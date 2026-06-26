import { createHash } from "node:crypto";
import { lstat, opendir, readFile } from "node:fs/promises";
import path from "node:path";

import { canonicalizeJson } from "@run402/release";

import { RuntimeKernelTypedError, type RuntimeKernelTypedErrorDetails } from "./errors.js";

export const PROJECT_ARCHIVE_VERSION = "run402-project-archive.v1" as const;
export const PROJECT_ARCHIVE_LAYOUT_SCHEMA_VERSION = "run402.project_archive.layout.v1" as const;
export const PROJECT_ARCHIVE_INDEX_SCHEMA_VERSION = "run402.project_archive.index.v1" as const;
export const PROJECT_ARCHIVE_DIGEST_IDENTITY = "run402-project-archive-logical-v1" as const;
export const PROJECT_ARCHIVE_DEFAULT_EXTENSION = ".r402ar" as const;

export const PROJECT_ARCHIVE_TRANSPORTS = ["directory", "tar"] as const;
export type PortableArchiveTransport = (typeof PROJECT_ARCHIVE_TRANSPORTS)[number];

export const PROJECT_ARCHIVE_MEDIA_TYPES = {
  layout: "application/vnd.run402.project-archive.layout.v1+json",
  index: "application/vnd.run402.project-archive.index.v1+json",
  descriptor: "application/vnd.run402.project-archive.descriptor.v1+json",
  exportReport: "application/vnd.run402.project-archive.export-report.v1+json",
  portabilityReport: "application/vnd.run402.project-archive.portability-report.v1+json",
  consistency: "application/vnd.run402.project-archive.consistency.v1+json",
  databaseTables: "application/vnd.run402.project-archive.database-tables.v1+json",
  databaseSequences: "application/vnd.run402.project-archive.database-sequences.v1+json",
  databaseSql: "application/sql; dialect=postgresql",
  databaseCopy: "application/vnd.postgresql.copy.text",
  authConfig: "application/vnd.run402.project-archive.auth-config.v1+json",
  authSubjects: "application/x-ndjson; profile=run402-auth-subject-stubs-v1",
  storageIndex: "application/vnd.run402.project-archive.storage-index.v1+json",
  runtimeIndex: "application/vnd.run402.project-archive.runtime-index.v1+json",
  secretRequirements: "application/vnd.run402.project-archive.secret-requirements.v1+json",
  envTemplate: "text/plain; profile=run402-required-env-template-v1",
  releaseSpec: "application/vnd.run402.release-spec.v1+json",
  portableReleaseState: "application/vnd.run402.portable-release-state.v1+json",
  releaseFactSet: "application/vnd.run402.release-fact-set.v1+json",
  blob: "application/octet-stream",
} as const;

export const SUPPORTED_ARCHIVE_CAPABILITIES = [
  "run402.core.release-state.v1",
  "run402.core.database.phased-postgres-copy.v1",
  "run402.core.storage.cas.v1",
  "run402.core.functions.node22.v1",
  "run402.core.astro-ssr.v1",
  "run402.core.auth-stubs.v1",
  "run402.core.secret-requirements.v1",
] as const;

export const ARCHIVE_ERROR_CODES = [
  "EXPORT_CONSISTENCY_UNAVAILABLE",
  "EXPORT_SCOPE_UNSUPPORTED",
  "ARCHIVE_EXPIRED",
  "ARCHIVE_DIGEST_MISMATCH",
  "ARCHIVE_SIZE_MISMATCH",
  "ARCHIVE_UNSUPPORTED_VERSION",
  "ARCHIVE_UNSUPPORTED_REQUIRED_CAPABILITY",
  "ARCHIVE_MEDIA_TYPE_UNSUPPORTED",
  "ARCHIVE_PATH_UNSAFE",
  "ARCHIVE_SIZE_LIMIT_EXCEEDED",
  "ARCHIVE_FILE_COUNT_LIMIT_EXCEEDED",
  "ARCHIVE_DESCRIPTOR_TOO_DEEP",
  "ARCHIVE_DESCRIPTOR_MISSING",
  "ARCHIVE_BLOB_MISSING",
  "ARCHIVE_DUPLICATE_PATH",
  "ARCHIVE_DUPLICATE_JSON_KEY",
  "ARCHIVE_MALFORMED_JSON",
  "ARCHIVE_MALFORMED_TAR",
  "ARCHIVE_ENTRY_TYPE_UNSUPPORTED",
  "DATABASE_EXTENSION_UNSUPPORTED",
  "DATABASE_RLS_IMPORT_UNSUPPORTED",
  "DATABASE_SCHEMA_UNSAFE",
  "DATABASE_SEQUENCE_RESTORE_FAILED",
  "STORAGE_OBJECT_CHANGED_DURING_EXPORT",
  "STORAGE_OBJECT_DIGEST_MISMATCH",
  "AUTH_CREDENTIALS_NOT_EXPORTED",
  "AUTH_SUBJECT_STUBS_IMPORTED",
  "SECRET_VALUES_REQUIRED",
  "CLOUD_ONLY_FEATURE_EXCLUDED",
  "PROJECT_ALREADY_EXISTS",
  "IMPORT_VERIFY_FAILED",
  "IMPORT_CONFORMANCE_FAILED",
] as const;

export type ArchiveErrorCode = (typeof ARCHIVE_ERROR_CODES)[number];

export const PORTABILITY_REPORT_SEVERITIES = ["info", "warning", "blocking"] as const;
export type PortabilityReportSeverity = (typeof PORTABILITY_REPORT_SEVERITIES)[number];

export const ARCHIVE_NEXT_ACTION_TYPES = [
  "run_command",
  "set_secret",
  "change_export_scope",
  "remove_unsupported_feature",
  "retry_later",
  "contact_support",
  "read_docs",
  "none",
] as const;

