import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  createCoreProject,
  commitApplyPlan,
  createApplyPlan,
  AstroSsrUnsupportedFeatureError,
  CORE_ASTRO_SSR_FALLBACK_PATTERN,
  CORE_ASTRO_SSR_OUTPUT_CONTRACT_VERSION,
  CORE_FUNCTION_DEFAULT_EXECUTOR,
  CORE_FUNCTION_DEPENDENCY_MODE,
  emptyCoreReleaseState,
  ApplyInvariantError,
  DependencyInstallRejectedError,
  DynamicRuntimeUnavailableError,
  FunctionBundleValidationError,
  inspectCoreProject,
  MissingRequiredSecretError,
  ProjectNotFoundError,
  projectNotFoundEnvelope,
  RUNTIME_KERNEL_CONTRACT_VERSION,
  UnsupportedCapabilityError,
  validateProjectId,
  runtimeCapabilities,
  runtimeHealth,
  normalizeStorageKey,
  StorageValidationError,
  createStorageReadSignature,
  computeStorageInventoryRevision,
  verifyStorageReadSignature,
  runtimeKernelErrorEnvelope,
  unsupportedCapabilityEnvelope,
  type CoreProject,
  type CoreStorageObject,
  type CoreStorageApplyEffects,
  type ProjectCatalogPort,
  type RuntimeKernelPorts,
  type StoredCoreApplyPlan,
} from "./index.js";

test("runtime capability document advertises first-slice boundaries", () => {
  const capabilities = runtimeCapabilities("test");

  assert.equal(capabilities.runtime_contract_version, RUNTIME_KERNEL_CONTRACT_VERSION);
  assert.ok(capabilities.supported_features.includes("projects.create.local"));
  assert.ok(capabilities.supported_features.includes("database.rest.postgrest"));
  assert.ok(capabilities.supported_features.includes("storage.objects.local"));
  assert.ok(capabilities.supported_features.includes("site.static.exact-alias-routes"));
  assert.ok(capabilities.supported_features.includes("functions.node"));
  assert.ok(capabilities.supported_features.includes("functions.routed-http.local"));
  assert.ok(capabilities.supported_features.includes("astro.ssr"));
  assert.ok(capabilities.supported_features.includes("astro.ssr.run402-output-v1"));
  assert.ok(capabilities.supported_features.includes("archives.format.run402-project-archive-v1"));
  assert.ok(capabilities.supported_features.includes("archives.verify.local"));
  assert.ok(capabilities.supported_features.includes("archives.import.local-new-project"));
  assert.equal(capabilities.functions_runtime.maturity, "developer_preview");
  assert.equal(capabilities.astro_ssr_runtime.maturity, "developer_preview");
  assert.equal(capabilities.portable_archives.maturity, "developer_preview");
  assert.equal(capabilities.portable_archives.local_verify, true);
  assert.equal(capabilities.portable_archives.local_import, true);
  assert.equal(capabilities.astro_ssr_runtime.output_contract_version, CORE_ASTRO_SSR_OUTPUT_CONTRACT_VERSION);
  assert.equal(capabilities.astro_ssr_runtime.fallback.pattern, CORE_ASTRO_SSR_FALLBACK_PATTERN);
  assert.equal(capabilities.functions_runtime.default_executor, CORE_FUNCTION_DEFAULT_EXECUTOR);
  assert.equal(capabilities.functions_runtime.hostile_code_isolation, false);
  assert.equal(capabilities.functions_runtime.dependency_policy.mode, CORE_FUNCTION_DEPENDENCY_MODE);
  assert.equal(capabilities.functions_runtime.dependency_policy.npm_install_supported, false);
  assert.ok(capabilities.unsupported_features.some((entry) => entry.feature === "functions.external-npm-dependencies"));
  assert.ok(capabilities.unsupported_features.some((entry) => entry.feature === "astro.streaming"));
  assert.ok(capabilities.unsupported_features.some((entry) => entry.feature === "archives.import.existing-project-merge"));
  assert.equal(capabilities.unsupported_features.some((entry) => entry.feature === "functions.node"), false);
  assert.equal(capabilities.unsupported_features.some((entry) => entry.feature === "astro.ssr"), false);
  assert.equal(capabilities.unsupported_features.some((entry) => entry.feature === "storage.user-api"), false);
  assert.ok(capabilities.unsupported_features.every((entry) => entry.error === "unsupported_capability"));
});

test("health is derived from capabilities", () => {
  const capabilities = runtimeCapabilities("test");
  const health = runtimeHealth(capabilities);

  assert.deepEqual(health, {
    status: "ok",
    mode: "core",
    runtime_contract_version: RUNTIME_KERNEL_CONTRACT_VERSION,
    supported_features: capabilities.supported_features.length,
    unsupported_features: capabilities.unsupported_features.length,
  });
});

test("unsupported capability errors have stable envelope", () => {
  const error = new UnsupportedCapabilityError("functions.node");

  assert.equal(error.code, "unsupported_capability");
  assert.equal(error.status, 422);
  assert.deepEqual(unsupportedCapabilityEnvelope(error), {
    error: "unsupported_capability",
    message: "Unsupported runtime capability: functions.node",
    capability: "functions.node",
  });
});

