import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";

import {
  createStorageReadSignature,
  emptyCoreReleaseState,
  verifyStorageReadSignature,
  verifyContentRefBytes,
  CORE_FUNCTION_DEPENDENCY_MODE,
  CORE_FUNCTION_RESOURCE_DEFAULTS,
  LocalExecutorError,
  runtimeCapabilities,
  type CoreFunctionBundleMetadata,
  type CoreFunctionInvocationRecord,
  type CoreFunctionLogEntry,
  type CoreProject,
  type CoreStorageObject,
  type CoreUploadSession,
  type FunctionLogPort,
  type ProjectCatalogPort,
  type SignedReadPort,
  type StorageObjectVisibility,
  type StoragePort,
} from "@run402/runtime-kernel";
import { STATIC_MANIFEST_VERSION, type PortableReleaseState } from "@run402/release";
import type {
  LocalFunctionExecutorInput,
  LocalFunctionExecutorResult,
} from "./local-function-executor.js";
import { coreGatewayResponse, loadConfig } from "./server.js";

test("loadConfig does not require Cloud environment variables", () => {
  assert.deepEqual(loadConfig({}), {
    host: "127.0.0.1",
    port: 4020,
    databaseUrl: undefined,
    publicBaseUrl: "http://127.0.0.1:4020",
    postgrestPublicUrl: "http://127.0.0.1:4300",
    contentDir: ".run402-core/content",
    jwtSecret: "run402-core-local-jwt-secret-change-me",
    signedReadSecret: "run402-core-local-signed-read-secret-change-me",
    maxObjectBytes: 104857600,
    functionWorkerUrl: undefined,
  });
});

test("health route returns core mode", async () => {
  const response = await coreGatewayResponse("/health");
  assert.equal(response.status, 200);
  assert.equal((response.body as { mode?: string }).mode, "core");
});

test("capability route returns supported and unsupported feature lists", async () => {
  const response = await coreGatewayResponse("/capabilities/v1");
  const body = response.body as {
    supported_features?: string[];
    unsupported_features?: Array<{ feature: string; error: string }>;
  };

  assert.equal(response.status, 200);
  assert.ok(body.supported_features?.includes("projects.create.local"));
  assert.ok(body.supported_features?.includes("functions.node"));
  assert.equal(body.unsupported_features?.some((entry) => entry.feature === "functions.node"), false);
});

test("function runtime route fails closed while worker is unavailable", async () => {
  const response = await coreGatewayResponse("/functions/v1/invoke");
  assert.equal(response.status, 503);
  assert.equal((response.body as { error?: string }).error, "dynamic_runtime_unavailable");
});

test("project create and inspect routes use the configured catalog", async () => {
  const catalog = new MemoryProjectCatalog();
  const create = await coreGatewayResponse({
    method: "POST",
    pathname: "/projects/v1",
    body: { name: "agent app" },
  }, { projects: catalog });
  const created = create.body as CoreProject;

  assert.equal(create.status, 201);
  assert.equal(catalog.createdNames[0], "agent app");
  assert.equal(created.project_id, "prj_0000000000000001");

  const inspect = await coreGatewayResponse({
    method: "GET",
    pathname: `/projects/v1/${created.project_id}`,
  }, { projects: catalog });

  assert.equal(inspect.status, 200);
  assert.deepEqual(inspect.body, created);
});

test("project inspect maps invalid and missing ids", async () => {
  const catalog = new MemoryProjectCatalog();

  const invalid = await coreGatewayResponse({
    method: "GET",
    pathname: "/projects/v1/not-a-project",
  }, { projects: catalog });
  assert.equal(invalid.status, 400);
  assert.equal((invalid.body as { error?: string }).error, "invalid_project_id");

  const missing = await coreGatewayResponse({
    method: "GET",
    pathname: "/projects/v1/prj_0000000000000001",
  }, { projects: catalog });
  assert.equal(missing.status, 404);
  assert.equal((missing.body as { error?: string }).error, "project_not_found");
});

test("dev token route is deterministic for stable fixture inputs", async () => {
  const body = {
    project_id: "prj_0000000000000001",
    role: "authenticated",
    sub: "user_a",
  };
  const first = await coreGatewayResponse({
    method: "POST",
    pathname: "/auth/v1/dev-tokens",
    body,
  });
  const second = await coreGatewayResponse({
    method: "POST",
    pathname: "/auth/v1/dev-tokens",
    body,
  });

  assert.equal(first.status, 201);
  assert.equal(
    (first.body as { token?: string }).token,
    (second.body as { token?: string }).token,
  );
  assert.match((first.body as { authorization?: string }).authorization ?? "", /^Bearer /);
});

