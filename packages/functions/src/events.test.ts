import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

mock.module("./config.js", {
  namedExports: {
    config: {
      API_BASE: "https://test.run402.com",
      PROJECT_ID: "prj_test",
      SERVICE_KEY: "sk_test",
    },
  },
});

const { events, Run402EventsPlatformError } = await import("./events.js");

function storedEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cursor: "evc_a1b2c3",
    event_type: "signature_completed",
    class: "app",
    source: "app",
    payload: { request_id: "req_123" },
    occurred_at: "2026-07-15T12:00:00.000Z",
    deduplicated: false,
    next_actions: [{ type: "poll", method: "GET", path: "/projects/v1/prj_test/events" }],
    ...over,
  };
}

describe("events.emit — fresh emit (201)", () => {
  let lastFetchUrl = "";
  let lastFetchOpts: RequestInit = {};

  beforeEach(() => {
    lastFetchUrl = "";
    lastFetchOpts = {};
    mock.method(globalThis, "fetch", async (url: string, opts: RequestInit) => {
      lastFetchUrl = url;
      lastFetchOpts = opts;
      return new Response(JSON.stringify(storedEvent()), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    });
  });

  it("posts to /projects/v1/:project_id/events with service-key Bearer auth", async () => {
    const result = await events.emit(
      "signature_completed",
      { request_id: "req_123" },
      { idempotencyKey: "sig:req_123" },
    );

    assert.equal(lastFetchUrl, "https://test.run402.com/projects/v1/prj_test/events");
    assert.equal(lastFetchOpts.method, "POST");
    const headers = lastFetchOpts.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer sk_test");
    assert.equal(headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(lastFetchOpts.body as string), {
      event_type: "signature_completed",
      payload: { request_id: "req_123" },
      idempotency_key: "sig:req_123",
    });

    assert.deepEqual(result, storedEvent());
    assert.equal(result.deduplicated, false);
  });

  it("omits payload and idempotency_key from the body when not provided", async () => {
    await events.emit("signature_completed");
    assert.deepEqual(JSON.parse(lastFetchOpts.body as string), {
      event_type: "signature_completed",
    });
  });

  it("omits idempotency_key but includes payload when only payload is given", async () => {
    await events.emit("signature_completed", { a: 1 });
    assert.deepEqual(JSON.parse(lastFetchOpts.body as string), {
      event_type: "signature_completed",
      payload: { a: 1 },
    });
  });

  it("sends an empty-object payload verbatim (does not conflate with 'omitted')", async () => {
    await events.emit("signature_completed", {});
    assert.deepEqual(JSON.parse(lastFetchOpts.body as string), {
      event_type: "signature_completed",
      payload: {},
    });
  });
});

describe("events.emit — idempotent replay (200 deduplicated:true)", () => {
  it("returns the ORIGINAL stored event with deduplicated:true, same shape as a fresh emit", async () => {
    mock.method(globalThis, "fetch", async () =>
      new Response(
        JSON.stringify(storedEvent({ deduplicated: true, cursor: "evc_original" })),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await events.emit(
      "signature_completed",
      { request_id: "req_123" },
      { idempotencyKey: "sig:req_123" },
    );

    assert.equal(result.deduplicated, true);
    assert.equal(result.cursor, "evc_original");
  });
});

describe("events.emit — error envelope passthrough", () => {
  it("403 QUOTA_EXCEEDED surfaces as a structured Run402EventsPlatformError with details intact", async () => {
    mock.method(globalThis, "fetch", async () =>
      new Response(
        JSON.stringify({
          error: "storage_quota_exceeded",
          message: "Daily app-event quota exceeded for this organization.",
          code: "QUOTA_EXCEEDED",
          category: "quota",
          details: { resource: "events_per_day", scope: "organization", used: 1000, limit: 1000 },
          next_actions: [
            { type: "renew_tier", method: "POST", path: "/tiers/v1/:tier" },
            { type: "check_usage", method: "GET", path: "/tiers/v1/status" },
          ],
          trace_id: "trace-abc",
        }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      ),
    );

    await assert.rejects(
      () => events.emit("signature_completed", { a: 1 }),
      (err: unknown) => {
        assert.ok(err instanceof Run402EventsPlatformError);
        assert.ok(err instanceof Error);
        assert.equal(err.name, "Run402EventsPlatformError");
        assert.equal(err.status, 403);
        assert.equal(err.code, "QUOTA_EXCEEDED");
        assert.deepEqual(err.details, {
          resource: "events_per_day",
          scope: "organization",
          used: 1000,
          limit: 1000,
        });
        assert.equal(err.next_actions?.length, 2);
        assert.match(err.message, /Event emit failed \(403\)/);
        assert.match(err.message, /Daily app-event quota exceeded/);
        return true;
      },
    );
  });

  it("403 cross-project denial surfaces with code FORBIDDEN", async () => {
    mock.method(globalThis, "fetch", async () =>
      new Response(
        JSON.stringify({ code: "FORBIDDEN", message: "Service key is not valid for this project" }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      ),
    );

    await assert.rejects(
      () => events.emit("signature_completed"),
      (err: unknown) => {
        assert.ok(err instanceof Run402EventsPlatformError);
        assert.equal(err.status, 403);
        assert.equal(err.code, "FORBIDDEN");
        return true;
      },
    );
  });

  it("non-JSON error body still produces a structured error (falls back to raw text as message)", async () => {
    mock.method(globalThis, "fetch", async () =>
      new Response("upstream 502 Bad Gateway", { status: 502 }),
    );

    await assert.rejects(
      () => events.emit("signature_completed"),
      (err: unknown) => {
        assert.ok(err instanceof Run402EventsPlatformError);
        assert.equal(err.status, 502);
        assert.equal(err.code, "events_platform_error");
        assert.match(err.message, /upstream 502 Bad Gateway/);
        return true;
      },
    );
  });
});

describe("events.emit — grammar is NOT validated client-side", () => {
  it("sends a malformed event_type verbatim and lets the gateway's 400 INVALID_EVENT_TYPE surface", async () => {
    let called = false;
    let sentBody = "";
    mock.method(globalThis, "fetch", async (_url: string, opts: RequestInit) => {
      called = true;
      sentBody = opts.body as string;
      return new Response(
        JSON.stringify({
          code: "INVALID_EVENT_TYPE",
          message: "event_type must match /^[a-z][a-z0-9_]{2,63}$/",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    });

    const badType = "Not-A-Valid-Type!!";
    await assert.rejects(
      () => events.emit(badType, { a: 1 }),
      (err: unknown) => {
        assert.ok(err instanceof Run402EventsPlatformError);
        assert.equal(err.status, 400);
        assert.equal(err.code, "INVALID_EVENT_TYPE");
        return true;
      },
    );

    // The client is a dumb pipe: it made the call and sent exactly what it
    // was given, rather than pre-validating the grammar and throwing locally.
    assert.equal(called, true, "the client must not short-circuit before the HTTP call");
    assert.deepEqual(JSON.parse(sentBody), { event_type: badType, payload: { a: 1 } });
  });

  it("sends a platform-reserved event_type verbatim and lets the gateway's 400 RESERVED_EVENT_TYPE surface", async () => {
    let called = false;
    let sentBody = "";
    mock.method(globalThis, "fetch", async (_url: string, opts: RequestInit) => {
      called = true;
      sentBody = opts.body as string;
      return new Response(
        JSON.stringify({
          code: "RESERVED_EVENT_TYPE",
          message: "event_type 'deploy_activated' is a platform-registered type",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    });

    await assert.rejects(
      () => events.emit("deploy_activated"),
      (err: unknown) => {
        assert.ok(err instanceof Run402EventsPlatformError);
        assert.equal(err.status, 400);
        assert.equal(err.code, "RESERVED_EVENT_TYPE");
        return true;
      },
    );

    assert.equal(called, true, "the client must not locally reject platform-registered names");
    assert.deepEqual(JSON.parse(sentBody), { event_type: "deploy_activated" });
  });
});
