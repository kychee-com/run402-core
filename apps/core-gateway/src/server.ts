import { createHmac, randomBytes } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import {
  applyInvariantEnvelope,
  ApplyInvariantError,
  commitApplyPlan,
  createApplyPlan,
  createCoreProject,
  DynamicRuntimeUnavailableError,
  inspectCoreProject,
  normalizeSha256Hex,
  normalizeStorageContentType,
  normalizeStorageKey,
  normalizeStorageSize,
  normalizeStorageVisibility,
  ProjectNotFoundError,
  projectNotFoundEnvelope,
  CORE_FUNCTION_RESOURCE_DEFAULTS,
  runtimeCapabilities,
  runtimeHealth,
  RuntimeKernelTypedError,
  runtimeKernelErrorEnvelope,
  StorageValidationError,
  storageErrorEnvelope,
  UnsupportedCapabilityError,
  unsupportedCapabilityEnvelope,
  type ContentStorePort,
  type CoreFunctionBundleMetadata,
  type CoreProject,
  type RuntimeKernelPorts,
  type ProjectCatalogPort,
} from "@run402/runtime-kernel";
import {
  cacheControlForStaticCacheClass,
  computeStaticManifestSha256,
  ReleaseCoreError,
  type ContentRefHex,
  type PortableReleaseState,
  type RouteEntry,
  type StaticManifestFileEntry,
} from "@run402/release";
import { FilesystemContentStore } from "./filesystem-content.js";
import { HttpFunctionWorkerClient } from "./function-worker-client.js";
import type {
  LocalFunctionExecutorInput,
  LocalFunctionExecutorResult,
} from "./local-function-executor.js";
import { PostgresApplyStore } from "./postgres-apply.js";
import { createPostgresPool, PostgresProjectCatalog } from "./postgres-projects.js";
import { PostgresStorageStore } from "./postgres-storage.js";

export interface CoreGatewayConfig {
  host: string;
  port: number;
  databaseUrl?: string;
  publicBaseUrl: string;
  postgrestPublicUrl: string;
  contentDir: string;
  jwtSecret: string;
  signedReadSecret: string;
  maxObjectBytes: number;
  functionWorkerUrl?: string;
}

export interface CoreGatewayRuntime {
  projects?: ProjectCatalogPort;
  releases?: RuntimeKernelPorts["releases"];
  plans?: RuntimeKernelPorts["plans"];
  content?: ContentStorePort;
  storage?: RuntimeKernelPorts["storage"];
  signedReads?: RuntimeKernelPorts["signedReads"];
  cleanup?: RuntimeKernelPorts["cleanup"];
  functions?: RuntimeKernelPorts["functions"];
  functionBundles?: FunctionBundleLookupPort;
  functionExecutor?: FunctionExecutorPort;
  migrations?: RuntimeKernelPorts["migrations"];
  lifecycle?: RuntimeKernelPorts["lifecycle"];
  jwtSecret?: string;
  maxObjectBytes?: number;
  close?: () => Promise<void>;
}

export interface FunctionBundleLookupPort {
  getFunctionBundle(input: {
    projectId: string;
    releaseId: string;
    functionName: string;
  }): Promise<CoreFunctionBundleMetadata | null>;
}

export interface FunctionExecutorPort {
  invoke(input: LocalFunctionExecutorInput): Promise<LocalFunctionExecutorResult>;
}

interface VerifiedContentStore extends ContentStorePort {
  putVerified(projectId: string, ref: ContentRefHex, bytes: Uint8Array): Promise<void>;
}

export interface CoreGatewayRequest {
  method?: string;
  pathname: string;
  body?: unknown;
  headers?: Record<string, string | string[] | undefined>;
}

