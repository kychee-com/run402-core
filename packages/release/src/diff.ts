import { buildStaticManifestFromPortableState } from "./materialize.js";
import { normalizeFunctionTriggers } from "./normalize.js";
import { sortRouteEntries } from "./routes.js";
import {
  collectLegacyImmutableRisks,
  detectPreviousImmutableViolations,
  isDirectStaticManifestEntry,
  staticManifestEntryAssetPath,
  staticManifestPublicPathMode,
} from "./static-manifest.js";
import {
  ROUTE_TABLE_LIMIT,
} from "./routes.js";
import type {
  ContentRefHex,
  HttpMethod,
  PortableFunctionEntry,
  PortableReleaseState,
  ReleaseSpec,
  RouteEntry,
} from "./types.js";
import { SUPPORTED_HTTP_METHODS } from "./types.js";

export const PLAN_BUCKET_DEFAULT_CAP = 1_000;
export const RELEASE_DIFF_BUCKET_DEFAULT_CAP = 1_000;
export const SITE_BULK_REMOVAL_THRESHOLD = 0.10;

export interface PlanMigrationDelta {
  new: Array<{
    id: string;
    checksum_hex: string;
    transaction: "default" | "none";
  }>;
  noop: Array<{
    id: string;
    checksum_hex: string;
  }>;
}

export interface PlanDiffEnvelope {
  is_noop: boolean;
  summary: string;
  warnings: CoreWarningEntry[];
  migrations: PlanMigrationDelta;
  site: SiteDiff;
  functions: FunctionsDiff;
  secrets: SecretsDiff;
  subdomains: SubdomainsDiff;
  routes: RoutesDiff;
  static_assets: StaticAssetsDiff;
}

export interface ReleaseDiffEnvelope {
  is_noop: boolean;
  summary: string;
  warnings: CoreWarningEntry[];
  migrations: {
    applied_between_releases: string[];
  };
  site: SiteDiff;
  functions: FunctionsDiff;
  secrets: SecretsDiff;
  subdomains: SubdomainsDiff;
  routes: RoutesDiff;
  static_assets: StaticAssetsDiff;
}

export interface SiteDiff {
  added: Array<{
    path: string;
    sha256: string;
    content_type: string;
  }>;
  removed: string[];
  changed: Array<{
    path: string;
    sha256_old: string;
    sha256_new: string;
    content_type_old: string;
    content_type_new: string;
    content_type_inferred?: true;
  }>;
  totals?: { added: number; removed: number; changed: number };
}

export interface FunctionsDiff {
  added: string[];
  removed: string[];
  changed: Array<{
    name: string;
    fields_changed: Array<
      | "code_hash"
      | "runtime"
      | "timeout_seconds"
      | "memory_mb"
      | "schedule"
      | "triggers"
      | "deps"
    >;
  }>;
}

export interface SecretsDiff {
  added: string[];
  removed: string[];
}

export interface SubdomainsDiff {
  added: string[];
  removed: string[];
}

export interface RoutesDiff {
  added: RouteEntry[];
  removed: string[];
  changed: Array<{
    pattern: string;
    fields_changed: Array<"target" | "methods" | "pricing">;
    target_old?: RouteEntry["target"];
    target_new?: RouteEntry["target"];
    methods_old?: RouteEntry["methods"];
    methods_new?: RouteEntry["methods"];
    pricing_old?: RouteEntry["pricing"];
    pricing_new?: RouteEntry["pricing"];
  }>;
}

export interface StaticAssetsDiff {
  unchanged: number;
  changed: number;
  added: number;
  removed: number;
  newly_uploaded_cas_bytes: number;
  reused_cas_bytes: number;
  deployment_copy_bytes_eliminated: number;
  legacy_immutable_warnings: Array<{
    path: string;
    sha256: string;
    reason: string;
  }>;
  previous_immutable_failures: Array<{
    path: string;
    previous_sha256: string;
    candidate_sha256: string;
  }>;
}

export interface CoreWarningEntry {
  code: `RUN402_CORE_${string}`;
  severity: "info" | "warn" | "high";
  message: string;
  affected: string[];
  requires_confirmation: boolean;
  confidence?: "heuristic";
  details?: Record<string, unknown>;
}

export type EffectRequirement =
  | { kind: "content-required"; sha256: string; size: number; content_type?: string }
  | { kind: "migration-required"; migration_id: string; checksum_hex: string; transaction: "default" | "none" }
  | { kind: "function-change"; name: string; operation: "set" | "delete" }
  | { kind: "route-change" }
  | { kind: "static-site-change" };

export function computeReleaseDiff(
  from: PortableReleaseState,
  to: PortableReleaseState,
  options: {
    plan_migrations?: PlanMigrationDelta;
    site_cap?: number;
    include_core_warnings?: boolean;
    spec?: ReleaseSpec;
  } = {},
): PlanDiffEnvelope | ReleaseDiffEnvelope {
  const siteCap = options.site_cap ?? PLAN_BUCKET_DEFAULT_CAP;

  const site = computeSiteDiff(from, to, siteCap);
  const functions = computeFunctionsDiff(from, to);
  const secrets = computeSecretsDiff(from, to);
  const subdomains = computeSubdomainsDiff(from, to);
  const routes = computeRoutesDiff(from, to);
  const staticAssets = computeStaticAssetsDiff(from, to);

  const isNoop = isDiffNoop(site, functions, secrets, subdomains, routes);
  const base = {
    site,
    functions,
    secrets,
    subdomains,
    routes,
    static_assets: staticAssets,
  };

  if (options.plan_migrations) {
    const isNoopWithMigrations =
      isNoop && options.plan_migrations.new.length === 0;
    const envelope: PlanDiffEnvelope = {
      is_noop: isNoopWithMigrations,
      summary: renderSummary(options.plan_migrations, site, functions, secrets, subdomains, routes),
      warnings: [],
      migrations: options.plan_migrations,
      ...base,
    };
    envelope.warnings = options.include_core_warnings
      ? deriveCoreWarnings({ from, to, diff: envelope, spec: options.spec })
      : [];
    return envelope;
  }

  const fromIds = new Set(from.migrations.map((migration) => migration.migration_id));
  const appliedBetween = to.migrations
    .filter((migration) => !fromIds.has(migration.migration_id))
    .map((migration) => migration.migration_id)
    .sort(compareAscii);
  const isNoopWithMigrations = isNoop && appliedBetween.length === 0;
  const envelope: ReleaseDiffEnvelope = {
    is_noop: isNoopWithMigrations,
    summary: renderSummaryReleaseDiff(appliedBetween.length, site, functions, secrets, subdomains, routes),
    warnings: [],
    migrations: { applied_between_releases: appliedBetween },
    ...base,
  };
  envelope.warnings = options.include_core_warnings
    ? deriveCoreWarnings({ from, to, diff: envelope, spec: options.spec })
    : [];
  return envelope;
}

