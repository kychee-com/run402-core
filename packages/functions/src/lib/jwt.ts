/**
 * Minimal HS256/HS512 JWT sign + verify built directly on `node:crypto`.
 *
 * Drop-in replacement for the subset of `jsonwebtoken` this codebase used
 * (sign / verify / decode + TokenExpiredError + JwtPayload). Replaces the
 * `jsonwebtoken` package and its transitive tree (`jws`, `jwa`,
 * `ecdsa-sig-formatter`, `lodash.*`, `ms`, `semver`, `safe-buffer`) — the
 * cryptographic primitive (HMAC) comes from `node:crypto`; the rest is JWT
 * envelope handling per RFC 7519.
 *
 * VENDORED, KEPT IN SYNC WITH THE GATEWAY'S `packages/gateway/src/lib/jwt.ts`.
 * Same file lineage; this copy had drifted to a pre-keyring version (238 lines
 * vs 344 — no `VerificationKey`, no `verifyWithKey`, no kid-aware selection),
 * which is why no deployed function at any version could verify a keyset. That
 * gap is what blocked project-JWT rotation entirely: pushing a new key broke
 * old tokens, pushing the old one changed nothing, and pushing a JWKS broke
 * every version including the newest.
 *
 * The symmetric HMAC algorithms plus **ES256** are implemented. ES256 exists
 * here so the project keyring can hold a key whose VERIFICATION material is
 * safe to hand out: with an HMAC key, verify and sign are the same capability,
 * so any consumer able to check a signature can forge one. RS/PS remain
 * unsupported; for OIDC JWKS verification the gateway uses `jose` directly
 * (see services/oidc-jwks.ts).
 *
 * The verifier's algorithm allowlist defaults to ["HS256"] and any token
 * claiming a different `alg` is rejected before any cryptographic work —
 * defence against the classic "alg=none" / algorithm-confusion attacks. A key
 * only ever verifies a token whose `alg` matches its own, so an ES256 public
 * key can never be pressed into service as HMAC key material (the specific
 * confusion attack that asymmetric-alongside-symmetric invites).
 */

import { createHmac, createSign, createVerify, timingSafeEqual, type KeyObject } from "node:crypto";

export interface JwtPayload {
  [key: string]: unknown;
  iat?: number;
  exp?: number;
  nbf?: number;
  iss?: string;
  aud?: string | string[];
  sub?: string;
  jti?: string;
}

export type SupportedAlgorithm = "HS256" | "HS512" | "ES256";

/** True for algorithms whose verification material is not signing material. */
export function isAsymmetricAlg(alg: string): alg is "ES256" {
  return alg === "ES256";
}

export interface SignOptions {
  algorithm?: SupportedAlgorithm;
  /** Seconds (number) or duration string (`"1h"`, `"15m"`, `"-1s"`). */
  expiresIn?: string | number;
  /** Skip auto-populating `iat`. */
  noTimestamp?: boolean;
  /**
   * Emit a `kid` header. Omitted entirely when unset, so legacy issuance keeps
   * producing byte-identical bare `{alg,typ}` headers.
   */
  kid?: string;
}

/**
 * One symmetric verification key. `key` is the RAW HMAC key material: a legacy
 * passphrase contributes `Buffer.from(passphrase, "utf8")`, a JWKS `oct` entry
 * contributes `Buffer.from(k, "base64url")` — which are byte-identical for the
 * same secret, so lifting a passphrase into a one-key JWKS is a no-op.
 *
 * `legacy: true` marks the single key eligible to verify tokens that carry NO
 * `kid` header (what `deriveProjectKeys` emits today).
 */
export interface VerificationKey {
  kid?: string;
  /**
   * HMAC key material for `HS*`.
   *
   * For `ES256` this is the SPKI DER of the PUBLIC key — never private
   * material. It exists so the keyring's fingerprint and duplicate-material
   * checks work identically across key types, and so nothing that digests or
   * logs a key can reach a secret by doing so.
   */
  key: Buffer;
  alg: SupportedAlgorithm;
  legacy?: boolean;
  /** `ES256` verification material. Absent for `HS*`. */
  publicKey?: KeyObject;
  /**
   * `ES256` signing material. Present ONLY on an entry configured with a
   * private component; its absence is what makes a key verify-only, which the
   * keyring relies on to refuse designating it as the signing key.
   */
  privateKey?: KeyObject;
}

