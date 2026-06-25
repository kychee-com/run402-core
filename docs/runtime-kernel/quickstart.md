# Run402 Core Runtime Kernel Quickstart

Run402 Core is a Developer Preview single-node reference runtime. It is meant to prove portability and local execution for the supported release slice; it is not a production operations stack.

## Start

```bash
npm ci
npm run lint
npm run build
npm test
docker compose up -d --build core
npm run core:health
npm run core:conformance
```

## What The Conformance Fixture Proves

- create and inspect a local project
- stage digest-checked static content
- plan and commit a supported ReleaseSpec
- run an inline PostgreSQL migration
- reload PostgREST dynamic schemas
- verify RLS through anon, user A, user B, and service-role dev JWTs
- serve active-release static content
- verify no-op reapply, stale-plan rejection, content-digest failure, and unsupported capability failure

## Stop

```bash
docker compose down -v
```

Omit `-v` if you want to keep local Postgres and content-store volumes between runs.
