import { config } from "./config.js";
import { DATA_PLANE_ACTOR_TOKEN_HEADER, forwardedActorAuthorization } from "./lib/project-jwt-keys.js";
import { getCurrentContext } from "./runtime-context.js";

/** The client-facing header that names a request's current group (`group_owns_rows`). */
const GROUP_HEADER = "Run402-Group";

interface QueryBuilderOpts {
  apikey: string;
  authorization: string | undefined;
  basePath: string;
  /** Extra request headers, e.g. `Run402-Client` on the service-key client. */
  headers?: Record<string, string>;
}

/**
 * `Run402-Client` for calls a deployed function makes with its service key:
 * `surface="function"` plus the function's name, so the gateway can say which
 * function of a project still calls a route it is retiring.
 */
export function functionClientHeader(): Record<string, string> {
  const raw = process.env.RUN402_FUNCTION_NAME || process.env.AWS_LAMBDA_FUNCTION_NAME || "";
  const name = raw.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 64);
  return { "Run402-Client": name ? `surface="function", function="${name}"` : `surface="function"` };
}

/** Stable SDK-level codes for the `db()` / `adminDb()` throw sites. */
export type R402DbErrorCode =
  | "R402_DB_QUERY_ERROR"
  | "R402_DB_SQL_ERROR"
  | "R402_DB_SQL_RESULT_SHAPE";

/**
 * Structured error thrown by the DB helpers on a non-ok gateway/PostgREST
 * response:
 *   - `db()` / `adminDb().from()` (QueryBuilder) → code `R402_DB_QUERY_ERROR`
 *   - `db().sql()` / `adminDb().sql()` → code `R402_DB_SQL_ERROR`
 *
 * Also thrown by `db().sql()` / `adminDb().sql()` on a 2xx whose body is NOT the
 * `{ rows: [...] }` envelope → code `R402_DB_SQL_RESULT_SHAPE` (see
 * {@link buildSqlResultShapeError}); the message names only the top-level
 * type / keys of what came back, never the body.
 *
 * The `message` is a stable, LOW-cardinality template so error monitors
 * group failures by kind. High-cardinality material — a fresh `trace_id`
 * per event, the full response body — rides on PROPERTIES, never the
 * message (embedding it defeats fingerprint grouping). Catch-sites SHOULD
 * branch on `err.code` / `err.status` / `err.trace_id` / `err.remote_code`
 * instead of parsing the message string.
 *
 * Message template:
 *   - Body is a JSON object → `<prefix> (<status>): <remote_code>`, where
 *     `remote_code` is `body.code` (else `body.error`, else the literal
 *     `<envelope>`).
 *   - Body is NOT a JSON object (plain text, HTML, empty, JSON array/
 *     primitive) → the legacy verbatim shape `<prefix> (<status>): <body>`,
 *     so old-bundle and new-bundle non-JSON failures fingerprint identically.
 *
 * `prefix` is `PostgREST error` for the QueryBuilder path and `SQL error`
 * for the `db().sql()` / `adminDb().sql()` path.
 */
export class R402DbError extends Error {
  readonly code: R402DbErrorCode;
  readonly status: number;
  readonly trace_id: string | null;
  /** The remote/gateway code that went into the message (`<envelope>` when absent). */
  readonly remote_code: string | null;
  /** Full response body preserved for debugging — parsed object, or raw string when unparseable. */
  readonly body: unknown;
  /** `adminDb().sql()` only, when a retryable refusal outlasted the budget: requests sent. */
  attempts?: number;
  /** `adminDb().sql()` only, when a retryable refusal outlasted the budget: milliseconds spent waiting (0 when there was no time to repeat it). */
  waited_ms?: number;
  readonly docs = "https://run402.com/errors/#R402_DB_ERROR";

  constructor(
    code: R402DbErrorCode,
    message: string,
    fields: {
      status: number;
      trace_id: string | null;
      remote_code: string | null;
      body: unknown;
    },
  ) {
    super(message);
    this.name = "R402DbError";
    this.code = code;
    this.status = fields.status;
    this.trace_id = fields.trace_id;
    this.remote_code = fields.remote_code;
    this.body = fields.body;
  }
}

