import {
  PLANNER_SEMANTICS_VERSION,
  RELEASE_SPEC_VERSION,
  releasePackageInfo,
} from "@run402/release";
import {
  coreAstroSsrRuntimeCapability,
  type CoreAstroSsrRuntimeCapability,
  coreFunctionRuntimeCapability,
  type CoreFunctionRuntimeCapability,
} from "./functions-runtime.js";

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
  "site.static.implicit-public-paths",
  "site.static.exact-alias-routes",
  "site.static.route-manifest",
  "storage.objects.local",
  "storage.upload-sessions.local",
  "storage.visibility.public-private",
  "storage.immutable-local-urls",
  "storage.signed-read.local",
  "functions.node",
  "functions.routed-http.local",
  "functions.direct-invoke.local",
  "functions.auth-gates.local",
  "functions.role-gates.local",
  "functions.secrets.local",
  "functions.logs.local",
  "functions.trusted-local-code",
  "astro.ssr",
  "astro.ssr.run402-output-v1",
  "astro.ssr.fallback.local",
  "astro.ssr.static-precedence",
  "astro.ssr.trusted-local-code",
] as const;

export const UNSUPPORTED_RUNTIME_FEATURES = [
  "database.migrations.sql_ref",
  "site.patch",
  "astro.arbitrary-adapters",
  "astro.streaming",
  "astro.websockets",
  "astro.isr-cache",
  "astro.edge-runtime",
  "astro.cloud-globals",
  "functions.hostile-code-isolation",
  "functions.external-npm-dependencies",
  "functions.scheduled",
  "functions.background-jobs",
  "functions.streaming",
  "functions.websockets",
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
    functions: {
      name: "@run402/functions";
      version: string;
    };
  };
  functions_runtime: CoreFunctionRuntimeCapability;
  astro_ssr_runtime: CoreAstroSsrRuntimeCapability;
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
      functions: {
        name: "@run402/functions",
        version: "3.5.1",
      },
    },
    functions_runtime: coreFunctionRuntimeCapability(),
    astro_ssr_runtime: coreAstroSsrRuntimeCapability(),
  };
}
