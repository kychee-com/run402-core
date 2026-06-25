import { createHmac } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import {
  applyInvariantEnvelope,
  ApplyInvariantError,
  commitApplyPlan,
  createApplyPlan,
  createCoreProject,
  inspectCoreProject,
  ProjectNotFoundError,
  projectNotFoundEnvelope,
  runtimeCapabilities,
  runtimeHealth,
  UnsupportedCapabilityError,
  unsupportedCapabilityEnvelope,
  type ContentStorePort,
  type RuntimeKernelPorts,
  type ProjectCatalogPort,
} from "@run402/runtime-kernel";
import { ReleaseCoreError, type ContentRefHex, type PortableReleaseState, type StaticManifestFileEntry } from "@run402/release";
import { FilesystemContentStore } from "./filesystem-content.js";
import { PostgresApplyStore } from "./postgres-apply.js";
import { createPostgresPool, PostgresProjectCatalog } from "./postgres-projects.js";

export interface CoreGatewayConfig {
  host: string;
  port: number;
  databaseUrl?: string;
  publicBaseUrl: string;
  postgrestPublicUrl: string;
  contentDir: string;
  jwtSecret: string;
}

export interface CoreGatewayRuntime {
  projects?: ProjectCatalogPort;
  releases?: RuntimeKernelPorts["releases"];
  plans?: RuntimeKernelPorts["plans"];
  content?: ContentStorePort;
  migrations?: RuntimeKernelPorts["migrations"];
  jwtSecret?: string;
  close?: () => Promise<void>;
}

interface VerifiedContentStore extends ContentStorePort {
  putVerified(projectId: string, ref: ContentRefHex, bytes: Uint8Array): Promise<void>;
}

export interface CoreGatewayRequest {
  method?: string;
  pathname: string;
  body?: unknown;
}

export interface CoreGatewayResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
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
  await projects.bootstrap();
  await applyStore.bootstrap();

  return {
    projects,
    releases: applyStore,
    plans: applyStore,
    content,
    migrations: applyStore,
    jwtSecret: config.jwtSecret,
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
  const pathname = request.pathname;
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
  if ((method === "GET" || method === "HEAD") && staticMatch) {
    const staticResult = await staticResponse(runtime, staticMatch[1], staticMatch[2] || "/");
    if (method === "HEAD" && staticResult.status === 200) {
      return { ...staticResult, body: new Uint8Array() };
    }
    return staticResult;
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
  const result = await safeRequest(req, url.pathname, runtime);
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
    migrations: runtime.migrations,
  };
}

function unavailable(error: string, message: string): CoreGatewayResult {
  return {
    status: 503,
    body: { error, message },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}

async function safeRequest(
  req: IncomingMessage,
  pathname: string,
  runtime: CoreGatewayRuntime,
): Promise<CoreGatewayResult> {
  try {
    return await coreGatewayResponse({
      method: req.method,
      pathname,
      body: await readJsonBody(req),
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

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  if (req.method === "GET" || req.method === "HEAD") {
    return undefined;
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
  if (error instanceof UnsupportedCapabilityError) {
    return { status: error.status, body: unsupportedCapabilityEnvelope(error) };
  }
  if (error instanceof ApplyInvariantError) {
    const status = error.code === "project_not_found" || error.code === "plan_not_found" ? 404 : error.status;
    return { status, body: applyInvariantEnvelope(error) };
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
  const entry = active.state.static_manifest?.files[publicPath];
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
    body: content.bytes,
    headers: {
      "Content-Type": entry.content_type || content.contentType,
      "Content-Length": String(content.bytes.byteLength),
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

function normalizePublicStaticPath(rawPath: string): string {
  const decoded = decodeURIComponent(rawPath || "/");
  if (decoded.includes("\0") || decoded.includes("..")) {
    throw new RangeError("Static path is invalid.");
  }
  return decoded.startsWith("/") ? decoded : `/${decoded}`;
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

function unsupportedFeatureForPath(pathname: string): ConstructorParameters<typeof UnsupportedCapabilityError>[0] | null {
  if (pathname.startsWith("/functions")) return "functions.node";
  if (pathname.startsWith("/ssr")) return "astro.ssr";
  if (pathname.startsWith("/storage")) return "storage.user-api";
  if (pathname.startsWith("/export")) return "export.project-archive";
  if (pathname.startsWith("/import")) return "import.project-archive";
  if (pathname.startsWith("/auth/oauth")) return "auth.hosted-oauth";
  if (pathname.startsWith("/jobs")) return "cloud.fleet-scheduling";
  return null;
}
