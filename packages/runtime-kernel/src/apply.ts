import { createHash } from "node:crypto";
import {
  canonicalizeJson,
  digestApplyRequest,
  digestMaterializedRelease,
  emptyPortableReleaseState,
  materializeRelease,
  parseReleaseSpec,
  type AssetPutEntryWire,
  type ContentRefHex,
  type FunctionSpec,
  type MigrationSpec,
  type PortableReleaseState,
  type ReleaseSpec,
} from "@run402/release";
import type {
  CoreApplyCommitContext,
  CoreApplyPlan,
  CoreAssetPut,
  CoreStorageApplyEffects,
  RuntimeKernelPorts,
} from "./ports.js";
import {
  AstroSsrUnsupportedFeatureError,
  DependencyInstallRejectedError,
  FunctionBundleValidationError,
  MissingRequiredSecretError,
  UnsupportedCapabilityError,
} from "./errors.js";
import {
  CORE_ASTRO_SSR_FALLBACK_PATTERN,
  CORE_ASTRO_SSR_OUTPUT_CONTRACT_VERSION,
  CORE_FUNCTION_DEPENDENCY_MODE,
  CORE_FUNCTION_RESOURCE_DEFAULTS,
  CORE_FUNCTION_SCHEDULE_LIMIT_DEFAULTS,
  emptyFunctionApplyEffects,
  emptyCoreFunctionScheduleMetadata,
  functionMemoryBytes,
  isAstroSsrFunction,
  nextCoreCronRunIso,
  normalizeFunctionEntrypoint,
  validateCoreFunctionScheduleTrigger,
  type CoreDynamicFunctionRoute,
  type CoreFunctionApplyEffects,
  type CoreFunctionBundleMetadata,
} from "./functions-runtime.js";
import {
  computeStorageInventoryRevision,
  normalizeSha256Hex,
  normalizeStorageContentType,
  normalizeStorageKey,
  normalizeStoragePrefix,
  normalizeStorageVisibility,
  StorageValidationError,
} from "./storage.js";
import { validateProjectId } from "./projects.js";

export interface CreateApplyPlanInput {
  spec: unknown;
}

export interface CommitApplyPlanInput {
  plan_id: string;
  release_spec_digest?: string;
}

export interface CoreApplyCommitResult {
  plan_id: string;
  project_id: string;
  release_id: string;
  release_digest: string;
  status: "committed" | "noop" | "deferred";
  deferred_phase?: "schema_settling" | "activation_pending";
  deferred_reason?: string;
}

export class ApplyInvariantError extends Error {
  readonly status = 409;

  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ApplyInvariantError";
  }
}

export function applyInvariantEnvelope(error: ApplyInvariantError): {
  error: string;
  message: string;
} {
  return {
    error: error.code,
    message: error.message,
  };
}

export async function createApplyPlan(
  ports: RuntimeKernelPorts,
  input: CreateApplyPlanInput,
): Promise<CoreApplyPlan> {
  const spec = parseReleaseSpec(input.spec);
  validateSupportedSpec(spec, ports);
  validateProjectId(spec.project);

  const project = await ports.projects.inspect(spec.project);
  if (!project) {
    throw new ApplyInvariantError("project_not_found", `Run402 Core project not found: ${spec.project}`);
  }

  const base = await ports.releases.getBase(spec.project, releaseBaseTarget(spec));
  const target = materializeRelease({
    spec,
    concreteBase: base.state,
  });
  const storageEffects = await planStorageEffects(ports, spec);
  const functionEffects = planFunctionEffects(spec, base.state, target);
  const storedFunctionEffects = isEmptyFunctionEffects(functionEffects) ? undefined : functionEffects;
  const releaseSpecDigest = digestApplyRequest(spec);
  const targetDigest = digestMaterializedRelease(target);
  const baseDigest = digestMaterializedRelease(base.state);
  const targetReleaseId = releaseIdFromDigest(targetDigest);
  const plan = await ports.plans.create({
    project_id: spec.project,
    spec,
    release_spec_digest: releaseSpecDigest,
    base_release_id: base.release_id,
    target_release_id: targetReleaseId,
    target_release_digest: targetDigest,
    target_release: target,
    storage_effects: storageEffects,
    ...(storedFunctionEffects ? { function_effects: storedFunctionEffects } : {}),
    noop: targetDigest === baseDigest && storageEffects.noop && functionEffects.noop,
  });

  return publicPlan(plan);
}