/** A bare passphrase (legacy) or an ordered verification keyset. */
export type SecretOrKeys = string | ReadonlyArray<VerificationKey>;

export interface VerifyOptions {
  algorithms?: ReadonlyArray<SupportedAlgorithm>;
  issuer?: string;
  audience?: string | string[];
  /** Seconds of slack applied to both `exp` and `nbf` checks. */
  clockTolerance?: number;
}

export class JsonWebTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonWebTokenError";
  }
}

export class TokenExpiredError extends JsonWebTokenError {
  expiredAt: Date;
  constructor(message: string, expiredAt: Date) {
    super(message);
    this.name = "TokenExpiredError";
    this.expiredAt = expiredAt;
  }
}

export class NotBeforeError extends JsonWebTokenError {
  date: Date;
  constructor(message: string, date: Date) {
    super(message);
    this.name = "NotBeforeError";
    this.date = date;
  }
}

/**
 * Raised when a token names a `kid` no configured key provides. Declared here
 * (after `JsonWebTokenError`) because `extends` is evaluated in source order.
 */
export class UnknownKeyIdError extends JsonWebTokenError {
  kid: string;
  constructor(kid: string) {
    super("unknown key id");
    this.name = "UnknownKeyIdError";
    this.kid = kid;
  }
}

function b64urlEncode(input: string | Buffer): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecodeToBuffer(input: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(input)) throw new JsonWebTokenError("invalid token");
  const norm = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = norm.length % 4 === 0 ? "" : "=".repeat(4 - (norm.length % 4));
  return Buffer.from(norm + pad, "base64");
}

const DURATION_RE = /^(-?\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|weeks?|y|years?)?$/i;

function parseDurationSeconds(input: string | number): number {
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw new TypeError(`Invalid expiresIn: ${input}`);
    return Math.floor(input);
  }
  const m = DURATION_RE.exec(input.trim());
  if (!m) throw new TypeError(`Invalid expiresIn duration: ${input}`);
  const n = parseFloat(m[1]);
  const unit = (m[2] ?? "s").toLowerCase();
  if (unit.startsWith("y")) return Math.floor(n * 31_557_600);
  if (unit.startsWith("w")) return Math.floor(n * 604_800);
  if (unit.startsWith("d")) return Math.floor(n * 86_400);
  if (unit.startsWith("h")) return Math.floor(n * 3_600);
  if (unit === "m" || unit.startsWith("min")) return Math.floor(n * 60);
  return Math.floor(n);
}

function hmacForAlg(alg: SupportedAlgorithm): "sha256" | "sha512" {
  // Explicit rather than `=== "HS256" ? sha256 : sha512`: with ES256 in the
  // union that fallback would silently HMAC an asymmetric key under sha512.
  // Both call sites guard already; this makes the guard non-load-bearing.
  if (alg === "HS256") return "sha256";
  if (alg === "HS512") return "sha512";
  throw new JsonWebTokenError(`${alg} is not an HMAC algorithm`);
}