test("typed dynamic runtime errors have stable envelope", () => {
  const error = new DynamicRuntimeUnavailableError("No worker configured.", { function_name: "api" });

  assert.equal(error.code, "dynamic_runtime_unavailable");
  assert.equal(error.status, 503);
  assert.deepEqual(runtimeKernelErrorEnvelope(error), {
    error: "dynamic_runtime_unavailable",
    message: "No worker configured.",
    details: { function_name: "api" },
  });
});

test("storage key validation rejects traversal and internal namespaces", () => {
  assert.equal(normalizeStorageKey("images/logo.png"), "images/logo.png");
  assert.throws(
    () => normalizeStorageKey("../secret.txt"),
    (error) => error instanceof StorageValidationError && error.code === "invalid_storage_key",
  );
  assert.throws(
    () => normalizeStorageKey("_cas/aa/object"),
    (error) => error instanceof StorageValidationError && error.code === "invalid_storage_key",
  );
  assert.throws(
    () => normalizeStorageKey("images%2Flogo.png"),
    (error) => error instanceof StorageValidationError && error.code === "invalid_storage_key",
  );
});

test("storage signed-read signatures verify expiry and payload", () => {
  const signature = createStorageReadSignature({
    secret: "secret",
    projectId: "prj_0000000000000001",
    key: "private/report.pdf",
    expiresAtEpochSeconds: 100,
  });

  assert.equal(verifyStorageReadSignature({
    secret: "secret",
    projectId: "prj_0000000000000001",
    key: "private/report.pdf",
    expiresAtEpochSeconds: 100,
    signature,
    nowEpochSeconds: 99,
  }), true);
  assert.equal(verifyStorageReadSignature({
    secret: "secret",
    projectId: "prj_0000000000000001",
    key: "private/other.pdf",
    expiresAtEpochSeconds: 100,
    signature,
    nowEpochSeconds: 99,
  }), false);
  assert.equal(verifyStorageReadSignature({
    secret: "secret",
    projectId: "prj_0000000000000001",
    key: "private/report.pdf",
    expiresAtEpochSeconds: 100,
    signature,
    nowEpochSeconds: 101,
  }), false);
});

test("project service normalizes default names and delegates creation", async () => {
  const catalog = new MemoryProjectCatalog();
  const project = await createCoreProject({ projects: catalog }, {});

  assert.equal(catalog.createdNames[0], "local-project");
  assert.equal(project.project_id, "prj_0000000000000001");
});

test("project inspect validates ids and maps missing projects", async () => {
  const catalog = new MemoryProjectCatalog();
  let error: unknown;
  try {
    await inspectCoreProject({ projects: catalog }, { project_id: "prj_0000000000000001" });
  } catch (caught) {
    error = caught;
  }

  assert.ok(error instanceof ProjectNotFoundError);
  assert.deepEqual(projectNotFoundEnvelope(error as ProjectNotFoundError), {
    error: "project_not_found",
    message: "Run402 Core project not found: prj_0000000000000001",
    project_id: "prj_0000000000000001",
  });
  await assert.rejects(
    inspectCoreProject({ projects: catalog }, { project_id: "not-a-project-id" }),
    RangeError,
  );
});

test("project id validation accepts existing Cloud id shapes", () => {
  assert.equal(validateProjectId("prj_1776162941487_0008"), "prj_1776162941487_0008");
  assert.equal(validateProjectId("prj_test"), "prj_test");
});

test("commit apply plan delegates supported lifecycle phases in public order", async () => {
  const order: string[] = [];
  const ports = new MemoryRuntimePorts({
    order,
    lifecycle: {
      async stage() {
        order.push("stage");
        return { release_id: "rel_cloud_generated" };
      },
      async beforeMigrate() {
        order.push("beforeMigrate");
      },
      async applyRestExposure(context) {
        assert.equal(context.release_id, "rel_cloud_generated");
        order.push("applyRestExposure");
      },
      async settleSchema() {
        order.push("settleSchema");
      },
      async activate(context) {
        assert.equal(context.release_id, "rel_cloud_generated");
        order.push("activate");
        return { status: "activated" };
      },
      async committed() {
        order.push("committed");
      },
    },
  });

  const plan = await createApplyPlan(ports, { spec: supportedMigrationSpec() });
  const result = await commitApplyPlan(ports, { plan_id: plan.plan_id });

  assert.equal(result.status, "committed");
  assert.equal(result.release_id, "rel_cloud_generated");
  assert.deepEqual(order, [
    "stage",
    "beforeMigrate",
    "migration.check",
    "migration.apply",
    "applyRestExposure",
    "settleSchema",
    "activate",
    "plan.markCommitted",
    "committed",
  ]);
});

test("commit apply plan can defer during lifecycle without marking plan committed", async () => {
  const order: string[] = [];
  const ports = new MemoryRuntimePorts({
    order,
    lifecycle: {
      async settleSchema() {
        order.push("settleSchema");
        return {
          status: "deferred",
          phase: "schema_settling",
          reason: "PostgREST schema cache has not converged.",
        };
      },
    },
  });

  const plan = await createApplyPlan(ports, { spec: supportedMigrationSpec() });
  const result = await commitApplyPlan(ports, { plan_id: plan.plan_id });

  assert.deepEqual(result, {
    plan_id: plan.plan_id,
    project_id: "prj_0000000000000001",
    release_id: plan.target_release_id,
    release_digest: plan.target_release_digest,
    status: "deferred",
    deferred_phase: "schema_settling",
    deferred_reason: "PostgREST schema cache has not converged.",
  });
  assert.equal((await ports.plans.get(plan.plan_id))?.status, "planned");
  assert.deepEqual(order, [
    "migration.check",
    "migration.apply",
    "settleSchema",
  ]);
});

