// The browser files shipped in `browser/` run in pages and service workers,
// not in Node, so they are loaded into a `node:vm` sandbox with the browser
// objects they touch mocked. Values crossing the sandbox boundary are compared
// after a JSON round-trip (`plain`), since each realm has its own prototypes.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash, webcrypto } from "node:crypto";
import vm from "node:vm";

const PUSH_JS = readFileSync(new URL("../browser/push.js", import.meta.url), "utf8");
const PUSH_SW_JS = readFileSync(new URL("../browser/push-sw.js", import.meta.url), "utf8");

const ORIGIN = "https://app.example";
const ENDPOINT = "https://push.example/send/abc123";
const VAPID_KEY = Buffer.from(Uint8Array.from({ length: 65 }, (_, i) => (i === 0 ? 4 : i))).toString("base64url");
const OTHER_KEY = Buffer.from(Uint8Array.from({ length: 65 }, (_, i) => (i === 0 ? 4 : 200 - i))).toString("base64url");
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const DESKTOP_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function expectedId(endpoint: string): string {
  return "psub_" + createHash("sha256").update(endpoint, "utf8").digest("base64url");
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// ---- Page sandbox -----------------------------------------------------------

interface FakeSubscription {
  endpoint: string;
  options: { applicationServerKey: ArrayBuffer | null };
  toJSON(): unknown;
  unsubscribe(): Promise<boolean>;
}

interface PageOptions {
  userAgent?: string;
  platform?: string;
  maxTouchPoints?: number;
  standalone?: boolean;
  displayModeStandalone?: boolean;
  permission?: "default" | "granted" | "denied";
  /** What requestPermission() resolves to (and leaves Notification.permission at). */
  prompt?: "default" | "granted" | "denied";
  notification?: boolean;
  serviceWorker?: boolean;
  pushManagerApi?: boolean;
  /** WebKit Declarative Web Push: `window.pushManager`. */
  windowPushManager?: boolean;
  /** An existing registration at scope "/": ours, an app worker that answers the ping, or one that does not. */
  existingWorker?: "ours" | "app-with-snippet" | "app-without-snippet";
  subscribed?: { endpoint: string; key: string | null };
  storage?: Record<string, string>;
  storageThrows?: boolean;
  /** `navigator.userActivation.isActive`: the call runs inside a tap or click. Absent when undefined. */
  userActivation?: boolean;
  respond?: (url: string, init: RequestInit) => Response;
}

function makePushManager(calls: PageCalls, initial: PageOptions["subscribed"]) {
  let current: FakeSubscription | null = null;
  const make = (endpoint: string, key: Uint8Array | null): FakeSubscription => {
    const sub: FakeSubscription = {
      endpoint,
      options: { applicationServerKey: key ? Uint8Array.from(key).buffer : null },
      toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh: "p256dh-key", auth: "auth-secret" } }),
      unsubscribe: async () => {
        calls.unsubscribe++;
        if (current === sub) current = null;
        return true;
      },
    };
    return sub;
  };
  if (initial) current = make(initial.endpoint, initial.key ? Buffer.from(initial.key, "base64url") : null);
  return {
    getSubscription: async () => current,
    subscribe: async (options: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }) => {
      calls.subscribe.push({ userVisibleOnly: options.userVisibleOnly, key: Buffer.from(options.applicationServerKey).toString("base64url") });
      current = make(calls.subscribe.length === 1 ? ENDPOINT : `${ENDPOINT}-${calls.subscribe.length}`, options.applicationServerKey);
      return current;
    },
  };
}

interface PageCalls {
  fetch: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown; credentials?: string }>;
  register: Array<{ url: string; scope?: string }>;
  requestPermission: number;
  subscribe: Array<{ userVisibleOnly: boolean; key: string }>;
  unsubscribe: number;
  pings: number;
  timeouts: number[];
}

