import type {
  CANONICALIZATION_VERSION,
  PLANNER_SEMANTICS_VERSION,
  PORTABLE_RELEASE_STATE_VERSION,
  RELEASE_SPEC_VERSION,
  STATIC_MANIFEST_VERSION,
  FACT_PROTOCOL_VERSION,
} from "./versions.js";

export type ReleaseSpecVersion = typeof RELEASE_SPEC_VERSION;
export type PortableReleaseStateVersion = typeof PORTABLE_RELEASE_STATE_VERSION;
export type StaticManifestVersion = typeof STATIC_MANIFEST_VERSION;
export type FactProtocolVersion = typeof FACT_PROTOCOL_VERSION;
export type CanonicalizationVersion = typeof CANONICALIZATION_VERSION;
export type PlannerSemanticsVersion = typeof PLANNER_SEMANTICS_VERSION;

export interface ContentRefHex {
  sha256: string;
  size: number;
  contentType?: string;
  integrity?: string;
}

export type FileSet = Record<string, ContentRefHex>;

export type PublicPathMode = "implicit" | "explicit";
export type StaticCacheClass = "html" | "immutable_versioned" | "revalidating_asset";
export type StaticCacheClassSource =
  | "declared"
  | "inferred_html"
  | "inferred_sha_filename"
  | "downgraded"
  | "legacy";
export type StaticManifestAuthority =
  | "implicit_file_path"
  | "explicit_public_path"
  | "route_static_alias";
export type StaticManifestMethod = "GET" | "HEAD";

export interface PublicStaticPathSpec {
  asset: string;
  cache_class?: StaticCacheClass;
}

export interface SitePublicPathsSpec {
  mode: PublicPathMode;
  replace?: Record<string, PublicStaticPathSpec>;
}

export type SiteSpec = (
  | { replace?: FileSet; patch?: never }
  | { patch?: { put?: FileSet; delete?: string[] }; replace?: never }
) & {
  public_paths?: SitePublicPathsSpec;
};

export interface MigrationSpec {
  id: string;
  checksum: string;
  sql?: string;
  sql_ref?: ContentRefHex;
  transaction?: "required" | "none";
}

export interface RoleGateSpec {
  table: string;
  idColumn: string;
  roleColumn: string;
  allowed: string[];
  cacheTtl?: number;
  onDeny?: "envelope" | "redirect";
  signInPath?: string;
}

export interface FunctionSpec {
  runtime: "node22";
  entrypoint?: string;
  source?: ContentRefHex;
  files?: FileSet;
  config?: { timeoutSeconds?: number; memoryMb?: number };
  schedule?: string | null;
  deps?: string[];
  requireAuth?: boolean;
  requireRole?: RoleGateSpec | null;
  class?: "ssr" | "standard";
  capabilities?: string[];
}

export type DetectSource = "accept-language" | `cookie:${string}`;

export interface I18nSpec {
  defaultLocale: string;
  locales: string[];
  detect?: DetectSource[];
  unknownLocalePolicy?: "reject" | "pass-through";
}

export const SUPPORTED_HTTP_METHODS = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
] as const;

export type HttpMethod = (typeof SUPPORTED_HTTP_METHODS)[number];

export interface FunctionRouteTarget {
  type: "function";
  name: string;
}

export interface StaticRouteTarget {
  type: "static";
  file: string;
}

export type RouteTarget = FunctionRouteTarget | StaticRouteTarget;

export interface RouteSpec {
  pattern: string;
  methods?: HttpMethod[];
  target: RouteTarget;
}

export type ReleaseSpecRoutes = null | {
  replace: RouteSpec[];
};

export interface AssetPutEntryWire {
  key: string;
  sha256: string;
  size_bytes: number;
  content_type?: string;
  visibility?: "public" | "private";
  immutable?: boolean;
  metadata?: Record<string, unknown>;
  exif_policy?: "keep" | "strip";
}

export interface AssetSyncPruneConfirmWire {
  base_revision: string;
  delete_set_digest: string;
  expected_delete_count: number;
}