export interface CoreGatewayResult {
  status: number;
  body: unknown;
  headers?: Record<string, string | string[]>;
  raw?: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CoreGatewayConfig {
  const host = env.CORE_GATEWAY_HOST || "127.0.0.1";
  const port = Number.parseInt(env.PORT || "4020", 10);

  return {
    host,
    port,
    databaseUrl: env.CORE_DATABASE_URL,
    publicBaseUrl: env.CORE_PUBLIC_URL || `http://${host}:${port}`,
    postgrestPublicUrl: env.CORE_POSTGREST_PUBLIC_URL || env.CORE_POSTGREST_URL || "http://127.0.0.1:4300",
    contentDir: env.CORE_CONTENT_DIR || ".run402-core/content",
    jwtSecret: env.CORE_JWT_SECRET || "run402-core-local-jwt-secret-change-me",
    signedReadSecret: env.CORE_SIGNED_READ_SECRET || env.CORE_JWT_SECRET || "run402-core-local-signed-read-secret-change-me",
    maxObjectBytes: Number.parseInt(env.CORE_MAX_OBJECT_BYTES || String(100 * 1024 * 1024), 10),
    functionWorkerUrl: env.CORE_FUNCTION_WORKER_URL,
  };
}

export async function createGatewayRuntime(config: CoreGatewayConfig): Promise<CoreGatewayRuntime> {
  if (!config.databaseUrl) {
    return {};
  }

  const pool = createPostgresPool(config.databaseUrl);
  const projects = new PostgresProjectCatalog(pool, {
    publicBaseUrl: config.publicBaseUrl,
    postgrestPublicUrl: config.postgrestPublicUrl,
  });
  const applyStore = new PostgresApplyStore(pool);
  const content = new FilesystemContentStore(config.contentDir);
  const storage = new PostgresStorageStore(pool, {
    publicBaseUrl: config.publicBaseUrl,
    signedReadSecret: config.signedReadSecret,
    maxObjectBytes: config.maxObjectBytes,
  });
  await projects.bootstrap();
  await applyStore.bootstrap();
  await storage.bootstrap();

  return {
    projects,
    releases: applyStore,
    plans: applyStore,
    content,
    storage,
    signedReads: storage,
    cleanup: storage,
    functionBundles: storage,
    functionExecutor: config.functionWorkerUrl ? new HttpFunctionWorkerClient(config.functionWorkerUrl) : undefined,
    migrations: applyStore,
    lifecycle: {
      activate: async (context) => {
        await storage.activateReleaseWithStorage({
          projectId: context.plan.project_id,
          releaseId: context.release_id,
          digest: context.release_digest,
          release: context.target_release,
          expectedBaseReleaseId: context.plan.base_release_id,
          effects: context.storage_effects,
          functionEffects: context.function_effects,
        });
        return { status: "activated", release_id: context.release_id };
      },
    },
    jwtSecret: config.jwtSecret,
    maxObjectBytes: config.maxObjectBytes,
    close: async () => {
      await pool.end();
    },
  };
}

export async function coreGatewayResponse(
  requestOrPathname: CoreGatewayRequest | string,
  runtime: CoreGatewayRuntime = {},
): Promise<CoreGatewayResult> {
  const request = typeof requestOrPathname === "string"
    ? { method: "GET", pathname: requestOrPathname }
    : requestOrPathname;
  const method = request.method ?? "GET";
  const url = new URL(request.pathname, "http://run402-core.local");
  const pathname = url.pathname;
  const query = url.searchParams;
  const headers = normalizeHeaders(request.headers);
  const capabilities = runtimeCapabilities();

  if (method === "GET" && pathname === "/health") {
    return { status: 200, body: runtimeHealth(capabilities) };
  }

  if (method === "GET" && pathname === "/capabilities/v1") {
    return { status: 200, body: capabilities };
  }

  if (method === "POST" && pathname === "/projects/v1") {
    const projects = runtime.projects;
    if (!projects) {
      return {
        status: 503,
        body: {
          error: "project_catalog_unavailable",
          message: "Run402 Core project catalog is not configured.",
        },
      };
    }

    const project = await createCoreProject({ projects }, projectInput(request.body));
    return { status: 201, body: project };
  }

  const contentMatch = /^\/projects\/v1\/([^/]+)\/content$/.exec(pathname);
  if (method === "POST" && contentMatch) {
    const content = runtime.content;
    if (!content || !("putVerified" in content)) {
      return unavailable("content_store_unavailable", "Run402 Core content store is not configured.");
    }
    const staged = await stageContent(content, contentMatch[1], request.body);
    return { status: 201, body: staged };
  }

  const uploadCreateMatch = /^\/projects\/v1\/([^/]+)\/storage\/uploads$/.exec(pathname);
  if (method === "POST" && uploadCreateMatch) {
    const storage = runtime.storage;
    if (!storage) return unavailable("storage_unavailable", "Run402 Core storage is not configured.");
    const auth = await requireProjectService(runtime, uploadCreateMatch[1], headers);
    if ("status" in auth) return auth;
    try {
      const input = storageUploadInput(request.body, runtime.maxObjectBytes ?? 100 * 1024 * 1024);
      const session = await storage.createUploadSession({
        projectId: auth.project_id,
        ...input,
      });
      return { status: 201, body: session };
    } catch (error) {
      return storageRouteError(error);
    }
  }

  const uploadBytesMatch = /^\/projects\/v1\/([^/]+)\/storage\/uploads\/([^/]+)\/bytes$/.exec(pathname);
  if (method === "PUT" && uploadBytesMatch) {
    const storage = runtime.storage;
    const content = runtime.content;
    if (!storage || !content?.putUploadBytes) {
      return unavailable("storage_unavailable", "Run402 Core storage is not configured.");
    }
    const auth = await requireProjectService(runtime, uploadBytesMatch[1], headers);
    if ("status" in auth) return auth;
    try {
      const uploadId = uploadBytesMatch[2];
      const stored = await content.putUploadBytes({
        projectId: auth.project_id,
        uploadId,
        bytes: requestBodyBytes(request.body),
      });
      const session = await storage.markUploadBytesStored({
        projectId: auth.project_id,
        uploadId,
        sizeBytes: stored.size_bytes,
      });
      return { status: 200, body: session };
    } catch (error) {
      return storageRouteError(error);
    }
  }

  const uploadStatusMatch = /^\/projects\/v1\/([^/]+)\/storage\/uploads\/([^/]+)$/.exec(pathname);
  if (method === "GET" && uploadStatusMatch) {
    const storage = runtime.storage;
    if (!storage) return unavailable("storage_unavailable", "Run402 Core storage is not configured.");
    const auth = await requireProjectService(runtime, uploadStatusMatch[1], headers);
    if ("status" in auth) return auth;
    const session = await storage.getUploadSession({
      projectId: auth.project_id,
      uploadId: uploadStatusMatch[2],
    });
    return session
      ? { status: 200, body: session }
      : { status: 404, body: { error: "upload_not_found", message: "Upload session was not found." } };
  }

  const uploadCompleteMatch = /^\/projects\/v1\/([^/]+)\/storage\/uploads\/([^/]+)\/complete$/.exec(pathname);
  if (method === "POST" && uploadCompleteMatch) {
    const storage = runtime.storage;
    const content = runtime.content;
    if (!storage || !content?.promoteUpload) {
      return unavailable("storage_unavailable", "Run402 Core storage is not configured.");
    }
    const auth = await requireProjectService(runtime, uploadCompleteMatch[1], headers);
    if ("status" in auth) return auth;
    try {
      const uploadId = uploadCompleteMatch[2];
      const session = await storage.getUploadSession({ projectId: auth.project_id, uploadId });
      if (!session) return { status: 404, body: { error: "upload_not_found", message: "Upload session was not found." } };
      if (session.status !== "completed") {
        if (session.status !== "uploaded") {
          throw new StorageValidationError("upload_not_uploaded", "Upload session has no uploaded bytes.");
        }
        await content.promoteUpload({
          projectId: auth.project_id,
          uploadId,
          ref: {
            sha256: session.declared_sha256,
            size: session.declared_size,
            contentType: session.content_type,
          },
        });
      }
      const object = await storage.completeUploadSession({ projectId: auth.project_id, uploadId });
      return { status: 200, body: object };
    } catch (error) {
      return storageRouteError(error);
    }
  }

  const uploadAbortMatch = /^\/projects\/v1\/([^/]+)\/storage\/uploads\/([^/]+)\/abort$/.exec(pathname);
  if (method === "POST" && uploadAbortMatch) {
    const storage = runtime.storage;
    const content = runtime.content;
    if (!storage) return unavailable("storage_unavailable", "Run402 Core storage is not configured.");
    const auth = await requireProjectService(runtime, uploadAbortMatch[1], headers);
    if ("status" in auth) return auth;
    try {
      await content?.deleteUploadBytes?.({
        projectId: auth.project_id,
        uploadId: uploadAbortMatch[2],
      });
      const session = await storage.abortUploadSession({
        projectId: auth.project_id,
        uploadId: uploadAbortMatch[2],
      });
      return { status: 200, body: session };
    } catch (error) {
      return storageRouteError(error);
    }
  }

  const objectListMatch = /^\/projects\/v1\/([^/]+)\/storage\/objects$/.exec(pathname);
  if (method === "GET" && objectListMatch) {
    const storage = runtime.storage;
    if (!storage) return unavailable("storage_unavailable", "Run402 Core storage is not configured.");
    const auth = await requireProjectService(runtime, objectListMatch[1], headers);
    if ("status" in auth) return auth;
    try {
      const list = await storage.listObjects({
        projectId: auth.project_id,
        prefix: query.get("prefix") ?? undefined,
        cursor: query.get("cursor") ?? undefined,
        limit: query.has("limit") ? expectQueryInteger(query.get("limit"), "limit") : undefined,
      });
      return { status: 200, body: list };
    } catch (error) {
      return storageRouteError(error);
    }
  }

  const cleanupMatch = /^\/projects\/v1\/([^/]+)\/storage\/cleanup$/.exec(pathname);
  if (method === "POST" && cleanupMatch) {
    const cleanup = runtime.cleanup;
    if (!cleanup) return unavailable("storage_cleanup_unavailable", "Run402 Core storage cleanup is not configured.");
    const auth = await requireProjectService(runtime, cleanupMatch[1], headers);
    if ("status" in auth) return auth;
    const result = await cleanup.sweep(auth.project_id);
    return { status: 200, body: result };
  }

  const immutableReadMatch = /^\/projects\/v1\/([^/]+)\/storage\/immutable\/([a-f0-9]{64})\/(.+)$/.exec(pathname);
  if ((method === "GET" || method === "HEAD") && immutableReadMatch) {
    const storage = runtime.storage;
    if (!storage) return unavailable("storage_unavailable", "Run402 Core storage is not configured.");
    try {
      const projectId = immutableReadMatch[1];
      const sha256 = immutableReadMatch[2];
      const key = normalizeStorageKey(immutableReadMatch[3]);
      const version = await storage.getImmutableVersion({ projectId, key, sha256 });
      if (!version) return storageNotFound();
      const signedOk = await verifyOptionalSignedRead(runtime, query, projectId, key, sha256);
      if (version.visibility !== "public" && !signedOk) return storageNotFound();
      return await serveCas(runtime, {
        sha256: version.sha256,
        contentType: version.content_type,
        visibility: version.visibility,
        immutable: true,
        head: method === "HEAD",
      });
    } catch (error) {
      return storageRouteError(error);
    }
  }

  const signedReadMatch = /^\/projects\/v1\/([^/]+)\/storage\/signed\/(.+)$/.exec(pathname);
  if ((method === "GET" || method === "HEAD") && signedReadMatch) {
    const storage = runtime.storage;
    if (!storage) return unavailable("storage_unavailable", "Run402 Core storage is not configured.");
    try {
      const projectId = signedReadMatch[1];
      const key = normalizeStorageKey(signedReadMatch[2]);
      const sha256 = query.get("sha256");
      const signedOk = await verifyOptionalSignedRead(runtime, query, projectId, key, sha256);
      if (!signedOk) return storageNotFound();
      if (sha256) {
        const version = await storage.getImmutableVersion({ projectId, key, sha256 });
        if (!version) return storageNotFound();
        return await serveCas(runtime, {
          sha256: version.sha256,
          contentType: version.content_type,
          visibility: version.visibility,
          immutable: true,
          head: method === "HEAD",
        });
      }
      const object = await storage.getObject({ projectId, key });
      if (!object) return storageNotFound();
      return await serveCas(runtime, {
        sha256: object.sha256,
        contentType: object.content_type,
        visibility: object.visibility,
        immutable: object.immutable,
        head: method === "HEAD",
      });
    } catch (error) {
      return storageRouteError(error);
    }
  }

  const publicReadMatch = /^\/projects\/v1\/([^/]+)\/storage\/public\/(.+)$/.exec(pathname);
  if ((method === "GET" || method === "HEAD") && publicReadMatch) {
    const storage = runtime.storage;
    if (!storage) return unavailable("storage_unavailable", "Run402 Core storage is not configured.");
    try {
      const object = await storage.getObject({
        projectId: publicReadMatch[1],
        key: normalizeStorageKey(publicReadMatch[2]),
      });
      if (!object || object.visibility !== "public") return storageNotFound();
      return await serveCas(runtime, {
        sha256: object.sha256,
        contentType: object.content_type,
        visibility: object.visibility,
        immutable: object.immutable,
        head: method === "HEAD",
      });
    } catch (error) {
      return storageRouteError(error);
    }
  }

  const objectSignMatch = /^\/projects\/v1\/([^/]+)\/storage\/blob\/(.+)\/sign$/.exec(pathname);
  if (method === "POST" && objectSignMatch) {
    const storage = runtime.storage;
    const signedReads = runtime.signedReads;
    if (!storage || !signedReads) return unavailable("storage_unavailable", "Run402 Core storage is not configured.");
    const auth = await requireProjectService(runtime, objectSignMatch[1], headers);
    if ("status" in auth) return auth;
    try {
      const key = normalizeStorageKey(objectSignMatch[2]);
      const object = await storage.getObject({ projectId: auth.project_id, key });
      if (!object) return storageNotFound();
      const signed = await signedReads.signRead({
        projectId: auth.project_id,
        key,
        ttlSeconds: signedReadTtlInput(request.body),
      });
      return { status: 201, body: signed };
    } catch (error) {
      return storageRouteError(error);
    }
  }

  const objectReadMatch = /^\/projects\/v1\/([^/]+)\/storage\/blob\/(.+)$/.exec(pathname);
  if ((method === "GET" || method === "HEAD") && objectReadMatch) {
    const storage = runtime.storage;
    if (!storage) return unavailable("storage_unavailable", "Run402 Core storage is not configured.");
    const auth = await requireProjectService(runtime, objectReadMatch[1], headers);
    if ("status" in auth) return auth;
    try {
      const object = await storage.getObject({
        projectId: auth.project_id,
        key: normalizeStorageKey(objectReadMatch[2]),
      });
      if (!object) return storageNotFound();
      return await serveCas(runtime, {
        sha256: object.sha256,
        contentType: object.content_type,
        visibility: object.visibility,
        immutable: object.immutable,
        head: method === "HEAD",
      });
    } catch (error) {
      return storageRouteError(error);
    }
  }

  if (method === "DELETE" && objectReadMatch) {
    const storage = runtime.storage;
    if (!storage) return unavailable("storage_unavailable", "Run402 Core storage is not configured.");
    const auth = await requireProjectService(runtime, objectReadMatch[1], headers);
    if ("status" in auth) return auth;
    try {
      const deleted = await storage.deleteObject({
        projectId: auth.project_id,
        key: normalizeStorageKey(objectReadMatch[2]),
      });
      return deleted
        ? { status: 200, body: { deleted: true } }
        : storageNotFound();
    } catch (error) {
      return storageRouteError(error);
    }
  }

  if (method === "POST" && pathname === "/auth/v1/dev-tokens") {
    const token = createDevToken(request.body, runtime.jwtSecret ?? "run402-core-local-jwt-secret-change-me");
    return { status: 201, body: token };
  }

  const projectMatch = /^\/projects\/v1\/([^/]+)$/.exec(pathname);
  if (method === "GET" && projectMatch) {
    const projects = runtime.projects;
    if (!projects) {
      return {
        status: 503,
        body: {
          error: "project_catalog_unavailable",
          message: "Run402 Core project catalog is not configured.",
        },
      };
    }

    try {
      const project = await inspectCoreProject({ projects }, { project_id: projectMatch[1] });
      return { status: 200, body: project };
    } catch (error) {
      if (error instanceof ProjectNotFoundError) {
        return { status: error.status, body: projectNotFoundEnvelope(error) };
      }
      if (error instanceof RangeError) {
        return {
          status: 400,
          body: {
            error: "invalid_project_id",
            message: error.message,
          },
        };
      }
      throw error;
    }
  }

  if (method === "POST" && pathname === "/apply/v1/plans") {
    const ports = runtimePorts(runtime);
    if (!ports) return unavailable("runtime_kernel_unavailable", "Run402 Core runtime kernel is not fully configured.");
    try {
      const plan = await createApplyPlan(ports, { spec: applySpecInput(request.body) });
      return { status: 201, body: plan };
    } catch (error) {
      return applyErrorResponse(error);
    }
  }

  const commitMatch = /^\/apply\/v1\/plans\/([^/]+)\/commit$/.exec(pathname);
  if (method === "POST" && commitMatch) {
    const ports = runtimePorts(runtime);
    if (!ports) return unavailable("runtime_kernel_unavailable", "Run402 Core runtime kernel is not fully configured.");
    try {
      const result = await commitApplyPlan(ports, {
        plan_id: commitMatch[1],
        release_spec_digest: commitInput(request.body).release_spec_digest,
      });
      return { status: 200, body: result };
    } catch (error) {
      return applyErrorResponse(error);
    }
  }

  const staticMatch = /^\/projects\/v1\/([^/]+)\/static(\/.*)?$/.exec(pathname);
  if (staticMatch) {
    const staticResult = await staticResponse(runtime, staticMatch[1], staticMatch[2] || "/", {
      method,
      rawQuery: url.search.slice(1),
      headers: request.headers,
      body: request.body,
    });
    if (method === "HEAD" && staticResult.status === 200) {
      return { ...staticResult, body: new Uint8Array() };
    }
    return staticResult;
  }

  const staticDiagnosticsMatch = /^\/projects\/v1\/([^/]+)\/static-diagnostics$/.exec(pathname);
  if (method === "GET" && staticDiagnosticsMatch) {
    const auth = await requireProjectService(runtime, staticDiagnosticsMatch[1], headers);
    if ("status" in auth) return auth;
    return await staticDiagnostics(runtime, auth.project_id);
  }

  if (pathname.startsWith("/functions")) {
    const error = new DynamicRuntimeUnavailableError();
    return { status: error.status, body: runtimeKernelErrorEnvelope(error) };
  }

  const unsupportedFeature = unsupportedFeatureForPath(pathname);
  if (unsupportedFeature) {
    const error = new UnsupportedCapabilityError(unsupportedFeature);
    return { status: error.status, body: unsupportedCapabilityEnvelope(error) };
  }

  return {
    status: 404,
    body: {
      error: "not_found",
      message: "Route is not part of the Run402 Core runtime-kernel scaffold.",
    },
  };
}

export async function requestHandler(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: CoreGatewayRuntime = {},
): Promise<void> {
  const url = new URL(req.url || "/", "http://localhost");
  const result = await safeRequest(req, `${url.pathname}${url.search}`, runtime);
  res.statusCode = result.status;
  for (const [name, value] of Object.entries(result.headers ?? {})) {
    res.setHeader(name, value);
  }
  if (result.raw) {
    res.end(result.body as Uint8Array);
    return;
  }
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(`${JSON.stringify(result.body)}\n`);
}

export async function startServer(config = loadConfig()): Promise<http.Server> {
  const runtime = await createGatewayRuntime(config);
  const server = http.createServer((req, res) => {
    void requestHandler(req, res, runtime);
  });
  server.on("close", () => {
    void runtime.close?.();
  });
  await new Promise<void>((resolve) => {
    server.listen(config.port, config.host, resolve);
  });
  console.log(`Run402 Core gateway listening on http://${config.host}:${config.port}`);
  return server;
}

function runtimePorts(runtime: CoreGatewayRuntime): RuntimeKernelPorts | null {
  if (!runtime.projects || !runtime.releases || !runtime.plans || !runtime.content || !runtime.migrations) {
    return null;
  }
  return {
    projects: runtime.projects,
    releases: runtime.releases,
    plans: runtime.plans,
    content: runtime.content,
    storage: runtime.storage,
    signedReads: runtime.signedReads,
    cleanup: runtime.cleanup,
    functions: runtime.functions,
    migrations: runtime.migrations,
    lifecycle: runtime.lifecycle,
  };
}

function unavailable(error: string, message: string): CoreGatewayResult {
  return {
    status: 503,
    body: { error, message },
  };
}

async function requireProjectService(
  runtime: CoreGatewayRuntime,
  projectId: string,
  headers: Record<string, string | undefined>,
): Promise<CoreProject | CoreGatewayResult> {
  const projects = runtime.projects;
  if (!projects) return unavailable("project_catalog_unavailable", "Run402 Core project catalog is not configured.");
  const project = await projects.inspect(projectId);
  if (!project) return { status: 404, body: { error: "project_not_found", message: `Run402 Core project not found: ${projectId}` } };
  const token = serviceTokenFromHeaders(headers);
  if (token !== project.service_key) {
    return { status: 401, body: { error: "authentication_required", message: "A project service key is required." } };
  }
  return project;
}

function serviceTokenFromHeaders(headers: Record<string, string | undefined>): string | null {
  const apikey = headers.apikey;
  if (apikey) return apikey;
  const authorization = headers.authorization;
  if (!authorization) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match?.[1] ?? null;
}

function normalizeHeaders(headers: CoreGatewayRequest["headers"]): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    out[name.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }
  return out;
}

