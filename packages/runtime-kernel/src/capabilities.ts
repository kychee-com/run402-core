import {
  PLANNER_SEMANTICS_VERSION,
  RELEASE_SPEC_VERSION,
  releasePackageInfo,
} from "@run402/release";

export const RUNTIME_KERNEL_CONTRACT_VERSION = "run402-runtime-kernel-v1" as const;
export const RUNTIME_KERNEL_PACKAGE_NAME = "@run402/runtime-kernel" as const;

export const SUPPORTED_RUNTIME_FEATURES = [
  "projects.create.local",
  "projects.inspect.local",
  "apply.plan.supported-static-rest-slice",
  "apply.commit.supported-static-rest-slice",
  "database.migrations.inline-sql",
  "database.rest.postgrest",
  "auth.jwt.local-test-tokens",
  "rls.claim-mapping",
  "site.static.explicit-public-paths",
] as const;

export const UNSUPPORTED_RUNTIME_FEATURES = [
  "database.migrations.sql_ref",
  "site.patch",
  "functions.node",
  "astro.ssr",
  "storage.user-api",
  "storage.s3-compatible",
  "assets.images",
  "subdomains.managed",
  "domains.custom",
  "export.project-archive",
  "import.project-archive",
  "cloud-import.project-archive",
  "auth.hosted-oauth",
  "cloud.billing",
  "cloud.fleet-scheduling",
  "cloud.managed-backups",
  "cloud.monitoring",
  "cloud.abuse-controls",
] as const;

export interface UnsupportedRuntimeFeature {
  feature: (typeof UNSUPPORTED_RUNTIME_FEATURES)[number];
  error: "unsupported_capability";
}

export interface RuntimeCapabilityDocument {
  runtime_contract_version: typeof RUNTIME_KERNEL_CONTRACT_VERSION;
  release_spec_version: typeof RELEASE_SPEC_VERSION;
  planner_semantics_version: typeof PLANNER_SEMANTICS_VERSION;
  supported_features: Array<(typeof SUPPORTED_RUNTIME_FEATURES)[number]>;
  unsupported_features: UnsupportedRuntimeFeature[];
  components: {
    runtime_kernel: {
      name: typeof RUNTIME_KERNEL_PACKAGE_NAME;
      version: string;
    };
    release: {
      name: "@run402/release";
      release_spec_version: typeof RELEASE_SPEC_VERSION;
      planner_semantics_version: typeof PLANNER_SEMANTICS_VERSION;
    };
  };
}

export function runtimeCapabilities(version = "0.1.1"): RuntimeCapabilityDocument {
  const release = releasePackageInfo();
  return {
    runtime_contract_version: RUNTIME_KERNEL_CONTRACT_VERSION,
    release_spec_version: RELEASE_SPEC_VERSION,
    planner_semantics_version: PLANNER_SEMANTICS_VERSION,
    supported_features: [...SUPPORTED_RUNTIME_FEATURES],
    unsupported_features: UNSUPPORTED_RUNTIME_FEATURES.map((feature) => ({
      feature,
      error: "unsupported_capability",
    })),
    components: {
      runtime_kernel: {
        name: RUNTIME_KERNEL_PACKAGE_NAME,
        version,
      },
      release: {
        name: release.packageName,
        release_spec_version: release.releaseSpecVersion,
        planner_semantics_version: release.plannerSemanticsVersion,
      },
    },
  };
}