test("storage routes upload, serve, sign, preserve immutable versions, delete, and paginate", async () => {
  const catalog = new MemoryProjectCatalog();
  const project = await catalog.create({ name: "storage app" });
  const content = new MemoryContentStore();
  const storage = new MemoryStoragePort("http://127.0.0.1:4020");
  const runtime = {
    projects: catalog,
    content,
    storage,
    signedReads: storage,
    cleanup: storage,
    maxObjectBytes: 1024 * 1024,
  };
  const headers = { apikey: project.service_key };

  const firstBytes = Buffer.from("console.log('v1');");
  const firstSha = sha256Hex(firstBytes);
  const createFirst = await coreGatewayResponse({
    method: "POST",
    pathname: `/projects/v1/${project.project_id}/storage/uploads`,
    headers,
    body: {
      key: "assets/app.js",
      size_bytes: firstBytes.byteLength,
      sha256: firstSha,
      content_type: "text/javascript",
      visibility: "public",
      immutable: true,
    },
  }, runtime);
  assert.equal(createFirst.status, 201);
  const firstSession = createFirst.body as CoreUploadSession;

  const putFirst = await coreGatewayResponse({
    method: "PUT",
    pathname: `/projects/v1/${project.project_id}/storage/uploads/${firstSession.upload_id}/bytes`,
    headers,
    body: firstBytes,
  }, runtime);
  assert.equal(putFirst.status, 200);

  const completeFirst = await coreGatewayResponse({
    method: "POST",
    pathname: `/projects/v1/${project.project_id}/storage/uploads/${firstSession.upload_id}/complete`,
    headers,
  }, runtime);
  assert.equal(completeFirst.status, 200);
  const firstObject = completeFirst.body as CoreStorageObject;
  assert.equal(firstObject.public_url?.endsWith("/storage/public/assets/app.js"), true);
  assert.equal(firstObject.immutable_url?.includes(`/immutable/${firstSha}/assets/app.js`), true);

  const secondBytes = Buffer.from("console.log('v2');");
  const secondSha = sha256Hex(secondBytes);
  const createSecond = await coreGatewayResponse({
    method: "POST",
    pathname: `/projects/v1/${project.project_id}/storage/uploads`,
    headers,
    body: {
      key: "assets/app.js",
      size_bytes: secondBytes.byteLength,
      sha256: secondSha,
      content_type: "text/javascript",
      visibility: "public",
      immutable: true,
    },
  }, runtime);
  const secondSession = createSecond.body as CoreUploadSession;
  assert.equal(createSecond.status, 201);
  assert.equal((await coreGatewayResponse({
    method: "PUT",
    pathname: `/projects/v1/${project.project_id}/storage/uploads/${secondSession.upload_id}/bytes`,
    headers,
    body: secondBytes,
  }, runtime)).status, 200);
  assert.equal((await coreGatewayResponse({
    method: "POST",
    pathname: `/projects/v1/${project.project_id}/storage/uploads/${secondSession.upload_id}/complete`,
    headers,
  }, runtime)).status, 200);

  const mutableRead = await coreGatewayResponse({
    method: "GET",
    pathname: `/projects/v1/${project.project_id}/storage/public/assets/app.js`,
  }, runtime);
  assert.equal(mutableRead.status, 200);
  assert.equal(Buffer.from(mutableRead.body as Uint8Array).toString("utf8"), secondBytes.toString("utf8"));

  const immutableRead = await coreGatewayResponse({
    method: "GET",
    pathname: `/projects/v1/${project.project_id}/storage/immutable/${firstSha}/assets/app.js`,
  }, runtime);
  assert.equal(immutableRead.status, 200);
  assert.equal(Buffer.from(immutableRead.body as Uint8Array).toString("utf8"), firstBytes.toString("utf8"));

  const privateBytes = Buffer.from("quarterly numbers");
  const privateSha = sha256Hex(privateBytes);
  const privateSession = (await coreGatewayResponse({
    method: "POST",
    pathname: `/projects/v1/${project.project_id}/storage/uploads`,
    headers,
    body: {
      key: "private/report.txt",
      size_bytes: privateBytes.byteLength,
      sha256: privateSha,
      content_type: "text/plain",
      visibility: "private",
    },
  }, runtime)).body as CoreUploadSession;
  assert.equal((await coreGatewayResponse({
    method: "PUT",
    pathname: `/projects/v1/${project.project_id}/storage/uploads/${privateSession.upload_id}/bytes`,
    headers,
    body: privateBytes,
  }, runtime)).status, 200);
  assert.equal((await coreGatewayResponse({
    method: "POST",
    pathname: `/projects/v1/${project.project_id}/storage/uploads/${privateSession.upload_id}/complete`,
    headers,
  }, runtime)).status, 200);

  const privatePublicRead = await coreGatewayResponse({
    method: "GET",
    pathname: `/projects/v1/${project.project_id}/storage/public/private/report.txt`,
  }, runtime);
  assert.equal(privatePublicRead.status, 404);

  const privateAuthRead = await coreGatewayResponse({
    method: "GET",
    pathname: `/projects/v1/${project.project_id}/storage/blob/private/report.txt`,
    headers,
  }, runtime);
  assert.equal(privateAuthRead.status, 200);
  assert.equal(Buffer.from(privateAuthRead.body as Uint8Array).toString("utf8"), "quarterly numbers");

  const sign = await coreGatewayResponse({
    method: "POST",
    pathname: `/projects/v1/${project.project_id}/storage/blob/private/report.txt/sign`,
    headers,
    body: { ttl_seconds: 60 },
  }, runtime);
  assert.equal(sign.status, 201);
  const signedUrl = new URL((sign.body as { signed_url: string }).signed_url);
  const signedRead = await coreGatewayResponse({
    method: "GET",
    pathname: `${signedUrl.pathname}${signedUrl.search}`,
  }, runtime);
  assert.equal(signedRead.status, 200);
  assert.equal(Buffer.from(signedRead.body as Uint8Array).toString("utf8"), "quarterly numbers");

  const listOne = await coreGatewayResponse({
    method: "GET",
    pathname: `/projects/v1/${project.project_id}/storage/objects?prefix=assets/&limit=1`,
    headers,
  }, runtime);
  assert.equal(listOne.status, 200);
  assert.equal((listOne.body as { objects: unknown[]; next_cursor: string | null }).objects.length, 1);

  const deleted = await coreGatewayResponse({
    method: "DELETE",
    pathname: `/projects/v1/${project.project_id}/storage/blob/assets/app.js`,
    headers,
  }, runtime);
  assert.equal(deleted.status, 200);
  assert.equal((await coreGatewayResponse({
    method: "GET",
    pathname: `/projects/v1/${project.project_id}/storage/public/assets/app.js`,
  }, runtime)).status, 404);
  assert.equal((await coreGatewayResponse({
    method: "GET",
    pathname: `/projects/v1/${project.project_id}/storage/immutable/${firstSha}/assets/app.js`,
  }, runtime)).status, 200);

  const cleanup = await coreGatewayResponse({
    method: "POST",
    pathname: `/projects/v1/${project.project_id}/storage/cleanup`,
    headers,
  }, runtime);
  assert.equal(cleanup.status, 200);
  assert.deepEqual(
    (cleanup.body as { retained_live_sha256: string[] }).retained_live_sha256.sort(),
    [firstSha, secondSha, privateSha].sort(),
  );
});

test("storage upload completion rejects content digest mismatches", async () => {
  const catalog = new MemoryProjectCatalog();
  const project = await catalog.create({ name: "storage app" });
  const content = new MemoryContentStore();
  const storage = new MemoryStoragePort("http://127.0.0.1:4020");
  const runtime = { projects: catalog, content, storage };
  const headers = { apikey: project.service_key };
  const bytes = Buffer.from("actual bundle bytes");

  const create = await coreGatewayResponse({
    method: "POST",
    pathname: `/projects/v1/${project.project_id}/storage/uploads`,
    headers,
    body: {
      key: "functions/api.js",
      size_bytes: bytes.byteLength,
      sha256: "a".repeat(64),
      content_type: "application/javascript",
      visibility: "private",
      immutable: true,
    },
  }, runtime);
  assert.equal(create.status, 201);
  const session = create.body as CoreUploadSession;
  assert.equal((await coreGatewayResponse({
    method: "PUT",
    pathname: `/projects/v1/${project.project_id}/storage/uploads/${session.upload_id}/bytes`,
    headers,
    body: bytes,
  }, runtime)).status, 200);

  const complete = await coreGatewayResponse({
    method: "POST",
    pathname: `/projects/v1/${project.project_id}/storage/uploads/${session.upload_id}/complete`,
    headers,
  }, runtime);

  assert.equal(complete.status, 409);
  assert.equal((complete.body as { error?: string }).error, "content_digest_mismatch");
  assert.equal(await storage.getObject({ projectId: project.project_id, key: "functions/api.js" }), null);
});

