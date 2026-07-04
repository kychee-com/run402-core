/**
 * SDK runtime verifier for the gateway-signed actor-context envelope.
 *
 * Why this lives in `@run402/functions` (vendored shape):
 *   - `@run402/functions` is published independently; it must NOT depend
 *     on `@run402/gateway` types or runtime.
 *   - The verifier is small, deterministic, and security-critical — easier
 *     to audit when it lives next to the consumer.
 *   - Matches the convention used for `jwt.ts` (vendored upstream copy of
 *     the verifier we trust).
 *
 * Contract — the encoded envelope is `base64url(canonical_json) + "." +
 * base64url(hmac_sha256)`. Canonical JSON has a fixed key order; the
 * verifier doesn't re-canonicalise, it just rehmac's the body bytes that
 * were base64-decoded. (Trying to re-derive canonical JSON from the parsed
 * object would re-introduce key-order brittleness; verify the bytes you
 * received, parse only to read fields.)
 *
 * Lookup of `actor_context_signing_key[kid]`:
 *   1. `ACTOR_CONTEXT_SIGNING_KEY_MAP_JSON` env (`{kid: base64}` JSON).
 *   2. `ACTOR_CONTEXT_SIGNING_KEY_<KID_UPPER>` env (one var per kid).
 *   3. Test injection via `_setActorContextKeyMapForTest` on this module.
 *
 * Verification failure modes (mirrors the gateway side):
 *   - "malformed"               — encoded shape rejected before parse
 *   - "unknown_kid"             — envelope's kid not in the verifier map
 *   - "bad_signature"           — HMAC mismatch
 *   - "iss_mismatch"            — envelope.iss !== "run402-gateway"
 *   - "aud_mismatch"            — envelope.aud !== "run402-functions-runtime"
 *   - "expired"                 — envelope.exp <= now
 *   - "lifetime_too_long"       — envelope.exp - envelope.iat > 60s
 *   - "project_id_mismatch"     — envelope.project_id !== request's
 *   - "request_id_mismatch"     — envelope.request_id !== request's
 *   - "method_mismatch"         — different HTTP method
 *   - "host_mismatch"           — different host (after default-port normalise)
 *   - "path_mismatch"           — different path (compared by sha256)
 *   - "version_mismatch"        — schema version not what we compiled
 *
 * On ANY failure the SDK runtime treats the request as anonymous AND
 * logs `R402_AUTH_ACTOR_HEADER_SPOOF` so spoofs / replays are visible
 * in observability.
 *
 * @see openspec/changes/auth-aware-ssr/specs/routed-http-functions/spec.md
 */

import crypto from "node:crypto";

export const ACTOR_CONTEXT_ENVELOPE_VERSION = 1 as const;
export const ACTOR_CONTEXT_ENVELOPE_ISS = "run402-gateway";
export const ACTOR_CONTEXT_ENVELOPE_AUD = "run402-functions-runtime";
export const ACTOR_CONTEXT_MAX_LIFETIME_SEC = 60;

/** Inbound header carrying the encoded envelope. The runtime reads from
 *  the request headers in `RunRequestContext.request.headers`. */
export const ACTOR_CONTEXT_HEADER = "x-run402-actor-context";

export interface VerifiedActorPayload {
  id: string;
  email: string;
  /** Present only for Run402 tenant test-session actors. */
  isTest?: true;
  emailVerified: boolean;
  authTime: number;
  amr: string[];
  amrTimes: Record<string, number>;
  authzVersion: number;
}

export interface VerifiedEnvelope {
  v: 1;
  kid: string;
  iss: typeof ACTOR_CONTEXT_ENVELOPE_ISS;
  aud: typeof ACTOR_CONTEXT_ENVELOPE_AUD;
  project_id: string;
  request_id: string;
  method: string;
  host: string;
  path_hash: string;
  iat: number;
  exp: number;
  actor: VerifiedActorPayload;
}

export interface VerifyRequestContext {
  projectId: string;
  requestId: string;
  method: string;
  host: string;
  path: string;
  /** Override for tests; production uses `new Date()`. */
  now?: Date;
}

export type VerifyFailureReason =
  | "malformed"
  | "unknown_kid"
  | "bad_signature"
  | "iss_mismatch"
  | "aud_mismatch"
  | "expired"
  | "lifetime_too_long"
  | "project_id_mismatch"
  | "request_id_mismatch"
  | "method_mismatch"
  | "host_mismatch"
  | "path_mismatch"
  | "version_mismatch";

export type VerifyOutcome =
  | { ok: true; envelope: VerifiedEnvelope }
  | { ok: false; reason: VerifyFailureReason };

