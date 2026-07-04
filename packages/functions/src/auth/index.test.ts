import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// auth.* Bearer-fallback path reads `config.JWT_SECRET` (which lazy-reads
// `process.env.RUN402_JWT_SECRET`). Set it before the SDK imports so the
// fallback tests can mint + decode JWTs.
process.env.RUN402_JWT_SECRET ??= "test-jwt-secret-32chars-minimum!!";
process.env.RUN402_PROJECT_ID ??= "p_test";
process.env.RUN402_ANON_KEY ??= "test-anon-key";
process.env.RUN402_SERVICE_KEY ??= "test-service-key";

import { auth, AuthRequiredError, FetchAbsoluteUrlError, FreshnessRequiredError, InsufficientRoleError, RoleGateNotConfiguredError, MembershipGateNotWiredError, UnknownExportError, InvalidCredentialsError, TenantSubjectInvalidError, RenamedExportError, MINT_DIRECTIVE_HEADER } from "./index.js";
import { runWithContext, type ActorContext } from "../runtime-context.js";

const sampleActor: ActorContext = {
  id: "11111111-2222-3333-4444-555555555555",
  email: "user@example.com",
  emailVerified: true,
  authTime: Math.floor(Date.now() / 1000) - 60,
  amr: ["passkey"],
  amrTimes: { passkey: Math.floor(Date.now() / 1000) - 60 },
  authzVersion: 0,
  sessionId: "trc_test_session",
};

function inContext<T>(opts: {
  actor?: ActorContext | null;
  headers?: Record<string, string | string[] | undefined>;
  url?: string;
  method?: string;
  invocationKind?: "routed_http" | "direct" | "scheduled" | "function_run";
}, fn: () => T | Promise<T>): T | Promise<T> {
  return runWithContext(
    {
      requestId: "trc_test",
      projectId: "p_test",
      releaseId: "r_test",
      locale: null,
      defaultLocale: null,
      host: "kychon.run402.app",
      request: {
        method: opts.method ?? "GET",
        url: opts.url ?? "/some/path",
        headers: opts.headers ?? {},
      },
      actor: opts.actor === undefined ? sampleActor : opts.actor,
      ...(opts.invocationKind ? { invocationKind: opts.invocationKind } : {}),
    },
    fn,
  );
}