export function derivePlanMigrations(base: PortableReleaseState, spec: ReleaseSpec): PlanMigrationDelta {
  const result: PlanMigrationDelta = { new: [], noop: [] };
  for (const migration of spec.database?.migrations ?? []) {
    const checksum = migration.checksum.toLowerCase();
    const existing = base.migrations.find(
      (entry) =>
        entry.migration_id === migration.id &&
        entry.checksum_hex.toLowerCase() === checksum,
    );
    if (existing) {
      result.noop.push({ id: migration.id, checksum_hex: checksum });
    } else {
      result.new.push({
        id: migration.id,
        checksum_hex: checksum,
        transaction: migration.transaction === "none" ? "none" : "default",
      });
    }
  }
  result.new.sort((a, b) => compareAscii(a.id, b.id));
  result.noop.sort((a, b) => compareAscii(a.id, b.id));
  return result;
}

export function deriveReleaseRequirements(input: {
  spec: ReleaseSpec;
  from?: PortableReleaseState | null;
  to?: PortableReleaseState | null;
}): EffectRequirement[] {
  const requirements: EffectRequirement[] = [];
  for (const ref of collectContentRefsFromSpec(input.spec)) {
    requirements.push({
      kind: "content-required",
      sha256: ref.sha256.toLowerCase(),
      size: ref.size,
      ...(ref.contentType ? { content_type: ref.contentType } : {}),
    });
  }
  for (const migration of input.spec.database?.migrations ?? []) {
    requirements.push({
      kind: "migration-required",
      migration_id: migration.id,
      checksum_hex: migration.checksum.toLowerCase(),
      transaction: migration.transaction === "none" ? "none" : "default",
    });
  }
  if (input.spec.functions?.replace) {
    const next = new Set(Object.keys(input.spec.functions.replace));
    for (const name of [...next].sort(compareAscii)) {
      requirements.push({ kind: "function-change", name, operation: "set" });
    }
    for (const fn of input.from?.functions ?? []) {
      if (!next.has(fn.name)) {
        requirements.push({ kind: "function-change", name: fn.name, operation: "delete" });
      }
    }
  }
  if (input.spec.functions?.patch?.set) {
    for (const name of Object.keys(input.spec.functions.patch.set).sort(compareAscii)) {
      requirements.push({ kind: "function-change", name, operation: "set" });
    }
  }
  if (input.spec.functions?.patch?.delete) {
    for (const name of [...input.spec.functions.patch.delete].sort(compareAscii)) {
      requirements.push({ kind: "function-change", name, operation: "delete" });
    }
  }
  if (input.spec.routes !== undefined && input.spec.routes !== null) {
    requirements.push({ kind: "route-change" });
  }
  if (input.spec.site !== undefined) {
    requirements.push({ kind: "static-site-change" });
  }
  return sortRequirements(requirements);
}