/**
 * Build a {@link R402DbError} with a fingerprint-stable message and the
 * high-cardinality material on properties. See {@link R402DbError} for the
 * message-template contract (byte-compatible with the gateway's
 * `normalizeErrorMessage` derivation).
 */
function buildDbError(
  code: R402DbErrorCode,
  prefix: "PostgREST error" | "SQL error",
  status: number,
  errBody: string,
): R402DbError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(errBody);
  } catch {
    parsed = undefined;
  }
  // Only a plain JSON object earns the canonical code-in-message shape; the
  // gateway normalizer keys off a `{…}` body, so arrays/primitives/null fall
  // through to the legacy verbatim shape below.
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    const remoteCode: string =
      (typeof obj.code === "string" && obj.code) ||
      (typeof obj.error === "string" && obj.error) ||
      "<envelope>";
    const traceId = typeof obj.trace_id === "string" ? obj.trace_id : null;
    return new R402DbError(code, `${prefix} (${status}): ${remoteCode}`, {
      status,
      trace_id: traceId,
      remote_code: remoteCode,
      body: obj,
    });
  }
  return new R402DbError(code, `${prefix} (${status}): ${errBody}`, {
    status,
    trace_id: null,
    remote_code: null,
    body: errBody,
  });
}

/** Describe a parsed body by top-level type / keys only — never its contents. */
function describeBodyShape(body: unknown): string {
  if (body === null) return "null";
  if (Array.isArray(body)) return `array(length=${body.length})`;
  if (typeof body === "object") {
    const keys = Object.keys(body as Record<string, unknown>);
    return keys.length === 0 ? "object(no keys)" : `object(keys=${keys.join(",")})`;
  }
  return typeof body;
}

/**
 * Build the {@link R402DbError} thrown when `db().sql()` / `adminDb().sql()`
 * gets a 2xx whose body is not the `{ rows: [...] }` envelope. Same
 * fingerprint discipline as {@link buildDbError}: the message carries only a
 * low-cardinality shape description (top-level type / keys); the full body
 * rides on `body`.
 */
function buildSqlResultShapeError(status: number, body: unknown): R402DbError {
  const shape = describeBodyShape(body);
  return new R402DbError(
    "R402_DB_SQL_RESULT_SHAPE",
    `SQL result shape (${status}): expected envelope { rows: [...] }, got ${shape}`,
    {
      status,
      trace_id:
        body !== null &&
        typeof body === "object" &&
        !Array.isArray(body) &&
        typeof (body as Record<string, unknown>).trace_id === "string"
          ? ((body as Record<string, unknown>).trace_id as string)
          : null,
      remote_code: null,
      body,
    },
  );
}

export class QueryBuilder {
  #table: string;
  #params = new URLSearchParams();
  #method = "GET";
  #body: unknown = undefined;
  #apikey: string;
  #authorization: string | undefined;
  #basePath: string;
  #extraHeaders: Record<string, string>;
  #rowMode: "many" | "single" | "maybeSingle" = "many";