describe("auth.user / auth.requireUser", () => {
  it("auth.user returns Actor with canonical `id` field (not `userId`)", async () => {
    const result = await inContext({}, async () => {
      const u = await auth.user();
      return u;
    });
    assert.ok(result);
    assert.equal(result!.id, sampleActor.id);
    assert.equal(result!.email, sampleActor.email);
    assert.equal(result!.is_test, undefined);
    // The legacy SDK shape `userId` MUST NOT be present — matches the
    // Supabase / Clerk / Auth.js convention agents are trained on.
    assert.equal((result as unknown as { userId?: string }).userId, undefined);
  });

  it("auth.user exposes is_test for tenant test-session actors", async () => {
    const result = await inContext(
      { actor: { ...sampleActor, isTest: true } },
      async () => auth.user(),
    );
    assert.ok(result);
    assert.equal(result!.is_test, true);
  });

  it("auth.user returns null when no actor in context", async () => {
    const result = await inContext({ actor: null }, async () => auth.user());
    assert.equal(result, null);
  });

  // Bearer JWT fallback (direct-function-invocation backward-compat).
  // The cookie-session path populates ctx.actor at runWithContext entry;
  // direct /functions/v1/<name> calls send a JWT in Authorization and
  // ctx.actor is null. auth.user() decodes the JWT in that case.
  it("auth.user falls back to JWT decode when no actor + Bearer header present", async () => {
    const jwt = (await import("../lib/jwt.js")).default;
    const token = jwt.sign(
      {
        sub: "bearer-user-uuid",
        role: "authenticated",
        email: "bearer@example.com",
        project_id: "p_test",
        auth_time: 1779960000,
        amr: ["password"],
        is_test: true,
      },
      "test-jwt-secret-32chars-minimum!!", // mocked config.JWT_SECRET above
    );
    const result = await inContext(
      {
        actor: null,
        headers: { authorization: `Bearer ${token}` },
      },
      async () => auth.user(),
    );
    assert.ok(result, "expected actor from Bearer JWT");
    assert.equal(result!.id, "bearer-user-uuid");
    assert.equal(result!.email, "bearer@example.com");
    assert.equal(result!.is_test, true);
    assert.deepEqual(result!.amr, ["password"]);
  });

  it("auth.user Bearer fallback rejects JWT for a different project", async () => {
    const jwt = (await import("../lib/jwt.js")).default;
    const token = jwt.sign(
      {
        sub: "bearer-user-uuid",
        role: "authenticated",
        project_id: "p_other", // wrong project
      },
      "test-jwt-secret-32chars-minimum!!",
    );
    const result = await inContext(
      {
        actor: null,
        headers: { authorization: `Bearer ${token}` },
      },
      async () => auth.user(),
    );
    assert.equal(result, null, "cross-project Bearer must NOT resolve to an actor");
  });

  it("auth.user Bearer fallback rejects malformed token", async () => {
    const result = await inContext(
      { actor: null, headers: { authorization: "Bearer not-a-jwt" } },
      async () => auth.user(),
    );
    assert.equal(result, null);
  });

  it("auth.user prefers ctx.actor over Bearer JWT (envelope wins)", async () => {
    const jwt = (await import("../lib/jwt.js")).default;
    const token = jwt.sign(
      { sub: "bearer-user", role: "authenticated", project_id: "p_test" },
      "test-jwt-secret-32chars-minimum!!",
    );
    const result = await inContext(
      { headers: { authorization: `Bearer ${token}` } }, // ctx.actor defaults to sampleActor
      async () => auth.user(),
    );
    assert.ok(result);
    // sampleActor.id wins; Bearer is ignored when envelope-derived actor is present
    assert.equal(result!.id, sampleActor.id);
  });

  // auth-hosted-surface-parity (Kychon finding): for routed_http (browser
  // SSR) the cookie envelope is the ONLY actor input — a Bearer header must
  // NOT resolve an actor. Direct/machine invocations keep the fallback.
  it("auth.user does NOT honor Bearer on routed_http (browser SSR) invocations", async () => {
    const jwt = (await import("../lib/jwt.js")).default;
    const token = jwt.sign(
      { sub: "bearer-user", role: "authenticated", project_id: "p_test" },
      "test-jwt-secret-32chars-minimum!!",
    );
    const result = await inContext(
      {
        actor: null, // no cookie envelope
        invocationKind: "routed_http", // browser SSR
        headers: { authorization: `Bearer ${token}` },
      },
      async () => auth.user(),
    );
    assert.equal(result, null, "Bearer must not resolve an actor on browser SSR");
  });

  it("auth.user DOES honor Bearer on direct invocations (machine contract preserved)", async () => {
    const jwt = (await import("../lib/jwt.js")).default;
    const token = jwt.sign(
      { sub: "bearer-user", role: "authenticated", project_id: "p_test" },
      "test-jwt-secret-32chars-minimum!!",
    );
    const result = await inContext(
      {
        actor: null,
        invocationKind: "direct", // machine / mobile / CI
        headers: { authorization: `Bearer ${token}` },
      },
      async () => auth.user(),
    );
    assert.ok(result, "Bearer must resolve an actor on direct invocations");
    assert.equal(result!.id, "bearer-user");
  });

  it("auth.requireUser throws AuthRequiredError when anonymous", async () => {
    await assert.rejects(
      () => inContext({ actor: null }, async () => auth.requireUser()),
      (err: unknown) => {
        assert.ok(err instanceof AuthRequiredError);
        assert.equal((err as AuthRequiredError).code, "R402_AUTH_REQUIRED");
        return true;
      },
    );
  });
});

describe("auth.requireRole", () => {
  it("succeeds when gate-resolved role matches", async () => {
    const r = await inContext(
      { headers: { "x-run402-user-role": "admin" } },
      async () => auth.requireRole("admin"),
    );
    assert.equal(r.role, "admin");
    assert.equal(r.user.id, sampleActor.id);
  });

  it("throws InsufficientRoleError when role mismatch", async () => {
    await assert.rejects(
      () =>
        inContext(
          { headers: { "x-run402-user-role": "member" } },
          async () => auth.requireRole("admin"),
        ),
      (err: unknown) => {
        assert.ok(err instanceof InsufficientRoleError);
        assert.equal((err as InsufficientRoleError).code, "R402_AUTH_INSUFFICIENT_ROLE");
        assert.equal((err as InsufficientRoleError).requiredRole, "admin");
        return true;
      },
    );
  });

  it("throws AuthRequiredError when anonymous (NOT InsufficientRoleError)", async () => {
    await assert.rejects(
      () => inContext({ actor: null }, async () => auth.requireRole("admin")),
      (err: unknown) => err instanceof AuthRequiredError,
    );
  });

  it("throws RoleGateNotConfiguredError (NOT InsufficientRoleError) when no role gate resolved the request", async () => {
    await assert.rejects(
      // Authenticated, but NO x-run402-user-role header → no requireRole gate ran.
      () => inContext({ headers: {} }, async () => auth.requireRole("operator")),
      (err: unknown) => {
        assert.ok(err instanceof RoleGateNotConfiguredError);
        assert.ok(!(err instanceof InsufficientRoleError));
        assert.equal((err as RoleGateNotConfiguredError).code, "R402_AUTH_ROLE_GATE_NOT_CONFIGURED");
        assert.equal((err as RoleGateNotConfiguredError).status, 500);
        assert.equal((err as RoleGateNotConfiguredError).requiredRole, "operator");
        return true;
      },
    );
  });

  it("config error vs authz denial are distinguishable (no header → 500, wrong role → 403)", async () => {
    // No gate → server-class config error.
    const noGate = await inContext({ headers: {} }, async () =>
      auth.requireRole("operator").then(() => null, (e) => e),
    );
    assert.equal((noGate as RoleGateNotConfiguredError).status, 500);
    // Gate ran, role disallowed → 403 authz denial.
    const wrongRole = await inContext({ headers: { "x-run402-user-role": "member" } }, async () =>
      auth.requireRole("operator").then(() => null, (e) => e),
    );
    assert.equal((wrongRole as InsufficientRoleError).status, 403);
  });
});

