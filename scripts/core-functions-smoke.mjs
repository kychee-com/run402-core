import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const baseUrl = process.env.CORE_SMOKE_BASE_URL || "http://127.0.0.1:4020";
const fixtureDir = new URL("../fixtures/functions-runtime-core/", import.meta.url);
const restartEnabled = process.env.CORE_CONFORMANCE_RESTART === "1";
const requestBodyLimitBytes = 6 * 1024 * 1024;

const project = await postJson("/projects/v1", { name: "core-functions-smoke" });
const serviceHeaders = { apikey: project.service_key };

const files = {
  apiV1: await fixtureFile("functions/api-v1.mjs", "application/javascript"),
  apiV2: await fixtureFile("functions/api-v2.mjs", "application/javascript"),
  migration: await fixtureFile("migrations/001_functions_fixture.sql", "text/plain"),
  staticHtml: await fixtureFile("site/static.html", "text/html"),
  publicObject: await fixtureFile("objects/public.txt", "text/plain"),
};

for (const file of [files.apiV1, files.apiV2, files.staticHtml]) {
  await stageContent(project.project_id, file);
}

const adminAuth = await devAuthorization("user_admin");
const viewerAuth = await devAuthorization("user_viewer");

await expectMissingSecretBlocksCommit();
await setFunctionSecret("API_TOKEN", "core-secret-value");

const firstRelease = await applySpec(functionSpec(files.apiV1));
await expectRestRls(adminAuth, viewerAuth);
await expectStorageAsset();
await expectStaticAliasWins();
await expectRoutedJsonFidelity();
await expectAuthGate(viewerAuth);
await expectRoleGate(adminAuth, viewerAuth);
await expectSecretUsage();
await expectLogsAndDiagnostics();
await expectUncaughtErrorDiagnostics();
await expectBinaryBody();
await expectRedirectAndCookies();
await expectHeadOmitsBody();
await expectCorsOwnership();
await expectDirectInvoke();
await expectScheduledTrigger();
await expectRequestBodyLimit();
await expectResponseBodyLimit();
await expectQueuedInvocations();
await expectTimeout();
await expectUnsupportedDynamicFeature();
await expectNoopReapply(files.apiV1);

const stalePlan = await createPlan(functionSpec(files.apiV2, { base: { release: "current" } }));
const replacement = await applySpec(functionSpec(files.apiV2, { base: { release: "current" } }));
await expectPostJsonFailure(`/apply/v1/plans/${stalePlan.plan_id}/commit`, {
  release_spec_digest: stalePlan.release_spec_digest,
}, 409, "stale_plan");
await expectJson(`/projects/v1/${project.project_id}/static/api/version`, { version: "v2", method: "GET", path: "/api/version" });
await expectCleanup();

if (restartEnabled) {
  await restartFunctionWorker();
  await waitForFunctionVersion("v2");
}

console.log(JSON.stringify({
  status: "ok",
  project_id: project.project_id,
  release_id: firstRelease.release_id,
  replacement_release_id: replacement.release_id,
  routed_checks: [
    "static-route-priority",
    "migration-rls",
    "storage-asset",
    "routed-http-fidelity",
    "auth-gate",
    "role-gate",
    "secret-injection",
    "logs-request-id-diagnostics",
    "uncaught-error-diagnostics",
    "binary-body",
    "multiple-cookies",
    "redirect",
    "head-omits-body",
    "cache-defaults",
    "cors-owned-by-function",
    "request-body-limit",
    "response-body-limit",
    "timeout",
    "queue",
    "scheduled-manual-trigger",
    "no-op-reapply",
    "stale-plan-rejection",
    "unsupported-dynamic-feature",
    "cleanup",
  ],
  direct_checks: ["direct-invoke"],
  restart_checks: restartEnabled ? ["worker-restart-after-release-change"] : [],
}, null, 2));

async function expectStaticAliasWins() {
  const response = await fetch(`${baseUrl}/projects/v1/${project.project_id}/static/api/static`);
  const text = await response.text();
  if (response.status !== 200) {
    throw new Error(`Expected static alias to return 200, got ${response.status} ${text}`);
  }
  if (!text.includes("static route wins")) {
    throw new Error(`Static alias did not serve static content: ${text}`);
  }
  if (response.headers.get("x-run402-request-id")) {
    throw new Error("Static alias was unexpectedly served by dynamic function runtime.");
  }
}