function makePage(opts: PageOptions = {}) {
  const calls: PageCalls = { fetch: [], register: [], requestPermission: 0, subscribe: [], unsubscribe: 0, pings: 0, timeouts: [] };
  const store = new Map(Object.entries(opts.storage ?? {}));
  const pushManager = makePushManager(calls, opts.subscribed);

  const worker = (scriptURL: string, answers: boolean) => ({
    scriptURL,
    state: "activated",
    postMessage: (message: { type: string }, ports: Array<{ postMessage(data: unknown): void }>) => {
      calls.pings++;
      if (answers && message.type === "run402-push-ping") queueMicrotask(() => ports[0]!.postMessage({ type: "run402-push-pong" }));
    },
  });

  let registration: Record<string, unknown> | null = null;
  if (opts.existingWorker === "ours") registration = { active: worker(`${ORIGIN}/_run402/push-sw.js`, true), pushManager };
  if (opts.existingWorker === "app-with-snippet") registration = { active: worker(`${ORIGIN}/sw.js`, true), pushManager };
  if (opts.existingWorker === "app-without-snippet") registration = { active: worker(`${ORIGIN}/sw.js`, false), pushManager };

  const serviceWorker = {
    getRegistration: async (scope: string) => {
      assert.equal(scope, "/");
      return registration ?? undefined;
    },
    register: async (url: string, options: { scope?: string }) => {
      calls.register.push({ url, scope: options.scope });
      const installing = { scriptURL: `${ORIGIN}${url}`, state: "installing", listeners: [] as Array<() => void>,
        addEventListener(_type: string, fn: () => void) { this.listeners.push(fn); },
        removeEventListener() {},
        postMessage() {},
      };
      registration = { installing, active: null, pushManager };
      // Activation lands a moment later, as in a browser.
      setTimeout(() => {
        installing.state = "activated";
        registration!.active = installing;
        registration!.installing = null;
        installing.listeners.forEach((fn) => fn());
      }, 0);
      return registration;
    },
  };

  const Notification = {
    permission: opts.permission ?? "default",
    requestPermission: async () => {
      calls.requestPermission++;
      Notification.permission = opts.prompt ?? "granted";
      return Notification.permission;
    },
  };

  class FakeMessageChannel {
    port1: { onmessage: ((event: { data: unknown }) => void) | null; close(): void } = { onmessage: null, close() {} };
    port2 = { postMessage: (data: unknown) => this.port1.onmessage?.({ data }) };
  }

  const respond = opts.respond ?? ((url: string, init: RequestInit) => {
    if (url === "/_run402/push/key") return jsonResponse({ vapid_public_key: VAPID_KEY });
    if (url === "/_run402/push/subscriptions" && init.method === "POST") {
      return jsonResponse({ subscription_id: expectedId(ENDPOINT), user_id: "user_1", status: "subscribed", replaced_subscription_id: null }, 201);
    }
    if (url.startsWith("/_run402/push/subscriptions/") && init.method === "DELETE") {
      return jsonResponse({ subscription_id: url.split("/").pop(), status: "removed" });
    }
    return jsonResponse({ error: "not_found" }, 404);
  });

  const navigator: Record<string, unknown> = {
    userAgent: opts.userAgent ?? DESKTOP_UA,
    platform: opts.platform ?? "Linux x86_64",
    maxTouchPoints: opts.maxTouchPoints ?? 0,
  };
  if (opts.standalone !== undefined) navigator.standalone = opts.standalone;
  if (opts.userActivation !== undefined) navigator.userActivation = { isActive: opts.userActivation, hasBeenActive: opts.userActivation };
  if (opts.serviceWorker !== false) navigator.serviceWorker = serviceWorker;

  const sandbox: Record<string, unknown> = {
    navigator,
    location: { href: `${ORIGIN}/`, origin: ORIGIN },
    matchMedia: (query: string) => ({ matches: query === "(display-mode: standalone)" && opts.displayModeStandalone === true }),
    localStorage: {
      getItem: (key: string) => {
        if (opts.storageThrows) throw new Error("SecurityError");
        return store.has(key) ? store.get(key)! : null;
      },
      setItem: (key: string, value: string) => {
        if (opts.storageThrows) throw new Error("QuotaExceededError");
        store.set(key, String(value));
      },
      removeItem: (key: string) => {
        if (opts.storageThrows) throw new Error("SecurityError");
        store.delete(key);
      },
    },
    fetch: async (url: string, init: RequestInit = {}) => {
      calls.fetch.push({
        url,
        method: init.method ?? "GET",
        headers: (init.headers ?? {}) as Record<string, string>,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
        credentials: init.credentials,
      });
      return respond(url, init);
    },
    crypto: webcrypto,
    TextEncoder,
    TextDecoder,
    URL,
    atob,
    btoa,
    MessageChannel: FakeMessageChannel,
    setTimeout: (fn: () => void, ms: number) => {
      calls.timeouts.push(ms);
      return setTimeout(fn, 0); // the ping wait runs at once; its length is asserted instead
    },
    clearTimeout,
  };
  if (opts.notification !== false) sandbox.Notification = Notification;
  if (opts.pushManagerApi !== false) sandbox.PushManager = function PushManager() {};
  if (opts.windowPushManager) sandbox.pushManager = pushManager;
  sandbox.window = sandbox;

  const context = vm.createContext(sandbox);
  vm.runInContext(PUSH_JS, context, { filename: "push.js" });
  const api = sandbox.Run402Push as {
    status(): Promise<string>;
    subscribe(options?: { accessToken?: string }): Promise<Record<string, unknown>>;
    unsubscribe(options?: { accessToken?: string }): Promise<Record<string, unknown>>;
  };
  return { api, calls, store, Notification, getRegistration: () => registration };
}

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<Record<string, unknown>> {
  try {
    await promise;
  } catch (err) {
    assert.equal((err as { code?: string }).code, code, (err as Error).message);
    return err as Record<string, unknown>;
  }
  assert.fail(`expected a rejection with code ${code}`);
}

