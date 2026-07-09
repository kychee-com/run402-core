# `@run402/functions` changelog

## Unreleased

### Added

- Runtime request context now exposes `idempotencyKey` from
  `x-run402-idempotency-key`. Paid function calls and durable function runs
  can read the same platform key for downstream side-effect dedupe.
- `getRoutedPaymentContext()` and `routedHttp.paymentContext()` read the
  confirmed x402 payment attached to priced routed function requests.
- `auth.user()` / `auth.requireUser()` now expose `actor.is_test === true`
  for Run402 tenant test-session users. The signed actor envelope and the
  short-lived SDK-minted DB JWT preserve the same watermark.

## 3.5.1

### Changed

- Move source-of-truth to the public `kychee-com/run402-core` repository.
- Update package metadata and license to Apache-2.0.
- No runtime behavior changes.

## 3.0.0 (paired with gateway v1.60 — `auth-aware-ssr`)

### Added

- **`auth.*` namespace** — the single canonical server-side auth surface.
  - `auth.user()` → `Actor | null`. Actor uses `id` (not `userId`) as the
    canonical public field, matching the Supabase / Clerk / Auth.js
    convention coding agents are trained on.
  - `auth.requireUser()` → throws `AuthRequiredError` (HTML requests get
    303 to `/auth/sign-in?returnTo=…` from the gateway).
  - `auth.requireRole(role)` / `auth.requireMembership(membership)` —
    typed-literal helpers that imply `requireUser` and return the user
    alongside the grant.
  - `auth.requireFresh({ maxAge, amr? })` — per-method freshness check
    that reads `Actor.amrTimes` not just flat `authTime`. A recent
    password proof does NOT satisfy `{amr: ["passkey"]}`.
  - `auth.fetch(input, init?)` — same-origin-only fetch with synchronous
    URL validation, `redirect: "manual"` default, no cookie forwarding,
    no actor-header forwarding to cross-origin redirect hops.
  - `auth.csrfToken()` / `auth.csrfField()` — double-submit token for
    hosted-auth forms (gateway is the authoritative verifier).
  - `auth.identities.link({provider, subject, proof})` — atomic
    nonce consumption + identity insert via the platform route.
  - `auth.sessions.createResponseFromIdentity({ provider, subject,
    proof, amr, createUser? })` — custom identity proof bridge. No
    raw-userId mint exposed.
  - `auth.sessions.endResponse()` — sign-out, revokes + clears cookie.

- **`Actor` type** carries `{ id, projectId, sessionId, email,
  emailVerified, authTime, amr, amrTimes }`. No `roles` / `memberships`
  field (privileged authorization goes through gate helpers).

- **SDK proxy + sentinel exports** — hallucinated names produce
  `R402_AUTH_UNKNOWN_EXPORT` with a structured fix-it:
  - `auth.protect`, `auth.getUser`, `auth.signIn`, `auth.logout`,
    `auth.middleware`, `auth.getSession`, … (proxy on the `auth` object).
  - Bare-name ESM imports `getSession`, `currentUser`, `getCurrentUser`,
    `getServerSession` are exported as throwing-sentinel functions —
    excluded from public docs, present so they fail loudly when the
    `run402 doctor` source scanner and the ESLint rule both miss.

- **Actor-context envelope verification at runtime.** The SSR Lambda
  runtime verifies the gateway-signed `X-Run402-Actor-Context` envelope
  in `runWithContext` BEFORE exposing actor data via `auth.*`. Failure
  → request becomes anonymous + `R402_AUTH_ACTOR_HEADER_SPOOF` log.
  HMAC-SHA256 with `kid` rotation; `exp = iat + 60s` cap; bound to
  method/host/path/project/request_id so envelopes can't be replayed
  cross-route.

- **Typed error subclasses** for framework-level catches:
  `Run402AuthError`, `AuthRequiredError`, `InsufficientRoleError`,
  `InsufficientMembershipError`, `FreshnessRequiredError`,
  `FetchAbsoluteUrlError`, `PrerenderedError`, `UnknownExportError`,
  `SessionBridgeUnverifiedError`, `IdentityLinkConflictError`,
  `UnknownIdentityError`.

### Notes

