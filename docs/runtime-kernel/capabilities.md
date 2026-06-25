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
- active-release static serving for explicit static public paths

## Explicitly Unsupported

Unsupported required capabilities fail with `unsupported_capability`.

- functions
- Astro SSR
- general user storage API
- S3-compatible storage
- image assets and variants
- `database.migrations[].sql_ref`
- `site.patch`
- hosted OAuth
- managed subdomains and custom domains
- export/import
- Cloud import
- Cloud billing, fleet scheduling, managed backups, monitoring, and abuse controls

## Narrow Static Route Subset

The current static server serves active-release entries from `site.public_paths` explicit mode and simple static manifest entries. It is not full global routing compatibility.