test("static route manifest serving honors explicit paths, aliases, methods, diagnostics, and dynamic fail-closed", async () => {
  const catalog = new MemoryProjectCatalog();
  const project = await catalog.create({ name: "routes app" });
  const content = new MemoryContentStore();
  const events = Buffer.from("<h1>Events</h1>");
  const login = Buffer.from("<h1>Login</h1>");
  const hidden = Buffer.from("hidden");
  const eventsSha = sha256Hex(events);
  const loginSha = sha256Hex(login);
  const hiddenSha = sha256Hex(hidden);
  await content.putStatic({ sha256: eventsSha, bytes: events, contentType: "text/html" });
  await content.putStatic({ sha256: loginSha, bytes: login, contentType: "text/html" });
  await content.putStatic({ sha256: hiddenSha, bytes: hidden, contentType: "text/plain" });

  const state: PortableReleaseState = {
    ...emptyCoreReleaseState(),
    site: {
      paths: [
        { path: "events.html", content_sha256: eventsSha, content_type: "text/html", size_bytes: events.byteLength },
        { path: "login.html", content_sha256: loginSha, content_type: "text/html", size_bytes: login.byteLength },
        { path: "hidden.txt", content_sha256: hiddenSha, content_type: "text/plain", size_bytes: hidden.byteLength },
      ],
    },
    static_manifest: {
      version: STATIC_MANIFEST_VERSION,
      public_path_mode: "explicit",
      files: {
        "/events": {
          sha256: eventsSha,
          size: events.byteLength,
          content_type: "text/html",
          cache_class: "html",
          cache_class_source: "declared",
          asset_path: "events.html",
          direct: true,
          authority: "explicit_public_path",
        },
        "/login": {
          sha256: loginSha,
          size: login.byteLength,
          content_type: "text/html",
          cache_class: "html",
          cache_class_source: "declared",
          asset_path: "login.html",
          direct: false,
          authority: "route_static_alias",
          methods: ["GET", "HEAD"],
        },
      },
    },
    routes: {
      manifest_sha256: "route-manifest-test",
      entries: [
        {
          pattern: "/login",
          kind: "exact",
          prefix: null,
          methods: ["GET", "HEAD"],
          target: { type: "static", file: "login.html" },
        },
        {
          pattern: "/api/*",
          kind: "prefix",
          prefix: "/api/",
          methods: ["GET"],
          target: { type: "function", name: "api" },
        },
      ],
    },
  };
  const runtime = {
    projects: catalog,
    releases: new MemoryReleaseState(state),
    content,
  };

  const eventsRead = await coreGatewayResponse({
    method: "GET",
    pathname: `/projects/v1/${project.project_id}/static/events?ignored=true`,
  }, runtime);
  assert.equal(eventsRead.status, 200);
  assert.equal(Buffer.from(eventsRead.body as Uint8Array).toString("utf8"), "<h1>Events</h1>");
  assert.equal(eventsRead.headers?.["X-Run402-Content-Sha256"], eventsSha);

  assert.equal((await coreGatewayResponse({
    method: "GET",
    pathname: `/projects/v1/${project.project_id}/static/events.html`,
  }, runtime)).status, 404);

  const loginHead = await coreGatewayResponse({
    method: "HEAD",
    pathname: `/projects/v1/${project.project_id}/static/login/`,
  }, runtime);
  assert.equal(loginHead.status, 200);
  assert.equal(loginHead.headers?.["Content-Length"], String(login.byteLength));
  assert.equal((loginHead.body as Uint8Array).byteLength, 0);

  assert.equal((await coreGatewayResponse({
    method: "POST",
    pathname: `/projects/v1/${project.project_id}/static/login`,
  }, runtime)).status, 405);
  assert.equal((await coreGatewayResponse({
    method: "GET",
    pathname: `/projects/v1/${project.project_id}/static/api/users`,
  }, runtime)).status, 503);

  const diagnostics = await coreGatewayResponse({
    method: "GET",
    pathname: `/projects/v1/${project.project_id}/static-diagnostics`,
    headers: { apikey: project.service_key },
  }, runtime);
  assert.equal(diagnostics.status, 200);
  assert.deepEqual((diagnostics.body as { non_public_asset_paths: string[] }).non_public_asset_paths, ["hidden.txt"]);
});

test("dynamic static routes invoke local functions with routed HTTP envelope", async () => {
  const catalog = new MemoryProjectCatalog();
  const project = await catalog.create({ name: "routes app" });
  const state: PortableReleaseState = {
    ...emptyCoreReleaseState(),
    i18n: {
      defaultLocale: "en",
      locales: ["en"],
      detect: [],
      unknownLocalePolicy: "reject",
    },
    routes: {
      manifest_sha256: "route-manifest-test",
      entries: [{
        pattern: "/api/*",
        kind: "prefix",
        prefix: "/api/",
        methods: ["POST", "HEAD"],
        target: { type: "function", name: "api" },
      }],
    },
  };
  const bundle = functionBundle("b".repeat(64), 12);
  const executor = new MemoryFunctionExecutor();
  const runtime = {
    projects: catalog,
    releases: new MemoryReleaseState(state),
    content: new MemoryContentStore(),
    functionBundles: new MemoryFunctionBundles(bundle),
    functionExecutor: executor,
  };

  const response = await coreGatewayResponse({
    method: "POST",
    pathname: `/projects/v1/${project.project_id}/static/api/users?x=1&x=2`,
    headers: {
      host: "example.test",
      cookie: "sid=abc",
      "x-run402-request-id": "spoofed",
      connection: "close",
      "x-custom": ["one", "two"],
    },
    body: Buffer.from("hello"),
  }, runtime);

  assert.equal(response.status, 201);
  assert.equal(Buffer.from(response.body as Uint8Array).toString("utf8"), "ok");
  assert.match(String(response.headers?.["X-Run402-Request-Id"]), /^req_/);
  assert.deepEqual(response.headers?.["Set-Cookie"], ["a=1; Path=/", "b=2; Path=/"]);
  assert.equal(response.headers?.["Cache-Control"], "private, no-store");
  assert.equal(response.headers?.["x-run402-cache"], "dynamic-bypass");
  assert.equal(response.headers?.connection, undefined);

  const invocation = executor.last;
  assert.ok(invocation);
  assert.equal(invocation.request?.version, "run402.routed_http.v1");
  assert.equal(invocation.request?.method, "POST");
  assert.equal(invocation.request?.url, "http://example.test/api/users?x=1&x=2");
  assert.equal(invocation.request?.path, "/api/users");
  assert.equal(invocation.request?.rawQuery, "x=1&x=2");
  assert.equal(invocation.request?.cookies.raw, "sid=abc");
  assert.equal(Buffer.from(invocation.request?.body?.data ?? "", "base64").toString("utf8"), "hello");
  assert.equal(invocation.request?.headers.some(([name, value]) => name === "x-run402-request-id" && value === "spoofed"), false);
  assert.equal(invocation.request?.headers.some(([name]) => name === "connection"), false);
  assert.deepEqual(invocation.request?.headers.filter(([name]) => name === "x-custom"), [["x-custom", "one"], ["x-custom", "two"]]);
  assert.equal(invocation.request?.context.routePattern, "/api/*");
  assert.equal(invocation.request?.context.routeTarget.name, "api");
  assert.equal(invocation.request?.context.locale, "en");
  assert.equal(invocation.request?.context.defaultLocale, "en");

  const head = await coreGatewayResponse({
    method: "HEAD",
    pathname: `/projects/v1/${project.project_id}/static/api/users`,
    headers: { host: "example.test" },
  }, runtime);
  assert.equal(head.status, 201);
  assert.equal((head.body as Uint8Array).byteLength, 0);
  assert.equal(head.headers?.["Content-Length"], "2");
});