// ---- push.js ----------------------------------------------------------------

describe("Run402Push.status()", () => {
  it("needs_install on an iPhone browser tab", async () => {
    assert.equal(await makePage({ userAgent: IPHONE_UA, standalone: false, serviceWorker: false, pushManagerApi: false }).api.status(), "needs_install");
  });

  it("needs_install on an iPad that reports itself as a Mac", async () => {
    assert.equal(await makePage({ platform: "MacIntel", maxTouchPoints: 5 }).api.status(), "needs_install");
  });

  it("not needs_install for the Home Screen app (navigator.standalone or display-mode)", async () => {
    assert.equal(await makePage({ userAgent: IPHONE_UA, standalone: true }).api.status(), "default");
    assert.equal(await makePage({ userAgent: IPHONE_UA, displayModeStandalone: true }).api.status(), "default");
  });

  it("unsupported without push support or without Notification", async () => {
    assert.equal(await makePage({ pushManagerApi: false }).api.status(), "unsupported");
    assert.equal(await makePage({ serviceWorker: false }).api.status(), "unsupported");
    assert.equal(await makePage({ notification: false }).api.status(), "unsupported");
  });

  it("supported through window.pushManager alone (Declarative Web Push)", async () => {
    const page = makePage({ serviceWorker: false, pushManagerApi: false, windowPushManager: true, permission: "granted", subscribed: { endpoint: ENDPOINT, key: VAPID_KEY } });
    assert.equal(await page.api.status(), "subscribed");
  });

  it("denied and default follow Notification.permission", async () => {
    assert.equal(await makePage({ permission: "denied" }).api.status(), "denied");
    assert.equal(await makePage({ permission: "default" }).api.status(), "default");
  });

  it("granted is subscribed only with a push subscription", async () => {
    assert.equal(await makePage({ permission: "granted" }).api.status(), "default");
    assert.equal(await makePage({ permission: "granted", existingWorker: "ours" }).api.status(), "default");
    assert.equal(
      await makePage({ permission: "granted", existingWorker: "ours", subscribed: { endpoint: ENDPOINT, key: VAPID_KEY } }).api.status(),
      "subscribed",
    );
  });

  it("never prompts", async () => {
    const page = makePage({ permission: "default" });
    await page.api.status();
    assert.equal(page.calls.requestPermission, 0);
  });
});