export interface AssetSpecWire {
  put?: AssetPutEntryWire[];
  delete?: string[];
  sync?: {
    prefix: string;
    prune: true;
    confirm?: AssetSyncPruneConfirmWire;
  };
}

export interface ReleaseSpec {
  project: string;
  idempotency_key?: string;
  base?: { release: "current" | "empty" } | { release_id: string };
  database?: {
    migrations?: MigrationSpec[];
    expose?: unknown;
    zero_downtime?: boolean;
  };
  secrets?: {
    require?: string[];
    delete?: string[];
  };
  functions?: {
    replace?: Record<string, FunctionSpec>;
    patch?: { set?: Record<string, FunctionSpec>; delete?: string[] };
  };
  site?: SiteSpec;
  subdomains?: { set?: string[]; add?: string[]; remove?: string[] };
  routes?: ReleaseSpecRoutes;
  checks?: unknown;
  assets?: AssetSpecWire;
  i18n?: I18nSpec | null;
}

export interface RouteEntry {
  pattern: string;
  kind: "exact" | "prefix";
  prefix: string | null;
  methods: HttpMethod[] | null;
  target: RouteTarget;
}

export interface MaterializedRoutes {
  manifest_sha256: string | null;
  entries: RouteEntry[];
}

export interface StaticManifestResponseMetadata {
  headers?: Record<string, string>;
}

export interface StaticManifestFileEntry {
  sha256: string;
  size: number;
  content_type: string;
  cache_class: StaticCacheClass;
  cache_class_source: StaticCacheClassSource;
  asset_path?: string;
  direct?: boolean;
  authority?: StaticManifestAuthority;
  route_id?: string;
  methods?: StaticManifestMethod[];
  response_metadata?: StaticManifestResponseMetadata;
}

export interface StaticManifestBuildEntry {
  public_path: string;
  asset_path: string;
  sha256: string;
  size: number;
  content_type?: string | null;
  cache_class?: StaticCacheClass | null;
  authority: StaticManifestAuthority;
  direct: boolean;
  route_id?: string;
  methods?: StaticManifestMethod[];
  response_metadata?: StaticManifestResponseMetadata;
}

export interface StaticManifest {
  version: StaticManifestVersion;
  public_path_mode?: PublicPathMode;
  files: Record<string, StaticManifestFileEntry>;
  spa_fallback?: string | null;
}

export interface StaticManifestMetadata {
  file_count: number;
  total_bytes: number;
  cache_classes: Record<string, number>;
  cache_class_sources: Record<string, number>;
  spa_fallback: string | null;
}

export interface PortableSitePath {
  path: string;
  content_sha256: string;
  size_bytes?: number;
  content_type: string;
}

export interface PortableFunctionEntry {
  name: string;
  code_hash: string;
  runtime: "node22";
  timeout_seconds: number;
  memory_mb: number;
  schedule: string | null;
  deps: string[];
  require_auth: boolean;
  require_role: RoleGateSpec | null;
  class?: "standard" | "ssr";
  capabilities?: string[];
}

export interface MaterializedI18n {
  defaultLocale: string;
  locales: string[];
  detect: string[];
  unknownLocalePolicy: "reject" | "pass-through";
}

export interface PortableMigrationEntry {
  migration_id: string;
  checksum_hex: string;
  transaction: "default" | "none";
}

export interface PortableReleaseState {
  state_version: typeof PORTABLE_RELEASE_STATE_VERSION;
  site: { paths: PortableSitePath[] };
  static_manifest: StaticManifest | null;
  functions: PortableFunctionEntry[];
  secrets: { keys: string[] };
  subdomains: { names: string[] };
  routes: MaterializedRoutes;
  migrations: PortableMigrationEntry[];
  i18n: MaterializedI18n | null;
}

export interface PlannerSemantics {
  releaseSpecVersion: typeof RELEASE_SPEC_VERSION;
  materializedStateVersion: typeof PORTABLE_RELEASE_STATE_VERSION;
  canonicalizationVersion: typeof CANONICALIZATION_VERSION;
  plannerSemanticsVersion: typeof PLANNER_SEMANTICS_VERSION;
  factProtocolVersion?: "run402.release_facts.v1";
  legacySnapshotVersion?: 0 | 1;
}