test("dynamic static routes reject oversized request bodies before invoking functions", async () => {
  const catalog = new MemoryProjectCatalog();
  const project = await catalog.create({ name: "routes app" });
  const state: PortableReleaseState = {
    ...emptyCoreReleaseState(),
    routes: {
      manifest_sha256: "route-manifest-test",
      entries: [{
        pattern: "/api/*",
        kind: "prefix",
        prefix: "/api/",
        methods: ["POST"],
        target: { type: "function", name: "api" },
      }],
    },
  };
  const executor = new MemoryFunctionExecutor();
  const runtime = {
    projects: catalog,
    releases: new MemoryReleaseState(state),
    content: new MemoryContentStore(),
    functionBundles: new MemoryFunctionBundles(functionBundle("e".repeat(64), 12)),
    functionExecutor: executor,
  };

  const response = await coreGatewayResponse({
    method: "POST",
    pathname: `/projects/v1/${project.project_id}/static/api/too-big`,
    body: Buffer.alloc(CORE_FUNCTION_RESOURCE_DEFAULTS.requestBodyLimitBytes + 1),
  }, runtime);

  assert.equal(response.status, 413);
  assert.equal((response.body as { error?: string }).error, "request_body_too_large");
  assert.equal(executor.last, null);
});

test("direct function invoke requires service auth and enforces auth gates before dispatch", async () => {
  const catalog = new MemoryProjectCatalog();
  const project = await catalog.create({ name: "functions app" });
  const state = emptyCoreReleaseState();
  const executor = new MemoryFunctionExecutor();
  const runtime = {
    projects: catalog,
    releases: new MemoryReleaseState(state),
    content: new MemoryContentStore(),
    functionBundles: new MemoryFunctionBundles(functionBundle("c".repeat(64), 12)),
    functionExecutor: executor,
    jwtSecret: "test-jwt-secret",
  };

  const unauthorized = await coreGatewayResponse({
    method: "POST",
    pathname: "/functions/v1/invoke",
    body: {
      project_id: project.project_id,
      function_name: "api",
    },
  }, runtime);
  assert.equal(unauthorized.status, 401);

  const direct = await coreGatewayResponse({
    method: "POST",
    pathname: "/functions/v1/invoke",
    headers: { apikey: project.service_key },
    body: {
      project_id: project.project_id,
      function_name: "api",
    },
  }, runtime);

  assert.equal(direct.status, 200);
  assert.equal((direct.body as { response?: { status?: number } }).response?.status, 201);
  assert.equal(executor.last?.invocationKind, "direct");
  assert.equal(executor.last?.request, undefined);

  const gatedBundle = functionBundle("d".repeat(64), 12);
  gatedBundle.require_auth = true;
  const gatedExecutor = new MemoryFunctionExecutor();
  const gated = await coreGatewayResponse({
    method: "POST",
    pathname: "/functions/v1/invoke",
    headers: { apikey: project.service_key },
    body: {
      project_id: project.project_id,
      function_name: "api",
    },
  }, {
    ...runtime,
    functionBundles: new MemoryFunctionBundles(gatedBundle),
    functionExecutor: gatedExecutor,
  });

  assert.equal(gated.status, 401);
  assert.equal((gated.body as { error?: string }).error, "authentication_required");
  assert.equal(gatedExecutor.last, null);

  const userAuth = await devAuthorization(runtime, project.project_id, "user_direct");
  const gatedWithUser = await coreGatewayResponse({
    method: "POST",
    pathname: "/functions/v1/invoke",
    headers: { apikey: project.service_key, authorization: userAuth },
    body: {
      project_id: project.project_id,
      function_name: "api",
    },
  }, {
    ...runtime,
    functionBundles: new MemoryFunctionBundles(gatedBundle),
    functionExecutor: gatedExecutor,
  });

  assert.equal(gatedWithUser.status, 200);
  assert.equal(gatedExecutor.last?.actor?.id, "user_direct");
  assert.equal(gatedExecutor.last?.actor?.role, "authenticated");
});