export async function commitApplyPlan(
  ports: RuntimeKernelPorts,
  input: CommitApplyPlanInput,
): Promise<CoreApplyCommitResult> {
  const plan = await ports.plans.get(input.plan_id);
  if (!plan) {
    throw new ApplyInvariantError("plan_not_found", `Run402 Core apply plan not found: ${input.plan_id}`);
  }
  if (input.release_spec_digest && input.release_spec_digest !== plan.release_spec_digest) {
    throw new ApplyInvariantError("release_spec_digest_mismatch", "Apply plan digest does not match commit input.");
  }
  const spec = parseReleaseSpec(plan.spec);
  validateSupportedSpec(spec, ports);

  if (plan.status === "committed") {
    return {
      plan_id: plan.plan_id,
      project_id: plan.project_id,
      release_id: plan.target_release_id,
      release_digest: plan.target_release_digest,
      status: plan.noop ? "noop" : "committed",
    };
  }

  const current = await ports.releases.getBase(plan.project_id, "current");
  if (current.release_id !== plan.base_release_id) {
    throw new ApplyInvariantError("stale_plan", "Apply plan base release no longer matches the active release.");
  }
  if (plan.noop) {
    const releaseId = plan.base_release_id ?? plan.target_release_id;
    await ports.plans.markCommitted(plan.plan_id);
    await ports.lifecycle?.committed?.({
      plan,
      spec,
      release_id: releaseId,
      release_digest: plan.target_release_digest,
      target_release: plan.target_release,
    });
    return {
      plan_id: plan.plan_id,
      project_id: plan.project_id,
      release_id: releaseId,
      release_digest: plan.target_release_digest,
      status: "noop",
    };
  }

  let releaseId = plan.target_release_id;
  const context = (): CoreApplyCommitContext => ({
    plan,
    spec,
    release_id: releaseId,
    release_digest: plan.target_release_digest,
    target_release: plan.target_release,
    storage_effects: plan.storage_effects,
    function_effects: plan.function_effects,
  });

  await verifyStaticContent(ports, plan.project_id, plan.target_release);
  await verifyStorageContent(ports, plan.project_id, plan.storage_effects);
  await verifyFunctionContent(ports, plan.project_id, plan.function_effects);
  await verifyFunctionSecrets(ports, plan.project_id, plan.function_effects);

  const staged = await ports.lifecycle?.stage?.(context());
  if (staged?.release_id) releaseId = staged.release_id;

  await ports.lifecycle?.beforeMigrate?.(context());
  await applyMigrations(ports, spec);

  const expose = await ports.lifecycle?.applyRestExposure?.(context());
  if (expose?.status === "deferred") {
    return deferredCommitResult(plan, releaseId, expose);
  }

  const settled = await ports.lifecycle?.settleSchema?.(context());
  if (settled?.status === "deferred") {
    return deferredCommitResult(plan, releaseId, settled);
  }

  const activated = await ports.lifecycle?.activate?.(context());
  if (activated?.status === "deferred") {
    return deferredCommitResult(plan, releaseId, activated);
  }
  if (activated?.release_id) releaseId = activated.release_id;
  if (!ports.lifecycle?.activate) {
    if (plan.storage_effects && !plan.storage_effects.noop) {
      if (!ports.storage) throw new UnsupportedCapabilityError("storage.objects.local");
      await ports.storage.commitAssetPlan({
        projectId: plan.project_id,
        effects: plan.storage_effects,
      });
    }
    await ports.releases.setActiveRelease({
      projectId: plan.project_id,
      releaseId,
      digest: plan.target_release_digest,
      release: plan.target_release,
      expectedBaseReleaseId: plan.base_release_id,
    });
  }

  await ports.plans.markCommitted(plan.plan_id);
  await ports.lifecycle?.committed?.(context());

  return {
    plan_id: plan.plan_id,
    project_id: plan.project_id,
    release_id: releaseId,
    release_digest: plan.target_release_digest,
    status: plan.noop ? "noop" : "committed",
  };
}

function deferredCommitResult(
  plan: CoreApplyPlan,
  releaseId: string,
  deferred: { phase: "schema_settling" | "activation_pending"; reason: string },
): CoreApplyCommitResult {
  return {
    plan_id: plan.plan_id,
    project_id: plan.project_id,
    release_id: releaseId,
    release_digest: plan.target_release_digest,
    status: "deferred",
    deferred_phase: deferred.phase,
    deferred_reason: deferred.reason,
  };
}

