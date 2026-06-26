# Runtime Kernel Capabilities

## Supported In This Slice

- local project create and inspect
- `ReleaseSpec` planning and commit for the static + Postgres REST fixture
- inline SQL migrations with checksum verification
- local Postgres roles: `anon`, `authenticated`, `service_role`
- local `auth.uid()`, `auth.role()`, and `auth.project_id()` RLS helpers
- deterministic dev JWTs from `POST /auth/v1/dev-tokens`
- dynamic PostgREST schema reload for `project_*` schemas
- filesystem CAS for staged static content
- local upload-session storage flow
- local filesystem CAS plus Postgres metadata for storage objects
- project-scoped object list, authenticated read, public read, delete, and cleanup-visible behavior
- local signed-read URLs for private objects
- immutable local object URLs that survive mutable overwrite/delete while retained
- apply-time asset put, delete, overwrite, and sync-prune for the supported subset
- active-release static serving for explicit public paths
- exact static alias routes with GET/HEAD behavior
- route-first matching, query-insensitive selection, trailing-slash equivalence, and route miss/static lookup
- Core Functions Developer Preview contract for trusted local Node 22 functions
- pre-bundled function source refs with no external npm dependencies
- function bundle content digest verification during apply commit
- routed HTTP function targets through the local worker executor
- service-key local direct function invocation
- `requireAuth` and `requireRole` gates with generated local user/role context
- local function secrets with metadata-only readback and required-secret commit/invocation checks
- structured local function logs, generated request IDs, timestamp/request-id/tail filters, retention pruning, and best-effort stdout/stderr redaction
- function route targets that fail closed with typed dynamic-runtime errors when the worker executor is not configured
- machine-readable functions isolation profile, resource defaults, dependency policy, and known exclusions
- Astro SSR Developer Preview for `astro.ssr.v1`
- one Node 22 ESM SSR target with Web `Request` input and buffered Web `Response` output
- SSR fallback after static aliases, public assets, prerendered HTML, and function routes
- inherited function runtime request IDs, logs, required secrets, env allowlist, timeout, body/response caps, and trusted-local-code isolation profile

## Explicitly Unsupported

Unsupported required capabilities fail with `unsupported_capability`.

- full Astro support and arbitrary Astro adapters
- Astro streaming-to-client, WebSockets, HTTP upgrade, ISR/cache, edge runtime, Cloud globals, and Cloud routing hooks
- external npm dependency installation for functions
- function schedules and background jobs
- hostile-code isolation and public multi-tenant function hosting
- function WebSockets and streaming-to-client
- S3-compatible storage
- image assets and variants
- `database.migrations[].sql_ref`
- `site.patch`
- hosted OAuth
- managed subdomains and custom domains
- export/import
- Cloud import
- Cloud billing, fleet scheduling, managed backups, monitoring, and abuse controls

## Route Subset

The current server serves active-release entries from `site.public_paths` explicit or implicit mode, exact static alias routes, supported function targets, and one `astro.ssr.v1` fallback. Resolution order is explicit static alias, public static asset path, prerendered static HTML, dynamic function route, Astro SSR fallback, then 404. Core does not provide global routing compatibility, custom domains, CDN invalidation, arbitrary SPA fallback, or managed edge operations in this slice.
