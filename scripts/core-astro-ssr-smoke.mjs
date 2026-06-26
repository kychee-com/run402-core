import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const baseUrl = process.env.CORE_SMOKE_BASE_URL || "http://127.0.0.1:4020";
const fixtureDir = new URL("../fixtures/astro-ssr-core/", import.meta.url);
const restartEnabled = process.env.CORE_CONFORMANCE_RESTART === "1";
const ssrSecretValue = "astro-secret-value";

const project = await postJson("/projects/v1", { name: "core-astro-ssr-smoke" });
const serviceHeaders = { apikey: project.service_key };

const files = {
  ssr: await fixtureFile("functions/ssr.mjs", "application/javascript"),
  api: await fixtureFile("functions/api.mjs", "application/javascript"),
  login: await fixtureFile("site/login.html", "text/html"),
  dashboard: await fixtureFile("site/dashboard.html", "text/html"),
  asset: await fixtureFile("site/assets/app.txt", "text/plain"),
};

for (const file of Object.values(files)) {
  await stageContent(project.project_id, file);
}

await expectMissingSecretBlocksCommit();
await expectUnsupportedAstroContracts();
await setFunctionSecret("SESSION_SECRET", ssrSecretValue);

const firstRelease = await applySpec(astroSpec());
await expectStaticAliasWins();
await expectPublicAssetWins();
await expectPrerenderedHtmlWins();
await expectFunctionRouteWins();
await expectSsrFallbackGet();
await expectSsrFallbackPost();
await expectRedirect();
await expectCookies();
await expectBinary();
await expectHeadOmitsBody();
await expectSecretUsage();
await expectLogsAndDiagnostics();
await expectUpgradeUnsupported();
await expectNoopReapply();

const stalePlan = await createPlan(astroSpec({ extraStaticRoute: "/stale-login" }));
const replacement = await applySpec(astroSpec({ extraStaticRoute: "/alternate-login" }));
await expectPostJsonFailure(`/apply/v1/plans/${stalePlan.plan_id}/commit`, {
  release_spec_digest: stalePlan.release_spec_digest,
}, 409, "stale_plan");
await expectStaticText("/alternate-login", "static login alias wins before Astro SSR");
await expectSsrFallbackGet();
await expectCleanup();

if (restartEnabled) {
  await restartFunctionWorker();
  await waitForSsrFallback();
}

console.log(JSON.stringify({
  status: "ok",
  project_id: project.project_id,
  release_id: firstRelease.release_id,
  replacement_release_id: replacement.release_id,
  astro_ssr_checks: [
    "supported-output-contract",
    "missing-secret-commit-failure",
    "unsupported-output-contract",
    "multiple-ssr-target-rejection",
    "static-alias-before-ssr",
    "public-asset-before-ssr",
    "prerendered-html-before-ssr",
    "function-route-before-ssr",
    "ssr-fallback-get",
    "ssr-fallback-post-body",
    "redirect",
    "multiple-cookies",
    "binary-body",
    "head-omits-body",
    "secret-injection",
    "logs-request-id-diagnostics",
    "upgrade-unsupported",
    "no-op-reapply",
    "stale-plan-rejection",
    "cleanup",
  ],
  restart_checks: restartEnabled ? ["worker-restart-after-ssr-release"] : [],
}, null, 2));

async function expectStaticAliasWins() {
  await expectStaticText("/login", "static login alias wins before Astro SSR");
}

async function expectPublicAssetWins() {
  await expectStaticText("/assets/app.txt", "static public asset wins before Astro SSR");
}

async function expectPrerenderedHtmlWins() {
  await expectStaticText("/dashboard", "prerendered dashboard wins before Astro SSR");
}

async function expectStaticText(path, expected) {
  const response = await fetch(staticUrl(path));
  const text = await response.text();
  if (response.status !== 200) {
    throw new Error(`Expected static ${path} to return 200, got ${response.status} ${text}`);
  }
  if (!text.includes(expected)) {
    throw new Error(`Static ${path} returned unexpected body: ${text}`);
  }
  if (response.headers.get("x-run402-request-id")) {
    throw new Error(`Static ${path} was unexpectedly served by the dynamic runtime.`);
  }
}

