/**
 * Public types for the `auth.*` namespace.
 *
 * The canonical actor shape used everywhere `auth.user()` /
 * `auth.requireUser()` / `auth.requireRole()` etc. resolve to a user.
 * Note that `id` (not `userId`) is the canonical public field — matches
 * Supabase / Clerk / Auth.js / NextAuth so coding-agent generated code
 * gets it right on the first try.
 */

export interface Actor {
  /** Canonical public user-id. Matches `internal.users.id` UUID. */
  id: string;
  projectId: string;
  sessionId: string;
  /** The user's email. Populated ONLY on the direct Bearer-JWT invocation
   *  path (machine / mobile callers, from the JWT `email` claim). On the
   *  browser cookie-session / SSR path it is `""`: the actor envelope is
   *  signed from the session row, which carries no email. Do NOT gate on
   *  `email` for SSR surfaces — key off `id` and resolve the email yourself
   *  if needed. */
  email: string;
  /** True only for Run402 tenant test-session users.
   *
   * Invariant: real-method AMR on a real user only comes from a real ceremony
   * or cryptographic proof; arbitrary AMR exists only on `is_test` users under
   * test mode, audited by the gateway.
   */
  is_test?: true;
  emailVerified: boolean;
  /** Last any-method auth proof, seconds-since-epoch. */
  authTime: number;
  /** Authentication-method references such as `password`, `magic_link`,
   * `email_code`, or `passkey`. This is intentionally open-ended. Email code
   * is AAL1 and does not imply passkey freshness. */
  amr: string[];
  /** Per-AMR last-verified UNIX seconds, including `email_code` when that
   * ceremony established or refreshed the session. */
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

/**
 * Sign a user in to THIS app with their identity from another Run402 app
 * (federated sign-in). `proof.token` is the id_token app A's token endpoint
 * returned to this app's OAuth client; its audience must be a client metadata
 * document URL on this app's host. The platform verifies it, keys the user by
 * (A's issuer, A's user id), and never links to an existing user by email.
 */
export interface CreateResponseFromIdentityOptions {
  provider: "oidc";
  proof: { kind: "oidc_jwt"; token: string; nonce?: string };
  /** When `false` (default), an unlinked identity is
   *  `R402_AUTH_UNKNOWN_IDENTITY`. When `true`, the platform creates the user
   *  (it needs the `email` scope's verified email) in the same transaction as
   *  the session. */
  createUser?: boolean;
  /** A same-origin path: answer 303 there with the session cookie instead of
   *  `{ ok, user }`, e.g. back into a pending `/_run402/oauth/authorize`. */
  returnTo?: string;
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

/** An AI assistant (MCP client) the signed-in user connected to this app
 *  through its OAuth server (`/_run402/oauth/*`), from `auth.grants.list()`.
 *  No token or secret material. */
export interface AuthGrant {
  /** Pass to `auth.grants.revoke(id)`. */
  id: string;
  /** A client metadata document URL (`https://chatgpt.com/…`) or a
   *  registered `cl_…` id. */
  client_id: string;
  /** The client's display name at approval. For a registered client (no
   *  `verified_host`) it is self-declared: show it as unverified. */
  client_name: string | null;
  /** The host of the client_id URL for a metadata-document client, whose
   *  document the platform fetched; null for a registered client. */
  verified_host: string | null;
  /** When the user approved it (ISO 8601). */
  created_at: string;
  /** The client's last MCP request with this grant (one-minute resolution),
   *  or null when it has not called since approval. */
  last_used_at: string | null;
  /** When the grant ends and the user must approve the client again. */
  expires_at: string;
  /** Granted scopes, e.g. `["tools"]` or `["tools", "openid", "email"]`. */
  scopes: string[];
}
