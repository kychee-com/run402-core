import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

const config = {
  API_BASE: "https://test.run402.com",
  PROJECT_ID: "prj_test",
  SERVICE_KEY: "sk_test",
};

mock.module("./config.js", { namedExports: { config } });

const { push, Run402PushError } = await import("./push.js");
const index = await import("./index.js");

const URL_MESSAGES = "https://test.run402.com/projects/v1/prj_test/push/messages";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

let calls: Call[] = [];
const queuedOne = (): Response => json({ message_id: "pmsg_1", status: "queued", devices: 1 }, 202);
let respond: (call: Call) => Response = queuedOne;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  calls = [];
  respond = queuedOne;
  config.PROJECT_ID = "prj_test";
  config.SERVICE_KEY = "sk_test";
  mock.method(globalThis, "fetch", async (url: string, opts: RequestInit = {}) => {
    const call: Call = {
      url,
      method: opts.method ?? "GET",
      headers: (opts.headers ?? {}) as Record<string, string>,
      body: opts.body ? JSON.parse(String(opts.body)) : undefined,
    };
    calls.push(call);
    return respond(call);
  });
});

describe("push.send — request", () => {
  it("posts the known keys to /projects/v1/:project_id/push/messages with service-key Bearer auth", async () => {
    respond = () => json({ message_id: "pmsg_1", status: "queued", devices: 2 }, 202);
    await push.send({
      title: "Your order shipped",
      body: "Arrives Thursday",
      url: "/orders/123",
      tag: "order-123",
      to: { user_id: "user_1", extra: "dropped" } as never,
      ignored: true,
    } as never);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, URL_MESSAGES);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].headers.Authorization, "Bearer sk_test");
    assert.equal(calls[0].headers["Content-Type"], "application/json");
    assert.deepEqual(calls[0].body, {
      title: "Your order shipped",
      body: "Arrives Thursday",
      url: "/orders/123",
      tag: "order-123",
      to: { user_id: "user_1" },
    });
  });

  it("sends only the title when nothing else is given", async () => {
    await push.send({ title: "Hello" });
    assert.deepEqual(calls[0].body, { title: "Hello" });
  });

  it("does not validate field lengths locally (the gateway owns the limits)", async () => {
    respond = () => json({ code: "VALIDATION_FAILED", message: "title must be 1-100 characters" }, 400);
    await assert.rejects(() => push.send({ title: "" }), (err: unknown) => {
      assert.ok(err instanceof Run402PushError);
      assert.equal(err.code, "VALIDATION_FAILED");
      assert.equal(err.status, 400);
      return true;
    });
    assert.equal(calls.length, 1, "the request is made; the gateway decides");
  });

  it("encodes the project id into the path", async () => {
    config.PROJECT_ID = "prj/odd id";
    await push.send({ title: "x" });
    assert.equal(calls[0].url, "https://test.run402.com/projects/v1/prj%2Fodd%20id/push/messages");
  });
});

describe("push.send — results", () => {
  it("202 resolves the queued message", async () => {
    const queued = {
      message_id: "pmsg_1",
      status: "queued",
      devices: 3,
      next_actions: [{ type: "read_message", method: "GET", path: "/projects/v1/prj_test/push/messages/pmsg_1" }],
    };
    respond = () => json(queued, 202);
    const result = await push.send({ title: "Hi" });
    assert.deepEqual(result, queued);
  });

  it("200 resolves no_subscribers with devices: 0", async () => {
    respond = () => json({ message_id: "pmsg_2", status: "no_subscribers", devices: 0 }, 200);
    const result = await push.send({ title: "Hi", to: { user_id: "user_nobody" } });
    assert.equal(result.status, "no_subscribers");
    assert.equal(result.devices, 0);
  });
});