test("commit apply plan verifies static content before provider staging", async () => {
  const order: string[] = [];
  const ports = new MemoryRuntimePorts({
    order,
    contentPresent: false,
    lifecycle: {
      async stage() {
        order.push("stage");
      },
    },
  });

  const plan = await createApplyPlan(ports, {
    spec: {
      project: "prj_0000000000000001",
      base: { release: "empty" },
      site: {
        replace: {
          "index.html": {
            sha256: "a".repeat(64),
            size: 1,
            contentType: "text/html",
          },
        },
        public_paths: {
          mode: "explicit",
          replace: {
            "/": { asset: "index.html" },
          },
        },
      },
    },
  });

  await assert.rejects(
    commitApplyPlan(ports, { plan_id: plan.plan_id }),
    (error) => error instanceof ApplyInvariantError && error.code === "content_digest_missing",
  );
  assert.deepEqual(order, ["content.hasContent"]);
});

test("commit apply plan short-circuits no-op plans before lifecycle side effects", async () => {
  const order: string[] = [];
  const ports = new MemoryRuntimePorts({
    order,
    activeReleaseId: "rel_existing",
    lifecycle: {
      async stage() {
        order.push("stage");
      },
    },
  });
  const empty = emptyCoreReleaseState();
  ports.seedRelease("rel_existing", empty);
  const plan = await ports.plans.create({
    project_id: "prj_0000000000000001",
    spec: { project: "prj_0000000000000001" },
    release_spec_digest: "digest:spec",
    base_release_id: "rel_existing",
    target_release_id: "rel_should_not_activate",
    target_release_digest: "digest:release",
    target_release: empty,
    noop: true,
  });

  const result = await commitApplyPlan(ports, { plan_id: plan.plan_id });

  assert.equal(result.status, "noop");
  assert.equal(result.release_id, "rel_existing");
  assert.deepEqual(order, ["plan.markCommitted"]);
});

test("apply plan commits asset storage effects through the storage port", async () => {
  const storage = new MemoryStoragePort(["assets/old.txt", "assets/stale.txt"]);
  const ports = new MemoryRuntimePorts({
    storage,
    contentPresent: true,
  });
  const plan = await createApplyPlan(ports, {
    spec: {
      project: "prj_0000000000000001",
      base: { release: "empty" },
      assets: {
        put: [{
          key: "assets/app.js",
          sha256: "b".repeat(64),
          size_bytes: 12,
          content_type: "text/javascript",
          visibility: "public",
          immutable: true,
        }],
        delete: ["assets/old.txt"],
        sync: {
          prefix: "assets/",
          prune: true,
        },
      },
    },
  });

  assert.equal(plan.noop, false);
  assert.deepEqual(plan.storage_effects?.sync_prune?.planned_delete_keys, ["assets/stale.txt"]);
  const result = await commitApplyPlan(ports, { plan_id: plan.plan_id });

  assert.equal(result.status, "committed");
  assert.equal(storage.committed?.puts[0]?.key, "assets/app.js");
  assert.deepEqual(storage.committed?.deletes, ["assets/old.txt"]);
  assert.deepEqual(storage.committed?.sync_prune?.planned_delete_keys, ["assets/stale.txt"]);
});

test("asset sync-prune rejects stale inventory at commit", async () => {
  const storage = new MemoryStoragePort(["assets/a.txt"]);
  const ports = new MemoryRuntimePorts({
    storage,
    contentPresent: true,
  });
  const plan = await createApplyPlan(ports, {
    spec: {
      project: "prj_0000000000000001",
      base: { release: "empty" },
      assets: {
        sync: {
          prefix: "assets/",
          prune: true,
        },
      },
    },
  });
  storage.keys.push("assets/b.txt");

  await assert.rejects(
    commitApplyPlan(ports, { plan_id: plan.plan_id }),
    (error) => error instanceof ApplyInvariantError && error.code === "asset_sync_drift",
  );
});

test("asset reapply with identical object metadata is a no-op", async () => {
  const existing: CoreStorageObject = {
    project_id: "prj_0000000000000001",
    key: "assets/app.js",
    sha256: "b".repeat(64),
    size_bytes: 12,
    content_type: "text/javascript",
    visibility: "public",
    immutable: true,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
  };
  const storage = new MemoryStoragePort([existing.key], [existing]);
  const ports = new MemoryRuntimePorts({
    storage,
    activeReleaseId: "rel_existing",
    contentPresent: true,
  });
  ports.seedRelease("rel_existing", emptyCoreReleaseState());

  const plan = await createApplyPlan(ports, {
    spec: {
      project: "prj_0000000000000001",
      assets: {
        put: [{
          key: existing.key,
          sha256: existing.sha256,
          size_bytes: existing.size_bytes,
          content_type: existing.content_type,
          visibility: existing.visibility,
          immutable: existing.immutable,
        }],
      },
    },
  });

  assert.equal(plan.noop, true);
  const result = await commitApplyPlan(ports, { plan_id: plan.plan_id });
  assert.equal(result.status, "noop");
  assert.equal(storage.committed, null);
});