export function deriveCoreWarnings(input: {
  from: PortableReleaseState;
  to: PortableReleaseState;
  diff: PlanDiffEnvelope | ReleaseDiffEnvelope;
  spec?: ReleaseSpec;
}): CoreWarningEntry[] {
  const warnings: CoreWarningEntry[] = [];
  const add = (warning: CoreWarningEntry): void => {
    warnings.push(warning);
  };

  if (input.diff.functions.removed.length > 0) {
    add({
      code: "RUN402_CORE_DESTRUCTIVE_FUNCTION_REMOVAL",
      severity: "high",
      requires_confirmation: true,
      message: "This release removes deployed functions.",
      affected: input.diff.functions.removed,
    });
  }
  if (input.diff.subdomains.removed.length > 0) {
    add({
      code: "RUN402_CORE_DESTRUCTIVE_SUBDOMAIN_REMOVAL",
      severity: "high",
      requires_confirmation: true,
      message: "This release removes subdomain bindings.",
      affected: input.diff.subdomains.removed,
    });
  }
  if (input.diff.secrets.removed.length > 0) {
    add({
      code: "RUN402_CORE_DESTRUCTIVE_SECRET_REMOVAL",
      severity: "warn",
      requires_confirmation: true,
      message: "This release removes required secret keys.",
      affected: input.diff.secrets.removed,
    });
  }
  if (isBulkSiteRemoval(input.from, input.diff)) {
    add({
      code: "RUN402_CORE_DESTRUCTIVE_SITE_BULK_REMOVAL",
      severity: "high",
      requires_confirmation: true,
      message: "This release removes more than ten percent of current site paths.",
      affected: input.diff.site.removed,
    });
  }
  const entrypointsRemoved = input.diff.site.removed.filter(
    (path) => path === "index.html" || path === "/index.html" || path === "_worker.js" || path === "/_worker.js",
  );
  if (entrypointsRemoved.length > 0) {
    add({
      code: "RUN402_CORE_SITE_ENTRYPOINT_REMOVED",
      severity: "warn",
      requires_confirmation: true,
      message: "This release removes site entrypoint files.",
      affected: entrypointsRemoved,
    });
  }
  if (input.from.site.paths.length > 0 && input.to.site.paths.length === 0) {
    add({
      code: "RUN402_CORE_ZERO_SITE_FILES_AFTER",
      severity: "high",
      requires_confirmation: true,
      message: "This release leaves the app with zero site files.",
      affected: [],
    });
  }
  if (input.from.functions.length > 0 && input.to.functions.length === 0) {
    add({
      code: "RUN402_CORE_ZERO_FUNCTIONS_AFTER",
      severity: "high",
      requires_confirmation: true,
      message: "This release leaves the app with zero functions.",
      affected: [],
    });
  }
  if (input.from.subdomains.names.length > 0 && input.to.subdomains.names.length === 0) {
    add({
      code: "RUN402_CORE_ZERO_SUBDOMAINS_AFTER",
      severity: "warn",
      requires_confirmation: true,
      message: "This release leaves the app with zero subdomains.",
      affected: [],
    });
  }
  if ("new" in input.diff.migrations) {
    const nonTransactional = input.diff.migrations.new
      .filter((migration) => migration.transaction === "none")
      .map((migration) => migration.id);
    if (nonTransactional.length > 0) {
      add({
        code: "RUN402_CORE_MIGRATION_NON_TRANSACTIONAL",
        severity: "warn",
        requires_confirmation: true,
        message: "This release includes migrations that run outside the activation transaction.",
        affected: nonTransactional,
      });
    }
  }
  if (input.diff.site.totals) {
    add({
      code: "RUN402_CORE_DIFF_TRUNCATED",
      severity: "info",
      requires_confirmation: false,
      message: "Some diff buckets were truncated.",
      affected: ["site"],
      details: { site: input.diff.site.totals },
    });
  }
  const unreachableHtml = collectUnreachableHtmlWarning(input.to);
  if (unreachableHtml) add(unreachableHtml);
  warnings.push(...collectRouteCoreWarnings(input));
  if (input.spec && "new" in input.diff.migrations) {
    warnings.push(
      ...collectMigrationSqlHeuristicWarnings(
        input.spec,
        new Set(input.diff.migrations.new.map((migration) => migration.id)),
      ),
    );
  }
  return sortWarnings(warnings);
}

