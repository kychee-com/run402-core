import { createHash } from "node:crypto";

import { canonicalizeJson, type JsonCompatible } from "./canonical-json.js";
import { ReleaseSpecValidationError } from "./errors.js";
import { PLANNER_SEMANTICS_VERSION } from "./versions.js";

export const REVIEWED_PLAN_FINGERPRINT_IDENTITY = "run402-reviewed-plan-v1" as const;

export interface ReviewedPlanWarningFingerprint {
  code: string;
  severity?: "warning" | "error";
  resource?: string;
  details?: JsonCompatible;
}

export interface ReviewedPlanDestructiveActionFingerprint {
  kind: string;
  resource: string;
  count?: number;
  digest?: string;
  details?: JsonCompatible;
}

export interface ReviewedPlanFingerprintInput {
  release_spec_digest: string;
  concrete_base_identity: string;
  planner_semantics_version?: string;
  materialized_release_digest?: string | null;
  materialized_diff_digest?: string | null;
  content_binding_digest?: string | null;
  warnings?: readonly ReviewedPlanWarningFingerprint[];
  destructive_actions?: readonly ReviewedPlanDestructiveActionFingerprint[];
  cost_facts?: JsonCompatible;
  quota_facts?: JsonCompatible;
  policy_facts?: JsonCompatible;
  auth_binding?: JsonCompatible;
}

export interface NormalizedReviewedPlanFingerprint {
  release_spec_digest: string;
  concrete_base_identity: string;
  planner_semantics_version: string;
  materialized_release_digest?: string | null;
  materialized_diff_digest?: string | null;
  content_binding_digest?: string | null;
  warnings: ReviewedPlanWarningFingerprint[];
  destructive_actions: ReviewedPlanDestructiveActionFingerprint[];
  cost_facts?: JsonCompatible;
  quota_facts?: JsonCompatible;
  policy_facts?: JsonCompatible;
  auth_binding?: JsonCompatible;
}

export function normalizeReviewedPlanFingerprint(
  input: ReviewedPlanFingerprintInput,
): NormalizedReviewedPlanFingerprint {
  requireNonEmpty(input.release_spec_digest, "release_spec_digest");
  requireNonEmpty(input.concrete_base_identity, "concrete_base_identity");
  const normalized: NormalizedReviewedPlanFingerprint = {
    release_spec_digest: input.release_spec_digest,
    concrete_base_identity: input.concrete_base_identity,
    planner_semantics_version: input.planner_semantics_version ?? PLANNER_SEMANTICS_VERSION,
    warnings: normalizeWarnings(input.warnings ?? []),
    destructive_actions: normalizeDestructiveActions(input.destructive_actions ?? []),
  };
  if (input.materialized_release_digest !== undefined) {
    normalized.materialized_release_digest = input.materialized_release_digest;
  }
  if (input.materialized_diff_digest !== undefined) {
    normalized.materialized_diff_digest = input.materialized_diff_digest;
  }
  if (input.content_binding_digest !== undefined) {
    normalized.content_binding_digest = input.content_binding_digest;
  }
  if (input.cost_facts !== undefined) normalized.cost_facts = input.cost_facts;
  if (input.quota_facts !== undefined) normalized.quota_facts = input.quota_facts;
  if (input.policy_facts !== undefined) normalized.policy_facts = input.policy_facts;
  if (input.auth_binding !== undefined) normalized.auth_binding = input.auth_binding;
  return normalized;
}

export function computeReviewedPlanFingerprintHex(input: ReviewedPlanFingerprintInput): string {
  return sha256Hex(canonicalizeJson(normalizeReviewedPlanFingerprint(input)));
}

export function digestReviewedPlanFingerprint(input: ReviewedPlanFingerprintInput): string {
  return `${REVIEWED_PLAN_FINGERPRINT_IDENTITY}:${computeReviewedPlanFingerprintHex(input)}`;
}

function normalizeWarnings(input: readonly ReviewedPlanWarningFingerprint[]): ReviewedPlanWarningFingerprint[] {
  return input.map((warning) => {
    requireNonEmpty(warning.code, "warnings.code");
    return {
      code: warning.code,
      ...(warning.severity !== undefined ? { severity: warning.severity } : {}),
      ...(warning.resource !== undefined ? { resource: warning.resource } : {}),
      ...(warning.details !== undefined ? { details: warning.details } : {}),
    };
  }).sort(compareCanonical);
}

function normalizeDestructiveActions(
  input: readonly ReviewedPlanDestructiveActionFingerprint[],
): ReviewedPlanDestructiveActionFingerprint[] {
  return input.map((action) => {
    requireNonEmpty(action.kind, "destructive_actions.kind");
    requireNonEmpty(action.resource, "destructive_actions.resource");
    return {
      kind: action.kind,
      resource: action.resource,
      ...(action.count !== undefined ? { count: action.count } : {}),
      ...(action.digest !== undefined ? { digest: action.digest } : {}),
      ...(action.details !== undefined ? { details: action.details } : {}),
    };
  }).sort(compareCanonical);
}

function compareCanonical(a: unknown, b: unknown): number {
  const left = canonicalizeJson(a);
  const right = canonicalizeJson(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

function requireNonEmpty(value: unknown, resource: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ReleaseSpecValidationError(resource, `${resource} must be a non-empty string`);
  }
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