async function expectRoutedJsonFidelity() {
  const response = await fetch(`${baseUrl}/projects/v1/${project.project_id}/static/api/json?x=1&x=2`, {
    method: "POST",
    headers: {
      cookie: "sid=abc",
      "x-run402-request-id": "spoofed",
      "x-custom": "one",
      "content-type": "text/plain",
    },
    body: "hello",
  });
  const body = await readJsonResponse(response, 203);
  if (body.method !== "POST" || body.path !== "/api/json" || body.rawQuery !== "x=1&x=2") {
    throw new Error(`Routed envelope lost method/path/query fidelity: ${JSON.stringify(body)}`);
  }
  if (body.cookie !== "sid=abc" || body.body !== "hello") {
    throw new Error(`Routed envelope lost cookie/body fidelity: ${JSON.stringify(body)}`);
  }
  if (!/^req_/.test(body.requestId)) {
    throw new Error(`Expected generated request id, got ${JSON.stringify(body)}`);
  }
  if (response.headers.get("x-run402-request-id") !== body.requestId) {
    throw new Error("Routed response did not expose the generated request id.");
  }
  if (response.headers.get("cache-control") !== "private, no-store") {
    throw new Error(`Expected dynamic cache default, got ${response.headers.get("cache-control")}`);
  }
  if (response.headers.get("x-run402-cache") !== "dynamic-bypass") {
    throw new Error(`Expected dynamic cache bypass marker, got ${response.headers.get("x-run402-cache")}`);
  }
  if (response.headers.get("access-control-allow-origin") !== null) {
    throw new Error("Core added CORS by default; function should own CORS.");
  }
  const spoofedHeaders = body.headers.filter(([name, value]) => name === "x-run402-request-id" && value === "spoofed");
  if (spoofedHeaders.length !== 0) {
    throw new Error(`Spoofed x-run402 request id reached function: ${JSON.stringify(body.headers)}`);
  }
  if (body.routePattern !== "/api/*" || body.locale !== null || body.defaultLocale !== null) {
    throw new Error(`Routed context metadata mismatch: ${JSON.stringify(body)}`);
  }
}

async function expectRestRls(adminAuth, viewerAuth) {
  const anonRows = await getRestRows("/function_notes?select=id,owner_id,body&id=eq.note_admin");
  if (anonRows.length !== 0) {
    throw new Error(`Expected anon RLS denial as empty rows, got ${JSON.stringify(anonRows)}`);
  }
  const adminRows = await getRestRows("/function_notes?select=id,owner_id,body&id=eq.note_admin", adminAuth.authorization);
  if (adminRows.length !== 1 || adminRows[0].owner_id !== "user_admin") {
    throw new Error(`Expected admin to read own note, got ${JSON.stringify(adminRows)}`);
  }
  const viewerRows = await getRestRows("/function_notes?select=id,owner_id,body&id=eq.note_admin", viewerAuth.authorization);
  if (viewerRows.length !== 0) {
    throw new Error(`Expected viewer to be denied admin note, got ${JSON.stringify(viewerRows)}`);
  }
}

async function expectStorageAsset() {
  const uploaded = await uploadObject("functions-fixture/public.txt", files.publicObject, "public", true);
  if (!uploaded.public_url || !uploaded.immutable_url) {
    throw new Error(`Expected public and immutable storage URLs, got ${JSON.stringify(uploaded)}`);
  }
  await expectBytes(uploaded.public_url, files.publicObject.bytes, "functions fixture public storage object");
}

async function expectAuthGate(viewerAuth) {
  const blocked = await fetch(`${baseUrl}/projects/v1/${project.project_id}/static/auth/user`);
  await expectError(blocked, 401, "authentication_required");
  if (!/^req_/.test(blocked.headers.get("x-run402-request-id") ?? "")) {
    throw new Error("Auth gate response did not include X-Run402-Request-Id.");
  }

  const passed = await fetch(`${baseUrl}/projects/v1/${project.project_id}/static/auth/user`, {
    headers: {
      authorization: viewerAuth.authorization,
      "x-run402-user-id": "spoofed",
    },
  });
  const body = await readJsonResponse(passed, 200);
  if (body.userId !== "user_viewer" || body.headerUserId !== "user_viewer" || body.authenticated !== true) {
    throw new Error(`Auth gate did not inject generated user context: ${JSON.stringify(body)}`);
  }
}

