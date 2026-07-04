/**
 * `auth.*` — the sole server-side auth namespace.
 *
 * The single import line for any consumer:
 *
 *     import { auth } from "@run402/functions";
 *
 * Surface (deliberately small):
 *
 *     auth.user()                          → Actor | null
 *     auth.requireUser()                   → Actor (throws / 303 otherwise)
 *     auth.requireRole(role, { from? })    → { user, role }
 *     auth.role({ from? })                 → string | null (resolved role, no throw)
 *     auth.requireMembership(membership)   → { user, membership }
 *     auth.requireFresh({ maxAge, amr? })  → void (throws / 303 otherwise)
 *     auth.identities.link({ ... })        → void
 *     auth.fetch(input, init?)             → Response (same-origin only)
 *     auth.csrfToken()                     → string
 *     auth.csrfField()                     → "<input type=hidden ...>"
 *     auth.sessions.createResponseFromIdentity({ ... }) → Response
 *     auth.sessions.createResponseFromTenantAssertion({ tenant, user, method }) → Response
 *     auth.sessions.endResponse()          → Response
 *     auth.invalidCredentials()            → InvalidCredentialsError (throw it)
 *
 * Behaviour notes baked into the helpers:
 *   - Calling any helper taints the cache (the response now depends on
 *     per-request actor state). The taint is monotonic — once set, the
 *     SSR cache layer treats the response as non-cacheable until the
 *     request completes.
 *   - HTML-vs-JSON failure decisions are made by the gateway middleware
 *     (303 redirect for HTML, 401/403 envelope for JSON). The SDK throws
 *     a typed Error subclass; framework code OR the gateway translates.
 *   - `requireRole` reads the gate-resolved role from the routed-function
 *     envelope header (`x-run402-user-role`) that the gateway's
 *     `function-role-gates` middleware sets after resolving the caller
 *     against the project's OWN role table — the one named in that
 *     function's deploy-spec `requireRole` gate. It therefore REQUIRES the
 *     deploy-spec gate: with no gate declared the header is absent and
 *     `requireRole` throws `RoleGateNotConfiguredError` (server-class 500, a
 *     deploy-spec misconfiguration) — structurally distinct from
 *     `InsufficientRoleError` (403) for a resolved-but-disallowed role. The
 *     gateway role lookup is TTL-cached (default 60s; set the gate's
 *     `cacheTtl: 0` for a fresh read per request), so revocation lag is
 *     bounded by that TTL — it is NOT instant. The asserted role MUST be a
 *     member of the gate's `allowed` set; when a gate allows more than one
 *     role, read `auth.role()` and branch instead of re-asserting per role
 *     (asserting a role outside `allowed` denies the other allowed roles).
 *   - `auth.role()` returns the gate-resolved role (or `null`) WITHOUT
 *     throwing — the branch-friendly companion to `requireRole`. It reads the
 *     gate's decision; it is NOT itself an authorization boundary (the gate's
 *     `allowed` is), and only ever yields an allowed role or `null`.
 *   - TWO topologies. The default `requireRole(role)` / `role()` above are for
 *     Bearer/API callers behind the deploy-spec edge gate. For cookie-session
 *     SSR (Astro/Next consoles) the edge gate does NOT apply — pass
 *     `{ from: { table, idColumn, roleColumn } }` and the helper resolves the
 *     cookie user (`auth.user()`) + reads their role from your tenant table
 *     directly (RLS-bypass), no gate required. Use `role({ from })` +
 *     `Astro.redirect(303)` on `.astro` pages (a throw in frontmatter renders
 *     a 500, not a redirect).
 *   - `requireMembership` is forward-only API: the gateway producer for
 *     `x-run402-user-membership` is not shipped, so it throws
 *     `MembershipGateNotWiredError` (a distinct "not wired yet" diagnostic,
 *     NOT an authz denial). `@deprecated` until the membership gate lands.
 *   - `requireFresh` consults the per-method `amr_times` on the Actor —
 *     a recent password proof does NOT satisfy `{amr: ["passkey"]}`.
 *
 * @see openspec/changes/auth-aware-ssr/specs/auth-sdk-namespace/spec.md
 */

import {
  getCurrentContext,
  requireActiveContext,
  taintCacheBypass,
  type ActorContext,
} from "../runtime-context.js";
import { config } from "../config.js";
import jwt from "../lib/jwt.js";
import {
  AuthRequiredError,
  FetchAbsoluteUrlError,
  FreshnessRequiredError,
  InsufficientRoleError,
  InvalidCredentialsError,
  MembershipGateNotWiredError,
  PrerenderedError,
  RenamedExportError,
  RoleGateNotConfiguredError,
  TenantSubjectInvalidError,
  UnknownExportError,
} from "./errors.js";
import type {
  AccountSecurity,
  Actor,
  CreateResponseFromIdentityOptions,
  CreateResponseFromTenantAssertionOptions,
  IdentityLinkOptions,
} from "./types.js";
import { validateAuthFetchInput } from "./url-validation.js";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Identity & authorization helpers
// ---------------------------------------------------------------------------

