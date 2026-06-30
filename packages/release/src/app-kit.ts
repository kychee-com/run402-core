import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export type AppKitTargetPolicy = "core-developer-preview" | "cloud";
export type AppKitDiagnosticSeverity = "error" | "warning" | "omitted";

export interface AppKitDiagnostic {
  code: string;
  severity: AppKitDiagnosticSeverity;
  message: string;
  capability?: string;
  resource?: string;
  owner?: "app" | "run402-core" | "run402-sdk-cli" | "cloud" | "unknown";
  nextAction?: string;
  details?: Record<string, unknown>;
}

export class AppKitError extends Error {
  readonly code = "RUN402_APP_KIT_ERROR";
  readonly diagnostics: readonly AppKitDiagnostic[];

  constructor(message: string, diagnostics: readonly AppKitDiagnostic[] = [], options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AppKitError";
    this.diagnostics = diagnostics;
  }
}

export interface AppKitFunctionConfigInput {
  timeoutSeconds?: number;
  memoryMb?: number;
  timeout_seconds?: number;
  memory_mb?: number;
}

export interface AppKitFunctionInput {
  runtime?: string;
  source?: string;
  config?: AppKitFunctionConfigInput;
  schedule?: string | null;
  deps?: string[];
  entrypoint?: string;
  files?: Record<string, unknown>;
  class?: string;
  capabilities?: string[];
  requireAuth?: boolean;
  require_auth?: boolean;
  requireRole?: unknown;
  require_role?: unknown;
}

export interface AppKitManifestFunctionSpec {
  runtime: string;
  source: { path: string };
  config?: {
    timeout_seconds?: number;
    memory_mb?: number;
  };
  deps?: string[];
  entrypoint?: string;
  files?: Record<string, unknown>;
  class?: string;
  capabilities?: string[];
  require_auth?: boolean;
  require_role?: unknown;
}

export interface MaterializeFunctionOptions {
  rootDir: string;
  outDir: string;
  targetPolicy?: AppKitTargetPolicy;
}

export interface MaterializeFunctionMapOptions extends MaterializeFunctionOptions {
  onUnsupportedFeature?: "throw" | "omit";
}

export interface MaterializedFunction {
  name: string;
  spec: AppKitManifestFunctionSpec;
  sourcePath: string;
  manifestPath: string;
  diagnostics: AppKitDiagnostic[];
}

export interface MaterializedFunctionMap {
  functions: Record<string, AppKitManifestFunctionSpec>;
  writtenFiles: string[];
  omittedFunctionNames: string[];
  diagnostics: AppKitDiagnostic[];
}

export interface AppKitLocalDirRef {
  __source: "local-dir";
  path: string;
}

export interface AppKitPublicPathsSpec {
  mode: "implicit" | "explicit";
  replace?: Record<string, { asset: string; cache_class?: string }>;
}

export interface AppKitSiteReplaceSlice {
  replace: AppKitLocalDirRef;
  public_paths?: AppKitPublicPathsSpec;
}

export interface AppKitMigrationInput {
  id: string;
  sql: string;
  transaction?: "default" | "none";
}

export interface AppKitMigrationFileInput {
  id: string;
  path: string;
  rootDir: string;
  transaction?: "default" | "none";
  embedSql?: boolean;
}

export interface AppKitManifestMigrationSpec {
  id: string;
  checksum: string;
  sql?: string;
  sql_path?: string;
  transaction?: "default" | "none";
}

export interface AppKitDatabaseSliceOptions {
  expose?: unknown;
  zero_downtime?: boolean;
}

export interface AppKitDatabaseSlice {
  migrations: AppKitManifestMigrationSpec[];
  expose?: unknown;
  zero_downtime?: boolean;
}

export interface AppKitOmittedFeatureInput {
  resource: string;
  capability: string;
  reason: string;
  owner?: AppKitDiagnostic["owner"];
  nextAction?: string;
  details?: Record<string, unknown>;
}

export interface PortableAppManifestInput {
  schema?: string;
  project_id?: string;
  idempotency_key?: string;
  database?: AppKitDatabaseSlice;
  functions?: { replace?: Record<string, AppKitManifestFunctionSpec>; patch?: unknown };
  site?: AppKitSiteReplaceSlice | Record<string, unknown>;
  routes?: Record<string, unknown>;
  secrets?: Record<string, unknown>;
  assets?: Record<string, unknown>;
  checks?: Record<string, unknown>;
  omittedFeatures?: readonly AppKitOmittedFeatureInput[];
}