async function expectRoleGate(adminAuth, viewerAuth) {
  const denied = await fetch(`${baseUrl}/projects/v1/${project.project_id}/static/admin/role`, {
    headers: { authorization: viewerAuth.authorization },
  });
  await expectError(denied, 403, "ROLE_FORBIDDEN");

  const allowed = await fetch(`${baseUrl}/projects/v1/${project.project_id}/static/admin/role`, {
    headers: {
      authorization: adminAuth.authorization,
      "x-run402-user-role": "spoofed",
    },
  });
  const body = await readJsonResponse(allowed, 200);
  if (body.role !== "admin" || body.headerRole !== "admin") {
    throw new Error(`Role gate did not inject generated role context: ${JSON.stringify(body)}`);
  }
}

async function expectSecretUsage() {
  const response = await fetch(`${baseUrl}/projects/v1/${project.project_id}/static/secret/value`);
  const body = await readJsonResponse(response, 200);
  if (body.hasSecret !== true || body.secretLength !== "core-secret-value".length) {
    throw new Error(`Secret route did not receive required secret: ${JSON.stringify(body)}`);
  }

  const listed = await getJson(`/projects/v1/${project.project_id}/functions/secrets`, serviceHeaders);
  if (!listed.secrets?.some((secret) => secret.name === "API_TOKEN") || JSON.stringify(listed).includes("core-secret-value")) {
    throw new Error(`Secret metadata readback was wrong or leaked a value: ${JSON.stringify(listed)}`);
  }
}

async function expectLogsAndDiagnostics() {
  const response = await fetch(`${baseUrl}/projects/v1/${project.project_id}/static/api/logs`);
  const body = await readJsonResponse(response, 200);
  const requestId = response.headers.get("x-run402-request-id");
  if (!/^req_/.test(requestId ?? "") || body.requestId !== requestId) {
    throw new Error(`Log route did not expose stable request id: ${requestId} ${JSON.stringify(body)}`);
  }
  const listed = await getJson(
    `/projects/v1/${project.project_id}/functions/logs?request_id=${encodeURIComponent(requestId)}&tail=20`,
    serviceHeaders,
  );
  const logs = listed.logs ?? [];
  if (!logs.some((entry) => entry.stream === "platform" && entry.message.includes("function_invocation_started"))) {
    throw new Error(`Missing platform start log: ${JSON.stringify(listed)}`);
  }
  if (!logs.some((entry) => entry.stream === "stdout" && entry.redacted === true)) {
    throw new Error(`Missing redacted stdout log: ${JSON.stringify(listed)}`);
  }
  const text = JSON.stringify(logs);
  for (const forbidden of ["core-secret-value", "abcdef123456", "sessionid", "paytoken", "abcd1234abcd1234"]) {
    if (text.includes(forbidden)) {
      throw new Error(`Function logs leaked ${forbidden}: ${text}`);
    }
  }
  const future = await getJson(
    `/projects/v1/${project.project_id}/functions/logs?request_id=${encodeURIComponent(requestId)}&since=2999-01-01T00:00:00.000Z`,
    serviceHeaders,
  );
  if ((future.logs ?? []).length !== 0) {
    throw new Error(`Future since filter returned logs: ${JSON.stringify(future)}`);
  }
}