describe("auth.requireMembership (forward-only, not wired)", () => {
  it("throws MembershipGateNotWiredError (NOT InsufficientMembershipError) for any input", async () => {
    await assert.rejects(
      () => inContext({ headers: { "x-run402-user-membership": "pro" } }, async () => auth.requireMembership("pro")),
      (err: unknown) => {
        assert.ok(err instanceof MembershipGateNotWiredError);
        assert.equal((err as MembershipGateNotWiredError).code, "R402_AUTH_MEMBERSHIP_GATE_NOT_WIRED");
        assert.equal((err as MembershipGateNotWiredError).status, 501);
        assert.equal((err as MembershipGateNotWiredError).requiredMembership, "pro");
        return true;
      },
    );
  });

  it("requires auth first (anonymous → AuthRequiredError)", async () => {
    await assert.rejects(
      () => inContext({ actor: null }, async () => auth.requireMembership("pro")),
      (err: unknown) => err instanceof AuthRequiredError,
    );
  });

  it("is still an exported, callable helper (not removed)", () => {
    assert.equal(typeof auth.requireMembership, "function");
  });
});

describe("auth.role (non-throwing gate-resolved role read)", () => {
  it("returns the resolved role when a role gate ran", async () => {
    const r = await inContext(
      { headers: { "x-run402-user-role": "operator" } },
      async () => auth.role(),
    );
    assert.equal(r, "operator");
  });

  it("returns null when no role gate resolved the request (does NOT throw)", async () => {
    const r = await inContext({ headers: {} }, async () => auth.role());
    assert.equal(r, null);
  });

  it("lets multi-role code branch without re-asserting (admin vs operator both readable)", async () => {
    const asAdmin = await inContext(
      { headers: { "x-run402-user-role": "admin" } },
      async () => auth.role(),
    );
    const asOperator = await inContext(
      { headers: { "x-run402-user-role": "operator" } },
      async () => auth.role(),
    );
    assert.equal(asAdmin, "admin");
    assert.equal(asOperator, "operator");
  });
});

describe("auth.requireRole / auth.role with { from } (cookie-session SSR guard)", () => {
  const FROM = { table: "staff", idColumn: "user_id", roleColumn: "role" };
  let origFetch: typeof globalThis.fetch;
  beforeEach(() => {
    origFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
  });
  function mockRows(rows: Array<Record<string, unknown>>) {
    globalThis.fetch = (async () => ({ ok: true, json: async () => rows })) as unknown as typeof fetch;
  }

  it("requireRole({ from }) resolves the cookie-session operator from the tenant table", async () => {
    mockRows([{ role: "operator" }]);
    const r = await inContext({ actor: sampleActor }, async () =>
      auth.requireRole("operator", { from: FROM }),
    );
    assert.equal(r.role, "operator");
    assert.equal(r.user.id, sampleActor.id);
  });

  it("requireRole({ from }) throws InsufficientRoleError when the table role differs", async () => {
    mockRows([{ role: "member" }]);
    await assert.rejects(
      () => inContext({ actor: sampleActor }, async () => auth.requireRole("operator", { from: FROM })),
      (e: unknown) => e instanceof InsufficientRoleError,
    );
  });

  it("requireRole({ from }) throws InsufficientRoleError when the user has no row", async () => {
    mockRows([]);
    await assert.rejects(
      () => inContext({ actor: sampleActor }, async () => auth.requireRole("operator", { from: FROM })),
      (e: unknown) => e instanceof InsufficientRoleError,
    );
  });

  it("requireRole({ from }) throws AuthRequiredError when anonymous (cookie envelope absent)", async () => {
    await assert.rejects(
      () => inContext({ actor: null }, async () => auth.requireRole("operator", { from: FROM })),
      (e: unknown) => e instanceof AuthRequiredError,
    );
  });

  it("role({ from }) returns the role / null and never throws", async () => {
    mockRows([{ role: "operator" }]);
    assert.equal(await inContext({ actor: sampleActor }, async () => auth.role({ from: FROM })), "operator");
    mockRows([]);
    assert.equal(await inContext({ actor: sampleActor }, async () => auth.role({ from: FROM })), null);
    assert.equal(await inContext({ actor: null }, async () => auth.role({ from: FROM })), null);
  });

  it("rejects an invalid SQL identifier in { from }", async () => {
    await assert.rejects(
      () =>
        inContext({ actor: sampleActor }, async () =>
          auth.requireRole("operator", { from: { ...FROM, table: "bad-name" } }),
        ),
      (e: unknown) => e instanceof Error && /unquoted SQL identifier/.test((e as Error).message),
    );
  });
});

