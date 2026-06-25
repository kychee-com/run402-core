import assert from "node:assert/strict";
import test from "node:test";

import {
  createCoreProject,
  commitApplyPlan,
  createApplyPlan,
  emptyCoreReleaseState,
  ApplyInvariantError,
  inspectCoreProject,
  ProjectNotFoundError,
  projectNotFoundEnvelope,
  RUNTIME_KERNEL_CONTRACT_VERSION,
  UnsupportedCapabilityError,
  validateProjectId,
  runtimeCapabilities,
  runtimeHealth,
  unsupportedCapabilityEnvelope,
  type CoreProject,
  type ProjectCatalogPort,
  type RuntimeKernelPorts,
  type StoredCoreApplyPlan,
} from "./index.js";

test("runtime capability document advertises first-slice boundaries", () => {
  const capabilities = runtimeCapabilities("test");

  assert.equal(capabilities.runtime_contract_version, RUNTIME_KERNEL_CONTRACT_VERSION);
  assert.ok(capabilities.supported_features.includes("projects.create.local"));
  assert.ok(capabilities.supported_features.includes("database.rest.postgrest"));
  assert.ok(capabilities.unsupported_features.some((entry) => entry.feature === "functions.node"));
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
  readonly migrations: RuntimeKernelPorts["migrations"];
  readonly lifecycle?: RuntimeKernelPorts["lifecycle"];

  readonly #plans = new Map<string, StoredCoreApplyPlan>();
  readonly #releases = new Map<string, ReturnType<typeof emptyCoreReleaseState>>();
  readonly #activeReleaseId: string | null;
  readonly #order: string[];

  constructor(options: {
    lifecycle?: RuntimeKernelPorts["lifecycle"];
    order?: string[];
    activeReleaseId?: string | null;
    contentPresent?: boolean;
  } = {}) {
    this.#order = options.order ?? [];
    this.#activeReleaseId = options.activeReleaseId ?? null;
    this.lifecycle = options.lifecycle;
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
        },
        active_release_id: null,
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
      setActiveRelease: async () => {
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