describe("Run402Push.subscribe() — first time, from a tap", () => {
  it("registers the worker, prompts, subscribes with the server key and records the subscription", async () => {
    const page = makePage({ permission: "default", prompt: "granted" });
    const result = await page.api.subscribe({ accessToken: "tok_user" });

    assert.deepEqual(page.calls.register, [{ url: "/_run402/push-sw.js", scope: "/" }]);
    assert.equal(page.calls.requestPermission, 1);
    assert.deepEqual(page.calls.subscribe, [{ userVisibleOnly: true, key: VAPID_KEY }]);

    const post = page.calls.fetch.find((call) => call.method === "POST")!;
    assert.equal(post.url, "/_run402/push/subscriptions");
    assert.equal(post.credentials, "same-origin");
    assert.equal(post.headers["Content-Type"], "application/json");
    assert.equal(post.headers.Authorization, "Bearer tok_user");
    assert.deepEqual(post.body, { endpoint: ENDPOINT, keys: { p256dh: "p256dh-key", auth: "auth-secret" }, expiration_time: null });

    assert.deepEqual(plain(result), {
      subscription_id: expectedId(ENDPOINT),
      user_id: "user_1",
      status: "subscribed",
      replaced_subscription_id: null,
      confirmed: true,
    });
    const stored = JSON.parse(page.store.get("run402.push.confirmed")!);
    assert.equal(stored.endpoint, ENDPOINT);
    assert.equal(typeof stored.at, "number");
  });

  it("sends no Authorization header without an accessToken (cookie session)", async () => {
    const page = makePage({ permission: "default" });
    await page.api.subscribe();
    const post = page.calls.fetch.find((call) => call.method === "POST")!;
    assert.equal(post.headers.Authorization, undefined);
  });

  it("uses window.pushManager when present (WebKit Declarative Web Push)", async () => {
    const page = makePage({ serviceWorker: false, pushManagerApi: false, windowPushManager: true });
    const result = await page.api.subscribe();
    assert.equal(page.calls.register.length, 0, "no worker to register");
    assert.equal(page.calls.subscribe.length, 1);
    assert.equal(result.confirmed, true);
  });

  it("uses an existing registration of its own worker", async () => {
    const page = makePage({ existingWorker: "ours" });
    await page.api.subscribe();
    assert.equal(page.calls.register.length, 0);
    assert.equal(page.calls.pings, 0);
    assert.equal(page.calls.subscribe.length, 1);
  });

  it("uses an app's worker that imports the snippet (answers the ping)", async () => {
    const page = makePage({ existingWorker: "app-with-snippet" });
    await page.api.subscribe();
    assert.equal(page.calls.pings, 1);
    assert.equal(page.calls.register.length, 0);
    assert.equal(page.calls.subscribe.length, 1);
  });

  it("refuses to replace an app's worker without the snippet", async () => {
    const page = makePage({ existingWorker: "app-without-snippet" });
    const err = await rejectsWith(page.api.subscribe(), "worker_missing_snippet");
    assert.equal(err.fix, 'importScripts("/_run402/push-sw.js");');
    assert.ok(page.calls.timeouts.includes(1000), "waits up to 1000 ms for the pong");
    assert.equal(page.calls.register.length, 0, "never registers over the app's worker");
    assert.equal(page.calls.requestPermission, 1, "asks first, while the tap still counts");
    assert.equal(page.calls.subscribe.length, 0);
  });

  it("replaces a subscription made with another key", async () => {
    const page = makePage({ permission: "granted", existingWorker: "ours", subscribed: { endpoint: `${ENDPOINT}-old`, key: OTHER_KEY } });
    await page.api.subscribe();
    assert.equal(page.calls.unsubscribe, 1);
    assert.deepEqual(page.calls.subscribe, [{ userVisibleOnly: true, key: VAPID_KEY }]);
  });
});