export function sign(
  payload: object,
  // Accepts RAW key bytes as well as a passphrase. Callers that resolve a key
  // through the keyring pass a Buffer, so they sign with the DECODED key rather
  // than whatever string `JWT_SECRET` happens to hold — under a JWKS that string
  // is the JSON document, and signing with it produces tokens nothing verifies.
  // For ES256 the caller passes the private `KeyObject`; a Buffer is rejected,
  // since raw bytes cannot be an EC private key here.
  secret: string | Buffer | KeyObject,
  options?: SignOptions,
): string {
  const alg: SupportedAlgorithm = options?.algorithm ?? "HS256";
  if (alg !== "HS256" && alg !== "HS512" && alg !== "ES256") {
    throw new JsonWebTokenError(`Unsupported algorithm: ${alg}`);
  }
  const isKeyObject = typeof secret === "object" && secret !== null && !Buffer.isBuffer(secret);
  if (alg === "ES256") {
    if (!isKeyObject) {
      throw new JsonWebTokenError("ES256 requires a private KeyObject");
    }
  } else if (isKeyObject) {
    throw new JsonWebTokenError(`${alg} requires raw key material, not a KeyObject`);
  }
  const isBuffer = Buffer.isBuffer(secret);
  if (!isKeyObject && ((!isBuffer && typeof secret !== "string") || secret.length === 0)) {
    throw new JsonWebTokenError("secretOrPrivateKey must be provided");
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new JsonWebTokenError("payload must be a plain object");
  }

  const claims: Record<string, unknown> = { ...(payload as Record<string, unknown>) };
  const noTimestamp = options?.noTimestamp ?? false;
  if (!noTimestamp && claims.iat === undefined) {
    claims.iat = Math.floor(Date.now() / 1000);
  }
  if (options?.expiresIn !== undefined) {
    if (claims.exp !== undefined) {
      throw new JsonWebTokenError(
        "Bad options.expiresIn option the payload already has an exp property",
      );
    }
    const offset = parseDurationSeconds(options.expiresIn);
    const iatRef = typeof claims.iat === "number" ? claims.iat : Math.floor(Date.now() / 1000);
    claims.exp = iatRef + offset;
  }

  // `kid` is omitted entirely when unset so legacy issuance keeps producing
  // byte-identical bare `{alg,typ}` headers.
  const header = options?.kid === undefined
    ? { alg, typ: "JWT" }
    : { alg, typ: "JWT", kid: options.kid };
  const headerB64 = b64urlEncode(JSON.stringify(header));
  const payloadB64 = b64urlEncode(JSON.stringify(claims));
  const signingInput = `${headerB64}.${payloadB64}`;
  const sig = alg === "ES256"
    // JWS requires the raw R||S pair, NOT the DER encoding node emits by
    // default. Getting this wrong produces a signature every verifier rejects.
    ? createSign("sha256")
        .update(signingInput)
        .sign({ key: secret as KeyObject, dsaEncoding: "ieee-p1363" })
    : createHmac(hmacForAlg(alg), secret as string | Buffer)
        .update(signingInput)
        .digest();
  return `${signingInput}.${b64urlEncode(sig)}`;
}

/**
 * Verify and report WHICH key matched.
 *
 * Key selection (mirrors the shipped gateway policy, and is deliberately
 * stricter than PostgREST v12.2.3, which ignores `kid` entirely):
 *   - `kid` present and known   -> verify against THAT key alone; a signature
 *                                  mismatch is an error, never a fallback.
 *   - `kid` present but unknown -> reject immediately, no HMAC work.
 *   - `kid` absent              -> try only keys marked `legacy`.
 *
 * A bare-string `secret` keeps the legacy single-key behavior exactly.
 */