async function expectUncaughtErrorDiagnostics() {
  const response = await fetch(`${baseUrl}/projects/v1/${project.project_id}/static/api/throw`);
  const text = await response.text();
  if (response.status !== 500) {
    throw new Error(`Expected uncaught function error 500, got ${response.status} ${text}`);
  }
  const body = JSON.parse(text);
  const requestId = response.headers.get("x-run402-request-id");
  if (body.error !== "local_executor_failed" || body.message !== "Function invocation failed." || body.request_id !== requestId) {
    throw new Error(`Unexpected sanitized error response: ${text}`);
  }
  if (text.includes("core-secret-value") || text.includes("fixture uncaught raw")) {
    throw new Error(`Sanitized error response leaked raw details: ${text}`);
  }
  const listed = await getJson(
    `/projects/v1/${project.project_id}/functions/logs?request_id=${encodeURIComponent(requestId)}`,
    serviceHeaders,
  );
  const logs = listed.logs ?? [];
  if (!logs.some((entry) => entry.stream === "platform" && entry.level === "error" && entry.message.includes("function_invocation_failed"))) {
    throw new Error(`Missing platform error log: ${JSON.stringify(listed)}`);
  }
  if (JSON.stringify(logs).includes("fixture uncaught raw")) {
    throw new Error(`Platform error logs leaked raw user exception text: ${JSON.stringify(logs)}`);
  }
}

async function expectBinaryBody() {
  const response = await fetch(`${baseUrl}/projects/v1/${project.project_id}/static/api/binary`);
  if (response.status !== 200) {
    throw new Error(`Binary route failed: ${response.status} ${await response.text()}`);
  }
  const actual = Buffer.from(await response.arrayBuffer());
  const expected = Buffer.from([0, 1, 2, 255]);
  if (!actual.equals(expected)) {
    throw new Error(`Binary route returned wrong bytes: ${actual.toString("hex")}`);
  }
}

async function expectRedirectAndCookies() {
  const response = await fetch(`${baseUrl}/projects/v1/${project.project_id}/static/api/cookies`, {
    redirect: "manual",
  });
  if (response.status !== 302) {
    throw new Error(`Expected redirect status 302, got ${response.status} ${await response.text()}`);
  }
  if (response.headers.get("location") !== "/next") {
    throw new Error(`Expected Location /next, got ${response.headers.get("location")}`);
  }
  const cookies = getSetCookies(response.headers);
  if (!cookies.some((value) => value.startsWith("a=1;")) || !cookies.some((value) => value.startsWith("b=2;"))) {
    throw new Error(`Expected two Set-Cookie headers, got ${JSON.stringify(cookies)}`);
  }
}

async function expectHeadOmitsBody() {
  const response = await fetch(`${baseUrl}/projects/v1/${project.project_id}/static/api/json`, {
    method: "HEAD",
  });
  if (response.status !== 203) {
    throw new Error(`Expected HEAD status 203, got ${response.status} ${await response.text()}`);
  }
  const body = Buffer.from(await response.arrayBuffer());
  if (body.byteLength !== 0) {
    throw new Error("HEAD returned a body.");
  }
  if (Number(response.headers.get("content-length") ?? "0") <= 0) {
    throw new Error(`HEAD did not preserve response content length: ${response.headers.get("content-length")}`);
  }
}

async function expectCorsOwnership() {
  const response = await fetch(`${baseUrl}/projects/v1/${project.project_id}/static/api/cors`);
  const body = await readJsonResponse(response, 200);
  if (body.cors !== true) {
    throw new Error(`CORS route body mismatch: ${JSON.stringify(body)}`);
  }
  if (response.headers.get("access-control-allow-origin") !== "https://allowed.example") {
    throw new Error(`Function-owned CORS header was not preserved: ${response.headers.get("access-control-allow-origin")}`);
  }
}

async function expectDirectInvoke() {
  const response = await fetch(`${baseUrl}/functions/v1/invoke`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...serviceHeaders,
    },
    body: JSON.stringify({
      project_id: project.project_id,
      function_name: "api",
    }),
  });
  const body = await readJsonResponse(response, 200);
  if (!/^req_/.test(body.request_id)) {
    throw new Error(`Expected direct invoke request id, got ${JSON.stringify(body)}`);
  }
  const responseBody = decodeFunctionJsonBody(body.response?.body);
  if (body.response?.status !== 200 || responseBody.kind !== "direct" || responseBody.version !== "v1") {
    throw new Error(`Direct invoke response mismatch: ${JSON.stringify(body)}`);
  }
}

