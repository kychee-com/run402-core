import { createHash } from "node:crypto";
import {
  digestApplyRequest,
  digestMaterializedRelease,
  emptyPortableReleaseState,
  materializeRelease,
  parseReleaseSpec,
  type ContentRefHex,
  type MigrationSpec,
  type PortableReleaseState,
  type ReleaseSpec,
} from "@run402/release";
import type { CoreApplyCommitContext, CoreApplyPlan, RuntimeKernelPorts } from "./ports.js";
import { UnsupportedCapabilityError } from "./errors.js";
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
    noop: targetDigest === baseDigest,
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
  });

  await verifyStaticContent(ports, plan.project_id, plan.target_release);

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
  if (spec.assets) throw new UnsupportedCapabilityError("storage.user-api");
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
