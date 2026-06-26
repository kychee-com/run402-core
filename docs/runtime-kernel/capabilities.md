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
- function route targets that fail closed with typed dynamic-runtime errors until the worker executor is configured
- machine-readable functions isolation profile, resource defaults, dependency policy, and known exclusions

## Explicitly Unsupported

Unsupported required capabilities fail with `unsupported_capability`.

- Astro SSR
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

## Static Route Subset

The current static server serves active-release entries from `site.public_paths` explicit or implicit mode and exact static alias routes. Function targets are recognized in the route manifest and fail closed with `dynamic_runtime_unavailable` until the worker executor is configured. SSR targets remain unsupported. Core does not provide global routing compatibility, custom domains, CDN invalidation, SPA fallback, or managed edge operations in this slice.