export function collectContentRefsFromSpec(
  spec: ReleaseSpec,
  manifestRef?: ContentRefHex,
): ContentRefHex[] {
  const out: ContentRefHex[] = [];
  if (manifestRef) out.push(manifestRef);
  if (spec.database?.migrations) {
    for (const migration of spec.database.migrations) {
      if (migration.sql_ref) out.push(migration.sql_ref);
    }
  }
  if (spec.functions?.replace) {
    for (const fn of Object.values(spec.functions.replace)) collectFunctionContentRefs(out, fn);
  }
  if (spec.functions?.patch?.set) {
    for (const fn of Object.values(spec.functions.patch.set)) collectFunctionContentRefs(out, fn);
  }
  if (spec.site && "replace" in spec.site && spec.site.replace) {
    for (const ref of Object.values(spec.site.replace)) out.push(ref);
  }
  if (spec.site && "patch" in spec.site && spec.site.patch?.put) {
    for (const ref of Object.values(spec.site.patch.put)) out.push(ref);
  }
  if (spec.assets?.put) {
    for (const entry of spec.assets.put) {
      out.push({
        sha256: entry.sha256,
        size: entry.size_bytes,
        ...(entry.content_type ? { contentType: entry.content_type } : {}),
      });
    }
  }
  const seen = new Set<string>();
  return out.filter((ref) => {
    const key = ref.sha256.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function collectFunctionContentRefs(out: ContentRefHex[], fn: { source?: ContentRefHex; files?: Record<string, ContentRefHex> }): void {
  if (fn.source) out.push(fn.source);
  if (fn.files) for (const ref of Object.values(fn.files)) out.push(ref);
}

function computeSiteDiff(
  from: PortableReleaseState,
  to: PortableReleaseState,
  cap: number,
): SiteDiff {
  const fromByPath = new Map(from.site.paths.map((path) => [path.path, path]));
  const toByPath = new Map(to.site.paths.map((path) => [path.path, path]));

  const added: SiteDiff["added"] = [];
  const removed: string[] = [];
  const changed: SiteDiff["changed"] = [];

  for (const [path, toEntry] of toByPath) {
    const fromEntry = fromByPath.get(path);
    if (!fromEntry) {
      added.push({
        path,
        sha256: toEntry.content_sha256,
        content_type: toEntry.content_type,
      });
    } else if (fromEntry.content_sha256 !== toEntry.content_sha256) {
      changed.push({
        path,
        sha256_old: fromEntry.content_sha256,
        sha256_new: toEntry.content_sha256,
        content_type_old: fromEntry.content_type,
        content_type_new: toEntry.content_type,
      });
    }
  }
  for (const [path] of fromByPath) {
    if (!toByPath.has(path)) removed.push(path);
  }

  added.sort((a, b) => compareAscii(a.path, b.path));
  removed.sort(compareAscii);
  changed.sort((a, b) => compareAscii(a.path, b.path));

  const totalAdded = added.length;
  const totalRemoved = removed.length;
  const totalChanged = changed.length;

  return {
    added: added.slice(0, cap),
    removed: removed.slice(0, cap),
    changed: changed.slice(0, cap),
    totals:
      totalAdded > cap || totalRemoved > cap || totalChanged > cap
        ? {
            added: totalAdded,
            removed: totalRemoved,
            changed: totalChanged,
          }
        : undefined,
  };
}

function computeStaticAssetsDiff(
  from: PortableReleaseState,
  to: PortableReleaseState,
): StaticAssetsDiff {
  const fromByPath = new Map(from.site.paths.map((path) => [path.path, path]));
  const toByPath = new Map(to.site.paths.map((path) => [path.path, path]));
  let unchanged = 0;
  let changed = 0;
  let added = 0;
  let removed = 0;
  let newlyUploadedCasBytes = 0;
  let reusedCasBytes = 0;

  for (const [path, toEntry] of toByPath) {
    const fromEntry = fromByPath.get(path);
    const bytes = toEntry.size_bytes ?? 0;
    if (!fromEntry) {
      added++;
      newlyUploadedCasBytes += bytes;
    } else if (fromEntry.content_sha256 !== toEntry.content_sha256) {
      changed++;
      newlyUploadedCasBytes += bytes;
    } else {
      unchanged++;
      reusedCasBytes += bytes;
    }
  }
  for (const [path] of fromByPath) {
    if (!toByPath.has(path)) removed++;
  }

  const candidateManifest =
    to.static_manifest ?? buildStaticManifestFromPortableState(to.site.paths, to.routes, null, undefined).manifest;
  const previousImmutableFailures = candidateManifest
    ? detectPreviousImmutableViolations(from.static_manifest, candidateManifest).map((violation) => ({
        path: violation.path,
        previous_sha256: violation.previous_sha256,
        candidate_sha256: violation.candidate_sha256,
      }))
    : [];
  const legacyRiskManifest = from.static_manifest ?? to.static_manifest;

  return {
    unchanged,
    changed,
    added,
    removed,
    newly_uploaded_cas_bytes: newlyUploadedCasBytes,
    reused_cas_bytes: reusedCasBytes,
    deployment_copy_bytes_eliminated: reusedCasBytes,
    legacy_immutable_warnings: legacyRiskManifest
      ? collectLegacyImmutableRisks(legacyRiskManifest).map((risk) => ({
          path: risk.path,
          sha256: risk.sha256,
          reason: risk.reason,
        }))
      : [],
    previous_immutable_failures: previousImmutableFailures,
  };
}

function computeFunctionsDiff(from: PortableReleaseState, to: PortableReleaseState): FunctionsDiff {
  const fromByName = new Map(from.functions.map((fn) => [fn.name, fn]));
  const toByName = new Map(to.functions.map((fn) => [fn.name, fn]));

  const added: string[] = [];
  const removed: string[] = [];
  const changed: FunctionsDiff["changed"] = [];

  for (const [name, toFn] of toByName) {
    const fromFn = fromByName.get(name);
    if (!fromFn) {
      added.push(name);
      continue;
    }
    const fields = changedFunctionFields(fromFn, toFn);
    if (fields.length > 0) changed.push({ name, fields_changed: fields });
  }
  for (const [name] of fromByName) {
    if (!toByName.has(name)) removed.push(name);
  }

  added.sort(compareAscii);
  removed.sort(compareAscii);
  changed.sort((a, b) => compareAscii(a.name, b.name));

  return { added, removed, changed };
}

function changedFunctionFields(
  fromFn: PortableFunctionEntry,
  toFn: PortableFunctionEntry,
): FunctionsDiff["changed"][number]["fields_changed"] {
  const fields: FunctionsDiff["changed"][number]["fields_changed"] = [];
  if (fromFn.code_hash !== toFn.code_hash) fields.push("code_hash");
  if (fromFn.runtime !== toFn.runtime) fields.push("runtime");
  if (fromFn.timeout_seconds !== toFn.timeout_seconds) fields.push("timeout_seconds");
  if (fromFn.memory_mb !== toFn.memory_mb) fields.push("memory_mb");
  if (fromFn.schedule !== toFn.schedule) fields.push("schedule");
  if (JSON.stringify(normalizeFunctionTriggers(fromFn.triggers ?? [])) !== JSON.stringify(normalizeFunctionTriggers(toFn.triggers ?? []))) {
    fields.push("triggers");
  }
  if (JSON.stringify([...(fromFn.deps ?? [])].sort()) !== JSON.stringify([...(toFn.deps ?? [])].sort())) {
    fields.push("deps");
  }
  return fields;
}

function computeSecretsDiff(from: PortableReleaseState, to: PortableReleaseState): SecretsDiff {
  const fromKeys = new Set(from.secrets.keys);
  const toKeys = new Set(to.secrets.keys);
  const added = [...toKeys].filter((key) => !fromKeys.has(key)).sort(compareAscii);
  const removed = [...fromKeys].filter((key) => !toKeys.has(key)).sort(compareAscii);
  return { added, removed };
}

function computeSubdomainsDiff(from: PortableReleaseState, to: PortableReleaseState): SubdomainsDiff {
  const fromNames = new Set(from.subdomains.names);
  const toNames = new Set(to.subdomains.names);
  const added = [...toNames].filter((name) => !fromNames.has(name)).sort(compareAscii);
  const removed = [...fromNames].filter((name) => !toNames.has(name)).sort(compareAscii);
  return { added, removed };
}

function computeRoutesDiff(from: PortableReleaseState, to: PortableReleaseState): RoutesDiff {
  const fromByPattern = groupRoutesByPattern(from.routes.entries);
  const toByPattern = groupRoutesByPattern(to.routes.entries);
  const added: RouteEntry[] = [];
  const removed: string[] = [];
  const changed: RoutesDiff["changed"] = [];

  for (const [identity, toGroup] of toByPattern) {
    const fromGroup = fromByPattern.get(identity);
    if (!fromGroup) {
      added.push(...toGroup);
      continue;
    }

    if (fromGroup.length === 1 && toGroup.length === 1) {
      pushRouteChange(changed, fromGroup[0]!, toGroup[0]!);
      continue;
    }

    const fromByMethods = new Map(fromGroup.map((entry) => [routeMethodsKey(entry), entry]));
    for (const toEntry of toGroup) {
      const key = routeMethodsKey(toEntry);
      const fromEntry = fromByMethods.get(key);
      if (!fromEntry) {
        added.push(toEntry);
        continue;
      }
      pushRouteChange(changed, fromEntry, toEntry);
      fromByMethods.delete(key);
    }
    for (const fromEntry of fromByMethods.values()) {
      removed.push(fromEntry.pattern);
    }
  }

  for (const [identity, fromGroup] of fromByPattern) {
    if (!toByPattern.has(identity)) {
      for (const fromEntry of fromGroup) removed.push(fromEntry.pattern);
    }
  }

  return {
    added: sortRouteEntries(added),
    removed: removed.sort(compareAscii),
    changed: changed.sort((a, b) => compareAscii(a.pattern, b.pattern)),
  };
}

function pushRouteChange(
  changed: RoutesDiff["changed"],
  fromEntry: RouteEntry,
  toEntry: RouteEntry,
): void {
  const fields: RoutesDiff["changed"][0]["fields_changed"] = [];
  const change: RoutesDiff["changed"][0] = { pattern: toEntry.pattern, fields_changed: fields };
  if (!sameRouteTarget(fromEntry.target, toEntry.target)) {
    fields.push("target");
    change.target_old = fromEntry.target;
    change.target_new = toEntry.target;
  }
  if (!sameMethods(fromEntry.methods, toEntry.methods)) {
    fields.push("methods");
    change.methods_old = fromEntry.methods;
    change.methods_new = toEntry.methods;
  }
  if (!samePricing(fromEntry.pricing, toEntry.pricing)) {
    fields.push("pricing");
    change.pricing_old = fromEntry.pricing;
    change.pricing_new = toEntry.pricing;
  }
  if (fields.length > 0) changed.push(change);
}

function sameRouteTarget(a: RouteEntry["target"], b: RouteEntry["target"]): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "function" && b.type === "function") return a.name === b.name;
  if (a.type === "static" && b.type === "static") return a.file === b.file;
  return false;
}

function sameMethods(a: RouteEntry["methods"], b: RouteEntry["methods"]): boolean {
  if (a === null || b === null) return a === b;
  if (a.length !== b.length) return false;
  return a.every((method, index) => method === b[index]);
}

function samePricing(a: RouteEntry["pricing"], b: RouteEntry["pricing"]): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.mode !== b.mode || a.amount_usd_micros !== b.amount_usd_micros || a.pay_to !== b.pay_to) {
    return false;
  }
  const aNetworks = a.networks ?? [];
  const bNetworks = b.networks ?? [];
  if (aNetworks.length !== bNetworks.length) return false;
  return aNetworks.every((network, index) => network === bNetworks[index]);
}

