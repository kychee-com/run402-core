/**
 * Structured errors thrown by the `auth.*` namespace.
 *
 * The platform error envelope (`R402_AUTH_*` codes) is the wire shape;
 * these Error subclasses are how user code catches them in TypeScript.
 *
 * The docs say "do not catch auth errors" — the platform's response-shape
 * decision (303 redirect for HTML, 401/403 envelope for JSON) already does
 * the right thing. But framework code, middleware, and test harnesses
 * occasionally need typed catches; that's what these classes are for.
 */

export type Run402AuthCode =
  | "R402_AUTH_REQUIRED"
  | "R402_AUTH_INSUFFICIENT_ROLE"
  | "R402_AUTH_INSUFFICIENT_MEMBERSHIP"
  | "R402_AUTH_ROLE_GATE_NOT_CONFIGURED"
  | "R402_AUTH_MEMBERSHIP_GATE_NOT_WIRED"
  | "R402_AUTH_FRESHNESS_REQUIRED"
  | "R402_AUTH_PRERENDERED"
  | "R402_AUTH_FETCH_ABSOLUTE_URL"
  | "R402_AUTH_UNKNOWN_EXPORT"
  | "R402_AUTH_SESSION_BRIDGE_UNVERIFIED"
  | "R402_AUTH_IDENTITY_LINK_CONFLICT"
  | "R402_AUTH_UNKNOWN_IDENTITY"
  | "R402_AUTH_TENANT_SUFFIX_REQUIRED"
  | "R402_AUTH_RETURN_TO_INVALID"
  | "R402_AUTH_REDUNDANT_USER_FILTER"
  | "R402_AUTH_INVALID_CREDENTIALS"
  | "R402_AUTH_TENANT_SUBJECT_INVALID"
  | "R402_AUTH_UNTRUSTED_CONTEXT"
  | "R402_AUTH_RENAMED_EXPORT";

export class Run402AuthError extends Error {
  readonly code: Run402AuthCode;
  readonly status: number;
  readonly details: Record<string, unknown>;
  readonly suggestedFix?: string;
  readonly docs?: string;

  constructor(opts: {
    code: Run402AuthCode;
    status: number;
    message: string;
    details?: Record<string, unknown>;
    suggestedFix?: string;
    docs?: string;
  }) {
    super(opts.message);
    this.name = "Run402AuthError";
    this.code = opts.code;
    this.status = opts.status;
    this.details = opts.details ?? {};
    if (opts.suggestedFix) this.suggestedFix = opts.suggestedFix;
    if (opts.docs) this.docs = opts.docs;
  }
}

/** Subclass identifying the "anonymous on a protected route" case. The
 *  middleware decides whether to surface this as a 303 (HTML) or a 401
 *  envelope (JSON); user code never needs to make that choice. */
export class AuthRequiredError extends Run402AuthError {
  constructor(opts: { returnTo?: string } = {}) {
    super({
      code: "R402_AUTH_REQUIRED",
      status: 401,
      message: "Authentication required.",
      details: opts.returnTo ? { returnTo: opts.returnTo } : {},
      suggestedFix: "Use: const user = await auth.requireUser()",
      docs: "https://run402.com/errors/#R402_AUTH_REQUIRED",
    });
    this.name = "AuthRequiredError";
  }
}

export class InsufficientRoleError extends Run402AuthError {
  readonly requiredRole: string;
  constructor(requiredRole: string) {
    super({
      code: "R402_AUTH_INSUFFICIENT_ROLE",
      status: 403,
      message: `Authenticated user lacks required role: ${requiredRole}.`,
      details: { required_role: requiredRole },
    });
    this.name = "InsufficientRoleError";
    this.requiredRole = requiredRole;
  }
}

export class InsufficientMembershipError extends Run402AuthError {
  readonly requiredMembership: string;
  constructor(requiredMembership: string) {
    super({
      code: "R402_AUTH_INSUFFICIENT_MEMBERSHIP",
      status: 403,
      message: `Authenticated user lacks required membership: ${requiredMembership}.`,
      details: { required_membership: requiredMembership },
    });
    this.name = "InsufficientMembershipError";
    this.requiredMembership = requiredMembership;
  }
}

/** Thrown by `auth.requireRole(role)` when NO role gate resolved the request
 *  (the `x-run402-user-role` header is absent). This is a deploy-spec
 *  misconfiguration — the function asserts a role but declares no `requireRole`
 *  gate — NOT an authorization denial, so it is server-class (500), distinct
 *  from `InsufficientRoleError` (403). The distinction is reliable because the
 *  gateway rejects a disallowed role with 403 BEFORE dispatch, so an executing
 *  function never reflects a denied role — only an allowed role, or no gate. */
