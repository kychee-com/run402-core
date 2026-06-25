import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import { verifyWebhook, type VerifyWebhookResult } from "./verify-webhook.js";

const SECRET = "test-secret-32-bytes-of-shared-material";
const PREVIOUS = "rotated-out-secret-also-32-bytes";

function signBody(secret: string, t: number, rawBody: string): string {
  const sig = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  return `t=${t},v1=${sig}`;
}

function makeHeaders(sigValue: string | null): Headers {
  const h = new Headers();
  if (sigValue !== null) h.set("Run402-Signature", sigValue);
  return h;
}

function assertValid(r: VerifyWebhookResult, expected: "current" | "previous" = "current"): void {
  assert.equal(r.valid, true);
  if (r.valid) assert.equal(r.secret_used, expected);
}

function assertInvalid(r: VerifyWebhookResult, reason: string): void {
  assert.equal(r.valid, false);
  if (!r.valid) assert.equal(r.reason, reason);
}

const NOW = 1_748_102_400;
const opts = { nowSeconds: () => NOW };

// ---------------------------------------------------------------------------
// Happy path.
// ---------------------------------------------------------------------------

describe("verifyWebhook — happy path", () => {
  it("validates a correctly-signed request", () => {
    const body = `{"id":"abc","type":"project_past_due"}`;
    const headers = makeHeaders(signBody(SECRET, NOW, body));
    const r = verifyWebhook(headers, body, SECRET, opts);
    assertValid(r);
    if (r.valid) assert.equal(r.timestamp, NOW);
  });

  it("validates with whitespace around segments", () => {
    const body = `{}`;
    const sig = createHmac("sha256", SECRET).update(`${NOW}.${body}`).digest("hex");
    const headers = makeHeaders(` t=${NOW} , v1=${sig} `);
    assertValid(verifyWebhook(headers, body, SECRET, opts));
  });

  it("ignores unknown segments (forward-compat for future v2 schemes)", () => {
    const body = `{}`;
    const sig = createHmac("sha256", SECRET).update(`${NOW}.${body}`).digest("hex");
    const headers = makeHeaders(`t=${NOW},v1=${sig},v2=futureproof`);
    assertValid(verifyWebhook(headers, body, SECRET, opts));
  });

  it("works with case-insensitive header names", () => {
    const body = `{}`;
    const headers = makeHeaders(signBody(SECRET, NOW, body));
    // Pass as a plain object with mixed case.
    const plain = { "Run402-Signature": headers.get("Run402-Signature")! };
    assertValid(verifyWebhook(plain, body, SECRET, opts));
  });

  it("works with Node IncomingHttpHeaders-shape (array values)", () => {
    const body = `{}`;
    const sig = signBody(SECRET, NOW, body);
    const plain = { "run402-signature": [sig] };
    assertValid(verifyWebhook(plain, body, SECRET, opts));
  });
});

// ---------------------------------------------------------------------------
// Reject paths.
// ---------------------------------------------------------------------------