function groupRoutesByPattern(entries: readonly RouteEntry[]): Map<string, RouteEntry[]> {
  const groups = new Map<string, RouteEntry[]>();
  for (const entry of entries) {
    const key = routePatternKey(entry);
    const group = groups.get(key);
    if (group) group.push(entry);
    else groups.set(key, [entry]);
  }
  return groups;
}

function routePatternKey(entry: RouteEntry): string {
  return entry.kind === "exact" ? `exact:${normalizeExactRoutePattern(entry.pattern)}` : `prefix:${entry.pattern}`;
}

function normalizeExactRoutePattern(pattern: string): string {
  return pattern.length > 1 && pattern.endsWith("/") ? pattern.slice(0, -1) : pattern;
}

function routeMethodsKey(entry: RouteEntry): string {
  return effectiveRouteMethods(entry.methods).join(",");
}

function effectiveRouteMethods(methods: RouteEntry["methods"]): HttpMethod[] {
  if (methods === null) return [...SUPPORTED_HTTP_METHODS];
  const out = new Set<HttpMethod>(methods);
  if (out.has("GET")) out.add("HEAD");
  return [...out].sort(compareAscii);
}

function isDiffNoop(
  site: SiteDiff,
  functions: FunctionsDiff,
  secrets: SecretsDiff,
  subdomains: SubdomainsDiff,
  routes: RoutesDiff,
): boolean {
  return (
    site.added.length === 0 &&
    site.removed.length === 0 &&
    site.changed.length === 0 &&
    functions.added.length === 0 &&
    functions.removed.length === 0 &&
    functions.changed.length === 0 &&
    secrets.added.length === 0 &&
    secrets.removed.length === 0 &&
    subdomains.added.length === 0 &&
    subdomains.removed.length === 0 &&
    routes.added.length === 0 &&
    routes.removed.length === 0 &&
    routes.changed.length === 0
  );
}

function renderSummary(
  migrations: PlanMigrationDelta,
  site: SiteDiff,
  functions: FunctionsDiff,
  secrets: SecretsDiff,
  subdomains: SubdomainsDiff,
  routes: RoutesDiff,
): string {
  const parts = commonSummaryParts(site, functions, secrets, subdomains, routes, "required");
  if (migrations.new.length > 0) {
    parts.unshift(`${migrations.new.length} migration${migrations.new.length === 1 ? "" : "s"} new`);
  }
  if (parts.length === 0) return "No changes (noop)";
  return parts.join(", ");
}

function renderSummaryReleaseDiff(
  migrationsAppliedBetween: number,
  site: SiteDiff,
  functions: FunctionsDiff,
  secrets: SecretsDiff,
  subdomains: SubdomainsDiff,
  routes: RoutesDiff,
): string {
  const parts = commonSummaryParts(site, functions, secrets, subdomains, routes, "added");
  if (migrationsAppliedBetween > 0) {
    parts.unshift(`${migrationsAppliedBetween} migration${migrationsAppliedBetween === 1 ? "" : "s"} applied between releases`);
  }
  if (parts.length === 0) return "No changes between releases (noop)";
  return parts.join(", ");
}

