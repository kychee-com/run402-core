import { createHash } from "node:crypto";

import { canonicalizeJson } from "./canonical-json.js";
import {
  normalizePortableManifest,
  normalizePortableReleaseState,
  normalizeReleaseSpec,
} from "./normalize.js";
import type { PortableReleaseState, ReleaseSpec } from "./types.js";

export const APPLY_REQUEST_DIGEST_IDENTITY = "run402-apply-request-v1" as const;
export const PORTABLE_MANIFEST_DIGEST_IDENTITY = "run402-portable-manifest-v1" as const;
export const MATERIALIZED_RELEASE_DIGEST_IDENTITY = "run402-materialized-release-v1" as const;
export const EVALUATED_PLAN_DIGEST_IDENTITY = "run402-evaluated-plan-v1" as const;

export function computeApplyRequestDigestHex(spec: ReleaseSpec): string {
  return sha256Hex(canonicalizeJson(normalizeReleaseSpec(spec)));
}

export function digestApplyRequest(spec: ReleaseSpec): string {
  return `${APPLY_REQUEST_DIGEST_IDENTITY}:${computeApplyRequestDigestHex(spec)}`;
}

export function computePortableManifestDigestHex(spec: ReleaseSpec): string {
  return sha256Hex(canonicalizeJson(normalizePortableManifest(spec)));
}

export function digestPortableManifest(spec: ReleaseSpec): string {
  return `${PORTABLE_MANIFEST_DIGEST_IDENTITY}:${computePortableManifestDigestHex(spec)}`;
}

export function computeMaterializedReleaseDigestHex(state: PortableReleaseState): string {
  return sha256Hex(canonicalizeJson(normalizePortableReleaseState(state)));
}

export function digestMaterializedRelease(state: PortableReleaseState): string {
  return `${MATERIALIZED_RELEASE_DIGEST_IDENTITY}:${computeMaterializedReleaseDigestHex(state)}`;
}

export function computeEvaluatedPlanDigestHex(plan: unknown): string {
  return sha256Hex(canonicalizeJson(plan));
}

export function digestEvaluatedPlan(plan: unknown): string {
  return `${EVALUATED_PLAN_DIGEST_IDENTITY}:${computeEvaluatedPlanDigestHex(plan)}`;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