test("apply plan accepts first-slice prebundled function metadata", async () => {
  const source = Buffer.from("export default async function handler() { return { status: 200 }; }\n");
  const sourceSha = sha256Hex(source);
  const order: string[] = [];
  const ports = new MemoryRuntimePorts({ contentPresent: true, order });

  const plan = await createApplyPlan(ports, {
    spec: {
      project: "prj_0000000000000001",
      base: { release: "empty" },
      functions: {
        replace: {
          api: {
            runtime: "node22",
            source: {
              sha256: sourceSha,
              size: source.byteLength,
              contentType: "application/javascript",
            },
            requireAuth: true,
            requireRole: {
              table: "members",
              idColumn: "user_id",
              roleColumn: "role",
              allowed: ["admin"],
              cacheTtl: 0,
            },
          },
        },
      },
      routes: {
        replace: [{
          pattern: "/api/*",
          methods: ["GET", "POST"],
          target: { type: "function", name: "api" },
        }],
      },
    },
  });

  assert.equal(plan.noop, false);
  assert.equal(plan.function_effects?.bundles[0]?.name, "api");
  assert.equal(plan.function_effects?.bundles[0]?.source.sha256, sourceSha);
  assert.equal(plan.function_effects?.bundles[0]?.dependency_mode, CORE_FUNCTION_DEPENDENCY_MODE);
  assert.equal(plan.function_effects?.bundles[0]?.require_auth, true);
  assert.equal(plan.function_effects?.dynamic_routes[0]?.pattern, "/api/*");

  const result = await commitApplyPlan(ports, { plan_id: plan.plan_id });
  assert.equal(result.status, "committed");
  assert.equal(ports.activeReleaseId, result.release_id);
  assert.deepEqual(order, [
    "content.hasContent",
    "release.setActiveRelease",
    "plan.markCommitted",
  ]);
});

test("function apply verifies source content before activation", async () => {
  const ports = new MemoryRuntimePorts({ contentPresent: false });
  const plan = await createApplyPlan(ports, {
    spec: prebundledFunctionSpec("b".repeat(64), 12),
  });

  await assert.rejects(
    commitApplyPlan(ports, { plan_id: plan.plan_id }),
    (error) => error instanceof ApplyInvariantError && error.code === "content_digest_missing",
  );
});

test("function apply forwards effects to lifecycle activation", async () => {
  const source = Buffer.from("export default async function handler() { return { status: 200 }; }\n");
  const sourceSha = sha256Hex(source);
  let activatedBundleNames: string[] = [];
  const ports = new MemoryRuntimePorts({
    contentPresent: true,
    lifecycle: {
      async activate(context) {
        activatedBundleNames = context.function_effects?.bundles.map((bundle) => bundle.name) ?? [];
        return { status: "activated" };
      },
    },
  });

  const plan = await createApplyPlan(ports, {
    spec: prebundledFunctionSpec(sourceSha, source.byteLength),
  });
  const result = await commitApplyPlan(ports, { plan_id: plan.plan_id });

  assert.equal(result.status, "committed");
  assert.deepEqual(activatedBundleNames, ["api"]);
});

test("function commit verifies required secrets before activation", async () => {
  const missingPorts = new MemoryRuntimePorts({ secrets: new MemorySecretPort() });
  const missingPlan = await createApplyPlan(missingPorts, {
    spec: {
      ...prebundledFunctionSpec("5".repeat(64), 12),
      secrets: { require: ["API_TOKEN"] },
    },
  });
  await assert.rejects(
    commitApplyPlan(missingPorts, { plan_id: missingPlan.plan_id }),
    (error) => error instanceof MissingRequiredSecretError && error.code === "missing_required_secret",
  );

  const presentPorts = new MemoryRuntimePorts({
    secrets: new MemorySecretPort({ API_TOKEN: "secret-value" }),
  });
  const presentPlan = await createApplyPlan(presentPorts, {
    spec: {
      ...prebundledFunctionSpec("6".repeat(64), 12),
      secrets: { require: ["API_TOKEN"] },
    },
  });
  const committed = await commitApplyPlan(presentPorts, { plan_id: presentPlan.plan_id });

  assert.equal(committed.status, "committed");
  assert.deepEqual(presentPlan.function_effects?.required_secrets, ["API_TOKEN"]);
  assert.deepEqual(presentPlan.function_effects?.bundles[0]?.required_secrets, ["API_TOKEN"]);
});

