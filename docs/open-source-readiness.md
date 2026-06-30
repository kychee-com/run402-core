# Open Source Readiness

Run402 Core is the public home for public-safe Run402 runtime code. The repo is intentionally narrower than Run402 Cloud: it exists to make the supported application runtime inspectable, buildable, testable, and progressively portable.

## Current Boundary

Included:

- `@run402/functions`
- `@run402/release`
- `@run402/runtime-kernel`
- Core gateway composition root
- Docker Compose local runtime
- Postgres/PostgREST/RLS Run402 Core
- supported ReleaseSpec apply plan/commit
- storage/static routing subset
- trusted local functions Run402 Core
- narrow Astro SSR
- portable archive inspect/verify/import into Core

Excluded:

- multi-tenant allocator
- fleet scheduling
- Aurora operations
- global routing
- billing operations
- abuse controls
- managed backups
- monitoring
- compliance automation
- support tooling
- HA/TLS/custom-domain automation
- hostile multi-tenant code isolation
- Cloud import back into managed Run402

## Validation

Run these before presenting the repo for external review:

```bash
npm ci
npm run lint
npm run build
npm test
npm run test:functions:smoke
npm run test:release:smoke
npm run core:boundary
docker compose config --quiet
docker compose up -d --build postgres postgrest core
npm run core:health
npm run core:conformance
docker compose down -v
```

`npm run core:boundary` is the public-safety scan. It blocks private workspace paths, private package scopes, private registry references, common Cloud-only metadata names, and credential-shaped leakage outside explicitly allowed test fixtures and scanner code.

## Trust Claims

Open source reduces vendor-lock-in risk: the supported runtime slice can be inspected, built, tested, and imported into Core after export.

Run402 allowances and spend caps reduce financial-risk exposure.

These are separate promises and should stay separate in docs, marketing, and agent-facing output.

## Product Discipline

Do not add a second deployment API to make open source feel complete. The canonical write primitive remains Run402 apply:

```text
POST /apply/v1/plans
POST /apply/v1/plans/:plan_id/commit
```

Portable archives are a portability artifact for the supported Core runtime slice. Any future Cloud-side acceptance of `.r402ar` should be designed as an input format for unified apply unless a future proposal proves otherwise.