describe("auth.requireFresh (per-AMR semantics)", () => {
  it("passes when the named AMR method is fresh", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const actor: ActorContext = {
      ...sampleActor,
      amrTimes: { passkey: nowSec - 60 }, // 1m ago
    };
    await inContext({ actor }, async () => {
      await auth.requireFresh({ maxAge: "10m", amr: ["passkey"] });
    });
  });

  it("fails when the named method is stale even if another method is fresh", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const actor: ActorContext = {
      ...sampleActor,
      authTime: nowSec - 30, // flat auth_time is fresh (password just now)
      amrTimes: {
        passkey: nowSec - 86400, // passkey 1 day ago
        password: nowSec - 30, // password 30s ago
      },
    };
    await assert.rejects(
      () =>
        inContext({ actor }, async () =>
          auth.requireFresh({ maxAge: "10m", amr: ["passkey"] }),
        ),
      (err: unknown) => {
        assert.ok(err instanceof FreshnessRequiredError);
        return true;
      },
    );
  });

  it("uses flat authTime when amr filter omitted", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const actor: ActorContext = { ...sampleActor, authTime: nowSec - 30 };
    await inContext({ actor }, async () => {
      await auth.requireFresh({ maxAge: "1m" });
    });
  });
});

describe("auth.fetch URL validation", () => {
  // We don't actually issue network requests in these tests — validation
  // is synchronous BEFORE network I/O, so the throw fires regardless.
  it("relative URL passes validation", async () => {
    await inContext({}, async () => {
      // Catch the network failure (no server in test env) but assert that
      // validation passed (no FetchAbsoluteUrlError).
      try {
        await auth.fetch("/api/me");
      } catch (err) {
        assert.ok(
          !(err instanceof FetchAbsoluteUrlError),
          `validation should pass for relative URL; got: ${(err as Error).message}`,
        );
      }
    });
  });

  it("absolute cross-origin URL throws FetchAbsoluteUrlError synchronously", async () => {
    await assert.rejects(
      () => inContext({}, async () => auth.fetch("https://evil.example/api")),
      (err: unknown) => {
        assert.ok(err instanceof FetchAbsoluteUrlError);
        return true;
      },
    );
  });

  it("javascript: scheme throws FetchAbsoluteUrlError", async () => {
    await assert.rejects(
      () => inContext({}, async () => auth.fetch("javascript:alert(1)")),
      (err: unknown) => err instanceof FetchAbsoluteUrlError,
    );
  });

  it("data: scheme throws FetchAbsoluteUrlError", async () => {
    await assert.rejects(
      () => inContext({}, async () => auth.fetch("data:text/plain,hello")),
      (err: unknown) => err instanceof FetchAbsoluteUrlError,
    );
  });

  it("protocol-relative URL throws FetchAbsoluteUrlError", async () => {
    await assert.rejects(
      () => inContext({}, async () => auth.fetch("//evil.example/path")),
      (err: unknown) => err instanceof FetchAbsoluteUrlError,
    );
  });

  it("absolute URL with embedded credentials throws FetchAbsoluteUrlError", async () => {
    await assert.rejects(
      () =>
        inContext({}, async () =>
          auth.fetch("https://user:pass@kychon.run402.app/api"),
        ),
      (err: unknown) => err instanceof FetchAbsoluteUrlError,
    );
  });

  it("subdomain-spoof (host suffix collision) rejected", async () => {
    await assert.rejects(
      () =>
        inContext({}, async () =>
          auth.fetch("https://kychon.run402.app.evil.example/api"),
        ),
      (err: unknown) => err instanceof FetchAbsoluteUrlError,
    );
  });

  it("absolute same-origin URL passes (URL.origin matches)", async () => {
    await inContext({}, async () => {
      try {
        await auth.fetch("https://kychon.run402.app/api/me");
      } catch (err) {
        assert.ok(
          !(err instanceof FetchAbsoluteUrlError),
          `same-origin absolute URL should pass; got: ${(err as Error).message}`,
        );
      }
    });
  });
});

describe("auth.csrfToken / auth.csrfField", () => {
  it("returns a 32-char hex token for signed-in users", async () => {
    const token = await inContext({}, () => auth.csrfToken());
    assert.match(token, /^[0-9a-f]{32}$/);
  });

  it("csrfField wraps the token in an HTML input with the canonical name", async () => {
    const field = await inContext({}, () => auth.csrfField());
    assert.match(field, /^<input type="hidden" name="_csrf" value="[0-9a-f]{32}">$/);
  });

  it("throws AuthRequiredError when called anonymously", async () => {
    await assert.rejects(
      () => inContext({ actor: null }, async () => auth.csrfToken()),
      (err: unknown) => err instanceof AuthRequiredError,
    );
  });
});

