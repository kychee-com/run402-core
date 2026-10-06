/**
 * `snapshots` namespace — the function's OWN project's restore points.
 *
 * Authorized by the function's service key against the project-scoped
 * snapshot routes (`/projects/v1/:project_id/snapshots*`). There is no
 * project id or credential argument: a function can only ever address its own
 * project. With a service key the gateway allows listing, reading, creating
 * manual snapshots, deleting manual snapshots, and planning/confirming
 * app-data restores; restoring auth identities and deleting platform
 * snapshots stay with org admins.
 *
 * `restore` never waits for the restore to finish — it can outlast a
 * function's timeout. It returns the restore handle; poll `getRestore`.
 *
 * Label and metadata live outside the project's database, so `list()` stays a
 * complete ledger of restore points after a restore.
 */

import { config } from "./config.js";

export type SnapshotKind = "manual" | "pre_migration" | "pre_restore" | "scheduled";
export type SnapshotMetadata = Record<string, string | number | boolean | string[]>;
/** `keep` restores data only; `snapshot` also re-activates the capture-time release. */
export type SnapshotReleaseMode = "keep" | "snapshot";

export interface SnapshotNextAction {
  type: string;
  message?: string;
  why?: string;
  method?: string;
  path?: string;
  command?: string;
  [key: string]: unknown;
}

export interface Snapshot {
  snapshot_id: string;
  operation_id: string;
  project_id: string;
  kind: SnapshotKind | (string & {});
  profile: string;
  status: "running" | "ready" | "failed" | "expired" | (string & {});
  manifest_sha256: string | null;
  size_bytes: number;
  live_release_id: string | null;
  captured_at: string | null;
  expires_at: string | null;
  error: unknown | null;
  created_at: string;
  updated_at: string;
  label: string | null;
  metadata: SnapshotMetadata | null;
  created_by: { credential_kind: string; principal_id: string | null };
  restore_of: { snapshot_id: string; restore_id: string } | null;
  next_actions: SnapshotNextAction[];
}

export interface SnapshotList {
  snapshots: Snapshot[];
  has_more: boolean;
  next_cursor: string | null;
}

export interface SnapshotCreateOptions {
  /** 1–120 characters after trimming, no control characters. Immutable. */
  label?: string;
  /** Flat object of string / number / boolean / string[] values, ≤ 4 KB. Never secrets. */
  metadata?: SnapshotMetadata;
}

export interface SnapshotListOptions {
  limit?: number;
  after?: string;
  kind?: SnapshotKind;
}

export interface SnapshotRestoreOptions {
  /** Must match between `restorePlan` and `restore`. Default `"keep"`. */
  release?: SnapshotReleaseMode;
}

export interface SnapshotRestorePlan {
  snapshot_id: string;
  project_id: string;
  snapshot_at: string;
  data_loss_statement: string;
  auth: { mode: string; users: number; passkeys: number; message: string };
  release: {
    mode: SnapshotReleaseMode | (string & {});
    snapshot_live_release_id: string | null;
    current_live_release_id: string | null;
    restorable: boolean;
    reason: string;
    /** `FUNCTION_VERSION_MISMATCH` names functions that keep their current code. */
    warnings: Array<{ code: string; message: string; affected: string[]; [key: string]: unknown }>;
    message: string;
  };
  target: { current_schema_slot: string; behavior: string };
  confirm: { token: string; expires_at: string };
  next_actions: SnapshotNextAction[];
}

export interface SnapshotRestoreHandle {
  operation_id: string;
  restore_id: string;
  project_id: string;
  snapshot_id: string;
  release_mode: SnapshotReleaseMode | (string & {});
  include_auth: boolean;
  status: "running";
  retry_after_seconds: number;
  next_actions: SnapshotNextAction[];
}

export interface SnapshotRestoreResult {
  operation_id: string;
  restore_id: string;
  project_id: string;
  snapshot_id: string;
  pre_restore_snapshot_id: string;
  old_schema_slot: string;
  new_schema_slot: string;
  migration_registry_rows: number;
  invalidated_plan_count: number;
  release_mode: SnapshotReleaseMode | (string & {});
  live_release_id: string | null;
  edge?: Record<string, unknown>;
  message: string;
  status: "ready";
  next_actions: SnapshotNextAction[];
}

export interface SnapshotRestoreStatus {
  operation_id: string;
  restore_id: string;
  project_id: string;
  snapshot_id: string;
  status: "running" | "ready" | "failed" | (string & {});
  release_mode: SnapshotReleaseMode | (string & {});
  include_auth: boolean;
  pre_restore_snapshot_id: string | null;
  live_release_id: string | null;
  started_at: string;
  completed_at: string | null;
  updated_at: string;
  error: { code: string; message: string } | null;
  /** When `ready`: the full restore result. */
  result: SnapshotRestoreResult | null;
  next_actions: SnapshotNextAction[];
}

