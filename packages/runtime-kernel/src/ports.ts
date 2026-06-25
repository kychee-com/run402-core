import type { PortableReleaseState } from "@run402/release";
import type { RuntimeCapabilityDocument } from "./capabilities.js";

export interface CoreProject {
  project_id: string;
  schema_slot: string;
  public_id: string;
  anon_key: string;
  service_key: string;
  endpoints: {
    rest_url: string;
    static_base_url: string;
  };
  active_release_id: string | null;
  capabilities: RuntimeCapabilityDocument;
}

export interface ProjectCatalogPort {
  create(input: { name: string }): Promise<CoreProject>;
  inspect(projectId: string): Promise<CoreProject | null>;
}

export interface ReleaseStatePort {
  getBase(projectId: string, target: "empty" | "current" | { release_id: string }): Promise<{
    release_id: string | null;
    state: PortableReleaseState;
  }>;
  setActiveRelease(input: {
    projectId: string;
    releaseId: string;
    digest: string;
    release: PortableReleaseState;
    expectedBaseReleaseId: string | null;
  }): Promise<void>;
}

export interface CoreApplyPlan {
  plan_id: string;
  project_id: string;
  release_spec_digest: string;
  base_release_id: string | null;
  target_release_id: string;
  target_release_digest: string;
  noop: boolean;
  status: "planned" | "committed";
  created_at: string;
}

export interface StoredCoreApplyPlan extends CoreApplyPlan {
  spec: unknown;
  target_release: PortableReleaseState;
}

export interface CoreApplyCommitContext {
  plan: StoredCoreApplyPlan;
  spec: unknown;
  release_id: string;
  release_digest: string;
  target_release: PortableReleaseState;
}

export interface CoreApplyDeferredResult {
  status: "deferred";
  phase: "schema_settling" | "activation_pending";
  reason: string;
}

export interface CoreApplyActivatedResult {
  status: "activated";
  release_id?: string;
}

export interface ApplyLifecyclePort {
  stage?(context: CoreApplyCommitContext): Promise<{ release_id?: string } | void>;
  beforeMigrate?(context: CoreApplyCommitContext): Promise<void>;
  applyRestExposure?(context: CoreApplyCommitContext): Promise<CoreApplyDeferredResult | void>;
  settleSchema?(context: CoreApplyCommitContext): Promise<CoreApplyDeferredResult | void>;
  activate?(context: CoreApplyCommitContext): Promise<CoreApplyActivatedResult | CoreApplyDeferredResult>;
  committed?(context: CoreApplyCommitContext): Promise<void>;
}

export interface ApplyPlanStorePort {
  create(input: Omit<StoredCoreApplyPlan, "plan_id" | "created_at" | "status">): Promise<StoredCoreApplyPlan>;
  get(planId: string): Promise<StoredCoreApplyPlan | null>;
  markCommitted(planId: string): Promise<void>;
}

export interface ContentStorePort {
  putStatic(input: {
    projectId: string;
    sha256: string;
    bytes: Uint8Array;
    contentType: string;
  }): Promise<void>;
  hasContent(projectId: string, sha256: string): Promise<boolean>;
  readStatic(projectId: string, sha256: string): Promise<{ bytes: Uint8Array; contentType: string } | null>;
}

export interface MigrationPort {
  check(projectId: string, migrationId: string): Promise<
    | { state: "absent" }
    | { state: "present"; checksum_hex: string }
  >;
  applyBatch?(input: {
    projectId: string;
    schema: string;
    migrations: Array<{
      migrationId: string;
      checksum_hex: string;
      sql: string;
      transaction: "default" | "none";
    }>;
  }): Promise<void>;
  applyInline(input: {
    projectId: string;
    schema: string;
    migrationId: string;
    checksum_hex: string;
    sql: string;
    transaction: "default" | "none";
  }): Promise<void>;
}

export interface RuntimeKernelPorts {
  projects: ProjectCatalogPort;
  releases: ReleaseStatePort;
  plans: ApplyPlanStorePort;
  content: ContentStorePort;
  migrations: MigrationPort;
  lifecycle?: ApplyLifecyclePort;
}
