import { ReleaseSpecValidationError } from "./errors.js";
import {
  SUPPORTED_HTTP_METHODS,
  type ContentRefHex,
  type FunctionSpec,
  type I18nSpec,
  type ReleaseSpec,
  type RoleGateSpec,
  type RouteSpec,
} from "./types.js";

const TOP_LEVEL_KEYS = [
  "project",
  "idempotency_key",
  "base",
  "database",
  "functions",
  "secrets",
  "site",
  "subdomains",
  "routes",
  "checks",
  "assets",
  "i18n",
] as const;

const SHA256_HEX = /^[0-9a-f]{64}$/;
const SECRET_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
const FUNCTION_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const SUBDOMAIN_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LOCALE_TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const COOKIE_DETECT = /^cookie:[A-Za-z0-9._-]{1,128}$/;
const TOKEN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const EMAIL_TRIGGER_EVENTS = new Set(["reply_received", "delivery", "bounced", "complained"]);

export function parseReleaseSpec(input: unknown): ReleaseSpec {
  if (!isRecord(input)) {
    throw invalid("release", "ReleaseSpec must be an object");
  }
  const spec = input as unknown as ReleaseSpec;
  validateReleaseSpec(spec);
  return spec;
}

export function validateReleaseSpec(spec: ReleaseSpec): void {
  if (!isRecord(spec)) throw invalid("release", "ReleaseSpec must be an object");
  rejectUnknownKeys(spec, "", TOP_LEVEL_KEYS);
  if (typeof spec.project !== "string" || spec.project.length === 0) {
    throw invalid("project", "project is required");
  }
  validateBase(spec.base);
  validateChecks(spec.checks);
  validateDatabase(spec);
  validateFunctions(spec);
  validateSite(spec);
  validateSecrets(spec);
  validateSubdomains(spec);
  validateRoutes(spec.routes);
  validateI18n(spec.i18n);
  validateAssets(spec.assets);
}

function validateBase(base: ReleaseSpec["base"]): void {
  if (base === undefined) return;
  if (!isRecord(base)) throw invalid("base", "base must be an object");
  if ("release_id" in base) {
    rejectUnknownKeys(base, "base", ["release_id"]);
    if (typeof base.release_id !== "string" || base.release_id.length === 0) {
      throw invalid("base.release_id", "base.release_id must be a non-empty string");
    }
    return;
  }
  rejectUnknownKeys(base, "base", ["release"]);
  if (base.release !== "current" && base.release !== "empty") {
    throw invalid("base.release", "base.release must be 'current' or 'empty'");
  }
}

function validateChecks(checks: unknown): void {
  if (checks !== undefined && checks !== null) {
    throw invalid("checks", "checks is reserved and must be null or absent");
  }
}

function validateDatabase(spec: ReleaseSpec): void {
  const database = spec.database;
  if (database === undefined) return;
  if (!isRecord(database)) throw invalid("database", "database must be an object");
  rejectUnknownKeys(database, "database", ["migrations", "expose", "zero_downtime"]);
  if (database.zero_downtime !== undefined && typeof database.zero_downtime !== "boolean") {
    throw invalid("database.zero_downtime", "database.zero_downtime must be a boolean");
  }
  if (database.migrations !== undefined) {
    if (!Array.isArray(database.migrations)) {
      throw invalid("database.migrations", "database.migrations must be an array");
    }
    const seen = new Set<string>();
    for (let i = 0; i < database.migrations.length; i++) {
      const migration = database.migrations[i];
      if (!isRecord(migration)) throw invalid(`database.migrations[${i}]`, "migration must be an object");
      rejectUnknownKeys(migration, `database.migrations[${i}]`, ["id", "checksum", "sql", "sql_ref", "transaction"]);
      if (typeof migration.id !== "string" || migration.id.length === 0) {
        throw invalid(`database.migrations[${i}].id`, "migration.id must be a non-empty string");
      }
      if (seen.has(migration.id)) {
        throw invalid("database.migrations", `duplicate migration id '${migration.id}'`);
      }
      seen.add(migration.id);
      if (typeof migration.checksum !== "string" || !SHA256_HEX.test(migration.checksum)) {
        throw invalid(`database.migrations.${migration.id}.checksum`, "migration.checksum must be lowercase sha256 hex");
      }
      const hasSql = migration.sql !== undefined;
      const hasSqlRef = migration.sql_ref !== undefined;
      if (hasSql === hasSqlRef) {
        throw invalid(`database.migrations.${migration.id}`, "migration must include exactly one of sql or sql_ref");
      }
      if (hasSql && (typeof migration.sql !== "string" || migration.sql.trim() === "")) {
        throw invalid(`database.migrations.${migration.id}.sql`, "migration.sql must be non-empty");
      }
      if (hasSqlRef) validateContentRef(migration.sql_ref, `database.migrations.${migration.id}.sql_ref`);
      if (migration.transaction !== undefined && migration.transaction !== "required" && migration.transaction !== "none") {
        throw invalid(`database.migrations.${migration.id}.transaction`, "migration.transaction must be 'required' or 'none'");
      }
    }
  }
}