async function user(): Promise<Actor | null> {
  // Taint cache regardless of outcome — the response depends on actor
  // state once any consumer asks. The taint is monotonic (D23).
  taintCacheBypass();
  const ctx = getCurrentContext();
  if (ctx === undefined) {
    // No active context — could be (a) module scope or (b) prerendered
    // build. The runtime-context module distinguishes these via the
    // `active` flag, but for `auth.user()` specifically we return null
    // for module-scope while throwing R402_AUTH_PRERENDERED for the
    // prerendered case. Without a context we can't tell, so return
    // null — Astro's prerender detection runs upstream in @run402/astro.
    return null;
  }
  // SSR / cookie-session path: actor populated from the verified
  // gateway-signed envelope at runWithContext entry.
  if (ctx.actor) {
    return actorContextToPublicActor(ctx.actor, ctx.projectId);
  }
  // auth-hosted-surface-parity: for browser SSR (routed_http) the cookie
  // envelope is the ONLY actor input. We do NOT fall back to decoding an
  // `Authorization: Bearer` header here — otherwise a Bearer on a GET to
  // a tenant SSR page would resolve an actor, contradicting the
  // "cookie is the only browser actor input" invariant (Kychon finding).
  // The fallback is preserved only for direct/machine invocations below.
  if (ctx.invocationKind === "routed_http") {
    return null;
  }
  // Direct function invocation path (Bearer JWT, no cookie envelope):
  // fall back to decoding the Authorization header. This is the legacy
  // getUser(req) contract — mobile / server-to-server callers send a
  // signed JWT in the Authorization header, the function reads it.
  // The gateway has already routed the request to this function and
  // injected the Authorization header per the apikey/wallet-auth
  // pipeline, so we can trust JWT_SECRET-signed claims here.
  return actorFromAuthorizationHeader(ctx);
}

/** Read `Authorization: Bearer <jwt>` from the runtime context's
 *  request headers and decode it via JWT_SECRET. Returns an `Actor`
 *  populated from the JWT claims on success, `null` on absence /
 *  malformed / wrong-project / verify-fail.
 *
 *  This is the legacy `getUser(req)` shape adapted to the v3.0 `auth.*`
 *  surface — it preserves the direct-function-invocation contract that
 *  the platform's own E2E suite exercises and that mobile / CI callers
 *  rely on. The cookie-session SSR path doesn't go through here (it
 *  populates ctx.actor at runWithContext entry via the verified
 *  envelope). */
function actorFromAuthorizationHeader(
  ctx: NonNullable<ReturnType<typeof getCurrentContext>>,
): Actor | null {
  if (!config.JWT_SECRET) return null;
  const headers = ctx.request.headers;
  // The runtime-context wrapper accepts either a `Headers` instance
  // (when the gateway's buildEntryWrapper passes a Request) or a plain
  // header object. Handle both.
  let authHeader: string | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const h = headers as any;
  if (typeof h?.get === "function") {
    authHeader = h.get("authorization") ?? h.get("Authorization") ?? undefined;
  } else {
    const raw = h?.["authorization"] ?? h?.["Authorization"];
    authHeader = Array.isArray(raw) ? raw[0] : raw;
  }
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify<{
      sub: string;
      role: string;
      email?: string;
      project_id: string;
      auth_time?: number;
      amr?: string[];
      session_id?: string;
      authz_version?: number;
      is_test?: boolean;
    }>(token, config.JWT_SECRET);
    if (payload.project_id !== ctx.projectId) return null;
    return {
      id: payload.sub,
      projectId: payload.project_id,
      sessionId: payload.session_id ?? `bearer:${payload.sub}`,
      email: payload.email ?? "",
      is_test: payload.is_test === true ? true : undefined,
      emailVerified: false,
      authTime: payload.auth_time ?? Math.floor(Date.now() / 1000),
      amr: Array.isArray(payload.amr) ? [...payload.amr] : [],
      amrTimes: {},
    };
  } catch {
    return null;
  }
}

async function requireUser(): Promise<Actor> {
  const actor = await user();
  if (actor === null) {
    throw new AuthRequiredError({ returnTo: currentReturnTo() });
  }
  return actor;
}

/** A tenant role-table source for the cookie-session SSR guard
 *  (`auth.requireRole(role, { from })` / `auth.role({ from })`). The role is
 *  read from `<table>` where `<idColumn> = auth.user().id`, RLS-bypass. */
export interface RoleSource {
  table: string;
  idColumn: string;
  roleColumn: string;
}

const ROLE_SOURCE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Resolve the cookie-session user and their role from a tenant table via an
 *  RLS-bypass single-row read. `user` is null when anonymous; `role` is null
 *  when anonymous or no row. Never reads the edge-gate header — this is the
 *  no-edge-gate SSR path. `auth.user()` taints the cache like the other
 *  readers. */
async function resolveRoleFromTable(
  source: RoleSource,
): Promise<{ user: Actor | null; role: string | null }> {
  for (const field of ["table", "idColumn", "roleColumn"] as const) {
    if (!ROLE_SOURCE_IDENT.test(source[field])) {
      throw new Error(
        `auth role source: ${field} must be an unquoted SQL identifier (${ROLE_SOURCE_IDENT.source})`,
      );
    }
  }
  const actor = await user();
  if (actor === null) return { user: null, role: null };
  // RLS-bypass single-row read of the resolved user's role (service-key).
  const { adminDb } = await import("../db.js");
  const rows = await adminDb()
    .from(source.table)
    .select(source.roleColumn)
    .eq(source.idColumn, actor.id)
    .limit(1);
  const raw = rows[0]?.[source.roleColumn];
  return { user: actor, role: typeof raw === "string" ? raw : null };
}

async function requireRole<const R extends string>(
  role: R,
  opts?: { from?: RoleSource },
): Promise<{ user: Actor; role: R }> {
  if (opts?.from) {
    // Cookie-session SSR topology (no edge gate): resolve the user from the
    // cookie envelope, read their role from the tenant table directly.
    const resolved = await resolveRoleFromTable(opts.from);
    if (resolved.user === null) {
      throw new AuthRequiredError({ returnTo: currentReturnTo() });
    }
    if (resolved.role === role) {
      return { user: resolved.user, role };
    }
    throw new InsufficientRoleError(role);
  }
  const actor = await requireUser();
  // Read the gate-resolved role from the routed-function envelope header the
  // gateway's `function-role-gates` middleware (gateway middleware/role-gate.ts)
  // sets after resolving the caller against the project's OWN role table. The
  // header is present ONLY when the function declares a `requireRole` gate;
  // there is no `internal.role_grants` table — the role lives in the tenant's
  // own schema, named by the gate spec.
  const ctx = requireActiveContext("auth.requireRole");
  const headerRole = readHeader(ctx.request.headers, "x-run402-user-role");
  if (headerRole === undefined) {
    // No role gate resolved this request. The gateway returns 403 ROLE_FORBIDDEN
    // *before* dispatch when a `requireRole` gate IS declared and the caller's
    // role is not allowed — so an executing function with no role header
    // definitively had NO `requireRole` gate (or only an auth-only gate). That
    // is a deploy-spec misconfiguration, not an authorization denial against an
    // innocent caller, so it surfaces as a distinct server-class error.
    throw new RoleGateNotConfiguredError(role);
  }
  if (headerRole === role) {
    return { user: actor, role };
  }
  // A role WAS resolved but it is not the required one: a genuine 403 denial.
  throw new InsufficientRoleError(role);
}