test("function reapply with identical bundle and routes is a no-op", async () => {
  const source = Buffer.from("export default async function handler() { return { status: 200 }; }\n");
  const sourceSha = sha256Hex(source);
  const order: string[] = [];
  const ports = new MemoryRuntimePorts({ contentPresent: true, order });

  const firstPlan = await createApplyPlan(ports, {
    spec: prebundledFunctionSpec(sourceSha, source.byteLength),
  });
  const firstResult = await commitApplyPlan(ports, { plan_id: firstPlan.plan_id });
  assert.equal(firstResult.status, "committed");
  order.length = 0;

  const secondPlan = await createApplyPlan(ports, {
    spec: prebundledCurrentFunctionSpec(sourceSha, source.byteLength),
  });
  assert.equal(secondPlan.noop, true);

  const secondResult = await commitApplyPlan(ports, { plan_id: secondPlan.plan_id });

  assert.equal(secondResult.status, "noop");
  assert.equal(secondResult.release_id, firstResult.release_id);
  assert.equal(ports.activeReleaseId, firstResult.release_id);
  assert.deepEqual(order, ["plan.markCommitted"]);
});

test("function no-op comparison tolerates JSONB key and array ordering", async () => {
  const source = Buffer.from("export default async function handler() { return { status: 200 }; }\n");
  const sourceSha = sha256Hex(source);
  const sourceRef = {
    sha256: sourceSha,
    size: source.byteLength,
    contentType: "application/javascript",
  };
  const spec = {
    project: "prj_0000000000000001",
    base: { release: "empty" },
    secrets: { require: ["API_TOKEN"] },
    functions: {
      replace: {
        api: { runtime: "node22", source: sourceRef },
        admin: {
          runtime: "node22",
          source: sourceRef,
          requireAuth: true,
          requireRole: {
            table: "members",
            idColumn: "user_id",
            roleColumn: "role",
            allowed: ["admin"],
            cacheTtl: 0,
          },
        },
      },
    },
    routes: {
      replace: [
        { pattern: "/api/*", target: { type: "function", name: "api" } },
        { pattern: "/admin/*", target: { type: "function", name: "admin" } },
      ],
    },
  };
  const secretPorts = new MemoryRuntimePorts({
    contentPresent: true,
    secrets: new MemorySecretPort({ API_TOKEN: "secret-value" }),
  });

  const firstPlan = await createApplyPlan(secretPorts, { spec });
  const firstResult = await commitApplyPlan(secretPorts, { plan_id: firstPlan.plan_id });
  assert.equal(firstResult.status, "committed");

  const current = await secretPorts.releases.getBase("prj_0000000000000001", "current");
  const jsonbLike = JSON.parse(JSON.stringify(current.state)) as typeof current.state;
  const admin = jsonbLike.functions.find((entry) => entry.name === "admin");
  if (admin?.require_role) {
    admin.require_role = {
      allowed: admin.require_role.allowed,
      cacheTtl: admin.require_role.cacheTtl,
      roleColumn: admin.require_role.roleColumn,
      idColumn: admin.require_role.idColumn,
      table: admin.require_role.table,
    };
  }
  secretPorts.seedRelease(firstResult.release_id, jsonbLike);

  const secondPlan = await createApplyPlan(secretPorts, {
    spec: {
      ...spec,
      base: { release: "current" },
    },
  });
  assert.equal(secondPlan.noop, true);
});

test("function commit rejects stale plans before staging content", async () => {
  const ports = new MemoryRuntimePorts({ contentPresent: true });
  const plan = await createApplyPlan(ports, {
    spec: prebundledFunctionSpec("e".repeat(64), 12),
  });
  ports.seedRelease("rel_concurrent", emptyCoreReleaseState());
  ports.setActiveReleaseId("rel_concurrent");

  await assert.rejects(
    commitApplyPlan(ports, { plan_id: plan.plan_id }),
    (error) => error instanceof ApplyInvariantError && error.code === "stale_plan",
  );
});

test("function activation failure leaves previous release active and plan planned", async () => {
  const ports = new MemoryRuntimePorts({
    activeReleaseId: "rel_previous",
    contentPresent: true,
    lifecycle: {
      async activate() {
        throw new FunctionBundleValidationError("invalid_function_bundle", "activation failed");
      },
    },
  });
  ports.seedRelease("rel_previous", emptyCoreReleaseState());
  const plan = await createApplyPlan(ports, {
    spec: prebundledCurrentFunctionSpec("f".repeat(64), 12),
  });

  await assert.rejects(
    commitApplyPlan(ports, { plan_id: plan.plan_id }),
    (error) => error instanceof FunctionBundleValidationError,
  );

  assert.equal(ports.activeReleaseId, "rel_previous");
  assert.equal((await ports.plans.get(plan.plan_id))?.status, "planned");
});

test("function apply rejects external deps and unsafe role gate config", async () => {
  await assert.rejects(
    createApplyPlan(new MemoryRuntimePorts(), {
      spec: {
        ...prebundledFunctionSpec("c".repeat(64), 12),
        functions: {
          replace: {
            api: {
              runtime: "node22",
              source: { sha256: "c".repeat(64), size: 12 },
              deps: ["lodash@^4.17.21"],
            },
          },
        },
      },
    }),
    DependencyInstallRejectedError,
  );

  await assert.rejects(
    createApplyPlan(new MemoryRuntimePorts(), {
      spec: {
        ...prebundledFunctionSpec("d".repeat(64), 12),
        functions: {
          replace: {
            api: {
              runtime: "node22",
              source: { sha256: "d".repeat(64), size: 12 },
              requireRole: {
                table: "members",
                idColumn: "user_id",
                roleColumn: "role",
                allowed: ["admin"],
                cacheTtl: 30,
              },
            },
          },
        },
      },
    }),
    (error) => error instanceof FunctionBundleValidationError && error.code === "role_cache_unsupported",
  );

  await assert.rejects(
    createApplyPlan(new MemoryRuntimePorts(), {
      spec: {
        ...prebundledFunctionSpec("e".repeat(64), 12),
        functions: {
          replace: {
            api: {
              runtime: "node22",
              source: { sha256: "e".repeat(64), size: 12 },
              requireRole: {
                table: "bad-name",
                idColumn: "user_id",
                roleColumn: "role",
                allowed: ["admin"],
                cacheTtl: 0,
              },
            },
          },
        },
      },
    }),
    (error) =>
      (error instanceof FunctionBundleValidationError && error.code === "role_gate_invalid_identifier") ||
      (error instanceof Error && error.name === "ReleaseSpecValidationError"),
  );
});