describe("auth.* hallucinated-name proxy", () => {
  it("auth.protect throws UnknownExportError with canonical replacement", () => {
    assert.throws(
      () => (auth as unknown as { protect: () => void }).protect(),
      (err: unknown) => {
        assert.ok(err instanceof UnknownExportError);
        assert.equal((err as UnknownExportError).attemptedName, "auth.protect");
        assert.match((err as UnknownExportError).canonicalName, /requireUser|requireRole/);
        return true;
      },
    );
  });

  it("auth.signIn throws UnknownExportError pointing at the bridge", () => {
    assert.throws(
      () => (auth as unknown as { signIn: () => void }).signIn(),
      (err: unknown) => {
        assert.ok(err instanceof UnknownExportError);
        assert.match(
          (err as UnknownExportError).canonicalName,
          /createResponseFromIdentity|POST \/auth\/sign-in/,
        );
        return true;
      },
    );
  });

  it("auth.getUser (legacy name on the namespace) throws UnknownExportError", () => {
    assert.throws(
      () => (auth as unknown as { getUser: () => void }).getUser(),
      (err: unknown) => err instanceof UnknownExportError,
    );
  });

  it("auth.unknownMadeUpName throws with the canonical-fallback fix-it", () => {
    assert.throws(
      () => (auth as unknown as { unknownMadeUpName: () => void }).unknownMadeUpName(),
      (err: unknown) => {
        assert.ok(err instanceof UnknownExportError);
        assert.match(
          (err as UnknownExportError).canonicalName,
          /auth\.user|auth\.requireUser|auth\.requireRole/,
        );
        return true;
      },
    );
  });
});

describe("auth: throwing-sentinel ESM exports", () => {
  it("getSession throws UnknownExportError", async () => {
    const { getSession } = await import("./index.js");
    assert.throws(
      () => getSession(),
      (err: unknown) => err instanceof UnknownExportError,
    );
  });

  it("currentUser throws UnknownExportError", async () => {
    const { currentUser } = await import("./index.js");
    assert.throws(
      () => currentUser(),
      (err: unknown) => err instanceof UnknownExportError,
    );
  });

  it("getCurrentUser throws UnknownExportError", async () => {
    const { getCurrentUser } = await import("./index.js");
    assert.throws(
      () => getCurrentUser(),
      (err: unknown) => err instanceof UnknownExportError,
    );
  });
});

describe("auth.invalidCredentials (Section 5, D9)", () => {
  it("returns an InvalidCredentialsError carrying the canonical code", () => {
    const err = auth.invalidCredentials();
    assert.ok(err instanceof InvalidCredentialsError);
    assert.equal(err.code, "R402_AUTH_INVALID_CREDENTIALS");
    assert.equal(err.status, 401);
  });

  it("the constructor mistake `auth.InvalidCredentialsError` is steered to the function form", () => {
    assert.throws(
      () =>
        (auth as unknown as { InvalidCredentialsError: () => void }).InvalidCredentialsError(),
      (err: unknown) => {
        assert.ok(err instanceof UnknownExportError);
        assert.match(
          (err as UnknownExportError).canonicalName,
          /auth\.invalidCredentials\(\)/,
        );
        return true;
      },
    );
  });
});

