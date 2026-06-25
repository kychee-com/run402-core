import { createHash } from "node:crypto";
import {
  digestApplyRequest,
  digestMaterializedRelease,
  emptyPortableReleaseState,
  materializeRelease,
  parseReleaseSpec,
  type AssetPutEntryWire,
  type ContentRefHex,
  type MigrationSpec,
  type PortableReleaseState,
  type ReleaseSpec,
} from "@run402/release";
import type { CoreApplyCommitContext, CoreApplyPlan, CoreAssetPut, CoreStorageApplyEffects, RuntimeKernelPorts } from "./ports.js";
import { UnsupportedCapabilityError } from "./errors.js";
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
  validateSupportedSpec(spec);
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
    noop: targetDigest === baseDigest && storageEffects.noop,
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
  validateSupportedSpec(spec);

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
  });

  await verifyStaticContent(ports, plan.project_id, plan.target_release);
  await verifyStorageContent(ports, plan.project_id, plan.storage_effects);

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

function validateSupportedSpec(spec: ReleaseSpec): void {
  if (spec.functions) throw new UnsupportedCapabilityError("functions.node");
  if (spec.secrets) throw new UnsupportedCapabilityError("secrets.hosted");
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
    if (route.target.type !== "static") {
      throw new UnsupportedCapabilityError("functions.node");
    }
  }
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