test("astro ssr apply accepts only the public output contract", async () => {
  const source = Buffer.from("export default async function handler(request) { return new Response('ssr'); }\n");
  const sourceSha = sha256Hex(source);
  const ports = new MemoryRuntimePorts({ contentPresent: true });

  const plan = await createApplyPlan(ports, {
    spec: astroSsrFunctionSpec(sourceSha, source.byteLength),
  });

  assert.equal(plan.noop, false);
  assert.equal(plan.function_effects?.bundles[0]?.name, "ssr");
  assert.equal(plan.function_effects?.bundles[0]?.class, "ssr");
  assert.deepEqual(plan.function_effects?.bundles[0]?.capabilities, [CORE_ASTRO_SSR_OUTPUT_CONTRACT_VERSION]);
  assert.deepEqual(plan.function_effects?.astro_ssr_fallback, {
    function_name: "ssr",
    output_contract_version: CORE_ASTRO_SSR_OUTPUT_CONTRACT_VERSION,
    pattern: CORE_ASTRO_SSR_FALLBACK_PATTERN,
  });

  const result = await commitApplyPlan(ports, { plan_id: plan.plan_id });
  assert.equal(result.status, "committed");
});

test("astro ssr apply rejects arbitrary adapter output and multiple fallbacks", async () => {
  await assert.rejects(
    createApplyPlan(new MemoryRuntimePorts(), {
      spec: {
        ...astroSsrFunctionSpec("a".repeat(64), 12),
        functions: {
          replace: {
            ssr: {
              runtime: "node22",
              source: { sha256: "a".repeat(64), size: 12 },
              class: "ssr",
            },
          },
        },
      },
    }),
    (error) => error instanceof AstroSsrUnsupportedFeatureError && error.code === "astro_ssr_unsupported_feature",
  );

  await assert.rejects(
    createApplyPlan(new MemoryRuntimePorts(), {
      spec: {
        ...astroSsrFunctionSpec("b".repeat(64), 12),
        functions: {
          replace: {
            ssr: {
              runtime: "node22",
              source: { sha256: "b".repeat(64), size: 12 },
              class: "ssr",
              capabilities: [CORE_ASTRO_SSR_OUTPUT_CONTRACT_VERSION],
            },
            alt: {
              runtime: "node22",
              source: { sha256: "b".repeat(64), size: 12 },
              class: "ssr",
              capabilities: [CORE_ASTRO_SSR_OUTPUT_CONTRACT_VERSION],
            },
          },
        },
      },
    }),
    (error) => error instanceof AstroSsrUnsupportedFeatureError && error.details.feature === "multiple_ssr_targets",
  );

  await assert.rejects(
    createApplyPlan(new MemoryRuntimePorts(), {
      spec: {
        ...astroSsrFunctionSpec("c".repeat(64), 12),
        functions: {
          replace: {
            ssr: {
              runtime: "node22",
              source: { sha256: "c".repeat(64), size: 12 },
              class: "ssr",
              capabilities: [CORE_ASTRO_SSR_OUTPUT_CONTRACT_VERSION, "astro.streaming"],
            },
          },
        },
      },
    }),
    (error) => error instanceof AstroSsrUnsupportedFeatureError && error.details.feature === "astro.streaming",
  );
});

test("function apply rejects unsupported runtimes and commit digest mismatches", async () => {
  await assert.rejects(
    createApplyPlan(new MemoryRuntimePorts(), {
      spec: {
        ...prebundledFunctionSpec("a".repeat(64), 12),
        functions: {
          replace: {
            api: {
              runtime: "node20",
              source: { sha256: "a".repeat(64), size: 12 },
            },
          },
        },
      },
    }),
    (error) => error instanceof Error && error.message === "function runtime must be node22",
  );

  const ports = new MemoryRuntimePorts({ contentPresent: true });
  const plan = await createApplyPlan(ports, {
    spec: prebundledFunctionSpec("a".repeat(64), 12),
  });

  await assert.rejects(
    commitApplyPlan(ports, { plan_id: plan.plan_id, release_spec_digest: "sha256:not-this-plan" }),
    (error) => error instanceof ApplyInvariantError && error.code === "release_spec_digest_mismatch",
  );
});

class MemoryProjectCatalog implements ProjectCatalogPort {
  readonly createdNames: string[] = [];
  readonly projects = new Map<string, CoreProject>();

