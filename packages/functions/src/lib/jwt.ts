/**
 * Minimal HS256/HS512 JWT sign + verify built directly on `node:crypto`.
 *
 * Used internally by `@run402/functions` to verify project JWTs in
 * `getUser`. Replaces a runtime dependency on the `jsonwebtoken` package
 * (and its transitive tree `jws` / `jwa` / `ecdsa-sig-formatter` /
 * `lodash.*` / `ms` / `semver` / `safe-buffer`), so this published SDK
 * has zero crypto deps beyond `node:crypto`. The Run402 Cloud gateway keeps
 * a companion implementation for its own runtime, but this package cannot
 * depend on gateway-private source.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

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

export type SupportedAlgorithm = "HS256" | "HS512";

export interface SignOptions {
  algorithm?: SupportedAlgorithm;
  expiresIn?: string | number;
  noTimestamp?: boolean;
}

export interface VerifyOptions {
  algorithms?: ReadonlyArray<SupportedAlgorithm>;
  issuer?: string;
  audience?: string | string[];
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
  return alg === "HS256" ? "sha256" : "sha512";
}

export function sign(
  payload: object,
  secret: string,
  options?: SignOptions,
): string {
  const alg: SupportedAlgorithm = options?.algorithm ?? "HS256";
  if (alg !== "HS256" && alg !== "HS512") {
    throw new JsonWebTokenError(`Unsupported algorithm: ${alg}`);
  }
  if (typeof secret !== "string" || secret.length === 0) {
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

  const header = { alg, typ: "JWT" };
  const headerB64 = b64urlEncode(JSON.stringify(header));
  const payloadB64 = b64urlEncode(JSON.stringify(claims));
  const sig = createHmac(hmacForAlg(alg), secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest();
  return `${headerB64}.${payloadB64}.${b64urlEncode(sig)}`;
}

export function verify<T = JwtPayload>(
  token: string,
  secret: string,
  options?: VerifyOptions,
): T {
  if (typeof token !== "string" || token.length === 0) {
    throw new JsonWebTokenError("jwt must be provided");
  }
  if (typeof secret !== "string" || secret.length === 0) {
    throw new JsonWebTokenError("secret must be provided");
  }
  const parts = token.split(".");
  if (parts.length !== 3) throw new JsonWebTokenError("jwt malformed");
  const [headerB64, payloadB64, sigB64] = parts;

  let header: { alg?: unknown; typ?: unknown };
  try {
    header = JSON.parse(b64urlDecodeToBuffer(headerB64).toString("utf8")) as {
      alg?: unknown;
      typ?: unknown;
    };
  } catch {
    throw new JsonWebTokenError("invalid token");
  }

  const allowed = (options?.algorithms ?? ["HS256"]) as ReadonlyArray<string>;
  if (typeof header.alg !== "string" || !allowed.includes(header.alg)) {
    throw new JsonWebTokenError("invalid algorithm");
  }
  if (header.alg !== "HS256" && header.alg !== "HS512") {
    throw new JsonWebTokenError("invalid algorithm");
  }

  const expected = createHmac(hmacForAlg(header.alg), secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest();
  let got: Buffer;
  try {
    got = b64urlDecodeToBuffer(sigB64);
  } catch {
    throw new JsonWebTokenError("invalid signature");
  }
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
    throw new JsonWebTokenError("invalid signature");
  }

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

  return payload as T;
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

const jwt = { sign, verify, decode };
export default jwt;