export type ArchiveNextActionType = (typeof ARCHIVE_NEXT_ACTION_TYPES)[number];

export interface ArchiveNextAction {
  type: ArchiveNextActionType;
  command?: string;
  env_var?: string;
  docs_url?: string;
  message?: string;
}

export interface ArchiveDiagnostic {
  code: ArchiveErrorCode;
  severity: PortabilityReportSeverity;
  resource_type: string;
  resource_id?: string;
  path?: string;
  message: string;
  next_action: ArchiveNextAction;
  retryable: boolean;
  context?: Record<string, unknown>;
}

export interface PortableArchiveDescriptor {
  mediaType: string;
  digest: `sha256:${string}`;
  size: number;
  path?: string;
  annotations?: Record<string, string>;
}

export interface PortableArchiveConsistencyDescriptor {
  mode: "cloud_write_pause_v1" | "core_fixture_v1";
  pinned_release_id?: string | null;
  started_at?: string;
  completed_at?: string;
  database?: {
    postgres_version?: string;
    snapshot?: string | null;
    wal_lsn?: string | null;
  };
  storage?: {
    mutation_pause: "not_applicable" | "paused" | "unavailable";
  };
  runtime?: {
    artifact_capture: "captured" | "not_applicable" | "unavailable";
  };
}

export interface PortableArchiveIndex {
  schema_version: typeof PROJECT_ARCHIVE_INDEX_SCHEMA_VERSION;
  archive_version: typeof PROJECT_ARCHIVE_VERSION;
  mediaType: typeof PROJECT_ARCHIVE_MEDIA_TYPES.index;
  archive_digest?: `sha256:${string}`;
  core_compatibility: {
    runtime_kernel: string;
    release_spec: string;
  };
  source: {
    platform: "run402-cloud" | "run402-core" | "run402-core-fixture";
    label?: string;
  };
  required_capabilities: string[];
  identity_descriptors: string[];
  descriptors: Record<string, PortableArchiveDescriptor>;
  consistency?: PortableArchiveConsistencyDescriptor;
  annotations?: Record<string, string>;
}

export interface PortableArchiveLayout {
  schema_version: typeof PROJECT_ARCHIVE_LAYOUT_SCHEMA_VERSION;
  archive_version: typeof PROJECT_ARCHIVE_VERSION;
  mediaType: typeof PROJECT_ARCHIVE_MEDIA_TYPES.layout;
  index: "index.json";
  blobs: "blobs/sha256";
  transports: PortableArchiveTransport[];
  checksum_lists_authoritative: false;
}

export interface ArchiveSecretRequirement {
  name: string;
  required: boolean;
  targets?: string[];
  description?: string;
}

export interface ArchivePortabilityReportEntry extends ArchiveDiagnostic {
  resource_id?: string;
}

export interface ArchivePortabilityReport {
  schema_version: "run402.project_archive.portability_report.v1";
  entries: ArchivePortabilityReportEntry[];
}

export interface ArchiveExportReport {
  schema_version: "run402.project_archive.export_report.v1";
  export_scope: "portable-runtime-v1";
  auth_export: "none" | "stubs";
  consistency: "cloud_write_pause_v1" | "core_fixture_v1";
  omitted_sensitive_resource_count?: number;
  unsupported_resource_count?: number;
}

export interface PortableArchiveLimits {
  maxFiles: number;
  maxExpandedBytes: number;
  maxFileBytes: number;
  maxDescriptorBytes: number;
  maxDescriptorDepth: number;
}

export interface PortableArchiveVerifyInput {
  archivePath: string;
  limits?: Partial<PortableArchiveLimits>;
}

export interface PortableArchiveVerifyResult {
  ok: boolean;
  archive_version: typeof PROJECT_ARCHIVE_VERSION | null;
  archive_digest: `sha256:${string}` | null;
  transport: PortableArchiveTransport | null;
  file_count: number;
  total_bytes: number;
  descriptor_count: number;
  required_capabilities: string[];
  required_secrets: ArchiveSecretRequirement[];
  auth_subject_stub_count: number;
  export_report: ArchiveExportReport | null;
  portability_report: ArchivePortabilityReport | null;
  diagnostics: ArchiveDiagnostic[];
}

export class PortableArchiveError extends RuntimeKernelTypedError {
  constructor(code: ArchiveErrorCode, message: string, details: RuntimeKernelTypedErrorDetails = {}) {
    super(code, 422, message, details);
    this.name = "PortableArchiveError";
  }
}

interface ArchiveEntries {
  entries: Map<string, Uint8Array>;
  transport: PortableArchiveTransport;
  totalBytes: number;
}

interface JsonParseFailure extends Error {
  code: "ARCHIVE_DUPLICATE_JSON_KEY" | "ARCHIVE_MALFORMED_JSON";
  details?: Record<string, unknown>;
}

const DEFAULT_ARCHIVE_LIMITS: PortableArchiveLimits = {
  maxFiles: 20_000,
  maxExpandedBytes: 512 * 1024 * 1024,
  maxFileBytes: 128 * 1024 * 1024,
  maxDescriptorBytes: 2 * 1024 * 1024,
  maxDescriptorDepth: 64,
};

const UTF8 = new TextDecoder("utf-8", { fatal: true });
const SHA256_DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const TAR_BLOCK_BYTES = 512;
const CONTROL_RE = /[\x00-\x1f\x7f]/;
const SUPPORTED_MEDIA_TYPES = new Set<string>(Object.values(PROJECT_ARCHIVE_MEDIA_TYPES));
const SUPPORTED_CAPABILITY_SET = new Set<string>(SUPPORTED_ARCHIVE_CAPABILITIES);