export class RoleGateNotConfiguredError extends Run402AuthError {
  readonly requiredRole: string;
  constructor(requiredRole: string) {
    super({
      code: "R402_AUTH_ROLE_GATE_NOT_CONFIGURED",
      status: 500,
      message: `auth.requireRole(${JSON.stringify(
        requiredRole,
      )}) was called but no requireRole gate is declared for this function — the gateway never resolved a role.`,
      details: { required_role: requiredRole },
      suggestedFix:
        "Declare a `requireRole` gate in this function's deploy spec (table/idColumn/roleColumn/allowed), or remove the auth.requireRole(...) call.",
      docs: "https://run402.com/errors/#R402_AUTH_ROLE_GATE_NOT_CONFIGURED",
    });
    this.name = "RoleGateNotConfiguredError";
    this.requiredRole = requiredRole;
  }
}

/** Thrown by `auth.requireMembership(membership)`. The membership gate has no
 *  gateway producer yet (`x-run402-user-membership` is never set), so the
 *  helper cannot succeed. Surfaced as a distinct, server-class (501 Not
 *  Implemented) diagnostic instead of `InsufficientMembershipError` (403),
 *  which would falsely imply the platform evaluated a membership the caller
 *  lacks. Forward-only API surface until the membership gate ships. */
export class MembershipGateNotWiredError extends Run402AuthError {
  readonly requiredMembership: string;
  constructor(requiredMembership: string) {
    super({
      code: "R402_AUTH_MEMBERSHIP_GATE_NOT_WIRED",
      status: 501,
      message: `auth.requireMembership(${JSON.stringify(
        requiredMembership,
      )}) is not available: the membership gate is not yet wired on the gateway.`,
      details: { required_membership: requiredMembership },
      suggestedFix:
        "Membership gates are not implemented yet. Use auth.requireRole(...) with a role gate, or gate in code via auth.user().",
      docs: "https://run402.com/errors/#R402_AUTH_MEMBERSHIP_GATE_NOT_WIRED",
    });
    this.name = "MembershipGateNotWiredError";
    this.requiredMembership = requiredMembership;
  }
}

export class FreshnessRequiredError extends Run402AuthError {
  readonly maxAge: string;
  readonly amr: string[];
  constructor(opts: { maxAge: string; amr: string[]; returnTo?: string }) {
    super({
      code: "R402_AUTH_FRESHNESS_REQUIRED",
      status: 401,
      message: `Fresh re-auth proof required within ${opts.maxAge} matching one of: ${opts.amr.join(", ")}.`,
      details: { max_age: opts.maxAge, amr: opts.amr, returnTo: opts.returnTo ?? null },
    });
    this.name = "FreshnessRequiredError";
    this.maxAge = opts.maxAge;
    this.amr = opts.amr;
  }
}

export class FetchAbsoluteUrlError extends Run402AuthError {
  constructor(opts: { attempted: string; reason: string }) {
    super({
      code: "R402_AUTH_FETCH_ABSOLUTE_URL",
      status: 500,
      message: `auth.fetch refused URL "${opts.attempted}": ${opts.reason}`,
      details: { attempted_url: opts.attempted, reason: opts.reason },
      suggestedFix: "auth.fetch accepts only same-origin paths. Cross-origin calls belong in your own service module.",
      docs: "https://run402.com/errors/#R402_AUTH_FETCH_ABSOLUTE_URL",
    });
    this.name = "FetchAbsoluteUrlError";
  }
}

export class PrerenderedError extends Run402AuthError {
  constructor(opts: { sdkFunction: string }) {
    super({
      code: "R402_AUTH_PRERENDERED",
      status: 500,
      message: `${opts.sdkFunction} cannot run in prerendered context.`,
      details: { sdk_function: opts.sdkFunction },
      suggestedFix: "Set `export const prerender = false` or use a server island.",
      docs: "https://run402.com/errors/#R402_AUTH_PRERENDERED",
    });
    this.name = "PrerenderedError";
  }
}

export class UnknownExportError extends Run402AuthError {
  readonly attemptedName: string;
  readonly canonicalName: string;
  constructor(opts: { attemptedName: string; canonicalName: string }) {
    super({
      code: "R402_AUTH_UNKNOWN_EXPORT",
      status: 500,
      message: `Unknown SDK export: ${opts.attemptedName}. Use ${opts.canonicalName} instead.`,
      details: {
        attempted_name: opts.attemptedName,
        canonical_name: opts.canonicalName,
        import_line: 'import { auth } from "@run402/functions"',
      },
      suggestedFix: `Use: ${opts.canonicalName}`,
      docs: "https://run402.com/errors/#R402_AUTH_UNKNOWN_EXPORT",
    });
    this.name = "UnknownExportError";
    this.attemptedName = opts.attemptedName;
    this.canonicalName = opts.canonicalName;
  }
}