function validateFunctions(spec: ReleaseSpec): void {
  const functions = spec.functions;
  if (functions === undefined) return;
  if (!isRecord(functions)) throw invalid("functions", "functions must be an object");
  rejectUnknownKeys(functions, "functions", ["replace", "patch"]);
  if (functions.replace !== undefined && functions.patch !== undefined) {
    throw invalid("functions", "functions must use replace or patch, not both");
  }
  if (functions.replace !== undefined) {
    validateFunctionMap(functions.replace, "functions.replace");
  }
  if (functions.patch !== undefined) {
    if (!isRecord(functions.patch)) throw invalid("functions.patch", "functions.patch must be an object");
    rejectUnknownKeys(functions.patch, "functions.patch", ["set", "delete"]);
    if (functions.patch.set !== undefined) validateFunctionMap(functions.patch.set, "functions.patch.set");
    if (functions.patch.delete !== undefined) validateStringArray(functions.patch.delete, "functions.patch.delete", FUNCTION_NAME);
    const setNames = new Set(Object.keys(functions.patch.set ?? {}));
    const conflicting = (functions.patch.delete ?? []).filter((name) => setNames.has(name));
    if (conflicting.length > 0) {
      throw invalid("functions", `functions.patch.set and functions.patch.delete share names: ${conflicting.join(", ")}`);
    }
  }
}

function validateFunctionMap(value: unknown, resource: string): void {
  if (!isRecord(value)) throw invalid(resource, `${resource} must be an object`);
  for (const [name, fn] of Object.entries(value)) {
    if (!FUNCTION_NAME.test(name)) throw invalid(`${resource}.${name}`, `function name '${name}' is invalid`);
    validateFunctionSpec(fn as FunctionSpec, `${resource}.${name}`);
  }
}

function validateFunctionSpec(fn: FunctionSpec, resource: string): void {
  if (!isRecord(fn)) throw invalid(resource, "function spec must be an object");
  rejectUnknownKeys(fn, resource, [
    "runtime",
    "entrypoint",
    "source",
    "files",
    "config",
    "triggers",
    "schedule",
    "deps",
    "requireAuth",
    "requireRole",
    "class",
    "capabilities",
  ]);
  if (fn.runtime !== "node22") throw invalid(`${resource}.runtime`, "function runtime must be node22");
  if (fn.source !== undefined) validateContentRef(fn.source, `${resource}.source`);
  if (fn.files !== undefined) {
    if (!isRecord(fn.files)) throw invalid(`${resource}.files`, "function files must be an object");
    for (const [file, ref] of Object.entries(fn.files)) validateContentRef(ref, `${resource}.files.${file}`);
  }
  if (fn.config !== undefined) {
    if (!isRecord(fn.config)) throw invalid(`${resource}.config`, "function config must be an object");
    rejectUnknownKeys(fn.config, `${resource}.config`, ["timeoutSeconds", "memoryMb"]);
  }
  if (fn.triggers !== undefined) validateFunctionTriggers(fn.triggers, `${resource}.triggers`);
  if (fn.schedule !== undefined && fn.schedule !== null && typeof fn.schedule !== "string") {
    throw invalid(`${resource}.schedule`, "function schedule must be a string or null");
  }
  if (fn.deps !== undefined) validateStringArray(fn.deps, `${resource}.deps`);
  if (fn.requireAuth !== undefined && typeof fn.requireAuth !== "boolean") {
    throw invalid(`${resource}.requireAuth`, "requireAuth must be a boolean");
  }
  if (fn.requireRole !== undefined && fn.requireRole !== null) validateRoleGate(fn.requireRole, `${resource}.requireRole`);
  if (fn.class !== undefined && fn.class !== "standard" && fn.class !== "ssr") {
    throw invalid(`${resource}.class`, "function class must be standard or ssr");
  }
  if (fn.capabilities !== undefined) validateStringArray(fn.capabilities, `${resource}.capabilities`);
}