async function expectScheduledTrigger() {
  const body = await postJson(
    `/projects/v1/${project.project_id}/functions/api/trigger`,
    {},
    serviceHeaders,
  );
  if (!/^req_/.test(body.request_id) || body.status !== 200) {
    throw new Error(`Scheduled trigger did not return request id/status: ${JSON.stringify(body)}`);
  }
  const responseBody = decodeFunctionJsonBody(body.response?.body);
  if (
    body.response?.status !== 200 ||
    responseBody.version !== "v1" ||
    responseBody.trigger !== "manual" ||
    responseBody.bodyTrigger !== "manual" ||
    !responseBody.scheduledAt
  ) {
    throw new Error(`Scheduled trigger envelope mismatch: ${JSON.stringify(body)}`);
  }
  if (body.schedule_meta?.run_count < 1 || body.schedule_meta?.last_status !== 200) {
    throw new Error(`Scheduled trigger did not update metadata: ${JSON.stringify(body.schedule_meta)}`);
  }
  const listed = await getJson(
    `/projects/v1/${project.project_id}/functions/logs?request_id=${encodeURIComponent(body.request_id)}&function_name=api&tail=20`,
    serviceHeaders,
  );
  if (!listed.logs?.some((entry) => entry.request_id === body.request_id && entry.message.includes("function_invocation_completed"))) {
    throw new Error(`Scheduled trigger logs missing completion entry: ${JSON.stringify(listed)}`);
  }
}

async function expectRequestBodyLimit() {
  const response = await fetch(`${baseUrl}/projects/v1/${project.project_id}/static/api/json`, {
    method: "POST",
    body: Buffer.alloc(requestBodyLimitBytes + 1),
  });
  await expectError(response, 413, "request_body_too_large");
}

async function expectResponseBodyLimit() {
  const response = await fetch(`${baseUrl}/projects/v1/${project.project_id}/static/api/large`);
  await expectError(response, 502, "response_body_too_large");
}

async function expectQueuedInvocations() {
  const requests = Array.from({ length: 6 }, () => fetch(`${baseUrl}/projects/v1/${project.project_id}/static/api/sleep?ms=300`));
  const responses = await Promise.all(requests);
  for (const response of responses) {
    const body = await readJsonResponse(response, 200);
    if (body.slept !== true || body.version !== "v1") {
      throw new Error(`Queued invocation returned wrong body: ${JSON.stringify(body)}`);
    }
  }
}

async function expectTimeout() {
  const response = await fetch(`${baseUrl}/projects/v1/${project.project_id}/static/api/slow`);
  await expectError(response, 504, "dynamic_runtime_timeout");
}

async function expectMissingSecretBlocksCommit() {
  const plan = await createPlan(functionSpec(files.apiV1));
  await expectPostJsonFailure(`/apply/v1/plans/${plan.plan_id}/commit`, {
    release_spec_digest: plan.release_spec_digest,
  }, 422, "missing_required_secret");
}

async function expectUnsupportedDynamicFeature() {
  await expectPostJsonFailure("/apply/v1/plans", {
    spec: {
      project: project.project_id,
      functions: {
        replace: {
          api: {
            runtime: "node22",
            source: contentRef(files.apiV1),
            deps: ["lodash@^4.17.0"],
          },
        },
      },
    },
  }, 422, "dependency_install_rejected");
}

async function expectNoopReapply(apiFile) {
  const plan = await createPlan(functionSpec(apiFile, { base: { release: "current" } }));
  if (plan.noop !== true) {
    throw new Error(`Expected functions reapply to be noop, got ${JSON.stringify(plan)}`);
  }
  const commit = await postJson(`/apply/v1/plans/${plan.plan_id}/commit`, {
    release_spec_digest: plan.release_spec_digest,
  });
  if (commit.status !== "noop") {
    throw new Error(`Expected noop functions commit, got ${JSON.stringify(commit)}`);
  }
}

async function expectCleanup() {
  const cleanup = await postJson(`/projects/v1/${project.project_id}/storage/cleanup`, {}, serviceHeaders);
  if (!Array.isArray(cleanup.retained_live_sha256) || !cleanup.retained_live_sha256.includes(files.apiV2.sha256)) {
    throw new Error(`Cleanup did not retain active function bundle ref: ${JSON.stringify(cleanup)}`);
  }
  if (typeof cleanup.removed_function_logs !== "number") {
    throw new Error(`Cleanup did not report function log cleanup count: ${JSON.stringify(cleanup)}`);
  }
}