function storageUploadInput(body: unknown, maxObjectBytes: number): {
  key: string;
  sizeBytes: number;
  sha256: string;
  contentType: string;
  visibility: "public" | "private";
  immutable: boolean;
  ttlSeconds?: number;
} {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new RangeError("Storage upload body must be a JSON object.");
  }
  const record = body as Record<string, unknown>;
  const ttl = record.ttl_seconds;
  if (ttl !== undefined && (typeof ttl !== "number" || !Number.isFinite(ttl))) {
    throw new RangeError("ttl_seconds must be a number.");
  }
  const immutable = record.immutable === undefined ? false : expectBoolean(record.immutable, "immutable");
  return {
    key: normalizeStorageKey(record.key),
    sizeBytes: normalizeStorageSize(record.size_bytes ?? record.size, maxObjectBytes),
    sha256: normalizeSha256Hex(record.sha256),
    contentType: normalizeStorageContentType(record.content_type ?? record.contentType),
    visibility: normalizeStorageVisibility(record.visibility),
    immutable,
    ...(typeof ttl === "number" ? { ttlSeconds: ttl } : {}),
  };
}

function signedReadTtlInput(body: unknown): number | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new RangeError("Signed-read body must be a JSON object.");
  }
  const ttl = (body as Record<string, unknown>).ttl_seconds;
  if (ttl === undefined) return undefined;
  if (typeof ttl !== "number" || !Number.isFinite(ttl)) {
    throw new RangeError("ttl_seconds must be a number.");
  }
  return ttl;
}

