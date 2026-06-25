/**
 * Verify a Run402 operator-notifications webhook request.
 *
 * Run402 signs every webhook delivery with HMAC-SHA256 in Stripe shape:
 *   Run402-Signature: t=<unix_seconds>,v1=<hex_digest>
 *
 * where `<hex_digest>` is `HMAC_SHA256(secret, "${t}.${rawBody}")`.
 *
 * Receivers should call `verifyWebhook(headers, rawBody, secret)` BEFORE
 * parsing or trusting the body. Pass the EXACT raw request body — re-
 * serializing JSON will change byte order and break the HMAC.
 *
 * Dual-secret rotation: pass `previousSecret` (returned from
 * `POST /agent/v1/webhook-secret/rotate` before rotation) to accept
 * signatures created with either secret during the 24h grace window.
 *
 * Replay protection: the function rejects signatures whose `t` is more
 * than `toleranceSeconds` (default 300 = 5 minutes) away from the
 * current time.
 *
 * @example
 * ```ts
 * import { verifyWebhook } from "@run402/functions";
 *
 * export default async (req: Request) => {
 *   const rawBody = await req.text();
 *   const result = verifyWebhook(req.headers, rawBody, process.env.RUN402_WEBHOOK_SECRET!);
 *   if (!result.valid) {
 *     return new Response(`bad signature: ${result.reason}`, { status: 401 });
 *   }
 *   const event = JSON.parse(rawBody);
 *   // …handle event…
 *   return new Response("ok");
 * };
 * ```
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export interface VerifyWebhookOptions {
  /** Maximum age of the signed timestamp, in seconds. Default 300 (5 min). */
  toleranceSeconds?: number;
  /** Optional previous secret accepted during a 24h rotation grace window. */
  previousSecret?: string | null;
  /** Override the current Unix timestamp (for tests). */
  nowSeconds?: () => number;
}

export type VerifyWebhookResult =
  | { valid: true; timestamp: number; secret_used: "current" | "previous" }
  | {
      valid: false;
      reason:
        | "missing_signature_header"
        | "malformed_signature_header"
        | "missing_timestamp"
        | "missing_v1"
        | "timestamp_out_of_tolerance"
        | "signature_mismatch";
    };

/**
 * Verify a Run402-signed webhook.
 *
 * @param headers Either an instance of `Headers` (Web API), a Node
 *                `IncomingHttpHeaders`-shaped record, or any object with
 *                `get(name)` and case-insensitive header access.
 * @param rawBody The exact raw request body bytes received. Must NOT be
 *                re-serialized from a parsed JSON object — byte-level
 *                equality with the signed payload is required.
 * @param secret The current webhook signing secret returned by
 *               `POST /agent/v1/webhook-secret/rotate`.
 * @param options Optional behavior tweaks.
 */
export function verifyWebhook(
  headers: HeadersLike,
  rawBody: string,
  secret: string,
  options: VerifyWebhookOptions = {},
): VerifyWebhookResult {
  const tolerance = options.toleranceSeconds ?? 300;
  const nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));

  const headerValue = getHeader(headers, "run402-signature");
  if (headerValue === null) {
    // Header not present at all.
    return { valid: false, reason: "missing_signature_header" };
  }

  const parsed = parseSignatureHeader(headerValue);
  if (parsed === null) {
    return { valid: false, reason: "malformed_signature_header" };
  }
  if (parsed.t === null) {
    return { valid: false, reason: "missing_timestamp" };
  }
  if (parsed.v1Hex === null) {
    return { valid: false, reason: "missing_v1" };
  }

  const now = nowSeconds();
  if (Math.abs(now - parsed.t) > tolerance) {
    return { valid: false, reason: "timestamp_out_of_tolerance" };
  }

  const signedPayload = `${parsed.t}.${rawBody}`;
  if (constantTimeEqualHex(parsed.v1Hex, computeHmacHex(secret, signedPayload))) {
    return { valid: true, timestamp: parsed.t, secret_used: "current" };
  }
  if (options.previousSecret) {
    if (constantTimeEqualHex(parsed.v1Hex, computeHmacHex(options.previousSecret, signedPayload))) {
      return { valid: true, timestamp: parsed.t, secret_used: "previous" };
    }
  }
  return { valid: false, reason: "signature_mismatch" };
}

// ---------------------------------------------------------------------------
// Headers abstraction — accept Web Headers, IncomingHttpHeaders, or
// case-insensitive plain objects.
// ---------------------------------------------------------------------------

/** Anything we can read a header from. */
export type HeadersLike =
  | Headers
  | Record<string, string | string[] | undefined>
  | { get(name: string): string | null };

function getHeader(headers: HeadersLike, name: string): string | null {
  // Web Headers: has .get and case-insensitive.
  if (typeof (headers as Headers).get === "function" && (headers as Headers).get.length === 1) {
    return (headers as Headers).get(name);
  }
  // Plain object: case-insensitive lookup.
  const lower = name.toLowerCase();
  const rec = headers as Record<string, string | string[] | undefined>;
  for (const key of Object.keys(rec)) {
    if (key.toLowerCase() === lower) {
      const v = rec[key];
      if (Array.isArray(v)) return v[0] ?? null;
      return v ?? null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Signature parsing.
// ---------------------------------------------------------------------------

interface ParsedSignatureHeader {
  t: number | null;
  v1Hex: string | null;
}

function parseSignatureHeader(value: string): ParsedSignatureHeader | null {
  // Format: t=<unix>,v1=<hex>[,v2=...]
  // Use comma + equals splitting; reject anything else.
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parts = trimmed.split(",");
  let t: number | null = null;
  let v1Hex: string | null = null;
  for (const raw of parts) {
    const segment = raw.trim();
    const eq = segment.indexOf("=");
    if (eq <= 0) return null;
    const key = segment.slice(0, eq).trim();
    const val = segment.slice(eq + 1).trim();
    if (!key || !val) return null;
    if (key === "t") {
      const n = Number(val);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
      t = n;
    } else if (key === "v1") {
      if (!/^[0-9a-f]{64}$/i.test(val)) return null;
      v1Hex = val.toLowerCase();
    }
    // Unknown keys ignored — forward-compat for future v2 schemes.
  }
  return { t, v1Hex };
}

// ---------------------------------------------------------------------------
// Crypto.
// ---------------------------------------------------------------------------

function computeHmacHex(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  // Convert both to Buffer of equal length, then timingSafeEqual.
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