describe("push.send — gateway errors", () => {
  it("403 QUOTA_EXCEEDED passes through code, details and next_actions", async () => {
    const envelope = {
      error: "push_quota_exceeded",
      message: "Daily push delivery cap reached for this organization.",
      code: "QUOTA_EXCEEDED",
      details: {
        resource: "push_deliveries_per_day",
        used: 100,
        limit: 100,
        resets_at: "2026-10-22T00:00:00.000Z",
      },
      next_actions: [{ type: "upgrade_tier", method: "POST", path: "/tiers/v1/:tier" }],
    };
    respond = () => json(envelope, 403);

    await assert.rejects(() => push.send({ title: "Hi" }), (err: unknown) => {
      assert.ok(err instanceof Run402PushError);
      assert.ok(err instanceof Error);
      assert.equal(err.name, "Run402PushError");
      assert.equal(err.code, "QUOTA_EXCEEDED");
      assert.equal(err.status, 403);
      assert.deepEqual(err.details, envelope.details);
      assert.deepEqual(err.next_actions, envelope.next_actions);
      assert.deepEqual(err.body, envelope);
      assert.match(err.message, /push\.send failed \(403\): Daily push delivery cap reached/);
      return true;
    });
  });

  it("429 RATE_LIMITED and 403 FORBIDDEN keep their codes", async () => {
    respond = () => json({ code: "RATE_LIMITED", message: "Too many push messages" }, 429);
    await assert.rejects(() => push.send({ title: "Hi" }), (err: unknown) =>
      err instanceof Run402PushError && err.code === "RATE_LIMITED" && err.status === 429);

    respond = () => json({ code: "FORBIDDEN", error: "Service key is not valid for this project" }, 403);
    await assert.rejects(() => push.send({ title: "Hi" }), (err: unknown) =>
      err instanceof Run402PushError && err.code === "FORBIDDEN" && /Service key is not valid/.test(err.message));
  });

  it("a non-JSON error body still produces a structured error", async () => {
    respond = () => new Response("upstream 502 Bad Gateway", { status: 502 });
    await assert.rejects(() => push.send({ title: "Hi" }), (err: unknown) => {
      assert.ok(err instanceof Run402PushError);
      assert.equal(err.code, "HTTP_502");
      assert.equal(err.status, 502);
      assert.match(err.message, /upstream 502 Bad Gateway/);
      return true;
    });
  });
});

describe("push.send — hosts without push", () => {
  it("maps Run402 Core's code-less 404 to PUSH_UNSUPPORTED", async () => {
    respond = () => json({ error: "not_found", message: "Route is not part of the Run402 Core runtime-kernel scaffold." }, 404);
    await assert.rejects(() => push.send({ title: "Hi" }), (err: unknown) => {
      assert.ok(err instanceof Run402PushError);
      assert.equal(err.code, "PUSH_UNSUPPORTED");
      assert.equal(err.status, 404);
      assert.match(err.message, /need Run402 Cloud; this host does not serve the push routes/);
      return true;
    });
  });

  it("maps a Cloud catch-all route 404 to PUSH_UNSUPPORTED", async () => {
    respond = () => json({ code: "RESOURCE_NOT_FOUND", message: "Cannot POST /projects/v1/prj_test/push/messages" }, 404);
    await assert.rejects(() => push.send({ title: "Hi" }), (err: unknown) =>
      err instanceof Run402PushError && err.code === "PUSH_UNSUPPORTED");
  });

  it("keeps a real coded 404 as the gateway's code", async () => {
    respond = () => json({ code: "PROJECT_NOT_FOUND", message: "project not found" }, 404);
    await assert.rejects(() => push.send({ title: "Hi" }), (err: unknown) =>
      err instanceof Run402PushError && err.code === "PROJECT_NOT_FOUND");
  });
});

describe("push.send — missing config", () => {
  it("throws PROJECT_ID_MISSING without a request when RUN402_PROJECT_ID is unset", async () => {
    config.PROJECT_ID = "";
    await assert.rejects(() => push.send({ title: "Hi" }), (err: unknown) => {
      assert.ok(err instanceof Run402PushError);
      assert.equal(err.code, "PROJECT_ID_MISSING");
      assert.equal(err.status, null);
      return true;
    });
    assert.equal(calls.length, 0);
  });

  it("without a service key, the gateway's AUTH_REQUIRED comes back unchanged", async () => {
    config.SERVICE_KEY = "";
    respond = (call) =>
      call.headers.Authorization === "Bearer "
        ? json({ code: "AUTH_REQUIRED", message: "Missing credential" }, 401)
        : queuedOne();
    await assert.rejects(() => push.send({ title: "Hi" }), (err: unknown) =>
      err instanceof Run402PushError && err.code === "AUTH_REQUIRED" && err.status === 401);
  });
});

describe("push — package exports", () => {
  it("exports push and Run402PushError from the package root", () => {
    assert.equal(index.push, push);
    assert.equal(index.Run402PushError, Run402PushError);
  });
});