export type PortableAppManifest = Record<string, unknown>;

const DEFAULT_RUNTIME = "node22";

const TOP_LEVEL_UNSUPPORTED: Record<string, Omit<AppKitDiagnostic, "resource">> = {
  subdomains: unsupported("run402.core.unsupported.managed_subdomains", "managed.subdomains", "Managed subdomains are a Run402 Cloud convenience and are omitted from Core Developer Preview."),
  custom_domains: unsupported("run402.core.unsupported.custom_domains", "managed.custom_domains", "Custom domain automation is not part of Core Developer Preview."),
  domains: unsupported("run402.core.unsupported.custom_domains", "managed.custom_domains", "Custom domain automation is not part of Core Developer Preview."),
  i18n: unsupported("run402.core.unsupported.i18n_routing", "i18n.routing", "i18n routing is not part of Core Developer Preview."),
  hosted_oauth: unsupported("run402.core.unsupported.hosted_oauth", "auth.hosted_oauth", "Hosted OAuth is not part of Core Developer Preview."),
  mailboxes: unsupported(
    "run402.core.unsupported.email_manifest",
    "email.outbound_configuration",
    "Core outbound email is configured through the gateway provider and /mailboxes/v1, not as a deploy manifest resource.",
  ),
  email: unsupported(
    "run402.core.unsupported.email_manifest",
    "email.outbound_configuration",
    "Core outbound email is configured through the gateway provider and /mailboxes/v1; managed inbound, bounce, and sender-domain operations remain Cloud-only.",
  ),
  billing: unsupported("run402.core.unsupported.billing", "billing.managed", "Managed billing is not part of Core Developer Preview."),
  monitoring: unsupported("run402.core.unsupported.monitoring", "monitoring.managed", "Managed monitoring is not part of Core Developer Preview."),
  backups: unsupported("run402.core.unsupported.backups", "backups.managed", "Managed backups are not part of Core Developer Preview."),
  compliance: unsupported("run402.core.unsupported.compliance", "compliance.managed", "Managed compliance operations are not part of Core Developer Preview."),
  fleet: unsupported("run402.core.unsupported.fleet", "fleet.operations", "Fleet operations are not part of Core Developer Preview."),
};

const NESTED_UNSUPPORTED_KEYS: Record<string, Omit<AppKitDiagnostic, "resource">> = {
  hosted_oauth: TOP_LEVEL_UNSUPPORTED.hosted_oauth,
  oauth_providers: TOP_LEVEL_UNSUPPORTED.hosted_oauth,
};

export function safeAppKitFileName(name: string, extension = ".js"): string {
  const suffix = extension.startsWith(".") ? extension : `.${extension}`;
  const base = name.trim()
    .replace(/[^a-zA-Z0-9_.-]/g, "_")
    .replace(/^\.+/, "_")
    .replace(/_+/g, "_");
  if (!base || base === "_" || base === "." || base === "..") {
    throw appKitError("Function name cannot produce a safe filename", "run402.app_kit.invalid_filename", {
      resource: name,
    });
  }
  return base.endsWith(suffix) ? base : `${base}${suffix}`;
}

export function manifestRelativePath(path: string, rootDir: string): string {
  const absoluteRoot = resolve(rootDir);
  const absolutePath = isAbsolute(path) ? resolve(path) : resolve(absoluteRoot, path);
  const rel = relative(absoluteRoot, absolutePath).replaceAll("\\", "/");
  if (!rel || rel === "." || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
    throw appKitError("Path must stay inside the manifest root", "run402.app_kit.path_outside_root", {
      resource: path,
      details: { rootDir },
    });
  }
  return rel;
}

export function localDirSiteReplace(dir: string, options: { rootDir: string }): AppKitLocalDirRef {
  return {
    __source: "local-dir",
    path: manifestRelativePath(dir, options.rootDir),
  };
}

export function siteReplaceFromLocalDir(
  dir: string,
  options: { rootDir: string; publicPaths?: AppKitPublicPathsSpec },
): AppKitSiteReplaceSlice {
  return {
    replace: localDirSiteReplace(dir, options),
    ...(options.publicPaths ? { public_paths: options.publicPaths } : {}),
  };
}