describe("Run402Push.subscribe() — refusals", () => {
  it("rejects needs_install, unsupported and permission_denied before anything else", async () => {
    const ios = makePage({ userAgent: IPHONE_UA });
    await rejectsWith(ios.api.subscribe(), "needs_install");
    const old = makePage({ pushManagerApi: false });
    await rejectsWith(old.api.subscribe(), "unsupported");
    const denied = makePage({ permission: "denied" });
    await rejectsWith(denied.api.subscribe(), "permission_denied");
    for (const page of [ios, old, denied]) {
      assert.equal(page.calls.fetch.length, 0);
      assert.equal(page.calls.requestPermission, 0);
    }
  });

  it("a denied prompt rejects permission_denied", async () => {
    const page = makePage({ permission: "default", prompt: "denied" });
    await rejectsWith(page.api.subscribe(), "permission_denied");
    assert.equal(page.calls.subscribe.length, 0);
  });

  it("a prompt left undecided (no user gesture) rejects needs_user_gesture", async () => {
    const page = makePage({ permission: "default", prompt: "default" });
    await rejectsWith(page.api.subscribe(), "needs_user_gesture");
    assert.equal(page.calls.subscribe.length, 0);
  });

  it("401 from the server rejects sign_in_required with the server's next_actions", async () => {
    const page = makePage({
      permission: "granted",
      respond: (url) =>
        url === "/_run402/push/key"
          ? jsonResponse({ vapid_public_key: VAPID_KEY })
          : jsonResponse({ error: "auth_required", code: "AUTH_REQUIRED", message: "Sign in first", next_actions: [{ type: "sign_in" }] }, 401),
    });
    const err = await rejectsWith(page.api.subscribe(), "sign_in_required");
    assert.equal(err.status, 401);
    assert.deepEqual(plain(err.next_actions), [{ type: "sign_in" }]);
    assert.equal(page.store.has("run402.push.confirmed"), false);
  });

  it("other server errors reject with the server's code", async () => {
    const page = makePage({
      permission: "granted",
      respond: (url) =>
        url === "/_run402/push/key"
          ? jsonResponse({ vapid_public_key: VAPID_KEY })
          : jsonResponse({ error: "forbidden", code: "R402_AUTH_CSRF_ORIGIN_MISMATCH", message: "Origin mismatch", next_actions: [] }, 403),
    });
    const err = await rejectsWith(page.api.subscribe(), "R402_AUTH_CSRF_ORIGIN_MISMATCH");
    assert.equal(err.status, 403);
  });
});