  constructor(table: string, opts: QueryBuilderOpts) {
    this.#table = table;
    this.#apikey = opts.apikey;
    this.#authorization = opts.authorization;
    this.#basePath = opts.basePath;
    this.#extraHeaders = opts.headers ?? {};
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

  /**
   * Resolve with exactly one row (the object, not a one-element array).
   * 0 rows or >1 rows throw an {@link R402DbError} with `status: 406`
   * (PostgREST's single-object convention) and a fingerprint-stable message.
   * Terminal — call it last in the chain.
   */
  single(): PromiseLike<Record<string, unknown>> {
    this.#rowMode = "single";
    return this as unknown as PromiseLike<Record<string, unknown>>;
  }

  /**
   * Resolve with one row or `null` when no row matches. More than one row
   * throws an {@link R402DbError} with `status: 406` — narrow the filter.
   * Terminal — call it last in the chain.
   */
  maybeSingle(): PromiseLike<Record<string, unknown> | null> {
    this.#rowMode = "maybeSingle";
    return this as unknown as PromiseLike<Record<string, unknown> | null>;
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
    // Runtime value matches the row mode: array by default, object/null after
    // single()/maybeSingle() — whose return types re-narrow the PromiseLike.
    this.#run().then(resolve as (value: unknown) => void, reject);
  }

  async #run(): Promise<Record<string, unknown>[] | Record<string, unknown> | null> {
    const rows = await this.#execute();
    if (this.#rowMode === "many") return rows;
    if (rows.length > 1) {
      throw new R402DbError(
        "R402_DB_QUERY_ERROR",
        `PostgREST error (406): ${this.#rowMode}() got multiple rows`,
        { status: 406, trace_id: null, remote_code: null, body: { rows: rows.length } },
      );
    }
    if (rows.length === 0) {
      if (this.#rowMode === "maybeSingle") return null;
      throw new R402DbError(
        "R402_DB_QUERY_ERROR",
        "PostgREST error (406): single() got 0 rows",
        { status: 406, trace_id: null, remote_code: null, body: { rows: 0 } },
      );
    }
    return rows[0];
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
      ...this.#extraHeaders,
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
        throw buildDbError("R402_DB_QUERY_ERROR", "PostgREST error", res.status, errBody);
      }
      await new Promise((r) => setTimeout(r, Math.min(500, 100 * (attempt + 1))));
    }
  }
}

function extractAuth(req: Request): string | undefined {
  const auth = req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (auth) return auth;
  // `db(req)` is the documented, idiomatic form — and a browser request carries
  // a session COOKIE, never an Authorization header. Without this fallback the
  // explicit-request form silently runs ANONYMOUS for a cookie-authenticated
  // visitor while the no-arg `db()` form runs as the actor: same page, same
  // user, two different identities depending on which overload the author
  // happened to use. Caught by the live e2e (a 42501 on an INSERT whose RLS
  // policy was correct); unit tests could not see it because both forms were
  // only ever exercised with an explicit Bearer.
  //
  // An inbound Authorization still WINS — this is a fallback, not an override,
  // so explicit Bearer flows (mobile, server-to-server) are unchanged.
  return forwardedActorAuthorization(req.headers);
}

function extractAuthFromAls(): string | undefined {
  const ctx = getCurrentContext();
  if (ctx === undefined) return undefined;

  // When a verified actor is present, the data-plane call must carry that
  // actor's claims so the gateway's PostgREST proxy → pre_request → RLS
  // pipeline sees the browser-cookie actor identically to a Bearer-JWT call.
  // The cookie itself is `__Host-` scoped and never forwarded server-to-server
  // (D13 forbids cookie forwarding), so something has to carry the identity.
  //
  // The GATEWAY mints that token and this runtime forwards it: a short-lived
  // token scoped to ONE identity. This runtime never holds a key capable of
  // signing credentials for another project.
  const forwarded = forwardedActorAuthorization(ctx.request.headers);
  if (forwarded) return forwarded;

  // DEFENSE IN DEPTH, PRESERVED. `ctx.actor` is the runtime's VERIFIED state —
  // an envelope the gateway signed and this SDK checked before exposing it. If
  // a verified actor is present but no gateway-minted token came with it, we
  // return NOTHING rather than falling through to the inbound Authorization
  // header: forwarding an unverified header there would let a caller-supplied
  // credential overwrite the verified identity downstream — exactly the
  // substitution this guard exists to prevent.
  //
  // In practice this branch is near-unreachable: the gateway mints the token
  // in the same block that signs the envelope, so actor-present implies
  // token-present unless the gateway's keyring itself failed. Degrading to an
  // anonymous call there is the intended failure mode.
  if (ctx.actor) return undefined;

  // Fallback: forward whatever Authorization the inbound request carried,
  // for explicit Bearer flows (mobile, server-to-server) where the caller
  // already has a JWT.
  const headers = ctx.request.headers;
  const raw = headers["authorization"] ?? headers["Authorization"];
  if (Array.isArray(raw)) return raw[0];
  return raw ?? undefined;
}