function validateSupportedSpec(spec: ReleaseSpec, ports: RuntimeKernelPorts): void {
  validateFunctionSubset(spec, ports);
  if (spec.subdomains) throw new UnsupportedCapabilityError("subdomains.managed");
  if (spec.assets && !spec.assets.put && !spec.assets.delete && !spec.assets.sync) {
    throw new ApplyInvariantError("asset_spec_empty", "Asset spec must include put, delete, or sync.");
  }
  if (spec.i18n) throw new UnsupportedCapabilityError("i18n.routing");
  if (spec.database?.zero_downtime) throw new UnsupportedCapabilityError("database.zero-downtime");
  if (spec.site && "patch" in spec.site && spec.site.patch) {
    throw new UnsupportedCapabilityError("site.patch");
  }
  for (const migration of spec.database?.migrations ?? []) {
    if (migration.sql_ref) throw new UnsupportedCapabilityError("database.migrations.sql_ref");
    if (!migration.sql) {
      throw new ApplyInvariantError("migration_sql_required", `Migration ${migration.id} must include inline SQL.`);
    }
  }
  for (const route of spec.routes?.replace ?? []) {
    if (route.target.type === "function") {
      continue;
    }
    if (route.target.type !== "static") {
      throw new UnsupportedCapabilityError("functions.node");
    }
  }
}

function validateFunctionSubset(spec: ReleaseSpec, ports: RuntimeKernelPorts): void {
  if (!spec.functions) return;
  if (!("replace" in spec.functions) || !spec.functions.replace) {
    throw new UnsupportedCapabilityError("functions.patch");
  }

  let ssrCount = 0;
  let scheduledCount = 0;
  for (const [name, fn] of Object.entries(spec.functions.replace)) {
    validateCoreFunctionSpec(name, fn, ports);
    if (fn.class === "ssr") ssrCount += 1;
    scheduledCount += fn.triggers?.filter((trigger) => trigger.type === "schedule").length ?? 0;
  }
  const scheduleLimits = ports.scheduleLimits ?? CORE_FUNCTION_SCHEDULE_LIMIT_DEFAULTS;
  if (scheduledCount > scheduleLimits.maxScheduledFunctionsPerProject) {
    throw new FunctionBundleValidationError("schedule_limit_exceeded", `Core schedule trigger limit exceeded: ${scheduledCount} scheduled trigger(s), maximum is ${scheduleLimits.maxScheduledFunctionsPerProject}.`, {
      scheduled_count: scheduledCount,
      max_scheduled_functions_per_project: scheduleLimits.maxScheduledFunctionsPerProject,
    });
  }
  if (ssrCount > 1) {
    throw new AstroSsrUnsupportedFeatureError("multiple_ssr_targets", "Run402 Core Astro SSR supports one fallback target per release.", {
      ssr_target_count: ssrCount,
    });
  }
}

