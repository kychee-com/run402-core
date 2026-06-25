/**
 * Public types for the `auth.*` namespace.
 *
 * The canonical actor shape used everywhere `auth.user()` /
 * `auth.requireUser()` / `auth.requireRole()` etc. resolve to a user.
 * Note that `id` (not `userId`) is the canonical public field — matches
 * Supabase / Clerk / Auth.js / NextAuth so coding-agent generated code
 * gets it right on the first try.
 *
 * @see openspec/changes/auth-aware-ssr/specs/auth-sdk-namespace/spec.md
 */

export interface Actor {
  /** Canonical public user-id. Matches `internal.users.id` UUID. */
  id: string;
  projectId: string;
  sessionId: string;
  /** The user's email. Populated ONLY on the direct Bearer-JWT invocation
   *  path (machine / mobile callers, from the JWT `email` claim). On the
   *  browser cookie-session / SSR path it is currently `""`: the actor
   *  envelope is signed from the session row, which carries no email (a JOIN
   *  to `internal.users` is a pending follow-up). Do NOT gate on `email` for
   *  SSR surfaces — key off `id` and resolve the email yourself if needed. */
  email: string;
  emailVerified: boolean;
  /** Last any-method auth proof, seconds-since-epoch. */
  authTime: number;
  amr: string[];
  /** Per-AMR last-verified UNIX seconds. */
  amrTimes: Record<string, number>;
}

/** Provider-shaped identity proof. The `wallet` shape carries an SIWX
 *  signature + message; `oidc` carries a JWT bound to a project-configured
 *  issuer; `custom` requires admin-registered project-side verifier and
 *  carries provider-specific bytes. */
export type IdentityProof =
  | { kind: "siwx"; signature: string; message: string; nonce?: string }
  | { kind: "oidc_jwt"; token: string; nonce?: string }
  | { kind: "custom"; payload: unknown; nonce?: string };

export interface CreateResponseFromIdentityOptions {
  provider: "wallet" | "oidc" | "custom";
  subject: string;
  proof: IdentityProof;
  amr: string[];
  /** When `false` (default), unknown identities cause
   *  `R402_AUTH_UNKNOWN_IDENTITY`. When `true`, the platform creates the
   *  user + identity link in the same transaction as the session. */
  createUser?: boolean;
}

export interface IdentityLinkOptions {
  provider: string;
  subject: string;
  proof: IdentityProof;
}

/** The tenant's view of a user it has already authenticated against its OWN
 *  store (bcrypt, custom DB, external IdP). `id` MUST be a stable primary key
 *  — NOT a bare email. Platform identity uniqueness is `(project_id, issuer,
 *  id)`; linking is by `(issuer, id)` only, never implicitly by email. */
export interface TenantUser {
  id: string;
  email: string;
  emailVerified: boolean;
  displayName?: string;
  avatarUrl?: string;
}

/** A Run402-verified federated identity link (OAuth / cryptographic proof). */
export interface Run402Identity {
  provider: string;
  provider_sub: string;
  provider_email: string | null;
  created_at: string;
}

/** A tenant-vouched assertion link (from `createResponseFromTenantAssertion`).
 *  `last_amr` reflects the tenant provenance (e.g. `["tenant_password"]`),
 *  intentionally distinct from Run402-verified amr values. */
export interface TenantAssertionRef {
  issuer: string;
  last_amr: string[];
}

/** The rich account/security read returned by `auth.account.getSecurity()` —
 *  distinct from the cheap per-request `auth.user()` Actor. Credentials are
 *  qualified to Run402 ownership (`has_run402_password`, `run402_passkey_count`,
 *  `run402_identities`) so a tenant-vouched user (no Run402 password) reads
 *  `has_run402_password: false`.
 *
 *  §4.8 — branch parity with the shipped `GET /auth/v1/user`. Every UI branch
 *  the old fields drove is preserved by the ownership-qualified mapping:
 *    - `has_password`              → `has_run402_password`            (set-vs-change password)
 *    - `has_passkeys`/`passkey_count` → `run402_passkey_count`         (offer "Add passkey")
 *    - `has_passkey_for_current_rp` → `has_run402_passkey_for_current_rp`
 *    - `identities`               → `run402_identities`              (connected accounts)
 *    - `current_rp_id`            → `current_rp_id` (unchanged)
 *  Plus the new `passkey_rp_scope` and `tenant_assertions` (tenant provenance,
 *  which the old endpoint conflated into `has_password`/`identities`). */
export interface AccountSecurity {
  user: Actor;
  has_run402_password: boolean;
  run402_passkey_count: number;
  has_run402_passkey_for_current_rp: boolean | null;
  run402_identities: Run402Identity[];
  current_rp_id: string | null;
  passkey_rp_scope: "host" | "realm";
  tenant_assertions: TenantAssertionRef[];
}

/** Options for `auth.sessions.createResponseFromTenantAssertion`. Agent-proof
 *  by design: the platform derives `issuer: "tenant:<tenant>"` from `tenant`
 *  and `amr` from `method` (`"password"` → `tenant_password`, `"sso"` →
 *  `tenant_sso`). The agent never hand-builds `issuer`/`amr`; arbitrary amr is
 *  available only via the `advanced` escape hatch. */
export interface CreateResponseFromTenantAssertionOptions {
  /** Short tenant identifier; becomes `issuer: "tenant:<tenant>"`. */
  tenant: string;
  /** The tenant-verified user. Requires a stable `user.id`. */
  user: TenantUser;
  /** The credential class the tenant verified. */
  method: "password" | "sso";
  /** Escape hatch for arbitrary amr values — agents should not need this. */
  advanced?: { amr: string[] };
}
