# Runtime Kernel Static + REST Fixture

This fixture is the canonical first-slice Run402 Core app:

- one inline PostgreSQL migration
- one RLS-protected REST table served through PostgREST
- one static HTML file served from the active release
- deterministic local dev JWTs for anon, authenticated, and service-role access

`scripts/core-apply-smoke.mjs` computes the content digests at runtime and applies this fixture against a running Docker Compose stack.
