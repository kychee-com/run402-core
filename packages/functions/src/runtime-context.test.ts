/**
 * Unit tests for the AsyncLocalStorage request-context plumbing in
 * `@run402/functions/runtime-context`, covering:
 *
 *   - Task 2.28 — SDK lazy initialization (no DB/HTTP connections
 *     created at module import).
 *   - Task 2.29 — ALS context propagation across awaits, microtasks,
 *     setTimeout, queueMicrotask, and nested runWithContext scopes.
 *   - Task 2.30 — Run402OutsideRequestContextError thrown by
 *     requireActiveContext when ALS is empty (the "no-context" case).
 *   - Task 2.31 — PAYMENT_PRIMITIVES registry contract: every entry is
 *     listed in the canonical set + withPaymentTaint enforces the same
 *     name appears in the set (no rogue primitives can ship without
 *     being announced).
 *
 * The CACHE-side fact that `getUser()` / `getUserId()` / `getRole()` /
 * `db()` flow into taintCacheBypass is covered by `db.test.ts` and the
 * production `ssr-cache-e2e.ts` integration test.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import {
  als,
  runWithContext,
  getCurrentContext,
  requireActiveContext,
  taintCacheBypass,
  withPaymentTaint,
  PAYMENT_PRIMITIVES,
  Run402OutsideRequestContextError,
  type RequestContext,
} from "./runtime-context.js";
import {
  ACTOR_CONTEXT_ENVELOPE_VERSION,
  ACTOR_CONTEXT_ENVELOPE_ISS,
  ACTOR_CONTEXT_ENVELOPE_AUD,
  _setActorContextKeyMapForTest,
} from "./lib/actor-context-verify.js";

function makeCtx(over: Partial<RequestContext> = {}): RequestContext {
  return {
    request: new Request("https://test.run402.com/p", {
      headers: { "x-test": "1" },
    }),
    projectId: "prj_test",
    releaseId: "rel_test",
    locale: "en",
    defaultLocale: "en",
    idempotencyKey: null,
    cacheBypassTainted: { value: false },
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Task 2.28 — SDK lazy initialization (no connections at module init)
// ---------------------------------------------------------------------------

describe("SDK lazy initialization (task 2.28)", () => {
  it("importing @run402/functions does NOT instantiate the DB pool", async () => {
    // The DB client is created on-demand inside `db()`. Verify by
    // counting whether merely importing the module creates anything
    // network-shaped. We do this by checking that `globalThis.fetch`
    // hasn't been called by import side-effects.
    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      fetchCalls++;
      return Promise.resolve(new Response(""));
    }) as typeof fetch;
    try {
      // Dynamic import so the side-effect timing is observable.
      await import("./index.js");
      assert.equal(fetchCalls, 0, "module-import-time fetch must be zero");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("PAYMENT_PRIMITIVES is a frozen-by-convention reference, not a live array", () => {
    // The set is shared across the runtime; mutation would be a
    // contract violation. Verify the type is ReadonlySet so consumers
    // can't .add() through normal TS without a cast.
    assert.equal(typeof PAYMENT_PRIMITIVES.has, "function");
    // Iterating is safe (ReadonlySet supports for..of).
    const iter = [...PAYMENT_PRIMITIVES];
    assert.ok(Array.isArray(iter));
  });
});

// ---------------------------------------------------------------------------
// Task 2.29 — ALS context propagation across awaits + microtasks
// ---------------------------------------------------------------------------

describe("AsyncLocalStorage propagation (task 2.29)", () => {
  it("propagates through plain await", async () => {
    const ctx = makeCtx();
    await runWithContext(ctx, async () => {
      const inner = getCurrentContext();
      assert.equal(inner?.projectId, "prj_test");
    });
  });

  it("derives idempotencyKey from the platform header when not supplied", async () => {
    const ctx = makeCtx({
      idempotencyKey: undefined,
      request: new Request("https://test.run402.com/p", {
        headers: { "x-run402-idempotency-key": "paid-call-1" },
      }),
    } as Partial<RequestContext>);
    await runWithContext(ctx, async () => {
      assert.equal(getCurrentContext()?.idempotencyKey, "paid-call-1");
    });
  });

  it("propagates through Promise.resolve chain", async () => {
    const ctx = makeCtx();
    await runWithContext(ctx, async () => {
      await Promise.resolve()
        .then(() => Promise.resolve())
        .then(() => {
          assert.equal(getCurrentContext()?.projectId, "prj_test");
        });
    });
  });

  it("propagates through setTimeout(0)", async () => {
    const ctx = makeCtx();
    await runWithContext(ctx, async () => {
      await new Promise<void>((resolve) => {
        setTimeout(() => {
          assert.equal(getCurrentContext()?.projectId, "prj_test");
          resolve();
        }, 0);
      });
    });
  });

  it("propagates through queueMicrotask", async () => {
    const ctx = makeCtx();
    await runWithContext(ctx, async () => {
      await new Promise<void>((resolve) => {
        queueMicrotask(() => {
          assert.equal(getCurrentContext()?.projectId, "prj_test");
          resolve();
        });
      });
    });
  });

  it("propagates across nested runWithContext (inner overrides outer)", async () => {
    const outer = makeCtx({ projectId: "prj_outer" });
    const inner = makeCtx({ projectId: "prj_inner" });
    await runWithContext(outer, async () => {
      assert.equal(getCurrentContext()?.projectId, "prj_outer");
      await runWithContext(inner, async () => {
        assert.equal(getCurrentContext()?.projectId, "prj_inner");
      });
      // After the inner scope ends, outer is restored.
      assert.equal(getCurrentContext()?.projectId, "prj_outer");
    });
  });

  it("outside any runWithContext, getCurrentContext returns undefined", () => {
    // AsyncLocalStorage.getStore() returns `undefined` when not inside
    // a run() scope (Node API), which getCurrentContext() forwards.
    assert.equal(getCurrentContext(), undefined);
    // requireActiveContext throws the structured error.
    assert.throws(() => requireActiveContext(), Run402OutsideRequestContextError);
  });

  it("Run402OutsideRequestContextError carries R402_SDK_OUTSIDE_REQUEST_CONTEXT", () => {
    const err = new Run402OutsideRequestContextError("test message");
    assert.equal((err as { code: string }).code, "R402_SDK_OUTSIDE_REQUEST_CONTEXT");
    assert.match(err.message, /test message/);
    assert.ok(err instanceof Error);
  });

  it("getCurrentContext is undefined OUTSIDE the runWithContext scope after it ends", async () => {
    const ctx = makeCtx();
    await runWithContext(ctx, async () => {
      assert.notEqual(getCurrentContext(), undefined);
    });
    assert.equal(getCurrentContext(), undefined);
  });
});

// ---------------------------------------------------------------------------
// Task 2.31 — PAYMENT_PRIMITIVES registry contract
// ---------------------------------------------------------------------------

describe("PAYMENT_PRIMITIVES registry (task 2.31)", () => {
  it("withPaymentTaint(name) where name is NOT in the set warns at WRAP time + still taints at CALL time", async () => {
    // withPaymentTaint emits the warning when called (wrap time), not
    // when the returned function executes. So we have to intercept
    // console.warn BEFORE the wrap call. The taint flips at call time.
    let warnCount = 0;
    const origWarn = console.warn;
    console.warn = () => {
      warnCount++;
    };

    let wrapped: ((x: number) => Promise<number>) | null = null;
    try {
      const fakeImpl = async (x: number): Promise<number> => x * 2;
      wrapped = withPaymentTaint("unregistered.helper", fakeImpl);
    } finally {
      console.warn = origWarn;
    }
    assert.ok(warnCount >= 1, "unregistered payment-primitive name should warn at WRAP time");

    // Now exercise the wrapped fn inside an ALS scope to verify taint flips.
    const ctx = makeCtx();
    await runWithContext(ctx, async () => {
      const result = await wrapped!(21);
      assert.equal(result, 42);
      assert.equal(ctx.cacheBypassTainted.value, true);
    });
  });

  it("withPaymentTaint(name) where name IS in the set does NOT warn", async () => {
    if (PAYMENT_PRIMITIVES.size === 0) {
      // Set is empty in v1 (no concrete payment primitives ship yet);
      // skip this branch until the first registered helper lands.
      return;
    }
    const name = [...PAYMENT_PRIMITIVES][0]!;
    const ctx = makeCtx();
    const wrapped = withPaymentTaint(name, async (x: number) => x);

    let warnCount = 0;
    const origWarn = console.warn;
    console.warn = () => {
      warnCount++;
    };
    try {
      await runWithContext(ctx, async () => {
        await wrapped(0);
      });
    } finally {
      console.warn = origWarn;
    }
    assert.equal(warnCount, 0, "registered payment-primitive must NOT warn");
  });

  it("every entry in PAYMENT_PRIMITIVES is a non-empty string (no rogue values)", () => {
    for (const name of PAYMENT_PRIMITIVES) {
      assert.equal(typeof name, "string");
      assert.ok(name.length > 0);
      // Convention: dotted helper-path (e.g. "payments.require").
      assert.match(name, /^[a-z][a-z0-9_.-]*$/);
    }
  });

  it("taintCacheBypass() inside ALS scope flips cacheBypassTainted.value to true", async () => {
    const ctx = makeCtx();
    await runWithContext(ctx, async () => {
      assert.equal(ctx.cacheBypassTainted.value, false);
      taintCacheBypass();
      assert.equal(ctx.cacheBypassTainted.value, true);
    });
  });

  it("taintCacheBypass() outside ALS scope is a silent no-op (does not throw)", () => {
    // Defensive — payment helpers may execute in test fixtures with no
    // ALS context. Throwing would surface as a confusing test failure;
    // silently not-flipping is the documented behavior.
    assert.doesNotThrow(() => taintCacheBypass());
  });

  it("als is a real AsyncLocalStorage instance (sanity check the export)", () => {
    assert.equal(typeof als.run, "function");
    assert.equal(typeof als.getStore, "function");
  });
});

// ---------------------------------------------------------------------------
// auth-hosted-surface-parity — routed_http actor resolution from a real Web
// Request. This mirrors the production Lambda entry wrapper, which passes a
// `new Request(absoluteUrl, { headers: new Headers(...) })` — i.e. a Web
// `Headers` instance + absolute url, NOT the plain record the type implies.
// Regression guard for the bracket-access-on-Headers bug that left
// auth.user() null in every deployed function despite the gateway signing a
// valid envelope. `verifyEnvelopeFromRequest` had no test before this.
// ---------------------------------------------------------------------------

const ACTOR_KID = "ac-rt-test-2026";
const ACTOR_KEY = crypto.randomBytes(32);

function signActorEnvelope(opts: {
  host: string;
  path: string;
  method: string;
  requestId: string;
  projectId: string;
  actor: Record<string, unknown>;
}): string {
  const iat = Math.floor(Date.now() / 1000);
  const env = {
    v: ACTOR_CONTEXT_ENVELOPE_VERSION,
    kid: ACTOR_KID,
    iss: ACTOR_CONTEXT_ENVELOPE_ISS,
    aud: ACTOR_CONTEXT_ENVELOPE_AUD,
    project_id: opts.projectId,
    request_id: opts.requestId,
    method: opts.method.toUpperCase(),
    host: opts.host,
    path_hash: crypto.createHash("sha256").update(opts.path).digest("hex"),
    iat,
    exp: iat + 60,
    actor: opts.actor,
  };
  const body = JSON.stringify(env);
  const sig = crypto.createHmac("sha256", ACTOR_KEY).update(body).digest();
  return Buffer.from(body).toString("base64url") + "." + sig.toString("base64url");
}

function routedCtx(request: Request): RequestContext {
  return {
    request,
    projectId: "prj_rt_test",
    releaseId: null,
    locale: null,
    defaultLocale: null,
    invocationKind: "routed_http",
    cacheBypassTainted: { value: false },
  } as unknown as RequestContext;
}

describe("runWithContext — routed_http actor from a Web Request (auth-hosted-surface-parity)", () => {
  it("resolves ctx.actor from the x-run402-actor-context header (Web Headers + absolute url)", async () => {
    _setActorContextKeyMapForTest({ [ACTOR_KID]: ACTOR_KEY });
    const host = "kychon.run402.app";
    const requestId = "req_rt_abc123";
    const actor = {
      id: "11111111-2222-3333-4444-555555555555",
      email: "u@example.com",
      isTest: true,
      emailVerified: true,
      authTime: 1779960000,
      amr: ["tenant_password"],
      amrTimes: { tenant_password: 1779960000 },
      authzVersion: 1,
    };
    const envelope = signActorEnvelope({
      host,
      path: "/verifyamr",
      method: "GET",
      requestId,
      projectId: "prj_rt_test",
      actor,
    });
    // Exactly what the Lambda entry wrapper builds: absolute url + Web Headers.
    const request = new Request(`https://${host}/verifyamr`, {
      method: "GET",
      headers: new Headers({
        "x-run402-actor-context": envelope,
        "x-run402-request-id": requestId,
      }),
    });

    let resolved: { id?: string; amr?: string[]; isTest?: true } | null = null;
    await runWithContext(routedCtx(request), () => {
      resolved = (getCurrentContext()?.actor ?? null) as typeof resolved;
    });
    assert.ok(resolved, "actor MUST resolve from the signed cookie envelope");
    assert.equal(resolved!.id, "11111111-2222-3333-4444-555555555555");
    assert.equal(resolved!.isTest, true);
    assert.deepEqual(resolved!.amr, ["tenant_password"]);
  });

  it("stays anonymous (null actor) when the actor-context header is absent", async () => {
    _setActorContextKeyMapForTest({ [ACTOR_KID]: ACTOR_KEY });
    const request = new Request("https://kychon.run402.app/x", {
      method: "GET",
      headers: new Headers({}),
    });
    let resolved: unknown = "unset";
    await runWithContext(routedCtx(request), () => {
      resolved = getCurrentContext()?.actor ?? null;
    });
    assert.equal(resolved, null);
  });

  it("rejects a path-bound envelope replayed on a different path (path_mismatch → anonymous)", async () => {
    _setActorContextKeyMapForTest({ [ACTOR_KID]: ACTOR_KEY });
    const host = "kychon.run402.app";
    const requestId = "req_rt_replay";
    const envelope = signActorEnvelope({
      host,
      path: "/account",
      method: "GET",
      requestId,
      projectId: "prj_rt_test",
      actor: {
        id: "u",
        email: "",
        emailVerified: true,
        authTime: 1779960000,
        amr: ["passkey"],
        amrTimes: {},
        authzVersion: 1,
      },
    });
    // Same envelope, replayed against /admin — pathname binding must reject.
    const request = new Request(`https://${host}/admin`, {
      method: "GET",
      headers: new Headers({
        "x-run402-actor-context": envelope,
        "x-run402-request-id": requestId,
      }),
    });
    let resolved: unknown = "unset";
    await runWithContext(routedCtx(request), () => {
      resolved = getCurrentContext()?.actor ?? null;
    });
    assert.equal(resolved, null);
  });
});