describe("auth.sessions.createResponseFromTenantAssertion (Section 5, D6)", () => {
  const goodUser = { id: "u_42", email: "u42@example.com", emailVerified: true };

  it("emits a mint directive with caller-supplied {tenant,user,method} and NO platform-derived issuer/amr", async () => {
    const res = await inContext({ invocationKind: "routed_http" }, () =>
      auth.sessions.createResponseFromTenantAssertion({
        tenant: "kychon",
        user: goodUser,
        method: "password",
      }),
    );
    assert.ok(res instanceof Response);
    const encoded = res.headers.get(MINT_DIRECTIVE_HEADER);
    assert.ok(encoded, "expected the mint-directive header");
    const directive = JSON.parse(
      Buffer.from(encoded!, "base64url").toString("utf8"),
    ) as Record<string, unknown> & { user: Record<string, unknown> };
    assert.equal(directive.tenant, "kychon");
    assert.equal(directive.user.id, "u_42");
    assert.equal(directive.method, "password");
    // The platform derives issuer + amr at the gateway — the SDK MUST NOT.
    assert.equal(directive.issuer, undefined);
    assert.equal(directive.amr, undefined);
  });

  it("passes the advanced.amr override through to the directive", async () => {
    const res = await inContext({}, () =>
      auth.sessions.createResponseFromTenantAssertion({
        tenant: "kychon",
        user: goodUser,
        method: "sso",
        advanced: { amr: ["tenant_sso", "mfa"] },
      }),
    );
    const directive = JSON.parse(
      Buffer.from(res.headers.get(MINT_DIRECTIVE_HEADER)!, "base64url").toString("utf8"),
    ) as { advanced: { amr: string[] } };
    assert.deepEqual(directive.advanced.amr, ["tenant_sso", "mfa"]);
  });

  it("rejects a bare-email subject (email used as id) with TenantSubjectInvalidError", async () => {
    await assert.rejects(
      () =>
        inContext({}, () =>
          auth.sessions.createResponseFromTenantAssertion({
            tenant: "kychon",
            user: { id: "u42@example.com", email: "u42@example.com", emailVerified: true },
            method: "password",
          }),
        ),
      (err: unknown) => {
        assert.ok(err instanceof TenantSubjectInvalidError);
        assert.equal(
          (err as TenantSubjectInvalidError).code,
          "R402_AUTH_TENANT_SUBJECT_INVALID",
        );
        return true;
      },
    );
  });

  it("rejects a missing user.id", async () => {
    await assert.rejects(
      () =>
        inContext({}, () =>
          auth.sessions.createResponseFromTenantAssertion({
            tenant: "kychon",
            user: { email: "x@example.com", emailVerified: true } as never,
            method: "password",
          }),
        ),
      (err: unknown) => err instanceof TenantSubjectInvalidError,
    );
  });

  it("rejects an invalid method", async () => {
    await assert.rejects(
      () =>
        inContext({}, () =>
          auth.sessions.createResponseFromTenantAssertion({
            tenant: "kychon",
            user: goodUser,
            method: "magic" as never,
          }),
        ),
      (err: unknown) => err instanceof TenantSubjectInvalidError,
    );
  });

  it("forbidden legacy name auth.sessions.createResponseFromTenantSubject throws toward ...TenantAssertion", () => {
    assert.throws(
      () =>
        (
          auth.sessions as unknown as {
            createResponseFromTenantSubject: () => void;
          }
        ).createResponseFromTenantSubject(),
      (err: unknown) => {
        assert.ok(err instanceof UnknownExportError);
        assert.match(
          (err as UnknownExportError).canonicalName,
          /createResponseFromTenantAssertion/,
        );
        return true;
      },
    );
  });

  it("forbidden top-level name auth.signInResponse throws", () => {
    assert.throws(
      () => (auth as unknown as { signInResponse: () => void }).signInResponse(),
      (err: unknown) => {
        assert.ok(err instanceof UnknownExportError);
        assert.match(
          (err as UnknownExportError).canonicalName,
          /createResponseFromTenantAssertion|invalidCredentials/,
        );
        return true;
      },
    );
  });
});

async function withMockFetch<T>(
  handler: (url: string, init: RequestInit) => Response,
  fn: () => Promise<T>,
): Promise<T> {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) =>
    handler(String(url), init ?? {})) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = orig;
  }
}

describe("auth.account.getSecurity / requireSecurity (Section 4.3)", () => {
  const projection = {
    user: { id: "route-projection-ignored", email: "ignored@example.com" },
    has_run402_password: true,
    run402_passkey_count: 2,
    has_run402_passkey_for_current_rp: true,
    run402_identities: [
      { provider: "google", provider_sub: "g1", provider_email: "u@example.com", created_at: "2026-01-01T00:00:00Z" },
    ],
    current_rp_id: "kychon.run402.app",
    passkey_rp_scope: "host",
    tenant_assertions: [{ issuer: "tenant:kychon", last_amr: ["tenant_password"] }],
  };

  it("returns the projection overlaid with the ctx actor (not the route's user echo)", async () => {
    const result = await inContext({}, () =>
      withMockFetch(
        () => new Response(JSON.stringify(projection), { status: 200 }),
        () => auth.account.getSecurity(),
      ),
    );
    assert.ok(result);
    assert.equal(result!.user.id, sampleActor.id);
    assert.equal(result!.has_run402_password, true);
    assert.equal(result!.run402_passkey_count, 2);
    assert.equal(result!.passkey_rp_scope, "host");
    assert.deepEqual(result!.tenant_assertions, [
      { issuer: "tenant:kychon", last_amr: ["tenant_password"] },
    ]);
  });

  it("sends apikey + an actor Bearer to /auth/v1/account/security", async () => {
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};
    await inContext({}, () =>
      withMockFetch(
        (url, init) => {
          seenUrl = url;
          seenHeaders = (init.headers ?? {}) as Record<string, string>;
          return new Response(JSON.stringify(projection), { status: 200 });
        },
        () => auth.account.getSecurity(),
      ),
    );
    assert.match(seenUrl, /\/auth\/v1\/account\/security\?app_origin=/);
    assert.ok(seenHeaders.apikey, "expected apikey header");
    assert.match(seenHeaders.authorization, /^Bearer /);
  });

  it("returns null when anonymous (no actor)", async () => {
    const result = await inContext({ actor: null }, () => auth.account.getSecurity());
    assert.equal(result, null);
  });

  it("returns null when the route returns 401", async () => {
    const result = await inContext({}, () =>
      withMockFetch(
        () => new Response("nope", { status: 401 }),
        () => auth.account.getSecurity(),
      ),
    );
    assert.equal(result, null);
  });

  it("requireSecurity throws AuthRequiredError when anonymous", async () => {
    await assert.rejects(
      () => inContext({ actor: null }, () => auth.account.requireSecurity()),
      (err: unknown) => err instanceof AuthRequiredError,
    );
  });

  it("auth.account.get (shipped throwing name) throws UnknownExportError", () => {
    assert.throws(
      () => (auth.account as unknown as { get: () => void }).get(),
      (err: unknown) => {
        assert.ok(err instanceof UnknownExportError);
        assert.match((err as UnknownExportError).canonicalName, /getSecurity/);
        return true;
      },
    );
  });
});

