import { ReleaseSpecValidationError } from "./errors.js";
import { normalizeReleaseSpec } from "./normalize.js";
import type {
  ContentRefHex,
  FileSet,
  FunctionSpec,
  MigrationSpec,
  ReleaseSpec,
  SiteSpec,
} from "./types.js";

export const TYPED_CONFIG_FILE_KIND = "run402.typed_config.file.v1" as const;
export const TYPED_CONFIG_DIR_KIND = "run402.typed_config.dir.v1" as const;
export const TYPED_CONFIG_SQL_FILE_KIND = "run402.typed_config.sql_file.v1" as const;
export const TYPED_CONFIG_NODE_FUNCTION_KIND = "run402.typed_config.node_function.v1" as const;

export interface TypedConfigFileDescriptor {
  kind: typeof TYPED_CONFIG_FILE_KIND;
  path: string;
  key?: string;
  ref?: ContentRefHex;
  contentType?: string;
}

export interface TypedConfigDirDescriptor {
  kind: typeof TYPED_CONFIG_DIR_KIND;
  path: string;
  files?: FileSet;
  includeHidden?: boolean;
  followSymlinks?: false;
  ignore?: string[];
}

export interface TypedConfigSqlFileDescriptor {
  kind: typeof TYPED_CONFIG_SQL_FILE_KIND;
  path: string;
  id?: string;
  checksum?: string;
  sql?: string;
  sql_ref?: ContentRefHex;
  transaction?: MigrationSpec["transaction"];
}

export interface TypedConfigNodeFunctionDescriptor {
  kind: typeof TYPED_CONFIG_NODE_FUNCTION_KIND;
  path: string;
  runtime?: FunctionSpec["runtime"];
  entrypoint?: string;
  source?: ContentRefHex;
  files?: FileSet;
  config?: FunctionSpec["config"];
  schedule?: string | null;
  deps?: string[];
  requireAuth?: boolean;
  requireRole?: FunctionSpec["requireRole"];
  class?: FunctionSpec["class"];
  capabilities?: string[];
  bundle?: {
    tool: string;
    version?: string;
    inputDigest?: string;
  };
}

export type TypedConfigFileSetInput =
  | FileSet
  | TypedConfigDirDescriptor
  | TypedConfigFileDescriptor
  | Record<string, ContentRefHex | TypedConfigFileDescriptor>;

export type TypedConfigMigrationInput = MigrationSpec | TypedConfigSqlFileDescriptor;
export type TypedConfigFunctionInput = FunctionSpec | TypedConfigNodeFunctionDescriptor;

export type TypedConfigSiteSpec = (
  | { replace?: TypedConfigFileSetInput; patch?: never }
  | { patch?: { put?: TypedConfigFileSetInput; delete?: string[] }; replace?: never }
) & {
  public_paths?: SiteSpec["public_paths"];
};

export interface TypedConfigDatabaseSpec extends Omit<NonNullable<ReleaseSpec["database"]>, "migrations"> {
  migrations?: TypedConfigMigrationInput[];
}

export type TypedConfigFunctionsSpec =
  | { replace?: Record<string, TypedConfigFunctionInput>; patch?: never }
  | { patch?: { set?: Record<string, TypedConfigFunctionInput>; delete?: string[] }; replace?: never };

export interface TypedConfigReleaseSpec extends Omit<ReleaseSpec, "database" | "functions" | "site"> {
  database?: TypedConfigDatabaseSpec;
  functions?: TypedConfigFunctionsSpec;
  site?: TypedConfigSiteSpec;
}

export function defineConfig<const T extends TypedConfigReleaseSpec>(config: T): T {
  return config;
}

export function file(path: string, options: Omit<TypedConfigFileDescriptor, "kind" | "path"> = {}): TypedConfigFileDescriptor {
  return {
    kind: TYPED_CONFIG_FILE_KIND,
    path,
    ...options,
  };
}

export function dir(path: string, options: Omit<TypedConfigDirDescriptor, "kind" | "path"> = {}): TypedConfigDirDescriptor {
  return {
    kind: TYPED_CONFIG_DIR_KIND,
    path,
    ...options,
  };
}

export function sqlFile(
  path: string,
  options: Omit<TypedConfigSqlFileDescriptor, "kind" | "path"> = {},
): TypedConfigSqlFileDescriptor {
  return {
    kind: TYPED_CONFIG_SQL_FILE_KIND,
    path,
    id: options.id ?? defaultIdFromPath(path),
    ...options,
  };
}

