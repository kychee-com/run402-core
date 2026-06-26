import type {
  RoutedHttpRequestV1,
  RoutedHttpResponseV1,
} from "@run402/functions";
import type {
  ContentRefHex,
  FunctionSpec,
  HttpMethod,
  PortableFunctionEntry,
  RoleGateSpec,
  RouteEntry,
} from "@run402/release";

export const CORE_FUNCTION_RUNTIME_MATURITY = "developer_preview" as const;
export const CORE_FUNCTION_SECURITY_PROFILE = "trusted_local_code" as const;
export const CORE_FUNCTION_DEFAULT_EXECUTOR = "docker_compose_worker" as const;
export const CORE_FUNCTION_DEPENDENCY_MODE = "prebundled_no_external_deps" as const;
export const CORE_ASTRO_SSR_OUTPUT_CONTRACT_VERSION = "astro.ssr.v1" as const;
export const CORE_ASTRO_SSR_FALLBACK_PATTERN = "/*" as const;

export const CORE_FUNCTION_RESOURCE_DEFAULTS = {
  requestBodyLimitBytes: 6 * 1024 * 1024,
  responseBodyLimitBytes: 6 * 1024 * 1024,
  invocationTimeoutMs: 10_000,
  startupTimeoutMs: 5_000,
  dependencyInstallTimeoutMs: 120_000,
  maxConcurrentInvocationsPerProject: 4,
  maxPendingInvocationQueue: 16,
  stdoutStderrLimitBytes: 64 * 1024,
  maxLogLineBytes: 16 * 1024,
  localLogRetentionBytes: 10 * 1024 * 1024,
  localLogRetentionMs: 24 * 60 * 60 * 1000,
  workerMemoryLimitBytes: 512 * 1024 * 1024,
  tempDirLimitBytes: 512 * 1024 * 1024,
  nodeModulesLimitBytes: 256 * 1024 * 1024,
} as const;

export const CORE_FUNCTION_FILESYSTEM_LAYOUT = {
  bundleStagingDir: "functions/staging",
  activeBundleDir: "functions/active",
  dependencyCacheDir: "functions/deps",
  tempDir: "functions/tmp",
  logDir: "functions/logs",
} as const;

export const CORE_FUNCTION_KNOWN_EXCLUSIONS = [
  "hostile_code_isolation",
  "public_multi_tenant_hosting",
  "cloud_grade_sandbox",
  "external_npm_dependencies",
  "lockfile_npm_install",
  "lifecycle_scripts",
  "native_postinstall_builds",
  "file_link_workspace_dependencies",
  "git_or_tarball_dependencies",
  "private_registries",
  "websockets",
  "streaming_to_client",
  "scheduled_functions",
  "background_jobs",
  "managed_jobs",
  "managed_kms",
  "cloudwatch_logs",
  "cloud_quota_enforcement",
  "cloud_billing",
  "cloud_abuse_controls",
] as const;

export const CORE_ASTRO_SSR_KNOWN_EXCLUSIONS = [
  "full_astro_support",
  "arbitrary_astro_adapters",
  "streaming_to_client",
  "websockets",
  "http_upgrade",
  "isr_cache",
  "edge_runtime",
  "cloud_globals",
  "cloud_routing_hooks",
  "cloudwatch_logs",
  "cloud_quota_enforcement",
  "cloud_billing",
  "cloud_abuse_controls",
] as const;

export interface CoreFunctionIsolationProfile {
  maturity: typeof CORE_FUNCTION_RUNTIME_MATURITY;
  security_profile: typeof CORE_FUNCTION_SECURITY_PROFILE;
  hostile_code_isolation: false;
  default_executor: typeof CORE_FUNCTION_DEFAULT_EXECUTOR;
  app_code_runs_in_gateway_process: false;
  environment_policy: "explicit_allowlist";
  host_environment_inherited: false;
  gateway_secrets_visible_by_default: false;
  filesystem_policy: "project_worker_scoped";
  network_policy: "developer_preview_not_hardened";
}

export const CORE_FUNCTION_ISOLATION_PROFILE: CoreFunctionIsolationProfile = {
  maturity: CORE_FUNCTION_RUNTIME_MATURITY,
  security_profile: CORE_FUNCTION_SECURITY_PROFILE,
  hostile_code_isolation: false,
  default_executor: CORE_FUNCTION_DEFAULT_EXECUTOR,
  app_code_runs_in_gateway_process: false,
  environment_policy: "explicit_allowlist",
  host_environment_inherited: false,
  gateway_secrets_visible_by_default: false,
  filesystem_policy: "project_worker_scoped",
  network_policy: "developer_preview_not_hardened",
};

