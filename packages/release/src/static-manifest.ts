import { createHash } from "node:crypto";

import { STATIC_MANIFEST_VERSION } from "./versions.js";
import type {
  StaticCacheClass,
  StaticCacheClassSource,
  StaticManifest,
  StaticManifestAuthority,
  StaticManifestBuildEntry,
  StaticManifestFileEntry,
  StaticManifestMetadata,
  StaticManifestMethod,
  StaticManifestResponseMetadata,
} from "./types.js";

export interface StaticManifestInputFileEntry {
  sha256?: unknown;
  size?: unknown;
  content_type?: unknown;
  cache_class?: unknown;
  cache_class_source?: unknown;
  asset_path?: unknown;
  direct?: unknown;
  authority?: unknown;
  route_id?: unknown;
  methods?: unknown;
  response_metadata?: unknown;
  headers?: unknown;
}

export interface StaticManifestValidationOptions {
  mode?: "reject" | "strip";
}

export interface InlineStaticManifest {
  sha256: string;
  manifest: unknown;
}

export interface CacheClassificationInput {
  path: string;
  contentType?: string | null;
  declaredCacheClass?: StaticCacheClass | null;
  previous?: Pick<StaticManifestFileEntry, "sha256" | "cache_class"> | null;
}

export interface CacheClassificationResult {
  cache_class: StaticCacheClass;
  cache_class_source: StaticCacheClassSource;
  warnings: string[];
}

export interface PreviousImmutableViolation {
  path: string;
  previous_sha256: string;
  candidate_sha256: string;
  previous_cache_class: StaticCacheClass;
}

export interface LegacyImmutableRisk {
  path: string;
  sha256: string;
  reason: "legacy_immutable_unfingerprinted";
}

export interface StaticManifestSitePathInput {
  path: string;
  content_sha256: string;
  content_type?: string | null;
  size?: number | null;
}

export class StaticManifestError extends Error {
  constructor(
    public code: string,
    message: string,
    public resource: string = "static_manifest",
  ) {
    super(message);
    this.name = "StaticManifestError";
  }
}

export class UnsupportedStaticManifestVersionError extends StaticManifestError {
  constructor(version: unknown) {
    super(
      "UNSUPPORTED_STATIC_MANIFEST_VERSION",
      `unsupported static manifest version: ${String(version)}`,
      "static_manifest.version",
    );
    this.name = "UnsupportedStaticManifestVersionError";
  }
}

type StaticPathErrorCode =
  | "PATH_MUST_START_WITH_SLASH"
  | "PATH_INVALID_PERCENT_ENCODING"
  | "PATH_ENCODED_SEPARATOR"
  | "PATH_RAW_BACKSLASH"
  | "PATH_CONTROL_CHARACTER"
  | "PATH_DOT_SEGMENT"
  | "PATH_DOUBLE_DECODE_TRAVERSAL"
  | "PATH_DUPLICATE_SLASH"
  | "PATH_INTERNAL_NAMESPACE";

const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const HEX_SHA_RE = /^[0-9a-f]{64}$/;
const CONTROL_RE = /[\x00-\x1f\x7f]/;
const CONTROL_IN_HEADER_VALUE = /[\x00-\x08\x0a-\x1f\x7f]/;
const ENCODED_SEPARATOR_RE = /%(?:2f|5c)/i;
const ENCODED_AFTER_DECODE_RE = /%(?:2e|2f|5c)/i;
const MAX_RESPONSE_HEADERS = 32;
const MAX_HEADER_NAME_LENGTH = 64;
const MAX_HEADER_VALUE_LENGTH = 4096;
const PLATFORM_HEADER_EXACT = new Set([
  "accept-ranges",
  "age",
  "cache-control",
  "cf-cache-status",
  "connection",
  "content-encoding",
  "content-length",
  "etag",
  "expires",
  "host",
  "keep-alive",
  "last-modified",
  "pragma",
  "proxy-authenticate",
  "proxy-authorization",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "vary",
  "via",
]);