function validateCoreFunctionSpec(name: string, fn: FunctionSpec, ports: RuntimeKernelPorts): void {
  if (fn.runtime !== "node22") {
    throw new FunctionBundleValidationError("invalid_function_bundle", `Function ${name} must use runtime node22.`, {
      function_name: name,
      runtime: fn.runtime,
    });
  }
  if (!fn.source) {
    throw new FunctionBundleValidationError("invalid_function_bundle", `Function ${name} must use source in Run402 Core.`, {
      function_name: name,
      reason: "missing_source_ref",
    });
  }
  if (fn.files && Object.keys(fn.files).length > 0) {
    throw new FunctionBundleValidationError("invalid_function_bundle", `Function ${name} files maps are not supported in Run402 Core.`, {
      function_name: name,
      reason: "files_map_unsupported",
    });
  }
  if ((fn.deps?.length ?? 0) > 0) {
    throw new DependencyInstallRejectedError("Run402 Core Functions supports pre-bundled function artifacts with no external deps.", {
      function_name: name,
      deps: fn.deps,
      dependency_mode: CORE_FUNCTION_DEPENDENCY_MODE,
    });
  }
  if (fn.schedule !== undefined && fn.schedule !== null) {
    throw new FunctionBundleValidationError("invalid_function_schedule", `Function ${name} must use functions.replace.${name}.triggers[] schedule entries; the standalone schedule field is not accepted by Run402 Core.`, {
      function_name: name,
      schedule: fn.schedule,
      replacement: `functions.replace.${name}.triggers[]`,
    });
  }
  try {
    for (const trigger of fn.triggers ?? []) {
      if (trigger.type === "schedule") {
        validateCoreFunctionScheduleTrigger({ functionName: name, trigger, limits: ports.scheduleLimits });
      }
    }
  } catch (error) {
    throw new FunctionBundleValidationError("invalid_function_schedule", error instanceof Error ? error.message : String(error), {
      function_name: name,
      triggers: fn.triggers ?? [],
    });
  }
  if (fn.class === "ssr") {
    if (!fn.capabilities?.includes(CORE_ASTRO_SSR_OUTPUT_CONTRACT_VERSION)) {
      throw new AstroSsrUnsupportedFeatureError("unsupported_output_contract", `SSR function ${name} must declare capability ${CORE_ASTRO_SSR_OUTPUT_CONTRACT_VERSION}.`, {
        function_name: name,
        required_capability: CORE_ASTRO_SSR_OUTPUT_CONTRACT_VERSION,
      });
    }
    const unsupportedAstroCapability = fn.capabilities.find((capability) =>
      capability.startsWith("astro.") && capability !== CORE_ASTRO_SSR_OUTPUT_CONTRACT_VERSION);
    if (unsupportedAstroCapability) {
      throw new AstroSsrUnsupportedFeatureError(unsupportedAstroCapability, `SSR function ${name} declares unsupported Astro capability ${unsupportedAstroCapability}.`, {
        function_name: name,
        capability: unsupportedAstroCapability,
      });
    }
  } else if (fn.capabilities?.some((capability) => capability.startsWith("astro."))) {
    throw new AstroSsrUnsupportedFeatureError("class_mismatch", `Function ${name} declares Astro SSR capabilities but is not class ssr.`, {
      function_name: name,
      class: fn.class ?? "standard",
    });
  }
  if (fn.requireRole?.cacheTtl && fn.requireRole.cacheTtl > 0) {
    throw new FunctionBundleValidationError("role_cache_unsupported", `Function ${name} requireRole.cacheTtl must be 0 in Run402 Core.`, {
      function_name: name,
      cache_ttl: fn.requireRole.cacheTtl,
    });
  }
  if (fn.requireRole) {
    for (const field of ["table", "idColumn", "roleColumn"] as const) {
      if (!isSafeSqlIdentifier(fn.requireRole[field])) {
        throw new FunctionBundleValidationError("role_gate_invalid_identifier", `Function ${name} requireRole.${field} must be an unquoted SQL identifier.`, {
          function_name: name,
          field,
        });
      }
    }
  }
}

function planFunctionEffects(
  spec: ReleaseSpec,
  base: PortableReleaseState,
  target: PortableReleaseState,
): CoreFunctionApplyEffects {
  if (!spec.functions && !hasFunctionRoutes(target) && target.functions.length === 0) {
    return emptyFunctionApplyEffects();
  }
  const functionSpecs = spec.functions && "replace" in spec.functions ? spec.functions.replace ?? {} : {};
  const requiredSecrets = [...new Set(spec.secrets?.require ?? [])].sort();
  const bundles = target.functions.map((entry) => {
    const fnSpec = functionSpecs[entry.name];
    if (!fnSpec?.source) {
      throw new FunctionBundleValidationError("invalid_function_bundle", `Function ${entry.name} is missing source metadata for Core activation.`, {
        function_name: entry.name,
      });
    }
    return bundleMetadataFromSpec(entry.name, fnSpec, entry.require_role, requiredSecrets);
  });
  const dynamicRoutes = target.routes.entries
    .filter((route): route is typeof route & { target: { type: "function"; name: string } } => route.target.type === "function")
    .map((route): CoreDynamicFunctionRoute => ({
      pattern: route.pattern,
      kind: route.kind,
      prefix: route.prefix,
      methods: route.methods,
      function_name: route.target.name,
    }));
  const ssrTarget = target.functions.find(isAstroSsrFunction);
  return {
    bundles,
    dynamic_routes: dynamicRoutes,
    astro_ssr_fallback: ssrTarget
      ? {
          function_name: ssrTarget.name,
          output_contract_version: CORE_ASTRO_SSR_OUTPUT_CONTRACT_VERSION,
          pattern: CORE_ASTRO_SSR_FALLBACK_PATTERN,
        }
      : null,
    required_secrets: requiredSecrets,
    dependency_mode: CORE_FUNCTION_DEPENDENCY_MODE,
    noop: stableFunctionSlice(base) === stableFunctionSlice(target),
  };
}