/** The bare `x-run402-actor-token` value behind an `Authorization`-ready bearer, if it is one. */
function bareBearer(authorization: string | undefined): string | undefined {
  if (!authorization) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(authorization);
  return m ? m[1] : undefined;
}

/**
 * Run one request against `POST /projects/v1/:project_id/sql` with the
 * project's service key and map the answer the one way both SQL clients
 * share: a non-2xx throws `R402_DB_SQL_ERROR`, a 2xx that is not the
 * `{ rows: [...] }` envelope throws `R402_DB_SQL_RESULT_SHAPE`.
 */
async function requestSql(
  serviceKey: string,
  init: { headers?: Record<string, string>; contentType: string; body: string },
): Promise<AdminSqlResult> {
  const url = `${config.API_BASE}/projects/v1/${config.PROJECT_ID}/sql`;
  const send = (connectionWaitMs: number) => fetch(url, {
    method: "POST",
    headers: {
      ...functionClientHeader(),
      ...init.headers,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": init.contentType,
      [CONNECTION_WAIT_HEADER]: String(connectionWaitMs),
    },
    body: init.body,
  });
  // Both SQL clients wait out a retryable refusal (a deploy's write pause,
  // 503 PROJECT_WRITES_PAUSED) within the budget, then surface the refusal.
  const sent = await sendWaitingOutRetryable(send);
  if (!sent.ok) throw sent.error;
  const res = sent.response;
  const body: unknown = await res.json();
  if (
    body === null ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    !Array.isArray((body as Record<string, unknown>).rows)
  ) {
    throw buildSqlResultShapeError(res.status, body);
  }
  return body as AdminSqlResult;
}

/**
 * How `db()` learns the request it acts for and the group it acts in.
 *
 * - `request` — the inbound Web `Request`; omitted, the active request
 *   context (AsyncLocalStorage, populated by the routed runtime) is read.
 * - `group` — the request's current group for tables declared
 *   `group_owns_rows`: sent as the `Run402-Group` header on `from()` and as
 *   the body's `group` on `sql()`. The policy narrows to that group and never
 *   widens: a group the user is not a member of yields no rows, and a
 *   `force_group_on_insert` table fills a NULL group column from it.
 */
export interface DbOptions {
  request?: Request;
  group?: string;
}

interface CallerDbClient {
  from(table: string): QueryBuilder;
  /**
   * Run SQL as the request's end user, under row-level security.
   *
   * Posts the project's service key with `as_actor: true` and the request's
   * forwarded actor token to `/projects/v1/:project_id/sql`; the gateway runs
   * the statement as that user (role `authenticated`), or as `anon` when the
   * request carries no actor (a scheduled function, an anonymous visitor),
   * never silently as the service key. The result says whom it ran as:
   * `actor: { user_id } | null` and `role: "authenticated" | "anon"`.
   *
   * ```ts
   * const { rows, actor } = await db().sql(
   *   "SELECT * FROM threads WHERE created_at > $1",
   *   [since],
   * );
   * ```
   *
   * The result is the gateway ENVELOPE ({@link AdminSqlResult}), never a bare
   * row array: destructure `rows`. Reads are governed by the tables' policies
   * (rows the user may not see are absent); a write a policy refuses throws
   * `R402DbError` with `status: 403` and `remote_code: "REST_PERMISSION_DENIED"`.
   * A non-2xx throws `R402_DB_SQL_ERROR`; a 2xx whose body is not
   * `{ rows: [...] }` throws `R402_DB_SQL_RESULT_SHAPE`, exactly as
   * `adminDb().sql()` does, so moving a call between the two changes one
   * identifier.
   *
   * Needs `RUN402_SERVICE_KEY` in the function's environment (the gateway
   * injects it); without it this throws before any request.
   */
  sql(query: string, params?: unknown[]): Promise<AdminSqlResult>;
}

