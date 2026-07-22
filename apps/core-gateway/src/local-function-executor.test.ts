import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  CORE_FUNCTION_RESOURCE_DEFAULTS,
  DynamicRuntimeBusyError,
  DynamicRuntimeTimeoutError,
  CORE_FUNCTION_DEPENDENCY_MODE,
  ResponseBodyTooLargeError,
  type CoreFunctionBundleMetadata,
} from "@run402/runtime-kernel";
import { FilesystemContentStore } from "./filesystem-content.js";
import { LocalFunctionExecutor } from "./local-function-executor.js";

const PROJECT_ID = "prj_0000000000000001";
const RELEASE_ID = "rel_test";

test("local function executor runs a prebundled source ref with scrubbed env", async () => {
  const fixture = await createExecutorFixture(`
    import { routedHttp } from "@run402/functions";

    export default async function handler(event) {
      console.log("hello from user code");
      return routedHttp.json({
        path: event.path,
        project: process.env.RUN402_PROJECT_ID,
        secret: process.env.API_TOKEN ?? null,
        leakedDatabaseUrl: process.env.CORE_DATABASE_URL ?? null
      });
    }
  `);
  const previousDatabaseUrl = process.env.CORE_DATABASE_URL;
  process.env.CORE_DATABASE_URL = "postgres://should-not-leak";
  try {
    const result = await fixture.executor.invoke({
      projectId: PROJECT_ID,
      releaseId: RELEASE_ID,
      functionName: "api",
      invocationKind: "routed_http",
      requestId: "req_executor_1",
      bundle: fixture.bundle,
      secrets: { API_TOKEN: "secret-value" },
      request: routedRequest("req_executor_1", "/api/hello"),
    });

    assert.equal(result.requestId, "req_executor_1");
    assert.equal(result.response.status, 200);
    const body = decodeJsonBody(result.response.body);
    assert.deepEqual(body, {
      path: "/api/hello",
      project: PROJECT_ID,
      secret: "secret-value",
      leakedDatabaseUrl: null,
    });
    assert.equal(result.logs.some((entry) => entry.stream === "stdout" && entry.message.includes("hello from user code")), true);
  } finally {
    if (previousDatabaseUrl === undefined) {
      delete process.env.CORE_DATABASE_URL;
    } else {
      process.env.CORE_DATABASE_URL = previousDatabaseUrl;
    }
    await fixture.cleanup();
  }
});

test("local function executor normalizes SSR Web Request and Web Response", async () => {
  const fixture = await createExecutorFixture(`
    export default async function handler(request) {
      const body = await request.text();
      const headers = new Headers({ "content-type": "text/plain; charset=utf-8" });
      headers.append("set-cookie", "a=1; Path=/");
      headers.append("set-cookie", "b=2; Path=/");
      return new Response(request.method + " " + new URL(request.url).pathname + " " + body, {
        status: 207,
        headers
      });
    }
  `);
  fixture.bundle.class = "ssr";
  fixture.bundle.capabilities = ["astro.ssr.v1"];
  try {
    const result = await fixture.executor.invoke({
      projectId: PROJECT_ID,
      releaseId: RELEASE_ID,
      functionName: "ssr",
      invocationKind: "routed_http",
      requestId: "req_ssr_1",
      bundle: fixture.bundle,
      request: {
        ...routedRequest("req_ssr_1", "/settings"),
        method: "POST",
        url: "http://localhost/settings?tab=billing",
        rawQuery: "tab=billing",
        body: {
          encoding: "base64",
          data: Buffer.from("hello").toString("base64"),
          size: 5,
        },
      },
    });

    assert.equal(result.requestId, "req_ssr_1");
    assert.equal(result.response.status, 207);
    assert.equal(Buffer.from(result.response.body?.data ?? "", "base64").toString("utf8"), "POST /settings hello");
    assert.equal(result.response.cookies?.some((cookie) => cookie.startsWith("a=1;")), true);
    assert.equal(result.response.cookies?.some((cookie) => cookie.startsWith("b=2;")), true);
  } finally {
    await fixture.cleanup();
  }
});