async function expectFunctionRouteWins() {
  const response = await fetch(staticUrl("/api/users?x=1&x=2"));
  const body = await readJsonResponse(response, 200);
  if (body.kind !== "function-route" || body.path !== "/api/users" || body.rawQuery !== "x=1&x=2") {
    throw new Error(`Function route did not win over SSR fallback: ${JSON.stringify(body)}`);
  }
  if (body.routePattern !== "/api/*") {
    throw new Error(`Function route metadata mismatch: ${JSON.stringify(body)}`);
  }
  if (!/^req_/.test(response.headers.get("x-run402-request-id") ?? "")) {
    throw new Error("Function route did not expose generated request id.");
  }
}

async function expectSsrFallbackGet() {
  const response = await fetch(staticUrl("/settings?tab=billing"), {
    headers: {
      cookie: "sid=abc",
      "x-run402-request-id": "spoofed",
      "x-run402-spoof": "should-not-pass",
    },
  });
  const body = await readJsonResponse(response, 200);
  const requestId = response.headers.get("x-run402-request-id");
  if (!/^req_/.test(requestId ?? "") || body.requestId !== requestId) {
    throw new Error(`SSR fallback request id mismatch: ${requestId} ${JSON.stringify(body)}`);
  }
  if (body.kind !== "ssr-fallback" || body.method !== "GET" || body.path !== "/settings" || body.rawQuery !== "tab=billing") {
    throw new Error(`SSR fallback lost URL fidelity: ${JSON.stringify(body)}`);
  }
  if (body.cookie !== "sid=abc" || body.routePattern !== "/*") {
    throw new Error(`SSR fallback lost cookie/route metadata: ${JSON.stringify(body)}`);
  }
  if (body.spoofedHeader !== null || !body.generatedProjectHeader?.startsWith("prj_")) {
    throw new Error(`SSR fallback header stripping/generated headers mismatch: ${JSON.stringify(body)}`);
  }
  if (body.secretLength !== ssrSecretValue.length) {
    throw new Error(`SSR fallback did not receive required secret: ${JSON.stringify(body)}`);
  }
  if (response.headers.get("cache-control") !== "private, no-store") {
    throw new Error(`Expected SSR dynamic cache default, got ${response.headers.get("cache-control")}`);
  }
}

async function expectSsrFallbackPost() {
  const response = await fetch(staticUrl("/accepted?mode=post"), {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "hello ssr",
  });
  const body = await readJsonResponse(response, 202);
  if (body.method !== "POST" || body.path !== "/accepted" || body.body !== "hello ssr" || body.rawQuery !== "mode=post") {
    throw new Error(`SSR POST lost body or URL fidelity: ${JSON.stringify(body)}`);
  }
}

async function expectRedirect() {
  const response = await fetch(staticUrl("/redirect"), { redirect: "manual" });
  if (response.status !== 302) {
    throw new Error(`Expected SSR redirect status 302, got ${response.status} ${await response.text()}`);
  }
  if (response.headers.get("location") !== "/settings?from=redirect") {
    throw new Error(`Expected SSR Location /settings?from=redirect, got ${response.headers.get("location")}`);
  }
}

async function expectCookies() {
  const response = await fetch(staticUrl("/cookies"));
  if (response.status !== 200) {
    throw new Error(`Expected SSR cookies status 200, got ${response.status} ${await response.text()}`);
  }
  const cookies = getSetCookies(response.headers);
  if (!cookies.some((value) => value.startsWith("astro_a=1;")) || !cookies.some((value) => value.startsWith("astro_b=2;"))) {
    throw new Error(`Expected distinct SSR Set-Cookie headers, got ${JSON.stringify(cookies)}`);
  }
}

async function expectBinary() {
  const response = await fetch(staticUrl("/binary"));
  if (response.status !== 200) {
    throw new Error(`Expected SSR binary status 200, got ${response.status} ${await response.text()}`);
  }
  const actual = Buffer.from(await response.arrayBuffer());
  const expected = Buffer.from([0, 1, 2, 255]);
  if (!actual.equals(expected)) {
    throw new Error(`SSR binary returned wrong bytes: ${actual.toString("hex")}`);
  }
}