export function canonicalizeStaticManifest(
  input: unknown,
  options: StaticManifestValidationOptions = {},
): StaticManifest {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new StaticManifestError("INVALID_STATIC_MANIFEST", "static manifest must be an object");
  }
  const obj = input as Record<string, unknown>;
  if (obj.version !== STATIC_MANIFEST_VERSION) {
    throw new UnsupportedStaticManifestVersionError(obj.version);
  }
  if (!obj.files || typeof obj.files !== "object" || Array.isArray(obj.files)) {
    throw new StaticManifestError("INVALID_STATIC_MANIFEST", "files must be an object", "static_manifest.files");
  }

  const files: Record<string, StaticManifestFileEntry> = {};
  for (const [rawPath, rawEntry] of Object.entries(obj.files as Record<string, unknown>).sort(compareEntryKey)) {
    const path = canonicalizeStaticManifestPath(rawPath, `static_manifest.files.${rawPath}`);
    if (files[path]) {
      throw new StaticManifestError(
        "DUPLICATE_STATIC_MANIFEST_PATH",
        `duplicate normalized path ${path}`,
        `static_manifest.files.${rawPath}`,
      );
    }
    files[path] = canonicalizeManifestEntry(path, rawEntry, options);
  }

  const spaFallback = canonicalizeSpaFallback(obj.spa_fallback, files);
  const mode = normalizePublicPathMode(obj.public_path_mode);
  return {
    version: STATIC_MANIFEST_VERSION,
    ...(mode === "implicit" ? {} : { public_path_mode: mode }),
    files,
    ...(spaFallback === undefined ? {} : { spa_fallback: spaFallback }),
  };
}

export function staticManifestCanonicalBytes(manifest: StaticManifest): Buffer {
  return Buffer.from(stableJson(manifest), "utf-8");
}

export function computeStaticManifestSha256(manifest: StaticManifest): string {
  return createHash("sha256").update(staticManifestCanonicalBytes(manifest)).digest("hex");
}

export function verifyInlineStaticManifestHash(
  inline: InlineStaticManifest,
  options: StaticManifestValidationOptions = {},
): StaticManifest {
  const manifest = canonicalizeStaticManifest(inline.manifest, options);
  const actual = computeStaticManifestSha256(manifest);
  if (actual !== inline.sha256.toLowerCase()) {
    throw new StaticManifestError(
      "STATIC_MANIFEST_INLINE_HASH_MISMATCH",
      `inline static manifest sha mismatch: expected ${inline.sha256}, got ${actual}`,
      "static_manifest_inline.sha256",
    );
  }
  return manifest;
}

export function normalizeManifestResponseHeaders(
  headers: unknown,
  options: StaticManifestValidationOptions = {},
): Record<string, string> | undefined {
  if (headers === undefined || headers === null) return undefined;
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    throw new StaticManifestError(
      "INVALID_STATIC_RESPONSE_HEADERS",
      "response headers must be an object",
      "static_manifest.files[].response_metadata.headers",
    );
  }

  const entries = Object.entries(headers as Record<string, unknown>);
  if (entries.length > MAX_RESPONSE_HEADERS) {
    throw new StaticManifestError(
      "STATIC_RESPONSE_HEADERS_TOO_MANY",
      `response headers exceed ${MAX_RESPONSE_HEADERS}`,
      "static_manifest.files[].response_metadata.headers",
    );
  }

  const out: Record<string, string> = {};
  for (const [rawName, rawValue] of entries) {
    const name = rawName.toLowerCase();
    const value = String(rawValue);
    const blocked = isPlatformOwnedResponseHeader(name);
    if (blocked) {
      if (options.mode === "strip") continue;
      throw new StaticManifestError(
        "STATIC_RESPONSE_HEADER_FORBIDDEN",
        `response header ${rawName} is platform-owned`,
        `static_manifest.files[].response_metadata.headers.${rawName}`,
      );
    }
    if (!HEADER_NAME_RE.test(rawName) || rawName.length > MAX_HEADER_NAME_LENGTH) {
      throw new StaticManifestError(
        "STATIC_RESPONSE_HEADER_INVALID_NAME",
        `response header ${rawName} has an invalid name`,
        `static_manifest.files[].response_metadata.headers.${rawName}`,
      );
    }
    if (CONTROL_IN_HEADER_VALUE.test(value) || value.length > MAX_HEADER_VALUE_LENGTH) {
      throw new StaticManifestError(
        "STATIC_RESPONSE_HEADER_INVALID_VALUE",
        `response header ${rawName} has an invalid value`,
        `static_manifest.files[].response_metadata.headers.${rawName}`,
      );
    }
    out[rawName] = value;
  }
  const sorted = Object.fromEntries(Object.entries(out).sort(compareEntryKey));
  return Object.keys(sorted).length === 0 ? undefined : sorted;
}

export function isPlatformOwnedResponseHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return PLATFORM_HEADER_EXACT.has(lower) ||
    lower.startsWith("x-run402-") ||
    lower.startsWith("cf-");
}

export function classifyStaticCacheClass(
  input: CacheClassificationInput,
): CacheClassificationResult {
  const contentType = input.contentType ?? "application/octet-stream";
  const warnings: string[] = [];
  if (isHtmlPathOrContentType(input.path, contentType)) {
    return { cache_class: "html", cache_class_source: "inferred_html", warnings };
  }

  const fingerprinted = hasVersionedFilename(input.path);
  let cacheClass: StaticCacheClass = fingerprinted
    ? "immutable_versioned"
    : "revalidating_asset";
  let source: StaticCacheClassSource = fingerprinted
    ? "inferred_sha_filename"
    : "downgraded";

  if (input.declaredCacheClass) {
    if (input.declaredCacheClass === "html") {
      cacheClass = "html";
      source = "declared";
    } else if (input.declaredCacheClass === "immutable_versioned" && fingerprinted) {
      cacheClass = "immutable_versioned";
      source = "declared";
    } else if (input.declaredCacheClass === "immutable_versioned") {
      cacheClass = "revalidating_asset";
      source = "downgraded";
      warnings.push("declared immutable_versioned was downgraded because the path is not fingerprinted");
    } else {
      cacheClass = "revalidating_asset";
      source = "declared";
    }
  }

  if (
    input.previous?.cache_class === "revalidating_asset" &&
    input.previous.sha256 !== "" &&
    cacheClass === "immutable_versioned" &&
    input.declaredCacheClass !== "immutable_versioned"
  ) {
    cacheClass = "revalidating_asset";
    source = "downgraded";
    warnings.push("candidate immutable asset was downgraded because the previous path was revalidating");
  }

  return { cache_class: cacheClass, cache_class_source: source, warnings };
}

export function cacheControlForStaticCacheClass(cacheClass: StaticCacheClass): string {
  switch (cacheClass) {
    case "immutable_versioned":
      return "public, max-age=31536000, immutable";
    case "html":
    case "revalidating_asset":
      return "public, max-age=0, must-revalidate";
  }
}

export function detectPreviousImmutableViolations(
  previous: StaticManifest | null | undefined,
  candidate: StaticManifest,
): PreviousImmutableViolation[] {
  if (!previous) return [];
  const out: PreviousImmutableViolation[] = [];
  for (const [path, next] of Object.entries(candidate.files)) {
    const prev = previous.files[path];
    if (
      prev &&
      prev.cache_class === "immutable_versioned" &&
      prev.sha256 !== next.sha256
    ) {
      out.push({
        path,
        previous_sha256: prev.sha256,
        candidate_sha256: next.sha256,
        previous_cache_class: prev.cache_class,
      });
    }
  }
  return out.sort((a, b) => compareAscii(a.path, b.path));
}