function isRequest(value: Request | DbOptions): value is Request {
  if (typeof Request !== "undefined" && value instanceof Request) return true;
  const headers = (value as { headers?: unknown }).headers;
  return typeof headers === "object" && headers !== null && typeof (headers as Headers).get === "function";
}

/**
 * Caller-context DB client: the visitor's reads and writes, under row-level
 * security. Use it for anything a function does on behalf of the person
 * whose request it is serving; use {@link adminDb} for platform work (audit
 * logs, cron cleanup, webhooks) where there is no caller to act as.
 *
 * `from(table)` forwards the caller's identity to PostgREST so RLS evaluates
 * against the caller's role; `sql(query, params?)` runs a statement as the
 * same user through the gateway's SQL route (`as_actor`), for the joins and
 * aggregates a REST query cannot express. Both see only what the manifest's
 * policies allow that user.
 *
 * `db()` learns the request via either path:
 *
 *   1. **Explicit `db(req)`** or **`db({ request: req })`** — pass a Web
 *      `Request` (or Express `req.raw` equivalent).
 *
 *   2. **Implicit `db()`** — with no request, reads the active
 *      AsyncLocalStorage request context (populated by the routed runtime and
 *      `@run402/astro`). This is what makes `await db().from(...)` work
 *      naturally inside Astro `[slug].astro` frontmatter without plumbing.
 *
 * `db({ group })` names the request's current group for tables declared
 * `group_owns_rows` (see {@link DbOptions}): `Run402-Group` on `from()`, the
 * body's `group` on `sql()`.
 *
 * `apikey` is the project's anon key (routing only — does not grant
 * bypass). If no identity is present (in either form), `from()` is sent with
 * just the anon apikey and PostgREST resolves role=anon, and `sql()` runs as
 * `anon` and says so (`role: "anon"`); RLS decides what either returns.
 *
 * Outside an active request context (module scope, background timer past
 * response materialization, a scheduled function), `db()` (no arg) still
 * works — it sends no identity, matching a Request with no auth header. SDK
 * functions that REQUIRE a context (like `cache.invalidate` path-form) throw
 * `R402_SDK_OUTSIDE_REQUEST_CONTEXT` separately.
 */
export function db(reqOrOpts?: Request | DbOptions): CallerDbClient {
  if (!config.ANON_KEY) {
    throw new Error(
      "db() requires RUN402_ANON_KEY in the Lambda environment. " +
        "Redeploy this function via the gateway to pick up the new env var.",
    );
  }
  const opts: DbOptions = reqOrOpts === undefined ? {} : isRequest(reqOrOpts) ? { request: reqOrOpts } : reqOrOpts;
  if (opts.group !== undefined && (typeof opts.group !== "string" || opts.group.length === 0)) {
    throw new Error("db({ group }) needs a non-empty string: the request's current group, sent as Run402-Group.");
  }
  const group = opts.group;
  const authorization = opts.request !== undefined ? extractAuth(opts.request) : extractAuthFromAls();
  const anonKey = config.ANON_KEY;
  return {
    from(table: string) {
      return new QueryBuilder(table, {
        apikey: anonKey,
        authorization,
        basePath: "/rest/v1",
        ...(group !== undefined ? { headers: { [GROUP_HEADER]: group } } : {}),
      });
    },
    sql(query: string, params?: unknown[]): Promise<AdminSqlResult> {
      if (!config.SERVICE_KEY) {
        throw new Error(
          "db().sql() requires RUN402_SERVICE_KEY in the Lambda environment: " +
            "it posts the service key with as_actor: true so the statement runs as the request's user. " +
            "Redeploy this function via the gateway to pick up the env var.",
        );
      }
      const actorToken = bareBearer(authorization);
      return requestSql(config.SERVICE_KEY, {
        ...(actorToken !== undefined ? { headers: { [DATA_PLANE_ACTOR_TOKEN_HEADER]: actorToken } } : {}),
        contentType: "application/json",
        body: JSON.stringify({
          sql: query,
          params: Array.isArray(params) ? params : [],
          as_actor: true,
          ...(group !== undefined ? { group } : {}),
        }),
      });
    },
  };
}