test("routed function auth and role gates inject generated user context", async () => {
  const catalog = new MemoryProjectCatalog();
  const project = await catalog.create({ name: "gated routes app" });
  const state: PortableReleaseState = {
    ...emptyCoreReleaseState(),
    routes: {
      manifest_sha256: "route-manifest-test",
      entries: [{
        pattern: "/api/*",
        kind: "prefix",
        prefix: "/api/",
        methods: ["GET"],
        target: { type: "function", name: "api" },
      }],
    },
  };
  const authBundle = functionBundle("f".repeat(64), 12);
  authBundle.require_auth = true;
  const authExecutor = new MemoryFunctionExecutor();
  const runtime = {
    projects: catalog,
    releases: new MemoryReleaseState(state),
    content: new MemoryContentStore(),
    functionBundles: new MemoryFunctionBundles(authBundle),
    functionExecutor: authExecutor,
    jwtSecret: "test-jwt-secret",
  };

  const blocked = await coreGatewayResponse({
    method: "GET",
    pathname: `/projects/v1/${project.project_id}/static/api/user`,
  }, runtime);
  assert.equal(blocked.status, 401);
  assert.equal(authExecutor.last, null);

  const userAuth = await devAuthorization(runtime, project.project_id, "user_routed");
  const passed = await coreGatewayResponse({
    method: "GET",
    pathname: `/projects/v1/${project.project_id}/static/api/user`,
    headers: {
      authorization: userAuth,
      "x-run402-user-id": "spoofed",
    },
  }, runtime);
  assert.equal(passed.status, 201);
  assert.equal(authExecutor.last?.actor?.id, "user_routed");
  assert.deepEqual(authExecutor.last?.request?.headers.filter(([name]) => name === "x-run402-user-id"), [["x-run402-user-id", "user_routed"]]);

  const roleBundle = functionBundle("a".repeat(64), 12);
  roleBundle.require_role = {
    table: "members",
    idColumn: "user_id",
    roleColumn: "role",
    allowed: ["admin"],
    cacheTtl: 0,
  };
  const roleExecutor = new MemoryFunctionExecutor();
  const denied = await coreGatewayResponse({
    method: "GET",
    pathname: `/projects/v1/${project.project_id}/static/api/admin`,
    headers: { authorization: userAuth },
  }, {
    ...runtime,
    functionBundles: new MemoryFunctionBundles(roleBundle),
    functionExecutor: roleExecutor,
    roleGates: new MemoryRoleGates("member"),
  });
  assert.equal(denied.status, 403);
  assert.equal((denied.body as { error?: string }).error, "ROLE_FORBIDDEN");
  assert.equal(roleExecutor.last, null);

  const allowed = await coreGatewayResponse({
    method: "GET",
    pathname: `/projects/v1/${project.project_id}/static/api/admin`,
    headers: { authorization: userAuth },
  }, {
    ...runtime,
    functionBundles: new MemoryFunctionBundles(roleBundle),
    functionExecutor: roleExecutor,
    roleGates: new MemoryRoleGates("admin"),
  });
  assert.equal(allowed.status, 201);
  assert.equal(roleExecutor.last?.actor?.role, "admin");
  assert.deepEqual(roleExecutor.last?.request?.headers.filter(([name]) => name === "x-run402-user-role"), [["x-run402-user-role", "admin"]]);
});

test("function secrets expose metadata only and inject required values before dispatch", async () => {
  const catalog = new MemoryProjectCatalog();
  const project = await catalog.create({ name: "secret functions app" });
  const state = emptyCoreReleaseState();
  const secrets = new MemorySecrets();
  const bundle = functionBundle("7".repeat(64), 12);
  bundle.required_secrets = ["API_TOKEN"];
  const executor = new MemoryFunctionExecutor();
  const runtime = {
    projects: catalog,
    releases: new MemoryReleaseState(state),
    content: new MemoryContentStore(),
    functionBundles: new MemoryFunctionBundles(bundle),
    functionExecutor: executor,
    secrets,
  };

  const blockedSet = await coreGatewayResponse({
    method: "POST",
    pathname: `/projects/v1/${project.project_id}/functions/secrets`,
    body: { name: "API_TOKEN", value: "secret-value" },
  }, runtime);
  assert.equal(blockedSet.status, 401);

  const stored = await coreGatewayResponse({
    method: "POST",
    pathname: `/projects/v1/${project.project_id}/functions/secrets`,
    headers: { apikey: project.service_key },
    body: { name: "API_TOKEN", value: "secret-value" },
  }, runtime);
  assert.equal(stored.status, 201);
  assert.equal((stored.body as { name?: string }).name, "API_TOKEN");
  assert.equal("value" in (stored.body as Record<string, unknown>), false);

  const listed = await coreGatewayResponse({
    method: "GET",
    pathname: `/projects/v1/${project.project_id}/functions/secrets`,
    headers: { apikey: project.service_key },
  }, runtime);
  assert.equal(listed.status, 200);
  const listedSecrets = (listed.body as { secrets: Array<Record<string, unknown>> }).secrets;
  assert.equal(listedSecrets[0]?.name, "API_TOKEN");
  assert.equal("value" in listedSecrets[0], false);

  const invoked = await coreGatewayResponse({
    method: "POST",
    pathname: "/functions/v1/invoke",
    headers: { apikey: project.service_key },
    body: {
      project_id: project.project_id,
      function_name: "api",
    },
  }, runtime);
  assert.equal(invoked.status, 200);
  assert.deepEqual(executor.last?.secrets, { API_TOKEN: "secret-value" });

  secrets.clear();
  executor.last = null;
  const missing = await coreGatewayResponse({
    method: "POST",
    pathname: "/functions/v1/invoke",
    headers: { apikey: project.service_key },
    body: {
      project_id: project.project_id,
      function_name: "api",
    },
  }, runtime);
  assert.equal(missing.status, 422);
  assert.equal((missing.body as { error?: string }).error, "missing_required_secret");
  assert.equal(executor.last, null);
});

test("function logs persist platform and user records with request filters", async () => {
  const catalog = new MemoryProjectCatalog();
  const project = await catalog.create({ name: "logged routes app" });
  const state: PortableReleaseState = {
    ...emptyCoreReleaseState(),
    routes: {
      manifest_sha256: "route-manifest-test",
      entries: [{
        pattern: "/api/*",
        kind: "prefix",
        prefix: "/api/",
        methods: ["GET"],
        target: { type: "function", name: "api" },
      }],
    },
  };
  const functionLogs = new MemoryFunctionLogs();
  const executor = new MemoryFunctionExecutor({
    logs: (input) => [userLog(input, "stdout", "hello from user code")],
  });
  const runtime = {
    projects: catalog,
    releases: new MemoryReleaseState(state),
    content: new MemoryContentStore(),
    functionBundles: new MemoryFunctionBundles(functionBundle("8".repeat(64), 12)),
    functionExecutor: executor,
    functionLogs,
  };

  const response = await coreGatewayResponse({
    method: "GET",
    pathname: `/projects/v1/${project.project_id}/static/api/logged`,
  }, runtime);
  assert.equal(response.status, 201);
  const requestId = String(response.headers?.["X-Run402-Request-Id"]);
  assert.match(requestId, /^req_/);

  const unauthorized = await coreGatewayResponse({
    method: "GET",
    pathname: `/projects/v1/${project.project_id}/functions/logs?request_id=${requestId}`,
  }, runtime);
  assert.equal(unauthorized.status, 401);

  const listed = await coreGatewayResponse({
    method: "GET",
    pathname: `/projects/v1/${project.project_id}/functions/logs?request_id=${requestId}&tail=10`,
    headers: { apikey: project.service_key },
  }, runtime);
  assert.equal(listed.status, 200);
  const logs = (listed.body as { logs: CoreFunctionLogEntry[] }).logs;
  assert.ok(logs.length >= 3);
  assert.deepEqual([...logs].sort((a, b) => a.timestamp.localeCompare(b.timestamp)), logs);
  assert.equal(logs.every((entry) => entry.request_id === requestId), true);
  assert.equal(logs.some((entry) => entry.stream === "platform" && entry.message.includes("function_invocation_started")), true);
  assert.equal(logs.some((entry) => entry.stream === "stdout" && entry.message === "hello from user code"), true);
  assert.equal(functionLogs.invocations[0]?.status, "succeeded");

  const future = await coreGatewayResponse({
    method: "GET",
    pathname: `/projects/v1/${project.project_id}/functions/logs?request_id=${requestId}&since=2999-01-01T00:00:00.000Z`,
    headers: { apikey: project.service_key },
  }, runtime);
  assert.deepEqual((future.body as { logs: CoreFunctionLogEntry[] }).logs, []);
});