function requestBodyBytes(body: unknown): Uint8Array {
  if (body instanceof Uint8Array) return body;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (typeof body === "object" && body !== null && !Array.isArray(body)) {
    const bytesBase64 = (body as Record<string, unknown>).bytes_base64 ?? (body as Record<string, unknown>).bytesBase64;
    if (typeof bytesBase64 === "string") return Buffer.from(bytesBase64, "base64");
  }
  throw new RangeError("Upload byte body must be raw bytes or { bytes_base64 }.");
}

async function verifyOptionalSignedRead(
  runtime: CoreGatewayRuntime,
  query: URLSearchParams,
  projectId: string,
  key: string,
  sha256?: string | null,
): Promise<boolean> {
  const signedReads = runtime.signedReads;
  if (!signedReads) return false;
  const signature = query.get("signature");
  const expires = query.get("expires");
  if (!signature || !expires) return false;
  const expiresAtEpochSeconds = Number(expires);
  if (!Number.isFinite(expiresAtEpochSeconds)) return false;
  return await signedReads.verifyRead({
    projectId,
    key,
    expiresAtEpochSeconds,
    signature,
    sha256: sha256 ?? null,
  });
}

async function serveCas(
  runtime: CoreGatewayRuntime,
  input: {
    sha256: string;
    contentType: string;
    visibility: "public" | "private";
    immutable: boolean;
    head: boolean;
  },
): Promise<CoreGatewayResult> {
  const content = runtime.content;
  if (!content?.readCas) return unavailable("content_store_unavailable", "Run402 Core content store is not configured.");
  const stored = await content.readCas(input.sha256);
  if (!stored) {
    return {
      status: 409,
      body: {
        error: "content_digest_missing",
        message: `Storage content ${input.sha256} is missing from the local content store.`,
      },
    };
  }
  return {
    status: 200,
    raw: true,
    body: input.head ? new Uint8Array() : stored.bytes,
    headers: {
      "Content-Type": input.contentType || stored.contentType,
      "Content-Length": String(stored.bytes.byteLength),
      "ETag": `"sha256-${input.sha256}"`,
      "X-Run402-Content-Sha256": input.sha256,
      "Content-Digest": `sha-256=:${Buffer.from(input.sha256, "hex").toString("base64")}:`,
      "Cache-Control": cacheControlForStorage(input.visibility, input.immutable),
    },
  };
}