async function role(opts?: { from?: RoleSource }): Promise<string | null> {
  // Non-throwing READ of the resolved role. Two sources:
  //  - `{ from }` (cookie-session SSR): resolve auth.user() + read the role
  //    from the named tenant table (RLS-bypass single-row). No edge gate.
  //  - default: the gateway-resolved `x-run402-user-role` edge-gate header
  //    (set only when the function declares a `requireRole` gate).
  // Either way returns the role string or null and NEVER throws — the SSR
  // branch primitive (branch + `Astro.redirect(303)` yourself). Taints the
  // cache like the other readers.
  taintCacheBypass();
  if (opts?.from) {
    return (await resolveRoleFromTable(opts.from)).role;
  }
  const ctx = getCurrentContext();
  if (ctx === undefined) return null;
  return readHeader(ctx.request.headers, "x-run402-user-role") ?? null;
}

function readHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const v = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
  return Array.isArray(v) ? v[0] : v;
}

async function requireMembership<const M extends string>(
  membership: M,
): Promise<{ user: Actor; membership: M }> {
  // The membership gate has no gateway producer yet (`x-run402-user-membership`
  // is never set), so this helper cannot succeed. Require auth first (parity
  // with requireRole), then fail with an HONEST, distinct diagnostic — NOT
  // `InsufficientMembershipError`, which would falsely imply the platform
  // evaluated a membership the caller lacks. Forward-only API surface (see the
  // `@deprecated` tag on the namespace); replace this stub when the membership
  // gate ships.
  await requireUser();
  throw new MembershipGateNotWiredError(membership);
}

interface RequireFreshOptions {
  /** Human-friendly window expression. Accepted forms: `"10m"`, `"1h"`,
   *  `"5m30s"`, integer seconds (`"600"`). Anything that fails to parse
   *  is treated as 0s (immediate freshness required). */
  maxAge: string;
  /** Names of AMR methods one of which must have been verified within
   *  `maxAge`. When omitted, any flat `auth_time` proof within `maxAge`
   *  satisfies. */
  amr?: string[];
}

async function requireFresh(opts: RequireFreshOptions): Promise<void> {
  taintCacheBypass();
  const actor = await requireUser();
  const maxAgeSec = parseMaxAge(opts.maxAge);
  const nowSec = Math.floor(Date.now() / 1000);
  if (opts.amr && opts.amr.length > 0) {
    const ok = opts.amr.some((method) => {
      const ts = actor.amrTimes[method];
      return typeof ts === "number" && nowSec - ts <= maxAgeSec;
    });
    if (!ok) {
      throw new FreshnessRequiredError({
        maxAge: opts.maxAge,
        amr: opts.amr,
        returnTo: currentReturnTo(),
      });
    }
    return;
  }
  if (nowSec - actor.authTime <= maxAgeSec) return;
  throw new FreshnessRequiredError({
    maxAge: opts.maxAge,
    amr: [],
    returnTo: currentReturnTo(),
  });
}