test("routed function errors return sanitized request diagnostics and platform logs", async () => {
  const catalog = new MemoryProjectCatalog();
  const project = await catalog.create({ name: "failing routes app" });
  const state: PortableReleaseState = {
    ...emptyCoreReleaseState(),
    routes: {
      manifest_sha256: "route-manifest-test",
      entries: [{
        pattern: "/api/*",
        kind: "prefix",
        prefix: "/api/",
        methods: ["GET"],
        target: { type: "function", name: "api" },
      }],
    },
  };
  const functionLogs = new MemoryFunctionLogs();
  const runtime = {
    projects: catalog,
    releases: new MemoryReleaseState(state),
    content: new MemoryContentStore(),
    functionBundles: new MemoryFunctionBundles(functionBundle("9".repeat(64), 12)),
    functionExecutor: new MemoryFunctionExecutor({
      error: new LocalExecutorError("raw user boom secret-value", { function_name: "api" }),
    }),
    functionLogs,
  };

  const response = await coreGatewayResponse({
    method: "GET",
    pathname: `/projects/v1/${project.project_id}/static/api/fails`,
  }, runtime);
  assert.equal(response.status, 500);
  const body = response.body as { error?: string; message?: string; request_id?: string };
  assert.equal(body.error, "local_executor_failed");
  assert.equal(body.message, "Function invocation failed.");
  assert.match(body.request_id ?? "", /^req_/);
  assert.equal(response.headers?.["X-Run402-Request-Id"], body.request_id);
  assert.equal(JSON.stringify(body).includes("raw user boom"), false);

  const listed = await coreGatewayResponse({
    method: "GET",
    pathname: `/projects/v1/${project.project_id}/functions/logs?request_id=${body.request_id}`,
    headers: { apikey: project.service_key },
  }, runtime);
  const logs = (listed.body as { logs: CoreFunctionLogEntry[] }).logs;
  assert.equal(functionLogs.invocations[0]?.status, "failed");
  assert.equal(logs.some((entry) => entry.stream === "platform" && entry.level === "error"), true);
  assert.equal(logs.some((entry) => entry.message.includes("raw user boom")), false);
  assert.equal(logs.some((entry) => entry.message.includes("/api/*") && entry.message.includes("/api/fails")), true);
});

test("function user logs are redacted before readback or direct response", async () => {
  const catalog = new MemoryProjectCatalog();
  const project = await catalog.create({ name: "redacted functions app" });
  const state = emptyCoreReleaseState();
  const secrets = new MemorySecrets();
  await secrets.setSecret({
    projectId: project.project_id,
    name: "API_TOKEN",
    value: "secret-value",
  });
  const bundle = functionBundle("6".repeat(64), 12);
  bundle.required_secrets = ["API_TOKEN"];
  const functionLogs = new MemoryFunctionLogs();
  const executor = new MemoryFunctionExecutor({
    logs: (input) => [
      userLog(input, "stdout", `Authorization: Bearer abcdef123456 cookie=sessionid ${project.service_key}`),
      userLog(input, "stderr", "x-run402-payment: paytoken API_TOKEN=secret-value api_key=abcd1234abcd1234"),
    ],
  });
  const runtime = {
    projects: catalog,
    releases: new MemoryReleaseState(state),
    content: new MemoryContentStore(),
    functionBundles: new MemoryFunctionBundles(bundle),
    functionExecutor: executor,
    functionLogs,
    secrets,
  };

  const invoked = await coreGatewayResponse({
    method: "POST",
    pathname: "/functions/v1/invoke",
    headers: { apikey: project.service_key },
    body: {
      project_id: project.project_id,
      function_name: "api",
    },
  }, runtime);
  assert.equal(invoked.status, 200);
  const directLogs = (invoked.body as { logs: CoreFunctionLogEntry[] }).logs;
  assert.equal(directLogs.every((entry) => entry.redacted), true);
  const directText = directLogs.map((entry) => entry.message).join("\n");
  assert.equal(directText.includes("abcdef123456"), false);
  assert.equal(directText.includes("sessionid"), false);
  assert.equal(directText.includes(project.service_key), false);
  assert.equal(directText.includes("paytoken"), false);
  assert.equal(directText.includes("secret-value"), false);
  assert.equal(directText.includes("abcd1234abcd1234"), false);

  const requestId = (invoked.body as { request_id: string }).request_id;
  const listed = await coreGatewayResponse({
    method: "GET",
    pathname: `/projects/v1/${project.project_id}/functions/logs?request_id=${requestId}`,
    headers: { apikey: project.service_key },
  }, runtime);
  const storedText = (listed.body as { logs: CoreFunctionLogEntry[] }).logs.map((entry) => entry.message).join("\n");
  assert.equal(storedText.includes("secret-value"), false);
  assert.equal(storedText.includes("[redacted]"), true);
});

async function devAuthorization(
  runtime: Parameters<typeof coreGatewayResponse>[1],
  projectId: string,
  sub: string,
): Promise<string> {
  const response = await coreGatewayResponse({
    method: "POST",
    pathname: "/auth/v1/dev-tokens",
    body: {
      project_id: projectId,
      role: "authenticated",
      sub,
    },
  }, runtime);
  assert.equal(response.status, 201);
  return (response.body as { authorization: string }).authorization;
}

class MemoryFunctionBundles {
  readonly #bundle: CoreFunctionBundleMetadata;

  constructor(bundle: CoreFunctionBundleMetadata) {
    this.#bundle = bundle;
  }

  async getFunctionBundle(): Promise<CoreFunctionBundleMetadata> {
    return this.#bundle;
  }
}

class MemoryRoleGates {
  readonly #role: string | null;

  constructor(role: string | null) {
    this.#role = role;
  }

  async resolveRole(): Promise<string | null> {
    return this.#role;
  }
}

