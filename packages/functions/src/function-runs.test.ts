import { beforeEach, describe, it, mock } from "node:test";
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

const {
  defineFunctionRuns,
  functions,
  isFunctionRun,
  parseFunctionRun,
  parseFunctionRunEnvelope,
  permanentFunctionRunError,
  retryableFunctionRunError,
  Run402FunctionRunContextError,
  Run402FunctionRunInputError,
  runWithContext,
} = await import("./index.js");

function envelope(over: Record<string, unknown> = {}) {
  return {
    trigger: "function_run",
    run_id: "fnrun_abc123",
    generation: 1,
    event_type: "kysigned.forward.process",
    idempotency_key: "reply:msg_123",
    run_at: "2026-07-01T12:00:00.000Z",
    attempt: {
      attempt_id: "fnatt_abc123",
      number: 1,
      max: 5,
    },
    source: { type: "api" },
    payload: { message_id: "msg_123" },
    ...over,
  };
}

function activeContext() {
  return {
    requestId: "fnrun_abc123",
    projectId: "prj_test",
    releaseId: "rel_test",
    locale: null,
    defaultLocale: null,
    host: "test.run402.com",
    request: {
      method: "POST",
      url: "https://test.run402.com/functions/v1/worker",
      headers: {
        "x-run402-trigger": "function_run",
        "x-run402-run-id": "fnrun_abc123",
      },
    },
    invocationKind: "direct" as const,
  };
}

describe("function run envelope parsing", () => {
  it("parses a valid function-run envelope", () => {
    const parsed = parseFunctionRunEnvelope(envelope());

    assert.equal(parsed.run_id, "fnrun_abc123");
    assert.equal(parsed.event_type, "kysigned.forward.process");
    assert.equal(parsed.attempt.attempt_id, "fnatt_abc123");
    assert.deepEqual(parsed.payload, { message_id: "msg_123" });
    assert.equal(isFunctionRun(parsed), true);
  });

  it("rejects malformed envelopes before user dispatch", () => {
    assert.throws(
      () => parseFunctionRunEnvelope(envelope({ trigger: "cron" })),
      Run402FunctionRunInputError,
    );
    assert.equal(isFunctionRun(envelope({ run_id: "" })), false);
  });

  it("parses a Web Request body", async () => {
    const req = new Request("https://test.run402.com/functions/v1/worker", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope()),
    });

    const parsed = await parseFunctionRun(req);

    assert.equal(parsed.run_id, "fnrun_abc123");
    assert.equal(parsed.source.type, "api");
  });
});

describe("defineFunctionRuns", () => {
  it("dispatches a known event and passes typed context", async () => {
    let seen: unknown;
    const handler = defineFunctionRuns({
      "kysigned.forward.process": {
        payload: {
          parse(value: unknown) {
            assert.deepEqual(value, { message_id: "msg_123" });
            return value as { message_id: string };
          },
        },
        async run(ctx: unknown, payload: { message_id: string }) {
          seen = {
            runId: (ctx as { run: { id: string } }).run.id,
            attemptId: (ctx as { attempt: { id: string } }).attempt.id,
            idempotencyKey: (ctx as { idempotency: { key: string } }).idempotency.key,
            payload,
          };
        },
      },
    });

    const res = await handler(envelope());

    assert.equal(res.status, 204);
    assert.deepEqual(seen, {
      runId: "fnrun_abc123",
      attemptId: "fnatt_abc123",
      idempotencyKey: "reply:msg_123",
      payload: { message_id: "msg_123" },
    });
  });

  it("returns terminal 400 for unknown events", async () => {
    const handler = defineFunctionRuns({});

    const res = await handler(envelope({ event_type: "unknown.event" }));
    const body = await res.json() as { error: string; event_type: string; retryable: boolean };

    assert.equal(res.status, 400);
    assert.equal(body.error, "function_run_unknown_event");
    assert.equal(body.event_type, "unknown.event");
    assert.equal(body.retryable, false);
  });

  it("returns terminal 400 for invalid payloads", async () => {
    const handler = defineFunctionRuns({
      "kysigned.forward.process": {
        payload: {
          parse() {
            throw new Error("message_id is required");
          },
        },
        async run() {},
      },
    });

    const res = await handler(envelope());
    const body = await res.json() as { error: string; message: string; retryable: boolean };

    assert.equal(res.status, 400);
    assert.equal(body.error, "function_run_invalid_payload");
    assert.match(body.message, /message_id is required/);
    assert.equal(body.retryable, false);
  });

  it("maps permanent and retryable helper errors to terminal/retryable statuses", async () => {
    const terminal = defineFunctionRuns({
      "kysigned.forward.process": {
        async run() {
          throw permanentFunctionRunError("bad domain state", "bad_domain_state");
        },
      },
    });
    const transient = defineFunctionRuns({
      "kysigned.forward.process": {
        async run() {
          throw retryableFunctionRunError("upstream unavailable", "upstream_unavailable");
        },
      },
    });

    const terminalRes = await terminal(envelope());
    const transientRes = await transient(envelope());

    assert.equal(terminalRes.status, 400);
    assert.equal(transientRes.status, 500);
    assert.equal(((await terminalRes.json()) as { retryable: boolean }).retryable, false);
    assert.equal(((await transientRes.json()) as { retryable: boolean }).retryable, true);
  });
});