function validateFunctionTriggers(value: unknown, resource: string): void {
  if (!Array.isArray(value)) throw invalid(resource, "function triggers must be an array");
  const seen = new Set<string>();
  for (let i = 0; i < value.length; i++) {
    const trigger = value[i];
    const path = `${resource}[${i}]`;
    if (!isRecord(trigger)) throw invalid(path, "function trigger must be an object");
    rejectUnknownKeys(trigger, path, ["id", "type", "cron", "timezone", "misfire_policy", "overlap_policy", "mailbox", "events", "run"]);
    if (typeof trigger.id !== "string" || trigger.id.length === 0) {
      throw invalid(`${path}.id`, "function trigger id is required");
    }
    if (seen.has(trigger.id)) throw invalid(`${path}.id`, `duplicate function trigger id '${trigger.id}'`);
    seen.add(trigger.id);
    if (trigger.type === "schedule") {
      if (trigger.mailbox !== undefined || trigger.events !== undefined) {
        throw invalid(path, "schedule triggers cannot include mailbox or events");
      }
      if (typeof trigger.cron !== "string" || trigger.cron.trim().split(/\s+/).length !== 5) {
        throw invalid(`${path}.cron`, "function trigger cron must be a 5-field string");
      }
      if (trigger.timezone !== undefined && typeof trigger.timezone !== "string") {
        throw invalid(`${path}.timezone`, "function trigger timezone must be a string");
      }
      if (trigger.misfire_policy !== undefined && trigger.misfire_policy !== "skip") {
        throw invalid(`${path}.misfire_policy`, "function trigger misfire_policy must be skip");
      }
      if (trigger.overlap_policy !== undefined && trigger.overlap_policy !== "allow") {
        throw invalid(`${path}.overlap_policy`, "function trigger overlap_policy must be allow");
      }
    } else if (trigger.type === "email") {
      if (
        trigger.cron !== undefined ||
        trigger.timezone !== undefined ||
        trigger.misfire_policy !== undefined ||
        trigger.overlap_policy !== undefined
      ) {
        throw invalid(path, "email triggers cannot include schedule fields");
      }
      if (typeof trigger.mailbox !== "string" || trigger.mailbox.length === 0) {
        throw invalid(`${path}.mailbox`, "function trigger mailbox is required");
      }
      if (!Array.isArray(trigger.events) || trigger.events.length === 0) {
        throw invalid(`${path}.events`, "function trigger events must be a non-empty array");
      }
      for (let j = 0; j < trigger.events.length; j++) {
        if (!EMAIL_TRIGGER_EVENTS.has(String(trigger.events[j]))) {
          throw invalid(`${path}.events[${j}]`, "function trigger event must be reply_received, delivery, bounced, or complained");
        }
      }
    } else {
      throw invalid(`${path}.type`, "function trigger type must be schedule or email");
    }
    if (!isRecord(trigger.run)) throw invalid(`${path}.run`, "function trigger run must be an object");
    rejectUnknownKeys(trigger.run, `${path}.run`, ["event_type", "payload", "retry", "expires_after_seconds"]);
    if (typeof trigger.run.event_type !== "string" || trigger.run.event_type.length === 0) {
      throw invalid(`${path}.run.event_type`, "function trigger run.event_type is required");
    }
    if (trigger.run.payload !== undefined && !isRecord(trigger.run.payload)) {
      throw invalid(`${path}.run.payload`, "function trigger run.payload must be an object");
    }
    if (trigger.run.retry !== undefined && !isRecord(trigger.run.retry)) {
      throw invalid(`${path}.run.retry`, "function trigger run.retry must be an object");
    }
    if (
      trigger.run.expires_after_seconds !== undefined &&
      (typeof trigger.run.expires_after_seconds !== "number" ||
        !Number.isInteger(trigger.run.expires_after_seconds) ||
        trigger.run.expires_after_seconds <= 0)
    ) {
      throw invalid(`${path}.run.expires_after_seconds`, "function trigger run.expires_after_seconds must be a positive integer");
    }
  }
}