function bundleMetadataFromSpec(
  name: string,
  spec: FunctionSpec,
  requireRole: CoreFunctionBundleMetadata["require_role"],
  requiredSecrets: string[],
): CoreFunctionBundleMetadata {
  if (!spec.source) {
    throw new FunctionBundleValidationError("invalid_function_bundle", `Function ${name} must use source in Run402 Core.`, {
      function_name: name,
    });
  }
  return {
    name,
    runtime: "node22",
    entrypoint: normalizeFunctionEntrypoint(spec),
    source: spec.source,
    bundle_sha256: spec.source.sha256.toLowerCase(),
    bundle_size_bytes: spec.source.size,
    dependency_mode: CORE_FUNCTION_DEPENDENCY_MODE,
    dependency_lock_digest: null,
    deps: [],
    required_secrets: requiredSecrets,
    timeout_ms: Math.min(
      (spec.config?.timeoutSeconds ?? CORE_FUNCTION_RESOURCE_DEFAULTS.invocationTimeoutMs / 1000) * 1000,
      CORE_FUNCTION_RESOURCE_DEFAULTS.invocationTimeoutMs,
    ),
    memory_bytes: functionMemoryBytes({ memory_mb: spec.config?.memoryMb ?? 128 }),
    require_auth: spec.requireAuth === true,
    require_role: requireRole,
    schedule: null,
    schedule_meta: null,
    triggers: (spec.triggers ?? []).map((trigger) => {
      if (trigger.type === "email") {
        return { ...trigger };
      }
      const scheduleTrigger = validateCoreFunctionScheduleTrigger({ functionName: name, trigger });
      return {
        ...scheduleTrigger,
        schedule_meta: {
          ...emptyCoreFunctionScheduleMetadata(),
          next_tick_at: nextCoreCronRunIso(scheduleTrigger.cron),
        },
      };
    }),
    class: spec.class ?? "standard",
    capabilities: spec.capabilities ? [...spec.capabilities].sort() : [],
  };
}

function hasFunctionRoutes(state: PortableReleaseState): boolean {
  return state.routes.entries.some((entry) => entry.target.type === "function");
}

function isEmptyFunctionEffects(effects: CoreFunctionApplyEffects): boolean {
  return effects.noop &&
    effects.bundles.length === 0 &&
    effects.dynamic_routes.length === 0 &&
    effects.astro_ssr_fallback === null &&
    effects.required_secrets.length === 0;
}

function stableFunctionSlice(state: PortableReleaseState): string {
  return canonicalizeJson({
    functions: [...state.functions].sort((a, b) => a.name.localeCompare(b.name)),
    dynamic_routes: state.routes.entries
      .filter((entry) => entry.target.type === "function")
      .sort((a, b) => a.pattern.localeCompare(b.pattern) || (a.methods ?? []).join(",").localeCompare((b.methods ?? []).join(","))),
    astro_ssr_fallback: state.functions.find(isAstroSsrFunction)?.name ?? null,
    secrets: [...state.secrets.keys].sort(),
  });
}

function isSafeSqlIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