function commonSummaryParts(
  site: SiteDiff,
  functions: FunctionsDiff,
  secrets: SecretsDiff,
  subdomains: SubdomainsDiff,
  routes: RoutesDiff,
  secretAddedVerb: "added" | "required",
): string[] {
  const parts: string[] = [];
  if (site.added.length > 0) parts.push(`${site.added.length} site path${site.added.length === 1 ? "" : "s"} added`);
  if (site.changed.length > 0) parts.push(`${site.changed.length} site path${site.changed.length === 1 ? "" : "s"} changed`);
  if (site.removed.length > 0) parts.push(`${site.removed.length} site path${site.removed.length === 1 ? "" : "s"} removed`);
  if (functions.added.length > 0) parts.push(`${functions.added.length} function${functions.added.length === 1 ? "" : "s"} added`);
  if (functions.changed.length > 0) parts.push(`${functions.changed.length} function${functions.changed.length === 1 ? "" : "s"} changed`);
  if (functions.removed.length > 0) parts.push(`${functions.removed.length} function${functions.removed.length === 1 ? "" : "s"} removed`);
  if (secrets.added.length > 0) parts.push(`${secrets.added.length} secret${secrets.added.length === 1 ? "" : "s"} ${secretAddedVerb}`);
  if (secrets.removed.length > 0) parts.push(`${secrets.removed.length} secret${secrets.removed.length === 1 ? "" : "s"} removed`);
  if (subdomains.added.length > 0) parts.push(`${subdomains.added.length} subdomain${subdomains.added.length === 1 ? "" : "s"} added`);
  if (subdomains.removed.length > 0) parts.push(`${subdomains.removed.length} subdomain${subdomains.removed.length === 1 ? "" : "s"} removed`);
  if (routes.added.length > 0) parts.push(`${routes.added.length} route${routes.added.length === 1 ? "" : "s"} added`);
  if (routes.changed.length > 0) parts.push(`${routes.changed.length} route${routes.changed.length === 1 ? "" : "s"} changed`);
  if (routes.removed.length > 0) parts.push(`${routes.removed.length} route${routes.removed.length === 1 ? "" : "s"} removed`);
  return parts;
}

function isBulkSiteRemoval(base: PortableReleaseState, diff: Pick<PlanDiffEnvelope | ReleaseDiffEnvelope, "site">): boolean {
  const baseCount = base.site.paths.length;
  if (baseCount === 0) return false;
  return diff.site.removed.length / baseCount > SITE_BULK_REMOVAL_THRESHOLD;
}

