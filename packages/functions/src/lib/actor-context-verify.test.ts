import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import {
  ACTOR_CONTEXT_ENVELOPE_VERSION,
  ACTOR_CONTEXT_ENVELOPE_ISS,
  ACTOR_CONTEXT_ENVELOPE_AUD,
  ACTOR_CONTEXT_MAX_LIFETIME_SEC,
  verifyActorContextEnvelope,
  ensureActorContextKeysLoaded,
  _setActorContextKeyMapForTest,
  type VerifiedActorPayload,
} from "./actor-context-verify.js";

const KID = "ac-test-2026-05";
const SHARED_KEY = crypto.randomBytes(32);

beforeEach(() => {
  _setActorContextKeyMapForTest({ [KID]: SHARED_KEY });
});

const actor: VerifiedActorPayload = {
  id: "11111111-2222-3333-4444-555555555555",
  email: "user@example.com",
  emailVerified: true,
  authTime: 1779960000,
  amr: ["passkey"],
  amrTimes: { passkey: 1779960000 },
  authzVersion: 1,
};

function signEnvelope(opts: {
  kid?: string;
  iss?: string;
  aud?: string;
  iat?: number;
  exp?: number;
  projectId?: string;
  requestId?: string;
  method?: string;
  host?: string;
  path?: string;
  v?: number;
  actorOverride?: Partial<VerifiedActorPayload>;
  signWithKey?: Buffer;
}): string {
  const iat = opts.iat ?? Math.floor(Date.now() / 1000);
  const exp = opts.exp ?? iat + ACTOR_CONTEXT_MAX_LIFETIME_SEC;
  const env = {
    v: (opts.v ?? ACTOR_CONTEXT_ENVELOPE_VERSION) as 1,
    kid: opts.kid ?? KID,
    iss: opts.iss ?? ACTOR_CONTEXT_ENVELOPE_ISS,
    aud: opts.aud ?? ACTOR_CONTEXT_ENVELOPE_AUD,
    project_id: opts.projectId ?? "p_abc",
    request_id: opts.requestId ?? "trc_xyz",
    method: (opts.method ?? "GET").toUpperCase(),
    host: opts.host ?? "kychon.run402.app",
    path_hash: crypto.createHash("sha256").update(opts.path ?? "/forum").digest("hex"),
    iat,
    exp,
    actor: { ...actor, ...(opts.actorOverride ?? {}) },
  };
  const body = JSON.stringify(env);
  const key = opts.signWithKey ?? SHARED_KEY;
  const sig = crypto.createHmac("sha256", key).update(body).digest();
  return (
    Buffer.from(body).toString("base64url") +
    "." +
    sig.toString("base64url")
  );
}

const ctxFor = (overrides: Partial<Parameters<typeof verifyActorContextEnvelope>[1]> = {}) => ({
  projectId: "p_abc",
  requestId: "trc_xyz",
  method: "GET",
  host: "kychon.run402.app",
  path: "/forum",
  ...overrides,
});

describe("SDK actor-context verifier — happy path", () => {
  it("verifies a freshly-signed envelope and returns the actor", () => {
    const encoded = signEnvelope({});
    const r = verifyActorContextEnvelope(encoded, ctxFor());
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.envelope.actor.id, actor.id);
      assert.equal(r.envelope.actor.emailVerified, true);
      assert.deepEqual(r.envelope.actor.amrTimes, { passkey: 1779960000 });
    }
  });
});

describe("SDK actor-context verifier — failure modes (each maps to anonymous + spoof log)", () => {
  it("malformed encoding (no dot)", () => {
    const r = verifyActorContextEnvelope("nodot", ctxFor());
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "malformed");
  });

  it("non-base64url body half", () => {
    const r = verifyActorContextEnvelope("body!.sigb64", ctxFor());
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "malformed");
  });

  it("unknown kid", () => {
    _setActorContextKeyMapForTest({ "other-kid": SHARED_KEY });
    const encoded = signEnvelope({ kid: KID });
    const r = verifyActorContextEnvelope(encoded, ctxFor());
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "unknown_kid");
  });

  it("bad signature (signed with a different key under the same kid)", () => {
    const wrongKey = crypto.randomBytes(32);
    const encoded = signEnvelope({ signWithKey: wrongKey });
    const r = verifyActorContextEnvelope(encoded, ctxFor());
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "bad_signature");
  });

  it("iss mismatch", () => {
    const encoded = signEnvelope({ iss: "evil-gateway" });
    const r = verifyActorContextEnvelope(encoded, ctxFor());
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "iss_mismatch");
  });

  it("aud mismatch", () => {
    const encoded = signEnvelope({ aud: "some-other-audience" });
    const r = verifyActorContextEnvelope(encoded, ctxFor());
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "aud_mismatch");
  });

  it("expired envelope (exp <= now)", () => {
    const encoded = signEnvelope({ iat: 1, exp: 10 });
    const r = verifyActorContextEnvelope(encoded, ctxFor({ now: new Date(100 * 1000) }));
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "expired");
  });

  it("lifetime too long (exp - iat > 60)", () => {
    const iat = Math.floor(Date.now() / 1000);
    const encoded = signEnvelope({ iat, exp: iat + 3600 });
    const r = verifyActorContextEnvelope(encoded, ctxFor());
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "lifetime_too_long");
  });

  it("project_id mismatch", () => {
    const encoded = signEnvelope({ projectId: "p_signed" });
    const r = verifyActorContextEnvelope(encoded, ctxFor({ projectId: "p_other" }));
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "project_id_mismatch");
  });

  it("request_id mismatch (cross-request replay)", () => {
    const encoded = signEnvelope({ requestId: "trc_signed" });
    const r = verifyActorContextEnvelope(encoded, ctxFor({ requestId: "trc_other" }));
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "request_id_mismatch");
  });

  it("method mismatch (GET envelope replayed against POST)", () => {
    const encoded = signEnvelope({ method: "GET" });
    const r = verifyActorContextEnvelope(encoded, ctxFor({ method: "POST" }));
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "method_mismatch");
  });

  it("host mismatch (forum envelope replayed against admin)", () => {
    const encoded = signEnvelope({ host: "forum.run402.app" });
    const r = verifyActorContextEnvelope(encoded, ctxFor({ host: "admin.run402.app" }));
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "host_mismatch");
  });

  it("path mismatch (different route)", () => {
    const encoded = signEnvelope({ path: "/forum" });
    const r = verifyActorContextEnvelope(encoded, ctxFor({ path: "/admin/delete" }));
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "path_mismatch");
  });

  it("version mismatch (v: 2 not supported by this runtime)", () => {
    const encoded = signEnvelope({ v: 2 });
    const r = verifyActorContextEnvelope(encoded, ctxFor());
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "version_mismatch");
  });
});

