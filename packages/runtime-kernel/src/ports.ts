import type {
  ContentRefHex,
  MaterializedRoutes,
  PortableReleaseState,
  StaticManifest,
} from "@run402/release";
import type { RuntimeCapabilityDocument } from "./capabilities.js";
import type {
  CoreFunctionApplyEffects,
  CoreFunctionBundleMetadata,
  CoreFunctionInvocationInput,
  CoreFunctionInvocationResult,
  CoreFunctionInvocationRecord,
  CoreFunctionLogEntry,
  CoreFunctionSecretMetadata,
} from "./functions-runtime.js";

export interface CoreProject {
  project_id: string;
  schema_slot: string;
  public_id: string;
  anon_key: string;
  service_key: string;
  endpoints: {
    rest_url: string;
    static_base_url: string;
    storage_base_url?: string;
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
  storage_effects?: CoreStorageApplyEffects;
  function_effects?: CoreFunctionApplyEffects;
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
  storage_effects?: CoreStorageApplyEffects;
  function_effects?: CoreFunctionApplyEffects;
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
  putCas?(input: {
    sha256: string;
    bytes: Uint8Array;
    contentType: string;
  }): Promise<void>;
  readCas?(sha256: string): Promise<{ bytes: Uint8Array; contentType: string } | null>;
  putUploadBytes?(input: {
    projectId: string;
    uploadId: string;
    bytes: Uint8Array;
  }): Promise<{ size_bytes: number }>;
  promoteUpload?(input: {
    projectId: string;
    uploadId: string;
    ref: ContentRefHex;
  }): Promise<{ sha256: string; size_bytes: number; content_type: string }>;
  deleteUploadBytes?(input: {
    projectId: string;
    uploadId: string;
  }): Promise<void>;
}

export type StorageObjectVisibility = "public" | "private";
export type UploadSessionStatus = "active" | "uploaded" | "completed" | "aborted";

export interface CoreStorageObject {
  project_id: string;
  key: string;
  sha256: string;
  size_bytes: number;
  content_type: string;
  visibility: StorageObjectVisibility;
  immutable: boolean;
  created_at: string;
  updated_at: string;
  public_url?: string;
  immutable_url?: string;
}

export interface CoreImmutableObjectVersion {
  project_id: string;
  key: string;
  sha256: string;
  version_id: string;
  size_bytes: number;
  content_type: string;
  visibility: StorageObjectVisibility;
  public_url_key: string;
  created_at: string;
  retained_until: string | null;
  public_url?: string;
}

export interface CoreUploadSession {
  upload_id: string;
  project_id: string;
  key: string;
  declared_size: number;
  declared_sha256: string;
  content_type: string;
  visibility: StorageObjectVisibility;
  immutable: boolean;
  status: UploadSessionStatus;
  upload_url: string;
  bytes_written: number;
  expires_at: string;
  completed_at: string | null;
  aborted_at: string | null;
  created_at: string;
}

export interface CoreStorageObjectList {
  objects: CoreStorageObject[];
  next_cursor: string | null;
}

export interface CoreAssetPut {
  key: string;
  sha256: string;
  size_bytes: number;
  content_type: string;
  visibility: StorageObjectVisibility;
  immutable: boolean;
}

export interface CoreAssetSyncPrunePlan {
  prefix: string;
  base_revision: string;
  delete_set_digest: string;
  planned_delete_keys: string[];
}

export interface CoreStorageApplyEffects {
  puts: CoreAssetPut[];
  deletes: string[];
  sync_prune: CoreAssetSyncPrunePlan | null;
  noop: boolean;
}

export interface RouteStaticResponse {
  status: 200;
  sha256: string;
  content_type: string;
  content_length: number;
  etag: string;
  cache_control: string;
  bytes: Uint8Array;
}

export interface CoreRouteManifest {
  project_id: string;
  release_id: string | null;
  route_manifest_sha256: string | null;
  static_manifest_sha256: string | null;
  routes: MaterializedRoutes;
  static_manifest: StaticManifest | null;
}

export interface CleanupResult {
  removed_uploads: number;
  removed_objects: number;
  removed_versions: number;
  removed_cas_objects: number;
  removed_function_bundles?: number;
  removed_function_logs?: number;
  retained_live_sha256: string[];
}

export interface FunctionRuntimePort {
  stageBundles(input: {
    projectId: string;
    releaseId: string;
    bundles: CoreFunctionBundleMetadata[];
  }): Promise<void>;
  activateRelease(input: {
    projectId: string;
    releaseId: string;
    expectedBaseReleaseId: string | null;
    effects: CoreFunctionApplyEffects;
  }): Promise<void>;
  invoke(input: CoreFunctionInvocationInput): Promise<CoreFunctionInvocationResult>;
  listLogs(input: {
    projectId: string;
    functionName?: string;
    requestId?: string;
    since?: string;
    tail?: number;
  }): Promise<CoreFunctionLogEntry[]>;
  listSecrets(input: {
    projectId: string;
    functionName?: string;
  }): Promise<CoreFunctionSecretMetadata[]>;
  cleanup(projectId?: string): Promise<{
    removed_function_bundles: number;
    removed_function_logs: number;
    retained_live_sha256: string[];
  }>;
}

export interface FunctionSecretPort {
  setSecret(input: {
    projectId: string;
    name: string;
    value: string;
    scope?: "project" | "release" | "function";
    functionName?: string | null;
  }): Promise<CoreFunctionSecretMetadata>;
  listSecrets(input: {
    projectId: string;
    functionName?: string;
  }): Promise<CoreFunctionSecretMetadata[]>;
  getSecretValues(input: {
    projectId: string;
    functionName: string;
    names: string[];
  }): Promise<Record<string, string>>;
}

export interface FunctionLogPort {
  recordInvocation(input: {
    invocation: CoreFunctionInvocationRecord;
    logs: CoreFunctionLogEntry[];
    retention?: {
      maxAgeMs?: number;
      maxBytes?: number;
    };
  }): Promise<void>;
  listLogs(input: {
    projectId: string;
    functionName?: string;
    requestId?: string;
    since?: string;
    tail?: number;
  }): Promise<CoreFunctionLogEntry[]>;
}

export interface StoragePort {
  createUploadSession(input: {
    projectId: string;
    key: string;
    sizeBytes: number;
    sha256: string;
    contentType: string;
    visibility: StorageObjectVisibility;
    immutable: boolean;
    ttlSeconds?: number;
  }): Promise<CoreUploadSession>;
  getUploadSession(input: {
    projectId: string;
    uploadId: string;
  }): Promise<CoreUploadSession | null>;
  markUploadBytesStored(input: {
    projectId: string;
    uploadId: string;
    sizeBytes: number;
  }): Promise<CoreUploadSession>;
  completeUploadSession(input: {
    projectId: string;
    uploadId: string;
  }): Promise<CoreStorageObject>;
  abortUploadSession(input: {
    projectId: string;
    uploadId: string;
  }): Promise<CoreUploadSession>;
  getObject(input: {
    projectId: string;
    key: string;
  }): Promise<CoreStorageObject | null>;
  listObjects(input: {
    projectId: string;
    prefix?: string;
    limit?: number;
    cursor?: string;
  }): Promise<CoreStorageObjectList>;
  inventoryRevision(input: {
    projectId: string;
    prefix: string;
  }): Promise<{
    keys: string[];
    revision: string;
  }>;
  commitAssetPlan(input: {
    projectId: string;
    effects: CoreStorageApplyEffects;
  }): Promise<void>;
  deleteObject(input: {
    projectId: string;
    key: string;
  }): Promise<boolean>;
  getImmutableVersion(input: {
    projectId: string;
    key: string;
    sha256: string;
  }): Promise<CoreImmutableObjectVersion | null>;
}

export interface SignedReadPort {
  signRead(input: {
    projectId: string;
    key: string;
    ttlSeconds?: number;
    sha256?: string | null;
  }): Promise<{
    expires_at: string;
    signed_url: string;
  }>;
  verifyRead(input: {
    projectId: string;
    key: string;
    expiresAtEpochSeconds: number;
    signature: string;
    sha256?: string | null;
  }): Promise<boolean>;
}

export interface RouteManifestPort {
  getActiveRouteManifest(projectId: string): Promise<CoreRouteManifest | null>;
}

export interface CleanupPort {
  sweep(projectId?: string): Promise<CleanupResult>;
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
  storage?: StoragePort;
  signedReads?: SignedReadPort;
  routes?: RouteManifestPort;
  cleanup?: CleanupPort;
  functions?: FunctionRuntimePort;
  secrets?: FunctionSecretPort;
  migrations: MigrationPort;
  lifecycle?: ApplyLifecyclePort;
}