function validateRoleGate(gate: RoleGateSpec, resource: string): void {
  if (!isRecord(gate)) throw invalid(resource, "requireRole must be an object");
  rejectUnknownKeys(gate, resource, ["table", "idColumn", "roleColumn", "allowed", "cacheTtl", "onDeny", "signInPath"]);
  for (const key of ["table", "idColumn", "roleColumn"] as const) {
    if (typeof gate[key] !== "string" || !SQL_IDENTIFIER.test(gate[key])) {
      throw invalid(`${resource}.${key}`, `${key} must be a SQL identifier`);
    }
  }
  validateStringArray(gate.allowed, `${resource}.allowed`);
}

function validateSite(spec: ReleaseSpec): void {
  const site = spec.site;
  if (site === undefined) return;
  if (!isRecord(site)) throw invalid("site", "site must be an object");
  rejectUnknownKeys(site, "site", ["replace", "patch", "public_paths"]);
  if (site.replace !== undefined && site.patch !== undefined) {
    throw invalid("site", "site must use replace or patch, not both");
  }
  if (site.replace !== undefined) validateFileSet(site.replace, "site.replace");
  if (site.patch !== undefined) {
    if (!isRecord(site.patch)) throw invalid("site.patch", "site.patch must be an object");
    rejectUnknownKeys(site.patch, "site.patch", ["put", "delete"]);
    if (site.patch.put !== undefined) validateFileSet(site.patch.put, "site.patch.put");
    if (site.patch.delete !== undefined) validateStringArray(site.patch.delete, "site.patch.delete");
    const putPaths = new Set(Object.keys(site.patch.put ?? {}));
    const conflicting = (site.patch.delete ?? []).filter((item) => putPaths.has(item));
    if (conflicting.length > 0) throw invalid("site", `site.patch.put and site.patch.delete share paths: ${conflicting.join(", ")}`);
  }
  if (site.public_paths !== undefined) {
    if (!isRecord(site.public_paths)) throw invalid("site.public_paths", "site.public_paths must be an object");
    rejectUnknownKeys(site.public_paths, "site.public_paths", ["mode", "replace"]);
    if (site.public_paths.mode !== "implicit" && site.public_paths.mode !== "explicit") {
      throw invalid("site.public_paths.mode", "site.public_paths.mode must be implicit or explicit");
    }
    if (site.public_paths.mode === "explicit") {
      if (!isRecord(site.public_paths.replace)) {
        throw invalid("site.public_paths.replace", "explicit site.public_paths requires a replace table");
      }
    } else if (site.public_paths.replace !== undefined) {
      throw invalid("site.public_paths.replace", "site.public_paths.replace is only valid when mode is explicit");
    }
    if (site.public_paths.replace !== undefined) {
      for (const [publicPath, entry] of Object.entries(site.public_paths.replace)) {
        if (!publicPath.startsWith("/") || publicPath.includes("?") || publicPath.includes("#")) {
          throw invalid(`site.public_paths.replace.${publicPath}`, "public path must start with / and omit query strings and fragments");
        }
        if (!isRecord(entry)) throw invalid(`site.public_paths.replace.${publicPath}`, "public path entry must be an object");
        rejectUnknownKeys(entry, `site.public_paths.replace.${publicPath}`, ["asset", "cache_class"]);
        if (typeof entry.asset !== "string" || entry.asset.length === 0 || entry.asset.startsWith("/")) {
          throw invalid(`site.public_paths.replace.${publicPath}.asset`, "public path asset must be a relative file path");
        }
        if (
          entry.cache_class !== undefined &&
          entry.cache_class !== "html" &&
          entry.cache_class !== "immutable_versioned" &&
          entry.cache_class !== "revalidating_asset"
        ) {
          throw invalid(`site.public_paths.replace.${publicPath}.cache_class`, "cache_class must be html, immutable_versioned, or revalidating_asset");
        }
      }
    }
  }
}

function validateFileSet(value: unknown, resource: string): void {
  if (!isRecord(value)) throw invalid(resource, `${resource} must be an object`);
  for (const [filePath, ref] of Object.entries(value)) {
    if (filePath.startsWith("/") || filePath.length === 0) throw invalid(`${resource}.${filePath}`, "site file paths must be relative");
    validateContentRef(ref, `${resource}.${filePath}`);
  }
}