/**
 * The gateway's SQL endpoint envelope, returned verbatim by `db().sql()` and
 * `adminDb().sql()`.
 * NOTE the snake_case `row_count` — this shape is the wire contract
 * (docs/style.md snake_case), not a camelCase SDK projection. Do not declare
 * this type as a bare row array; it does not match the runtime response shape.
 */
export interface AdminSqlResult {
  status: string;
  /** The project's backing schema slot (e.g. "p0005"). */
  schema: string;
  /** SELECT rows — and RETURNING rows for INSERT/UPDATE/DELETE .. RETURNING. */
  rows: Record<string, unknown>[];
  /** Matched/affected row count of the last statement (snake_case on the wire). */
  row_count: number;
  /** Column metadata for the returned rows. */
  fields: { name: string; type: string }[];
  /** One entry per statement, in order: its command tag and its own count. */
  statements: { command: string | null; row_count: number }[];
  /**
   * Warnings that never change the result (`SCHEMA_CHANGE_OUTSIDE_MIGRATION`,
   * `MULTI_STATEMENT_TEXT_BODY`, `ROUTE_RETIRING`), each with `next_actions`.
   */
  warnings: { code: string; message: string; severity?: string; next_actions: unknown[] }[];
  /**
   * `db().sql()` only: the end user the statement ran as, or `null` when the
   * request carried no actor. Absent on `adminDb().sql()`.
   */
  actor?: { user_id: string } | null;
  /**
   * `db().sql()` only: `"authenticated"` when an actor was forwarded, else
   * `"anon"`. Absent on `adminDb().sql()`, which runs as the service role.
   */
  role?: "authenticated" | "anon";
}

interface AdminDbClient {
  from(table: string): QueryBuilder;
  /**
   * Run raw SQL as the project's superuser-scoped role (always BYPASSRLS).
   * For a statement on behalf of the request's visitor, under their
   * policies, use `db().sql()` instead.
   *
   * The result is the gateway ENVELOPE, never a bare row array:
   *
   * ```ts
   * const { rows, row_count } = await adminDb().sql(
   *   "UPDATE items SET done = true WHERE id = $1 RETURNING id",
   *   [id],
   * );
   * ```
   *
   * - `rows` — SELECT rows, and `RETURNING` rows for INSERT/UPDATE/DELETE
   *   (`[]` for a write without `RETURNING`).
   * - `row_count` — the matched/affected count (snake_case, wire contract).
   * - `status`, `schema`, `fields`, `statements`, `warnings` — see
   *   {@link AdminSqlResult}.
   *
   * Iterating the result itself (`for (const r of result)`) or reading
   * `result.length` is wrong and silently yields nothing — destructure `rows`.
   *
   * A 2xx whose body is not `{ rows: [...] }` throws `R402DbError` with
   * `code: "R402_DB_SQL_RESULT_SHAPE"`; a non-2xx throws `R402_DB_SQL_ERROR`.
   *
   * `params`: omitted or `[]` sends the query as `text/plain` with NO
   * parameter binding, so `$1` placeholders fail server-side — pass a
   * non-empty array whenever the query uses placeholders.
   */
  sql(query: string, params?: unknown[]): Promise<AdminSqlResult>;
}

/**
 * How long one `adminDb().sql()` call may take, attempts and waits together,
 * while it waits out a retryable refusal (a deploy's write pause answers
 * `503 PROJECT_WRITES_PAUSED`): under the prototype tier's
 * 10-second default function timeout, so a function never dies waiting
 * (project-sql-endpoint "First-party SQL clients wait out a retryable refusal").
 */
export const ADMIN_SQL_WAIT_BUDGET_MS = 8_000;

/**
 * Each attempt tells the gateway how long it may wait for a database
 * connection: what is left of the budget, less this allowance for the
 * statement itself and the round trip. The gateway answers
 * `503 PROJECT_DATABASE_BUSY` when that wait runs out, so no attempt's
 * connection wait can carry the call past the budget.
 */
