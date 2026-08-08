/**
 * The cold-start project-JWT keyset fetch.
 *
 * The properties that matter: the runtime ends up holding ONLY public keys
 * (anything symmetric served by a compromised or misconfigured gateway must be
 * ignored, not trusted), the fetch happens once per execution environment, and
 * a missing keyset fails CLOSED rather than silently authenticating.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createPrivateKey } from "node:crypto";

import {
  ensureProjectJwtKeysLoaded,
  projectJwtVerificationKeys,
  projectJwtKeysUnavailable,
  forwardedActorAuthorization,
  readHeader,
  _setProjectJwtKeysForTest,
} from "./project-jwt-keys.js";
import { sign, verifyWithKey } from "./jwt.js";

const realFetch = globalThis.fetch;
let savedEnv: Record<string, string | undefined> = {};
let served: unknown = { keys: [] };
let fetchCalls = 0;
let lastAuthHeader: string | undefined;
let responseOk = true;

function ecPair() {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = privateKey.export({ format: "jwk" }) as Record<string, string>;
  return { jwk, privateKey };
}

beforeEach(() => {
  savedEnv = {
    RUN402_API_BASE: process.env.RUN402_API_BASE,
    RUN402_SERVICE_KEY: process.env.RUN402_SERVICE_KEY,
    RUN402_JWT_SECRET: process.env.RUN402_JWT_SECRET,
  };
  process.env.RUN402_API_BASE = "https://api.example.test";
  process.env.RUN402_SERVICE_KEY = "svc-key";
  delete process.env.RUN402_JWT_SECRET;
  fetchCalls = 0;
  lastAuthHeader = undefined;
  responseOk = true;
  served = { keys: [] };
  _setProjectJwtKeysForTest(null);
  globalThis.fetch = (async (_url: string, init?: { headers?: Record<string, string> }) => {
    fetchCalls++;
    lastAuthHeader = init?.headers?.Authorization;
    return {
      ok: responseOk,
      json: async () => served,
    } as unknown as Response;
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  _setProjectJwtKeysForTest(null);
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("project JWT keyset — the runtime holds nothing that can sign", () => {
  it("accepts EC P-256 public keys and can verify a gateway-signed token with them", async () => {
    const { jwk, privateKey } = ecPair();
    served = { keys: [{ kty: "EC", crv: "P-256", alg: "ES256", x: jwk.x, y: jwk.y, kid: "p1" }] };
    await ensureProjectJwtKeysLoaded();

    const keys = projectJwtVerificationKeys();
    assert.equal(keys.length, 1);
    assert.equal(keys[0].alg, "ES256");
    assert.equal(keys[0].kid, "p1");
    assert.equal(keys[0].privateKey, undefined, "no private material may be held");

    const token = sign({ sub: "u1" }, privateKey, { algorithm: "ES256", kid: "p1" });
    const { payload, kid } = verifyWithKey(token, keys, { algorithms: ["ES256"] });
    assert.equal(kid, "p1");
    assert.equal((payload as { sub?: string }).sub, "u1");
  });

  it("IGNORES a symmetric key even if the gateway serves one", async () => {
    // Defence against the exact regression this change exists to prevent: an
    // `oct` key here would restore the ability to forge, over HTTP instead of
    // via env. Trusting only the promised shape means a gateway bug or a
    // compromised response cannot reintroduce it.
    served = {
      keys: [
        { kty: "oct", k: Buffer.from("a".repeat(40)).toString("base64url"), alg: "HS256", kid: "k0" },
        { kty: "RSA", n: "x", e: "AQAB", kid: "r1" },
      ],
    };
    await ensureProjectJwtKeysLoaded();
    assert.deepEqual(projectJwtVerificationKeys(), []);
  });

  it("skips a malformed EC entry without discarding the rest of the keyset", async () => {
    const { jwk } = ecPair();
    served = {
      keys: [
        { kty: "EC", crv: "P-256", alg: "ES256", x: "not-a-point", y: "nope", kid: "bad" },
        { kty: "EC", crv: "P-256", alg: "ES256", x: jwk.x, y: jwk.y, kid: "good" },
      ],
    };
    await ensureProjectJwtKeysLoaded();
    assert.deepEqual(projectJwtVerificationKeys().map((k) => k.kid), ["good"]);
  });
});

describe("project JWT keyset — fetch discipline", () => {
  it("fetches once per execution environment and reuses the cache", async () => {
    const { jwk } = ecPair();
    served = { keys: [{ kty: "EC", crv: "P-256", alg: "ES256", x: jwk.x, y: jwk.y, kid: "p1" }] };
    await ensureProjectJwtKeysLoaded();
    await ensureProjectJwtKeysLoaded();
    await ensureProjectJwtKeysLoaded();
    assert.equal(fetchCalls, 1, "a warm environment must not re-fetch");
  });

  it("single-flights concurrent cold starts", async () => {
    const { jwk } = ecPair();
    served = { keys: [{ kty: "EC", crv: "P-256", alg: "ES256", x: jwk.x, y: jwk.y, kid: "p1" }] };
    await Promise.all([
      ensureProjectJwtKeysLoaded(),
      ensureProjectJwtKeysLoaded(),
      ensureProjectJwtKeysLoaded(),
    ]);
    assert.equal(fetchCalls, 1);
  });

  it("authenticates with the project service key", async () => {
    await ensureProjectJwtKeysLoaded();
    assert.equal(lastAuthHeader, "Bearer svc-key");
  });

  it("never throws on a failed fetch, and retries on the next request", async () => {
    responseOk = false;
    await ensureProjectJwtKeysLoaded();
    assert.deepEqual(projectJwtVerificationKeys(), []);
    const { jwk } = ecPair();
    responseOk = true;
    served = { keys: [{ kty: "EC", crv: "P-256", alg: "ES256", x: jwk.x, y: jwk.y, kid: "p1" }] };
    await ensureProjectJwtKeysLoaded();
    assert.equal(projectJwtVerificationKeys().length, 1, "a later request recovers");
  });

  it("does not attempt a fetch without a service key", async () => {
    delete process.env.RUN402_SERVICE_KEY;
    await ensureProjectJwtKeysLoaded();
    assert.equal(fetchCalls, 0);
  });
});

describe("project JWT keyset — fail closed, and the transition fallback", () => {
  it("reports unavailable when there is no key at all", async () => {
    responseOk = false;
    await ensureProjectJwtKeysLoaded();
    assert.equal(projectJwtKeysUnavailable(), true);
  });

  it("IGNORES the env-injected key entirely — the fallback is gone", async () => {
    // REVERSAL, and deliberate. This used to assert the opposite: that
    // `RUN402_JWT_SECRET` was kept as a kid-less legacy verifier. That was
    // load-bearing for exactly one window — after the fleet carried this
    // runtime but before the gateway's signing key was asymmetric, the gateway
    // was still minting HS256 tokens an asymmetric-only keyset cannot verify.
    //
    // The window closed: the gateway signs ES256/p1-2026-08, and §8 stopped
    // injecting the env key AND swept it out of the fleet, so this code path
    // had already stopped firing in production before it was deleted.
    const legacySecret = "legacy-env-secret-at-least-32-bytes-long!!";
    process.env.RUN402_JWT_SECRET = legacySecret;
    responseOk = false;
    await ensureProjectJwtKeysLoaded();

    // The env var is set and still contributes NOTHING.
    assert.deepEqual(projectJwtVerificationKeys(), []);
    assert.equal(
      projectJwtKeysUnavailable(),
      true,
      "with no fetched keyset there is nothing to verify against; getUser() must fail closed " +
        "rather than fall back to material the tenant's own environment can supply",
    );
  });

  it("verifies ONLY against the fetched keyset, even when the env key would match", async () => {
    const { jwk, privateKey } = ecPair();
    const legacySecret = "legacy-env-secret-at-least-32-bytes-long!!";
    process.env.RUN402_JWT_SECRET = legacySecret;
    served = { keys: [{ kty: "EC", crv: "P-256", alg: "ES256", x: jwk.x, y: jwk.y, kid: "p1" }] };
    await ensureProjectJwtKeysLoaded();

    const keys = projectJwtVerificationKeys();
    assert.equal(keys.length, 1, "the fetched keyset is the entire set");
    assert.equal(keys[0].kid, "p1");

    // A token the gateway signs today still verifies.
    const modern = sign({ sub: "new" }, privateKey, { algorithm: "ES256", kid: "p1" });
    assert.equal(
      (verifyWithKey(modern, keys, { algorithms: ["ES256"] }).payload as { sub?: string }).sub,
      "new",
    );

    // A token signed with the env secret does NOT. This is the security half:
    // a tenant that sets RUN402_JWT_SECRET in its own project cannot thereby
    // mint identities its own `auth.user()` will accept.
    const forged = sign({ sub: "old" }, Buffer.from(legacySecret, "utf8"));
    assert.throws(() => verifyWithKey(forged, keys));
  });

  it("rejects a token whose kid is in neither set", async () => {
    const { jwk } = ecPair();
    served = { keys: [{ kty: "EC", crv: "P-256", alg: "ES256", x: jwk.x, y: jwk.y, kid: "p1" }] };
    await ensureProjectJwtKeysLoaded();
    const other = ecPair();
    const token = sign({ sub: "x" }, other.privateKey, { algorithm: "ES256", kid: "unknown" });
    assert.throws(() =>
      verifyWithKey(token, projectJwtVerificationKeys(), { algorithms: ["ES256"] }),
    );
  });
});

describe("forwarded actor token", () => {
  it("reads the header from a plain object and from a Headers instance", () => {
    assert.equal(
      forwardedActorAuthorization({ "x-run402-actor-token": "T" }),
      "Bearer T",
    );
    assert.equal(
      forwardedActorAuthorization(new Headers({ "x-run402-actor-token": "T" })),
      "Bearer T",
    );
  });

  it("is undefined when absent, so callers fall through instead of failing", () => {
    // An older gateway does not send it; a new runtime must degrade, not break.
    assert.equal(forwardedActorAuthorization({}), undefined);
    assert.equal(forwardedActorAuthorization(undefined), undefined);
  });

  it("reads headers case-insensitively", () => {
    assert.equal(readHeader({ "X-Run402-Actor-Token": "T" }, "x-run402-actor-token"), undefined);
    assert.equal(readHeader(new Headers({ "X-Run402-Actor-Token": "T" }), "x-run402-actor-token"), "T");
  });
});