export class SessionBridgeUnverifiedError extends Run402AuthError {
  constructor(opts: { reason: string }) {
    super({
      code: "R402_AUTH_SESSION_BRIDGE_UNVERIFIED",
      status: 401,
      message: `Session bridge refused unverified proof: ${opts.reason}`,
      details: { reason: opts.reason },
      suggestedFix: "Pass a verifiable proof to auth.sessions.createResponseFromIdentity({provider, subject, proof, amr, createUser?}).",
      docs: "https://run402.com/errors/#R402_AUTH_SESSION_BRIDGE_UNVERIFIED",
    });
    this.name = "SessionBridgeUnverifiedError";
  }
}

export class IdentityLinkConflictError extends Run402AuthError {
  constructor(opts: { provider: string; subject: string }) {
    super({
      code: "R402_AUTH_IDENTITY_LINK_CONFLICT",
      status: 409,
      message: `Identity (${opts.provider}, ${opts.subject}) is already linked to another user.`,
      details: { provider: opts.provider, subject: opts.subject },
    });
    this.name = "IdentityLinkConflictError";
  }
}

export class UnknownIdentityError extends Run402AuthError {
  constructor(opts: { provider: string; subject: string }) {
    super({
      code: "R402_AUTH_UNKNOWN_IDENTITY",
      status: 401,
      message: `Identity (${opts.provider}, ${opts.subject}) not found.`,
      details: { provider: opts.provider, subject: opts.subject },
      suggestedFix: "Pass `createUser: true` to auth.sessions.createResponseFromIdentity if first-sign-in should create the user.",
    });
    this.name = "UnknownIdentityError";
  }
}

/** The canonical "your own credential check failed" error. Thrown via the
 *  `auth.invalidCredentials()` FUNCTION (not `new auth.InvalidCredentialsError()`)
 *  per D9 — agents fumble the constructor+import; `throw auth.invalidCredentials()`
 *  is one call and renders the canonical `R402_AUTH_INVALID_CREDENTIALS` envelope
 *  (distinct from `R402_AUTH_MAGIC_LINK_INVALID`). */
export class InvalidCredentialsError extends Run402AuthError {
  constructor() {
    super({
      code: "R402_AUTH_INVALID_CREDENTIALS",
      status: 401,
      message: "Invalid credentials.",
      details: {},
      suggestedFix:
        'After your own credential check fails, use: throw auth.invalidCredentials()',
      docs: "https://run402.com/errors/#R402_AUTH_INVALID_CREDENTIALS",
    });
    this.name = "InvalidCredentialsError";
  }
}

/** A shipped export that has been renamed/moved. Distinct from
 *  `UnknownExportError` (never-existed names): this one teaches the specific
 *  move for a name that used to work. Used for `auth.identities.link` →
 *  `auth.account.identities.startLink`. */
export class RenamedExportError extends Run402AuthError {
  readonly oldName: string;
  readonly newName: string;
  constructor(opts: { oldName: string; newName: string }) {
    super({
      code: "R402_AUTH_RENAMED_EXPORT",
      status: 400,
      message: `${opts.oldName} has moved to ${opts.newName}.`,
      details: { old_name: opts.oldName, new_name: opts.newName },
      suggestedFix: `Use: ${opts.newName}`,
      docs: "https://run402.com/errors/#R402_AUTH_RENAMED_EXPORT",
    });
    this.name = "RenamedExportError";
    this.oldName = opts.oldName;
    this.newName = opts.newName;
  }
}

/** Rejects a tenant-assertion mint whose `user` lacks a stable `id` (e.g. a
 *  bare email). The `fix` shows the required `{ tenant, user: { id, email, ... },
 *  method }` shape. SDK-side fast-feedback twin of the gateway's
 *  `R402_AUTH_TENANT_SUBJECT_INVALID` envelope. */
export class TenantSubjectInvalidError extends Run402AuthError {
  constructor(opts: { reason: string }) {
    super({
      code: "R402_AUTH_TENANT_SUBJECT_INVALID",
      status: 400,
      message: `Tenant assertion subject invalid: ${opts.reason}`,
      details: { reason: opts.reason },
      suggestedFix:
        'Pass a stable id: auth.sessions.createResponseFromTenantAssertion({ tenant, user: { id, email, emailVerified }, method: "password" })',
      docs: "https://run402.com/errors/#R402_AUTH_TENANT_SUBJECT_INVALID",
    });
    this.name = "TenantSubjectInvalidError";
  }
}