describe("auth.* under streaming SSR body-drain (issue #436)", () => {
  // Reproduce the gateway's render-then-drain split: a streaming render returns
  // a Response whose body is a `highWaterMark: 0` ReadableStream. The "child
  // component" calls auth.* lazily — only when the body is pulled — rather than
  // wrapping the call directly in `als.run`. The gateway's buildEntryWrapper
  // must materialize that body INSIDE the request context (the fix); a child
  // component reading auth.* during the streamed drain MUST resolve the actor.
  const projection = {
    user: { id: "route-projection-ignored", email: "ignored@example.com" },
    has_run402_password: true,
    run402_passkey_count: 1,
    has_run402_passkey_for_current_rp: true,
    run402_identities: [],
    current_rp_id: "kychon.run402.app",
    passkey_rp_scope: "host" as const,
    tenant_assertions: [],
  };

  function streamingRender(): Response {
    const stream = new ReadableStream(
      {
        async pull(controller) {
          // Child-component frontmatter — renders lazily during the drain.
          const u = await auth.user();
          const sec = await auth.account.getSecurity();
          controller.enqueue(
            new TextEncoder().encode(
              JSON.stringify({
                userId: u?.id ?? null,
                securityUserId: sec?.user.id ?? null,
              }),
            ),
          );
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    return new Response(stream);
  }

  it("resolves auth.user() and auth.account.getSecurity() when the body is drained INSIDE the context", async () => {
    const decoded = await inContext({}, () =>
      withMockFetch(
        () => new Response(JSON.stringify(projection), { status: 200 }),
        async () => {
          // The fixed buildEntryWrapper drains the body inside the
          // runWithContext callback — reproduce that boundary here.
          const res = streamingRender();
          const bytes = Buffer.from(await res.arrayBuffer());
          return JSON.parse(bytes.toString("utf-8")) as {
            userId: string | null;
            securityUserId: string | null;
          };
        },
      ),
    );
    assert.equal(
      decoded.userId,
      sampleActor.id,
      "auth.user() must resolve during the streamed child render",
    );
    assert.equal(
      decoded.securityUserId,
      sampleActor.id,
      "auth.account.getSecurity() must resolve during the streamed child render",
    );
  });

  it("characterizes the #436 bug: auth.* is null when the streamed body is drained AFTER the context exits", async () => {
    // render() runs inside the context, but the body is pulled outside it —
    // the pre-fix buildEntryWrapper shape (drain after runWithContext returns).
    // No fetch mock needed: getSecurity() returns null at its `if (!ctx)` guard
    // before reaching the gateway round-trip.
    const res = await inContext({}, () => streamingRender());
    const bytes = Buffer.from(await res.arrayBuffer()); // drained OUTSIDE the context
    const decoded = JSON.parse(bytes.toString("utf-8")) as {
      userId: string | null;
      securityUserId: string | null;
    };
    assert.equal(
      decoded.userId,
      null,
      "drained-after-context render sees no actor — the silent-degrade bug",
    );
    assert.equal(decoded.securityUserId, null);
  });
});

describe("auth.identities.link renamed → startLink (Section 4.5)", () => {
  it("throws RenamedExportError pointing at auth.account.identities.startLink", async () => {
    await assert.rejects(
      () =>
        inContext({}, () =>
          auth.identities.link({
            provider: "google",
            subject: "g1",
            proof: { kind: "custom", payload: {} },
          }),
        ),
      (err: unknown) => {
        assert.ok(err instanceof RenamedExportError);
        assert.equal((err as RenamedExportError).code, "R402_AUTH_RENAMED_EXPORT");
        assert.match((err as RenamedExportError).newName, /startLink/);
        return true;
      },
    );
  });
});

describe("auth.account advanced tier (§4.4 / §7.7)", () => {
  // sampleActor.authTime is now-60s → fresh (within the 5-min window) for the
  // happy paths; the gateway re-checks via the minted JWT's auth_time claim.

  it("setPassword POSTs new_password with an actor Bearer carrying auth_time", async () => {
    let seenUrl = "";
    let seenBody = "";
    let seenAuth = "";
    await inContext({}, () =>
      withMockFetch(
        (url, init) => {
          seenUrl = url;
          seenBody = String((init as { body?: unknown }).body ?? "");
          seenAuth = ((init as { headers?: Record<string, string> }).headers ?? {}).authorization ?? "";
          return new Response(JSON.stringify({ ok: true, sessions_revoked: 3 }), { status: 200 });
        },
        () => auth.account.setPassword("new-strong-password"),
      ),
    );
    assert.match(seenUrl, /\/auth\/v1\/account\/password$/);
    assert.match(seenBody, /new-strong-password/);
    assert.match(seenAuth, /^Bearer /);
    const payloadSeg = seenAuth.slice("Bearer ".length).split(".")[1] ?? "";
    const payload = JSON.parse(Buffer.from(payloadSeg, "base64url").toString("utf8")) as {
      auth_time?: number;
    };
    assert.equal(typeof payload.auth_time, "number");
  });

  it("setPassword throws FreshnessRequiredError on 401 R402_AUTH_FRESHNESS_REQUIRED (§7.7)", async () => {
    await assert.rejects(
      () =>
        inContext({}, () =>
          withMockFetch(
            () =>
              new Response(JSON.stringify({ code: "R402_AUTH_FRESHNESS_REQUIRED" }), { status: 401 }),
            () => auth.account.setPassword("x"),
          ),
        ),
      (err: unknown) => err instanceof FreshnessRequiredError,
    );
  });

  it("signOutEverywhere POSTs sign-out-everywhere and returns revoked_count (§7.7)", async () => {
    const out = await inContext({}, () =>
      withMockFetch(
        (url) => {
          assert.match(url, /sign-out-everywhere$/);
          return new Response(JSON.stringify({ ok: true, revoked_count: 5 }), { status: 200 });
        },
        () => auth.account.signOutEverywhere(),
      ),
    );
    assert.equal(out.revoked_count, 5);
  });

  it("passkeys.remove POSTs, passkeys.list GETs, passkeys.add throws (browser ceremony)", async () => {
    await inContext({}, () =>
      withMockFetch(
        (url, init) => {
          assert.match(url, /passkeys\/remove$/);
          assert.equal((init as { method?: string }).method, "POST");
          return new Response(JSON.stringify({ ok: true, removed: true }), { status: 200 });
        },
        () => auth.account.passkeys.remove("pk_1"),
      ),
    );
    const list = await inContext({}, () =>
      withMockFetch(
        (url) => {
          assert.match(url, /\/account\/passkeys$/);
          return new Response(JSON.stringify({ passkeys: [{ id: "pk_1" }] }), { status: 200 });
        },
        () => auth.account.passkeys.list(),
      ),
    );
    assert.equal(list.length, 1);
    assert.throws(() => auth.account.passkeys.add(), /browser WebAuthn ceremony/);
  });

  it("identities.unlink POSTs provider+subject; sessions.revoke POSTs session_id", async () => {
    await inContext({}, () =>
      withMockFetch(
        (url, init) => {
          assert.match(url, /identities\/unlink$/);
          assert.match(String((init as { body?: unknown }).body), /google/);
          return new Response(JSON.stringify({ ok: true, unlinked: true }), { status: 200 });
        },
        () => auth.account.identities.unlink({ provider: "google", subject: "g1" }),
      ),
    );
    await inContext({}, () =>
      withMockFetch(
        (url, init) => {
          assert.match(url, /sessions\/revoke$/);
          assert.match(String((init as { body?: unknown }).body), /sess_1/);
          return new Response(JSON.stringify({ ok: true, revoked: true }), { status: 200 });
        },
        () => auth.account.sessions.revoke("sess_1"),
      ),
    );
  });

  it("identities.startLink POSTs intent:link to the provider oauth start route and returns the URL (§4.5)", async () => {
    let seenUrl = "";
    let seenBody = "";
    const out = await inContext({}, () =>
      withMockFetch(
        (url, init) => {
          seenUrl = url;
          seenBody = String((init as { body?: unknown }).body ?? "");
          return new Response(
            JSON.stringify({
              provider: "google",
              authorization_url: "https://accounts.google.com/o/oauth2/v2/auth?state=abc",
              expires_in: 600,
            }),
            { status: 200 },
          );
        },
        () =>
          auth.account.identities.startLink({
            provider: "google",
            redirectUrl: "https://app.example.com/account",
          }),
      ),
    );
    // link-to-existing-account ceremony hits the provider's oauth start route
    // (NOT an /account/* route), carrying intent:"link" + the app redirect.
    assert.match(seenUrl, /\/auth\/v1\/oauth\/google\/start$/);
    assert.match(seenBody, /"intent":"link"/);
    assert.match(seenBody, /app\.example\.com/);
    assert.equal(out.authorizationUrl, "https://accounts.google.com/o/oauth2/v2/auth?state=abc");
    assert.equal(out.expiresIn, 600);
  });

  it("identities.startLink throws synchronously on a missing redirectUrl (§4.5)", async () => {
    await assert.rejects(
      () =>
        inContext({}, () =>
          auth.account.identities.startLink({ provider: "google", redirectUrl: "" }),
        ),
      /redirectUrl is required/,
    );
  });

  it("advanced methods throw AuthRequiredError when anonymous", async () => {
    await assert.rejects(
      () => inContext({ actor: null }, () => auth.account.setPassword("x")),
      (err: unknown) => err instanceof AuthRequiredError,
    );
  });
});
