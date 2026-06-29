import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  classifyHttpBlocker,
  probeHttp,
  redactEvidence,
  runCertification,
} from "./core-certify.mjs";

describe("core-certify runner", () => {
  it("runs product-neutral probes and emits redacted passing evidence", async () => {
    const fetch = fakeFetch({
      "GET http://core.local/health": json({ status: "ok", mode: "core" }),
      "GET http://core.local/projects/v1/prj_demo": json({
        project_id: "prj_demo",
        service_key: "service-secret",
        endpoints: { rest_url: "http://postgrest.local" },
      }),
      "GET http://core.local/projects/v1/prj_demo/static/": text("<h1>demo</h1>"),
      "GET http://core.local/projects/v1/prj_demo/static/env.js": text("window.API='http://core.local'"),
      "GET http://core.local/projects/v1/prj_demo/static/api/health": json(
        { ok: true },
        { "x-run402-request-id": "req_123" },
      ),
      "GET http://core.local/projects/v1/prj_demo/static/settings": text("<main>settings</main>"),
      "GET http://postgrest.local/todos?select=id": json([]),
      "POST http://core.local/auth/v1/dev-tokens": json({
        authorization: "Bearer user-secret-token",
      }),
      "GET http://postgrest.local/todos?select=id|authorization=Bearer user-secret-token": json([{ id: 1 }]),
    });

    const evidence = await runCertification({
      base_url: "http://core.local",
      project_id: "prj_demo",
      service_key: "service-secret",
      postgrest_url: "http://postgrest.local",
      probes: {
        static: { path: "/projects/v1/{project_id}/static/", expect_text: "demo" },
        runtime_config: { path: "/projects/v1/{project_id}/static/env.js", expect_text: "window.API" },
        function: { path: "/projects/v1/{project_id}/static/api/health" },
        ssr: { path: "/projects/v1/{project_id}/static/settings", expect_text: "settings" },
        rls: {
          path: "todos?select=id",
          anon_expect_count: 0,
          user: { sub: "user_a", expect_count: 1 },
        },
      },
    }, { fetch });

    assert.equal(evidence.status, "pass");
    assert.equal(evidence.summary.passed, 7);
    assert.equal(evidence.summary.failed, 0);
    const serialized = JSON.stringify(evidence);
    assert(!serialized.includes("service-secret"));
    assert(!serialized.includes("user-secret-token"));
    assert(serialized.includes("[redacted]"));
  });

  it("classifies SSR stub responses as Core runtime gaps", async () => {
    const result = await probeHttp(
      { baseUrl: "http://core.local", projectId: "prj_demo", redactionValues: [] },
      fakeFetch({
        "GET http://core.local/ssr": text("SSR stub: dynamic runtime is not configured", {}, 200),
      }),
      "ssr-fallback",
      { path: "/ssr" },
      { classifySsrStub: true },
    );

    assert.equal(result.status, "fail");
    assert.equal(result.blocker.kind, "core_runtime_capability_gap");
  });

  it("classifies common blocker shapes", () => {
    assert.equal(classifyHttpBlocker({ status: 404, body_sample: "missing" }, "static-fetch"), "app_source_deploy_mapping");
    assert.equal(classifyHttpBlocker({ status: 503, body_sample: "dynamic_runtime_unavailable" }, "routed-function"), "core_runtime_capability_gap");
    assert.equal(classifyHttpBlocker({ status: 400, body_sample: "Cloud-only feature is not part of Core" }, "probe"), "intentionally_unsupported_cloud_only_feature");
    assert.equal(classifyHttpBlocker({ status: 400, body_sample: "manifest adapter mismatch" }, "probe"), "public_sdk_cli_package_gap");
  });

  it("redacts bearer tokens, service keys, signed URLs, cookies, and explicit secrets", () => {
    const redacted = redactEvidence({
      headers: {
        authorization: "Bearer abcdef123456",
        cookie: "sessionid=abc",
      },
      body: "service_key=service-secret token=my-token signed_url=https://example.test/signed",
      nested: {
        signed_url: "https://example.test/private?token=abc",
        message: "hello service-secret",
      },
    }, ["service-secret", "my-token"]);

    const serialized = JSON.stringify(redacted);
    assert(!serialized.includes("service-secret"));
    assert(!serialized.includes("abcdef123456"));
    assert(!serialized.includes("sessionid=abc"));
    assert(!serialized.includes("my-token"));
    assert(!serialized.includes("https://example.test/private"));
    assert(serialized.includes("[redacted]"));
  });

  it("records probe failures as blockers in evidence", async () => {
    const evidence = await runCertification({
      base_url: "http://core.local",
      project_id: "prj_demo",
      service_key: "service-secret",
      probes: {
        static: { path: "/missing", expect_text: "demo" },
      },
    }, {
      fetch: fakeFetch({
        "GET http://core.local/health": json({ status: "ok" }),
        "GET http://core.local/projects/v1/prj_demo": json({ project_id: "prj_demo" }),
        "GET http://core.local/missing": text("not found", {}, 404),
      }),
    });

    assert.equal(evidence.status, "fail");
    assert.equal(evidence.blockers[0]?.kind, "app_source_deploy_mapping");
    assert.equal(evidence.summary.failed, 1);
  });
});

function fakeFetch(routes) {
  return async (input, init = {}) => {
    const method = init.method ?? "GET";
    const url = String(input);
    const authorization = headerValue(init.headers, "authorization");
    const key = authorization ? `${method} ${url}|authorization=${authorization}` : `${method} ${url}`;
    const response = routes[key] ?? routes[`${method} ${url}`];
    if (!response) {
      return text(`missing fake route ${key}`, {}, 404);
    }
    return response;
  };
}

function headerValue(headers, name) {
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get(name);
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return found?.[1] ?? null;
}

function json(body, headers = {}, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function text(body, headers = {}, status = 200) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain", ...headers },
  });
}