function parseMaxAge(raw: string): number {
  if (/^\d+$/.test(raw)) return Number(raw);
  let total = 0;
  const re = /(\d+)\s*([smhd])/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const v = Number(m[1]);
    switch (m[2]!.toLowerCase()) {
      case "s":
        total += v;
        break;
      case "m":
        total += v * 60;
        break;
      case "h":
        total += v * 3600;
        break;
      case "d":
        total += v * 86400;
        break;
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// auth.fetch — relative-only with manual-redirect default
// ---------------------------------------------------------------------------

async function authFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const ctx = requireActiveContext("auth.fetch");
  const origin = `https://${ctx.host}`;
  const result = validateAuthFetchInput(input, { requestOrigin: origin });
  if (!result.ok) {
    throw new FetchAbsoluteUrlError({
      attempted: typeof input === "string" ? input : (input instanceof URL ? input.toString() : input.url),
      reason: result.reason,
    });
  }

  // The validated URL is same-origin. Default redirect: "manual" so
  // follow-cross-origin redirects don't smuggle our actor context to
  // hostile hops. If the caller opts in via init.redirect: "follow",
  // we still re-validate each hop — but native fetch doesn't expose
  // hop-by-hop hooks, so we emulate by doing manual redirects.
  const headers = new Headers(init?.headers);
  // Forward only headers the gateway expects from a same-origin SSR
  // fetch. Actor-context propagation is automatic (the inbound envelope
  // is propagated as a header; the SSR runtime already verified it).
  // Cookies are NEVER forwarded — never set the Cookie header here.
  headers.delete("cookie");
  headers.delete("Cookie");

  const requestInit: RequestInit = {
    ...init,
    headers,
    redirect: init?.redirect ?? "manual",
  };
  return fetch(result.normalized, requestInit);
}

// ---------------------------------------------------------------------------
// CSRF token helpers (double-submit token bound to the active session).
// ---------------------------------------------------------------------------

function csrfToken(): string {
  const ctx = getCurrentContext();
  if (!ctx || !ctx.actor) {
    // No session ⇒ no CSRF token. Returning an empty string would let
    // the form submit with no token at all; instead throw so the page
    // author knows the helper should be inside `<SignedIn>`-style
    // conditional rendering.
    throw new AuthRequiredError();
  }
  // The token derivation is HMAC(session_secret, "csrf") truncated to
  // 32 hex chars. Browsers double-submit; the gateway re-derives and
  // compares constant-time. We use the session_id + auth_time as the
  // poor-man's MAC input since the SDK doesn't have access to the
  // pepper; the gateway is the authoritative verifier (cross-checks
  // against internal.sessions via session_id). This is double-submit
  // CSRF, not a primary control — the Origin check is.
  const input = `${ctx.actor.sessionId}:${ctx.actor.authTime}:csrf`;
  return crypto.createHash("sha256").update(input, "utf8").digest("hex").slice(0, 32);
}

function csrfField(): string {
  return `<input type="hidden" name="_csrf" value="${escapeHtml(csrfToken())}">`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------------------
// Session bridge — createResponseFromIdentity / endResponse.
//
// These delegate to the platform routes; the SDK never holds raw secrets.
// The session-minting route lives at POST /auth/v1/sessions/from-identity
// (gateway-internal). The endResponse helper just emits the clear-cookie
// Set-Cookie + body and lets the gateway-side mounted CSRF/origin check
// run on the calling capability's response.
// ---------------------------------------------------------------------------

async function createResponseFromIdentity(
  opts: CreateResponseFromIdentityOptions,
): Promise<Response> {
  const ctx = requireActiveContext("auth.sessions.createResponseFromIdentity");
  const origin = `https://${ctx.host}`;
  // Delegate to the platform route. The route verifies the proof
  // against the project's registered verifier (wallet/oidc/custom) and
  // mints the session via the internal-only primitive. The Response
  // already carries Set-Cookie and the canonical {ok, user} body.
  const res = await fetch(`${origin}/auth/v1/sessions/from-identity`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(opts),
    redirect: "manual",
  });
  return res;
}

/** Header on the function's RETURNED Response that the gateway's routed-invoke
 *  post-processor materializes into a host-bound `Set-Cookie` — AFTER it
 *  checks the INVOKED function's declared `auth.sessionMint` capability
 *  (server-side; service-key presence is NOT sufficient). The gateway always
 *  strips this header before the client sees it. Kept in sync with the
 *  gateway constant of the same name. */
export const MINT_DIRECTIVE_HEADER = "x-run402-mint-directive";

/**
 * Tenant-assertion session mint (D6) — for the tenant-owned-credential case
 * where the calling function already verified the credential against its OWN
 * store (bcrypt, custom DB, external IdP). This is NOT a proof-based mint;
 * the tenant is *vouching*, so it is capability-gated (`auth.sessionMint` in
 * the function's deploy spec), audited, and host-gated — all enforced by the
 * gateway when it materializes the directive below.
 *
 * The shape is agent-proof: the platform derives `issuer: "tenant:<tenant>"`
 * and `amr` from `method` (`password` → `tenant_password`, `sso` →
 * `tenant_sso`). Arbitrary amr is available only via `advanced.amr`.
 *
 * Mechanism (pattern B): the SDK never holds the session secret, so it returns
 * a Response carrying a `x-run402-mint-directive` header. The gateway reads it,
 * verifies the invoked function declared `auth.sessionMint` (else
 * `R402_AUTH_UNTRUSTED_CONTEXT`), validates the subject, mints the host-bound
 * cookie, writes an audit row, strips the directive, and rewrites the body to
 * `{ ok, user }`. Return it directly from your handler: `return
 * auth.sessions.createResponseFromTenantAssertion({ tenant, user, method })`.
 */
async function createResponseFromTenantAssertion(
  opts: CreateResponseFromTenantAssertionOptions,
): Promise<Response> {
  // Must run inside a real routed invocation (not module scope / prerender).
  requireActiveContext("auth.sessions.createResponseFromTenantAssertion");

  // Fast SDK-side validation with the teaching fix. The gateway re-validates
  // and additionally enforces `(project_id, issuer, user.id)` uniqueness.
  const tenant = typeof opts?.tenant === "string" ? opts.tenant.trim() : "";
  if (!tenant) {
    throw new TenantSubjectInvalidError({ reason: "missing `tenant`" });
  }
  const user = opts?.user;
  if (!user || typeof user !== "object") {
    throw new TenantSubjectInvalidError({ reason: "missing `user`" });
  }
  const id = typeof user.id === "string" ? user.id.trim() : "";
  if (!id) {
    throw new TenantSubjectInvalidError({
      reason: "`user.id` is required (a stable primary key, not a bare email)",
    });
  }
  const email = typeof user.email === "string" ? user.email.trim() : "";
  // The classic mistake: passing the email AS the id. A stable id is required.
  if (id.includes("@") && id === email) {
    throw new TenantSubjectInvalidError({
      reason: "`user.id` must be a stable primary key, not the email",
    });
  }
  if (opts.method !== "password" && opts.method !== "sso") {
    throw new TenantSubjectInvalidError({
      reason: '`method` must be "password" or "sso"',
    });
  }

  const directive = {
    v: 1 as const,
    tenant,
    user: {
      id,
      email,
      emailVerified: user.emailVerified === true,
      ...(user.displayName ? { displayName: String(user.displayName) } : {}),
      ...(user.avatarUrl ? { avatarUrl: String(user.avatarUrl) } : {}),
    },
    method: opts.method,
    ...(opts.advanced?.amr ? { advanced: { amr: opts.advanced.amr } } : {}),
  };
  const encoded = Buffer.from(JSON.stringify(directive), "utf8").toString(
    "base64url",
  );
  // The response now depends on per-request actor state — taint the SSR cache.
  taintCacheBypass();
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      [MINT_DIRECTIVE_HEADER]: encoded,
    },
  });
}

