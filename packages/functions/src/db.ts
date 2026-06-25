import { config } from "./config.js";
import { getCurrentContext } from "./runtime-context.js";
import jwt from "./lib/jwt.js";

interface QueryBuilderOpts {
  apikey: string;
  authorization: string | undefined;
  basePath: string;
}

export class QueryBuilder {
  #table: string;
  #params = new URLSearchParams();
  #method = "GET";
  #body: unknown = undefined;
  #apikey: string;
  #authorization: string | undefined;
  #basePath: string;

  constructor(table: string, opts: QueryBuilderOpts) {
    this.#table = table;
    this.#apikey = opts.apikey;
    this.#authorization = opts.authorization;
    this.#basePath = opts.basePath;
  }

  select(columns = "*"): this {
    this.#params.set("select", columns);
    return this;
  }

  eq(column: string, value: string | number): this {
    this.#params.append(column, `eq.${value}`);
    return this;
  }

  neq(column: string, value: string | number): this {
    this.#params.append(column, `neq.${value}`);
    return this;
  }

  gt(column: string, value: string | number): this {
    this.#params.append(column, `gt.${value}`);
    return this;
  }

  lt(column: string, value: string | number): this {
    this.#params.append(column, `lt.${value}`);
    return this;
  }

  gte(column: string, value: string | number): this {
    this.#params.append(column, `gte.${value}`);
    return this;
  }

  lte(column: string, value: string | number): this {
    this.#params.append(column, `lte.${value}`);
    return this;
  }

  like(column: string, pattern: string): this {
    this.#params.append(column, `like.${pattern}`);
    return this;
  }

  ilike(column: string, pattern: string): this {
    this.#params.append(column, `ilike.${pattern}`);
    return this;
  }

  in(column: string, values: (string | number)[]): this {
    this.#params.append(column, `in.(${values.join(",")})`);
    return this;
  }

  order(column: string, { ascending = true } = {}): this {
    this.#params.append("order", `${column}.${ascending ? "asc" : "desc"}`);
    return this;
  }

  limit(count: number): this {
    this.#params.set("limit", String(count));
    return this;
  }

  offset(count: number): this {
    this.#params.set("offset", String(count));
    return this;
  }

  insert(data: Record<string, unknown> | Record<string, unknown>[]): this {
    this.#method = "POST";
    this.#body = Array.isArray(data) ? data : [data];
    return this;
  }

  update(data: Record<string, unknown>): this {
    this.#method = "PATCH";
    this.#body = data;
    return this;
  }

  delete(): this {
    this.#method = "DELETE";
    return this;
  }

  then(
    resolve: (value: Record<string, unknown>[]) => void,
    reject: (reason: Error) => void,
  ): void {
    this.#execute().then(resolve, reject);
  }

  // Execute the request, retrying on a PostgREST schema-cache reload race.
  //
  // After a deploy/expose, a freshly created table 404s (often with an empty
  // `{}` body — NOT the usual PGRST205 object) until PostgREST finishes
  // reloading its schema cache. PostgREST reloads the WHOLE cache on any DDL,
  // which under production load can take longer than the gateway's own ~6s
  // retry budget, so the 404 reaches the client and a first write right after a
  // deploy would otherwise fail spuriously. Retry on STATUS (404/503, or 400 +
  // PGRST204/PGRST205) — NOT on body text, which can be empty — mirroring the
  // gateway's isSchemaCacheError contract. A lost-race 404 means the statement
  // never ran, so retrying a write is safe; a genuinely-missing table still
  // surfaces as a 404 once the deadline passes.
  async #execute(): Promise<Record<string, unknown>[]> {
    const qs = this.#params.toString();
    const url = `${config.API_BASE}${this.#basePath}/${this.#table}${qs ? "?" + qs : ""}`;

    const headers: Record<string, string> = {
      apikey: this.#apikey,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    };
    if (this.#authorization) {
      headers.Authorization = this.#authorization;
    }
    const body = this.#body ? JSON.stringify(this.#body) : undefined;

    // Reload windows can exceed the gateway's ~6s budget; ride them out, but
    // bound it so a genuinely-missing table still errors in reasonable time.
    const deadline = Date.now() + 20_000;
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, { method: this.#method, headers, body });
      if (res.ok) {
        return (await res.json()) as Record<string, unknown>[];
      }
      const errBody = await res.text();
      const schemaCacheTransient =
        res.status === 404 ||
        res.status === 503 ||
        (res.status === 400 && (errBody.includes("PGRST204") || errBody.includes("PGRST205")));
      if (!schemaCacheTransient || Date.now() >= deadline) {
        throw new Error(`PostgREST error (${res.status}): ${errBody}`);
      }
      await new Promise((r) => setTimeout(r, Math.min(500, 100 * (attempt + 1))));
    }
  }
}

function extractAuth(req: Request): string | undefined {
  const auth = req.headers.get("authorization") ?? req.headers.get("Authorization");
  return auth ?? undefined;
}