describe("verifyWebhook — reject paths", () => {
  it("missing header returns missing_signature_header", () => {
    assertInvalid(verifyWebhook(makeHeaders(null), "{}", SECRET, opts), "missing_signature_header");
  });

  it("empty header returns malformed_signature_header", () => {
    assertInvalid(verifyWebhook(makeHeaders(""), "{}", SECRET, opts), "malformed_signature_header");
  });

  it("malformed header (no =) returns malformed_signature_header", () => {
    assertInvalid(verifyWebhook(makeHeaders("notvalid"), "{}", SECRET, opts), "malformed_signature_header");
  });

  it("missing t returns missing_timestamp", () => {
    const sig = createHmac("sha256", SECRET).update(`${NOW}.{}`).digest("hex");
    assertInvalid(verifyWebhook(makeHeaders(`v1=${sig}`), "{}", SECRET, opts), "missing_timestamp");
  });

  it("missing v1 returns missing_v1", () => {
    assertInvalid(verifyWebhook(makeHeaders(`t=${NOW}`), "{}", SECRET, opts), "missing_v1");
  });

  it("malformed v1 (not hex / wrong length) returns malformed_signature_header", () => {
    // Wrong length → header parse rejects it.
    assertInvalid(verifyWebhook(makeHeaders(`t=${NOW},v1=abc`), "{}", SECRET, opts), "malformed_signature_header");
  });

  it("timestamp out of tolerance (too old) returns timestamp_out_of_tolerance", () => {
    const old = NOW - 1000; // 1000s > 300s tolerance
    const body = "{}";
    const headers = makeHeaders(signBody(SECRET, old, body));
    assertInvalid(verifyWebhook(headers, body, SECRET, opts), "timestamp_out_of_tolerance");
  });

  it("timestamp out of tolerance (too far future) returns timestamp_out_of_tolerance", () => {
    const future = NOW + 1000;
    const body = "{}";
    const headers = makeHeaders(signBody(SECRET, future, body));
    assertInvalid(verifyWebhook(headers, body, SECRET, opts), "timestamp_out_of_tolerance");
  });

  it("signature mismatch (wrong secret) returns signature_mismatch", () => {
    const body = "{}";
    const headers = makeHeaders(signBody("wrong-secret", NOW, body));
    assertInvalid(verifyWebhook(headers, body, SECRET, opts), "signature_mismatch");
  });

  it("signature mismatch (tampered body) returns signature_mismatch", () => {
    const body = `{"id":"original"}`;
    const headers = makeHeaders(signBody(SECRET, NOW, body));
    // Receiver re-serialized the body, breaking byte equality.
    assertInvalid(verifyWebhook(headers, `{"id": "original"}`, SECRET, opts), "signature_mismatch");
  });

  it("custom toleranceSeconds is respected", () => {
    const slightlyOld = NOW - 60;
    const body = "{}";
    const headers = makeHeaders(signBody(SECRET, slightlyOld, body));
    // Default tolerance 300 → passes
    assertValid(verifyWebhook(headers, body, SECRET, opts));
    // Custom tolerance 30 → fails
    assertInvalid(
      verifyWebhook(headers, body, SECRET, { ...opts, toleranceSeconds: 30 }),
      "timestamp_out_of_tolerance",
    );
  });
});

// ---------------------------------------------------------------------------
// Dual-secret rotation grace window.
// ---------------------------------------------------------------------------

describe("verifyWebhook — dual-secret rotation", () => {
  it("accepts current secret normally", () => {
    const body = "{}";
    const headers = makeHeaders(signBody(SECRET, NOW, body));
    const r = verifyWebhook(headers, body, SECRET, { ...opts, previousSecret: PREVIOUS });
    assertValid(r, "current");
  });

  it("accepts previous secret during grace window", () => {
    const body = "{}";
    const headers = makeHeaders(signBody(PREVIOUS, NOW, body));
    const r = verifyWebhook(headers, body, SECRET, { ...opts, previousSecret: PREVIOUS });
    assertValid(r, "previous");
  });

  it("rejects when previousSecret not supplied (rotation grace expired)", () => {
    const body = "{}";
    const headers = makeHeaders(signBody(PREVIOUS, NOW, body));
    assertInvalid(verifyWebhook(headers, body, SECRET, opts), "signature_mismatch");
  });

  it("rejects when neither current nor previous matches", () => {
    const body = "{}";
    const headers = makeHeaders(signBody("totally-wrong", NOW, body));
    assertInvalid(
      verifyWebhook(headers, body, SECRET, { ...opts, previousSecret: PREVIOUS }),
      "signature_mismatch",
    );
  });
});

// ---------------------------------------------------------------------------
// Constant-time comparison sanity.
// ---------------------------------------------------------------------------

describe("verifyWebhook — implementation sanity", () => {
  it("uses constant-time comparison (no early return on first-byte mismatch detectable from API)", () => {
    // We can't observe timing-safe behavior directly, but we can confirm
    // the function returns the same "signature_mismatch" for two
    // completely-wrong signatures regardless of how the bytes line up.
    const body = "{}";
    const wrong1 = makeHeaders(`t=${NOW},v1=${"0".repeat(64)}`);
    const wrong2 = makeHeaders(`t=${NOW},v1=${"f".repeat(64)}`);
    assertInvalid(verifyWebhook(wrong1, body, SECRET, opts), "signature_mismatch");
    assertInvalid(verifyWebhook(wrong2, body, SECRET, opts), "signature_mismatch");
  });
});