// ---------------------------------------------------------------------------
// Key store (env-loaded, test-injectable)
// ---------------------------------------------------------------------------

const KEY_MIN_BYTES = 32;

/** The resolved verify-key map (env ∪ gateway-fetched ∪ test-injected).
 *  `null` until first resolve. Once populated with ≥1 key it is treated as
 *  authoritative and never re-fetched. */
let keyMap: Map<string, Buffer> | null = null;
/** De-dupes concurrent cold-start fetches; cleared on completion so a
 *  failed fetch can be retried by the next request (rather than pinning the
 *  Lambda anonymous for its whole lifetime). */
let keyFetchInFlight: Promise<void> | null = null;

/** Pure env read. Does NOT cache — `keyMap` is only set once we have keys,
 *  so an empty prod-Lambda env doesn't pin an empty map and block the
 *  gateway fetch fallback. */
function loadKeyMapFromEnv(): Map<string, Buffer> {
  const map = new Map<string, Buffer>();

  const mapJson = process.env.ACTOR_CONTEXT_SIGNING_KEY_MAP_JSON;
  if (mapJson) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(mapJson);
    } catch (err) {
      throw new Error(
        `ACTOR_CONTEXT_SIGNING_KEY_MAP_JSON is not valid JSON: ${(err as Error).message}`,
      );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("ACTOR_CONTEXT_SIGNING_KEY_MAP_JSON must be an object {kid: base64}");
    }
    for (const [kid, b64] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof b64 !== "string") continue;
      const buf = Buffer.from(b64, "base64");
      if (buf.length >= KEY_MIN_BYTES) map.set(kid, buf);
    }
  }

  for (const [envName, envValue] of Object.entries(process.env)) {
    const match = envName.match(/^ACTOR_CONTEXT_SIGNING_KEY_([A-Z0-9_-]+)$/);
    if (!match) continue;
    if (
      envName === "ACTOR_CONTEXT_SIGNING_KEY_CURRENT_KID" ||
      envName === "ACTOR_CONTEXT_SIGNING_KEY_MAP_JSON"
    ) {
      continue;
    }
    if (typeof envValue !== "string" || envValue.length === 0) continue;
    const kid = match[1]!.toLowerCase().replace(/_/g, "-");
    if (map.has(kid)) continue;
    const buf = Buffer.from(envValue, "base64");
    if (buf.length >= KEY_MIN_BYTES) map.set(kid, buf);
  }

  return map;
}

/** Sync accessor used by `verifyActorContextEnvelope`. Prefers the resolved
 *  `keyMap`; falls back to an env read so callers that have env keys (local
 *  dev, the in-process gateway) or that injected via the test helper work
 *  without an explicit `ensureActorContextKeysLoaded()`. */
function currentKeyMap(): Map<string, Buffer> {
  return keyMap ?? loadKeyMapFromEnv();
}

/**
 * Ensure the actor-context verify keys are available before a synchronous
 * `verifyActorContextEnvelope` call. In production the key is NEVER injected
 * into the tenant Lambda's environment (gateway-only secret — see the
 * `functions.ts` INVARIANT comment); instead the runtime fetches it once,
 * lazily, from the gateway's service-key-authed
 * `GET /internal/v1/actor-context-keys` endpoint using the Lambda's
 * `RUN402_SERVICE_KEY`. The key stays out of the static bundle (can't be
 * grepped) and is cached only in this module's memory. Local dev and the
 * in-process gateway have the key in env, so the fetch path is skipped.
 *
 * Failures are non-fatal: the request stays anonymous and a later request
 * retries the fetch. Callers MUST await this before relying on a cookie-
 * derived actor (the generated Lambda entry wrapper does so when the
 * inbound request carries the actor-context header).
 */
export async function ensureActorContextKeysLoaded(): Promise<void> {
  if (keyMap && keyMap.size > 0) return;
  const envMap = loadKeyMapFromEnv();
  if (envMap.size > 0) {
    keyMap = envMap;
    return;
  }
  if (!keyFetchInFlight) {
    keyFetchInFlight = fetchActorContextKeysFromGateway()
      .then((fetched) => {
        if (fetched.size > 0) keyMap = fetched;
      })
      .catch(() => {
        /* stay anonymous; next request retries */
      })
      .finally(() => {
        keyFetchInFlight = null;
      });
  }
  await keyFetchInFlight;
}

/** Fetch the verify-key map from the gateway. Returns an empty map (never
 *  throws to the caller's await) when the env is missing or the call fails. */