function extractAuthFromAls(): string | undefined {
  const ctx = getCurrentContext();
  if (ctx === undefined) return undefined;

  // v3.0 (auth-aware-ssr): if a verified actor is present on the runtime
  // context, mint a short-lived JWT carrying the actor's claims so the
  // gateway's PostgREST proxy → pre_request hook → RLS pipeline sees the
  // browser-cookie actor identically to a Bearer-JWT call. The mint is
  // SDK-side because the cookie itself is `__Host-` scoped to the
  // browser origin and never forwarded server-to-server (D13 forbids
  // cookie forwarding). The pepper-isolated session secret stays in the
  // DB; the JWT carries only the actor's already-validated claims, signed
  // with the same JWT_SECRET PostgREST verifies against.
  if (ctx.actor && config.JWT_SECRET) {
    const nowSec = Math.floor(Date.now() / 1000);
    const claims = {
      sub: ctx.actor.id,
      role: "authenticated" as const,
      email: ctx.actor.email,
      project_id: ctx.projectId,
      iss: "agentdb" as const,
      amr: ctx.actor.amr,
      auth_time: ctx.actor.authTime,
      aal: ctx.actor.amr.includes("passkey") ? ("aal2" as const) : ("aal1" as const),
      session_id: ctx.actor.sessionId,
      authz_version: ctx.actor.authzVersion,
      iat: nowSec,
      // 60-second TTL — long enough for the request + retry budget,
      // short enough that exfiltration provides no value.
      exp: nowSec + 60,
    };
    try {
      return `Bearer ${jwt.sign(claims, config.JWT_SECRET)}`;
    } catch {
      // Fall through to header forwarding below. JWT signing should not
      // realistically fail with a present secret; if it does, we want
      // the request to proceed anonymously rather than 500.
    }
  }

  // Fallback: forward whatever Authorization the inbound request carried.
  // This is the v2.x behavior — preserved for explicit Bearer flows
  // (mobile, server-to-server) where the caller already has a JWT.
  const headers = ctx.request.headers;
  const raw = headers["authorization"] ?? headers["Authorization"];
  if (Array.isArray(raw)) return raw[0];
  return raw ?? undefined;
}

interface CallerDbClient {
  from(table: string): QueryBuilder;
}

/**
 * Caller-context DB client. Forwards the caller's Authorization header
 * to PostgREST so RLS policies evaluate against the caller's role.
 *
 * Capability `astro-ssr-runtime` (v1.52): `db()` now accepts the request
 * via either path:
 *
 *   1. **Explicit `db(req)`** — pass a Web `Request` (or Express
 *      `req.raw` equivalent). The existing v0.x call shape.
 *
 *   2. **Implicit `db()`** — when called with no argument, reads the
 *      Authorization header from the active AsyncLocalStorage request
 *      context (populated by the SSR Lambda runtime in `@run402/astro`).
 *      This is what makes `await db().from(...)` work naturally inside
 *      Astro `[slug].astro` frontmatter without explicit plumbing.
 *
 * `apikey` is the project's anon key (routing only — does not grant
 * bypass). If no Authorization is present (in either form), the request
 * is sent with just the anon apikey; PostgREST resolves role=anon and
 * RLS decides whether the query succeeds or returns 401/403.
 *
 * Outside an active request context (module scope, background timer
 * past response materialization), `db()` (no arg) still works — it
 * sends with no Authorization, exactly as the v0.x behavior with a
 * Request that has no auth header. SDK functions that REQUIRE a context
 * (like `cache.invalidate` path-form) throw `R402_SDK_OUTSIDE_REQUEST_CONTEXT`
 * separately.
 */
export function db(req?: Request): CallerDbClient {
  if (!config.ANON_KEY) {
    throw new Error(
      "db() requires RUN402_ANON_KEY in the Lambda environment. " +
        "Redeploy this function via the gateway to pick up the new env var.",
    );
  }
  const authorization = req !== undefined ? extractAuth(req) : extractAuthFromAls();
  const anonKey = config.ANON_KEY;
  return {
    from(table: string) {
      return new QueryBuilder(table, {
        apikey: anonKey,
        authorization,
        basePath: "/rest/v1",
      });
    },
  };
}

interface AdminDbClient {
  from(table: string): QueryBuilder;
  sql(query: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
}

/**
 * Admin DB client. Uses the project's service_key (role=service_role,
 * BYPASSRLS). Routes through /admin/v1/rest/* at the gateway, which rejects
 * any other caller than service_role. Use for explicit server-side operations
 * that must ignore RLS.
 *
 * `adminDb().sql()` targets the /projects/v1/admin/:project_id/sql endpoint, which
 * runs arbitrary SQL as a superuser-scoped role on the project schema.
 */
export function adminDb(): AdminDbClient {
  if (!config.SERVICE_KEY) {
    throw new Error("adminDb() requires RUN402_SERVICE_KEY in the Lambda environment.");
  }
  const serviceKey = config.SERVICE_KEY;
  return {
    from(table: string) {
      return new QueryBuilder(table, {
        apikey: serviceKey,
        authorization: `Bearer ${serviceKey}`,
        basePath: "/admin/v1/rest",
      });
    },
    async sql(query: string, params?: unknown[]): Promise<Record<string, unknown>[]> {
      const url = `${config.API_BASE}/projects/v1/admin/${config.PROJECT_ID}/sql`;
      const hasParams = Array.isArray(params) && params.length > 0;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${serviceKey}`,
          "Content-Type": hasParams ? "application/json" : "text/plain",
        },
        body: hasParams ? JSON.stringify({ sql: query, params }) : query,
      });
      if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`SQL error (${res.status}): ${errBody}`);
      }
      return res.json() as Promise<Record<string, unknown>[]>;
    },
  };
}