async function expectJson(path, expected) {
  const response = await fetch(`${baseUrl}${path}`);
  const body = await readJsonResponse(response, 200);
  for (const [key, value] of Object.entries(expected)) {
    if (body[key] !== value) {
      throw new Error(`Expected ${key}=${value}, got ${JSON.stringify(body)}`);
    }
  }
}

async function waitForFunctionVersion(version) {
  let lastError = "";
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await expectJson(`/projects/v1/${project.project_id}/static/api/version`, {
        version,
        method: "GET",
        path: "/api/version",
      });
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Function worker did not serve version ${version} after restart: ${lastError}`);
}

function functionSpec(apiFile, options = {}) {
  const functionEntry = {
    runtime: "node22",
    source: contentRef(apiFile),
    config: { timeoutSeconds: 10, memoryMb: 128 },
  };
  const migrationSql = files.migration.bytes.toString("utf8");
  return {
    project: project.project_id,
    base: options.base ?? { release: "current" },
    database: {
      migrations: [
        {
          id: "001_functions_fixture",
          checksum: files.migration.sha256,
          sql: migrationSql,
        },
      ],
    },
    secrets: {
      require: ["API_TOKEN"],
    },
    functions: {
      replace: {
        api: {
          ...functionEntry,
          schedule: "*/5 * * * *",
        },
        auth: {
          ...functionEntry,
          requireAuth: true,
        },
        admin: {
          ...functionEntry,
          requireAuth: true,
          requireRole: {
            table: "members",
            idColumn: "user_id",
            roleColumn: "role",
            allowed: ["admin"],
            cacheTtl: 0,
          },
        },
        secret: {
          ...functionEntry,
        },
      },
    },
    site: {
      replace: {
        "static.html": contentRef(files.staticHtml),
      },
      public_paths: {
        mode: "explicit",
        replace: {},
      },
    },
    routes: {
      replace: [
        {
          pattern: "/api/static",
          methods: ["GET", "HEAD"],
          target: { type: "static", file: "static.html" },
        },
        {
          pattern: "/api/*",
          methods: ["GET", "POST", "HEAD"],
          target: { type: "function", name: "api" },
        },
        {
          pattern: "/auth/*",
          methods: ["GET"],
          target: { type: "function", name: "auth" },
        },
        {
          pattern: "/admin/*",
          methods: ["GET"],
          target: { type: "function", name: "admin" },
        },
        {
          pattern: "/secret/*",
          methods: ["GET"],
          target: { type: "function", name: "secret" },
        },
      ],
    },
  };
}

async function fixtureFile(relativePath, contentType) {
  const bytes = await readFile(new URL(relativePath, fixtureDir));
  return {
    relativePath,
    bytes,
    sha256: sha256Hex(bytes),
    size: bytes.byteLength,
    contentType,
  };
}

async function stageContent(projectId, file) {
  await postJson(`/projects/v1/${projectId}/content`, {
    sha256: file.sha256,
    size: file.size,
    content_type: file.contentType,
    bytes_base64: file.bytes.toString("base64"),
  });
}

async function devAuthorization(sub) {
  return await postJson("/auth/v1/dev-tokens", {
    project_id: project.project_id,
    role: "authenticated",
    sub,
  });
}

async function setFunctionSecret(name, value) {
  return await postJson(
    `/projects/v1/${project.project_id}/functions/secrets`,
    { name, value },
    serviceHeaders,
  );
}

async function createPlan(spec) {
  return await postJson("/apply/v1/plans", { spec });
}

async function applySpec(spec) {
  const plan = await createPlan(spec);
  const commit = await postJson(`/apply/v1/plans/${plan.plan_id}/commit`, {
    release_spec_digest: plan.release_spec_digest,
  });
  if (commit.status !== "committed" && commit.status !== "noop") {
    throw new Error(`Expected committed or noop apply, got ${JSON.stringify(commit)}`);
  }
  return commit;
}

async function getJson(pathOrUrl, headers = {}) {
  const response = await fetch(resolveUrl(pathOrUrl), {
    headers,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GET ${pathOrUrl} failed: ${response.status} ${text}`);
  }
  return JSON.parse(text);
}