/** Returns the canonical invalid-credentials error for the tenant-owned
 *  credential case. A FUNCTION, not a constructor (D9): write
 *  `throw auth.invalidCredentials()` — never `new auth.InvalidCredentialsError()`.
 *  Renders the canonical `R402_AUTH_INVALID_CREDENTIALS` envelope (distinct
 *  from `R402_AUTH_MAGIC_LINK_INVALID`); no session is minted. */
function invalidCredentials(): InvalidCredentialsError {
  return new InvalidCredentialsError();
}

async function endResponse(): Promise<Response> {
  const ctx = requireActiveContext("auth.sessions.endResponse");
  const origin = `https://${ctx.host}`;
  const res = await fetch(`${origin}/auth/v1/sessions/end`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    redirect: "manual",
  });
  return res;
}

// ---------------------------------------------------------------------------
// Identity linking.
// ---------------------------------------------------------------------------

/** §4.5: the shipped top-level `auth.identities.link` is renamed/moved to
 *  `auth.account.identities.startLink` (the redirect+proof ceremony that links
 *  an OAuth identity to the already-signed-in account). Throws
 *  `R402_AUTH_RENAMED_EXPORT` teaching the move. (It also fetched a gateway
 *  route that never existed — see #429 — so it was non-functional regardless.) */
async function linkIdentity(_opts: IdentityLinkOptions): Promise<void> {
  throw new RenamedExportError({
    oldName: "auth.identities.link",
    newName: "auth.account.identities.startLink",
  });
}

// ---------------------------------------------------------------------------
// Account security (§4). `getSecurity()` is the everyday rich read; the
// advanced mutation tier (setPassword / passkeys / sessions / identities) is
// demoted and lands in a follow-up increment.
// ---------------------------------------------------------------------------

/**
 * The rich settings/security read for the current actor (§4.3). Distinct from
 * the cheap per-request `auth.user()` — returns the ownership-qualified
 * `AccountSecurity` projection (has_run402_password, run402_passkey_count,
 * run402_identities, tenant_assertions, …) or `null` when anonymous.
 *
 * Resolves the actor exactly like `auth.user()` (cookie envelope on browser
 * SSR; Bearer on direct/machine — §4.7/D15), mints a short-lived actor JWT
 * (the same channel `db()` uses), and fetches the gateway projection route.
 */
