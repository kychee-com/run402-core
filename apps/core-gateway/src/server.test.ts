import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";

import {
  createStorageReadSignature,
  emptyCoreReleaseState,
  verifyStorageReadSignature,
  verifyContentRefBytes,
  CORE_FUNCTION_DEPENDENCY_MODE,
  runtimeCapabilities,
  type CoreFunctionBundleMetadata,
  type CoreProject,
  type CoreStorageObject,
  type CoreUploadSession,
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

class MemoryFunctionBundles {
  readonly #bundle: CoreFunctionBundleMetadata;

  constructor(bundle: CoreFunctionBundleMetadata) {
    this.#bundle = bundle;
  }

  async getFunctionBundle(): Promise<CoreFunctionBundleMetadata> {
    return this.#bundle;
  }
}

class MemoryFunctionExecutor {
  last: LocalFunctionExecutorInput | null = null;

  async invoke(input: LocalFunctionExecutorInput): Promise<LocalFunctionExecutorResult> {
    this.last = input;
    return {
      requestId: input.requestId,
      duration_ms: 1,
      logs: [],
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