function cacheControlForStorage(visibility: "public" | "private", immutable: boolean): string {
  if (visibility === "private") return "private, no-store";
  return immutable
    ? "public, max-age=31536000, immutable"
    : "public, max-age=300, stale-while-revalidate=3600";
}

function storageRouteError(error: unknown): CoreGatewayResult {
  if (error instanceof StorageValidationError) {
    return { status: error.status, body: storageErrorEnvelope(error) };
  }
  if (error instanceof ApplyInvariantError) {
    return { status: error.status, body: applyInvariantEnvelope(error) };
  }
  if (error instanceof RangeError) {
    return { status: 400, body: { error: "invalid_request", message: error.message } };
  }
  throw error;
}

function storageNotFound(): CoreGatewayResult {
  return { status: 404, body: { error: "storage_not_found", message: "Storage object was not found." } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}

async function safeRequest(
  req: IncomingMessage,
  pathnameWithQuery: string,
  runtime: CoreGatewayRuntime,
): Promise<CoreGatewayResult> {
  try {
    return await coreGatewayResponse({
      method: req.method,
      pathname: pathnameWithQuery,
      headers: req.headers,
      body: await readRequestBody(req, pathnameWithQuery),
    }, runtime);
  } catch (error) {
    if (error instanceof RangeError) {
      return {
        status: 400,
        body: {
          error: "invalid_request",
          message: error.message,
        },
      };
    }
    throw error;
  }
}

async function readRequestBody(req: IncomingMessage, pathnameWithQuery: string): Promise<unknown> {
  if (req.method === "GET" || req.method === "HEAD") {
    return undefined;
  }
  if (
    (req.method === "PUT" && /^\/projects\/v1\/[^/]+\/storage\/uploads\/[^/]+\/bytes(?:\?|$)/.test(pathnameWithQuery)) ||
    /^\/projects\/v1\/[^/]+\/static(?:\/|\?|$)/.test(pathnameWithQuery)
  ) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
  }
  if (!raw.trim()) {
    return {};
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new RangeError("Request body must be valid JSON.");
  }
}

function projectInput(body: unknown): { name?: string | null } {
  if (body === undefined || body === null) {
    return {};
  }
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new RangeError("Project create body must be a JSON object.");
  }
  const name = (body as { name?: unknown }).name;
  if (name !== undefined && name !== null && typeof name !== "string") {
    throw new RangeError("Project name must be a string.");
  }
  return { name };
}

