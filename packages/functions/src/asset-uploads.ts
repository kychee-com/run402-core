/**
 * Function-delegated uploads: a function opens an upload on behalf of one of
 * its users, the user's browser sends the bytes straight to storage through
 * presigned part URLs, and completion makes an ordinary asset.
 *
 * Two layers:
 *   - `assets.createUpload / renewUpload / getUpload / completeUpload /
 *     abortUpload` — the primitives over `/apply/v1/asset-uploads`, with the
 *     function's service key.
 *   - `uploads.handler({ identify, authorize, onComplete })` — a
 *     `(Request) => Promise<Response>` that serves the protocol the browser
 *     module (`@run402/functions/browser/upload.js`) speaks, checks that every
 *     call after the first comes from the upload's owner, and dispatches the
 *     completion run to `onComplete`.
 */

import { config } from "./config.js";
import { isFunctionRun, parseFunctionRunEnvelope } from "./function-runs.js";

// ---- Types ----------------------------------------------------------------

export type UploadStatus = "active" | "verifying" | "completed" | "failed" | "aborted";

export interface UploadPartUrl {
  part_number: number;
  url: string;
  byte_start: number;
  byte_end: number;
}

export interface UploadState {
  upload_id: string;
  key: string;
  status: UploadStatus;
  mode: "single" | "multipart";
  size_bytes: number;
  content_type: string;
  visibility: "public" | "private";
  part_size_bytes: number;
  part_count: number;
  /** Present on open and renew: presigned URLs, each for one part at its exact length. */
  parts?: UploadPartUrl[];
  parts_expires_at?: string;
  /** Present on `getUpload`: the parts storage holds. */
  parts_done?: number[];
  bytes_done?: number;
  owner: string | null;
  metadata: Record<string, string | number | boolean | string[]> | null;
  expires_at: string;
  /** The AssetRef once `status` is `completed`. */
  asset?: Record<string, unknown>;
  /** The reason once `status` is `failed` (or an expiry, on `aborted`). */
  error?: { code: string; message: string };
  /** Missing parts this response carries no URL for; `renewUpload` signs them. */
  parts_remaining?: number;
  next_actions?: Array<Record<string, string>>;
}

export interface CreateUploadOptions {
  sizeBytes: number;
  contentType: string;
  visibility?: "public" | "private";
  immutable?: boolean;
  exifPolicy?: "keep" | "strip";
  metadata?: Record<string, string | number | boolean | string[]>;
  /** A known whole-file sha256: verified at completion, and a file the project already holds completes at once. */
  sha256?: string;
  /** Opaque owner tag (≤256 chars), stored and returned; `uploads.handler` sets it to `identify(req)`. */
  owner?: string;
  /** A function of this project to run once the upload completes or fails. */
  onComplete?: { function: string };
  /** How long each batch of part URLs lives: 60 s to 6 h, default 1 h. */
  ttlSeconds?: number;
}

export class Run402UploadError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;
  readonly next_actions?: unknown[];
  constructor(status: number, code: string, message: string, extra: { details?: Record<string, unknown>; next_actions?: unknown[] } = {}) {
    super(message);
    this.name = "Run402UploadError";
    this.status = status;
    this.code = code;
    this.details = extra.details;
    this.next_actions = extra.next_actions;
  }
}

// ---- Primitives -------------------------------------------------------------

const UPLOAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(config.API_BASE + path, {
    method,
    headers: {
      Authorization: "Bearer " + config.SERVICE_KEY,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try { parsed = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { parsed = { message: text }; }
  if (!res.ok) {
    throw new Run402UploadError(
      res.status,
      String(parsed.code ?? "UPLOAD_REQUEST_FAILED"),
      String(parsed.message ?? parsed.error ?? `Upload request failed (${res.status})`),
      { details: parsed.details as Record<string, unknown> | undefined, next_actions: parsed.next_actions as unknown[] | undefined },
    );
  }
  return { status: res.status, body: parsed as T };
}

function requireUploadId(uploadId: unknown, method: string): string {
  if (typeof uploadId !== "string" || !UPLOAD_ID_RE.test(uploadId)) {
    throw new Run402UploadError(400, "VALIDATION_FAILED", `assets.${method}: uploadId must be an upload id`);
  }
  return uploadId;
}

function validateCreate(key: string, opts: CreateUploadOptions): void {
  const bad = (m: string) => new Run402UploadError(400, "VALIDATION_FAILED", `assets.createUpload: ${m}`);
  if (typeof key !== "string" || key === "") throw bad("key must be a non-empty string");
  if (!opts || !Number.isInteger(opts.sizeBytes) || opts.sizeBytes < 1) throw bad("sizeBytes must be a positive integer");
  if (typeof opts.contentType !== "string" || !opts.contentType.includes("/")) throw bad("contentType must be a MIME type");
  if (opts.visibility !== undefined && opts.visibility !== "public" && opts.visibility !== "private") throw bad("visibility must be 'public' or 'private'");
  if (opts.exifPolicy !== undefined && opts.exifPolicy !== "keep" && opts.exifPolicy !== "strip") throw bad("exifPolicy must be 'keep' or 'strip'");
  if (opts.sha256 !== undefined && !/^[0-9a-f]{64}$/i.test(opts.sha256)) throw bad("sha256 must be 64 hex characters");
}

export async function createUpload(key: string, opts: CreateUploadOptions): Promise<UploadState> {
  validateCreate(key, opts);
  const { body } = await call<UploadState>("POST", "/apply/v1/asset-uploads", {
    key,
    size_bytes: opts.sizeBytes,
    content_type: opts.contentType,
    visibility: opts.visibility,
    immutable: opts.immutable,
    exif_policy: opts.exifPolicy,
    metadata: opts.metadata,
    sha256: opts.sha256?.toLowerCase(),
    owner: opts.owner,
    on_complete: opts.onComplete,
    ttl_seconds: opts.ttlSeconds,
  });
  return body;
}

export async function renewUpload(uploadId: string, opts: { partNumbers?: number[]; ttlSeconds?: number } = {}): Promise<UploadState> {
  const id = requireUploadId(uploadId, "renewUpload");
  const { body } = await call<UploadState>("POST", `/apply/v1/asset-uploads/${id}/urls`, {
    part_numbers: opts.partNumbers,
    ttl_seconds: opts.ttlSeconds,
  });
  return body;
}

export async function getUpload(uploadId: string): Promise<UploadState> {
  const id = requireUploadId(uploadId, "getUpload");
  return (await call<UploadState>("GET", `/apply/v1/asset-uploads/${id}`)).body;
}

export async function completeUpload(uploadId: string): Promise<UploadState> {
  const id = requireUploadId(uploadId, "completeUpload");
  return (await call<UploadState>("POST", `/apply/v1/asset-uploads/${id}/complete`, {})).body;
}

export async function abortUpload(uploadId: string): Promise<UploadState> {
  const id = requireUploadId(uploadId, "abortUpload");
  return (await call<UploadState>("DELETE", `/apply/v1/asset-uploads/${id}`)).body;
}

// ---- Handler ------------------------------------------------------------------

export interface UploadFileInfo {
  name: string;
  size: number;
  type: string;
}

export type AuthorizeResult =
  | (Omit<CreateUploadOptions, "sizeBytes" | "contentType" | "owner" | "onComplete"> & { key: string; contentType?: string })
  | { refuse: string };

export interface UploadsHandlerOptions {
  /** Who is calling: an opaque owner id, or null when the caller is not signed in (→ 401). */
  identify: (req: Request) => string | null | Promise<string | null>;
  /** Decide the key and options for a new upload, or refuse it (→ 403 with the reason). */
  authorize: (file: UploadFileInfo, owner: string, req: Request) => AuthorizeResult | Promise<AuthorizeResult>;
  /** Runs once per upload when it completes, as a durable function run (survives a closed tab). */
  onComplete?: (asset: Record<string, unknown>, upload: UploadState) => unknown | Promise<unknown>;
  /** Runs once per upload that fails verification. */
  onFailed?: (upload: UploadState) => unknown | Promise<unknown>;
  /** This function's name, for the completion run. Default: `RUN402_FUNCTION_NAME`. */
  functionName?: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function errorResponse(err: unknown): Response {
  if (err instanceof Run402UploadError) {
    return json({ code: err.code, message: err.message, details: err.details, next_actions: err.next_actions }, err.status);
  }
  throw err;
}

/** The part of the path after the mount point: `[]`, `[id]`, or `[id, action]`. */
function routeOf(url: string): string[] {
  const parts = new URL(url, "http://local").pathname.split("/").filter(Boolean);
  const i = parts.findIndex((p) => UPLOAD_ID_RE.test(p));
  return i === -1 ? [] : parts.slice(i);
}

/** What the browser sees of an upload: the state without the owner tag. */
function forBrowser(state: UploadState): Omit<UploadState, "owner"> {
  const { owner: _owner, ...rest } = state;
  return rest;
}

async function readFileInfo(req: Request): Promise<UploadFileInfo | null> {
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body.name !== "string" || !Number.isInteger(body.size) || typeof body.type !== "string") return null;
  return { name: body.name, size: body.size as number, type: body.type || "application/octet-stream" };
}

async function handleOpen(opts: UploadsHandlerOptions, req: Request, owner: string): Promise<Response> {
  const file = await readFileInfo(req);
  if (!file) return json({ code: "VALIDATION_FAILED", message: "Send { name, size, type } for the file" }, 400);
  const decision = await opts.authorize(file, owner, req);
  if ("refuse" in decision) return json({ code: "UPLOAD_REFUSED", message: decision.refuse }, 403);
  const { key, contentType, ...rest } = decision;
  const functionName = opts.functionName ?? process.env.RUN402_FUNCTION_NAME;
  if (opts.onComplete && !functionName) {
    throw new Error("uploads.handler: onComplete needs functionName (RUN402_FUNCTION_NAME is not set here)");
  }
  const state = await createUpload(key, {
    ...rest,
    sizeBytes: file.size,
    contentType: contentType ?? file.type,
    owner,
    onComplete: (opts.onComplete || opts.onFailed) && functionName ? { function: functionName } : undefined,
  });
  return json(forBrowser(state), 201);
}

async function handleCompletionRun(opts: UploadsHandlerOptions, req: Request): Promise<Response> {
  const envelope = parseFunctionRunEnvelope(await req.json());
  const uploadId = String((envelope.payload as { upload_id?: unknown }).upload_id ?? "");
  const state = await getUpload(uploadId);
  if (state.status === "completed" && state.asset && opts.onComplete) await opts.onComplete(state.asset, state);
  if (state.status === "failed" && opts.onFailed) await opts.onFailed(state);
  return json({ ok: true });
}

async function handleExisting(req: Request, owner: string, id: string, action: string | undefined): Promise<Response> {
  // Every call after the first must come from the upload's owner; anyone else
  // gets the same 404 a missing upload gets.
  const current = await getUpload(id);
  if (current.owner !== owner) return json({ code: "RESOURCE_NOT_FOUND", message: "Upload not found" }, 404);
  if (req.method === "GET" && !action) return json(forBrowser(current));
  if (req.method === "DELETE" && !action) return json(forBrowser(await abortUpload(id)));
  if (req.method === "POST" && action === "complete") {
    const state = await completeUpload(id);
    return json(forBrowser(state), state.status === "verifying" ? 202 : 200);
  }
  if (req.method === "POST" && action === "urls") {
    const body = await req.json().catch(() => ({})) as { part_numbers?: number[] };
    return json(forBrowser(await renewUpload(id, { partNumbers: body.part_numbers })));
  }
  return json({ code: "METHOD_NOT_ALLOWED", message: "Not an upload action" }, 405);
}

/**
 * A request handler for the browser module's protocol, mounted at any path
 * (e.g. `/api/uploads` and everything under it):
 *
 *   POST   <base>                     { name, size, type } → open (authorize decides)
 *   GET    <base>/<upload_id>         read state (parts_done from storage)
 *   POST   <base>/<upload_id>/urls    { part_numbers? } → fresh part URLs
 *   POST   <base>/<upload_id>/complete
 *   DELETE <base>/<upload_id>
 *
 * Invoked as the upload's completion run (`X-Run402-Trigger: function_run`,
 * event `asset_upload.completed` / `asset_upload.failed`), it calls
 * `onComplete` / `onFailed`.
 */
export function handler(opts: UploadsHandlerOptions): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    try {
      if (req.headers.get("x-run402-trigger") === "function_run") {
        const probe = await req.clone().json().catch(() => null);
        if (isFunctionRun(probe) && String((probe as { event_type?: string }).event_type).startsWith("asset_upload.")) {
          return await handleCompletionRun(opts, req);
        }
      }
      const owner = await opts.identify(req);
      if (!owner) return json({ code: "AUTH_REQUIRED", message: "Sign in to upload" }, 401);
      const [id, action] = routeOf(req.url);
      if (!id) {
        if (req.method !== "POST") return json({ code: "METHOD_NOT_ALLOWED", message: "POST to open an upload" }, 405);
        return await handleOpen(opts, req, owner);
      }
      return await handleExisting(req, owner, id, action);
    } catch (err) {
      return errorResponse(err);
    }
  };
}

export const uploads = { handler };