function validateSecrets(spec: ReleaseSpec): void {
  const secrets = spec.secrets;
  if (secrets === undefined) return;
  if (!isRecord(secrets)) throw invalid("secrets", "secrets must be an object");
  rejectUnknownKeys(secrets, "secrets", ["require", "delete"]);
  if (secrets.require !== undefined) validateStringArray(secrets.require, "secrets.require", SECRET_NAME);
  if (secrets.delete !== undefined) validateStringArray(secrets.delete, "secrets.delete", SECRET_NAME);
  const required = new Set(secrets.require ?? []);
  const conflicting = (secrets.delete ?? []).filter((item) => required.has(item));
  if (conflicting.length > 0) throw invalid("secrets", `secrets.require and secrets.delete share keys: ${conflicting.join(", ")}`);
}

function validateSubdomains(spec: ReleaseSpec): void {
  const subdomains = spec.subdomains;
  if (subdomains === undefined) return;
  if (!isRecord(subdomains)) throw invalid("subdomains", "subdomains must be an object");
  rejectUnknownKeys(subdomains, "subdomains", ["set", "add", "remove"]);
  if (subdomains.set !== undefined) validateStringArray(subdomains.set, "subdomains.set", SUBDOMAIN_NAME);
  if (subdomains.add !== undefined) validateStringArray(subdomains.add, "subdomains.add", SUBDOMAIN_NAME);
  if (subdomains.remove !== undefined) validateStringArray(subdomains.remove, "subdomains.remove", SUBDOMAIN_NAME);
  const add = new Set(subdomains.add ?? []);
  const conflicting = (subdomains.remove ?? []).filter((item) => add.has(item));
  if (conflicting.length > 0) throw invalid("subdomains", `subdomains.add and subdomains.remove share names: ${conflicting.join(", ")}`);
}

function validateRoutes(routes: ReleaseSpec["routes"]): void {
  if (routes === undefined || routes === null) return;
  if (!isRecord(routes)) throw invalid("routes", "routes must be null or an object");
  rejectUnknownKeys(routes, "routes", ["replace"]);
  if (!Array.isArray(routes.replace)) throw invalid("routes.replace", "routes.replace must be an array");
  for (let i = 0; i < routes.replace.length; i++) validateRouteSpec(routes.replace[i], `routes.replace.${i}`);
}

function validateRouteSpec(route: RouteSpec, resource: string): void {
  if (!isRecord(route)) throw invalid(resource, "route must be an object");
  rejectUnknownKeys(route, resource, ["pattern", "methods", "target"]);
  if (typeof route.pattern !== "string" || !route.pattern.startsWith("/")) {
    throw invalid(`${resource}.pattern`, "route pattern must start with /");
  }
  if (route.methods !== undefined) {
    validateStringArray(route.methods, `${resource}.methods`);
    const supported = new Set<string>(SUPPORTED_HTTP_METHODS);
    for (const method of route.methods) if (!supported.has(method)) throw invalid(`${resource}.methods`, `unsupported method ${method}`);
  }
  if (!isRecord(route.target)) throw invalid(`${resource}.target`, "route target must be an object");
  if (route.target.type === "function") {
    if (typeof route.target.name !== "string" || route.target.name.length === 0) {
      throw invalid(`${resource}.target.name`, "function route target requires name");
    }
  } else if (route.target.type === "static") {
    if (typeof route.target.file !== "string" || route.target.file.length === 0) {
      throw invalid(`${resource}.target.file`, "static route target requires file");
    }
  } else {
    throw invalid(`${resource}.target.type`, "route target type must be function or static");
  }
}