async function planStorageEffects(
  ports: RuntimeKernelPorts,
  spec: ReleaseSpec,
): Promise<CoreStorageApplyEffects> {
  if (!spec.assets) return emptyStorageEffects();
  if (!ports.storage) throw new UnsupportedCapabilityError("storage.objects.local");

  const requestedPuts = normalizeAssetPuts(spec.assets.put ?? []);
  const requestedDeletes = normalizeAssetDeletes(spec.assets.delete ?? []);
  const requestedPutKeys = new Set(requestedPuts.map((put) => put.key));
  const requestedDeleteKeys = new Set(requestedDeletes);
  for (const key of requestedPutKeys) {
    if (requestedDeleteKeys.has(key)) {
      throw new ApplyInvariantError("asset_key_conflict", `Asset key ${key} appears in both put and delete.`);
    }
  }

  const puts: CoreAssetPut[] = [];
  for (const put of requestedPuts) {
    const current = await ports.storage.getObject({ projectId: spec.project, key: put.key });
    if (
      current &&
      current.sha256 === put.sha256 &&
      current.size_bytes === put.size_bytes &&
      current.content_type === put.content_type &&
      current.visibility === put.visibility &&
      current.immutable === put.immutable
    ) {
      continue;
    }
    puts.push(put);
  }

  const deletes: string[] = [];
  for (const key of requestedDeletes) {
    if (await ports.storage.getObject({ projectId: spec.project, key })) {
      deletes.push(key);
    }
  }
  const effectiveDeleteKeys = new Set(deletes);

  let syncPrune: CoreStorageApplyEffects["sync_prune"] = null;
  if (spec.assets.sync) {
    if (spec.assets.sync.prune !== true) {
      throw new ApplyInvariantError("asset_sync_prune_required", "Asset sync only supports prune: true in Core.");
    }
    const prefix = normalizeStoragePrefix(spec.assets.sync.prefix);
    const inventory = await ports.storage.inventoryRevision({
      projectId: spec.project,
      prefix,
    });
    const plannedDeleteKeys = inventory.keys
      .filter((key) => !requestedPutKeys.has(key) && !effectiveDeleteKeys.has(key))
      .sort();
    syncPrune = {
      prefix,
      base_revision: inventory.revision,
      delete_set_digest: computeStorageInventoryRevision(plannedDeleteKeys),
      planned_delete_keys: plannedDeleteKeys,
    };
  }

  const noop = puts.length === 0 && deletes.length === 0 && (syncPrune?.planned_delete_keys.length ?? 0) === 0;
  return {
    puts,
    deletes,
    sync_prune: syncPrune,
    noop,
  };
}

function emptyStorageEffects(): CoreStorageApplyEffects {
  return {
    puts: [],
    deletes: [],
    sync_prune: null,
    noop: true,
  };
}

function normalizeAssetPuts(entries: AssetPutEntryWire[]): CoreAssetPut[] {
  const seen = new Set<string>();
  return entries.map((entry, index) => {
    const key = normalizeStorageKey(entry.key);
    if (seen.has(key)) throw new ApplyInvariantError("asset_duplicate_key", `Duplicate asset put key: ${key}`);
    seen.add(key);
    return {
      key,
      sha256: normalizeSha256Hex(entry.sha256),
      size_bytes: normalizeAssetSize(entry.size_bytes, `assets.put.${index}.size_bytes`),
      content_type: normalizeStorageContentType(entry.content_type),
      visibility: normalizeStorageVisibility(entry.visibility),
      immutable: entry.immutable ?? true,
    };
  });
}

function normalizeAssetDeletes(entries: string[]): string[] {
  const seen = new Set<string>();
  return entries.map((entry) => {
    const key = normalizeStorageKey(entry);
    if (seen.has(key)) throw new ApplyInvariantError("asset_duplicate_key", `Duplicate asset delete key: ${key}`);
    seen.add(key);
    return key;
  });
}

function normalizeAssetSize(value: unknown, resource: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new StorageValidationError("invalid_size", `${resource} must be a positive integer.`);
  }
  return value;
}

function releaseBaseTarget(spec: ReleaseSpec): "empty" | "current" | { release_id: string } {
  if (!spec.base) return "current";
  if ("release_id" in spec.base) return { release_id: spec.base.release_id };
  return spec.base.release;
}

async function verifyStaticContent(
  ports: RuntimeKernelPorts,
  projectId: string,
  release: PortableReleaseState,
): Promise<void> {
  for (const entry of release.site.paths) {
    const present = await ports.content.hasContent(projectId, entry.content_sha256);
    if (!present) {
      throw new ApplyInvariantError(
        "content_digest_missing",
        `Static content ${entry.content_sha256} has not been staged for project ${projectId}.`,
      );
    }
  }
}

async function verifyStorageContent(
  ports: RuntimeKernelPorts,
  projectId: string,
  effects: CoreStorageApplyEffects | undefined,
): Promise<void> {
  for (const put of effects?.puts ?? []) {
    const present = await ports.content.hasContent(projectId, put.sha256);
    if (!present) {
      throw new ApplyInvariantError(
        "content_digest_missing",
        `Asset content ${put.sha256} has not been staged for project ${projectId}.`,
      );
    }
  }
}