export function canonicalizePortableArchiveJson(value: unknown): string {
  return canonicalizeJson(value);
}

export function computePortableArchiveBytesDigest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function computePortableArchiveJsonDigest(value: unknown): `sha256:${string}` {
  return computePortableArchiveBytesDigest(Buffer.from(canonicalizePortableArchiveJson(value), "utf8"));
}

export function computePortableArchiveLogicalDigest(index: PortableArchiveIndex): `sha256:${string}` {
  const descriptors = [...index.identity_descriptors].sort().map((name) => {
    const descriptor = index.descriptors[name];
    return {
      name,
      mediaType: descriptor?.mediaType,
      digest: descriptor?.digest,
      size: descriptor?.size,
      path: descriptor?.path,
    };
  });
  return computePortableArchiveJsonDigest({
    identity: PROJECT_ARCHIVE_DIGEST_IDENTITY,
    archive_version: index.archive_version,
    core_compatibility: index.core_compatibility,
    required_capabilities: [...index.required_capabilities].sort(),
    consistency: index.consistency ?? null,
    descriptors,
  });
}

export async function inspectPortableArchive(input: PortableArchiveVerifyInput): Promise<PortableArchiveVerifyResult> {
  return verifyPortableArchive(input);
}

export async function verifyPortableArchive(input: PortableArchiveVerifyInput): Promise<PortableArchiveVerifyResult> {
  const limits = { ...DEFAULT_ARCHIVE_LIMITS, ...(input.limits ?? {}) };
  const diagnostics: ArchiveDiagnostic[] = [];
  let archive: ArchiveEntries;

  try {
    archive = await readArchiveEntries(input.archivePath, limits);
  } catch (error) {
    return emptyVerifyResult(errorToDiagnostic(error), null);
  }

  const layout = parseJsonEntry<PortableArchiveLayout>(archive, "run402-layout.json", diagnostics, limits);
  const index = parseJsonEntry<PortableArchiveIndex>(archive, "index.json", diagnostics, limits);
  let archiveDigest: `sha256:${string}` | null = null;
  let requiredSecrets: ArchiveSecretRequirement[] = [];
  let authSubjectStubCount = 0;
  let exportReport: ArchiveExportReport | null = null;
  let portabilityReport: ArchivePortabilityReport | null = null;

  if (layout) {
    validateLayout(layout, diagnostics);
  }
  if (index) {
    validateIndex(index, diagnostics);
    verifyRequiredCapabilities(index, diagnostics);
    verifyDescriptors(index, archive, diagnostics, limits);
    archiveDigest = computePortableArchiveLogicalDigest(index);
    if (index.archive_digest && index.archive_digest !== archiveDigest) {
      diagnostics.push(diagnostic({
        code: "ARCHIVE_DIGEST_MISMATCH",
        path: "index.json",
        resourceType: "archive",
        message: `Archive logical digest mismatch: expected ${index.archive_digest}, computed ${archiveDigest}.`,
        context: { expected_digest: index.archive_digest, actual_digest: archiveDigest },
      }));
    }

    exportReport = parseOptionalJsonDescriptor<ArchiveExportReport>(index, archive, "export_report", diagnostics, limits);
    portabilityReport = parseOptionalJsonDescriptor<ArchivePortabilityReport>(
      index,
      archive,
      "portability_report",
      diagnostics,
      limits,
    );
    const secretRequirements = parseOptionalJsonDescriptor<{ secrets?: ArchiveSecretRequirement[] }>(
      index,
      archive,
      "secret_requirements",
      diagnostics,
      limits,
    );
    requiredSecrets = Array.isArray(secretRequirements?.secrets)
      ? secretRequirements.secrets.filter(isArchiveSecretRequirement)
      : [];
    authSubjectStubCount = countAuthSubjectStubs(index, archive, diagnostics, limits);
    diagnostics.push(...portabilityDiagnostics(portabilityReport));
  } else {
    diagnostics.push(diagnostic({
      code: "ARCHIVE_DESCRIPTOR_MISSING",
      path: "index.json",
      resourceType: "archive",
      message: "Portable archive is missing index.json.",
    }));
  }

  const blocking = diagnostics.some((entry) => entry.severity === "blocking");
  return {
    ok: !blocking,
    archive_version: index?.archive_version === PROJECT_ARCHIVE_VERSION ? PROJECT_ARCHIVE_VERSION : null,
    archive_digest: archiveDigest,
    transport: archive.transport,
    file_count: archive.entries.size,
    total_bytes: archive.totalBytes,
    descriptor_count: index ? Object.keys(index.descriptors ?? {}).length : 0,
    required_capabilities: Array.isArray(index?.required_capabilities) ? index.required_capabilities : [],
    required_secrets: requiredSecrets,
    auth_subject_stub_count: authSubjectStubCount,
    export_report: exportReport,
    portability_report: portabilityReport,
    diagnostics,
  };
}

function validateLayout(layout: PortableArchiveLayout, diagnostics: ArchiveDiagnostic[]): void {
  if (layout.schema_version !== PROJECT_ARCHIVE_LAYOUT_SCHEMA_VERSION || layout.archive_version !== PROJECT_ARCHIVE_VERSION) {
    diagnostics.push(diagnostic({
      code: "ARCHIVE_UNSUPPORTED_VERSION",
      path: "run402-layout.json",
      resourceType: "layout",
      message: "Archive layout version is not supported by this Core runtime.",
      context: {
        schema_version: (layout as { schema_version?: unknown }).schema_version,
        archive_version: (layout as { archive_version?: unknown }).archive_version,
      },
    }));
  }
  if (layout.mediaType !== PROJECT_ARCHIVE_MEDIA_TYPES.layout) {
    diagnostics.push(diagnostic({
      code: "ARCHIVE_MEDIA_TYPE_UNSUPPORTED",
      path: "run402-layout.json",
      resourceType: "layout",
      message: "Archive layout media type is not supported.",
      context: { mediaType: (layout as { mediaType?: unknown }).mediaType },
    }));
  }
  if (layout.index !== "index.json" || layout.blobs !== "blobs/sha256" || layout.checksum_lists_authoritative !== false) {
    diagnostics.push(diagnostic({
      code: "ARCHIVE_UNSUPPORTED_REQUIRED_CAPABILITY",
      path: "run402-layout.json",
      resourceType: "layout",
      message: "Archive layout uses an unsupported root or authoritative checksum-list mode.",
    }));
  }
}

