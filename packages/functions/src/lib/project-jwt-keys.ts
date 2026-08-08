/**
 * The project-JWT verification keyset, fetched from the gateway at cold start.
 *
 * WHY THIS EXISTS. Until now the runtime read `RUN402_JWT_SECRET` — the
 * PLATFORM signing key — straight out of the Lambda environment. That key is
 * symmetric, so verification material IS signing material: every one of the
 * fleet's tenant Lambdas held the ability to forge `anon_key`/`service_key`
 * for EVERY project on the platform, and those carry no expiry. It also made
 * rotation impossible, because the key arrived at deploy time and could only
 * change by redeploying someone else's code.
 *
 * Fetching a PUBLIC keyset instead fixes both at once: there is nothing here
 * that can sign, and a rotated key reaches the fleet at the next cold start
 * with no redeployment at all.
 *
 * Deliberately mirrors `lib/actor-context-verify.ts`, which established this
 * pattern for the actor-context key — same lazy single-flight fetch, same
 * service-key auth, same "failures are non-fatal, the next request retries".
 *
 * FETCH-ONLY. There was a transition fallback here: while `RUN402_JWT_SECRET`
 * was still injected, it was kept as a second, kid-less verification key tried
 * after the fetched keyset. It was load-bearing for exactly one window — after
 * the fleet carried this runtime but BEFORE the gateway's signing key became
 * asymmetric, the gateway was still minting HS256 tokens that an
 * asymmetric-only keyset cannot verify.
 *
 * That window closed. The gateway signs ES256 (`kid=p1-2026-08`), and §8 both
 * stopped injecting the env key and swept it out of the fleet, so the fallback
 * had already stopped firing in production before this removed it — it read an
 * env var that is no longer set on any live function.
 *
 * The consequence is deliberate and is the whole point: with no fallback, a
 * failed keyset fetch leaves NO keys, and `getUser()` fails closed rather than
 * silently falling back to material the tenant's own environment could supply.
 * See `openspec/changes/functions-runtime-key-decoupling/design.md`.
 */

import { createPublicKey } from "node:crypto";
import type { VerificationKey } from "./jwt.js";

interface ServedJwk {
  kty?: string;
  crv?: string;
  alg?: string;
  x?: string;
  y?: string;
  kid?: string;
}

let cached: VerificationKey[] | null = null;
let fetchInFlight: Promise<void> | null = null;

/**
 * The keys `getUser()` should verify against.
 *
 * The fetched public keyset, and nothing else. An empty array is a legitimate
 * result — it means the fetch has not succeeded yet — and callers must treat it
 * as "cannot verify", never as "no verification needed".
 */
export function projectJwtVerificationKeys(): VerificationKey[] {
  return cached ? [...cached] : [];
}

/**
 * Ensure the keyset is loaded before a synchronous verify.
 *
 * Single-flight: concurrent invocations in the same execution environment
 * share one fetch. Cached for the life of the environment, so a warm Lambda
 * pays nothing. Never throws — a failed fetch leaves whatever keys are
 * available (possibly none at all) and the next request retries.
 */
export async function ensureProjectJwtKeysLoaded(): Promise<void> {
  if (cached && cached.length > 0) return;
  if (!fetchInFlight) {
    fetchInFlight = fetchKeysFromGateway()
      .then((fetched) => {
        if (fetched.length > 0) cached = fetched;
      })
      .catch(() => {
        /* keep whatever we have; the next request retries */
      })
      .finally(() => {
        fetchInFlight = null;
      });
  }
  await fetchInFlight;
}

/** True when verification has no key at all — the caller must fail CLOSED
 *  rather than treat the request as anonymous-but-fine. */
export function projectJwtKeysUnavailable(): boolean {
  return projectJwtVerificationKeys().length === 0;
}

async function fetchKeysFromGateway(): Promise<VerificationKey[]> {
  const base = process.env.RUN402_API_BASE;
  const serviceKey = process.env.RUN402_SERVICE_KEY;
  if (!base || !serviceKey) return [];
  const url = `${base.replace(/\/+$/, "")}/internal/v1/project-jwt-keys`;
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${serviceKey}` },
  });
  if (!res.ok) return [];
  const body = (await res.json()) as { keys?: ServedJwk[] };
  const out: VerificationKey[] = [];
  for (const jwk of body.keys ?? []) {
    // Only the shape the gateway promises to serve. Anything else — notably
    // anything symmetric — is ignored rather than trusted: this runtime must
    // never end up holding key material that can sign.
    if (jwk.kty !== "EC" || jwk.crv !== "P-256") continue;
    if (typeof jwk.x !== "string" || typeof jwk.y !== "string") continue;
    try {
      const publicKey = createPublicKey({
        key: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y } as never,
        format: "jwk",
      });
      out.push({
        ...(jwk.kid ? { kid: jwk.kid } : {}),
        key: publicKey.export({ type: "spki", format: "der" }),
        alg: "ES256",
        publicKey,
      });
    } catch {
      /* skip a malformed entry rather than failing the whole keyset */
    }
  }
  return out;
}

/** Test injection. NEVER call from production code. */
export function _setProjectJwtKeysForTest(keys: VerificationKey[] | null): void {
  cached = keys;
  fetchInFlight = null;
}

/**
 * The header carrying the gateway-minted actor token.
 *
 * The runtime FORWARDS this rather than minting its own. Kept here beside the
 * keyset because the two are halves of one contract: the gateway signs both
 * the tokens this runtime verifies and the one it forwards, and the runtime
 * holds nothing that can produce either.
 */
export const DATA_PLANE_ACTOR_TOKEN_HEADER = "x-run402-actor-token";

/** Headers as the runtime context exposes them — a `Headers` instance when the
 *  entry wrapper passed a `Request`, otherwise a plain object. */
type HeadersLike =
  | { get(name: string): string | null }
  | Record<string, string | string[] | undefined>;

/** Read a header from either shape, case-insensitively. */
export function readHeader(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined;
  const h = headers as HeadersLike;
  if (typeof (h as { get?: unknown }).get === "function") {
    return (h as { get(n: string): string | null }).get(name) ?? undefined;
  }
  const rec = h as Record<string, string | string[] | undefined>;
  const raw = rec[name] ?? rec[name.toLowerCase()] ?? rec[name.toUpperCase()];
  return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * The gateway-minted actor bearer for this request, if present.
 *
 * Returns the `Authorization`-ready value. Absent for anonymous requests, and
 * absent on older gateways — callers must fall through to their previous
 * behaviour rather than failing, so a new runtime on an old gateway degrades
 * instead of breaking.
 */
export function forwardedActorAuthorization(headers: unknown): string | undefined {
  const token = readHeader(headers, DATA_PLANE_ACTOR_TOKEN_HEADER);
  return token ? `Bearer ${token}` : undefined;
}