export function inlineSqlMigration(input: AppKitMigrationInput): AppKitManifestMigrationSpec {
  assertNonEmptyString(input.id, "database migration id");
  assertNonEmptyString(input.sql, `database migration ${input.id} sql`);
  return {
    id: input.id,
    checksum: sha256Hex(input.sql),
    sql: input.sql,
    ...(input.transaction ? { transaction: input.transaction } : {}),
  };
}

export function sqlFileMigration(input: AppKitMigrationFileInput): AppKitManifestMigrationSpec {
  assertNonEmptyString(input.id, "database migration id");
  assertNonEmptyString(input.path, `database migration ${input.id} path`);
  const absolutePath = resolve(input.rootDir, input.path);
  let sql: string;
  try {
    sql = readFileSync(absolutePath, "utf-8");
  } catch (err) {
    throw appKitError(
      `Failed to read database migration ${input.id}`,
      "run402.app_kit.migration_read_failed",
      { resource: input.path },
      err,
    );
  }
  assertNonEmptyString(sql, `database migration ${input.id} sql`);
  return {
    id: input.id,
    checksum: sha256Hex(sql),
    ...(input.embedSql === true
      ? { sql }
      : { sql_path: manifestRelativePath(absolutePath, input.rootDir) }),
    ...(input.transaction ? { transaction: input.transaction } : {}),
  };
}

export function databaseMigrationsSlice(
  migrations: readonly AppKitManifestMigrationSpec[],
  options: AppKitDatabaseSliceOptions = {},
): AppKitDatabaseSlice {
  if (!Array.isArray(migrations) || migrations.length === 0) {
    throw appKitError("Database slice requires at least one migration", "run402.app_kit.database_empty");
  }
  return {
    migrations: migrations.map((migration) => ({ ...migration })),
    ...(options.expose !== undefined ? { expose: options.expose } : {}),
    ...(options.zero_downtime !== undefined ? { zero_downtime: options.zero_downtime } : {}),
  };
}

export function materializeFunctionSource(
  name: string,
  input: AppKitFunctionInput,
  options: MaterializeFunctionOptions,
): MaterializedFunction {
  assertNonEmptyString(name, "function name");
  if (options.targetPolicy === "core-developer-preview" || options.targetPolicy === undefined) {
    const scheduleDiagnostic = scheduledFunctionDiagnostic(name, input.schedule);
    if (scheduleDiagnostic) {
      throw new AppKitError(`Core Developer Preview cannot include scheduled function ${name}`, [scheduleDiagnostic]);
    }
  }
  if (typeof input.source !== "string" || input.source.length === 0) {
    throw appKitError(`Function ${name} must include string source`, "run402.app_kit.function_missing_source", {
      resource: `functions.${name}`,
    });
  }

  const fileName = safeAppKitFileName(name, ".js");
  const absoluteOutDir = resolve(options.outDir);
  const absoluteSourcePath = resolve(absoluteOutDir, fileName);
  mkdirSync(absoluteOutDir, { recursive: true });
  writeFileSync(absoluteSourcePath, input.source, "utf-8");

  const manifestPath = manifestRelativePath(absoluteSourcePath, options.rootDir);
  const config = normalizeFunctionConfig(input.config, `functions.${name}.config`);
  const requireAuth = pickEquivalent(
    input.requireAuth,
    input.require_auth,
    `functions.${name}.require_auth`,
  );
  const requireRole = pickEquivalent(
    input.requireRole,
    input.require_role,
    `functions.${name}.require_role`,
  );

  const spec: AppKitManifestFunctionSpec = {
    runtime: input.runtime ?? DEFAULT_RUNTIME,
    source: { path: manifestPath },
    ...(config ? { config } : {}),
    ...(input.deps ? { deps: [...input.deps] } : {}),
    ...(input.entrypoint ? { entrypoint: input.entrypoint } : {}),
    ...(input.files ? { files: { ...input.files } } : {}),
    ...(input.class ? { class: input.class } : {}),
    ...(input.capabilities ? { capabilities: [...input.capabilities].sort() } : {}),
    ...(requireAuth !== undefined ? { require_auth: requireAuth } : {}),
    ...(requireRole !== undefined ? { require_role: requireRole } : {}),
  };

  return {
    name,
    spec,
    sourcePath: absoluteSourcePath,
    manifestPath,
    diagnostics: [],
  };
}