- Pre-launch posture: no compat path with prior SDK shapes that read
  `localStorage.wl_session` in browsers. Browser sessions are opaque
  server-side handles backed by `internal.sessions`; the cookie
  `__Host-Http-r402_session=v1.<session_id>.<secret>` carries no
  client-readable identity.
- Existing `getUser()` (JWT-based, returns `{ id, role, email }`) is
  preserved in v3.0 for in-flight cutover. Use `auth.user()` for new
  code; the legacy export will be removed once Kychon migrates.
- The DB-side actor-context propagation (`set_config('run402.user_id', …,
  true)` for RLS) lands when the PostgREST proxy translates the cookie
  actor context to claims. SDK-side `db()` is unchanged in v3.0; the
  `run402.current_user_id()` / `current_project_id()` / `current_session_id()`
  / `current_authz_version()` helpers ship in v1.60 of the gateway and
  return NULL safely when no setting is bound.

## Unreleased (paired with gateway v1.50 — `asset-metadata-and-image-intrinsics`)

### Added

- **`AssetPutOptions.metadata`** — per-key caller-provided metadata. Flat
  object; values must be `string | number | boolean | string[]`. Serialized
  size cap: 4 KB. Validated client-side before the HTTP call so bad shapes
  surface as `Error("INVALID_ASSET_METADATA: …")` rather than gateway 400s.
  Last-write-wins on re-upload — omitting `metadata` clears any prior value.
- **`AssetPutOptions.exifPolicy`** (`'keep' | 'strip'`, default `'keep'`) —
  EXIF policy applied to the indexed `image_exif` JSONB. `'keep'` stores the
  full EXIF object; `'strip'` keeps only the allowlist (camera_make /
  camera_model / lens_model / exposure_time / f_number / iso / focal_length
  / datetime_taken|digitized|modified). Original CAS bytes are NEVER mutated
  under either policy.
- **`assets.list(opts)`** — new method for listing project blobs.
  - `opts.prefix` — key-prefix filter (existing behavior).
  - `opts.limit` (default 100), `opts.cursor` — keyset pagination.
  - `opts.sort` — `'key:asc'` (default, legacy), `'createdAt:asc'`,
    `'createdAt:desc'`.
  - `opts.filter` — indexed predicates only: `uploadedBy`, `tag`, `format`,
    `isImage`, `minWidth`, `maxWidth`, `minHeight`, `maxHeight`. Unknown
    filter keys throw `INVALID_FILTER_KEY` before the HTTP call.
  - Returns `{ blobs: AssetListRow[]; next_cursor: string | null }`.
- **`AssetRef` top-level fields** (matching the flat shape variants change
  already shipped for `width_px` / `height_px` / `blurhash`):
  - `metadata: Record<string, string | number | boolean | string[]> | null`
  - `image_format: string | null`
  - `image_info: ImageInfo | null` (descriptive: has_alpha, color_space,
    animated, frame_count, bit_depth, orientation)
  - `image_exif: Record<string, unknown> | null` (snake_case keys,
    policy-filtered per `image_exif_policy`)
  - `image_exif_policy: 'keep' | 'strip' | null`
- **`AssetListRow`** type for `assets.list` results (same flat shape).
- **`ImageInfo`** exported type.
- **`AssetsListOptions` / `AssetsListResult` / `AssetsListSort` /
  `AssetsListFilter`** exported types.

### Wire details

- `assets.put` now ALWAYS sends `x-run402-asset-exif-policy: keep|strip`
  (default `keep`). The metadata header `x-run402-asset-metadata` is sent
  only when `opts.metadata` is supplied (URL-safe base64 JSON; matches the
  gateway's header-decode pipeline exactly).
- `assets.list` issues `GET /storage/v1/blobs` with `apikey` (service-key)
  auth.

### Compatibility

- Fully backward-compatible. Existing `assets.put` calls without
  `metadata` / `exifPolicy` opts produce identical wire output to the prior
  release except for the additional `x-run402-asset-exif-policy: keep`
  header (which the gateway treats identically to its absence).
- The new `AssetRef` fields are emitted as `undefined` (omitted) for
  non-image uploads, matching the variants change's convention for
  `width_px` / `height_px` / `blurhash`. `metadata` IS emitted as `null`
  when absent (callers reading metadata don't need to disambiguate
  undefined vs null).