describe("functions.runs.create", () => {
  let lastFetchUrl = "";
  let lastFetchOpts: RequestInit = {};

  beforeEach(() => {
    lastFetchUrl = "";
    lastFetchOpts = {};
    mock.method(globalThis, "fetch", async (url: string, opts: RequestInit) => {
      lastFetchUrl = url;
      lastFetchOpts = opts;
      return new Response(JSON.stringify({
        run_id: "fnrun_created",
        function_name: "worker",
        event_type: "kysigned.reminder.send",
        status: "scheduled",
        terminal: false,
        generation: 1,
        run_at: "2026-07-01T12:10:00.000Z",
        source: { type: "function" },
        attempts: { current: 0, max: 5, total: 0 },
        created_at: "2026-07-01T12:00:00.000Z",
        updated_at: "2026-07-01T12:00:00.000Z",
        next_actions: [],
      }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      });
    });
  });

  it("creates a same-project function run from active context", async () => {
    const run = await runWithContext(activeContext(), async () =>
      functions.runs.create("worker", {
        eventType: "kysigned.reminder.send",
        payload: { envelope_id: "env_123" },
        delay: "10m",
        expiresAfter: "1d",
        idempotencyKey: "reminder:env_123",
        retry: { preset: "standard", maxAttempts: 3 },
      }));

    assert.equal(run.run_id, "fnrun_created");
    assert.equal(lastFetchUrl, "https://test.run402.com/functions/v1/worker/runs");
    assert.equal(lastFetchOpts.method, "POST");
    const headers = lastFetchOpts.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer sk_test");
    assert.equal(headers["Content-Type"], "application/json");
    assert.equal(headers["Idempotency-Key"], "reminder:env_123");
    const body = JSON.parse(lastFetchOpts.body as string) as Record<string, unknown>;
    assert.equal(body.event_type, "kysigned.reminder.send");
    assert.deepEqual(body.payload, { envelope_id: "env_123" });
    assert.equal(body.delay_seconds, 600);
    assert.equal(body.idempotency_key, "reminder:env_123");
    assert.deepEqual(body.retry, {
      preset: "standard",
      max_attempts: 3,
    });
    assert.match(String(body.expires_at), /^20\d\d-/);
  });

  it("rejects missing context before fetching", async () => {
    await assert.rejects(
      () => functions.runs.create("worker", {
        eventType: "x",
        idempotencyKey: "x",
      }),
      Run402FunctionRunContextError,
    );
    assert.equal(lastFetchUrl, "");
  });

  it("rejects missing idempotency and ambiguous delay before fetching", async () => {
    await runWithContext(activeContext(), async () => {
      await assert.rejects(
        () => functions.runs.create("worker", { eventType: "x" }),
        Run402FunctionRunInputError,
      );
      await assert.rejects(
        () => functions.runs.create("worker", {
          eventType: "x",
          idempotencyKey: "x",
          delay: "10m",
          runAt: "2026-07-01T12:10:00.000Z",
        }),
        Run402FunctionRunInputError,
      );
    });
    assert.equal(lastFetchUrl, "");
  });
});