export function verifyWithKey<T = JwtPayload>(
  token: string,
  secretOrKeys: SecretOrKeys,
  options?: VerifyOptions,
): { payload: T; kid?: string } {
  if (typeof token !== "string" || token.length === 0) {
    throw new JsonWebTokenError("jwt must be provided");
  }
  const keys: ReadonlyArray<VerificationKey> = typeof secretOrKeys === "string"
    ? (secretOrKeys.length === 0
        ? (() => { throw new JsonWebTokenError("secret must be provided"); })()
        : [{ key: Buffer.from(secretOrKeys, "utf8"), alg: "HS256", legacy: true }])
    : secretOrKeys;
  if (keys.length === 0) throw new JsonWebTokenError("secret must be provided");

  const parts = token.split(".");
  if (parts.length !== 3) throw new JsonWebTokenError("jwt malformed");
  const [headerB64, payloadB64, sigB64] = parts;

  let header: { alg?: unknown; typ?: unknown; kid?: unknown };
  try {
    header = JSON.parse(b64urlDecodeToBuffer(headerB64).toString("utf8")) as {
      alg?: unknown;
      typ?: unknown;
      kid?: unknown;
    };
  } catch {
    throw new JsonWebTokenError("invalid token");
  }

  const allowed = (options?.algorithms ?? ["HS256"]) as ReadonlyArray<string>;
  if (typeof header.alg !== "string" || !allowed.includes(header.alg)) {
    throw new JsonWebTokenError("invalid algorithm");
  }
  if (header.alg !== "HS256" && header.alg !== "HS512" && header.alg !== "ES256") {
    throw new JsonWebTokenError("invalid algorithm");
  }
  const alg = header.alg;

  // Select the candidate set BEFORE doing any HMAC work.
  let candidates: ReadonlyArray<VerificationKey>;
  if (typeof header.kid === "string") {
    const named = keys.filter((k) => k.kid === header.kid);
    if (named.length === 0) throw new UnknownKeyIdError(header.kid);
    candidates = named;
  } else {
    // A bare string secret is inherently the legacy key; an explicit keyset
    // must mark exactly which key may verify kid-less tokens.
    candidates = keys.filter((k) => k.legacy === true);
    if (candidates.length === 0) throw new JsonWebTokenError("invalid key id");
  }

  let got: Buffer;
  try {
    got = b64urlDecodeToBuffer(sigB64);
  } catch {
    throw new JsonWebTokenError("invalid signature");
  }

  let matched: VerificationKey | undefined;
  for (const candidate of candidates) {
    // A key only verifies its OWN algorithm. This is what stops an ES256
    // public key from being used as HMAC material (algorithm confusion) now
    // that both kinds can sit in one keyset.
    if (candidate.alg !== alg) continue;
    if (alg === "ES256") {
      if (!candidate.publicKey) continue;
      const ok = createVerify("sha256")
        .update(`${headerB64}.${payloadB64}`)
        .verify({ key: candidate.publicKey, dsaEncoding: "ieee-p1363" }, got);
      if (ok) {
        matched = candidate;
        break;
      }
      continue;
    }
    const expected = createHmac(hmacForAlg(alg), candidate.key)
      .update(`${headerB64}.${payloadB64}`)
      .digest();
    if (got.length === expected.length && timingSafeEqual(got, expected)) {
      matched = candidate;
      break;
    }
  }
  if (!matched) throw new JsonWebTokenError("invalid signature");

  let payload: JwtPayload;
  try {
    payload = JSON.parse(b64urlDecodeToBuffer(payloadB64).toString("utf8")) as JwtPayload;
  } catch {
    throw new JsonWebTokenError("invalid token");
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new JsonWebTokenError("invalid token");
  }

  const clockTolerance = options?.clockTolerance ?? 0;
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === "number" && payload.exp + clockTolerance < now) {
    throw new TokenExpiredError("jwt expired", new Date(payload.exp * 1000));
  }
  if (typeof payload.nbf === "number" && payload.nbf - clockTolerance > now) {
    throw new NotBeforeError("jwt not active", new Date(payload.nbf * 1000));
  }
  if (options?.issuer !== undefined && payload.iss !== options.issuer) {
    throw new JsonWebTokenError(`jwt issuer invalid. expected: ${options.issuer}`);
  }
  if (options?.audience !== undefined) {
    const wantArr = Array.isArray(options.audience) ? options.audience : [options.audience];
    const haveArr = Array.isArray(payload.aud)
      ? payload.aud
      : payload.aud !== undefined
        ? [payload.aud]
        : [];
    if (!wantArr.some((w) => haveArr.includes(w))) {
      throw new JsonWebTokenError("jwt audience invalid");
    }
  }

  return { payload: payload as T, kid: matched.kid };
}

/**
 * Verify a token, returning only the payload. Accepts a legacy passphrase or a
 * keyset; use `verifyWithKey` when the caller needs to know which key matched
 * (legacy-usage telemetry during a rotation).
 */
export function verify<T = JwtPayload>(
  token: string,
  secretOrKeys: SecretOrKeys,
  options?: VerifyOptions,
): T {
  return verifyWithKey<T>(token, secretOrKeys, options).payload;
}

export function decode<T = JwtPayload>(token: string): T | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const decoded = JSON.parse(b64urlDecodeToBuffer(parts[1]).toString("utf8")) as unknown;
    if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) return null;
    return decoded as T;
  } catch {
    return null;
  }
}

const jwt = { sign, verify, verifyWithKey, decode };
export default jwt;