function validateIndex(index: PortableArchiveIndex, diagnostics: ArchiveDiagnostic[]): void {
  if (index.schema_version !== PROJECT_ARCHIVE_INDEX_SCHEMA_VERSION || index.archive_version !== PROJECT_ARCHIVE_VERSION) {
    diagnostics.push(diagnostic({
      code: "ARCHIVE_UNSUPPORTED_VERSION",
      path: "index.json",
      resourceType: "index",
      message: "Archive index version is not supported by this Core runtime.",
      context: {
        schema_version: (index as { schema_version?: unknown }).schema_version,
        archive_version: (index as { archive_version?: unknown }).archive_version,
      },
    }));
  }
  if (index.mediaType !== PROJECT_ARCHIVE_MEDIA_TYPES.index) {
    diagnostics.push(diagnostic({
      code: "ARCHIVE_MEDIA_TYPE_UNSUPPORTED",
      path: "index.json",
      resourceType: "index",
      message: "Archive index media type is not supported.",
      context: { mediaType: (index as { mediaType?: unknown }).mediaType },
    }));
  }
  if (!Array.isArray(index.identity_descriptors) || !isRecord(index.descriptors)) {
    diagnostics.push(diagnostic({
      code: "ARCHIVE_MALFORMED_JSON",
      path: "index.json",
      resourceType: "index",
      message: "Archive index must contain identity_descriptors and descriptors.",
    }));
    return;
  }
  for (const name of index.identity_descriptors) {
    if (typeof name !== "string" || !index.descriptors[name]) {
      diagnostics.push(diagnostic({
        code: "ARCHIVE_DESCRIPTOR_MISSING",
        path: "index.json",
        resourceType: "descriptor",
        resourceId: typeof name === "string" ? name : undefined,
        message: "Archive identity descriptor is not present in descriptors.",
      }));
    }
  }
}

function verifyRequiredCapabilities(index: PortableArchiveIndex, diagnostics: ArchiveDiagnostic[]): void {
  if (!Array.isArray(index.required_capabilities)) {
    diagnostics.push(diagnostic({
      code: "ARCHIVE_MALFORMED_JSON",
      path: "index.json",
      resourceType: "capability",
      message: "Archive required_capabilities must be an array.",
    }));
    return;
  }

  for (const capability of index.required_capabilities) {
    if (typeof capability !== "string" || !SUPPORTED_CAPABILITY_SET.has(capability)) {
      diagnostics.push(diagnostic({
        code: "ARCHIVE_UNSUPPORTED_REQUIRED_CAPABILITY",
        path: "index.json",
        resourceType: "capability",
        resourceId: typeof capability === "string" ? capability : undefined,
        message: `Archive requires unsupported capability: ${String(capability)}.`,
        nextAction: {
          type: "read_docs",
          message: "Use a newer Run402 Core runtime or export a narrower supported archive slice.",
        },
      }));
    }
  }
}

function verifyDescriptors(
  index: PortableArchiveIndex,
  archive: ArchiveEntries,
  diagnostics: ArchiveDiagnostic[],
  limits: PortableArchiveLimits,
): void {
  for (const [name, descriptor] of Object.entries(index.descriptors ?? {})) {
    if (!isDescriptor(descriptor)) {
      diagnostics.push(diagnostic({
        code: "ARCHIVE_MALFORMED_JSON",
        path: "index.json",
        resourceType: "descriptor",
        resourceId: name,
        message: "Archive descriptor has an invalid shape.",
      }));
      continue;
    }

    if (!SUPPORTED_MEDIA_TYPES.has(descriptor.mediaType)) {
      diagnostics.push(diagnostic({
        code: "ARCHIVE_MEDIA_TYPE_UNSUPPORTED",
        path: descriptor.path ?? "index.json",
        resourceType: "descriptor",
        resourceId: name,
        message: `Archive descriptor media type is not supported: ${descriptor.mediaType}.`,
        nextAction: {
          type: "read_docs",
          message: "Use a newer Run402 Core runtime or export a narrower supported archive slice.",
        },
      }));
    }

    if (!SHA256_DIGEST_RE.test(descriptor.digest)) {
      diagnostics.push(diagnostic({
        code: "ARCHIVE_MALFORMED_JSON",
        path: descriptor.path ?? "index.json",
        resourceType: "descriptor",
        resourceId: name,
        message: "Archive descriptor digest must be sha256:<64 lowercase hex>.",
      }));
      continue;
    }

    if (descriptor.path) {
      const pathDiagnostic = validateArchivePath(descriptor.path, "descriptor", name);
      if (pathDiagnostic) {
        diagnostics.push(pathDiagnostic);
        continue;
      }
      const bytes = archive.entries.get(descriptor.path);
      if (!bytes) {
        diagnostics.push(diagnostic({
          code: descriptor.path.startsWith("blobs/sha256/") ? "ARCHIVE_BLOB_MISSING" : "ARCHIVE_DESCRIPTOR_MISSING",
          path: descriptor.path,
          resourceType: "descriptor",
          resourceId: name,
          message: `Archive descriptor path is missing: ${descriptor.path}.`,
        }));
        continue;
      }
      if (bytes.byteLength !== descriptor.size) {
        diagnostics.push(diagnostic({
          code: "ARCHIVE_SIZE_MISMATCH",
          path: descriptor.path,
          resourceType: "descriptor",
          resourceId: name,
          message: `Archive descriptor size mismatch for ${descriptor.path}.`,
          context: { expected_size: descriptor.size, actual_size: bytes.byteLength },
        }));
      }
      const actualDigest = computePortableArchiveBytesDigest(bytes);
      if (actualDigest !== descriptor.digest) {
        diagnostics.push(diagnostic({
          code: "ARCHIVE_DIGEST_MISMATCH",
          path: descriptor.path,
          resourceType: "descriptor",
          resourceId: name,
          message: `Archive descriptor digest mismatch for ${descriptor.path}.`,
          context: { expected_digest: descriptor.digest, actual_digest: actualDigest },
        }));
      }
      if (isJsonMediaType(descriptor.mediaType)) {
        const parsed = parseJsonBytes<unknown>(bytes, descriptor.path, diagnostics, limits);
        if (parsed) {
          const depth = jsonDepth(parsed);
          if (depth > limits.maxDescriptorDepth) {
            diagnostics.push(diagnostic({
              code: "ARCHIVE_DESCRIPTOR_TOO_DEEP",
              path: descriptor.path,
              resourceType: "descriptor",
              resourceId: name,
              message: `Archive descriptor JSON depth ${depth} exceeds limit ${limits.maxDescriptorDepth}.`,
              context: { depth, max_depth: limits.maxDescriptorDepth },
            }));
          }
        }
      } else if (descriptor.mediaType === PROJECT_ARCHIVE_MEDIA_TYPES.authSubjects) {
        parseNdjsonBytes(bytes, descriptor.path, diagnostics, limits);
      }
    }
  }
}