class MemorySecrets {
  readonly #values = new Map<string, string>();

  async setSecret(input: {
    projectId: string;
    name: string;
    value: string;
    scope?: "project" | "release" | "function";
    functionName?: string | null;
  }) {
    this.#values.set(input.name, input.value);
    return secretMetadata(input.projectId, input.name, input.scope ?? "project", input.functionName ?? null);
  }

  async listSecrets(input: { projectId: string }) {
    return [...this.#values.keys()].sort().map((name) => secretMetadata(input.projectId, name, "project", null));
  }

  async getSecretValues(input: { names: string[] }) {
    const out: Record<string, string> = {};
    for (const name of input.names) {
      const value = this.#values.get(name);
      if (value !== undefined) out[name] = value;
    }
    return out;
  }

  clear(): void {
    this.#values.clear();
  }
}

class MemoryFunctionLogs implements FunctionLogPort {
  readonly invocations: CoreFunctionInvocationRecord[] = [];
  readonly logs: CoreFunctionLogEntry[] = [];

  async recordInvocation(input: {
    invocation: CoreFunctionInvocationRecord;
    logs: CoreFunctionLogEntry[];
  }): Promise<void> {
    this.invocations.push(input.invocation);
    this.logs.push(...input.logs);
  }

  async listLogs(input: {
    projectId: string;
    functionName?: string;
    requestId?: string;
    since?: string;
    tail?: number;
  }): Promise<CoreFunctionLogEntry[]> {
    const sinceMs = input.since ? Date.parse(input.since) : null;
    const filtered = this.logs.filter((entry) =>
      entry.project_id === input.projectId &&
      (!input.functionName || entry.function_name === input.functionName) &&
      (!input.requestId || entry.request_id === input.requestId) &&
      (sinceMs === null || Date.parse(entry.timestamp) >= sinceMs)
    );
    const tail = Math.min(Math.max(input.tail ?? 100, 1), 1000);
    return filtered
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
      .slice(-tail);
  }
}

function secretMetadata(
  projectId: string,
  name: string,
  scope: "project" | "release" | "function",
  functionName: string | null,
) {
  return {
    project_id: projectId,
    name,
    scope,
    function_name: functionName,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
  };
}

interface MemoryFunctionExecutorOptions {
  logs?: (input: LocalFunctionExecutorInput) => CoreFunctionLogEntry[];
  error?: Error;
}

class MemoryFunctionExecutor {
  last: LocalFunctionExecutorInput | null = null;
  readonly #options: MemoryFunctionExecutorOptions;

  constructor(options: MemoryFunctionExecutorOptions = {}) {
    this.#options = options;
  }

