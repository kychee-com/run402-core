import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Mock config before importing db
mock.module("./config.js", {
  namedExports: {
    config: {
      API_BASE: "https://test.run402.com",
      PROJECT_ID: "prj_test",
      SERVICE_KEY: "sk_test",
      ANON_KEY: "anon_test",
      JWT_SECRET: "secret",
    },
  },
});

const { db, adminDb } = await import("./db.js");

function makeRequest(authorization?: string): Request {
  const headers: Record<string, string> = {};
  if (authorization) headers.authorization = authorization;
  return new Request("https://fn.localhost/", { method: "POST", headers });
}

describe("adminDb().from() — BYPASSRLS via /admin/v1/rest", () => {
  let lastFetchUrl: string;
  let lastFetchOpts: RequestInit;

  beforeEach(() => {
    lastFetchUrl = "";
    lastFetchOpts = {};
    mock.method(globalThis, "fetch", async (url: string, opts: RequestInit) => {
      lastFetchUrl = url;
      lastFetchOpts = opts;
      return new Response(JSON.stringify([{ id: 1 }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
  });

  it("posts to /admin/v1/rest/<table> with service_key in both apikey and Authorization", async () => {
    await adminDb().from("users").select();
    assert.equal(lastFetchUrl, "https://test.run402.com/admin/v1/rest/users?select=*");
    const headers = lastFetchOpts.headers as Record<string, string>;
    assert.equal(headers.apikey, "sk_test");
    assert.equal(headers.Authorization, "Bearer sk_test");
  });

  it("supports insert/update/delete", async () => {
    await adminDb().from("users").insert({ name: "Alice" });
    assert.equal(lastFetchOpts.method, "POST");
    assert.equal(lastFetchOpts.body, JSON.stringify([{ name: "Alice" }]));

    await adminDb().from("users").update({ name: "Bob" }).eq("id", 1);
    assert.equal(lastFetchOpts.method, "PATCH");

    await adminDb().from("users").delete().eq("id", 1);
    assert.equal(lastFetchOpts.method, "DELETE");
  });

  it("rejects on a non-retryable non-ok response", async () => {
    mock.method(globalThis, "fetch", async () =>
      new Response("nope", { status: 500 }),
    );
    await assert.rejects(
      async () => { await adminDb().from("users").select(); },
      (err: Error) => err.message.includes("PostgREST error (500)"),
    );
  });

  it("retries a schema-cache 404 (empty body) then resolves", async () => {
    // A freshly-created table 404s with an empty `{}` body until PostgREST
    // finishes reloading its schema cache. The client must ride that out.
    let calls = 0;
    mock.method(globalThis, "fetch", async () => {
      calls++;
      if (calls === 1) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify([{ id: 1 }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const rows = await adminDb().from("users").select();
    assert.equal(calls, 2);
    assert.deepEqual(rows, [{ id: 1 }]);
  });
});

describe("adminDb().sql() — SQL bypass", () => {
  it("posts to /projects/v1/admin/:project_id/sql with Bearer service_key", async () => {
    let capturedUrl = "";
    let capturedOpts: RequestInit = {};
    mock.method(globalThis, "fetch", async (url: string, opts: RequestInit) => {
      capturedUrl = url;
      capturedOpts = opts;
      return new Response(JSON.stringify([{ count: 5 }]), { status: 200 });
    });

    await adminDb().sql("SELECT * FROM users WHERE id = $1", ["abc"]);
    assert.equal(capturedUrl, "https://test.run402.com/projects/v1/admin/prj_test/sql");
    const headers = capturedOpts.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer sk_test");
    assert.equal(headers["Content-Type"], "application/json");
    assert.equal(
      capturedOpts.body,
      JSON.stringify({ sql: "SELECT * FROM users WHERE id = $1", params: ["abc"] }),
    );
  });

  it("sends SQL without params as text/plain", async () => {
    let capturedOpts: RequestInit = {};
    mock.method(globalThis, "fetch", async (_url: string, opts: RequestInit) => {
      capturedOpts = opts;
      return new Response(JSON.stringify([]), { status: 200 });
    });

    await adminDb().sql("SELECT count(*) FROM users");
    const headers = capturedOpts.headers as Record<string, string>;
    assert.equal(headers["Content-Type"], "text/plain");
    assert.equal(capturedOpts.body, "SELECT count(*) FROM users");
  });
});

describe("db(req).from() — caller-context on /rest/v1", () => {
  let lastFetchUrl: string;
  let lastFetchOpts: RequestInit;

  beforeEach(() => {
    lastFetchUrl = "";
    lastFetchOpts = {};
    mock.method(globalThis, "fetch", async (url: string, opts: RequestInit) => {
      lastFetchUrl = url;
      lastFetchOpts = opts;
      return new Response(JSON.stringify([{ id: 1 }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
  });

  it("forwards the caller's Authorization header to PostgREST", async () => {
    const req = makeRequest("Bearer alice_jwt");
    await db(req).from("workouts").select();
    assert.equal(lastFetchUrl, "https://test.run402.com/rest/v1/workouts?select=*");
    const headers = lastFetchOpts.headers as Record<string, string>;
    assert.equal(headers.apikey, "anon_test", "apikey is anon, NOT service_key");
    assert.equal(headers.Authorization, "Bearer alice_jwt", "Authorization is caller's, NOT service_key");
  });

  it("routes to /rest/v1 (NOT /admin/v1/rest)", async () => {
    const req = makeRequest("Bearer alice_jwt");
    await db(req).from("workouts").select();
    assert.ok(lastFetchUrl.startsWith("https://test.run402.com/rest/v1/"));
    assert.ok(!lastFetchUrl.includes("/admin/v1/rest"));
  });

  it("uses anon apikey without Authorization when caller was unauthenticated — PostgREST returns 401 for tables requiring auth", async () => {
    mock.method(globalThis, "fetch", async (_url: string, opts: RequestInit) => {
      lastFetchOpts = opts;
      return new Response("no policy", { status: 401 });
    });
    const req = makeRequest(); // no Authorization header
    await assert.rejects(
      async () => { await db(req).from("workouts").select(); },
      (err: Error) => err.message.includes("PostgREST error (401)"),
    );
    const headers = lastFetchOpts.headers as Record<string, string>;
    assert.equal(headers.apikey, "anon_test");
    assert.equal(headers.Authorization, undefined, "Authorization must NOT be set when caller had none");
  });

  it("handles mixed-case Authorization header name from incoming Request", async () => {
    // Node's Request normalizes header names to lowercase, but we assert
    // robustness to either spelling since user code might forward a
    // hand-built Request with capitalized header names.
    const req = new Request("https://fn.localhost/", {
      method: "POST",
      headers: { Authorization: "Bearer bob_jwt" },
    });
    await db(req).from("workouts").select();
    const headers = lastFetchOpts.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer bob_jwt");
  });
});

describe("legacy db.from / db.sql shim — REMOVED", () => {
  it("db.from is no longer attached to the db function (object access errors)", () => {
    // Guard against accidental reintroduction of the legacy admin shim.
    // db is a function, not an object — `db.from` and `db.sql` must NOT exist.
    const dbAny = db as unknown as Record<string, unknown>;
    assert.equal(typeof dbAny.from, "undefined", "db.from must not exist (use db(req).from or adminDb().from)");
    assert.equal(typeof dbAny.sql, "undefined", "db.sql must not exist (use adminDb().sql)");
  });
});

// Capability `astro-ssr-runtime` (v1.52). Verifies db() (no arg) reads
// the Authorization header from the active AsyncLocalStorage context.
describe("db() — ALS-context form (no explicit Request)", () => {
  let lastFetchOpts: RequestInit;

  beforeEach(() => {
    lastFetchOpts = {};
    mock.method(globalThis, "fetch", async (_url: string, opts: RequestInit) => {
      lastFetchOpts = opts;
      return new Response(JSON.stringify([{ id: 1 }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
  });

  it("reads Authorization from the active ALS context when no req is passed", async () => {
    const { runWithContext } = await import("./runtime-context.js");
    await runWithContext(
      {
        requestId: "req_test",
        projectId: "prj_test",
        releaseId: "rel_test",
        locale: "en",
        defaultLocale: "en",
        host: "test.run402.com",
        request: {
          method: "GET",
          url: "/the-guys",
          headers: { authorization: "Bearer alice_jwt" },
        },
      },
      async () => {
        await db().from("pages").select();
      },
    );
    const headers = lastFetchOpts.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer alice_jwt", "ALS-context Authorization must flow into the PostgREST call");
  });

  it("falls back to anon apikey when no req AND no ALS context exist", async () => {
    // Outside an ALS scope, db() with no arg sends without Authorization.
    // This is the v0.x behavior for unauthenticated calls.
    await db().from("pages").select();
    const headers = lastFetchOpts.headers as Record<string, string>;
    assert.equal(headers.apikey, "anon_test");
    assert.equal(headers.Authorization, undefined, "no Authorization when neither req nor ALS context present");
  });

  it("explicit req argument takes precedence over ALS context", async () => {
    const { runWithContext } = await import("./runtime-context.js");
    await runWithContext(
      {
        requestId: "req_test",
        projectId: "prj_test",
        releaseId: "rel_test",
        locale: "en",
        defaultLocale: "en",
        host: "test.run402.com",
        request: {
          method: "GET",
          url: "/the-guys",
          headers: { authorization: "Bearer ALS_TOKEN" },
        },
      },
      async () => {
        // explicit req with a DIFFERENT auth header should win
        const explicit = new Request("https://fn.localhost/", {
          method: "POST",
          headers: { Authorization: "Bearer EXPLICIT_TOKEN" },
        });
        await db(explicit).from("pages").select();
      },
    );
    const headers = lastFetchOpts.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer EXPLICIT_TOKEN", "explicit req wins over ALS");
  });
});

describe("db() actor-context propagation (auth-aware-ssr)", () => {
  let lastFetchUrl: string;
  let lastFetchOpts: RequestInit;

  beforeEach(() => {
    lastFetchUrl = "";
    lastFetchOpts = {};
    mock.method(globalThis, "fetch", async (url: string, opts: RequestInit) => {
      lastFetchUrl = url;
      lastFetchOpts = opts;
      return new Response(JSON.stringify([{ id: 1 }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
  });

  it("mints a short-lived JWT from the verified actor when no inbound Authorization", async () => {
    const { runWithContext } = await import("./runtime-context.js");
    const jwt = (await import("./lib/jwt.js")).default;

    await runWithContext(
      {
        requestId: "req_test",
        projectId: "prj_test",
        releaseId: "rel_test",
        locale: null,
        defaultLocale: null,
        host: "test.run402.com",
        request: {
          method: "GET",
          url: "/forum",
          headers: {}, // no Authorization
        },
        actor: {
          id: "user-uuid-1",
          email: "u@example.com",
          isTest: true,
          emailVerified: true,
          authTime: 1779960000,
          amr: ["passkey"],
          amrTimes: { passkey: 1779960000 },
          authzVersion: 7,
          sessionId: "sess-uuid-1",
        },
      },
      async () => {
        await db().from("topics").select();
      },
    );

    const headers = lastFetchOpts.headers as Record<string, string>;
    assert.match(headers.Authorization!, /^Bearer ey/, "minted JWT present");

    const claims = jwt.verify<{
      sub: string;
      role: string;
      project_id: string;
      session_id: string;
      authz_version: number;
      is_test?: boolean;
      amr: string[];
      aal: string;
      iat: number;
      exp: number;
    }>(headers.Authorization!.slice(7), "secret");

    assert.equal(claims.sub, "user-uuid-1");
    assert.equal(claims.role, "authenticated");
    assert.equal(claims.project_id, "prj_test");
    assert.equal(claims.session_id, "sess-uuid-1");
    assert.equal(claims.authz_version, 7);
    assert.equal(claims.is_test, true);
    assert.deepEqual(claims.amr, ["passkey"]);
    assert.equal(claims.aal, "aal2", "passkey AMR → aal2");
    // 60s TTL
    assert.equal(claims.exp - claims.iat, 60, "JWT lifetime is exactly 60s");
  });

  it("password-only actor minted JWT uses aal1", async () => {
    const { runWithContext } = await import("./runtime-context.js");
    const jwt = (await import("./lib/jwt.js")).default;
    await runWithContext(
      {
        requestId: "req_test",
        projectId: "prj_test",
        releaseId: "rel_test",
        locale: null,
        defaultLocale: null,
        host: "test.run402.com",
        request: { method: "GET", url: "/forum", headers: {} },
        actor: {
          id: "user-uuid-1",
          email: "u@example.com",
          emailVerified: true,
          authTime: 1779960000,
          amr: ["password"],
          amrTimes: { password: 1779960000 },
          authzVersion: 0,
          sessionId: "sess-uuid-1",
        },
      },
      async () => {
        await db().from("topics").select();
      },
    );
    const headers = lastFetchOpts.headers as Record<string, string>;
    const claims = jwt.verify<{ aal: string }>(headers.Authorization!.slice(7), "secret");
    assert.equal(claims.aal, "aal1");
  });

  it("does NOT mint a JWT when actor is null (anonymous request)", async () => {
    const { runWithContext } = await import("./runtime-context.js");
    await runWithContext(
      {
        requestId: "req_test",
        projectId: "prj_test",
        releaseId: "rel_test",
        locale: null,
        defaultLocale: null,
        host: "test.run402.com",
        request: { method: "GET", url: "/", headers: {} },
        actor: null,
      },
      async () => {
        await db().from("public").select();
      },
    );
    const headers = lastFetchOpts.headers as Record<string, string>;
    assert.equal(headers.Authorization, undefined, "anonymous → no Bearer");
    assert.equal(headers.apikey, "anon_test", "apikey is the anon key");
  });

  it("verified actor wins over inbound Authorization header (defense in depth)", async () => {
    // The actor is the runtime's VERIFIED state (envelope signed by the
    // gateway, verified by the SDK before exposing). If an inbound
    // Authorization header somehow disagrees, we mint from the actor —
    // forwarding an unverified header would let upstream confusion
    // overwrite the verified identity downstream.
    const { runWithContext } = await import("./runtime-context.js");
    const jwt = (await import("./lib/jwt.js")).default;
    await runWithContext(
      {
        requestId: "req_test",
        projectId: "prj_test",
        releaseId: "rel_test",
        locale: null,
        defaultLocale: null,
        host: "test.run402.com",
        request: {
          method: "GET",
          url: "/forum",
          headers: { authorization: "Bearer SOMEONE_ELSE" },
        },
        actor: {
          id: "verified-user-uuid",
          email: "u@example.com",
          emailVerified: true,
          authTime: 1779960000,
          amr: ["passkey"],
          amrTimes: { passkey: 1779960000 },
          authzVersion: 0,
          sessionId: "verified-sess",
        },
      },
      async () => {
        await db().from("topics").select();
      },
    );
    const headers = lastFetchOpts.headers as Record<string, string>;
    assert.match(headers.Authorization!, /^Bearer ey/, "minted JWT, NOT the inbound header");
    const claims = jwt.verify<{ sub: string; session_id: string }>(
      headers.Authorization!.slice(7),
      "secret",
    );
    assert.equal(claims.sub, "verified-user-uuid");
    assert.equal(claims.session_id, "verified-sess");
  });
});