  async create(input: { name: string }): Promise<CoreProject> {
    this.createdNames.push(input.name);
    const project: CoreProject = {
      project_id: "prj_0000000000000001",
      schema_slot: "project_0000000000000001",
      public_id: "local_0000000000000001",
      anon_key: "anon_test",
      service_key: "service_test",
      endpoints: {
        rest_url: "http://127.0.0.1:4300",
        static_base_url: "http://127.0.0.1:4020/projects/prj_0000000000000001/static",
        storage_base_url: "http://127.0.0.1:4020/projects/prj_0000000000000001/storage",
      },
      active_release_id: null,
      capabilities: runtimeCapabilities("test"),
    };
    this.projects.set(project.project_id, project);
    return project;
  }

  async inspect(projectId: string): Promise<CoreProject | null> {
    return this.projects.get(projectId) ?? null;
  }
}

class MemoryRuntimePorts implements RuntimeKernelPorts {
  readonly projects: RuntimeKernelPorts["projects"];
  readonly releases: RuntimeKernelPorts["releases"];
  readonly plans: RuntimeKernelPorts["plans"];
  readonly content: RuntimeKernelPorts["content"];
  readonly storage?: RuntimeKernelPorts["storage"];
  readonly secrets?: RuntimeKernelPorts["secrets"];
  readonly migrations: RuntimeKernelPorts["migrations"];
  readonly lifecycle?: RuntimeKernelPorts["lifecycle"];

  readonly #plans = new Map<string, StoredCoreApplyPlan>();
  readonly #releases = new Map<string, ReturnType<typeof emptyCoreReleaseState>>();
  #activeReleaseId: string | null;
  readonly #order: string[];

  constructor(options: {
    lifecycle?: RuntimeKernelPorts["lifecycle"];
    order?: string[];
    activeReleaseId?: string | null;
    contentPresent?: boolean;
    storage?: RuntimeKernelPorts["storage"];
    secrets?: RuntimeKernelPorts["secrets"];
  } = {}) {
    this.#order = options.order ?? [];
    this.#activeReleaseId = options.activeReleaseId ?? null;
    this.lifecycle = options.lifecycle;
    this.storage = options.storage;
    this.secrets = options.secrets;
    this.projects = {
      create: async () => {
        throw new Error("not used");
      },
      inspect: async (projectId) => ({
        project_id: projectId,
        schema_slot: "project_0000000000000001",
        public_id: "local_0000000000000001",
        anon_key: "anon_test",
        service_key: "service_test",
        endpoints: {
          rest_url: "http://127.0.0.1:4300",
          static_base_url: "http://127.0.0.1:4020/projects/v1/prj_0000000000000001/static",
          storage_base_url: "http://127.0.0.1:4020/projects/v1/prj_0000000000000001/storage",
        },
        active_release_id: this.#activeReleaseId,
        capabilities: runtimeCapabilities("test"),
      }),
    };
    this.releases = {
      getBase: async (_projectId, target) => {
        if (target === "empty") {
          return { release_id: null, state: emptyCoreReleaseState() };
        }
        const releaseId = typeof target === "string" ? this.#activeReleaseId : target.release_id;
        return {
          release_id: releaseId,
          state: releaseId ? this.#releases.get(releaseId) ?? emptyCoreReleaseState() : emptyCoreReleaseState(),
        };
      },
      setActiveRelease: async (input) => {
        if (this.#activeReleaseId !== input.expectedBaseReleaseId) {
          throw new ApplyInvariantError("stale_plan", "Apply plan base release no longer matches the active release.");
        }
        this.#releases.set(input.releaseId, input.release as ReturnType<typeof emptyCoreReleaseState>);
        this.#activeReleaseId = input.releaseId;
        this.#order.push("release.setActiveRelease");
      },
    };
    this.plans = {
      create: async (input) => {
        const plan: StoredCoreApplyPlan = {
          ...input,
          plan_id: `plan_${this.#plans.size + 1}`,
          status: "planned",
          created_at: new Date(0).toISOString(),
        };
        this.#plans.set(plan.plan_id, plan);
        return plan;
      },
      get: async (planId) => this.#plans.get(planId) ?? null,
      markCommitted: async (planId) => {
        const plan = this.#plans.get(planId);
        if (!plan) return;
        this.#plans.set(planId, { ...plan, status: "committed" });
        this.#order.push("plan.markCommitted");
      },
    };
    this.content = {
      putStatic: async () => undefined,
      hasContent: async () => {
        this.#order.push("content.hasContent");
        return options.contentPresent ?? true;
      },
      readStatic: async () => null,
    };
    this.migrations = {
      check: async () => {
        this.#order.push("migration.check");
        return { state: "absent" };
      },
      applyInline: async () => {
        this.#order.push("migration.apply");
      },
    };
  }

  seedRelease(releaseId: string, state: ReturnType<typeof emptyCoreReleaseState>): void {
    this.#releases.set(releaseId, state);
  }

  setActiveReleaseId(releaseId: string | null): void {
    this.#activeReleaseId = releaseId;
  }

  get activeReleaseId(): string | null {
    return this.#activeReleaseId;
  }
}

class MemoryStoragePort implements NonNullable<RuntimeKernelPorts["storage"]> {
  readonly keys: string[];
  readonly objects: Map<string, CoreStorageObject>;
  committed: CoreStorageApplyEffects | null = null;