export interface CoreFunctionDependencyPolicy {
  mode: typeof CORE_FUNCTION_DEPENDENCY_MODE;
  npm_install_supported: false;
  platform_packages: ["@run402/functions"];
  rejected_dependency_spec_kinds: readonly string[];
  future_lockfile_install_command: readonly string[];
}

export const CORE_FUNCTION_DEPENDENCY_POLICY: CoreFunctionDependencyPolicy = {
  mode: CORE_FUNCTION_DEPENDENCY_MODE,
  npm_install_supported: false,
  platform_packages: ["@run402/functions"],
  rejected_dependency_spec_kinds: [
    "semver_without_lockfile",
    "file",
    "link",
    "workspace",
    "git",
    "http_tarball",
    "https_tarball",
    "local_path",
    "private_registry",
    "npm_alias",
    "lifecycle_script_required",
    "native_postinstall_required",
  ],
  future_lockfile_install_command: [
    "npm",
    "ci",
    "--ignore-scripts",
    "--omit=dev",
    "--no-audit",
    "--no-fund",
  ],
};

export interface CoreFunctionRuntimeCapability {
  capability: "core-functions";
  status: "supported";
  maturity: typeof CORE_FUNCTION_RUNTIME_MATURITY;
  security_profile: typeof CORE_FUNCTION_SECURITY_PROFILE;
  hostile_code_isolation: false;
  default_executor: typeof CORE_FUNCTION_DEFAULT_EXECUTOR;
  dependency_policy: CoreFunctionDependencyPolicy;
  resource_defaults: typeof CORE_FUNCTION_RESOURCE_DEFAULTS;
  filesystem_layout: typeof CORE_FUNCTION_FILESYSTEM_LAYOUT;
  supported_output: {
    runtime: "node22";
    artifact: "prebundled_source_ref";
    envelope: "run402.routed_http.v1";
  };
  known_exclusions: Array<(typeof CORE_FUNCTION_KNOWN_EXCLUSIONS)[number]>;
}

export interface CoreAstroSsrRuntimeCapability {
  capability: "core-astro-ssr";
  status: "supported";
  maturity: typeof CORE_FUNCTION_RUNTIME_MATURITY;
  output_contract_version: typeof CORE_ASTRO_SSR_OUTPUT_CONTRACT_VERSION;
  supported_output: {
    runtime: "node22";
    module_format: "esm";
    request: "web_request";
    response: "web_response_buffered";
    route: "fallback";
  };
  fallback: {
    pattern: typeof CORE_ASTRO_SSR_FALLBACK_PATTERN;
    precedence: readonly [
      "explicit_static_alias",
      "public_static_asset_path",
      "prerendered_static_html",
      "dynamic_function_route",
      "astro_ssr_fallback",
      "not_found",
    ];
  };
  inherits_from_functions_runtime: true;
  resource_defaults: typeof CORE_FUNCTION_RESOURCE_DEFAULTS;
  isolation_profile: CoreFunctionIsolationProfile;
  known_exclusions: Array<(typeof CORE_ASTRO_SSR_KNOWN_EXCLUSIONS)[number]>;
}

export interface CoreFunctionBundleMetadata {
  name: string;
  runtime: "node22";
  entrypoint: string;
  source: ContentRefHex;
  bundle_sha256: string;
  bundle_size_bytes: number;
  dependency_mode: typeof CORE_FUNCTION_DEPENDENCY_MODE;
  dependency_lock_digest: null;
  deps: [];
  required_secrets: string[];
  timeout_ms: number;
  memory_bytes: number;
  require_auth: boolean;
  require_role: RoleGateSpec | null;
  class: "standard" | "ssr";
  capabilities: string[];
}

export interface CoreDynamicFunctionRoute {
  pattern: string;
  kind: RouteEntry["kind"];
  prefix: string | null;
  methods: HttpMethod[] | null;
  function_name: string;
}

export interface CoreFunctionApplyEffects {
  bundles: CoreFunctionBundleMetadata[];
  dynamic_routes: CoreDynamicFunctionRoute[];
  astro_ssr_fallback: {
    function_name: string;
    output_contract_version: typeof CORE_ASTRO_SSR_OUTPUT_CONTRACT_VERSION;
    pattern: typeof CORE_ASTRO_SSR_FALLBACK_PATTERN;
  } | null;
  required_secrets: string[];
  dependency_mode: typeof CORE_FUNCTION_DEPENDENCY_MODE;
  noop: boolean;
}