test("Core routed requests omit Cloud tenant payment context", async () => {
  const fixture = await createExecutorFixture(`
    export default async function handler(request) {
      return Response.json({
        contextPayment: request.context?.payment ?? null,
        headerPaymentId: request.headers.get("x-run402-payment-id")
      });
    }
  `);
  try {
    const result = await fixture.executor.invoke({
      projectId: PROJECT_ID,
      releaseId: RELEASE_ID,
      functionName: "api",
      invocationKind: "routed_http",
      requestId: "req_core_unpriced_1",
      bundle: fixture.bundle,
      request: routedRequest("req_core_unpriced_1", "/api/free"),
    });

    assert.deepEqual(decodeJsonBody(result.response.body), {
      contextPayment: null,
      headerPaymentId: null,
    });
  } finally {
    await fixture.cleanup();
  }
});

test("local function executor forwards confirmed payment headers to Web Request handlers", async () => {
  const fixture = await createExecutorFixture(`
    export default async function handler(request) {
      return new Response(JSON.stringify({
        amount: Number(request.headers.get("x-run402-payment-amount-usd-micros")),
        network: request.headers.get("x-run402-payment-network"),
        payTo: request.headers.get("x-run402-payment-pay-to"),
        settledAt: request.headers.get("x-run402-payment-settled-at"),
        headerPaymentId: request.headers.get("x-run402-payment-id"),
        headerIdempotencyKey: request.headers.get("x-run402-payment-idempotency-key"),
        headerDeduplicated: request.headers.get("x-run402-payment-deduplicated"),
        headerDelivery: request.headers.get("x-run402-payment-delivery"),
        contextPaymentId: request.context?.payment?.paymentId ?? null,
        contextIdempotencyKey: request.context?.payment?.idempotencyKey ?? null
      }), {
        headers: { "content-type": "application/json; charset=utf-8" }
      });
    }
  `);
  const payment = {
    scheme: "x402" as const,
    paymentId: "pay_executor_1",
    idempotencyKey: "order:executor:1",
    deduplicated: true,
    delivery: "replay" as const,
    amountUsdMicros: 250000,
    payer: "0x000000000000000000000000000000000000b0b0",
    network: "base",
    asset: "0x0000000000000000000000000000000000000001",
    payTo: "0x000000000000000000000000000000000000cafe",
    transaction: "0xabc",
    settledAt: "2026-07-07T10:00:00.000Z",
  };
  const request = routedRequest("req_payment_1", "/api/credits");
  try {
    const result = await fixture.executor.invoke({
      projectId: PROJECT_ID,
      releaseId: RELEASE_ID,
      functionName: "api",
      invocationKind: "routed_http",
      requestId: "req_payment_1",
      bundle: fixture.bundle,
      request: {
        ...request,
        headers: [
          ...request.headers,
          ["x-run402-payment-scheme", "x402"],
          ["x-run402-payment-id", payment.paymentId],
          ["x-run402-payment-idempotency-key", payment.idempotencyKey],
          ["x-run402-payment-deduplicated", String(payment.deduplicated)],
          ["x-run402-payment-delivery", payment.delivery],
          ["x-run402-payment-amount-usd-micros", String(payment.amountUsdMicros)],
          ["x-run402-payment-payer", payment.payer],
          ["x-run402-payment-network", payment.network],
          ["x-run402-payment-asset", payment.asset],
          ["x-run402-payment-pay-to", payment.payTo],
          ["x-run402-payment-transaction", payment.transaction],
          ["x-run402-payment-settled-at", payment.settledAt],
        ],
        context: {
          ...request.context,
          payment,
        },
      },
    });

    assert.equal(result.response.status, 200);
    const body = decodeJsonBody(result.response.body) as {
      amount: number;
      network: string;
      payTo: string;
      settledAt: string;
      headerPaymentId: string;
      headerIdempotencyKey: string;
      headerDeduplicated: string;
      headerDelivery: string;
      contextPaymentId: string;
      contextIdempotencyKey: string;
    };
    assert.equal(body.amount, payment.amountUsdMicros);
    assert.equal(body.network, payment.network);
    assert.equal(body.payTo, payment.payTo);
    assert.equal(body.settledAt, payment.settledAt);
    assert.equal(body.headerPaymentId, payment.paymentId);
    assert.equal(body.headerIdempotencyKey, payment.idempotencyKey);
    assert.equal(body.headerDeduplicated, "true");
    assert.equal(body.headerDelivery, "replay");
    assert.equal(body.contextPaymentId, payment.paymentId);
    assert.equal(body.contextIdempotencyKey, payment.idempotencyKey);
  } finally {
    await fixture.cleanup();
  }
});