  async invoke(input: LocalFunctionExecutorInput): Promise<LocalFunctionExecutorResult> {
    this.last = input;
    if (this.#options.error) throw this.#options.error;
    return {
      requestId: input.requestId,
      duration_ms: 1,
      logs: this.#options.logs?.(input) ?? [],
      response: {
        status: 201,
        headers: [
          ["content-type", "text/plain"],
          ["connection", "close"],
        ],
        cookies: ["a=1; Path=/", "b=2; Path=/"],
        body: {
          encoding: "base64" as const,
          data: Buffer.from("ok").toString("base64"),
          size: 2,
        },
      },
    };
  }
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

function userLog(
  input: LocalFunctionExecutorInput,
  stream: "stdout" | "stderr",
  message: string,
): CoreFunctionLogEntry {
  return {
    timestamp: new Date().toISOString(),
    request_id: input.requestId,
    project_id: input.projectId,
    release_id: input.releaseId,
    function_name: input.functionName,
    stream,
    level: stream === "stderr" ? "error" : "info",
    message,
    redacted: false,
  };
}

class MemoryProjectCatalog implements ProjectCatalogPort {
  readonly createdNames: string[] = [];
  readonly projects = new Map<string, CoreProject>();

  async create(input: { name: string }): Promise<CoreProject> {
    this.createdNames.push(input.name);
    const project: CoreProject = {
      project_id: "prj_0000000000000001",
      schema_slot: "project_0000000000000001",
      public_id: "local_0000000000000001",
      anon_key: "anon_test",
      service_key: "service_test",
      endpoints: {
        rest_url: "http://127.0.0.1:4300",
        static_base_url: "http://127.0.0.1:4020/projects/v1/prj_0000000000000001/static",
        storage_base_url: "http://127.0.0.1:4020/projects/v1/prj_0000000000000001/storage",
      },
      active_release_id: null,
      capabilities: runtimeCapabilities("test"),
    };
    this.projects.set(project.project_id, project);
    return project;
  }

  async inspect(projectId: string): Promise<CoreProject | null> {
    return this.projects.get(projectId) ?? null;
  }
}

class MemoryReleaseState {
  readonly #state: PortableReleaseState;

  constructor(state: PortableReleaseState) {
    this.#state = state;
  }

  async getBase(): Promise<{ release_id: string | null; state: PortableReleaseState }> {
    return { release_id: "rel_test", state: this.#state };
  }

  async setActiveRelease(): Promise<void> {
    throw new Error("not used");
  }
}

class MemoryContentStore {
  readonly cas = new Map<string, { bytes: Uint8Array; contentType: string }>();
  readonly uploads = new Map<string, Uint8Array>();

  async putStatic(input: { sha256: string; bytes: Uint8Array; contentType: string }): Promise<void> {
    this.cas.set(input.sha256, { bytes: input.bytes, contentType: input.contentType });
  }

  async hasContent(_projectId: string, sha256: string): Promise<boolean> {
    return this.cas.has(sha256);
  }

  async readStatic(_projectId: string, sha256: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    return this.cas.get(sha256) ?? null;
  }

  async readCas(sha256: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    return this.cas.get(sha256) ?? null;
  }

  async putUploadBytes(input: { projectId: string; uploadId: string; bytes: Uint8Array }): Promise<{ size_bytes: number }> {
    this.uploads.set(`${input.projectId}:${input.uploadId}`, input.bytes);
    return { size_bytes: input.bytes.byteLength };
  }

  async promoteUpload(input: {
    projectId: string;
    uploadId: string;
    ref: { sha256: string; size: number; contentType?: string };
  }): Promise<{ sha256: string; size_bytes: number; content_type: string }> {
    const key = `${input.projectId}:${input.uploadId}`;
    const bytes = this.uploads.get(key);
    if (!bytes) throw new Error("missing upload bytes");
    verifyContentRefBytes(input.ref, bytes);
    const contentType = input.ref.contentType ?? "application/octet-stream";
    this.cas.set(input.ref.sha256, { bytes, contentType });
    this.uploads.delete(key);
    return { sha256: input.ref.sha256, size_bytes: input.ref.size, content_type: contentType };
  }

  async deleteUploadBytes(input: { projectId: string; uploadId: string }): Promise<void> {
    this.uploads.delete(`${input.projectId}:${input.uploadId}`);
  }
}

class MemoryStoragePort implements StoragePort, SignedReadPort {
  readonly sessions = new Map<string, CoreUploadSession>();
  readonly objects = new Map<string, CoreStorageObject>();
  readonly versions = new Map<string, CoreStorageObject>();
  readonly #baseUrl: string;
  readonly #secret = "test-signed-read-secret";

  constructor(baseUrl: string) {
    this.#baseUrl = baseUrl;
  }

  async createUploadSession(input: {
    projectId: string;
    key: string;
    sizeBytes: number;
    sha256: string;
    contentType: string;
    visibility: StorageObjectVisibility;
    immutable: boolean;
  }): Promise<CoreUploadSession> {
    const upload_id = `upl_${String(this.sessions.size + 1).padStart(24, "0")}`;
    const session: CoreUploadSession = {
      upload_id,
      project_id: input.projectId,
      key: input.key,
      declared_size: input.sizeBytes,
      declared_sha256: input.sha256,
      content_type: input.contentType,
      visibility: input.visibility,
      immutable: input.immutable,
      status: "active",
      upload_url: `${this.#baseUrl}/projects/v1/${input.projectId}/storage/uploads/${upload_id}/bytes`,
      bytes_written: 0,
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      completed_at: null,
      aborted_at: null,
      created_at: new Date(0).toISOString(),
    };
    this.sessions.set(upload_id, session);
    return session;
  }

  async getUploadSession(input: { uploadId: string }): Promise<CoreUploadSession | null> {
    return this.sessions.get(input.uploadId) ?? null;
  }

  async markUploadBytesStored(input: { uploadId: string; sizeBytes: number }): Promise<CoreUploadSession> {
    const session = this.sessions.get(input.uploadId);
    assert.ok(session);
    const updated: CoreUploadSession = { ...session, status: "uploaded", bytes_written: input.sizeBytes };
    this.sessions.set(input.uploadId, updated);
    return updated;
  }

  async completeUploadSession(input: { uploadId: string }): Promise<CoreStorageObject> {
    const session = this.sessions.get(input.uploadId);
    assert.ok(session);
    const now = new Date().toISOString();
    const object: CoreStorageObject = {
      project_id: session.project_id,
      key: session.key,
      sha256: session.declared_sha256,
      size_bytes: session.declared_size,
      content_type: session.content_type,
      visibility: session.visibility,
      immutable: session.immutable,
      created_at: this.objects.get(this.#objectKey(session.project_id, session.key))?.created_at ?? now,
      updated_at: now,
      ...(session.visibility === "public" ? {
        public_url: `${this.#baseUrl}/projects/v1/${session.project_id}/storage/public/${session.key}`,
        ...(session.immutable ? {
          immutable_url: `${this.#baseUrl}/projects/v1/${session.project_id}/storage/immutable/${session.declared_sha256}/${session.key}`,
        } : {}),
      } : {}),
    };
    this.objects.set(this.#objectKey(session.project_id, session.key), object);
    if (session.immutable) {
      this.versions.set(this.#versionKey(session.project_id, session.key, session.declared_sha256), object);
    }
    this.sessions.set(session.upload_id, { ...session, status: "completed", completed_at: now });
    return object;
  }

  async abortUploadSession(input: { uploadId: string }): Promise<CoreUploadSession> {
    const session = this.sessions.get(input.uploadId);
    assert.ok(session);
    const updated: CoreUploadSession = { ...session, status: "aborted", aborted_at: new Date().toISOString() };
    this.sessions.set(input.uploadId, updated);
    return updated;
  }

  async getObject(input: { projectId: string; key: string }): Promise<CoreStorageObject | null> {
    return this.objects.get(this.#objectKey(input.projectId, input.key)) ?? null;
  }

  async listObjects(input: { projectId: string; prefix?: string; limit?: number; cursor?: string }) {
    const sorted = [...this.objects.values()]
      .filter((object) => object.project_id === input.projectId)
      .filter((object) => !input.prefix || object.key.startsWith(input.prefix))
      .filter((object) => !input.cursor || object.key > input.cursor)
      .sort((a, b) => a.key.localeCompare(b.key));
    const limit = input.limit ?? 100;
    return {
      objects: sorted.slice(0, limit),
      next_cursor: sorted.length > limit ? sorted[limit - 1]!.key : null,
    };
  }

  async deleteObject(input: { projectId: string; key: string }): Promise<boolean> {
    return this.objects.delete(this.#objectKey(input.projectId, input.key));
  }

  async getImmutableVersion(input: { projectId: string; key: string; sha256: string }) {
    const object = this.versions.get(this.#versionKey(input.projectId, input.key, input.sha256));
    if (!object) return null;
    return {
      ...object,
      version_id: `ver_${input.sha256.slice(0, 24)}`,
      public_url_key: `${input.sha256}/${input.key}`,
      retained_until: null,
    };
  }

  async signRead(input: { projectId: string; key: string; ttlSeconds?: number; sha256?: string | null }) {
    const expires = Math.floor(Date.now() / 1000) + (input.ttlSeconds ?? 900);
    const signature = createStorageReadSignature({
      secret: this.#secret,
      projectId: input.projectId,
      key: input.key,
      expiresAtEpochSeconds: expires,
      sha256: input.sha256 ?? null,
    });
    return {
      expires_at: new Date(expires * 1000).toISOString(),
      signed_url: `${this.#baseUrl}/projects/v1/${input.projectId}/storage/signed/${input.key}?expires=${expires}&signature=${signature}`,
    };
  }

  async verifyRead(input: {
    projectId: string;
    key: string;
    expiresAtEpochSeconds: number;
    signature: string;
    sha256?: string | null;
  }) {
    return verifyStorageReadSignature({
      secret: this.#secret,
      ...input,
    });
  }

  async sweep() {
    const retained = new Set<string>();
    for (const object of this.objects.values()) retained.add(object.sha256);
    for (const object of this.versions.values()) retained.add(object.sha256);
    return {
      removed_uploads: 0,
      removed_objects: 0,
      removed_versions: 0,
      removed_cas_objects: 0,
      retained_live_sha256: [...retained].sort(),
    };
  }

  #objectKey(projectId: string, key: string): string {
    return `${projectId}:${key}`;
  }

  #versionKey(projectId: string, key: string, sha256: string): string {
    return `${projectId}:${key}:${sha256}`;
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