/**
 * A snapshots call failed. `code` is the gateway's code (for example
 * `SNAPSHOT_MANUAL_CAP_EXCEEDED`, `STALE_RESTORE_CONFIRMATION`,
 * `SNAPSHOT_RESTORE_IN_PROGRESS`), a local validation code
 * (`VALIDATION_FAILED` with `field`), or `SNAPSHOTS_UNSUPPORTED` when the host
 * serving this function has no snapshot routes (Run402 Core).
 */
export class R402SnapshotsError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly details: Record<string, unknown> | null;
  readonly next_actions: SnapshotNextAction[];
  /** Local validation failures name the offending input, e.g. `metadata.nested`. */
  readonly field: string | null;
  readonly body: unknown;

  constructor(
    code: string,
    message: string,
    fields: {
      status?: number | null;
      details?: Record<string, unknown> | null;
      next_actions?: SnapshotNextAction[];
      field?: string | null;
      body?: unknown;
    } = {},
  ) {
    super(message);
    this.name = "R402SnapshotsError";
    this.code = code;
    this.status = fields.status ?? null;
    this.details = fields.details ?? null;
    this.next_actions = fields.next_actions ?? [];
    this.field = fields.field ?? null;
    this.body = fields.body;
  }
}

const LABEL_MAX_CHARS = 120;
const METADATA_MAX_BYTES = 4096;
// C0 + DEL + C1 control characters.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

function invalid(field: string, message: string): R402SnapshotsError {
  return new R402SnapshotsError("VALIDATION_FAILED", `${field}: ${message}`, { field });
}

function validateLabel(input: unknown): string | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== "string") throw invalid("label", "must be a string");
  const label = input.trim();
  if (label.length === 0) throw invalid("label", "must not be empty");
  if ([...label].length > LABEL_MAX_CHARS) throw invalid("label", `must be at most ${LABEL_MAX_CHARS} characters`);
  if (CONTROL_CHARS.test(label)) throw invalid("label", "must not contain control characters");
  return label;
}

/** The asset-metadata rules: flat, string | number | boolean | string[] values, ≤ 4 KB. */
function validateMetadata(input: unknown): SnapshotMetadata | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw invalid("metadata", "must be a flat JSON object");
  }
  const out: SnapshotMetadata = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (key.length === 0) throw invalid("metadata", "keys must be non-empty strings");
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (typeof item !== "string") throw invalid(`metadata.${key}`, `[${i}] must be a string`);
      });
      out[key] = value as string[];
    } else if (typeof value === "object") {
      throw invalid(`metadata.${key}`, "must not be a nested object (flat shape only)");
    } else if (typeof value === "number") {
      if (!Number.isFinite(value)) throw invalid(`metadata.${key}`, "number value must be finite");
      out[key] = value;
    } else if (typeof value === "string" || typeof value === "boolean") {
      out[key] = value;
    } else {
      throw invalid(`metadata.${key}`, `has unsupported value type ${typeof value}`);
    }
  }
  const bytes = new TextEncoder().encode(JSON.stringify(out)).byteLength;
  if (bytes > METADATA_MAX_BYTES) {
    throw invalid("metadata", `serialized size ${bytes} bytes exceeds the ${METADATA_MAX_BYTES}-byte cap`);
  }
  return out;
}

function validateRelease(input: unknown): SnapshotReleaseMode | undefined {
  if (input === undefined) return undefined;
  if (input === "keep" || input === "snapshot") return input;
  throw invalid("release", `must be "keep" or "snapshot"; got ${JSON.stringify(input)}`);
}

function requireId(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw invalid(field, "must be a non-empty string");
  return value;
}

function collectionPath(): string {
  const projectId = config.PROJECT_ID;
  if (!projectId) {
    throw new R402SnapshotsError(
      "PROJECT_ID_MISSING",
      "snapshots: RUN402_PROJECT_ID is not set; this helper runs inside a deployed function (or set it for local runs)",
    );
  }
  return `/projects/v1/${encodeURIComponent(projectId)}/snapshots`;
}