export interface CoreFunctionInvocationInput {
  projectId: string;
  releaseId: string | null;
  functionName: string;
  invocationKind: "routed_http" | "direct";
  requestId: string;
  actor?: CoreFunctionActorContext | null;
  request?: RoutedHttpRequestV1;
}

export interface CoreFunctionActorContext {
  id: string;
  role: string | null;
}

export interface CoreFunctionInvocationResult {
  requestId: string;
  response: RoutedHttpResponseV1;
}

export type CoreFunctionInvocationStatus = "succeeded" | "failed";

export interface CoreFunctionInvocationRecord {
  request_id: string;
  project_id: string;
  release_id: string | null;
  function_name: string;
  invocation_kind: CoreFunctionInvocationInput["invocationKind"];
  status: CoreFunctionInvocationStatus;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  error_code: string | null;
}

export interface CoreFunctionLogEntry {
  timestamp: string;
  request_id: string;
  project_id: string;
  release_id: string | null;
  function_name: string;
  stream: "platform" | "stdout" | "stderr";
  level: "debug" | "info" | "warn" | "error";
  message: string;
  redacted: boolean;
}

export interface CoreFunctionSecretMetadata {
  project_id: string;
  name: string;
  scope: "project" | "release" | "function";
  function_name: string | null;
  created_at: string;
  updated_at: string;
}

export function coreFunctionRuntimeCapability(): CoreFunctionRuntimeCapability {
  return {
    capability: "core-functions",
    status: "supported",
    maturity: CORE_FUNCTION_RUNTIME_MATURITY,
    security_profile: CORE_FUNCTION_SECURITY_PROFILE,
    hostile_code_isolation: false,
    default_executor: CORE_FUNCTION_DEFAULT_EXECUTOR,
    dependency_policy: CORE_FUNCTION_DEPENDENCY_POLICY,
    resource_defaults: CORE_FUNCTION_RESOURCE_DEFAULTS,
    filesystem_layout: CORE_FUNCTION_FILESYSTEM_LAYOUT,
    supported_output: {
      runtime: "node22",
      artifact: "prebundled_source_ref",
      envelope: "run402.routed_http.v1",
    },
    known_exclusions: [...CORE_FUNCTION_KNOWN_EXCLUSIONS],
  };
}

export function coreAstroSsrRuntimeCapability(): CoreAstroSsrRuntimeCapability {
  return {
    capability: "core-astro-ssr",
    status: "supported",
    maturity: CORE_FUNCTION_RUNTIME_MATURITY,
    output_contract_version: CORE_ASTRO_SSR_OUTPUT_CONTRACT_VERSION,
    supported_output: {
      runtime: "node22",
      module_format: "esm",
      request: "web_request",
      response: "web_response_buffered",
      route: "fallback",
    },
    fallback: {
      pattern: CORE_ASTRO_SSR_FALLBACK_PATTERN,
      precedence: [
        "explicit_static_alias",
        "public_static_asset_path",
        "prerendered_static_html",
        "dynamic_function_route",
        "astro_ssr_fallback",
        "not_found",
      ],
    },
    inherits_from_functions_runtime: true,
    resource_defaults: CORE_FUNCTION_RESOURCE_DEFAULTS,
    isolation_profile: CORE_FUNCTION_ISOLATION_PROFILE,
    known_exclusions: [...CORE_ASTRO_SSR_KNOWN_EXCLUSIONS],
  };
}

export function emptyFunctionApplyEffects(): CoreFunctionApplyEffects {
  return {
    bundles: [],
    dynamic_routes: [],
    astro_ssr_fallback: null,
    required_secrets: [],
    dependency_mode: CORE_FUNCTION_DEPENDENCY_MODE,
    noop: true,
  };
}

export function isAstroSsrFunction(entry: Pick<PortableFunctionEntry, "class" | "capabilities">): boolean {
  return entry.class === "ssr" &&
    Array.isArray(entry.capabilities) &&
    entry.capabilities.includes(CORE_ASTRO_SSR_OUTPUT_CONTRACT_VERSION);
}

export function normalizeFunctionEntrypoint(spec: FunctionSpec): string {
  return spec.entrypoint ?? "default";
}

export function functionMemoryBytes(entry: Pick<PortableFunctionEntry, "memory_mb">): number {
  return entry.memory_mb * 1024 * 1024;
}