async function stageContent(
  content: ContentStorePort,
  projectId: string,
  body: unknown,
): Promise<{ staged: true; sha256: string; size_bytes: number; content_type: string }> {
  if (!("putVerified" in content)) {
    throw new Error("Configured content store does not support verified staging.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new RangeError("Content staging body must be a JSON object.");
  }
  const record = body as Record<string, unknown>;
  const sha256 = expectString(record.sha256, "sha256").toLowerCase();
  const size = expectInteger(record.size ?? record.size_bytes, "size");
  const contentType = expectString(record.content_type ?? record.contentType ?? "application/octet-stream", "content_type");
  const bytesBase64 = expectString(record.bytes_base64 ?? record.bytesBase64, "bytes_base64");
  const bytes = Buffer.from(bytesBase64, "base64");
  const ref: ContentRefHex = {
    sha256,
    size,
    contentType,
  };
  await (content as VerifiedContentStore).putVerified(projectId, ref, bytes);
  return {
    staged: true,
    sha256,
    size_bytes: size,
    content_type: contentType,
  };
}

function applySpecInput(body: unknown): unknown {
  if (typeof body === "object" && body !== null && !Array.isArray(body) && "spec" in body) {
    return (body as { spec: unknown }).spec;
  }
  return body;
}

function commitInput(body: unknown): { release_spec_digest?: string } {
  if (body === undefined || body === null) return {};
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new RangeError("Commit body must be a JSON object.");
  }
  const digest = (body as { release_spec_digest?: unknown }).release_spec_digest;
  if (digest !== undefined && typeof digest !== "string") {
    throw new RangeError("release_spec_digest must be a string.");
  }
  return { release_spec_digest: digest };
}

function createDevToken(body: unknown, secret: string): {
  token: string;
  authorization: string;
  role: "anon" | "authenticated" | "service_role";
  sub: string | null;
} {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new RangeError("Dev token body must be a JSON object.");
  }
  const record = body as Record<string, unknown>;
  const projectId = expectString(record.project_id ?? record.projectId, "project_id");
  const role = expectRole(record.role ?? "authenticated");
  const sub = role === "anon" ? null : expectString(record.sub ?? (role === "service_role" ? "service" : "user"), "sub");
  const payload: Record<string, string> = {
    iss: "run402-core-dev",
    project_id: projectId,
    role,
  };
  if (sub) payload.sub = sub;
  const token = signJwt(payload, secret);
  return {
    token,
    authorization: `Bearer ${token}`,
    role,
    sub,
  };
}

function signJwt(payload: Record<string, string>, secret: string): string {
  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = base64Url(JSON.stringify(header));
  const encodedPayload = base64Url(stableJson(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = createHmac("sha256", secret).update(signingInput).digest("base64url");
  return `${signingInput}.${signature}`;
}

function stableJson(record: Record<string, string>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b))));
}

function base64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function expectRole(value: unknown): "anon" | "authenticated" | "service_role" {
  if (value === "anon" || value === "authenticated" || value === "service_role") {
    return value;
  }
  throw new RangeError("role must be anon, authenticated, or service_role.");
}

function applyErrorResponse(error: unknown): CoreGatewayResult {
  if (error instanceof RuntimeKernelTypedError) {
    return { status: error.status, body: runtimeKernelErrorEnvelope(error) };
  }
  if (error instanceof UnsupportedCapabilityError) {
    return { status: error.status, body: unsupportedCapabilityEnvelope(error) };
  }
  if (error instanceof ApplyInvariantError) {
    const status = error.code === "project_not_found" || error.code === "plan_not_found" ? 404 : error.status;
    return { status, body: applyInvariantEnvelope(error) };
  }
  if (error instanceof StorageValidationError) {
    return { status: error.status, body: storageErrorEnvelope(error) };
  }
  if (error instanceof ReleaseCoreError) {
    return {
      status: 400,
      body: {
        error: "invalid_release_spec",
        message: error.message,
        resource: error.resource,
        code: error.code,
      },
    };
  }
  if (error instanceof RangeError) {
    return {
      status: 400,
      body: {
        error: "invalid_request",
        message: error.message,
      },
    };
  }
  throw error;
}

async function staticResponse(
  runtime: CoreGatewayRuntime,
  projectId: string,
  rawPath: string,
  request: {
    method: string;
    rawQuery: string;
    headers?: CoreGatewayRequest["headers"];
    body?: unknown;
  },
): Promise<CoreGatewayResult> {
  if (!runtime.releases || !runtime.content) {
    return unavailable("runtime_kernel_unavailable", "Run402 Core runtime kernel is not fully configured.");
  }
  const publicPath = normalizePublicStaticPath(rawPath);
  const active = await runtime.releases.getBase(projectId, "current");
  if (!active.release_id) {
    return {
      status: 404,
      body: {
        error: "static_not_found",
        message: "Project has no active static release.",
      },
    };
  }
  const route = routeForPath(active.state.routes.entries, publicPath);
  if (route) {
    if (!routeMethodAllows(route, request.method)) return methodNotAllowed(route);
    if (route.target.type === "function") {
      const functionRoute = route as RouteEntry & { target: { type: "function"; name: string } };
      return await invokeRoutedFunction(runtime, {
        projectId,
        releaseId: active.release_id,
        route: functionRoute,
        publicPath,
        rawQuery: request.rawQuery,
        method: request.method,
        headers: request.headers,
        body: request.body,
        locale: active.state.i18n?.defaultLocale ?? null,
        defaultLocale: active.state.i18n?.defaultLocale ?? null,
      });
    }
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return await staticMethodResponse(runtime, projectId, rawPath, request.method);
  }
  const entry = active.state.static_manifest?.files[route?.target.type === "static" ? route.pattern : publicPath];
  if (!entry) {
    return {
      status: 404,
      body: {
        error: "static_not_found",
        message: `Static path not found: ${publicPath}`,
      },
    };
  }
  const sha256 = staticEntrySha256(active.state, publicPath, entry);
  const content = await runtime.content.readStatic(projectId, sha256);
  if (!content) {
    return {
      status: 409,
      body: {
        error: "content_digest_missing",
        message: `Static content ${sha256} is missing from the local content store.`,
      },
    };
  }
  return {
    status: 200,
    raw: true,
    body: request.method === "HEAD" ? new Uint8Array() : content.bytes,
    headers: {
      "Content-Type": entry.content_type || content.contentType,
      "Content-Length": String(content.bytes.byteLength),
      "ETag": `"sha256-${sha256}"`,
      "X-Run402-Content-Sha256": sha256,
      "Content-Digest": `sha-256=:${Buffer.from(sha256, "hex").toString("base64")}:`,
      "Cache-Control": cacheControlForStaticCacheClass(entry.cache_class),
      ...entry.response_metadata?.headers,
    },
  };
}