/** Cloud's catch-all for an unmatched route is `404 { code: "RESOURCE_NOT_FOUND", message: "Cannot GET /…" }`. */
function looksLikeMissingRoute(status: number, body: unknown): boolean {
  if (status === 405 || status === 501) return true;
  if (status !== 404) return false;
  if (!body || typeof body !== "object") return true;
  const obj = body as Record<string, unknown>;
  if (typeof obj.code !== "string") return true;
  const message = typeof obj.message === "string" ? obj.message : typeof obj.error === "string" ? obj.error : "";
  return /^Cannot (GET|POST|DELETE|PUT|PATCH) \//.test(message);
}

async function request<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
  const res = await fetch(config.API_BASE + path, {
    method,
    headers: {
      Authorization: "Bearer " + config.SERVICE_KEY,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (res.ok) return parsed as T;
  if (looksLikeMissingRoute(res.status, parsed)) {
    throw new R402SnapshotsError(
      "SNAPSHOTS_UNSUPPORTED",
      "snapshots: this host does not support project snapshots (Run402 Cloud does; Run402 Core does not)",
      { status: res.status, body: parsed },
    );
  }
  const obj = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  const code = typeof obj.code === "string" ? obj.code : `HTTP_${res.status}`;
  const message =
    typeof obj.message === "string" ? obj.message : typeof obj.error === "string" ? obj.error : `HTTP ${res.status}`;
  throw new R402SnapshotsError(code, `snapshots: ${message}`, {
    status: res.status,
    details: obj.details && typeof obj.details === "object" ? (obj.details as Record<string, unknown>) : null,
    next_actions: Array.isArray(obj.next_actions) ? (obj.next_actions as SnapshotNextAction[]) : [],
    body: parsed,
  });
}

export const snapshots = {
  /** Create a manual snapshot (counts toward the project's manual-snapshot cap of 20). */
  async create(opts: SnapshotCreateOptions = {}): Promise<Snapshot> {
    const label = validateLabel(opts.label);
    const metadata = validateMetadata(opts.metadata);
    return request<Snapshot>("POST", collectionPath(), {
      ...(label !== undefined ? { label } : {}),
      ...(metadata !== undefined && Object.keys(metadata).length > 0 ? { metadata } : {}),
    });
  },

  async list(opts: SnapshotListOptions = {}): Promise<SnapshotList> {
    const qs = new URLSearchParams();
    if (opts.limit !== undefined) qs.set("limit", String(opts.limit));
    if (opts.after !== undefined) qs.set("after", opts.after);
    if (opts.kind !== undefined) qs.set("kind", opts.kind);
    const query = qs.toString();
    return request<SnapshotList>("GET", `${collectionPath()}${query ? `?${query}` : ""}`);
  },

  async get(snapshotId: string): Promise<Snapshot> {
    return request<Snapshot>("GET", `${collectionPath()}/${encodeURIComponent(requireId(snapshotId, "snapshotId"))}`);
  },

  /** Delete a manual snapshot. Platform snapshots are refused (`SNAPSHOT_KIND_NOT_DELETABLE_BY_SERVICE_KEY`). */
  async delete(snapshotId: string): Promise<void> {
    await request<void>("DELETE", `${collectionPath()}/${encodeURIComponent(requireId(snapshotId, "snapshotId"))}`);
  },

  /** Plan a restore without mutating anything; show `data_loss_statement` before confirming. */
  async restorePlan(snapshotId: string, opts: SnapshotRestoreOptions = {}): Promise<SnapshotRestorePlan> {
    const release = validateRelease(opts.release);
    const envelope = await request<{ restore_plan: SnapshotRestorePlan }>(
      "POST",
      `${collectionPath()}/${encodeURIComponent(requireId(snapshotId, "snapshotId"))}/restore`,
      release !== undefined ? { release } : {},
    );
    return envelope.restore_plan;
  },

  /**
   * Confirm a restore of app data. Returns the restore handle at once; the
   * restore runs on the gateway and `getRestore` reports its outcome. Pass the
   * same `release` the plan used.
   */
  async restore(snapshotId: string, confirm: string, opts: SnapshotRestoreOptions = {}): Promise<SnapshotRestoreHandle> {
    const release = validateRelease(opts.release);
    return request<SnapshotRestoreHandle>(
      "POST",
      `${collectionPath()}/${encodeURIComponent(requireId(snapshotId, "snapshotId"))}/restore`,
      { confirm: requireId(confirm, "confirm"), wait: false, ...(release !== undefined ? { release } : {}) },
    );
  },

  async getRestore(snapshotId: string, restoreId: string): Promise<SnapshotRestoreStatus> {
    return request<SnapshotRestoreStatus>(
      "GET",
      `${collectionPath()}/${encodeURIComponent(requireId(snapshotId, "snapshotId"))}/restores/${encodeURIComponent(requireId(restoreId, "restoreId"))}`,
    );
  },
};
