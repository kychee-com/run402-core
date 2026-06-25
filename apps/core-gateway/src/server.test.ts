import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";

import {
  createStorageReadSignature,
  verifyStorageReadSignature,
  verifyContentRefBytes,
  runtimeCapabilities,
  type CoreProject,
  type CoreStorageObject,
  type CoreUploadSession,
  type ProjectCatalogPort,
  type SignedReadPort,
  type StorageObjectVisibility,
  type StoragePort,
} from "@run402/runtime-kernel";
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
  assert.ok(body.unsupported_features?.some((entry) =>
    entry.feature === "functions.node" && entry.error === "unsupported_capability"
  ));
});

test("excluded runtime routes fail with unsupported_capability", async () => {
  const response = await coreGatewayResponse("/functions/v1/invoke");
  assert.equal(response.status, 422);
  assert.equal((response.body as { error?: string }).error, "unsupported_capability");
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