async function staticMethodResponse(
  runtime: CoreGatewayRuntime,
  projectId: string,
  rawPath: string,
  method: string,
): Promise<CoreGatewayResult> {
  if (!runtime.releases) {
    return unavailable("runtime_kernel_unavailable", "Run402 Core runtime kernel is not fully configured.");
  }
  const publicPath = normalizePublicStaticPath(rawPath);
  const active = await runtime.releases.getBase(projectId, "current");
  const route = routeForPath(active.state.routes.entries, publicPath);
  if (route) return methodNotAllowed(route);
  const entry = active.state.static_manifest?.files[publicPath];
  if (entry && method !== "GET" && method !== "HEAD") {
    return {
      status: 405,
      headers: { Allow: "GET, HEAD" },
      body: {
        error: "method_not_allowed",
        message: `Static path ${publicPath} supports only GET and HEAD.`,
      },
    };
  }
  return {
    status: 404,
    body: {
      error: "static_not_found",
      message: `Static path not found: ${publicPath}`,
    },
  };
}

async function staticDiagnostics(
  runtime: CoreGatewayRuntime,
  projectId: string,
): Promise<CoreGatewayResult> {
  if (!runtime.releases) {
    return unavailable("runtime_kernel_unavailable", "Run402 Core runtime kernel is not fully configured.");
  }
  const active = await runtime.releases.getBase(projectId, "current");
  const manifest = active.state.static_manifest;
  return {
    status: 200,
    body: {
      project_id: projectId,
      release_id: active.release_id,
      route_manifest_sha256: active.state.routes.manifest_sha256,
      static_manifest_sha256: manifest ? computeStaticManifestSha256(manifest) : null,
      public_paths: Object.entries(manifest?.files ?? {}).map(([publicPath, entry]) => ({
        public_path: publicPath,
        asset_path: entry.asset_path ?? publicPath.replace(/^\//, ""),
        sha256: entry.sha256,
        content_type: entry.content_type,
        authority: entry.authority ?? null,
        direct: entry.direct ?? false,
        methods: entry.methods ?? ["GET", "HEAD"],
      })),
      release_asset_paths: active.state.site.paths.map((entry) => entry.path).sort(),
      non_public_asset_paths: active.state.site.paths
        .map((entry) => entry.path)
        .filter((path) => !Object.values(manifest?.files ?? {}).some((file) => (file.asset_path ?? "").replace(/^\/+/, "") === path))
        .sort(),
    },
  };
}

function staticEntrySha256(
  release: PortableReleaseState,
  publicPath: string,
  entry: StaticManifestFileEntry,
): string {
  const assetPath = entry.asset_path ?? publicPath.replace(/^\//, "");
  const siteEntry = release.site.paths.find((path) => path.path === assetPath);
  return siteEntry?.content_sha256 ?? entry.sha256;
}

async function invokeRoutedFunction(
  runtime: CoreGatewayRuntime,
  input: {
    projectId: string;
    releaseId: string;
    route: RouteEntry & { target: { type: "function"; name: string } };
    publicPath: string;
    rawQuery: string;
    method: string;
    headers?: CoreGatewayRequest["headers"];
    body?: unknown;
    locale: string | null;
    defaultLocale: string | null;
  },
): Promise<CoreGatewayResult> {
  if (!runtime.functionExecutor || !runtime.functionBundles) {
    const error = new DynamicRuntimeUnavailableError("Run402 Core dynamic functions runtime is not configured.", {
      route_pattern: input.route.pattern,
      function_name: input.route.target.name,
    });
    return { status: error.status, body: runtimeKernelErrorEnvelope(error) };
  }
  const bundle = await runtime.functionBundles.getFunctionBundle({
    projectId: input.projectId,
    releaseId: input.releaseId,
    functionName: input.route.target.name,
  });
  if (!bundle) {
    const error = new DynamicRuntimeUnavailableError("Run402 Core function bundle metadata is not available.", {
      route_pattern: input.route.pattern,
      function_name: input.route.target.name,
      release_id: input.releaseId,
    });
    return { status: error.status, body: runtimeKernelErrorEnvelope(error) };
  }

  const requestId = `req_${randomBytes(12).toString("hex")}`;
  try {
    const result = await runtime.functionExecutor.invoke({
      projectId: input.projectId,
      releaseId: input.releaseId,
      functionName: input.route.target.name,
      invocationKind: "routed_http",
      requestId,
      bundle,
      request: {
        version: "run402.routed_http.v1",
        method: input.method,
        url: routedUrl(input.headers, input.publicPath, input.rawQuery),
        path: input.publicPath,
        rawPath: input.publicPath,
        rawQuery: input.rawQuery,
        headers: routedRequestHeaders(input.headers, {
          projectId: input.projectId,
          releaseId: input.releaseId,
          requestId,
          functionName: input.route.target.name,
        }),
        cookies: { raw: cookieHeader(input.headers) },
        body: routedBody(input.body),
        context: {
          source: "route",
          projectId: input.projectId,
          releaseId: input.releaseId,
          deploymentId: null,
          host: hostHeader(input.headers),
          proto: protoHeader(input.headers),
          routePattern: input.route.pattern,
          routeKind: input.route.kind,
          routeTarget: { type: "function", name: input.route.target.name },
          requestId,
          locale: input.locale,
          defaultLocale: input.defaultLocale,
        },
      },
    });
    return functionResultToGateway(result, input.method);
  } catch (error) {
    return applyErrorResponse(error);
  }
}

function functionResultToGateway(result: LocalFunctionExecutorResult, method: string): CoreGatewayResult {
  const response = result.response;
  const body = response.body ? Buffer.from(response.body.data, "base64") : Buffer.alloc(0);
  const headers = responseHeaders(response.headers, response.cookies);
  headers["X-Run402-Request-Id"] = result.requestId;
  if (!headerValue(headers, "Cache-Control")) {
    headers["Cache-Control"] = "private, no-store";
  }
  if (!headerValue(headers, "Content-Length")) {
    headers["Content-Length"] = String(body.byteLength);
  }
  return {
    status: response.status,
    raw: true,
    body: method === "HEAD" ? new Uint8Array() : body,
    headers,
  };
}

function responseHeaders(
  headers: Array<[string, string]> | undefined,
  cookies: string[] | undefined,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of headers ?? []) {
    if (isHopByHopHeader(name)) continue;
    setHeaderValue(out, name, value);
  }
  if (cookies?.length) {
    out["Set-Cookie"] = cookies;
  }
  return out;
}

function setHeaderValue(headers: Record<string, string | string[]>, name: string, value: string): void {
  const existingKey = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase()) ?? name;
  const existing = headers[existingKey];
  if (existing === undefined) {
    headers[existingKey] = value;
  } else if (Array.isArray(existing)) {
    existing.push(value);
  } else {
    headers[existingKey] = [existing, value];
  }
}