export function nodeFunction(
  path: string,
  options: Omit<TypedConfigNodeFunctionDescriptor, "kind" | "path" | "runtime"> & {
    runtime?: FunctionSpec["runtime"];
  } = {},
): TypedConfigNodeFunctionDescriptor {
  return {
    kind: TYPED_CONFIG_NODE_FUNCTION_KIND,
    path,
    runtime: options.runtime ?? "node22",
    ...options,
  };
}

export function normalizeTypedConfigReleaseSpec(input: TypedConfigReleaseSpec): ReleaseSpec {
  const out: ReleaseSpec = { project: input.project };
  if (input.idempotency_key !== undefined) out.idempotency_key = input.idempotency_key;
  if (input.base !== undefined) out.base = input.base;
  if (input.secrets !== undefined) out.secrets = input.secrets;
  if (input.subdomains !== undefined) out.subdomains = input.subdomains;
  if (input.routes !== undefined) out.routes = input.routes;
  if (input.checks !== undefined) out.checks = input.checks;
  if (input.assets !== undefined) out.assets = input.assets;
  if (input.i18n !== undefined) out.i18n = input.i18n;
  if (input.database !== undefined) out.database = normalizeTypedDatabase(input.database);
  if (input.functions !== undefined) out.functions = normalizeTypedFunctions(input.functions);
  if (input.site !== undefined) out.site = normalizeTypedSite(input.site);
  return normalizeReleaseSpec(out);
}

function normalizeTypedDatabase(input: TypedConfigDatabaseSpec): ReleaseSpec["database"] {
  return {
    ...(input.expose !== undefined ? { expose: input.expose } : {}),
    ...(input.zero_downtime !== undefined ? { zero_downtime: input.zero_downtime } : {}),
    ...(input.migrations !== undefined ? { migrations: input.migrations.map(normalizeTypedMigration) } : {}),
  };
}

function normalizeTypedMigration(input: TypedConfigMigrationInput): MigrationSpec {
  if (isSqlFileDescriptor(input)) {
    const id = input.id ?? defaultIdFromPath(input.path);
    if (!input.checksum) {
      throw invalid("database.migrations", `sqlFile('${input.path}') must be resolved with a checksum before normalization`);
    }
    const out: MigrationSpec = { id, checksum: input.checksum };
    if (input.sql !== undefined) out.sql = input.sql;
    if (input.sql_ref !== undefined) out.sql_ref = input.sql_ref;
    if (input.transaction !== undefined) out.transaction = input.transaction;
    return out;
  }
  return { ...input };
}

function normalizeTypedFunctions(input: TypedConfigFunctionsSpec): ReleaseSpec["functions"] {
  if ("patch" in input && input.patch !== undefined) {
    return {
      patch: {
        ...(input.patch.set !== undefined ? { set: normalizeFunctionMap(input.patch.set) } : {}),
        ...(input.patch.delete !== undefined ? { delete: [...input.patch.delete] } : {}),
      },
    };
  }
  return {
    replace: normalizeFunctionMap(input.replace ?? {}),
  };
}

function normalizeFunctionMap(input: Record<string, TypedConfigFunctionInput>): Record<string, FunctionSpec> {
  const out: Record<string, FunctionSpec> = {};
  for (const name of Object.keys(input).sort(compareAscii)) {
    out[name] = normalizeTypedFunction(input[name], `functions.${name}`);
  }
  return out;
}

function normalizeTypedFunction(input: TypedConfigFunctionInput, resource: string): FunctionSpec {
  if (isNodeFunctionDescriptor(input)) {
    if (input.source === undefined && input.files === undefined) {
      throw invalid(resource, `nodeFunction('${input.path}') must be resolved with source or files before normalization`);
    }
    return {
      runtime: input.runtime ?? "node22",
      ...(input.entrypoint !== undefined ? { entrypoint: input.entrypoint } : {}),
      ...(input.source !== undefined ? { source: input.source } : {}),
      ...(input.files !== undefined ? { files: normalizeFileSet(input.files, `${resource}.files`) } : {}),
      ...(input.config !== undefined ? { config: input.config } : {}),
      ...(input.schedule !== undefined ? { schedule: input.schedule } : {}),
      ...(input.deps !== undefined ? { deps: [...input.deps].sort(compareAscii) } : {}),
      ...(input.requireAuth !== undefined ? { requireAuth: input.requireAuth } : {}),
      ...(input.requireRole !== undefined ? { requireRole: input.requireRole } : {}),
      ...(input.class !== undefined ? { class: input.class } : {}),
      ...(input.capabilities !== undefined ? { capabilities: [...input.capabilities].sort(compareAscii) } : {}),
    };
  }
  return {
    ...input,
    ...(input.files !== undefined ? { files: normalizeFileSet(input.files, `${resource}.files`) } : {}),
    ...(input.deps !== undefined ? { deps: [...input.deps].sort(compareAscii) } : {}),
    ...(input.capabilities !== undefined ? { capabilities: [...input.capabilities].sort(compareAscii) } : {}),
  };
}

