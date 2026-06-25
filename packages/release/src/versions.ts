export const RELEASE_PACKAGE_NAME = "@run402/release" as const;

export const RELEASE_SPEC_VERSION = "run402.release_spec.v1" as const;
export const PORTABLE_RELEASE_STATE_VERSION = "run402.portable_release_state.v1" as const;
export const STATIC_MANIFEST_VERSION = "run402.static_manifest.v1" as const;
export const FACT_PROTOCOL_VERSION = "run402.release_facts.v1" as const;
export const CANONICALIZATION_VERSION = "run402.canonical_json.v1" as const;
export const PLANNER_SEMANTICS_VERSION = "run402.release_planner.v1" as const;

export interface ReleasePackageInfo {
  packageName: typeof RELEASE_PACKAGE_NAME;
  releaseSpecVersion: typeof RELEASE_SPEC_VERSION;
  portableReleaseStateVersion: typeof PORTABLE_RELEASE_STATE_VERSION;
  staticManifestVersion: typeof STATIC_MANIFEST_VERSION;
  factProtocolVersion: typeof FACT_PROTOCOL_VERSION;
  canonicalizationVersion: typeof CANONICALIZATION_VERSION;
  plannerSemanticsVersion: typeof PLANNER_SEMANTICS_VERSION;
}

export function releasePackageInfo(): ReleasePackageInfo {
  return {
    packageName: RELEASE_PACKAGE_NAME,
    releaseSpecVersion: RELEASE_SPEC_VERSION,
    portableReleaseStateVersion: PORTABLE_RELEASE_STATE_VERSION,
    staticManifestVersion: STATIC_MANIFEST_VERSION,
    factProtocolVersion: FACT_PROTOCOL_VERSION,
    canonicalizationVersion: CANONICALIZATION_VERSION,
    plannerSemanticsVersion: PLANNER_SEMANTICS_VERSION,
  };
}