export function collectLegacyImmutableRisks(manifest: StaticManifest): LegacyImmutableRisk[] {
  const out: LegacyImmutableRisk[] = [];
  for (const [path, entry] of Object.entries(manifest.files)) {
    if (
      entry.cache_class_source === "legacy" &&
      entry.cache_class === "immutable_versioned" &&
      !hasVersionedFilename(path) &&
      !isHtmlPathOrContentType(path, entry.content_type)
    ) {
      out.push({
        path,
        sha256: entry.sha256,
        reason: "legacy_immutable_unfingerprinted",
      });
    }
  }
  return out.sort((a, b) => compareAscii(a.path, b.path));
}

export function buildStaticManifestFromSitePaths(
  paths: StaticManifestSitePathInput[],
): StaticManifest {
  const entries: StaticManifestBuildEntry[] = [];
  for (const file of [...paths].sort((a, b) => compareAscii(a.path, b.path))) {
    entries.push({
      public_path: file.path,
      asset_path: file.path,
      sha256: file.content_sha256,
      size: file.size ?? 0,
      content_type: file.content_type ?? guessContentType(file.path),
      authority: "implicit_file_path",
      direct: true,
    });
    for (const compatibilityPath of implicitCompatibilityPublicPaths(file.path)) {
      entries.push({
        public_path: compatibilityPath,
        asset_path: file.path,
        sha256: file.content_sha256,
        size: file.size ?? 0,
        content_type: file.content_type ?? guessContentType(file.path),
        authority: "implicit_file_path",
        direct: true,
      });
    }
  }
  return buildStaticManifestFromEntries(entries, {
    publicPathMode: "implicit",
    spaFallback: paths.some((path) => canonicalizeStaticManifestPath(path.path, `site.${path.path}`) === "/index.html")
      ? "/index.html"
      : null,
  });
}

export function buildStaticManifestFromEntries(
  entries: StaticManifestBuildEntry[],
  options: {
    publicPathMode?: "implicit" | "explicit";
    spaFallback?: string | null;
  } = {},
): StaticManifest {
  const files: Record<string, StaticManifestFileEntry> = {};
  for (const entry of [...entries].sort((a, b) => compareAscii(a.public_path, b.public_path))) {
    const publicPath = canonicalizeStaticManifestPath(entry.public_path, `static_manifest.files.${entry.public_path}`);
    const assetPath = normalizeStaticManifestAssetPath(entry.asset_path, `static_manifest.files.${publicPath}.asset_path`);
    const contentType = normalizeContentType(entry.content_type ?? guessContentType(assetPath));
    const classification = classifyStaticCacheClass({
      path: publicPath,
      contentType,
      declaredCacheClass: entry.cache_class ?? null,
    });
    const normalized: StaticManifestFileEntry = {
      sha256: normalizeSha(entry.sha256, `static_manifest.files.${publicPath}.sha256`),
      size: normalizeSize(entry.size, `static_manifest.files.${publicPath}.size`),
      content_type: contentType,
      cache_class: classification.cache_class,
      cache_class_source: classification.cache_class_source,
      asset_path: assetPath,
      direct: entry.direct,
      authority: entry.authority,
      ...(entry.route_id ? { route_id: entry.route_id } : {}),
      ...(entry.methods ? { methods: normalizeManifestMethods(entry.methods, `static_manifest.files.${publicPath}.methods`) } : {}),
      ...(entry.response_metadata ? { response_metadata: entry.response_metadata } : {}),
    };
    const existing = files[publicPath];
    if (existing) {
      if (!sameManifestEntry(existing, normalized)) {
        throw new StaticManifestError(
          "DUPLICATE_STATIC_MANIFEST_PATH",
          `conflicting duplicate public path ${publicPath}`,
          `static_manifest.files.${publicPath}`,
        );
      }
      if (existing.direct !== true && normalized.direct === true) {
        files[publicPath] = { ...normalized };
      }
      continue;
    }
    files[publicPath] = normalized;
  }
  return canonicalizeStaticManifest({
    version: STATIC_MANIFEST_VERSION,
    public_path_mode: options.publicPathMode,
    files,
    spa_fallback: options.spaFallback,
  });
}