describe("Run402Push.subscribe() — at start-up for a signed-in user", () => {
  it("never prompts, re-confirms once, then skips the POST within 24 hours", async () => {
    const page = makePage({ permission: "granted", existingWorker: "ours", subscribed: { endpoint: ENDPOINT, key: VAPID_KEY } });

    const first = await page.api.subscribe({ accessToken: "tok" });
    assert.equal(first.confirmed, true);
    assert.equal(page.calls.fetch.filter((call) => call.method === "POST").length, 1);

    const second = await page.api.subscribe({ accessToken: "tok" });
    assert.deepEqual(plain(second), { status: "subscribed", subscription_id: expectedId(ENDPOINT), confirmed: false });
    assert.equal(page.calls.fetch.filter((call) => call.method === "POST").length, 1, "no second POST");

    assert.equal(page.calls.requestPermission, 0);
    assert.equal(page.calls.subscribe.length, 0, "reuses the existing subscription");
  });

  it("re-confirms when the record is older than 24 hours or for another endpoint", async () => {
    const stale = makePage({
      permission: "granted",
      existingWorker: "ours",
      subscribed: { endpoint: ENDPOINT, key: VAPID_KEY },
      storage: { "run402.push.confirmed": JSON.stringify({ endpoint: ENDPOINT, at: Date.now() - 25 * 60 * 60 * 1000 }) },
    });
    assert.equal((await stale.api.subscribe()).confirmed, true);

    const other = makePage({
      permission: "granted",
      existingWorker: "ours",
      subscribed: { endpoint: ENDPOINT, key: VAPID_KEY },
      storage: { "run402.push.confirmed": JSON.stringify({ endpoint: "https://push.example/other", at: Date.now() }) },
    });
    assert.equal((await other.api.subscribe()).confirmed, true);
  });

  it("re-confirms within 24 hours when the token names another user than the record", async () => {
    const token = (sub: string) =>
      ["e30", Buffer.from(JSON.stringify({ sub })).toString("base64url"), "sig"].join(".");
    const page = makePage({ permission: "granted", existingWorker: "ours", subscribed: { endpoint: ENDPOINT, key: VAPID_KEY } });
    // The server answers user_1, so the record is made for user_1.
    assert.equal((await page.api.subscribe({ accessToken: token("user_1") })).confirmed, true);
    assert.equal((await page.api.subscribe({ accessToken: token("user_1") })).confirmed, false, "same user: skipped");
    assert.equal((await page.api.subscribe({ accessToken: token("user_2") })).confirmed, true, "another sign-in confirms at once");
  });

  it("a tap that grants permission always confirms, even with a fresh record", async () => {
    const page = makePage({
      permission: "default",
      storage: { "run402.push.confirmed": JSON.stringify({ endpoint: ENDPOINT, at: Date.now() }) },
    });
    assert.equal((await page.api.subscribe()).confirmed, true);
  });

  it("a tap re-confirms within 24 hours, so a replaced phone comes back from the app's button", async () => {
    const fresh = { "run402.push.confirmed": JSON.stringify({ endpoint: ENDPOINT, at: Date.now() }) };
    const tap = makePage({ permission: "granted", existingWorker: "ours", subscribed: { endpoint: ENDPOINT, key: VAPID_KEY }, storage: fresh, userActivation: true });
    assert.equal((await tap.api.subscribe()).confirmed, true);
    assert.equal(tap.calls.fetch.filter((call) => call.method === "POST").length, 1);
    assert.equal(tap.calls.requestPermission, 0, "permission already granted: no prompt");

    const startUp = makePage({ permission: "granted", existingWorker: "ours", subscribed: { endpoint: ENDPOINT, key: VAPID_KEY }, storage: fresh, userActivation: false });
    assert.equal((await startUp.api.subscribe()).confirmed, false, "no gesture: the daily skip holds");
    assert.equal(startUp.calls.fetch.filter((call) => call.method === "POST").length, 0);
  });

  it("works when storage throws (confirms every time)", async () => {
    const page = makePage({ permission: "granted", existingWorker: "ours", subscribed: { endpoint: ENDPOINT, key: VAPID_KEY }, storageThrows: true });
    assert.equal((await page.api.subscribe()).confirmed, true);
    assert.equal((await page.api.subscribe()).confirmed, true);
  });
});

describe("Run402Push.unsubscribe()", () => {
  it("deletes the subscription by its deterministic id and unsubscribes the browser", async () => {
    const page = makePage({
      permission: "granted",
      existingWorker: "ours",
      subscribed: { endpoint: ENDPOINT, key: VAPID_KEY },
      storage: { "run402.push.confirmed": JSON.stringify({ endpoint: ENDPOINT, at: Date.now() }) },
    });
    const result = await page.api.unsubscribe({ accessToken: "tok" });
    assert.deepEqual(plain(result), { status: "unsubscribed", subscription_id: expectedId(ENDPOINT) });
    const del = page.calls.fetch[0]!;
    assert.equal(del.method, "DELETE");
    assert.equal(del.url, `/_run402/push/subscriptions/${expectedId(ENDPOINT)}`);
    assert.equal(del.headers.Authorization, "Bearer tok");
    assert.equal(page.calls.unsubscribe, 1);
    assert.equal(page.store.has("run402.push.confirmed"), false);
  });

  it("the id is psub_ + unpadded base64url SHA-256 of the endpoint", async () => {
    const endpoint = "https://fcm.googleapis.com/fcm/send/dXJsLXNhZmU_+/=?ünïcode";
    const page = makePage({ permission: "granted", existingWorker: "ours", subscribed: { endpoint, key: VAPID_KEY } });
    const result = await page.api.unsubscribe();
    assert.equal(result.subscription_id, expectedId(endpoint));
    assert.match(String(result.subscription_id), /^psub_[A-Za-z0-9_-]{43}$/);
  });

  it("treats a 404 as already removed", async () => {
    const page = makePage({
      permission: "granted",
      existingWorker: "ours",
      subscribed: { endpoint: ENDPOINT, key: VAPID_KEY },
      respond: () => jsonResponse({ error: "not_found", code: "PUSH_SUBSCRIPTION_NOT_FOUND" }, 404),
    });
    assert.equal((await page.api.unsubscribe()).status, "unsubscribed");
    assert.equal(page.calls.unsubscribe, 1);
  });

  it("without a subscription resolves not_subscribed and makes no request", async () => {
    const page = makePage({ permission: "granted", existingWorker: "ours" });
    assert.deepEqual(plain(await page.api.unsubscribe()), { status: "not_subscribed" });
    assert.equal(page.calls.fetch.length, 0);
  });

  it("a server refusal still stops this browser, then rejects", async () => {
    const page = makePage({
      permission: "granted",
      existingWorker: "ours",
      subscribed: { endpoint: ENDPOINT, key: VAPID_KEY },
      respond: () => jsonResponse({ error: "auth_required", code: "AUTH_REQUIRED" }, 401),
    });
    await rejectsWith(page.api.unsubscribe(), "sign_in_required");
    assert.equal(page.calls.unsubscribe, 1);
  });
});