function collectRouteCoreWarnings(input: {
  from: PortableReleaseState;
  to: PortableReleaseState;
  diff: PlanDiffEnvelope | ReleaseDiffEnvelope;
  spec?: ReleaseSpec;
}): CoreWarningEntry[] {
  const warnings: CoreWarningEntry[] = [];
  const functionRoutes = input.to.routes.entries
    .filter((entry) => entry.target.type === "function")
    .map((entry) => entry.pattern);
  const staticAliases = input.to.routes.entries.filter((entry) => entry.target.type === "static");
  if (functionRoutes.length > 0) {
    warnings.push({
      code: "RUN402_CORE_PUBLIC_ROUTED_FUNCTION",
      severity: "info",
      requires_confirmation: false,
      message: "This release exposes public same-origin routed functions.",
      affected: functionRoutes.sort(compareAscii),
    });
  }

  if (
    input.spec &&
    (input.spec.routes === undefined || input.spec.routes === null) &&
    input.from.routes.entries.length > 0
  ) {
    warnings.push({
      code: "RUN402_CORE_ROUTE_TARGET_CARRIED_FORWARD",
      severity: "info",
      requires_confirmation: false,
      message: "This release carries forward route targets from the base release.",
      affected: input.from.routes.entries.map((entry) => entry.pattern).sort(compareAscii),
    });
  }
  if (
    input.spec &&
    staticManifestPublicPathMode(input.from.static_manifest) === "explicit" &&
    input.spec.site?.public_paths?.mode === "implicit"
  ) {
    warnings.push({
      code: "RUN402_CORE_PUBLIC_PATH_MODE_WIDENS_TO_IMPLICIT",
      severity: "warn",
      requires_confirmation: true,
      message: "This release changes static public-path mode from explicit to implicit, which may make asset filenames directly reachable.",
      affected: [],
    });
  }

  const directStaticEntries = new Map<string, { asset_path: string; sha256: string }>();
  for (const [publicPath, entry] of Object.entries(input.to.static_manifest?.files ?? {})) {
    if (!isDirectStaticManifestEntry(entry)) continue;
    directStaticEntries.set(publicPath, {
      asset_path: staticManifestEntryAssetPath(publicPath, entry),
      sha256: entry.sha256,
    });
  }
  const exactShadowed: string[] = [];
  const wildcardShadowed: string[] = [];
  const staticAliasShadowing: string[] = [];
  const staticAliasRelativeAssetRisk: string[] = [];
  const staticAliasDuplicateCanonical: string[] = [];
  const staticAliasRedundantPublicPath: string[] = [];
  const staticAliasNonHtmlExtensionless: string[] = [];
  for (const entry of input.to.routes.entries) {
    if (entry.target.type === "static") {
      const targetFile = entry.target.file.replace(/^\/+/, "");
      const directAtAliasPath = directStaticEntries.get(entry.pattern);
      if (directAtAliasPath?.asset_path === targetFile) {
        staticAliasRedundantPublicPath.push(`${entry.pattern} -> static file ${targetFile}`);
      }
      const candidates = staticCandidatesForExactRoute(entry.pattern);
      if (candidates.some((candidate) => {
        const direct = directStaticEntries.get(candidate);
        return direct && direct.asset_path !== targetFile;
      })) {
        staticAliasShadowing.push(`${entry.pattern} -> static file ${targetFile}`);
      }
      if (directStaticEntries.has(`/${targetFile}`)) {
        staticAliasDuplicateCanonical.push(`${entry.pattern} -> static file ${targetFile}`);
      }
      if (!hasExtension(entry.pattern) && !isHtmlPath(targetFile)) {
        staticAliasNonHtmlExtensionless.push(`${entry.pattern} -> static file ${targetFile}`);
      }
      if (isHtmlPath(targetFile) && routePublicDirectory(entry.pattern) !== fileDirectory(targetFile)) {
        staticAliasRelativeAssetRisk.push(`${entry.pattern} -> static file ${targetFile}`);
      }
      continue;
    }
    if (entry.kind === "exact") {
      const candidates = staticCandidatesForExactRoute(entry.pattern);
      if (candidates.some((candidate) => directStaticEntries.has(candidate))) {
        exactShadowed.push(entry.pattern);
      }
    } else {
      const prefix = entry.prefix?.replace(/\/\*$/, "") ?? "";
      if (prefix && [...directStaticEntries.keys()].some((path) => path.startsWith(prefix))) {
        wildcardShadowed.push(entry.pattern);
      }
    }
  }

  pushAffectedWarning(warnings, "RUN402_CORE_ROUTE_SHADOWS_STATIC_PATH", "warn", "Some routes shadow static site paths.", exactShadowed);
  pushAffectedWarning(warnings, "RUN402_CORE_WILDCARD_ROUTE_SHADOWS_STATIC_PATHS", "warn", "Some wildcard routes shadow static site paths.", wildcardShadowed);
  pushAffectedWarning(warnings, "RUN402_CORE_STATIC_ALIAS_SHADOWS_STATIC_PATH", "warn", "Some exact static URL aliases shadow an existing static lookup.", staticAliasShadowing);
  pushAffectedWarning(warnings, "RUN402_CORE_STATIC_ALIAS_RELATIVE_ASSET_RISK", "warn", "Some exact static URL aliases may resolve relative assets differently than their target files.", staticAliasRelativeAssetRisk);
  pushAffectedWarning(warnings, "RUN402_CORE_STATIC_ALIAS_DUPLICATE_CANONICAL_URL", "info", "Some exact static URL aliases also leave their target files directly reachable.", staticAliasDuplicateCanonical);
  pushAffectedWarning(warnings, "RUN402_CORE_STATIC_ALIAS_REDUNDANT_PUBLIC_PATH", "info", "Some exact static URL aliases duplicate an identical direct public path declaration.", staticAliasRedundantPublicPath);
  pushAffectedWarning(warnings, "RUN402_CORE_STATIC_ALIAS_EXTENSIONLESS_NON_HTML", "warn", "Some extensionless exact static URL aliases target non-HTML files.", staticAliasNonHtmlExtensionless);

  if (input.to.routes.entries.length >= Math.floor(ROUTE_TABLE_LIMIT * 0.9)) {
    warnings.push({
      code: "RUN402_CORE_ROUTE_TABLE_NEAR_LIMIT",
      severity: "warn",
      requires_confirmation: false,
      message: "The route table is near the per-release route limit.",
      affected: [],
      details: { routes: input.to.routes.entries.length, limit: ROUTE_TABLE_LIMIT },
    });
  }
  if (staticAliases.length >= Math.floor(ROUTE_TABLE_LIMIT * 0.9)) {
    warnings.push({
      code: "RUN402_CORE_STATIC_ALIAS_TABLE_NEAR_LIMIT",
      severity: "warn",
      requires_confirmation: false,
      message: "The exact static URL alias table is near the current combined route limit.",
      affected: [],
      details: {
        static_aliases: staticAliases.length,
        limit: ROUTE_TABLE_LIMIT,
        limit_scope: "combined_routes_temporary",
      },
    });
  }
  return warnings;
}

function pushAffectedWarning(
  warnings: CoreWarningEntry[],
  code: CoreWarningEntry["code"],
  severity: CoreWarningEntry["severity"],
  message: string,
  affected: string[],
): void {
  if (affected.length === 0) return;
  warnings.push({
    code,
    severity,
    requires_confirmation: false,
    message,
    affected: affected.sort(compareAscii),
  });
}

export function collectUnreachableHtmlWarning(to: PortableReleaseState): CoreWarningEntry | null {
  const htmlAssets = to.site.paths.filter(
    (path) => isHtmlPath(path.path) || path.content_type.toLowerCase().startsWith("text/html"),
  );
  if (htmlAssets.length === 0) return null;

  const reachableAssetPaths = new Set<string>();
  const manifest = to.static_manifest;
  if (manifest) {
    for (const [publicPath, entry] of Object.entries(manifest.files)) {
      reachableAssetPaths.add(staticManifestEntryAssetPath(publicPath, entry).replace(/^\/+/, ""));
    }
    if (manifest.spa_fallback) {
      reachableAssetPaths.add(manifest.spa_fallback.replace(/^\/+/, ""));
    }
  }

  const unreachable = htmlAssets
    .map((path) => path.path.replace(/^\/+/, ""))
    .filter((assetPath) => !reachableAssetPaths.has(assetPath));
  if (unreachable.length < htmlAssets.length) return null;

  return {
    code: "RUN402_CORE_SITE_NO_REACHABLE_HTML",
    severity: "high",
    requires_confirmation: true,
    message: "This release ships HTML files but none are reachable at a public path.",
    affected: unreachable.slice(0, 10).sort(compareAscii),
  };
}