function normalizeTypedSite(input: TypedConfigSiteSpec): SiteSpec {
  const base = input.public_paths !== undefined ? { public_paths: input.public_paths } : {};
  if ("patch" in input && input.patch !== undefined) {
    return {
      ...base,
      patch: {
        ...(input.patch.put !== undefined ? { put: normalizeFileSet(input.patch.put, "site.patch.put") } : {}),
        ...(input.patch.delete !== undefined ? { delete: [...input.patch.delete].sort(compareAscii) } : {}),
      },
    };
  }
  return {
    ...base,
    ...(input.replace !== undefined ? { replace: normalizeFileSet(input.replace, "site.replace") } : {}),
  };
}

function normalizeFileSet(input: TypedConfigFileSetInput, resource: string): FileSet {
  if (isDirDescriptor(input)) {
    if (input.files === undefined) {
      throw invalid(resource, `dir('${input.path}') must be resolved with files before normalization`);
    }
    return normalizeFileSetRecord(input.files, resource);
  }
  if (isFileDescriptor(input)) {
    if (input.ref === undefined) {
      throw invalid(resource, `file('${input.path}') must be resolved with a content ref before normalization`);
    }
    const key = canonicalRelativeKey(input.key ?? input.path, resource);
    return { [key]: contentRefWithType(input.ref, input.contentType) };
  }
  return normalizeFileSetRecord(input, resource);
}

function normalizeFileSetRecord(input: Record<string, ContentRefHex | TypedConfigFileDescriptor>, resource: string): FileSet {
  const out: FileSet = {};
  for (const rawKey of Object.keys(input).sort(compareAscii)) {
    const value = input[rawKey];
    if (isFileDescriptor(value)) {
      if (value.ref === undefined) {
        throw invalid(`${resource}.${rawKey}`, `file('${value.path}') must be resolved with a content ref before normalization`);
      }
      out[canonicalRelativeKey(value.key ?? rawKey, `${resource}.${rawKey}`)] = contentRefWithType(value.ref, value.contentType);
    } else {
      out[canonicalRelativeKey(rawKey, `${resource}.${rawKey}`)] = { ...value };
    }
  }
  return out;
}

function contentRefWithType(ref: ContentRefHex, contentType: string | undefined): ContentRefHex {
  return {
    ...ref,
    ...(contentType !== undefined ? { contentType } : {}),
  };
}

function canonicalRelativeKey(input: string, resource: string): string {
  const normalized = input.replaceAll("\\", "/").replace(/^\.\//, "");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized.includes("\0")
  ) {
    throw invalid(resource, "typed config file paths must be relative and stay inside the manifest root");
  }
  return normalized;
}

function defaultIdFromPath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const base = normalized.split("/").filter(Boolean).at(-1) ?? normalized;
  return base.replace(/\.[^.]*$/, "") || base;
}

function isFileDescriptor(input: unknown): input is TypedConfigFileDescriptor {
  return isRecord(input) && input.kind === TYPED_CONFIG_FILE_KIND;
}

function isDirDescriptor(input: unknown): input is TypedConfigDirDescriptor {
  return isRecord(input) && input.kind === TYPED_CONFIG_DIR_KIND;
}

function isSqlFileDescriptor(input: unknown): input is TypedConfigSqlFileDescriptor {
  return isRecord(input) && input.kind === TYPED_CONFIG_SQL_FILE_KIND;
}

function isNodeFunctionDescriptor(input: unknown): input is TypedConfigNodeFunctionDescriptor {
  return isRecord(input) && input.kind === TYPED_CONFIG_NODE_FUNCTION_KIND;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function compareAscii(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function invalid(resource: string, message: string): ReleaseSpecValidationError {
  return new ReleaseSpecValidationError(resource, message);
}
