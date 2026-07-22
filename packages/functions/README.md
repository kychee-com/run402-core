# @run402/functions

In-function helper library for [Run402](https://run402.com) serverless functions. Imported _inside_ a deployed function — gives you typed access to the caller's database (RLS-respecting) and the project's admin database, the caller's auth, the project's mailbox, AI helpers, runtime asset uploads, and the project's cursored event feed.

```ts
import { db, adminDb, getUser, email, ai, assets } from "@run402/functions";

export default async (req: Request) => {
  const user = await getUser(req);
  if (!user) return new Response("unauthorized", { status: 401 });

  const mine = await db(req).from("items").select("*").eq("user_id", user.id);
  return Response.json(mine);
};
```

This package is **auto-bundled into every deployed function zip at deploy time** — you don't need to declare it in `--deps`. Install it locally only when you want **TypeScript autocomplete** in your editor while authoring function code.

## Install (local autocomplete)

```bash
npm install @run402/functions
```

## The two DB clients

The most important distinction in this library: **`db(req)` runs as the caller, `adminDb()` bypasses RLS.**

### `db(req).from(table)` — caller-context

Forwards the request's `Authorization` header to PostgREST. Row-Level Security policies evaluate against the caller's role — `anon`, `authenticated`, `project_admin`, or whatever the JWT carries. **This is the default choice.** Routes to `/rest/v1/*`.

```ts
// Reads everything the caller is authorized to see — could be 0 rows for unauthenticated callers.
const mine = await db(req).from("items").select("title, done").eq("user_id", user.id);

// Writes go through RLS too. If the policy says the caller can't insert, it errors.
const [created] = await db(req).from("items").insert({ title: "New", done: false });
```

### `adminDb().from(table)` — bypass RLS

Uses the project's `service_key`. Returns *all* rows regardless of RLS. Routes to `/admin/v1/rest/*` (the gateway rejects `role=service_role` on `/rest/v1/*`, so bypass traffic lives on its own surface).

Use only when the function acts on behalf of the **platform**, not the **caller** — audit logs, cron cleanup, webhook handlers, fan-out writes after a Stripe event.

```ts
// Audit log — capture every event regardless of who triggered the function.
await adminDb().from("audit_log").insert({ event: "payment.succeeded", user_id: userId });

// Cron cleanup — there's no caller to evaluate RLS against.
await adminDb()
  .from("sessions")
  .delete()
  .lt("expires_at", new Date().toISOString());
```

### Fluent surface (same on both clients)

```ts
.select(cols?)
.eq(col, val) / .neq() / .gt() / .lt() / .gte() / .lte()
.like(col, pattern) / .ilike(col, pattern)
.in(col, [vals])
.order(col, { ascending? })
.limit(n) / .offset(n)

// Writes return arrays of affected rows.
.insert(obj | obj[])
.update(obj)        // chain with .eq() to scope
.delete()           // chain with .eq() to scope

// Column narrowing on writes:
.insert({ title: "x" }).select("id, title")
```

### `adminDb().sql(query, params?)` — raw SQL, always BYPASSRLS

```ts
const { rows, row_count } = await adminDb().sql(
  "SELECT count(*)::int AS n FROM items WHERE user_id = $1",
  [userId],
);
// { status: "ok", schema: "p0001", rows: [{ n: 42 }], row_count: 1,
//   fields: [{ name: "n", type: "int4" }] }
```

Returns `AdminSqlResult` (exported type): `{ status, schema, rows, row_count, fields }` — snake_case on the wire. For SELECT, `rows` is the result set and `row_count` is the row count. For INSERT/UPDATE/DELETE, `rows` is `[]` and `row_count` is the affected count — unless the statement uses `RETURNING`, in which case `rows` carries the returned rows. `fields` lists the result columns (`{ name, type }`) so even an empty SELECT conveys its shape.

## `getUser(req)` — caller identity

Verifies the caller's JWT and returns the user, or `null` for unauthenticated requests.

```ts
const user = await getUser(req);
if (!user) return new Response("unauthorized", { status: 401 });
// user: { id: string, email: string, role: "authenticated" | "project_admin" | ... }
```

The function's own `RUN402_PROJECT_ID` is used to scope the verification.

**Note on `user.role`:** this is the JWT system role (`anon`, `authenticated`, `project_admin`, …) — the same value PostgREST uses to evaluate RLS. It is **not** your application role from a declarative `requireRole` gate (admin/moderator/etc.). For the gate-resolved application role, use `getRole(req)` (see "Function-level auth gates" below). Don't write `getUser(req).role === "admin"` thinking you're checking the gate role — `"admin"` is not a JWT role.

## Function-level auth gates

A function can declare auth requirements directly on its `FunctionSpec`. When you set `requireAuth: true` or `requireRole: { ... }`, the gateway enforces them **before** invoking your function — unauthorized callers get `401` / `403` without your code running, and the gateway injects the resolved identity into request headers your function can trust.

This lets you delete the hand-rolled "fetch JWT, query members table, check role, return 403" boilerplate from every privileged function. Declare the gate in your `FunctionSpec`; read the resolved identity with `getUserId(req)` and `getRole(req)`.

### Declaring a gate (deploy spec)

```ts
import { run402 } from "@run402/sdk/node";

const r = run402();
await r.project(projectId).apply({
  functions: {
    patch: {
      set: {
        // 1. Authentication only — any valid JWT for this project passes.
        "list-my-items": {
          source: { sha256, size },
          requireAuth: true,
        },

        // 2. Authentication + role check against your members table.
        "delete-content": {
          source: { sha256, size },
          requireRole: {
            table: "members",         // project-schema table
            idColumn: "user_id",      // FK to the user.id from the JWT
            roleColumn: "role",       // column holding the role string
            allowed: ["admin"],       // case-sensitive byte-equality allowlist
            cacheTtl: 60,             // optional, seconds, default 60, max 600, 0 disables
          },
        },

        // 3. Multi-role — any role in `allowed` passes the gate.
        "moderate-content": {
          source: { sha256, size },
          requireRole: {
            table: "members",
            idColumn: "user_id",
            roleColumn: "role",
            allowed: ["admin", "moderator"],
          },
        },
      },
    },
  },
});
```

`requireAuth` and `requireRole` are independent. `requireRole` on its own implies authentication (no valid JWT → 401), then runs the role lookup. `requireAuth: true` alone does a session check with no DB lookup. Set neither to opt out of platform auth (your function owns the check, as today).

**Single role-table per release:** all `requireRole` blocks in a single release must share the same `(table, idColumn, roleColumn)` triple. Different `allowed` sets are fine; different tables are not. The gateway rejects conflicting triples at plan time with `INVALID_SPEC`.

### Reading the gate result inside your function

```ts
import { getUserId, getRole } from "@run402/functions";

export default async (req: Request): Promise<Response> => {
  const userId = getUserId(req);  // string | null
  const role = getRole(req);      // string | null

  // For a gated function reached through the gateway, both are guaranteed:
  //   - getUserId(req) is non-null when requireAuth OR requireRole is on.
  //   - getRole(req) is non-null when requireRole is on (and is one of `allowed`).
  // The null case covers local invokes / direct Lambda tests / ungated functions.

  if (role === "admin") {
    // Privileged path — the gate already verified.
  } else {
    // role === "moderator" (the only other value `allowed` permits).
  }

  return Response.json({ ok: true, actor: userId, role });
};
```

The two headers (`x-run402-user-id`, `x-run402-user-role`) are injected by the gateway after the gate passes, and inbound `x-run402-*` headers from the browser are stripped before injection — so the values are trustworthy without any further verification.

### Direct vs routed invocation

The gate applies to **both** routed (browser via `/your/route`) and direct (`POST /functions/v1/:name` with an API key plus a user JWT) invocation. Direct invocation still requires the project API key at the edge; the gate runs after API-key authentication, against the user JWT.

### Deploy-time validation

If a `requireRole` block references a table or column that doesn't exist in the project schema at activation time, the deploy fails with `DEPLOY_INVALID_ROLE_GATE` (HTTP 422) **before** flipping the live release. Schema-qualified identifiers (`public.members`), empty `allowed`, and out-of-range `cacheTtl` are rejected earlier at plan time with `INVALID_SPEC` (HTTP 400).

### Caching and staleness

Role lookups are cached per `(projectId, userId)` for `cacheTtl` seconds (default 60, max 600). **A demoted user keeps the cached role until the TTL expires** — for high-stakes operations where instant revocation matters, set `cacheTtl: 0` to issue a fresh lookup on every request. The cache is bypassed when no `requireRole` gate runs.

### Relationship to `getUser`

`getUser(req)` decodes the JWT and gives you `{ id, role, email }` where `role` is the JWT system role. The gate-injected headers give you the gate-resolved identity:

| Helper | Source | Role meaning |
|---|---|---|
| `getUser(req).id` | JWT `sub` (decoded in-function) | — |
| `getUser(req).role` | JWT `role` claim | System role (`anon`, `authenticated`, `project_admin`) |
| `getUserId(req)` | `x-run402-user-id` header (injected by gateway) | — |
| `getRole(req)` | `x-run402-user-role` header (injected by gateway) | Application role from your `members` table |

For a gated function reached through the gateway, `getUserId(req)` and `getUser(req).id` will agree. The gate-side helpers skip the JWT decode (the gateway already did it), so they're slightly cheaper and stringly-typed against the trusted headers; use them when the gate guarantees the identity.

## `email.send(...)` — send mail from the project's mailbox

Auto-discovers the project's mailbox on first call (the project must already have one — create it once with `run402 email create <slug>` or the `create_mailbox` MCP tool). After that the mailbox id is cached for the function's lifetime.

On Run402 Core, this uses the same `/mailboxes/v1` contract as Cloud. Deploy still happens through `run402 deploy apply --manifest`; outbound email is enabled separately by configuring the Core gateway's provider (for example SES) and creating a project mailbox/default. If Core has mailboxes but no outbound provider configured, `email.send()` throws `EmailConfigurationError` with code `PROVIDER_NOT_CONFIGURED` and setup `next_actions`.

```ts
// Template mode
await email.send({
  to: "user@example.com",
  template: "notification",
  variables: { project_name: "My App", message: "Hello!" },
});

// Raw HTML mode
await email.send({
  to: "user@example.com",
  subject: "Welcome!",
  html: "<h1>Hi</h1>",
  from_name: "My App",
});
```

Templates: `project_invite` (`project_name`, `invite_url`), `magic_link` (`project_name`, `link_url`, `expires_in`), `notification` (`project_name`, `message` ≤ 500 chars). Throws on rate limit, suppression, or no-mailbox.

## `ai.translate` / `ai.moderate` / `ai.generateImage`

```ts
const { text, from } = await ai.translate("Hello world", {
  to: "es",
  context: "marketing tagline",
});

const { flagged, categories } = await ai.moderate("Some user-generated text");

const image = await ai.generateImage({
  prompt: "a moonlit dream journal illustration",
  aspect: "landscape",
});
// { image: "<base64 PNG>", content_type: "image/png", aspect: "landscape" }
```

`ai.generateImage` supports `aspect: "square" | "landscape" | "portrait"` and returns base64 image bytes plus `content_type` and `aspect`. It uses the function's `RUN402_SERVICE_KEY` against the project runtime image endpoint; it does **not** need allowance wallets, x402 wrapping, or local signing inside the function. Runtime image generation is billed and rate-limited against the project's organization. Quota, rate-limit, and spend-cap failures are ordinary thrown errors such as `Image generation failed (403): QUOTA_EXCEEDED: ...`; handle them in your app response instead of forwarding raw details to the browser.

Translation requires the AI Translation add-on on the project; moderation is free for all projects.

## `assets.put(...)` — upload runtime assets

Upload bytes from inside a deployed function using the project's service key. This routes through the same CAS-backed apply substrate as deploy-time assets, so public/private visibility, immutable URLs, retention, quota checks, and storage billing match `r.project(id).apply({ assets: { put: [...] } })`.

```ts
import { assets } from "@run402/functions";

const asset = await assets.put("generated/avatar.png", pngBytes, {
  contentType: "image/png",
  visibility: "public",
  immutable: true,
});

return Response.json({ url: asset.immutableUrl ?? asset.url });
```

`source` can be a string, `Uint8Array`, `{ content: string }`, or `{ bytes: Uint8Array }`. The returned `AssetRef` includes both snake_case wire fields (`immutable_url`, `size_bytes`, `content_type`) and SDK-style camelCase aliases (`immutableUrl`, `size`, `contentType`).

### Routed image generation example

Use a routed function when the browser should request an image at app runtime. Keep app-level auth/rate limits in your handler before calling `ai.generateImage`, especially for public routes.

```ts
import { ai, getUser } from "@run402/functions";

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  const user = await getUser(req);
  if (!user) return new Response("unauthorized", { status: 401 });

  const { prompt } = await req.json() as { prompt?: string };
  if (!prompt || prompt.length > 500) {
    return Response.json({ error: "prompt_required" }, { status: 400 });
  }

  try {
    const result = await ai.generateImage({ prompt, aspect: "landscape" });
    return Response.json(result, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (err) {
    return Response.json(
      { error: "image_generation_unavailable", detail: (err as Error).message },
      { status: 503 },
    );
  }
}
```

## `events.emit(type, payload?, opts?)` — emit into the project's event feed

Write a fact into this project's cursored event feed (the `internal.project_events` outbox) from inside a deployed function. Every existing and future feed consumer — `run402 events`, the MCP `list_project_events` tool, the operator console's Activity view — reads it back for free the moment your code calls `events.emit`.

```ts
import { events } from "@run402/functions";

await events.emit("signature_completed", { request_id, signer }, {
  idempotencyKey: `sig:${requestId}`,
});
```

Read it back with `GET /projects/v1/:project_id/events?source=app` (or `run402 events --source app`) — app events share the exact cursor/pagination/retention machinery as platform events (deploys, suspensions, transfers), just filtered to `source=app`.

**Vocabulary.** `type` must be flat snake_case matching `/^[a-z][a-z0-9_]{2,63}$/` — no dots, no `app_` prefix. Platform-registered type names (`deploy_activated`, `mailbox_suspended`, ...) are **reserved**: an app cannot impersonate a platform fact. This is enforced **server-side only** — `events.emit` does not pre-validate the grammar or check the reservation list locally; it sends `type` exactly as given. A bad grammar or a reserved name comes back as a thrown `Run402EventsPlatformError` with `code: "INVALID_EVENT_TYPE"` or `code: "RESERVED_EVENT_TYPE"` (both HTTP 400) — never a silently rewritten or dropped call.

**Idempotency.** Pass `idempotencyKey` on any code path that might run more than once for the same real-world fact — webhook retries, function-run retries, anything at-least-once. The gateway dedupes on `(project_id, idempotency_key)` **forever**: this is a durable identity for the fact, not a short-lived retry-window token like an HTTP `Idempotency-Key` header. Reusing a key days or years later still replays the *original* stored event (`deduplicated: true` on the response) instead of creating a new one.

**Response shape** — both a fresh emit (`201`) and an idempotent replay (`200`) return this:

```ts
{
  cursor: "evc_...",          // opaque feed position — pass to ?cursor= on a feed read
  event_type: "signature_completed",
  class: "app",               // always "app" for events emitted through this namespace
  source: "app",
  payload: { request_id: "req_123", signer: "0x..." },
  payload_truncated: true,    // present only if payload exceeded the 8 KiB bound
  occurred_at: "2026-07-15T12:00:00.000Z",
  deduplicated: false,        // true on an idempotency-key replay
  next_actions: [ /* platform-synthesized drill-downs, incl. a feed poll entry */ ],
}
```

`payload` is a compact JSON fact — ids and verdict fields, never bodies or secrets — bounded to 8 KiB server-side (oversize payloads are truncated with `payload_truncated: true` rather than rejected). `next_actions` is always platform-synthesized; there is no way to supply your own drill-downs from the emit call (an app-supplied action would be prompt-injection-by-schema for agents that treat `next_actions` as trusted).

**Errors.** Non-2xx responses throw `Run402EventsPlatformError` — see [Errors](#errors) below. In practice the two you're most likely to see are `code: "QUOTA_EXCEEDED"` (403, the organization's pooled daily quota is exhausted; `details: {resource: "events_per_day", scope, used, limit}`) and cross-project denials (`code: "FORBIDDEN"`, 403), alongside the two vocabulary errors above.

## Static-site generation (build-time use)

The same library works at build time for static-site generation if you set `RUN402_SERVICE_KEY` and `RUN402_PROJECT_ID` in your `.env`:

```ts
// build-time render — feed the page with current data
const items = await adminDb().from("items").select("title, slug").order("created_at", { ascending: false });
```

Use `adminDb()` (not `db(req)`) here — there's no incoming request to forward.

## Routed HTTP functions

Deploy-v2 web routes can map public same-origin browser paths to functions, for example `routes.replace` / `"routes": { "replace": [{ "pattern": "/api/*", "target": { "type": "function", "name": "api" } }] }`. Use exact `/admin` plus final-wildcard `/admin/*` when a dynamic section root and its children should route to the same function. A browser request to a routed path does **not** need a Run402 API key at the public edge. Direct `/functions/v1/:name` invocation is unchanged: it remains API-key protected and API-shaped.

Routed browser traffic invokes the same Node 22 Fetch Request -> Response handler used by direct functions:

```ts
export default async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "https://app.example.com",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type, authorization",
      },
    });
  }

  if (req.method === "POST" && !req.headers.has("x-csrf-token")) {
    return Response.json({ error: "csrf_required" }, { status: 403 });
  }

  const headers = new Headers({ "cache-control": "private, no-store" });
  headers.append("Set-Cookie", "sid=abc; HttpOnly; Secure; SameSite=Lax; Path=/");
  headers.append("Set-Cookie", "theme=dark; Secure; SameSite=Lax; Path=/");
  return Response.json({ ok: true, path: url.pathname, query: url.search }, { headers });
}
```

Request fields:
- `req.method` is the original browser method. `GET` routes also match `HEAD`; `HEAD` reaches the handler as `HEAD`.
- `req.url` is the full public URL, including scheme, host, path, and query, on managed subdomains, deployment hosts, and verified custom domains. Derive OAuth callback URLs from `new URL(req.url).origin`.
- `req.headers` is a Fetch `Headers` object. Cookie data is available through the `cookie` header.
- Run402 Cloud priced routes expose a confirmed x402 payment through `getRoutedPaymentContext(req)`, backed by platform-owned `x-run402-payment-*` headers. The helper returns `null` for unpriced routes. Run402 Core does not populate payment context because tenant x402 settlement is a Cloud control-plane feature.
- The returned payment keeps `paymentId` as the canonical tenant-side dedupe identity and also reports `idempotencyKey` (`null` for proof-keyed requests), `deduplicated`, and `delivery` (`first` or `replay`). Use `paymentId` to make application side effects idempotent; tenant execution remains at-least-once.
- Paid direct invocations and durable function runs expose the platform idempotency key on `x-run402-idempotency-key`; `getRun402Context(req).idempotencyKey` returns that value or `null`. Sellers with external side effects should also accept their own business-level dedupe token when they need guarantees beyond Run402 billing idempotency.
- `await req.text()`, `await req.json()`, and `await req.arrayBuffer()` read the buffered request body, capped at 6 MiB.

Response behavior:
- Return a Web `Response` with status 200 through 599 except `101 Switching Protocols`.
- Append each cookie with `headers.append("Set-Cookie", value)`; Run402 preserves multiple `Set-Cookie` values as separate browser headers.
- Redirects are ordinary 3xx responses with a `Location` header. `HEAD` responses send headers without body bytes.
- Request and response bodies are capped at 6 MiB. WebSockets, `101 Switching Protocols`, streaming, and SSE are not supported in Phase 1.

Limits and defaults: Run402 does not add wildcard CORS. Run402 does not store routed dynamic responses in a shared cache; if your function sets no `Cache-Control`, the gateway adds `Cache-Control: private, no-store` and `x-run402-cache: dynamic-bypass`.

Security notes: application auth, authorization, sessions, OAuth callbacks, CORS, and CSRF belong in your function code. For cookie-authenticated `POST`, `PUT`, `PATCH`, or `DELETE`, validate a CSRF token or an equivalent same-site defense. Do not trust spoofable forwarding headers for authorization.

The raw `run402.routed_http.v1` envelope is an internal gateway transport. Low-level `routedHttp` helpers and `RoutedHttpRequestV1` / `RoutedHttpResponseV1` types remain exported for tests and gateway-adjacent utilities, but browser route handlers should use Fetch `Request` and `Response`.

Runtime route failure codes to branch on: `ROUTE_MANIFEST_LOAD_FAILED` (manifest/propagation), `ROUTED_INVOKE_WORKER_SECRET_MISSING` (custom-domain Worker secret), `ROUTED_INVOKE_AUTH_FAILED` (internal invoke signature), `ROUTED_ROUTE_STALE` (selected route failed release revalidation), `ROUTE_METHOD_NOT_ALLOWED` (method mismatch), and `ROUTED_RESPONSE_TOO_LARGE` (body over 6 MiB).

## Scheduled functions

Run402 Cloud and Run402 Core both use release manifest `functions.replace.<name>.triggers[]` entries for cron-style schedule triggers. A schedule trigger creates a durable function run, so handler code can use the same `defineFunctionRuns(...)` path for delayed work, webhook redrive, and scheduled sweeps. In Run402 Core this is a single-node gateway scheduler, not a managed distributed jobs system.

Scheduled function runs receive the same Fetch `Request` shape as other durable function runs. The request is a synthetic `POST` with `X-Run402-Trigger: function_run`, `X-Run402-Run-Id`, `X-Run402-Attempt-Id`, and `X-Run402-Idempotency-Key`; the JSON body is the standard function-run envelope and includes `run_id`, `event_type`, `attempt`, `source`, and `payload`.

```ts
export default async function handler(req: Request): Promise<Response> {
  if (req.headers.get("x-run402-trigger")) {
    const event = await req.json() as { trigger: "function_run"; run_id: string; payload: { scheduled_at?: string } };
    await runReminderSweep(event.payload.scheduled_at ?? event.run_id);
    return Response.json({ ok: true, trigger: event.trigger });
  }

  return Response.json({ ok: true });
}
```

## Imports auto-resolved

Inside a deployed function you can `import { ... } from "@run402/functions"` directly — the gateway bundles this library plus any `--deps` you declared at deploy time. **Do not list `@run402/functions` in your `--deps`** — it's rejected. Native binary modules (`sharp`, `canvas`, native `bcrypt`, etc.) are also rejected.

The bundled version lands in the deploy response's `runtime_version` field; resolved `--deps` versions land in `deps_resolved`.

## Errors

All helpers throw on non-2xx responses.

### `R402DbError` — `db()` / `adminDb()` failures

The DB helpers throw a structured `R402DbError` (also exported as a type from the package). Both throw sites carry a stable SDK-level `code`:

- `adminDb().sql(...)` → `code: "R402_DB_SQL_ERROR"`
- `db(req).from(...)` / `adminDb().from(...)` (the `QueryBuilder`) → `code: "R402_DB_QUERY_ERROR"`

Branch on the **properties**, not the message string:

```ts
import { R402DbError } from "@run402/functions";

try {
  await adminDb().sql("INSERT INTO items (name) VALUES ($1)", [name]);
} catch (err) {
  if (err instanceof R402DbError) {
    err.code;       // "R402_DB_SQL_ERROR" | "R402_DB_QUERY_ERROR" (stable SDK code)
    err.status;     // HTTP status number, e.g. 402
    err.trace_id;   // gateway trace id (string) or null — for support tickets
    err.remote_code;// the gateway/PostgREST error code that shaped the message, or null
    err.body;       // full response body (parsed object, or raw string when unparseable)
    if (err.status === 402 && err.remote_code === "QUOTA_EXCEEDED") { /* … */ }
  }
  throw err;
}
```

**Why the message is a stable template.** `err.message` is intentionally low-cardinality so error monitors group failures by kind instead of by trace id. The high-cardinality material (a fresh `trace_id` per event, the full body) lives on properties. The message follows:

| Response body | `message` | `remote_code` | `trace_id` |
|---|---|---|---|
| JSON object with `code` | `SQL error (402): QUOTA_EXCEEDED` | `QUOTA_EXCEEDED` | from body, else `null` |
| JSON object with only `error` | `SQL error (401): PGRST301` | `PGRST301` | from body, else `null` |
| JSON object, no `code`/`error` | `SQL error (500): <envelope>` | `<envelope>` | from body, else `null` |
| non-JSON (text/HTML/empty/array) | `SQL error (502): <body verbatim>` | `null` | `null` |

(`PostgREST error (…)` is the prefix for the `QueryBuilder` path; `SQL error (…)` for `adminDb().sql()`.) Don't parse `message` — read `err.code` / `err.status` / `err.trace_id` / `err.remote_code`.

### `Run402EventsPlatformError` — `events.emit()` failures

`events.emit()` throws a structured `Run402EventsPlatformError` (also exported from the package) on any non-2xx gateway response. The gateway owns event-type grammar, platform-vocabulary reservation, and the per-organization daily quota — this error is a faithful passthrough of whatever canonical envelope the gateway returned, never a client-fabricated message.

```ts
import { events, Run402EventsPlatformError } from "@run402/functions";

try {
  await events.emit("signature_completed", { request_id });
} catch (err) {
  if (err instanceof Run402EventsPlatformError) {
    err.code;    // "QUOTA_EXCEEDED" | "INVALID_EVENT_TYPE" | "RESERVED_EVENT_TYPE" | "FORBIDDEN" | ...
    err.status;  // HTTP status, e.g. 403
    err.details; // e.g. {resource: "events_per_day", scope: "organization", used: 1000, limit: 1000}
    err.next_actions; // platform-synthesized drill-downs (e.g. renew_tier, check_usage)
    err.body;    // full response body (parsed object, or raw string when unparseable)
    if (err.code === "QUOTA_EXCEEDED") { /* … */ }
  }
  throw err;
}
```

Other helpers still throw plain `Error` whose message includes the HTTP status and the response body so you can branch on `code` / `category` / `retryable` (the v1.34+ agent-operable error envelope).

## Engines

Node 22 in deployed functions. `>=18` for local use (autocomplete and SSG).

## Other interfaces

Run402's public surfaces now span two repositories:

- [`run402-core`](https://github.com/kychee-com/run402-core) - server/runtime core, including **`@run402/functions`** (this package)
- [`run402`](https://github.com/kychee-com/run402) - agent/client surfaces:
  - [`@run402/sdk`](https://www.npmjs.com/package/@run402/sdk) — typed TypeScript client for the platform API
  - [`run402`](https://www.npmjs.com/package/run402) — the CLI
  - [`run402-mcp`](https://www.npmjs.com/package/run402-mcp) — MCP server for Claude Desktop / Cursor / Cline / Claude Code
  - OpenClaw skill — script-based skill for OpenClaw agents

## Links

- Run402: <https://run402.com>
- Source: <https://github.com/kychee-com/run402-core/tree/main/packages/functions>
- HTTP API reference: <https://run402.com/llms.txt>
- CLI reference: <https://run402.com/llms-cli.txt>

## License

Apache-2.0
