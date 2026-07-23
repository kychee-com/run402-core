export const X402_COMMERCE_RESULT_SCHEMA_VERSION =
  "x402-commerce-result.v1" as const;

export const X402_EVIDENCE_STATUSES = [
  "verified",
  "absent",
  "invalid",
  "untrusted",
  "unavailable",
] as const;

export const X402_MUTATION_STATES = [
  "not_started",
  "committed",
  "unknown",
] as const;

export const X402_RECOVERY_ACTIONS = [
  "retry",
  "reconcile_payment",
] as const;

export const X402_PAYMENT_POLICY_ERROR_CODES = [
  "MERCHANT_RECEIPT_REQUIRED",
  "MERCHANT_RECEIPT_UNAVAILABLE",
] as const;

export const X402_GATEWAY_AVAILABILITY_ERROR_CODE =
  "MERCHANT_EVIDENCE_UNAVAILABLE" as const;

export type X402EvidenceStatus = (typeof X402_EVIDENCE_STATUSES)[number];
export type X402MutationState = (typeof X402_MUTATION_STATES)[number];
export type X402RecoveryActionType = (typeof X402_RECOVERY_ACTIONS)[number];

export interface X402CommerceNextAction {
  type: X402RecoveryActionType;
  request?: "repeat_identical";
  reuse_payer?: true;
  reuse_idempotency_key?: true;
  why: string;
}

export interface X402CommerceResult {
  schema_version: typeof X402_COMMERCE_RESULT_SCHEMA_VERSION;
  http_status: number;
  body: unknown;
  payment: {
    payment_id: string | null;
    amount_usd_micros: number;
    asset: string;
    network: string;
    payer: string | null;
    pay_to: string;
    transaction: string | null;
    resource_url: string;
    settlement: { status: X402EvidenceStatus };
    funds_moved: boolean | "unknown";
    deduplicated: boolean;
    delivery: {
      status: "fulfilled" | "failed" | "unknown";
      replay: boolean;
    };
    offer: {
      status: X402EvidenceStatus;
      resource_url: string | null;
      valid_until: string | null;
    };
    merchant_receipt: {
      status: X402EvidenceStatus;
      claim: "service_delivered" | null;
      issued_at: string | null;
    };
    signer_relationship: {
      kind: "direct" | "delegated" | "unverified" | null;
      merchant_root: string | null;
      signer: string | null;
      authorization_expires_at: string | null;
    };
    policy: {
      require_receipt: boolean;
      status: "satisfied" | "unsatisfied" | "not_required";
    };
    evidence: {
      offer: unknown | null;
      merchant_receipt: unknown | null;
      signer_authorization: unknown | null;
    };
  } | null;
  outcome: "paid" | "not_paid" | "unknown";
  replay: boolean;
  next_actions: X402CommerceNextAction[];
}