export function materializeFunctionManifestMap(
  functions: Record<string, AppKitFunctionInput>,
  options: MaterializeFunctionMapOptions,
): MaterializedFunctionMap {
  const out: Record<string, AppKitManifestFunctionSpec> = {};
  const writtenFiles: string[] = [];
  const omittedFunctionNames: string[] = [];
  const diagnostics: AppKitDiagnostic[] = [];

  for (const name of Object.keys(functions).sort()) {
    const input = functions[name];
    if (!input) continue;
    const scheduleDiagnostic = options.targetPolicy === "cloud"
      ? null
      : scheduledFunctionDiagnostic(name, input.schedule);
    if (scheduleDiagnostic) {
      if (options.onUnsupportedFeature === "omit") {
        omittedFunctionNames.push(name);
        diagnostics.push({
          ...scheduleDiagnostic,
          severity: "omitted",
          nextAction: "Remove this function from the Core build or deploy it to Run402 Cloud.",
        });
        continue;
      }
      throw new AppKitError(`Core Developer Preview cannot include scheduled function ${name}`, [scheduleDiagnostic]);
    }

    const materialized = materializeFunctionSource(name, input, options);
    out[name] = materialized.spec;
    writtenFiles.push(materialized.sourcePath);
    diagnostics.push(...materialized.diagnostics);
  }

  return {
    functions: out,
    writtenFiles,
    omittedFunctionNames,
    diagnostics,
  };
}

export function omittedFeatureDiagnostic(input: AppKitOmittedFeatureInput): AppKitDiagnostic {
  assertNonEmptyString(input.resource, "omitted feature resource");
  assertNonEmptyString(input.capability, "omitted feature capability");
  assertNonEmptyString(input.reason, "omitted feature reason");
  return {
    code: `run402.app_kit.omitted.${input.capability.replace(/[^a-zA-Z0-9_.-]/g, "_")}`,
    severity: "omitted",
    resource: input.resource,
    capability: input.capability,
    owner: input.owner ?? "app",
    message: input.reason,
    ...(input.nextAction ? { nextAction: input.nextAction } : {}),
    ...(input.details ? { details: { ...input.details } } : {}),
  };
}

export function omittedFeatureDiagnostics(inputs: readonly AppKitOmittedFeatureInput[]): AppKitDiagnostic[] {
  return inputs.map((input) => omittedFeatureDiagnostic(input));
}

export function diagnoseCoreDeveloperPreviewCompatibility(manifest: Record<string, unknown>): AppKitDiagnostic[] {
  const diagnostics: AppKitDiagnostic[] = [];
  for (const key of Object.keys(manifest).sort()) {
    const template = TOP_LEVEL_UNSUPPORTED[key];
    if (template && manifest[key] !== undefined) {
      diagnostics.push({ ...template, resource: key });
    }
  }

  const functions = record(manifest.functions);
  for (const section of ["replace", "patch.set"]) {
    const functionMap = section === "replace"
      ? record(functions?.replace)
      : record(record(functions?.patch)?.set);
    for (const name of Object.keys(functionMap ?? {}).sort()) {
      const diagnostic = scheduledFunctionDiagnostic(name, record(functionMap?.[name])?.schedule);
      if (diagnostic) diagnostics.push(diagnostic);
    }
  }

  collectNestedUnsupported(manifest, "$", diagnostics);
  return uniqueDiagnostics(diagnostics);
}

export function assertCoreDeveloperPreviewCompatible(manifest: Record<string, unknown>): void {
  const diagnostics = diagnoseCoreDeveloperPreviewCompatibility(manifest)
    .filter((diagnostic) => diagnostic.severity === "error");
  if (diagnostics.length > 0) {
    throw new AppKitError("Manifest uses features outside Core Developer Preview", diagnostics);
  }
}

