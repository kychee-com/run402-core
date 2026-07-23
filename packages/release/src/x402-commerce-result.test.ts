import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  X402_COMMERCE_RESULT_SCHEMA_VERSION,
  X402_EVIDENCE_STATUSES,
  X402_GATEWAY_AVAILABILITY_ERROR_CODE,
  X402_MUTATION_STATES,
  X402_PAYMENT_POLICY_ERROR_CODES,
  X402_RECOVERY_ACTIONS,
} from "./x402-commerce-result.js";

describe("x402 commerce-result compatibility contract", () => {
  it("pins the schema, states, errors, and recovery actions", () => {
    assert.equal(
      X402_COMMERCE_RESULT_SCHEMA_VERSION,
      "x402-commerce-result.v1",
    );
    assert.deepEqual(X402_EVIDENCE_STATUSES, [
      "verified",
      "absent",
      "invalid",
      "untrusted",
      "unavailable",
    ]);
    assert.deepEqual(X402_MUTATION_STATES, [
      "not_started",
      "committed",
      "unknown",
    ]);
    assert.deepEqual(X402_PAYMENT_POLICY_ERROR_CODES, [
      "MERCHANT_RECEIPT_REQUIRED",
      "MERCHANT_RECEIPT_UNAVAILABLE",
    ]);
    assert.equal(
      X402_GATEWAY_AVAILABILITY_ERROR_CODE,
      "MERCHANT_EVIDENCE_UNAVAILABLE",
    );
    assert.deepEqual(X402_RECOVERY_ACTIONS, [
      "retry",
      "reconcile_payment",
    ]);
  });
});