// ---- push-sw.js -------------------------------------------------------------

type Listener = (event: Record<string, unknown>) => void;

function makeWorker(pathname = "/_run402/push-sw.js", windows: Array<Record<string, unknown>> = []) {
  const listeners = new Map<string, Listener[]>();
  const shown: Array<{ title: string; options: Record<string, unknown> }> = [];
  const opened: string[] = [];
  const calls = { skipWaiting: 0, claim: 0 };
  const sandbox: Record<string, unknown> = {
    addEventListener: (type: string, fn: Listener) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    location: new URL(`${ORIGIN}${pathname}`),
    registration: {
      showNotification: async (title: string, options: Record<string, unknown>) => {
        shown.push({ title, options: plain(options) });
      },
    },
    clients: {
      matchAll: async () => windows,
      openWindow: async (url: string) => {
        opened.push(url);
        return { url };
      },
      claim: async () => {
        calls.claim++;
      },
    },
    skipWaiting: async () => {
      calls.skipWaiting++;
    },
    URL,
  };
  sandbox.self = sandbox;
  vm.runInContext(PUSH_SW_JS, vm.createContext(sandbox), { filename: "push-sw.js" });

  async function dispatch(type: string, event: Record<string, unknown>): Promise<unknown[]> {
    const waits: unknown[] = [];
    event.waitUntil = (promise: unknown) => waits.push(promise);
    for (const fn of listeners.get(type) ?? []) fn(event);
    await Promise.all(waits);
    return waits;
  }
  return { listeners, shown, opened, calls, dispatch };
}

function pushEvent(payload: unknown): Record<string, unknown> {
  return {
    data: {
      json: () => (typeof payload === "string" ? JSON.parse(payload) : payload),
    },
  };
}

describe("push-sw.js — push", () => {
  it("shows a Declarative Web Push message exactly once", async () => {
    const worker = makeWorker();
    await worker.dispatch("push", pushEvent({
      web_push: 8030,
      notification: { title: "Order shipped", body: "Arrives Thursday", tag: "order-1", navigate: `${ORIGIN}/orders/1`, lang: "en" },
    }));
    assert.deepEqual(worker.shown, [{
      title: "Order shipped",
      options: { silent: false, data: { navigate: `${ORIGIN}/orders/1` }, body: "Arrives Thursday", tag: "order-1", lang: "en" },
    }]);
  });

  it("passes silent: true through only when it is exactly true", async () => {
    const worker = makeWorker();
    await worker.dispatch("push", pushEvent({ web_push: 8030, notification: { title: "Quiet", navigate: "/", silent: true } }));
    await worker.dispatch("push", pushEvent({ web_push: 8030, notification: { title: "Loud", navigate: "/", silent: "yes" } }));
    assert.equal(worker.shown[0]!.options.silent, true);
    assert.equal(worker.shown[1]!.options.silent, false);
  });

  it("does nothing when the browser hands its own notification (event.notification)", async () => {
    const worker = makeWorker();
    const event = pushEvent({ web_push: 8030, notification: { title: "Shown by the browser", navigate: "/" } });
    event.notification = { title: "Shown by the browser" };
    const waits = await worker.dispatch("push", event);
    assert.equal(worker.shown.length, 0);
    assert.equal(waits.length, 0);
  });

  it("ignores payloads that are not declarative, have no title, or are not JSON", async () => {
    const worker = makeWorker();
    await worker.dispatch("push", pushEvent({ title: "app's own format" }));
    await worker.dispatch("push", pushEvent({ web_push: 8030, notification: { title: "", navigate: "/" } }));
    await worker.dispatch("push", pushEvent({ web_push: 1, notification: { title: "x", navigate: "/" } }));
    await worker.dispatch("push", pushEvent("not json"));
    await worker.dispatch("push", {});
    assert.equal(worker.shown.length, 0);
  });
});