function validateI18n(i18n: I18nSpec | null | undefined): void {
  if (i18n === undefined || i18n === null) return;
  if (!isRecord(i18n)) throw invalid("i18n", "i18n must be null or an object");
  rejectUnknownKeys(i18n, "i18n", ["defaultLocale", "locales", "detect", "unknownLocalePolicy"]);
  if (typeof i18n.defaultLocale !== "string" || !LOCALE_TAG.test(i18n.defaultLocale)) {
    throw invalid("i18n.defaultLocale", "i18n.defaultLocale must be a locale tag");
  }
  validateStringArray(i18n.locales, "i18n.locales", LOCALE_TAG);
  if (!i18n.locales.includes(i18n.defaultLocale)) {
    throw invalid("i18n.defaultLocale", "i18n.defaultLocale must be present in i18n.locales");
  }
  if (i18n.detect !== undefined) {
    validateStringArray(i18n.detect, "i18n.detect");
    for (const source of i18n.detect) {
      if (source !== "accept-language" && !COOKIE_DETECT.test(source)) {
        throw invalid("i18n.detect", `invalid detect source '${source}'`);
      }
    }
  }
  if (i18n.unknownLocalePolicy !== undefined && i18n.unknownLocalePolicy !== "reject" && i18n.unknownLocalePolicy !== "pass-through") {
    throw invalid("i18n.unknownLocalePolicy", "unknownLocalePolicy must be reject or pass-through");
  }
}

function validateAssets(assets: ReleaseSpec["assets"]): void {
  if (assets === undefined) return;
  if (!isRecord(assets)) throw invalid("assets", "assets must be an object");
  rejectUnknownKeys(assets, "assets", ["put", "delete", "sync"]);
}

function validateContentRef(value: unknown, resource: string): void {
  if (!isRecord(value)) throw invalid(resource, "content ref must be an object");
  const ref = value as unknown as ContentRefHex;
  if (typeof ref.sha256 !== "string" || !SHA256_HEX.test(ref.sha256)) {
    throw invalid(`${resource}.sha256`, "sha256 must be lowercase sha256 hex");
  }
  if (typeof ref.size !== "number" || !Number.isInteger(ref.size) || ref.size < 0) {
    throw invalid(`${resource}.size`, "size must be a non-negative integer");
  }
  if (ref.contentType !== undefined && (typeof ref.contentType !== "string" || !isContentType(ref.contentType))) {
    throw invalid(`${resource}.contentType`, "contentType must be a MIME type");
  }
}

function isContentType(value: string): boolean {
  if (value.length === 0 || /[\u0000-\u001f\u007f]/.test(value)) return false;
  const [rawMediaType = "", ...params] = value.split(";");
  const mediaType = rawMediaType.trim();
  const slashIndex = mediaType.indexOf("/");
  if (slashIndex <= 0 || slashIndex !== mediaType.lastIndexOf("/") || slashIndex === mediaType.length - 1) {
    return false;
  }
  if (!TOKEN.test(mediaType.slice(0, slashIndex)) || !TOKEN.test(mediaType.slice(slashIndex + 1))) {
    return false;
  }
  for (const rawParam of params) {
    const param = rawParam.trim();
    const eqIndex = param.indexOf("=");
    if (eqIndex <= 0) return false;
    const name = param.slice(0, eqIndex).trim();
    const paramValue = param.slice(eqIndex + 1).trim();
    if (!TOKEN.test(name)) return false;
    if (paramValue.startsWith("\"")) {
      if (!isQuotedString(paramValue)) return false;
    } else if (!TOKEN.test(paramValue)) {
      return false;
    }
  }
  return true;
}

function isQuotedString(value: string): boolean {
  if (value.length < 2 || !value.endsWith("\"")) return false;
  for (let i = 1; i < value.length - 1; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0x22 || code === 0x7f || code < 0x20 || code > 0x7e) return false;
    if (code === 0x5c) {
      i += 1;
      if (i >= value.length - 1) return false;
      const escaped = value.charCodeAt(i);
      if (escaped < 0x20 || escaped > 0x7e || escaped === 0x7f) return false;
    }
  }
  return true;
}

function validateStringArray(value: unknown, resource: string, regex?: RegExp): asserts value is string[] {
  if (!Array.isArray(value)) throw invalid(resource, `${resource} must be an array`);
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (typeof item !== "string" || (regex && !regex.test(item))) {
      throw invalid(`${resource}[${i}]`, `${resource} entries must be valid strings`);
    }
  }
}

function rejectUnknownKeys(obj: unknown, resource: string, allowed: readonly string[]): void {
  if (!isRecord(obj)) return;
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      const path = resource === "" ? key : `${resource}.${key}`;
      throw invalid(path, `unknown key '${key}' (allowed: ${allowed.join(", ")})`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(resource: string, message: string): ReleaseSpecValidationError {
  return new ReleaseSpecValidationError(resource, message);
}