const CONNECTION_WAIT_HEADER = "Run402-Connection-Wait-Ms";
const STATEMENT_ALLOWANCE_MS = 1_000;
/** A retry starts only when at least this much budget is left after its wait. */
const MIN_ATTEMPT_MS = 1_500;

/** The wait before attempt `attempt + 1`: the response's Retry-After, at least 0.5 s growing to 2 s. */
function retryWaitMs(res: Response, attempt: number): number {
  const header = Number(res.headers.get("retry-after"));
  const retryAfterMs = Number.isFinite(header) && header > 0 ? header * 1000 : 0;
  return Math.max(retryAfterMs, Math.min(500 * attempt, 2_000));
}

/** True when the gateway envelope says repeating the identical request is safe. */
function isSafeRetryEnvelope(body: unknown): boolean {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return false;
  const b = body as Record<string, unknown>;
  return b.retryable === true && b.safe_to_retry === true;
}

/**
 * Send, repeating while the gateway marks the refusal retryable and safe to
 * retry and the budget still covers the wait plus a useful attempt. Every
 * attempt carries `Run402-Connection-Wait-Ms` so the gateway bounds its
 * connection wait to what the budget has left. Answers the ok response, or
 * the last refusal as an {@link R402DbError}; a retryable refusal the budget
 * ends carries `attempts` and `waited_ms` (1 and 0 when there was no time to
 * repeat it), any other error is the gateway's own.
 */
async function sendWaitingOutRetryable(
  send: (connectionWaitMs: number) => Promise<Response>,
): Promise<{ ok: true; response: Response } | { ok: false; error: R402DbError }> {
  const startedAt = Date.now();
  const remaining = (): number => ADMIN_SQL_WAIT_BUDGET_MS - (Date.now() - startedAt);
  let waitedMs = 0;
  for (let attempt = 1; ; attempt++) {
    const res = await send(Math.max(0, remaining() - STATEMENT_ALLOWANCE_MS));
    if (res.ok) return { ok: true, response: res };
    const errBody = await res.text();
    const error = buildDbError("R402_DB_SQL_ERROR", "SQL error", res.status, errBody);
    if (!isSafeRetryEnvelope(error.body)) return { ok: false, error };
    const wait = retryWaitMs(res, attempt);
    if (remaining() - wait < MIN_ATTEMPT_MS) {
      error.attempts = attempt;
      error.waited_ms = waitedMs;
      return { ok: false, error };
    }
    await new Promise((resolve) => setTimeout(resolve, wait));
    waitedMs += wait;
  }
}

/**
 * Admin DB client: the platform's own reads and writes, bypassing row-level
 * security. Uses the project's service_key (role=service_role, BYPASSRLS).
 * Routes through /projects/v1/:project_id/rest/* at the gateway, which
 * accepts only the project's own service key.
 *
 * Use it when the function acts for the PLATFORM, not for the caller: audit
 * logs, cron cleanup, webhook handlers, fan-out writes after a payment event.
 * A request served on behalf of a visitor belongs on {@link db}: `db().from()`
 * and `db().sql()` run as that visitor and let the manifest's policies
 * decide, so a bug in the handler's own checks cannot expose every row
 * (`run402 doctor` flags `adminDb()` in a file that reads the current user
 * as `SERVICE_KEY_IN_USER_REQUEST`).
 *
 * `adminDb().sql()` targets /projects/v1/:project_id/sql, which runs
 * arbitrary SQL as a superuser-scoped role on the project schema.
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
        basePath: `/projects/v1/${config.PROJECT_ID}/rest`,
        headers: functionClientHeader(),
      });
    },
    sql(query: string, params?: unknown[]): Promise<AdminSqlResult> {
      const hasParams = Array.isArray(params) && params.length > 0;
      return requestSql(serviceKey, {
        contentType: hasParams ? "application/json" : "text/plain",
        body: hasParams ? JSON.stringify({ sql: query, params }) : query,
      });
    },
  };
}