describe("ensureActorContextKeysLoaded — gateway key fetch (auth-hosted-surface-parity)", () => {
  const origFetch = globalThis.fetch;
  const origBase = process.env.RUN402_API_BASE;
  const origKey = process.env.RUN402_SERVICE_KEY;

  function restore(): void {
    globalThis.fetch = origFetch;
    if (origBase === undefined) delete process.env.RUN402_API_BASE;
    else process.env.RUN402_API_BASE = origBase;
    if (origKey === undefined) delete process.env.RUN402_SERVICE_KEY;
    else process.env.RUN402_SERVICE_KEY = origKey;
    delete process.env.ACTOR_CONTEXT_SIGNING_KEY_MAP_JSON;
  }

  it("fetches the verify key from the gateway when env is empty, then verifies", async () => {
    _setActorContextKeyMapForTest(null); // no keys in memory
    delete process.env.ACTOR_CONTEXT_SIGNING_KEY_MAP_JSON; // none in env → fetch path
    process.env.RUN402_API_BASE = "https://api.run402.com";
    process.env.RUN402_SERVICE_KEY = "svc.jwt.token";
    let calledUrl = "";
    let calledAuth = "";
    globalThis.fetch = (async (url: string, init: { headers?: Record<string, string> }) => {
      calledUrl = String(url);
      calledAuth = init?.headers?.Authorization ?? "";
      return {
        ok: true,
        json: async () => ({ keys: { [KID]: SHARED_KEY.toString("base64") }, current_kid: KID }),
      };
    }) as unknown as typeof fetch;

    await ensureActorContextKeysLoaded();
    restore();

    assert.equal(calledUrl, "https://api.run402.com/internal/v1/actor-context-keys");
    assert.equal(calledAuth, "Bearer svc.jwt.token");
    // The fetched key now verifies a gateway-signed envelope end to end.
    const outcome = verifyActorContextEnvelope(signEnvelope({}), ctxFor());
    assert.equal(outcome.ok, true);
  });

  it("stays anonymous AND allows retry when the gateway fetch fails", async () => {
    _setActorContextKeyMapForTest(null);
    delete process.env.ACTOR_CONTEXT_SIGNING_KEY_MAP_JSON;
    process.env.RUN402_API_BASE = "https://api.run402.com";
    process.env.RUN402_SERVICE_KEY = "svc.jwt.token";
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return { ok: false, json: async () => ({}) };
    }) as unknown as typeof fetch;

    await ensureActorContextKeysLoaded();
    const outcome = verifyActorContextEnvelope(signEnvelope({}), ctxFor());
    assert.equal(outcome.ok, false); // unknown_kid → anonymous
    if (!outcome.ok) assert.equal(outcome.reason, "unknown_kid");
    // A failed fetch must clear the in-flight promise so the NEXT request retries
    // (rather than pinning the Lambda anonymous for its whole lifetime).
    await ensureActorContextKeysLoaded();
    restore();
    assert.equal(calls, 2, "failed fetch should be retried on the next call");
  });

  it("prefers env keys and does NOT fetch when the env is populated", async () => {
    _setActorContextKeyMapForTest(null);
    process.env.ACTOR_CONTEXT_SIGNING_KEY_MAP_JSON = JSON.stringify({
      [KID]: SHARED_KEY.toString("base64"),
    });
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return { ok: true, json: async () => ({ keys: {} }) };
    }) as unknown as typeof fetch;

    await ensureActorContextKeysLoaded();
    restore();
    assert.equal(calls, 0, "env keys present → no gateway fetch");
    assert.equal(verifyActorContextEnvelope(signEnvelope({}), ctxFor()).ok, true);
  });
});