test("local function executor rejects busy and timed-out invocations", async () => {
  const busy = await createExecutorFixture(`
    export default async function handler() {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { ok: true };
    }
  `, { maxConcurrentInvocations: 1, maxPendingInvocations: 0 });
  try {
    const first = busy.executor.invoke({
      projectId: PROJECT_ID,
      releaseId: RELEASE_ID,
      functionName: "slow",
      invocationKind: "direct",
      requestId: "req_busy_1",
      bundle: busy.bundle,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await assert.rejects(
      busy.executor.invoke({
        projectId: PROJECT_ID,
        releaseId: RELEASE_ID,
        functionName: "slow",
        invocationKind: "direct",
        requestId: "req_busy_2",
        bundle: busy.bundle,
      }),
      DynamicRuntimeBusyError,
    );
    await first;
  } finally {
    await busy.cleanup();
  }

  const timeout = await createExecutorFixture(`
    export default async function handler() {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { ok: true };
    }
  `, { invocationTimeoutMs: 25 });
  try {
    await assert.rejects(
      timeout.executor.invoke({
        projectId: PROJECT_ID,
        releaseId: RELEASE_ID,
        functionName: "timeout",
        invocationKind: "direct",
        requestId: "req_timeout_1",
        bundle: timeout.bundle,
      }),
      DynamicRuntimeTimeoutError,
    );
  } finally {
    await timeout.cleanup();
  }
});

test("local function executor queues pending invocations within the configured limit", async () => {
  const fixture = await createExecutorFixture(`
    export default async function handler(event) {
      await new Promise((resolve) => setTimeout(resolve, 75));
      return { requestId: event.requestId };
    }
  `, { maxConcurrentInvocations: 1, maxPendingInvocations: 1 });
  try {
    const first = fixture.executor.invoke({
      projectId: PROJECT_ID,
      releaseId: RELEASE_ID,
      functionName: "queued",
      invocationKind: "direct",
      requestId: "req_queue_1",
      bundle: fixture.bundle,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = fixture.executor.invoke({
      projectId: PROJECT_ID,
      releaseId: RELEASE_ID,
      functionName: "queued",
      invocationKind: "direct",
      requestId: "req_queue_2",
      bundle: fixture.bundle,
    });

    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.deepEqual(decodeJsonBody(firstResult.response.body), { requestId: "req_queue_1" });
    assert.deepEqual(decodeJsonBody(secondResult.response.body), { requestId: "req_queue_2" });
  } finally {
    await fixture.cleanup();
  }
});

test("local function executor enforces response body limit", async () => {
  const fixture = await createExecutorFixture(`
    export default async function handler() {
      return "too large";
    }
  `, { responseBodyLimitBytes: 4 });
  try {
    await assert.rejects(
      fixture.executor.invoke({
        projectId: PROJECT_ID,
        releaseId: RELEASE_ID,
        functionName: "large",
        invocationKind: "direct",
        requestId: "req_large_1",
        bundle: fixture.bundle,
      }),
      ResponseBodyTooLargeError,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("local function executor caps stdout and stderr logs", async () => {
  const fixture = await createExecutorFixture(`
    export default async function handler() {
      console.error("y".repeat(${CORE_FUNCTION_RESOURCE_DEFAULTS.maxLogLineBytes + 1024}));
      for (let i = 0; i < 80; i += 1) console.log("line-" + i + "-" + "x".repeat(2048));
      return { ok: true };
    }
  `);
  try {
    const result = await fixture.executor.invoke({
      projectId: PROJECT_ID,
      releaseId: RELEASE_ID,
      functionName: "logs",
      invocationKind: "direct",
      requestId: "req_logs_1",
      bundle: fixture.bundle,
    });
    const totalLogBytes = result.logs.reduce((sum, entry) => sum + Buffer.byteLength(entry.message), 0);
    assert.ok(totalLogBytes <= CORE_FUNCTION_RESOURCE_DEFAULTS.stdoutStderrLimitBytes);
    assert.equal(
      result.logs.every((entry) => Buffer.byteLength(entry.message) <= CORE_FUNCTION_RESOURCE_DEFAULTS.maxLogLineBytes),
      true,
    );
    assert.equal(result.logs.some((entry) => entry.message.includes("...[truncated]")), true);
  } finally {
    await fixture.cleanup();
  }
});

async function createExecutorFixture(source: string, options: {
  invocationTimeoutMs?: number;
  maxConcurrentInvocations?: number;
  maxPendingInvocations?: number;
  responseBodyLimitBytes?: number;
} = {}) {
  const id = randomUUID();
  const root = path.join(process.cwd(), ".run402-core", "executor-tests", id);
  const content = new FilesystemContentStore(path.join(root, "content"));
  const bytes = Buffer.from(source, "utf8");
  const sha256 = sha256Hex(bytes);
  await content.putStatic({
    projectId: PROJECT_ID,
    sha256,
    bytes,
    contentType: "application/javascript",
  });
  const bundle = functionBundle(sha256, bytes.byteLength);
  return {
    bundle,
    executor: new LocalFunctionExecutor({
      content,
      workDir: path.join(root, "work"),
      invocationTimeoutMs: options.invocationTimeoutMs,
      maxConcurrentInvocations: options.maxConcurrentInvocations,
      maxPendingInvocations: options.maxPendingInvocations,
      responseBodyLimitBytes: options.responseBodyLimitBytes,
    }),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function functionBundle(sha256: string, size: number): CoreFunctionBundleMetadata {
  return {
    name: "api",
    runtime: "node22",
    entrypoint: "default",
    source: { sha256, size, contentType: "application/javascript" },
    bundle_sha256: sha256,
    bundle_size_bytes: size,
    dependency_mode: CORE_FUNCTION_DEPENDENCY_MODE,
    dependency_lock_digest: null,
    deps: [],
    required_secrets: [],
    timeout_ms: 10_000,
    memory_bytes: 128 * 1024 * 1024,
    require_auth: false,
    require_role: null,
    class: "standard",
    capabilities: [],
  };
}

function routedRequest(requestId: string, pathName: string) {
  return {
    version: "run402.routed_http.v1" as const,
    method: "GET",
    url: `http://localhost${pathName}`,
    path: pathName,
    rawPath: pathName,
    rawQuery: "",
    headers: [["host", "localhost"]] as Array<[string, string]>,
    cookies: { raw: null },
    body: null,
    context: {
      source: "route" as const,
      projectId: PROJECT_ID,
      releaseId: RELEASE_ID,
      deploymentId: null,
      host: "localhost",
      proto: "http" as const,
      routePattern: "/api/*",
      routeKind: "prefix" as const,
      routeTarget: { type: "function" as const, name: "api" },
      requestId,
    },
  };
}

function decodeJsonBody(body: { encoding: "base64"; data: string; size: number } | null | undefined): unknown {
  assert.ok(body);
  return JSON.parse(Buffer.from(body.data, "base64").toString("utf8"));
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