function headerValue(headers: Record<string, string | string[]>, name: string): string | string[] | undefined {
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

function routedUrl(headers: CoreGatewayRequest["headers"], publicPath: string, rawQuery: string): string {
  const query = rawQuery ? `?${rawQuery}` : "";
  return `${protoHeader(headers)}://${hostHeader(headers)}${publicPath}${query}`;
}

function routedRequestHeaders(
  headers: CoreGatewayRequest["headers"],
  context: {
    projectId: string;
    releaseId: string;
    requestId: string;
    functionName: string;
  },
): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [rawName, rawValue] of Object.entries(headers ?? {})) {
    const name = rawName.toLowerCase();
    if (isHopByHopHeader(name) || name.startsWith("x-run402-")) continue;
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) {
      if (value !== undefined) out.push([name, value]);
    }
  }
  out.push(["x-run402-project-id", context.projectId]);
  out.push(["x-run402-release-id", context.releaseId]);
  out.push(["x-run402-request-id", context.requestId]);
  out.push(["x-run402-function-name", context.functionName]);
  return out;
}

function routedBody(body: unknown): NonNullable<LocalFunctionExecutorInput["request"]>["body"] {
  if (body === undefined || body === null) return null;
  const bytes = body instanceof Uint8Array
    ? Buffer.from(body)
    : Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8");
  if (bytes.byteLength > CORE_FUNCTION_RESOURCE_DEFAULTS.requestBodyLimitBytes) {
    throw new RangeError(`Function request body exceeds ${CORE_FUNCTION_RESOURCE_DEFAULTS.requestBodyLimitBytes} bytes.`);
  }
  return {
    encoding: "base64",
    data: bytes.toString("base64"),
    size: bytes.byteLength,
  };
}

function hostHeader(headers: CoreGatewayRequest["headers"]): string {
  const value = firstHeader(headers, "host");
  return value && /^[a-zA-Z0-9.:-]+$/.test(value) ? value : "localhost";
}

function protoHeader(headers: CoreGatewayRequest["headers"]): "http" | "https" {
  return firstHeader(headers, "x-forwarded-proto") === "https" ? "https" : "http";
}

function cookieHeader(headers: CoreGatewayRequest["headers"]): string | null {
  return firstHeader(headers, "cookie") ?? null;
}

function firstHeader(headers: CoreGatewayRequest["headers"], name: string): string | undefined {
  const entry = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
  if (!entry) return undefined;
  return Array.isArray(entry[1]) ? entry[1][0] : entry[1];
}

function isHopByHopHeader(name: string): boolean {
  return [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ].includes(name.toLowerCase());
}

function normalizePublicStaticPath(rawPath: string): string {
  const raw = rawPath || "/";
  if (!raw.startsWith("/")) throw new RangeError("Static path must start with /.");
  if (raw.includes("\\") || /%(?:2f|5c)/i.test(raw)) {
    throw new RangeError("Static path must not contain slash or backslash escapes.");
  }
  if (/[\x00-\x1f\x7f]/.test(raw) || raw.includes("//")) {
    throw new RangeError("Static path is invalid.");
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new RangeError("Static path contains malformed percent encoding.");
  }
  if (/[\x00-\x1f\x7f]/.test(decoded) || decoded.includes("\\")) {
    throw new RangeError("Static path is invalid.");
  }
  const normalized = decoded.normalize("NFC");
  if (normalized.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new RangeError("Static path must not contain dot segments.");
  }
  if (
    normalized === "/_cas" ||
    normalized.startsWith("/_cas/") ||
    normalized === "/_run402" ||
    normalized.startsWith("/_run402/")
  ) {
    throw new RangeError("Static path targets an internal Run402 namespace.");
  }
  if (normalized !== "/" && normalized.endsWith("/")) return normalized.slice(0, -1);
  return normalized;
}

function routeForPath(routes: readonly RouteEntry[], path: string): RouteEntry | null {
  for (const route of routes) {
    if (route.kind === "exact" && normalizePublicStaticPath(route.pattern) === path) return route;
    if (route.kind === "prefix" && route.prefix && path.startsWith(route.prefix)) return route;
  }
  return null;
}

function routeMethodAllows(route: RouteEntry, method: string): boolean {
  if (!route.methods) return true;
  return (route.methods as readonly string[]).includes(method);
}

function methodNotAllowed(route: RouteEntry): CoreGatewayResult {
  const allowed = route.methods?.length ? route.methods.join(", ") : "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS";
  return {
    status: 405,
    headers: { Allow: allowed },
    body: {
      error: "method_not_allowed",
      message: `Route ${route.pattern} does not allow this method.`,
    },
  };
}

function expectString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new RangeError(`${name} must be a non-empty string.`);
  }
  return value;
}

function expectInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer.`);
  }
  return value;
}

function expectQueryInteger(value: string | null, name: string): number {
  if (!value) throw new RangeError(`${name} must be present.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RangeError(`${name} must be a non-negative integer.`);
  }
  return parsed;
}

function expectBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw new RangeError(`${name} must be a boolean.`);
  }
  return value;
}

function unsupportedFeatureForPath(pathname: string): ConstructorParameters<typeof UnsupportedCapabilityError>[0] | null {
  if (pathname.startsWith("/ssr")) return "astro.ssr";
  if (pathname.startsWith("/export")) return "export.project-archive";
  if (pathname.startsWith("/import")) return "import.project-archive";
  if (pathname.startsWith("/auth/oauth")) return "auth.hosted-oauth";
  if (pathname.startsWith("/jobs")) return "cloud.fleet-scheduling";
  return null;
}