export function emptyStaticManifestMetadata(): StaticManifestMetadata {
  return {
    file_count: 0,
    total_bytes: 0,
    cache_classes: {},
    cache_class_sources: {},
    spa_fallback: null,
  };
}

export function summarizeStaticManifest(manifest: StaticManifest | null): StaticManifestMetadata {
  if (!manifest) return emptyStaticManifestMetadata();
  const cacheClasses: Record<string, number> = {};
  const cacheClassSources: Record<string, number> = {};
  let totalBytes = 0;
  for (const entry of Object.values(manifest.files)) {
    totalBytes += entry.size;
    cacheClasses[entry.cache_class] = (cacheClasses[entry.cache_class] ?? 0) + 1;
    cacheClassSources[entry.cache_class_source] =
      (cacheClassSources[entry.cache_class_source] ?? 0) + 1;
  }
  return {
    file_count: Object.keys(manifest.files).length,
    total_bytes: totalBytes,
    cache_classes: Object.fromEntries(Object.entries(cacheClasses).sort()),
    cache_class_sources: Object.fromEntries(Object.entries(cacheClassSources).sort()),
    spa_fallback: manifest.spa_fallback ?? null,
  };
}

export function canonicalizeStaticManifestPath(path: string, resource = "static_manifest.path"): string {
  if (typeof path !== "string") {
    throw new StaticManifestError("INVALID_STATIC_MANIFEST_PATH", "path must be a string", resource);
  }
  if (path.includes("?") || path.includes("#")) {
    throw new StaticManifestError("INVALID_STATIC_MANIFEST_PATH", "path must not include query strings or fragments", resource);
  }
  const withSlash = path.startsWith("/") ? path : `/${path}`;
  try {
    return canonicalizeStablePath(withSlash).normalizedPath;
  } catch (err) {
    if (err instanceof StaticPathCanonicalizationError) {
      throw new StaticManifestError("INVALID_STATIC_MANIFEST_PATH", err.message, resource);
    }
    throw err;
  }
}

export function normalizeStaticManifestAssetPath(value: unknown, resource = "static_manifest.asset_path"): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new StaticManifestError("INVALID_STATIC_MANIFEST_ASSET_PATH", "asset_path must be a non-empty string", resource);
  }
  if (value.startsWith("/") || value.includes("\\") || value.includes("?") || value.includes("#") || value.endsWith("/")) {
    throw new StaticManifestError("INVALID_STATIC_MANIFEST_ASSET_PATH", "asset_path must be a relative file path", resource);
  }
  for (const segment of value.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new StaticManifestError("INVALID_STATIC_MANIFEST_ASSET_PATH", "asset_path must not contain empty, . or .. segments", resource);
    }
  }
  return value;
}

export function staticManifestPublicPathMode(
  manifest: StaticManifest | null | undefined,
): "implicit" | "explicit" {
  return manifest?.public_path_mode === "explicit" ? "explicit" : "implicit";
}

export function staticManifestEntryAssetPath(
  publicPath: string,
  entry: StaticManifestFileEntry,
): string {
  return entry.asset_path ?? publicPath.replace(/^\/+/, "");
}

export function isDirectStaticManifestEntry(entry: StaticManifestFileEntry): boolean {
  return entry.direct !== false;
}

export function staticManifestEntryAuthority(
  entry: StaticManifestFileEntry,
): StaticManifestAuthority {
  if (entry.authority) return entry.authority;
  return "implicit_file_path";
}