export function buildPortableAppManifest(input: PortableAppManifestInput): PortableAppManifest {
  const manifest: PortableAppManifest = {
    ...(input.schema ? { "$schema": input.schema } : {}),
    ...(input.project_id ? { project_id: input.project_id } : {}),
    ...(input.idempotency_key ? { idempotency_key: input.idempotency_key } : {}),
    ...(input.database ? { database: input.database } : {}),
    ...(input.secrets ? { secrets: input.secrets } : {}),
    ...(input.functions ? { functions: input.functions } : {}),
    ...(input.site ? { site: input.site } : {}),
    ...(input.assets ? { assets: input.assets } : {}),
    ...(input.routes ? { routes: input.routes } : {}),
    ...(input.checks ? { checks: input.checks } : {}),
  };
  const diagnostics = input.omittedFeatures ? omittedFeatureDiagnostics(input.omittedFeatures) : [];
  if (diagnostics.length > 0) {
    manifest["x-run402-omitted_features"] = diagnostics;
  }
  return manifest;
}

export function writePortableAppManifest(path: string, manifest: Record<string, unknown>): void {
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

function normalizeFunctionConfig(
  config: AppKitFunctionConfigInput | undefined,
  resource: string,
): AppKitManifestFunctionSpec["config"] | undefined {
  if (!config) return undefined;
  const timeoutSeconds = pickEquivalent(config.timeoutSeconds, config.timeout_seconds, `${resource}.timeout_seconds`);
  const memoryMb = pickEquivalent(config.memoryMb, config.memory_mb, `${resource}.memory_mb`);
  const out = {
    ...(timeoutSeconds !== undefined ? { timeout_seconds: assertPositiveInteger(timeoutSeconds, `${resource}.timeout_seconds`) } : {}),
    ...(memoryMb !== undefined ? { memory_mb: assertPositiveInteger(memoryMb, `${resource}.memory_mb`) } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

function pickEquivalent<T>(camel: T | undefined, snake: T | undefined, resource: string): T | undefined {
  if (camel !== undefined && snake !== undefined && !Object.is(camel, snake)) {
    throw appKitError(`Conflicting values for ${resource}`, "run402.app_kit.conflicting_fields", {
      resource,
      details: { camel, snake },
    });
  }
  return camel ?? snake;
}

function assertPositiveInteger(value: number, resource: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw appKitError(`${resource} must be a positive integer`, "run402.app_kit.invalid_number", {
      resource,
      details: { value },
    });
  }
  return value;
}

function assertNonEmptyString(value: string, resource: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw appKitError(`${resource} must be a non-empty string`, "run402.app_kit.empty_string", {
      resource,
    });
  }
}

function scheduledFunctionDiagnostic(name: string, schedule: unknown): AppKitDiagnostic | null {
  if (schedule === undefined || schedule === null || schedule === false) return null;
  return {
    code: "run402.core.unsupported.scheduled_functions",
    severity: "error",
    resource: `functions.${name}.schedule`,
    capability: "functions.scheduled",
    owner: "run402-core",
    message: "Scheduled functions are not part of Core Developer Preview.",
    nextAction: "Deploy this schedule to Run402 Cloud or omit it from the Core build.",
  };
}

function unsupported(
  code: string,
  capability: string,
  message: string,
): Omit<AppKitDiagnostic, "resource"> {
  return {
    code,
    severity: "error",
    capability,
    owner: "run402-core",
    message,
  };
}

function collectNestedUnsupported(
  value: unknown,
  path: string,
  diagnostics: AppKitDiagnostic[],
): void {
  const current = record(value);
  if (!current) return;
  for (const key of Object.keys(current).sort()) {
    const childPath = path === "$" ? key : `${path}.${key}`;
    const template = NESTED_UNSUPPORTED_KEYS[key];
    if (template && current[key] !== undefined) {
      diagnostics.push({ ...template, resource: childPath });
    }
    collectNestedUnsupported(current[key], childPath, diagnostics);
  }
}

function uniqueDiagnostics(diagnostics: readonly AppKitDiagnostic[]): AppKitDiagnostic[] {
  const seen = new Set<string>();
  const out: AppKitDiagnostic[] = [];
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.code}:${diagnostic.resource ?? ""}:${diagnostic.capability ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(diagnostic);
  }
  return out;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function appKitError(
  message: string,
  code: string,
  diagnostic: Partial<AppKitDiagnostic> = {},
  cause?: unknown,
): AppKitError {
  return new AppKitError(message, [{
    code,
    severity: "error",
    message,
    ...diagnostic,
  }], cause === undefined ? undefined : { cause });
}