  constructor(keys: string[], objects: CoreStorageObject[] = []) {
    this.keys = keys;
    this.objects = new Map(objects.map((object) => [object.key, object]));
  }

  async createUploadSession(): Promise<never> {
    throw new Error("not used");
  }

  async getUploadSession(): Promise<null> {
    return null;
  }

  async markUploadBytesStored(): Promise<never> {
    throw new Error("not used");
  }

  async completeUploadSession(): Promise<never> {
    throw new Error("not used");
  }

  async abortUploadSession(): Promise<never> {
    throw new Error("not used");
  }

  async getObject(input: { key: string }): Promise<CoreStorageObject | null> {
    return this.objects.get(input.key) ??
      (this.keys.includes(input.key)
        ? {
            project_id: "prj_0000000000000001",
            key: input.key,
            sha256: "a".repeat(64),
            size_bytes: 1,
            content_type: "text/plain",
            visibility: "public",
            immutable: false,
            created_at: new Date(0).toISOString(),
            updated_at: new Date(0).toISOString(),
          }
        : null);
  }

  async listObjects(input: { prefix?: string }) {
    return {
      objects: this.keys
        .filter((key) => !input.prefix || key.startsWith(input.prefix))
        .map((key) => ({
          project_id: "prj_0000000000000001",
          key,
          sha256: "a".repeat(64),
          size_bytes: 1,
          content_type: "text/plain",
          visibility: "public" as const,
          immutable: false,
          created_at: new Date(0).toISOString(),
          updated_at: new Date(0).toISOString(),
        })),
      next_cursor: null,
    };
  }

  async inventoryRevision(input: { prefix: string }) {
    const keys = this.keys.filter((key) => !input.prefix || key.startsWith(input.prefix)).sort();
    return {
      keys,
      revision: computeStorageInventoryRevision(keys),
    };
  }

  async commitAssetPlan(input: { effects: CoreStorageApplyEffects }): Promise<void> {
    if (input.effects.sync_prune) {
      const current = await this.inventoryRevision({ prefix: input.effects.sync_prune.prefix });
      if (current.revision !== input.effects.sync_prune.base_revision) {
        throw new ApplyInvariantError("asset_sync_drift", "Storage inventory changed after the apply plan was created.");
      }
    }
    this.committed = input.effects;
  }

  async deleteObject(): Promise<boolean> {
    return false;
  }

  async getImmutableVersion(): Promise<null> {
    return null;
  }
}

class MemorySecretPort implements NonNullable<RuntimeKernelPorts["secrets"]> {
  readonly #values: Map<string, string>;

  constructor(values: Record<string, string> = {}) {
    this.#values = new Map(Object.entries(values));
  }

  async setSecret(input: {
    projectId: string;
    name: string;
    value: string;
    scope?: "project" | "release" | "function";
    functionName?: string | null;
  }) {
    this.#values.set(input.name, input.value);
    return {
      project_id: input.projectId,
      name: input.name,
      scope: input.scope ?? "project",
      function_name: input.functionName ?? null,
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
    };
  }

  async listSecrets(input: { projectId: string }) {
    return [...this.#values.keys()].sort().map((name) => ({
      project_id: input.projectId,
      name,
      scope: "project" as const,
      function_name: null,
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
    }));
  }

  async getSecretValues(input: { names: string[] }) {
    const out: Record<string, string> = {};
    for (const name of input.names) {
      const value = this.#values.get(name);
      if (value !== undefined) out[name] = value;
    }
    return out;
  }
}

function supportedMigrationSpec() {
  return {
    project: "prj_0000000000000001",
    base: { release: "empty" },
    database: {
      migrations: [{
        id: "001_init",
        checksum: "354b7196c9ba5fb4b21cf615bb6ec4cd5c07503c34229feef033fc081a8c03f4",
        sql: "select 1;",
      }],
    },
  };
}

function prebundledFunctionSpec(sha256: string, size: number) {
  return {
    project: "prj_0000000000000001",
    base: { release: "empty" },
    functions: {
      replace: {
        api: {
          runtime: "node22",
          source: {
            sha256,
            size,
            contentType: "application/javascript",
          },
        },
      },
    },
    routes: {
      replace: [{
        pattern: "/api/*",
        target: { type: "function", name: "api" },
      }],
    },
  };
}

function prebundledCurrentFunctionSpec(sha256: string, size: number) {
  return {
    project: "prj_0000000000000001",
    functions: {
      replace: {
        api: {
          runtime: "node22",
          source: {
            sha256,
            size,
            contentType: "application/javascript",
          },
        },
      },
    },
    routes: {
      replace: [{
        pattern: "/api/*",
        target: { type: "function", name: "api" },
      }],
    },
  };
}

function astroSsrFunctionSpec(sha256: string, size: number) {
  return {
    project: "prj_0000000000000001",
    base: { release: "empty" },
    functions: {
      replace: {
        ssr: {
          runtime: "node22",
          source: {
            sha256,
            size,
            contentType: "application/javascript",
          },
          class: "ssr",
          capabilities: [CORE_ASTRO_SSR_OUTPUT_CONTRACT_VERSION],
        },
      },
    },
    routes: {
      replace: [],
    },
  };
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