function canonicalizeManifestEntry(
  path: string,
  rawEntry: unknown,
  options: StaticManifestValidationOptions,
): StaticManifestFileEntry {
  if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
    throw new StaticManifestError("INVALID_STATIC_MANIFEST_ENTRY", "file entry must be an object", `static_manifest.files.${path}`);
  }
  const entry = rawEntry as StaticManifestInputFileEntry;
  const contentType = normalizeContentType(entry.content_type ?? guessContentType(path));
  const declaredCacheClass = normalizeCacheClass(entry.cache_class, path);
  const legacySource = entry.cache_class_source === "legacy";
  const classification = legacySource && declaredCacheClass
    ? {
        cache_class: declaredCacheClass,
        cache_class_source: "legacy" as const,
        warnings: [],
      }
    : classifyStaticCacheClass({
        path,
        contentType,
        declaredCacheClass,
      });
  const responseMetadata = normalizeResponseMetadata(
    entry.response_metadata ?? (entry.headers ? { headers: entry.headers } : undefined),
    options,
  );
  const direct = normalizeDirect(entry.direct, `static_manifest.files.${path}.direct`);
  const authority = normalizeAuthority(entry.authority, `static_manifest.files.${path}.authority`);
  const assetPath = entry.asset_path === undefined
    ? undefined
    : normalizeStaticManifestAssetPath(entry.asset_path, `static_manifest.files.${path}.asset_path`);
  const routeId = normalizeRouteId(entry.route_id, `static_manifest.files.${path}.route_id`);
  const methods = normalizeManifestMethods(entry.methods, `static_manifest.files.${path}.methods`);

  return {
    sha256: normalizeSha(entry.sha256, `static_manifest.files.${path}.sha256`),
    size: normalizeSize(entry.size, `static_manifest.files.${path}.size`),
    content_type: contentType,
    cache_class: classification.cache_class,
    cache_class_source: normalizeCacheClassSource(
      entry.cache_class_source,
      classification.cache_class_source,
      `static_manifest.files.${path}.cache_class_source`,
    ),
    ...(assetPath ? { asset_path: assetPath } : {}),
    ...(direct === undefined ? {} : { direct }),
    ...(authority === undefined ? {} : { authority }),
    ...(routeId === undefined ? {} : { route_id: routeId }),
    ...(methods === undefined ? {} : { methods }),
    ...(responseMetadata ? { response_metadata: responseMetadata } : {}),
  };
}

function normalizeResponseMetadata(
  value: unknown,
  options: StaticManifestValidationOptions,
): StaticManifestResponseMetadata | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StaticManifestError(
      "INVALID_STATIC_RESPONSE_METADATA",
      "response_metadata must be an object",
      "static_manifest.files[].response_metadata",
    );
  }
  const obj = value as Record<string, unknown>;
  const headers = normalizeManifestResponseHeaders(obj.headers, options);
  return headers ? { headers } : undefined;
}

function canonicalizeSpaFallback(
  value: unknown,
  files: Record<string, StaticManifestFileEntry>,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new StaticManifestError(
      "INVALID_STATIC_MANIFEST_SPA_FALLBACK",
      "spa_fallback must be a path or null",
      "static_manifest.spa_fallback",
    );
  }
  const path = canonicalizeStaticManifestPath(value, "static_manifest.spa_fallback");
  if (!files[path]) {
    throw new StaticManifestError(
      "STATIC_MANIFEST_SPA_FALLBACK_MISSING",
      `spa_fallback target ${path} is not present in files`,
      "static_manifest.spa_fallback",
    );
  }
  return path;
}

function normalizeSha(value: unknown, resource: string): string {
  if (typeof value !== "string" || !HEX_SHA_RE.test(value.toLowerCase())) {
    throw new StaticManifestError("INVALID_STATIC_MANIFEST_SHA", "sha256 must be lowercase hex sha256", resource);
  }
  return value.toLowerCase();
}

function normalizeSize(value: unknown, resource: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new StaticManifestError("INVALID_STATIC_MANIFEST_SIZE", "size must be a non-negative safe integer", resource);
  }
  return value;
}

function normalizeContentType(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") return "application/octet-stream";
  if (/[\r\n]/.test(value)) {
    throw new StaticManifestError("INVALID_STATIC_MANIFEST_CONTENT_TYPE", "content_type must not contain CR or LF");
  }
  return value.trim().toLowerCase();
}