describe("push-sw.js — notificationclick", () => {
  function clickEvent(data: unknown) {
    const notification = { data, closed: 0, close() { this.closed++; } };
    return { notification };
  }

  it("opens navigate when no window is open", async () => {
    const worker = makeWorker();
    const event = clickEvent({ navigate: `${ORIGIN}/orders/1` });
    await worker.dispatch("notificationclick", event);
    assert.equal(event.notification.closed, 1);
    assert.deepEqual(worker.opened, [`${ORIGIN}/orders/1`]);
  });

  it("focuses a window already at that URL", async () => {
    let focused = 0;
    const worker = makeWorker(undefined, [{ url: `${ORIGIN}/orders/1`, focus: async () => { focused++; } }]);
    await worker.dispatch("notificationclick", clickEvent({ navigate: `${ORIGIN}/orders/1` }));
    assert.equal(focused, 1);
    assert.equal(worker.opened.length, 0);
  });

  it("navigates and focuses another same-origin window", async () => {
    const seen: string[] = [];
    const client = {
      url: `${ORIGIN}/home`,
      focus: async () => { seen.push("focus"); return client; },
      navigate: async (url: string) => { seen.push(`navigate ${url}`); return client; },
    };
    const worker = makeWorker(undefined, [{ url: "https://elsewhere.example/", focus: async () => {}, navigate: async () => null }, client]);
    await worker.dispatch("notificationclick", clickEvent({ navigate: "/orders/2" }));
    assert.deepEqual(seen, ["focus", `navigate ${ORIGIN}/orders/2`]);
    assert.equal(worker.opened.length, 0);
  });

  it("ignores a notification without data.navigate (not ours)", async () => {
    const worker = makeWorker();
    const event = clickEvent({ something: "else" });
    await worker.dispatch("notificationclick", event);
    assert.equal(event.notification.closed, 0);
    assert.equal(worker.opened.length, 0);
  });
});

describe("push-sw.js — ping and lifecycle", () => {
  it("answers the ping on the message port", async () => {
    const worker = makeWorker("/sw.js");
    const replies: unknown[] = [];
    await worker.dispatch("message", { data: { type: "run402-push-ping" }, ports: [{ postMessage: (data: unknown) => replies.push(plain(data)) }] });
    await worker.dispatch("message", { data: { type: "something-else" }, ports: [{ postMessage: (data: unknown) => replies.push(plain(data)) }] });
    assert.deepEqual(replies, [{ type: "run402-push-pong" }]);
  });

  it("registered directly: skips waiting on install and claims clients on activate", async () => {
    const worker = makeWorker("/_run402/push-sw.js");
    await worker.dispatch("install", {});
    await worker.dispatch("activate", {});
    assert.deepEqual(worker.calls, { skipWaiting: 1, claim: 1 });
  });

  it("imported into an app's worker: leaves install and activate to the app", () => {
    const worker = makeWorker("/sw.js");
    assert.equal(worker.listeners.has("install"), false);
    assert.equal(worker.listeners.has("activate"), false);
    assert.equal(worker.listeners.has("push"), true);
  });
});