function parseOptionalJsonDescriptor<T>(
  index: PortableArchiveIndex,
  archive: ArchiveEntries,
  name: string,
  diagnostics: ArchiveDiagnostic[],
  limits: PortableArchiveLimits,
): T | null {
  const descriptor = index.descriptors[name];
  if (!descriptor?.path) return null;
  const bytes = archive.entries.get(descriptor.path);
  if (!bytes) return null;
  return parseJsonBytes<T>(bytes, descriptor.path, diagnostics, limits);
}

function countAuthSubjectStubs(
  index: PortableArchiveIndex,
  archive: ArchiveEntries,
  diagnostics: ArchiveDiagnostic[],
  limits: PortableArchiveLimits,
): number {
  const descriptor = index.descriptors["auth.subjects"];
  if (!descriptor?.path) return 0;
  const bytes = archive.entries.get(descriptor.path);
  if (!bytes) return 0;
  return parseNdjsonBytes(bytes, descriptor.path, diagnostics, limits);
}

function portabilityDiagnostics(report: ArchivePortabilityReport | null): ArchiveDiagnostic[] {
  if (!report || !Array.isArray(report.entries)) return [];
  return report.entries
    .filter((entry) => entry.severity === "blocking")
    .map((entry) => ({
      code: entry.code,
      severity: entry.severity,
      resource_type: entry.resource_type,
      ...(entry.resource_id ? { resource_id: entry.resource_id } : {}),
      ...(entry.path ? { path: entry.path } : {}),
      message: entry.message,
      next_action: entry.next_action,
      retryable: entry.retryable,
      ...(entry.context ? { context: entry.context } : {}),
    }));
}

async function readArchiveEntries(archivePath: string, limits: PortableArchiveLimits): Promise<ArchiveEntries> {
  const stats = await lstat(archivePath);
  if (stats.isSymbolicLink()) {
    throw new PortableArchiveReadError(diagnostic({
      code: "ARCHIVE_ENTRY_TYPE_UNSUPPORTED",
      path: archivePath,
      resourceType: "archive",
      message: "Archive root must not be a symbolic link.",
    }));
  }
  if (stats.isDirectory()) {
    return readDirectoryArchive(archivePath, limits);
  }
  if (stats.isFile()) {
    return readTarArchive(archivePath, limits);
  }
  throw new PortableArchiveReadError(diagnostic({
    code: "ARCHIVE_ENTRY_TYPE_UNSUPPORTED",
    path: archivePath,
    resourceType: "archive",
    message: "Archive root must be a directory or uncompressed tar file.",
  }));
}

async function readDirectoryArchive(root: string, limits: PortableArchiveLimits): Promise<ArchiveEntries> {
  const entries = new Map<string, Uint8Array>();
  let totalBytes = 0;

  async function visit(dir: string): Promise<void> {
    const handle = await opendir(dir);
    for await (const dirent of handle) {
      const absolutePath = path.join(dir, dirent.name);
      const relativePath = toArchiveRelativePath(root, absolutePath);
      const pathDiagnostic = validateArchivePath(relativePath, "file");
      if (pathDiagnostic) throw new PortableArchiveReadError(pathDiagnostic);

      const stats = await lstat(absolutePath);
      if (stats.isSymbolicLink()) {
        throw new PortableArchiveReadError(diagnostic({
          code: "ARCHIVE_ENTRY_TYPE_UNSUPPORTED",
          path: relativePath,
          resourceType: "file",
          message: "Archive entries must not be symbolic links.",
        }));
      }
      if (stats.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!stats.isFile()) {
        throw new PortableArchiveReadError(diagnostic({
          code: "ARCHIVE_ENTRY_TYPE_UNSUPPORTED",
          path: relativePath,
          resourceType: "file",
          message: "Archive entries must be regular files.",
        }));
      }
      if (stats.nlink > 1) {
        throw new PortableArchiveReadError(diagnostic({
          code: "ARCHIVE_ENTRY_TYPE_UNSUPPORTED",
          path: relativePath,
          resourceType: "file",
          message: "Archive entries must not be hardlinks.",
        }));
      }
      if (entries.has(relativePath)) {
        throw new PortableArchiveReadError(diagnostic({
          code: "ARCHIVE_DUPLICATE_PATH",
          path: relativePath,
          resourceType: "file",
          message: "Archive contains a duplicate path.",
        }));
      }
      checkArchiveLimits(entries.size + 1, totalBytes + stats.size, stats.size, relativePath, limits);
      entries.set(relativePath, await readFile(absolutePath));
      totalBytes += stats.size;
    }
  }

  await visit(root);
  return { entries, transport: "directory", totalBytes };
}