async function postJson(pathOrUrl, body, headers = {}) {
  const response = await fetch(resolveUrl(pathOrUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`POST ${pathOrUrl} failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function expectPostJsonFailure(pathOrUrl, body, expectedStatus, expectedError) {
  const response = await fetch(resolveUrl(pathOrUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (response.status !== expectedStatus) {
    throw new Error(`Expected POST ${pathOrUrl} to fail with ${expectedStatus}, got ${response.status} ${text}`);
  }
  const parsed = JSON.parse(text);
  if (parsed.error !== expectedError) {
    throw new Error(`Expected POST ${pathOrUrl} error ${expectedError}, got ${text}`);
  }
}

async function readJsonResponse(response, expectedStatus) {
  const text = await response.text();
  if (response.status !== expectedStatus) {
    throw new Error(`Expected ${response.url} to return ${expectedStatus}, got ${response.status} ${text}`);
  }
  return JSON.parse(text);
}

async function expectError(response, expectedStatus, expectedError) {
  const text = await response.text();
  if (response.status !== expectedStatus) {
    throw new Error(`Expected ${response.url} to fail with ${expectedStatus}, got ${response.status} ${text}`);
  }
  const body = JSON.parse(text);
  if (body.error !== expectedError) {
    throw new Error(`Expected error ${expectedError}, got ${text}`);
  }
}

async function uploadObject(key, file, visibility, immutable) {
  const session = await postJson(
    `/projects/v1/${project.project_id}/storage/uploads`,
    {
      key,
      size_bytes: file.size,
      sha256: file.sha256,
      content_type: file.contentType,
      visibility,
      immutable,
    },
    serviceHeaders,
  );
  await putBytes(session.upload_url, file.bytes, serviceHeaders);
  return await postJson(
    `/projects/v1/${project.project_id}/storage/uploads/${session.upload_id}/complete`,
    {},
    serviceHeaders,
  );
}

async function putBytes(pathOrUrl, bytes, headers = {}) {
  const response = await fetch(resolveUrl(pathOrUrl), {
    method: "PUT",
    headers,
    body: bytes,
  });
  if (!response.ok) {
    throw new Error(`PUT ${pathOrUrl} failed: ${response.status} ${await response.text()}`);
  }
}

async function expectBytes(pathOrUrl, expectedBytes, label, headers = {}) {
  const response = await fetch(resolveUrl(pathOrUrl), { headers });
  if (!response.ok) {
    throw new Error(`${label} failed: ${response.status} ${await response.text()}`);
  }
  const actual = Buffer.from(await response.arrayBuffer());
  if (!actual.equals(expectedBytes)) {
    throw new Error(`${label} returned wrong bytes: ${actual.toString("hex")}`);
  }
}

async function getRestRows(path, authorization) {
  let lastStatus = 0;
  let lastText = "";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await fetch(`${project.endpoints.rest_url}${path}`, {
      headers: {
        "accept-profile": project.schema_slot,
        ...(authorization ? { authorization } : {}),
      },
    });
    lastStatus = response.status;
    lastText = await response.text();
    if (response.ok) return JSON.parse(lastText);
    if (response.status !== 404 && response.status !== 503) {
      throw new Error(`REST ${path} failed: ${response.status} ${lastText}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`REST ${path} did not become available: ${lastStatus} ${lastText}`);
}

function decodeFunctionJsonBody(body) {
  if (!body || body.encoding !== "base64") {
    throw new Error(`Missing function base64 body: ${JSON.stringify(body)}`);
  }
  return JSON.parse(Buffer.from(body.data, "base64").toString("utf8"));
}

function contentRef(file) {
  return {
    sha256: file.sha256,
    size: file.size,
    contentType: file.contentType,
  };
}

function getSetCookies(headers) {
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const raw = headers.get("set-cookie");
  return raw ? raw.split(/, (?=[^;,]+=)/) : [];
}

async function restartFunctionWorker() {
  await execFileAsync("docker", ["compose", "restart", "function-worker"], {
    cwd: new URL("../", import.meta.url).pathname,
    timeout: 120_000,
  });
}

function resolveUrl(pathOrUrl) {
  if (/^https?:\/\//.test(pathOrUrl)) return pathOrUrl;
  return `${baseUrl}${pathOrUrl}`;
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