function normalizeCacheClass(value: unknown, path: string): StaticCacheClass | null {
  if (value === undefined || value === null) return null;
  if (value === "html" || value === "immutable_versioned" || value === "revalidating_asset") return value;
  throw new StaticManifestError(
    "INVALID_STATIC_CACHE_CLASS",
    `invalid cache_class for ${path}`,
    `static_manifest.files.${path}.cache_class`,
  );
}

function normalizeCacheClassSource(
  value: unknown,
  fallback: StaticCacheClassSource,
  resource: string,
): StaticCacheClassSource {
  if (value === undefined || value === null) return fallback;
  if (
    value === "declared" ||
    value === "inferred_html" ||
    value === "inferred_sha_filename" ||
    value === "downgraded" ||
    value === "legacy"
  ) {
    return value;
  }
  throw new StaticManifestError(
    "INVALID_STATIC_CACHE_CLASS_SOURCE",
    "invalid cache_class_source",
    resource,
  );
}

function normalizePublicPathMode(value: unknown): "implicit" | "explicit" {
  if (value === undefined || value === null) return "implicit";
  if (value === "implicit" || value === "explicit") return value;
  throw new StaticManifestError(
    "INVALID_STATIC_MANIFEST_PUBLIC_PATH_MODE",
    "public_path_mode must be implicit or explicit",
    "static_manifest.public_path_mode",
  );
}

function normalizeDirect(value: unknown, resource: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value;
  throw new StaticManifestError("INVALID_STATIC_MANIFEST_DIRECT", "direct must be a boolean", resource);
}

function normalizeAuthority(value: unknown, resource: string): StaticManifestAuthority | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    value === "implicit_file_path" ||
    value === "explicit_public_path" ||
    value === "route_static_alias"
  ) {
    return value;
  }
  throw new StaticManifestError("INVALID_STATIC_MANIFEST_AUTHORITY", "invalid authority", resource);
}

function normalizeRouteId(value: unknown, resource: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string" && value.length > 0) return value;
  throw new StaticManifestError("INVALID_STATIC_MANIFEST_ROUTE_ID", "route_id must be a non-empty string", resource);
}

function normalizeManifestMethods(
  value: unknown,
  resource: string,
): StaticManifestMethod[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new StaticManifestError("INVALID_STATIC_MANIFEST_METHODS", "methods must be an array", resource);
  }
  const set = new Set<StaticManifestMethod>();
  for (const raw of value) {
    if (raw !== "GET" && raw !== "HEAD") {
      throw new StaticManifestError("INVALID_STATIC_MANIFEST_METHODS", "methods may only include GET and HEAD", resource);
    }
    set.add(raw);
  }
  return [...set].sort(compareAscii);
}

function sameManifestEntry(
  a: StaticManifestFileEntry,
  b: StaticManifestFileEntry,
): boolean {
  return stableJson(a) === stableJson(b);
}

function implicitCompatibilityPublicPaths(assetPath: string): string[] {
  const path = canonicalizeStaticManifestPath(assetPath, `site.${assetPath}`);
  if (path === "/index.html") return ["/"];
  if (path.endsWith("/index.html")) {
    return [path.slice(0, -"index.html".length)];
  }
  return [];
}

function hasVersionedFilename(path: string): boolean {
  const lastSlash = path.lastIndexOf("/");
  const basename = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
  return /(?:^|[._-])[0-9a-f]{8,}(?:[._-]|\.)/i.test(basename) ||
    /(?:^|[._-])[0-9a-f]{12,}$/i.test(basename);
}

function isHtmlPathOrContentType(path: string, contentType: string): boolean {
  return path.endsWith(".html") || contentType.toLowerCase().startsWith("text/html");
}