async function readTarArchive(tarPath: string, limits: PortableArchiveLimits): Promise<ArchiveEntries> {
  const tarBytes = await readFile(tarPath);
  if (tarBytes[0] === 0x1f && tarBytes[1] === 0x8b) {
    throw new PortableArchiveReadError(diagnostic({
      code: "ARCHIVE_ENTRY_TYPE_UNSUPPORTED",
      path: tarPath,
      resourceType: "tar",
      message: "Compressed archive envelopes are not supported in v1; Core verifies directory trees and uncompressed tar only.",
      nextAction: {
        type: "run_command",
        command: "tar -xf project.r402ar -C ./project.r402ar.dir && run402 archives verify ./project.r402ar.dir --json",
      },
    }));
  }
  const entries = new Map<string, Uint8Array>();
  let offset = 0;
  let totalBytes = 0;

  while (offset + TAR_BLOCK_BYTES <= tarBytes.byteLength) {
    const header = tarBytes.subarray(offset, offset + TAR_BLOCK_BYTES);
    if (isZeroBlock(header)) break;

    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const entryPath = prefix ? `${prefix}/${name}` : name;
    const typeFlag = header[156];
    const size = parseTarSize(readTarString(header, 124, 12), entryPath);
    const pathDiagnostic = validateArchivePath(entryPath, "file");
    if (pathDiagnostic) throw new PortableArchiveReadError(pathDiagnostic);

    const dataOffset = offset + TAR_BLOCK_BYTES;
    const paddedSize = Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
    const nextOffset = dataOffset + paddedSize;
    if (nextOffset > tarBytes.byteLength) {
      throw new PortableArchiveReadError(diagnostic({
        code: "ARCHIVE_MALFORMED_TAR",
        path: entryPath,
        resourceType: "tar",
        message: "Tar entry exceeds archive file length.",
      }));
    }

    if (typeFlag === 53) {
      offset = nextOffset;
      continue;
    }
    if (typeFlag !== 0 && typeFlag !== 48) {
      throw new PortableArchiveReadError(diagnostic({
        code: "ARCHIVE_ENTRY_TYPE_UNSUPPORTED",
        path: entryPath,
        resourceType: "tar",
        message: "Portable archives only support regular files and directories in tar transport.",
        context: { type_flag: String.fromCharCode(typeFlag) },
      }));
    }
    if (entries.has(entryPath)) {
      throw new PortableArchiveReadError(diagnostic({
        code: "ARCHIVE_DUPLICATE_PATH",
        path: entryPath,
        resourceType: "tar",
        message: "Tar archive contains a duplicate path.",
      }));
    }

    checkArchiveLimits(entries.size + 1, totalBytes + size, size, entryPath, limits);
    entries.set(entryPath, tarBytes.subarray(dataOffset, dataOffset + size));
    totalBytes += size;
    offset = nextOffset;
  }

  return { entries, transport: "tar", totalBytes };
}

function parseJsonEntry<T>(
  archive: ArchiveEntries,
  entryPath: string,
  diagnostics: ArchiveDiagnostic[],
  limits: PortableArchiveLimits,
): T | null {
  const bytes = archive.entries.get(entryPath);
  if (!bytes) return null;
  return parseJsonBytes<T>(bytes, entryPath, diagnostics, limits);
}

function parseJsonBytes<T>(
  bytes: Uint8Array,
  entryPath: string,
  diagnostics: ArchiveDiagnostic[],
  limits: PortableArchiveLimits,
): T | null {
  if (bytes.byteLength > limits.maxDescriptorBytes) {
    diagnostics.push(diagnostic({
      code: "ARCHIVE_SIZE_LIMIT_EXCEEDED",
      path: entryPath,
      resourceType: "descriptor",
      message: `JSON descriptor exceeds limit ${limits.maxDescriptorBytes}.`,
      context: { max_descriptor_bytes: limits.maxDescriptorBytes, actual_bytes: bytes.byteLength },
    }));
    return null;
  }
  try {
    const text = UTF8.decode(bytes);
    assertJsonHasNoDuplicateKeys(text, entryPath);
    return JSON.parse(text) as T;
  } catch (error) {
    const failure = normalizeJsonFailure(error);
    diagnostics.push(diagnostic({
      code: failure.code,
      path: entryPath,
      resourceType: "descriptor",
      message: failure.message,
      context: failure.details,
    }));
    return null;
  }
}

function parseNdjsonBytes(
  bytes: Uint8Array,
  entryPath: string,
  diagnostics: ArchiveDiagnostic[],
  limits: PortableArchiveLimits,
): number {
  if (bytes.byteLength > limits.maxDescriptorBytes) {
    diagnostics.push(diagnostic({
      code: "ARCHIVE_SIZE_LIMIT_EXCEEDED",
      path: entryPath,
      resourceType: "descriptor",
      message: `NDJSON descriptor exceeds limit ${limits.maxDescriptorBytes}.`,
    }));
    return 0;
  }
  try {
    const text = UTF8.decode(bytes);
    let count = 0;
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      assertJsonHasNoDuplicateKeys(line, entryPath);
      JSON.parse(line);
      count += 1;
    }
    return count;
  } catch (error) {
    const failure = normalizeJsonFailure(error);
    diagnostics.push(diagnostic({
      code: failure.code,
      path: entryPath,
      resourceType: "descriptor",
      message: failure.message,
      context: failure.details,
    }));
    return 0;
  }
}

