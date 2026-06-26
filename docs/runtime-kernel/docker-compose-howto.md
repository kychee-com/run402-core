# Docker Compose Core Gateway How-To

This guide verifies the self-hosted Run402 Core path: build the Core Gateway Docker image, run it with local Postgres, PostgREST, and the function worker, then execute the Core conformance scripts against the hosted gateway.

Run402 Core is a Developer Preview single-node runtime. This path is meant to prove the supported runtime slice is runnable outside Run402 Cloud; it is not yet a production HA deployment.

## Prerequisites

- Docker Desktop or Docker Engine with Compose v2.
- Node.js 22 and npm.
- Ports `4020`, `4300`, and `55432` free on `127.0.0.1`.

## Fresh Start

From the repo root:

```bash
npm ci
docker compose config --quiet
docker compose down -v
docker compose up -d --build core
```

`core` depends on `postgres`, `postgrest`, and `function-worker`, so the command starts the full local Core stack.

## Verify The Gateway

```bash
npm run core:health
npm run core:smoke
```

Expected result:

- `core:health` returns `{ "status": "ok", "mode": "core" }`.
- `core:smoke` creates and inspects a local project.

## Run The Conformance Path

```bash
npm run core:conformance
```

This runs the supported end-to-end runtime slice:

- apply plan and commit
- inline Postgres migration
- PostgREST/RLS behavior
- static content serving
- storage uploads, signed reads, immutable URLs, and route/static behavior
- trusted local functions
- narrow Astro SSR runtime
- portable archive import with restart checks

For restart-persistence coverage on the long-running storage/function/SSR fixtures, run these commands one at a time. Do not parallelize them: each fixture intentionally restarts Core services while it is running.

```bash
CORE_CONFORMANCE_RESTART=1 npm run core:storage-routing
CORE_CONFORMANCE_RESTART=1 npm run core:functions
CORE_CONFORMANCE_RESTART=1 npm run core:astro-ssr
```

These commands restart the Core services during the fixture and verify previously applied state still works afterward.

## Useful URLs

- Core Gateway: `http://127.0.0.1:4020`
- Core health: `http://127.0.0.1:4020/health`
- PostgREST public URL used by projects: `http://127.0.0.1:4300`
- Postgres host port: `127.0.0.1:55432`

## Debugging

Show service status:

```bash
docker compose ps
```

Show logs:

```bash
docker compose logs core
docker compose logs function-worker
docker compose logs postgrest
docker compose logs postgres
```

Restart only the Core runtime services:

```bash
docker compose restart core function-worker postgrest
```

Reset all local Core state:

```bash
docker compose down -v
```

Omit `-v` when you want to keep local Postgres/content/function volumes between runs.

## What This Does Not Prove

This Docker path does not include Run402 Cloud-only operations: billing, managed abuse controls, Aurora operations, global routing, S3/CloudFront storage, custom domains, backups, monitoring, compliance automation, or hostile multi-tenant function isolation.

It proves the open-source Core Gateway can host the current supported local runtime slice and pass the same conformance scripts that exercise apply, storage, functions, Astro SSR, and portable archive import.
