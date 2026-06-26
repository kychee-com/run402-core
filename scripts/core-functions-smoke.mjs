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
  staticHtml: await fixtureFile("site/static.html", "text/html"),
};

for (const file of Object.values(files)) {
  await stageContent(project.project_id, file);
}

const firstRelease = await applySpec(functionSpec(files.apiV1));
await expectStaticAliasWins();
await expectRoutedJsonFidelity();
await expectBinaryBody();
await expectRedirectAndCookies();
await expectHeadOmitsBody();
await expectCorsOwnership();
await expectDirectInvoke();
await expectRequestBodyLimit();
await expectResponseBodyLimit();
await expectQueuedInvocations();
await expectTimeout();

const replacement = await applySpec(functionSpec(files.apiV2, { base: { release: "current" } }));
await expectJson(`/projects/v1/${project.project_id}/static/api/version`, { version: "v2", method: "GET", path: "/api/version" });

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
    "routed-http-fidelity",
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
  return {
    project: project.project_id,
    base: options.base ?? { release: "current" },
    functions: {
      replace: {
        api: {
          runtime: "node22",
          source: contentRef(apiFile),
          config: { timeoutSeconds: 10, memoryMb: 128 },
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

async function applySpec(spec) {
  const plan = await postJson("/apply/v1/plans", { spec });
  const commit = await postJson(`/apply/v1/plans/${plan.plan_id}/commit`, {
    release_spec_digest: plan.release_spec_digest,
  });
  if (commit.status !== "committed" && commit.status !== "noop") {
    throw new Error(`Expected committed or noop apply, got ${JSON.stringify(commit)}`);
  }
  return commit;
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