function assertJsonHasNoDuplicateKeys(text: string, entryPath: string): void {
  new JsonDuplicateKeyScanner(text, entryPath).parse();
}

class JsonDuplicateKeyScanner {
  #index = 0;

  constructor(
    readonly text: string,
    readonly entryPath: string,
  ) {}

  parse(): void {
    this.#skipWhitespace();
    this.#parseValue();
    this.#skipWhitespace();
    if (this.#index !== this.text.length) {
      throw jsonFailure("ARCHIVE_MALFORMED_JSON", `Malformed JSON in ${this.entryPath}.`, {
        offset: this.#index,
      });
    }
  }

  #parseValue(): void {
    this.#skipWhitespace();
    const char = this.text[this.#index];
    if (char === "{") {
      this.#parseObject();
    } else if (char === "[") {
      this.#parseArray();
    } else if (char === "\"") {
      this.#parseStringToken();
    } else if (char === "-" || (char >= "0" && char <= "9")) {
      this.#parseNumber();
    } else if (this.text.startsWith("true", this.#index)) {
      this.#index += 4;
    } else if (this.text.startsWith("false", this.#index)) {
      this.#index += 5;
    } else if (this.text.startsWith("null", this.#index)) {
      this.#index += 4;
    } else {
      throw jsonFailure("ARCHIVE_MALFORMED_JSON", `Malformed JSON in ${this.entryPath}.`, {
        offset: this.#index,
      });
    }
  }

  #parseObject(): void {
    const keys = new Set<string>();
    this.#expect("{");
    this.#skipWhitespace();
    if (this.#peek("}")) {
      this.#index += 1;
      return;
    }

    while (true) {
      this.#skipWhitespace();
      const key = this.#parseStringToken();
      if (keys.has(key)) {
        throw jsonFailure("ARCHIVE_DUPLICATE_JSON_KEY", `Duplicate JSON key "${key}" in ${this.entryPath}.`, {
          key,
          offset: this.#index,
        });
      }
      keys.add(key);
      this.#skipWhitespace();
      this.#expect(":");
      this.#parseValue();
      this.#skipWhitespace();
      if (this.#peek("}")) {
        this.#index += 1;
        return;
      }
      this.#expect(",");
    }
  }

  #parseArray(): void {
    this.#expect("[");
    this.#skipWhitespace();
    if (this.#peek("]")) {
      this.#index += 1;
      return;
    }

    while (true) {
      this.#parseValue();
      this.#skipWhitespace();
      if (this.#peek("]")) {
        this.#index += 1;
        return;
      }
      this.#expect(",");
    }
  }

  #parseStringToken(): string {
    const start = this.#index;
    this.#expect("\"");
    while (this.#index < this.text.length) {
      const char = this.text[this.#index];
      if (char === "\"") {
        this.#index += 1;
        return JSON.parse(this.text.slice(start, this.#index)) as string;
      }
      if (char === "\\") {
        this.#index += 1;
        if (this.#index >= this.text.length) break;
        if (this.text[this.#index] === "u") {
          this.#index += 5;
        } else {
          this.#index += 1;
        }
      } else {
        this.#index += 1;
      }
    }
    throw jsonFailure("ARCHIVE_MALFORMED_JSON", `Unterminated JSON string in ${this.entryPath}.`, {
      offset: start,
    });
  }

  #parseNumber(): void {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.text.slice(this.#index));
    if (!match) {
      throw jsonFailure("ARCHIVE_MALFORMED_JSON", `Malformed JSON number in ${this.entryPath}.`, {
        offset: this.#index,
      });
    }
    this.#index += match[0].length;
  }

  #skipWhitespace(): void {
    while (/[\t\n\r ]/.test(this.text[this.#index] ?? "")) this.#index += 1;
  }

  #expect(char: string): void {
    if (this.text[this.#index] !== char) {
      throw jsonFailure("ARCHIVE_MALFORMED_JSON", `Malformed JSON in ${this.entryPath}.`, {
        expected: char,
        offset: this.#index,
      });
    }
    this.#index += 1;
  }

  #peek(char: string): boolean {
    return this.text[this.#index] === char;
  }
}

function checkArchiveLimits(
  fileCount: number,
  totalBytes: number,
  fileBytes: number,
  entryPath: string,
  limits: PortableArchiveLimits,
): void {
  if (fileCount > limits.maxFiles) {
    throw new PortableArchiveReadError(diagnostic({
      code: "ARCHIVE_FILE_COUNT_LIMIT_EXCEEDED",
      path: entryPath,
      resourceType: "file",
      message: `Archive file count exceeds limit ${limits.maxFiles}.`,
      context: { max_files: limits.maxFiles },
    }));
  }
  if (fileBytes > limits.maxFileBytes || totalBytes > limits.maxExpandedBytes) {
    throw new PortableArchiveReadError(diagnostic({
      code: "ARCHIVE_SIZE_LIMIT_EXCEEDED",
      path: entryPath,
      resourceType: "file",
      message: "Archive expanded size exceeds local Core limits.",
      context: {
        max_file_bytes: limits.maxFileBytes,
        max_expanded_bytes: limits.maxExpandedBytes,
        actual_file_bytes: fileBytes,
        actual_expanded_bytes: totalBytes,
      },
    }));
  }
}

function validateArchivePath(
  value: string,
  resourceType: string,
  resourceId?: string,
): ArchiveDiagnostic | null {
  if (
    !value ||
    value.startsWith("/") ||
    value.includes("\\") ||
    CONTROL_RE.test(value) ||
    path.posix.normalize(value) !== value ||
    value.split("/").some((segment) => segment === "." || segment === ".." || segment.length === 0)
  ) {
    return diagnostic({
      code: "ARCHIVE_PATH_UNSAFE",
      path: value,
      resourceType,
      resourceId,
      message: `Archive path is unsafe: ${value}.`,
      nextAction: {
        type: "none",
        message: "Reject this archive and create a fresh export.",
      },
    });
  }
  return null;
}

function toArchiveRelativePath(root: string, absolutePath: string): string {
  return path.relative(root, absolutePath).split(path.sep).join("/");
}

function isDescriptor(value: unknown): value is PortableArchiveDescriptor {
  return (
    isRecord(value) &&
    typeof value.mediaType === "string" &&
    typeof value.digest === "string" &&
    SHA256_DIGEST_RE.test(value.digest) &&
    typeof value.size === "number" &&
    Number.isSafeInteger(value.size) &&
    value.size >= 0 &&
    (value.path === undefined || typeof value.path === "string") &&
    (value.annotations === undefined || isStringRecord(value.annotations))
  );
}

function isArchiveSecretRequirement(value: unknown): value is ArchiveSecretRequirement {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.required === "boolean" &&
    (value.targets === undefined || (Array.isArray(value.targets) && value.targets.every((target) => typeof target === "string")))
  );
}

function isJsonMediaType(mediaType: string): boolean {
  return mediaType.endsWith("+json") || mediaType === "application/json";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function jsonDepth(value: unknown): number {
  if (value === null || typeof value !== "object") return 0;
  if (Array.isArray(value)) return 1 + Math.max(0, ...value.map((entry) => jsonDepth(entry)));
  return 1 + Math.max(0, ...Object.values(value).map((entry) => jsonDepth(entry)));
}

function readTarString(bytes: Uint8Array, start: number, length: number): string {
  const slice = bytes.subarray(start, start + length);
  const end = slice.indexOf(0);
  return Buffer.from(end >= 0 ? slice.subarray(0, end) : slice).toString("utf8").trim();
}

function parseTarSize(value: string, entryPath: string): number {
  const trimmed = value.replace(/\0/g, "").trim();
  if (!/^[0-7]+$/.test(trimmed)) {
    throw new PortableArchiveReadError(diagnostic({
      code: "ARCHIVE_MALFORMED_TAR",
      path: entryPath,
      resourceType: "tar",
      message: "Tar entry size is not valid octal.",
    }));
  }
  const size = Number.parseInt(trimmed, 8);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new PortableArchiveReadError(diagnostic({
      code: "ARCHIVE_SIZE_LIMIT_EXCEEDED",
      path: entryPath,
      resourceType: "tar",
      message: "Tar entry size is not safe.",
    }));
  }
  return size;
}

function isZeroBlock(bytes: Uint8Array): boolean {
  return bytes.every((byte) => byte === 0);
}

function normalizeJsonFailure(error: unknown): JsonParseFailure {
  if (isJsonParseFailure(error)) return error;
  return jsonFailure("ARCHIVE_MALFORMED_JSON", error instanceof Error ? error.message : "Malformed JSON descriptor.");
}

function isJsonParseFailure(error: unknown): error is JsonParseFailure {
  return error instanceof Error && "code" in error && (
    (error as JsonParseFailure).code === "ARCHIVE_DUPLICATE_JSON_KEY" ||
    (error as JsonParseFailure).code === "ARCHIVE_MALFORMED_JSON"
  );
}

function jsonFailure(
  code: JsonParseFailure["code"],
  message: string,
  details: Record<string, unknown> = {},
): JsonParseFailure {
  const error = new Error(message) as JsonParseFailure;
  error.code = code;
  error.details = details;
  return error;
}

function emptyVerifyResult(diagnosticEntry: ArchiveDiagnostic, transport: PortableArchiveTransport | null): PortableArchiveVerifyResult {
  return {
    ok: false,
    archive_version: null,
    archive_digest: null,
    transport,
    file_count: 0,
    total_bytes: 0,
    descriptor_count: 0,
    required_capabilities: [],
    required_secrets: [],
    auth_subject_stub_count: 0,
    export_report: null,
    portability_report: null,
    diagnostics: [diagnosticEntry],
  };
}

function errorToDiagnostic(error: unknown): ArchiveDiagnostic {
  if (error instanceof PortableArchiveReadError) return error.diagnostic;
  return diagnostic({
    code: "ARCHIVE_ENTRY_TYPE_UNSUPPORTED",
    resourceType: "archive",
    message: error instanceof Error ? error.message : "Could not read portable archive.",
  });
}

class PortableArchiveReadError extends Error {
  constructor(readonly diagnostic: ArchiveDiagnostic) {
    super(diagnostic.message);
    this.name = "PortableArchiveReadError";
  }
}

function diagnostic(input: {
  code: ArchiveErrorCode;
  resourceType: string;
  message: string;
  path?: string;
  resourceId?: string;
  severity?: PortabilityReportSeverity;
  nextAction?: ArchiveNextAction;
  retryable?: boolean;
  context?: Record<string, unknown>;
}): ArchiveDiagnostic {
  return {
    code: input.code,
    severity: input.severity ?? "blocking",
    resource_type: input.resourceType,
    ...(input.resourceId ? { resource_id: input.resourceId } : {}),
    ...(input.path ? { path: input.path } : {}),
    message: input.message,
    next_action: input.nextAction ?? { type: "none" },
    retryable: input.retryable ?? false,
    ...(input.context ? { context: input.context } : {}),
  };
}