function guessContentType(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".css")) return "text/css";
  if (path.endsWith(".js") || path.endsWith(".mjs")) return "application/javascript";
  if (path.endsWith(".json") || path.endsWith(".map")) return "application/json";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".wasm")) return "application/wasm";
  if (isAssetLikePath(path)) return "application/octet-stream";
  return "application/octet-stream";
}

function canonicalizeStablePath(rawUrlPath: string): {
  rawPath: string;
  normalizedPath: string;
  duplicateSlashPolicy: "reject";
} {
  const rawPath = stripQueryAndFragment(rawUrlPath);
  if (!rawPath.startsWith("/")) {
    throw new StaticPathCanonicalizationError("PATH_MUST_START_WITH_SLASH", "path must start with /");
  }
  if (rawPath.includes("\\")) {
    throw new StaticPathCanonicalizationError("PATH_RAW_BACKSLASH", "path contains raw backslash");
  }
  if (CONTROL_RE.test(rawPath)) {
    throw new StaticPathCanonicalizationError("PATH_CONTROL_CHARACTER", "path contains a control character");
  }
  if (rawPath.includes("//")) {
    throw new StaticPathCanonicalizationError("PATH_DUPLICATE_SLASH", "duplicate slashes are rejected for stable-host static lookup");
  }
  if (ENCODED_SEPARATOR_RE.test(rawPath)) {
    throw new StaticPathCanonicalizationError("PATH_ENCODED_SEPARATOR", "path contains an encoded slash or backslash");
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    throw new StaticPathCanonicalizationError("PATH_INVALID_PERCENT_ENCODING", "path contains invalid percent encoding");
  }
  if (CONTROL_RE.test(decoded)) {
    throw new StaticPathCanonicalizationError("PATH_CONTROL_CHARACTER", "decoded path contains a control character");
  }
  if (ENCODED_AFTER_DECODE_RE.test(decoded)) {
    throw new StaticPathCanonicalizationError("PATH_DOUBLE_DECODE_TRAVERSAL", "path would become unsafe if decoded twice");
  }
  const normalizedPath = decoded.normalize("NFC");
  if (hasDotSegment(rawPath) || hasDotSegment(normalizedPath)) {
    throw new StaticPathCanonicalizationError("PATH_DOT_SEGMENT", "path contains a dot segment");
  }
  if (isInternalStaticNamespace(normalizedPath)) {
    throw new StaticPathCanonicalizationError("PATH_INTERNAL_NAMESPACE", "path targets an internal Run402 namespace");
  }
  return { rawPath, normalizedPath, duplicateSlashPolicy: "reject" };
}

class StaticPathCanonicalizationError extends Error {
  constructor(
    public code: StaticPathErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "StaticPathCanonicalizationError";
  }
}

function stripQueryAndFragment(value: string): string {
  const query = value.indexOf("?");
  const hash = value.indexOf("#");
  const cuts = [query, hash].filter((n) => n >= 0).sort((a, b) => a - b);
  return cuts.length === 0 ? value : value.slice(0, cuts[0]);
}

function hasDotSegment(pathname: string): boolean {
  return pathname.split("/").some((segment) => segment === "." || segment === "..");
}

function isInternalStaticNamespace(pathname: string): boolean {
  return pathname === "/_cas" ||
    pathname.startsWith("/_cas/") ||
    pathname === "/_run402" ||
    pathname.startsWith("/_run402/");
}

function isAssetLikePath(pathname: string): boolean {
  const lastSlash = pathname.lastIndexOf("/");
  const basename = lastSlash >= 0 ? pathname.slice(lastSlash + 1) : pathname;
  return /\.[a-z0-9]{1,12}$/i.test(basename);
}

function stableJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${stableJson(obj[key])}`).join(",")}}`;
  }
  throw new StaticManifestError("INVALID_STATIC_MANIFEST", "static manifest contains unsupported JSON value");
}

function compareEntryKey(a: [string, unknown], b: [string, unknown]): number {
  return compareAscii(a[0], b[0]);
}

function compareAscii(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