async function getSecurity(): Promise<AccountSecurity | null> {
  const ctx = getCurrentContext();
  if (!ctx) return null;
  const actor = await user();
  if (!actor) return null;
  if (!config.JWT_SECRET) return null;
  const nowSec = Math.floor(Date.now() / 1000);
  let token: string;
  try {
    token = jwt.sign(
      {
        sub: actor.id,
        role: "authenticated" as const,
        email: actor.email,
        project_id: actor.projectId,
        iss: "agentdb" as const,
        iat: nowSec,
        exp: nowSec + 60,
      },
      config.JWT_SECRET,
    );
  } catch {
    return null;
  }
  // Fetch the gateway (config.API_BASE = RUN402_API_BASE) directly — NOT the
  // public tenant subdomain (ctx.host). The /auth/v1/account/* routes live on
  // the gateway; a Lambda-to-subdomain round-trip via CloudFront does not reach
  // them. `app_origin` still carries the tenant host for rpId validation.
  const appOrigin = `https://${ctx.host}`;
  let res: Response;
  try {
    res = await fetch(
      `${config.API_BASE}/auth/v1/account/security?app_origin=${encodeURIComponent(appOrigin)}`,
      {
        headers: {
          apikey: config.ANON_KEY ?? "",
          authorization: `Bearer ${token}`,
          accept: "application/json",
        },
        redirect: "manual",
      },
    );
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const data = (await res.json().catch(() => null)) as
    | (Omit<AccountSecurity, "user"> & { user?: unknown })
    | null;
  if (!data) return null;
  // The route returns a `user` projection; the SDK overlays the richer Actor.
  return { ...data, user: actor };
}

/** Throwing variant of `getSecurity()` (§4.3). */
async function requireSecurity(): Promise<AccountSecurity> {
  const security = await getSecurity();
  if (!security) throw new AuthRequiredError();
  return security;
}

// ---------------------------------------------------------------------------
// §4.4 advanced account-security mutation tier. Server-side, context-actor
// only. Each method mints a short-lived actor JWT (same channel as
// getSecurity) — including `auth_time` so the gateway can enforce freshness
// callee-side — and calls the Bearer-authed /auth/v1/account/* routes. NOT in
// the everyday docs; the everyday path is the <AccountSecurity> component.
// ---------------------------------------------------------------------------

/** Mint a short-lived actor JWT for an advanced-tier account call. Includes
 *  `auth_time` (the actor's last-auth from the verified browser-session
 *  envelope) so the gateway's sensitive-mutation freshness gate can read it. */
function mintAdvancedActorToken(actor: Actor): string | null {
  if (!config.JWT_SECRET) return null;
  const nowSec = Math.floor(Date.now() / 1000);
  try {
    return jwt.sign(
      {
        sub: actor.id,
        role: "authenticated" as const,
        email: actor.email,
        project_id: actor.projectId,
        iss: "agentdb" as const,
        iat: nowSec,
        exp: nowSec + 60,
        auth_time: actor.authTime,
      },
      config.JWT_SECRET,
    );
  } catch {
    return null;
  }
}

/** Call a Bearer-authed /auth/v1/account/* route with the context actor's
 *  minted JWT. Throws AuthRequiredError when anonymous / outside a request,
 *  FreshnessRequiredError on a freshness 401, and a generic error otherwise. */
async function accountAdvancedFetch(
  path: string,
  init: { method: "GET" | "POST"; body?: Record<string, unknown> },
): Promise<unknown> {
  const ctx = getCurrentContext();
  const actor = ctx ? await user() : null;
  if (!ctx || !actor) throw new AuthRequiredError();
  const token = mintAdvancedActorToken(actor);
  if (!token) throw new AuthRequiredError();
  // Gateway directly (config.API_BASE), NOT the tenant subdomain (ctx.host) —
  // the /auth/v1/account/* routes live on the gateway and a Lambda-to-subdomain
  // round-trip via CloudFront does not reach them (see getSecurity).
  const res = await fetch(`${config.API_BASE}${path}`, {
    method: init.method,
    headers: {
      apikey: config.ANON_KEY ?? "",
      authorization: `Bearer ${token}`,
      accept: "application/json",
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    redirect: "manual",
  });
  if (res.status === 401) {
    const data = (await res.json().catch(() => null)) as { code?: string } | null;
    if (data?.code === "R402_AUTH_FRESHNESS_REQUIRED") {
      throw new FreshnessRequiredError({ maxAge: "5m", amr: [] });
    }
    throw new AuthRequiredError();
  }
  if (!res.ok) {
    throw new Error(`auth.account.* request to ${path} failed: ${res.status}`);
  }
  return (await res.json().catch(() => ({}))) as unknown;
}

/** §4.4 — set or change the signed-in user's Run402 password. Callee-enforced
 *  freshness (re-auth within 5 min) — throws FreshnessRequiredError otherwise.
 *  On success the gateway rotates (revokes) the user's other sessions. */
async function setPassword(newPassword: string, _opts?: { maxAge?: string }): Promise<void> {
  await accountAdvancedFetch("/auth/v1/account/password", {
    method: "POST",
    body: { new_password: newPassword },
  });
}

/** §4.4 — sign out of every browser session for the context actor. */
async function signOutEverywhere(): Promise<{ revoked_count: number }> {
  const out = (await accountAdvancedFetch("/auth/v1/account/sign-out-everywhere", {
    method: "POST",
    body: {},
  })) as { revoked_count?: number };
  return { revoked_count: typeof out.revoked_count === "number" ? out.revoked_count : 0 };
}

const accountPasskeys = {
  list: async (): Promise<unknown[]> => {
    const out = (await accountAdvancedFetch("/auth/v1/account/passkeys", { method: "GET" })) as {
      passkeys?: unknown[];
    };
    return out.passkeys ?? [];
  },
  remove: async (passkeyId: string): Promise<void> => {
    await accountAdvancedFetch("/auth/v1/account/passkeys/remove", {
      method: "POST",
      body: { passkey_id: passkeyId },
    });
  },
  /** Passkey registration is a browser WebAuthn ceremony — it cannot run
   *  server-side. Use `<AccountSecurity sections={["passkeys"]}/>` or the
   *  hosted `/auth/passkeys/register` flow. */
  add: (): never => {
    throw new Error(
      "auth.account.passkeys.add() can't run server-side: passkey registration is a browser WebAuthn ceremony. Use <AccountSecurity sections={[\"passkeys\"]}/> or the hosted /auth/passkeys/register flow.",
    );
  },
};

const accountIdentities = {
  list: async (): Promise<unknown[]> => {
    const out = (await accountAdvancedFetch("/auth/v1/account/identities", { method: "GET" })) as {
      identities?: unknown[];
    };
    return out.identities ?? [];
  },
  /** §4.5 — begin the OAuth link-to-existing-account ceremony. Mints the
   *  context actor's JWT and calls the gateway `intent:"link"` start route,
   *  returning the provider authorization URL for the caller to redirect to.
   *  The resulting identity is written against the signed-in account (NOT a
   *  new sign-in). `redirectUrl` must be a project-allowed origin. */
  startLink: async (opts: {
    provider: string;
    redirectUrl: string;
    mode?: "redirect" | "popup";
  }): Promise<{ authorizationUrl: string; expiresIn: number }> => {
    if (!opts?.provider) throw new Error("auth.account.identities.startLink: provider is required");
    if (!opts?.redirectUrl)
      throw new Error("auth.account.identities.startLink: redirectUrl is required");
    const out = (await accountAdvancedFetch(`/auth/v1/oauth/${opts.provider}/start`, {
      method: "POST",
      body: { intent: "link", redirect_url: opts.redirectUrl, mode: opts.mode ?? "redirect" },
    })) as { authorization_url?: string; expires_in?: number };
    if (!out.authorization_url) {
      throw new Error("auth.account.identities.startLink: gateway returned no authorization_url");
    }
    return {
      authorizationUrl: out.authorization_url,
      expiresIn: typeof out.expires_in === "number" ? out.expires_in : 600,
    };
  },
  unlink: async (opts: { provider: string; subject: string }): Promise<void> => {
    await accountAdvancedFetch("/auth/v1/account/identities/unlink", {
      method: "POST",
      body: { provider: opts.provider, subject: opts.subject },
    });
  },
};

const accountSessions = {
  list: async (): Promise<unknown[]> => {
    const out = (await accountAdvancedFetch("/auth/v1/account/sessions", { method: "GET" })) as {
      sessions?: unknown[];
    };
    return out.sessions ?? [];
  },
  revoke: async (sessionId: string): Promise<void> => {
    await accountAdvancedFetch("/auth/v1/account/sessions/revoke", {
      method: "POST",
      body: { session_id: sessionId },
    });
  },
};

/** `auth.account.*` proxy — `getSecurity`/`requireSecurity` (everyday read) +
 *  the §4.4 advanced mutation members (`setPassword`, `passkeys`, `identities`,
 *  `sessions`, `signOutEverywhere`) are the real members; the shipped throwing
 *  names (`get`, `signIn`, `login`, `currentUser`) and typos throw the
 *  structured unknown-export error (§4.6). */
const ACCOUNT_HALLUCINATED_NAMES: Record<string, string> = {
  get: "auth.account.getSecurity() / auth.account.requireSecurity()",
  signIn:
    "auth.sessions.createResponseFromTenantAssertion({...}) / createResponseFromIdentity({...})",
  login: "auth.sessions.createResponseFromTenantAssertion({...})",
  currentUser: "auth.user()",
  user: "auth.user()",
};

const baseAccount = {
  getSecurity,
  requireSecurity,
  setPassword,
  signOutEverywhere,
  passkeys: accountPasskeys,
  identities: accountIdentities,
  sessions: accountSessions,
};

const account: AuthNamespace["account"] = new Proxy(baseAccount, {
  get(target, prop, receiver) {
    if (typeof prop === "string" && !(prop in target)) {
      throw new UnknownExportError({
        attemptedName: `auth.account.${prop}`,
        canonicalName:
          ACCOUNT_HALLUCINATED_NAMES[prop] ??
          "auth.account.getSecurity() / auth.account.requireSecurity()",
      });
    }
    return Reflect.get(target, prop, receiver);
  },
});

// ---------------------------------------------------------------------------
// SDK proxy intercepting hallucinated names.
// ---------------------------------------------------------------------------

const HALLUCINATED_NAMES: Record<string, string> = {
  session: "auth.user() then read .sessionId / .amr / etc.",
  getSession: "auth.user()",
  currentUser: "auth.user()",
  currentSession: "auth.user()",
  requireAuth: "auth.requireUser()",
  middleware: "auth.csrfField() / @run402/astro middleware",
  signIn: "POST /auth/sign-in (browser form) or auth.sessions.createResponseFromIdentity({...})",
  signout: "auth.sessions.endResponse()",
  signOut: "auth.sessions.endResponse()",
  logout: "auth.sessions.endResponse()",
  login: "auth.sessions.createResponseFromIdentity({...})",
  redirectToSignIn: "auth.requireUser() — platform redirects",
  getUser: "auth.user()",
  getToken: "auth.requireUser() then user.sessionId (tokens are not exposed)",
  protect: "auth.requireUser() / auth.requireRole(...)",
  // Section 5 — forbidden legacy mint names + common top-level typos.
  signInResponse:
    "throw auth.invalidCredentials() on failure, then auth.sessions.createResponseFromTenantAssertion({ tenant, user, method })",
  InvalidCredentialsError: "auth.invalidCredentials()",
  createResponseFromTenantSubject:
    "auth.sessions.createResponseFromTenantAssertion({ tenant, user, method })",
  createResponseFromTenantAssertion:
    "auth.sessions.createResponseFromTenantAssertion({ tenant, user, method })",
  createResponseFromIdentity:
    "auth.sessions.createResponseFromIdentity({ provider, subject, proof, amr })",
};

// ---------------------------------------------------------------------------
// Construct the namespace object and proxy it so hallucinated names throw
// the structured envelope.
// ---------------------------------------------------------------------------

interface AuthNamespace {
  user(): Promise<Actor | null>;
  requireUser(): Promise<Actor>;
  /** Assert the caller's role. Two topologies:
   *   - default (Bearer/API + edge gate): reads the gateway-resolved
   *     `x-run402-user-role` header; throws `RoleGateNotConfiguredError` if no
   *     `requireRole` gate is declared.
   *   - `{ from }` (cookie-session SSR): self-contained — resolves the cookie
   *     user and reads their role from your tenant table (RLS-bypass), no edge
   *     gate. Throws `AuthRequiredError` (anonymous) / `InsufficientRoleError`. */
  requireRole<const R extends string>(
    role: R,
    opts?: { from?: RoleSource },
  ): Promise<{ user: Actor; role: R }>;
  /** Non-throwing read of the resolved role, or `null`. Default reads the
   *  edge-gate `x-run402-user-role` header; `{ from }` reads it from your
   *  tenant table for cookie-session SSR. Branch on it (and `Astro.redirect`
   *  yourself); `requireRole` is the throwing hard assert. */
  role(opts?: { from?: RoleSource }): Promise<string | null>;
  /** @deprecated Forward-only API — the membership gate has no gateway producer
   *  yet, so this always throws `MembershipGateNotWiredError`. Use
   *  `requireRole` (a role gate) until membership gates ship. */
  requireMembership<const M extends string>(
    membership: M,
  ): Promise<{ user: Actor; membership: M }>;
  requireFresh(opts: RequireFreshOptions): Promise<void>;
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  csrfToken(): string;
  csrfField(): string;
  /** Canonical invalid-credentials failure for the tenant-owned credential
   *  case. A function (not a constructor): `throw auth.invalidCredentials()`. */
  invalidCredentials(): InvalidCredentialsError;
  /** Account security (§4). `getSecurity`/`requireSecurity` are the everyday
   *  rich read; the §4.4 advanced mutation tier (callee-enforced freshness,
   *  context-actor only) backs the same flows as `<AccountSecurity>`. */
  account: {
    getSecurity(): Promise<AccountSecurity | null>;
    requireSecurity(): Promise<AccountSecurity>;
    setPassword(newPassword: string, opts?: { maxAge?: string }): Promise<void>;
    signOutEverywhere(): Promise<{ revoked_count: number }>;
    passkeys: {
      list(): Promise<unknown[]>;
      remove(passkeyId: string): Promise<void>;
      add(): never;
    };
    identities: {
      list(): Promise<unknown[]>;
      /** §4.5 — begin the OAuth link-to-existing-account ceremony for the
       *  context actor. Mints a short-lived actor JWT and asks the gateway
       *  (`intent:"link"`) for a provider authorization URL bound to the
       *  signed-in user; the caller redirects the browser there. After the
       *  provider round-trip the identity is written against THIS account
       *  (not a new sign-in). `redirectUrl` must be an allowed origin for the
       *  project. This is link-to-existing — distinct from sign-in-with. */
      startLink(opts: {
        provider: string;
        redirectUrl: string;
        mode?: "redirect" | "popup";
      }): Promise<{ authorizationUrl: string; expiresIn: number }>;
      unlink(opts: { provider: string; subject: string }): Promise<void>;
    };
    sessions: {
      list(): Promise<unknown[]>;
      revoke(sessionId: string): Promise<void>;
    };
  };
  identities: {
    link(opts: IdentityLinkOptions): Promise<void>;
  };
  sessions: {
    createResponseFromIdentity(opts: CreateResponseFromIdentityOptions): Promise<Response>;
    createResponseFromTenantAssertion(
      opts: CreateResponseFromTenantAssertionOptions,
    ): Promise<Response>;
    endResponse(): Promise<Response>;
  };
}

/** `auth.sessions.*` proxy — mirrors the top-level `auth` proxy so forbidden
 *  legacy names (`createResponseFromTenantSubject`, `signInResponse`) and
 *  typos throw the structured unknown-export error pointing at the canonical
 *  primitive, instead of silently returning `undefined`. */
const SESSIONS_HALLUCINATED_NAMES: Record<string, string> = {
  createResponseFromTenantSubject:
    "auth.sessions.createResponseFromTenantAssertion({ tenant, user, method })",
  signInResponse:
    "auth.sessions.createResponseFromTenantAssertion({ tenant, user, method })",
  fromIdentity: "auth.sessions.createResponseFromIdentity({ ... })",
  fromTenantAssertion:
    "auth.sessions.createResponseFromTenantAssertion({ tenant, user, method })",
};

const baseSessions = {
  createResponseFromIdentity,
  createResponseFromTenantAssertion,
  endResponse,
};

const sessions: AuthNamespace["sessions"] = new Proxy(baseSessions, {
  get(target, prop, receiver) {
    if (typeof prop === "string" && !(prop in target)) {
      throw new UnknownExportError({
        attemptedName: `auth.sessions.${prop}`,
        canonicalName:
          SESSIONS_HALLUCINATED_NAMES[prop] ??
          "auth.sessions.createResponseFromIdentity / createResponseFromTenantAssertion / endResponse",
      });
    }
    return Reflect.get(target, prop, receiver);
  },
});

const baseAuth: AuthNamespace = {
  user,
  requireUser,
  requireRole,
  role,
  requireMembership,
  requireFresh,
  fetch: authFetch,
  csrfToken,
  csrfField,
  invalidCredentials,
  account,
  identities: {
    link: linkIdentity,
  },
  sessions,
};

/** Hallucinated-name proxy. Property access for a name not in
 *  `baseAuth` throws `R402_AUTH_UNKNOWN_EXPORT` with the canonical
 *  replacement. Hot-path access (existing keys) returns the actual
 *  helper — proxy overhead is one Reflect.has + Reflect.get. */
export const auth: AuthNamespace = new Proxy(baseAuth, {
  get(target, prop, receiver) {
    if (typeof prop === "string" && !(prop in target)) {
      const replacement = HALLUCINATED_NAMES[prop];
      if (replacement) {
        throw new UnknownExportError({
          attemptedName: `auth.${prop}`,
          canonicalName: replacement,
        });
      }
      throw new UnknownExportError({
        attemptedName: `auth.${prop}`,
        canonicalName: "auth.user / auth.requireUser / auth.requireRole / auth.requireMembership",
      });
    }
    return Reflect.get(target, prop, receiver);
  },
});

/** Throwing-sentinel exports for the top hallucinated *bare* names.
 *  ESM `import { getUser } from "@run402/functions"` can be intercepted
 *  only by a real export — so we ship these as exported throwing
 *  functions. They're marked `@deprecated` in the type JSDoc; the SDK
 *  proxy + lint registry + `run402 doctor` scan all flag the import
 *  before runtime if the user is running the tooling.
 *
 *  Excluded from public docs and AGENTS.md per the spec.
 */

/** @deprecated Use `auth.user()` or `auth.requireUser()`. */
export function getSession(): never {
  throw new UnknownExportError({ attemptedName: "getSession", canonicalName: "auth.user()" });
}

/** @deprecated Use `auth.user()`. */
export function currentUser(): never {
  throw new UnknownExportError({ attemptedName: "currentUser", canonicalName: "auth.user()" });
}

/** @deprecated Use `auth.user()`. */
export function getCurrentUser(): never {
  throw new UnknownExportError({ attemptedName: "getCurrentUser", canonicalName: "auth.user()" });
}

/** @deprecated Use `auth.user()`. */
export function getServerSession(): never {
  throw new UnknownExportError({
    attemptedName: "getServerSession",
    canonicalName: "auth.user()",
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function actorContextToPublicActor(
  ctxActor: ActorContext | null,
  projectId: string,
): Actor | null {
  if (!ctxActor) return null;
  return {
    id: ctxActor.id,
    projectId,
    sessionId: ctxActor.sessionId,
    email: ctxActor.email,
    is_test: ctxActor.isTest === true ? true : undefined,
    emailVerified: ctxActor.emailVerified,
    authTime: ctxActor.authTime,
    amr: [...ctxActor.amr],
    amrTimes: { ...ctxActor.amrTimes },
  };
}

function currentReturnTo(): string | undefined {
  const ctx = getCurrentContext();
  if (!ctx) return undefined;
  return ctx.request.url;
}

// Re-export the public types so consumers can `import type { Actor }`.
export type {
  Actor,
  IdentityProof,
  TenantUser,
  CreateResponseFromTenantAssertionOptions,
  AccountSecurity,
  Run402Identity,
  TenantAssertionRef,
} from "./types.js";
export {
  AuthRequiredError,
  InsufficientRoleError,
  InsufficientMembershipError,
  RoleGateNotConfiguredError,
  MembershipGateNotWiredError,
  FreshnessRequiredError,
  FetchAbsoluteUrlError,
  PrerenderedError,
  UnknownExportError,
  SessionBridgeUnverifiedError,
  IdentityLinkConflictError,
  UnknownIdentityError,
  InvalidCredentialsError,
  TenantSubjectInvalidError,
  RenamedExportError,
  Run402AuthError,
} from "./errors.js";