async function fetchActorContextKeysFromGateway(): Promise<Map<string, Buffer>> {
  const map = new Map<string, Buffer>();
  const base = process.env.RUN402_API_BASE;
  const serviceKey = process.env.RUN402_SERVICE_KEY;
  if (!base || !serviceKey) return map;
  const url = `${base.replace(/\/+$/, "")}/internal/v1/actor-context-keys`;
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${serviceKey}` },
  });
  if (!res.ok) return map;
  const body = (await res.json()) as { keys?: Record<string, string> };
  for (const [kid, b64] of Object.entries(body.keys ?? {})) {
    if (typeof b64 !== "string") continue;
    const buf = Buffer.from(b64, "base64");
    if (buf.length >= KEY_MIN_BYTES) map.set(kid, buf);
  }
  return map;
}

/** Test injection. NEVER call from production code. */
export function _setActorContextKeyMapForTest(
  map: Record<string, Buffer | string> | null,
): void {
  if (map === null) {
    keyMap = null;
    keyFetchInFlight = null;
    return;
  }
  const m = new Map<string, Buffer>();
  for (const [kid, value] of Object.entries(map)) {
    const buf = Buffer.isBuffer(value) ? value : Buffer.from(value, "base64");
    if (buf.length < KEY_MIN_BYTES) {
      throw new Error(`Actor-context key for kid "${kid}" is too short`);
    }
    m.set(kid, buf);
  }
  keyMap = m;
}

// ---------------------------------------------------------------------------
// Verifier
// ---------------------------------------------------------------------------

export function verifyActorContextEnvelope(
  encoded: string,
  ctx: VerifyRequestContext,
): VerifyOutcome {
  if (typeof encoded !== "string" || encoded.length === 0) {
    return { ok: false, reason: "malformed" };
  }
  const dot = encoded.indexOf(".");
  if (dot <= 0 || dot === encoded.length - 1) {
    return { ok: false, reason: "malformed" };
  }
  const bodyB64 = encoded.slice(0, dot);
  const sigB64 = encoded.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(bodyB64) || !/^[A-Za-z0-9_-]+$/.test(sigB64)) {
    return { ok: false, reason: "malformed" };
  }

  let bodyBuf: Buffer;
  let envelope: VerifiedEnvelope;
  try {
    bodyBuf = Buffer.from(bodyB64, "base64url");
    envelope = JSON.parse(bodyBuf.toString("utf8")) as VerifiedEnvelope;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!envelope || typeof envelope !== "object") {
    return { ok: false, reason: "malformed" };
  }
  if (envelope.v !== ACTOR_CONTEXT_ENVELOPE_VERSION) {
    return { ok: false, reason: "version_mismatch" };
  }
  if (typeof envelope.kid !== "string") return { ok: false, reason: "malformed" };

  const key = currentKeyMap().get(envelope.kid);
  if (!key) return { ok: false, reason: "unknown_kid" };

  const sigBuf = Buffer.from(sigB64, "base64url");
  const expectedSig = crypto.createHmac("sha256", key).update(bodyBuf).digest();
  if (sigBuf.length !== expectedSig.length) {
    return { ok: false, reason: "bad_signature" };
  }
  if (!crypto.timingSafeEqual(sigBuf, expectedSig)) {
    return { ok: false, reason: "bad_signature" };
  }

  if (envelope.iss !== ACTOR_CONTEXT_ENVELOPE_ISS) {
    return { ok: false, reason: "iss_mismatch" };
  }
  if (envelope.aud !== ACTOR_CONTEXT_ENVELOPE_AUD) {
    return { ok: false, reason: "aud_mismatch" };
  }
  if (typeof envelope.iat !== "number" || typeof envelope.exp !== "number") {
    return { ok: false, reason: "malformed" };
  }
  if (envelope.exp - envelope.iat > ACTOR_CONTEXT_MAX_LIFETIME_SEC) {
    return { ok: false, reason: "lifetime_too_long" };
  }
  const nowSec = Math.floor((ctx.now ?? new Date()).getTime() / 1000);
  if (envelope.exp <= nowSec) return { ok: false, reason: "expired" };

  if (envelope.project_id !== ctx.projectId) {
    return { ok: false, reason: "project_id_mismatch" };
  }
  if (envelope.request_id !== ctx.requestId) {
    return { ok: false, reason: "request_id_mismatch" };
  }
  if (envelope.method !== ctx.method.toUpperCase()) {
    return { ok: false, reason: "method_mismatch" };
  }
  if (envelope.host !== normaliseHost(ctx.host)) {
    return { ok: false, reason: "host_mismatch" };
  }
  if (envelope.path_hash !== sha256Hex(ctx.path)) {
    return { ok: false, reason: "path_mismatch" };
  }

  return { ok: true, envelope };
}

function normaliseHost(host: string): string {
  return host.toLowerCase().replace(/:80$/, "").replace(/:443$/, "");
}

function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}