async function expectHeadOmitsBody() {
  const response = await fetch(staticUrl("/settings?head=true"), { method: "HEAD" });
  if (response.status !== 200) {
    throw new Error(`Expected SSR HEAD status 200, got ${response.status} ${await response.text()}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength !== 0) {
    throw new Error("SSR HEAD returned a body.");
  }
  if (Number(response.headers.get("content-length") ?? "0") <= 0) {
    throw new Error(`SSR HEAD did not preserve content length: ${response.headers.get("content-length")}`);
  }
}

async function expectSecretUsage() {
  const response = await fetch(staticUrl("/needs-secret"));
  const body = await readJsonResponse(response, 200);
  if (body.hasSecret !== true || body.secretLength !== ssrSecretValue.length) {
    throw new Error(`SSR target did not receive required secret: ${JSON.stringify(body)}`);
  }
  const listed = await getJson(`/projects/v1/${project.project_id}/functions/secrets`, serviceHeaders);
  if (!listed.secrets?.some((secret) => secret.name === "SESSION_SECRET") || JSON.stringify(listed).includes(ssrSecretValue)) {
    throw new Error(`Secret metadata readback was wrong or leaked a value: ${JSON.stringify(listed)}`);
  }
}

async function expectLogsAndDiagnostics() {
  const response = await fetch(staticUrl("/logs"));
  const body = await readJsonResponse(response, 200);
  const requestId = response.headers.get("x-run402-request-id");
  if (!/^req_/.test(requestId ?? "") || body.requestId !== requestId || body.envRequestId !== requestId) {
    throw new Error(`SSR log route request id mismatch: ${requestId} ${JSON.stringify(body)}`);
  }
  const listed = await getJson(
    `/projects/v1/${project.project_id}/functions/logs?request_id=${encodeURIComponent(requestId)}&function_name=ssr&tail=20`,
    serviceHeaders,
  );
  const logs = listed.logs ?? [];
  if (!logs.some((entry) => entry.stream === "platform" && entry.message.includes("function_invocation_started"))) {
    throw new Error(`Missing SSR platform start log: ${JSON.stringify(listed)}`);
  }
  if (!logs.some((entry) => entry.stream === "stdout" && entry.redacted === true)) {
    throw new Error(`Missing redacted SSR stdout log: ${JSON.stringify(listed)}`);
  }
  const text = JSON.stringify(logs);
  for (const forbidden of [ssrSecretValue, "abcdef123456", "sessionid"]) {
    if (text.includes(forbidden)) {
      throw new Error(`SSR logs leaked ${forbidden}: ${text}`);
    }
  }
}

async function expectUpgradeUnsupported() {
  const response = await rawHttpRequest("GET", staticPath("/upgrade-target"), {
    connection: "upgrade",
    upgrade: "websocket",
  });
  if (response.status !== 422) {
    throw new Error(`Expected SSR upgrade to fail with 422, got ${response.status} ${response.body}`);
  }
  const parsed = JSON.parse(response.body);
  if (parsed.error !== "astro_ssr_unsupported_feature" || parsed.details?.feature !== "http_upgrade") {
    throw new Error(`Expected astro_ssr_unsupported_feature for upgrade, got ${response.body}`);
  }
  if (!/^req_/.test(response.headers["x-run402-request-id"] ?? "")) {
    throw new Error(`Upgrade failure did not include generated request id: ${JSON.stringify(response.headers)}`);
  }
}

async function expectMissingSecretBlocksCommit() {
  const plan = await createPlan(astroSpec());
  await expectPostJsonFailure(`/apply/v1/plans/${plan.plan_id}/commit`, {
    release_spec_digest: plan.release_spec_digest,
  }, 422, "missing_required_secret");
}

async function expectUnsupportedAstroContracts() {
  await expectPostJsonFailure("/apply/v1/plans", {
    spec: astroSpec({
      ssrFunction: {
        runtime: "node22",
        source: contentRef(files.ssr),
        class: "ssr",
        capabilities: ["astro.adapter.custom"],
      },
    }),
  }, 422, "astro_ssr_unsupported_feature");

  await expectPostJsonFailure("/apply/v1/plans", {
    spec: astroSpec({
      ssrFunction: {
        runtime: "node22",
        source: contentRef(files.ssr),
        class: "ssr",
        capabilities: ["astro.ssr.v1", "astro.streaming"],
      },
    }),
  }, 422, "astro_ssr_unsupported_feature");

  await expectPostJsonFailure("/apply/v1/plans", {
    spec: astroSpec({
      extraFunctions: {
        ssr_two: {
          runtime: "node22",
          source: contentRef(files.ssr),
          class: "ssr",
          capabilities: ["astro.ssr.v1"],
        },
      },
    }),
  }, 422, "astro_ssr_unsupported_feature");
}

async function expectNoopReapply() {
  const plan = await createPlan(astroSpec({ base: { release: "current" } }));
  if (plan.noop !== true) {
    throw new Error(`Expected Astro SSR reapply to be noop, got ${JSON.stringify(plan)}`);
  }
  const commit = await postJson(`/apply/v1/plans/${plan.plan_id}/commit`, {
    release_spec_digest: plan.release_spec_digest,
  });
  if (commit.status !== "noop") {
    throw new Error(`Expected noop Astro SSR commit, got ${JSON.stringify(commit)}`);
  }
}

async function expectCleanup() {
  const cleanup = await postJson(`/projects/v1/${project.project_id}/storage/cleanup`, {}, serviceHeaders);
  if (!Array.isArray(cleanup.retained_live_sha256) || !cleanup.retained_live_sha256.includes(files.ssr.sha256)) {
    throw new Error(`Cleanup did not retain active SSR bundle ref: ${JSON.stringify(cleanup)}`);
  }
  if (typeof cleanup.removed_function_logs !== "number") {
    throw new Error(`Cleanup did not report SSR log cleanup count: ${JSON.stringify(cleanup)}`);
  }
}

function astroSpec(options = {}) {
  const routes = [
    {
      pattern: "/login",
      methods: ["GET", "HEAD"],
      target: { type: "static", file: "login.html" },
    },
    {
      pattern: "/api/*",
      methods: ["GET", "POST", "HEAD"],
      target: { type: "function", name: "api" },
    },
  ];
  if (options.extraStaticRoute) {
    routes.push({
      pattern: options.extraStaticRoute,
      methods: ["GET", "HEAD"],
      target: { type: "static", file: "login.html" },
    });
  }

  return {
    project: project.project_id,
    base: options.base ?? { release: "current" },
    secrets: {
      require: ["SESSION_SECRET"],
    },
    functions: {
      replace: {
        ssr: options.ssrFunction ?? {
          runtime: "node22",
          source: contentRef(files.ssr),
          class: "ssr",
          capabilities: ["astro.ssr.v1"],
          config: { timeoutSeconds: 10, memoryMb: 128 },
        },
        api: {
          runtime: "node22",
          source: contentRef(files.api),
          config: { timeoutSeconds: 10, memoryMb: 128 },
        },
        ...(options.extraFunctions ?? {}),
      },
    },
    site: {
      replace: {
        "login.html": contentRef(files.login),
        "dashboard.html": contentRef(files.dashboard),
        "assets/app.txt": contentRef(files.asset),
      },
      public_paths: {
        mode: "explicit",
        replace: {
          "/dashboard": { asset: "dashboard.html", cache_class: "html" },
          "/assets/app.txt": { asset: "assets/app.txt", cache_class: "revalidating_asset" },
        },
      },
    },
    routes: { replace: routes },
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
  const response = await fetch(resolveUrl(pathOrUrl), { headers });
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
    headers: { "content-type": "application/json" },
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

async function waitForSsrFallback() {
  let lastError = "";
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await expectSsrFallbackGet();
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Astro SSR fallback did not serve after worker restart: ${lastError}`);
}

function staticUrl(path) {
  return resolveUrl(staticPath(path));
}

function staticPath(path) {
  return `/projects/v1/${project.project_id}/static${path}`;
}

function resolveUrl(pathOrUrl) {
  if (/^https?:\/\//.test(pathOrUrl)) return pathOrUrl;
  return `${baseUrl}${pathOrUrl}`;
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function rawHttpRequest(method, path, headers = {}) {
  const target = new URL(resolveUrl(path));
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: target.hostname,
      port: target.port || 80,
      path: `${target.pathname}${target.search}`,
      method,
      headers,
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.on("error", reject);
    req.end();
  });
}
