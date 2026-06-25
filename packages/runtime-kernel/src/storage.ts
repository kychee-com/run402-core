import { createHmac, timingSafeEqual } from "node:crypto";

export const CORE_STORAGE_KEY_MAX_LENGTH = 1024;
export const DEFAULT_SIGNED_READ_TTL_SECONDS = 15 * 60;
export const MAX_SIGNED_READ_TTL_SECONDS = 24 * 60 * 60;

const CONTROL_RE = /[\x00-\x1f\x7f]/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const ENCODED_SEPARATOR_RE = /%(?:2f|5c)/i;
const SAFE_KEY_RE = /^[a-zA-Z0-9._/\-]+$/;

export class StorageValidationError extends Error {
  readonly status = 400;

  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "StorageValidationError";
  }
}

export function storageErrorEnvelope(error: StorageValidationError): {
  error: string;
  message: string;
  details?: Record<string, unknown>;
} {
  return {
    error: error.code,
    message: error.message,
    ...(Object.keys(error.details).length > 0 ? { details: error.details } : {}),
  };
}

export function normalizeStorageKey(value: unknown): string {
  if (typeof value !== "string") {
    throw new StorageValidationError("invalid_storage_key", "Storage key must be a string.");
  }
  if (value.length === 0) {
    throw new StorageValidationError("invalid_storage_key", "Storage key must be non-empty.");
  }
  if (value.length > CORE_STORAGE_KEY_MAX_LENGTH) {
    throw new StorageValidationError("invalid_storage_key", "Storage key is too long.", {
      max_length: CORE_STORAGE_KEY_MAX_LENGTH,
    });
  }
  if (value.startsWith("/") || value.endsWith("/")) {
    throw new StorageValidationError("invalid_storage_key", "Storage key must not start or end with '/'.");
  }
  if (value.includes("\\") || ENCODED_SEPARATOR_RE.test(value)) {
    throw new StorageValidationError("invalid_storage_key", "Storage key must not contain slash or backslash escapes.");
  }
  if (CONTROL_RE.test(value)) {
    throw new StorageValidationError("invalid_storage_key", "Storage key must not contain control characters.");
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new StorageValidationError("invalid_storage_key", "Storage key contains malformed percent encoding.");
  }
  const normalized = decoded.normalize("NFC");
  if (normalized.includes("\\") || CONTROL_RE.test(normalized)) {
    throw new StorageValidationError("invalid_storage_key", "Storage key decodes to an unsafe path.");
  }
  if (!SAFE_KEY_RE.test(normalized)) {
    throw new StorageValidationError(
      "invalid_storage_key",
      "Storage key may only contain alphanumerics, '.', '_', '-', and '/'.",
    );
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => segment.length === 0)) {
    throw new StorageValidationError("invalid_storage_key", "Storage key must not contain empty path segments.");
  }
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new StorageValidationError("invalid_storage_key", "Storage key must not contain dot segments.");
  }
  if (
    normalized === "_cas" ||
    normalized.startsWith("_cas/") ||
    normalized === "_staging" ||
    normalized.startsWith("_staging/") ||
    normalized === "_run402" ||
    normalized.startsWith("_run402/")
  ) {
    throw new StorageValidationError("invalid_storage_key", "Storage key uses an internal Run402 namespace.");
  }
  return normalized;
}

export function normalizeStoragePrefix(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") {
    throw new StorageValidationError("invalid_storage_prefix", "Storage prefix must be a string.");
  }
  if (value.startsWith("/")) {
    throw new StorageValidationError("invalid_storage_prefix", "Storage prefix must not start with '/'.");
  }
  if (value.endsWith("/")) {
    return `${normalizeStorageKey(`${value}__run402_prefix_probe__`).slice(0, -"__run402_prefix_probe__".length)}`;
  }
  return normalizeStorageKey(value);
}

export function encodeStorageKeyPath(key: string): string {
  return key.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

export function normalizeStorageVisibility(value: unknown): "public" | "private" {
  if (value === undefined || value === null) return "public";
  if (value === "public" || value === "private") return value;
  throw new StorageValidationError("invalid_visibility", "Storage visibility must be 'public' or 'private'.");
}

export function normalizeStorageContentType(value: unknown): string {
  if (value === undefined || value === null || value === "") return "application/octet-stream";
  if (typeof value !== "string") {
    throw new StorageValidationError("invalid_content_type", "Content type must be a string.");
  }
  const trimmed = value.trim();
  if (!trimmed || CONTROL_RE.test(trimmed) || !trimmed.includes("/")) {
    throw new StorageValidationError("invalid_content_type", "Content type must be a MIME type.");
  }
  return trimmed;
}

export function normalizeSha256Hex(value: unknown): string {
  if (typeof value !== "string" || !SHA256_RE.test(value)) {
    throw new StorageValidationError("invalid_sha256", "SHA-256 must be lowercase 64-character hex.");
  }
  return value;
}

export function normalizeStorageSize(value: unknown, maxBytes: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new StorageValidationError("invalid_size", "size_bytes must be a positive integer.");
  }
  if (value > maxBytes) {
    throw new StorageValidationError("size_too_large", "Object exceeds the local Core upload limit.", {
      max_bytes: maxBytes,
    });
  }
  return value;
}

export function clampSignedReadTtlSeconds(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_SIGNED_READ_TTL_SECONDS;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    throw new StorageValidationError("invalid_ttl", "ttl_seconds must be a positive number.");
  }
  return Math.min(Math.floor(value), MAX_SIGNED_READ_TTL_SECONDS);
}

export function createStorageReadSignature(input: {
  secret: string;
  projectId: string;
  key: string;
  expiresAtEpochSeconds: number;
  sha256?: string | null;
}): string {
  const payload = storageSignaturePayload(input);
  return createHmac("sha256", input.secret).update(payload).digest("base64url");
}

export function verifyStorageReadSignature(input: {
  secret: string;
  projectId: string;
  key: string;
  expiresAtEpochSeconds: number;
  signature: string;
  nowEpochSeconds?: number;
  sha256?: string | null;
}): boolean {
  const now = input.nowEpochSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isFinite(input.expiresAtEpochSeconds) || input.expiresAtEpochSeconds < now) {
    return false;
  }
  const expected = createStorageReadSignature(input);
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(input.signature);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

export function computeStorageInventoryRevision(keys: readonly string[]): string {
  const canonical = JSON.stringify([...keys].sort());
  return createHmac("sha256", "run402-core-storage-inventory-v1").update(canonical).digest("hex");
}

function storageSignaturePayload(input: {
  projectId: string;
  key: string;
  expiresAtEpochSeconds: number;
  sha256?: string | null;
}): string {
  return [
    "run402-core-storage-read-v1",
    input.projectId,
    input.key,
    input.sha256 ?? "",
    String(input.expiresAtEpochSeconds),
  ].join("\n");
}
