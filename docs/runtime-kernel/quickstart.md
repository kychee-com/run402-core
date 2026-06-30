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
npm run core:smoke
npm run core:conformance
CORE_CONFORMANCE_RESTART=1 npm run core:storage-routing
CORE_CONFORMANCE_RESTART=1 npm run core:functions
CORE_CONFORMANCE_RESTART=1 npm run core:astro-ssr
```

Run the `CORE_CONFORMANCE_RESTART=1` commands one at a time. Each fixture restarts Core services during the test.

For a step-by-step Docker-hosted Core Gateway verification run, see [docker-compose-howto.md](./docker-compose-howto.md).

## What The Conformance Fixture Proves

- create and inspect a local project
- stage digest-checked static content
- plan and commit a supported ReleaseSpec
- run an inline PostgreSQL migration
- reload PostgREST dynamic schemas
- verify RLS through anon, user A, user B, and service-role dev JWTs
- serve active-release static content
- verify no-op reapply, stale-plan rejection, content-digest failure, and unsupported capability failure
- upload, complete, list, read, sign, delete, and clean up local storage objects
- verify public/private visibility, anonymous private denial, immutable URL retention, and restart persistence
- verify exact static aliases, explicit public paths, HEAD/GET behavior, route miss/static lookup, private asset non-disclosure, route-conflict rejection, and unsupported dynamic-route failure
- verify trusted-code Node function apply, routed HTTP fidelity, direct invoke, single-node scheduled function manual trigger, auth gates, role gates, local secrets, request IDs, logs/diagnostics, redaction, no-op reapply, stale-plan rejection, unsupported dynamic features, cleanup reporting, and worker restart persistence
- verify limited Astro SSR apply, static/SSR/function precedence, Web Request/Response behavior, redirects, multiple cookies, binary response bytes, HEAD behavior, required secrets, request IDs, logs/diagnostics, unsupported upgrade failure, no-op reapply, stale-plan rejection, cleanup reporting, and worker restart persistence

## Stop

```bash
docker compose down -v
```

Omit `-v` if you want to keep local Postgres and content-store volumes between runs.