async function verifyFunctionContent(
  ports: RuntimeKernelPorts,
  projectId: string,
  effects: CoreFunctionApplyEffects | undefined,
): Promise<void> {
  for (const bundle of effects?.bundles ?? []) {
    const present = await ports.content.hasContent(projectId, bundle.source.sha256);
    if (!present) {
      throw new ApplyInvariantError(
        "content_digest_missing",
        `Function bundle ${bundle.source.sha256} has not been staged for project ${projectId}.`,
      );
    }
  }
}

async function verifyFunctionSecrets(
  ports: RuntimeKernelPorts,
  projectId: string,
  effects: CoreFunctionApplyEffects | undefined,
): Promise<void> {
  const required = [...new Set(effects?.required_secrets ?? [])].sort();
  if (required.length === 0) return;
  if (!ports.secrets) {
    throw new UnsupportedCapabilityError("functions.secrets.local");
  }
  const present = new Set((await ports.secrets.listSecrets({ projectId })).map((secret) => secret.name));
  for (const name of required) {
    if (!present.has(name)) {
      throw new MissingRequiredSecretError(name);
    }
  }
}

async function applyMigrations(ports: RuntimeKernelPorts, spec: ReleaseSpec): Promise<void> {
  const migrations = spec.database?.migrations ?? [];
  for (const migration of migrations) {
    verifyMigrationChecksum(migration);
  }

  if (ports.migrations.applyBatch) {
    await ports.migrations.applyBatch({
      projectId: spec.project,
      schema: schemaForProject(spec.project),
      migrations: migrations.map((migration) => ({
        migrationId: migration.id,
        checksum_hex: migration.checksum.toLowerCase(),
        sql: migration.sql ?? "",
        transaction: migration.transaction === "none" ? "none" : "default",
      })),
    });
    return;
  }

  for (const migration of migrations) {
    const observed = await ports.migrations.check(spec.project, migration.id);
    const checksum = migration.checksum.toLowerCase();
    if (observed.state === "present") {
      if (observed.checksum_hex.toLowerCase() !== checksum) {
        throw new ApplyInvariantError(
          "migration_checksum_conflict",
          `Migration ${migration.id} was already applied with a different checksum.`,
        );
      }
      continue;
    }
    await ports.migrations.applyInline({
      projectId: spec.project,
      schema: schemaForProject(spec.project),
      migrationId: migration.id,
      checksum_hex: checksum,
      sql: migration.sql ?? "",
      transaction: migration.transaction === "none" ? "none" : "default",
    });
  }
}

function schemaForProject(projectId: string): string {
  return `project_${projectId.slice("prj_".length)}`;
}

function verifyMigrationChecksum(migration: MigrationSpec): void {
  const expected = migration.checksum.toLowerCase();
  const actual = sha256Hex(migration.sql ?? "");
  if (actual !== expected) {
    throw new ApplyInvariantError(
      "migration_checksum_mismatch",
      `Migration ${migration.id} checksum does not match its inline SQL.`,
    );
  }
}

export function verifyContentRefBytes(ref: ContentRefHex, bytes: Uint8Array): void {
  if (bytes.byteLength !== ref.size) {
    throw new ApplyInvariantError("content_size_mismatch", "Content bytes do not match the declared size.");
  }
  if (sha256Hex(bytes) !== ref.sha256.toLowerCase()) {
    throw new ApplyInvariantError("content_digest_mismatch", "Content bytes do not match the declared SHA-256 digest.");
  }
}

export function releaseIdFromDigest(digest: string): string {
  const suffix = digest.split(":").at(-1) ?? digest;
  return `rel_${suffix.slice(0, 24)}`;
}

function publicPlan(plan: CoreApplyPlan): CoreApplyPlan {
  return {
    plan_id: plan.plan_id,
    project_id: plan.project_id,
    release_spec_digest: plan.release_spec_digest,
    base_release_id: plan.base_release_id,
    target_release_id: plan.target_release_id,
    target_release_digest: plan.target_release_digest,
    ...(plan.storage_effects ? { storage_effects: plan.storage_effects } : {}),
    ...(plan.function_effects ? { function_effects: plan.function_effects } : {}),
    noop: plan.noop,
    status: plan.status,
    created_at: plan.created_at,
  };
}

function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

export function emptyCoreReleaseState(): PortableReleaseState {
  return emptyPortableReleaseState();
}