function collectMigrationSqlHeuristicWarnings(
  spec: ReleaseSpec,
  newMigrationIds: Set<string>,
): CoreWarningEntry[] {
  const buckets = new Map<CoreWarningEntry["code"], string[]>();
  for (const migration of spec.database?.migrations ?? []) {
    if (!newMigrationIds.has(migration.id)) continue;
    if (!migration.sql) continue;
    const stripped = stripSqlCommentsAndStrings(migration.sql);
    if (/\bdrop\s+(table|type)\b|\bdrop\s+column\b|\btruncate\s+(table\s+)?\b/.test(stripped)) {
      pushWarningAffected(buckets, "RUN402_CORE_MIGRATION_SCHEMA_SHRINKING", migration.id);
    }
    if (/\bcreate\s+index\b/.test(stripped) && !/\bconcurrently\b/.test(stripped)) {
      pushWarningAffected(buckets, "RUN402_CORE_MIGRATION_LOCK_RISK", migration.id);
    }
    if (/\bdisable\s+row\s+level\s+security\b/.test(stripped)) {
      pushWarningAffected(buckets, "RUN402_CORE_MIGRATION_RLS_DISABLED", migration.id);
    }
    if (/\bdrop\s+policy\b/.test(stripped)) {
      pushWarningAffected(buckets, "RUN402_CORE_MIGRATION_POLICY_REMOVAL", migration.id);
    }
    if (/\bgrant\b[\s\S]*\bto\s+public\b/.test(stripped)) {
      pushWarningAffected(buckets, "RUN402_CORE_MIGRATION_PUBLIC_GRANT", migration.id);
    }
    if (/\bsecurity\s+definer\b/.test(stripped)) {
      pushWarningAffected(buckets, "RUN402_CORE_MIGRATION_SECURITY_DEFINER", migration.id);
    }
  }

  const definitions: Record<CoreWarningEntry["code"], Omit<CoreWarningEntry, "affected">> = {
    RUN402_CORE_MIGRATION_SCHEMA_SHRINKING: {
      code: "RUN402_CORE_MIGRATION_SCHEMA_SHRINKING",
      severity: "high",
      requires_confirmation: true,
      confidence: "heuristic",
      message: "Migration SQL appears to remove schema objects or rows.",
    },
    RUN402_CORE_MIGRATION_LOCK_RISK: {
      code: "RUN402_CORE_MIGRATION_LOCK_RISK",
      severity: "warn",
      requires_confirmation: false,
      confidence: "heuristic",
      message: "Migration SQL may take locks that interrupt live traffic.",
    },
    RUN402_CORE_MIGRATION_RLS_DISABLED: {
      code: "RUN402_CORE_MIGRATION_RLS_DISABLED",
      severity: "high",
      requires_confirmation: true,
      confidence: "heuristic",
      message: "Migration SQL appears to disable row level security.",
    },
    RUN402_CORE_MIGRATION_POLICY_REMOVAL: {
      code: "RUN402_CORE_MIGRATION_POLICY_REMOVAL",
      severity: "warn",
      requires_confirmation: true,
      confidence: "heuristic",
      message: "Migration SQL appears to remove row level security policies.",
    },
    RUN402_CORE_MIGRATION_PUBLIC_GRANT: {
      code: "RUN402_CORE_MIGRATION_PUBLIC_GRANT",
      severity: "warn",
      requires_confirmation: true,
      confidence: "heuristic",
      message: "Migration SQL appears to grant privileges to public.",
    },
    RUN402_CORE_MIGRATION_SECURITY_DEFINER: {
      code: "RUN402_CORE_MIGRATION_SECURITY_DEFINER",
      severity: "warn",
      requires_confirmation: true,
      confidence: "heuristic",
      message: "Migration SQL creates or alters a SECURITY DEFINER function.",
    },
  };

  return [...buckets.entries()].map(([code, affected]) => ({
    ...definitions[code],
    affected: affected.sort(compareAscii),
    details: { migration_ids: affected.sort(compareAscii) },
  }));
}

function pushWarningAffected(
  buckets: Map<CoreWarningEntry["code"], string[]>,
  code: CoreWarningEntry["code"],
  value: string,
): void {
  const existing = buckets.get(code) ?? [];
  existing.push(value);
  buckets.set(code, existing);
}

function stripSqlCommentsAndStrings(sqlText: string): string {
  return sqlText
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n\r]*/g, " ")
    .replace(/\$\$[\s\S]*?\$\$/g, " ")
    .replace(/\$[A-Za-z_][A-Za-z0-9_]*\$[\s\S]*?\$[A-Za-z_][A-Za-z0-9_]*\$/g, " ")
    .replace(/'(?:''|[^'])*'/g, " ")
    .replace(/"(?:\"\"|[^"])*"/g, " ")
    .toLowerCase();
}

function sortWarnings(warnings: CoreWarningEntry[]): CoreWarningEntry[] {
  return [...warnings].sort((a, b) => {
    const code = compareAscii(a.code, b.code);
    if (code !== 0) return code;
    return compareAscii(a.affected.join("\u0000"), b.affected.join("\u0000"));
  });
}

function sortRequirements(requirements: EffectRequirement[]): EffectRequirement[] {
  return [...requirements].sort((a, b) => compareAscii(requirementSortKey(a), requirementSortKey(b)));
}

function requirementSortKey(requirement: EffectRequirement): string {
  switch (requirement.kind) {
    case "content-required":
      return `content:${requirement.sha256}`;
    case "migration-required":
      return `migration:${requirement.migration_id}:${requirement.checksum_hex}`;
    case "function-change":
      return `function:${requirement.name}:${requirement.operation}`;
    case "route-change":
      return "route";
    case "static-site-change":
      return "static-site";
  }
}

function staticCandidatesForExactRoute(pattern: string): string[] {
  const trimmed = pattern.replace(/^\/+/, "").replace(/\/$/, "");
  if (trimmed === "") return ["/", "/index.html"];
  return [`/${trimmed}`, `/${trimmed}/`, `/${trimmed}/index.html`];
}

function hasExtension(path: string): boolean {
  const lastSlash = path.lastIndexOf("/");
  const basename = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
  return basename.includes(".");
}

function routePublicDirectory(pattern: string): string {
  const trimmed = pattern.replace(/^\/+/, "").replace(/\/$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash < 0 ? "" : trimmed.slice(0, slash);
}

function fileDirectory(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

function isHtmlPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".html") || lower.endsWith(".htm");
}

function compareAscii(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
