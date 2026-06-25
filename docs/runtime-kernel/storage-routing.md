# Core Storage And Routing Developer Preview

Run402 Core storage/routing is a single-node Developer Preview reference runtime. It is designed to make application data-plane behavior portable and inspectable, not to replace managed production operations.

## Supported

- create local upload sessions
- upload bytes through the Core gateway
- complete uploads with SHA-256 and size verification
- list project storage objects with prefix and cursor pagination
- read public objects anonymously
- read private objects with the project service key
- create local signed-read URLs for private objects
- retain immutable local URLs by content digest after mutable overwrite or delete
- delete mutable object mappings
- run conservative cleanup that preserves live object, immutable version, upload, pending apply, and active release references
- apply asset put, overwrite, delete, and sync-prune operations through the runtime-kernel apply path
- serve explicit public paths and exact static alias routes from the active release
- serve GET and HEAD consistently with content type, ETag, SHA-256 integrity, and cache headers
- fail closed for unsupported dynamic function or SSR route targets

## Not Supported

- function execution
- Astro SSR execution
- export/import archives
- S3-compatible APIs
- direct-to-object-store upload paths
- managed quotas or billing policy
- global routing or custom domains
- managed CDN invalidation
- HA object durability
- managed backups, monitoring, abuse automation, compliance, or support workflows

## Local Routes

Storage routes are project scoped under:

```text
/projects/v1/:project_id/storage
```

The supported local routes are:

| Route | Auth | Purpose |
| --- | --- | --- |
| `POST /uploads` | service key | create an upload session |
| `PUT /uploads/:upload_id/bytes` | service key | upload local bytes |
| `GET /uploads/:upload_id` | service key | inspect upload status |
| `POST /uploads/:upload_id/complete` | service key | verify and promote bytes |
| `POST /uploads/:upload_id/abort` | service key | abort a session |
| `GET /objects` | service key | list objects |
| `GET /public/:key` | anonymous for public objects | read public object bytes |
| `GET /blob/:key` | service key | read private or public object bytes |
| `POST /blob/:key/sign` | service key | create a local signed-read URL |
| `DELETE /blob/:key` | service key | delete the mutable object mapping |
| `GET /immutable/:sha256/:key` | anonymous if public | read retained immutable bytes |
| `POST /cleanup` | service key | run conservative local cleanup |

Static routes are served under:

```text
/projects/v1/:project_id/static/*
```

Release-level public paths remain paths like `/events` and `/login`; the local Core gateway exposes them below the project static prefix.

## Quick Check

```bash
docker compose up -d --build core
npm run core:storage-routing
CORE_CONFORMANCE_RESTART=1 npm run core:storage-routing
docker compose down -v
```

The fixture lives in `fixtures/storage-routing-core`. It checks upload, complete, list, authenticated read, anonymous public read, private denial, signed read, immutable URL retention, delete, cleanup-visible retention, restart persistence, explicit public paths, exact static aliases, HEAD/GET behavior, route miss/static lookup, route-conflict rejection, and unsupported dynamic target failure.

## Trust Claims

Open source and allowances solve different trust problems.

Open source reduces vendor-lock-in risk: the supported runtime behavior is public, buildable, testable, and can run outside Run402 Cloud.

Allowances and pricing controls reduce financial-risk exposure: users can cap spend when starting on Run402 Cloud.

Run402 Cloud should be the easiest place to start, not the only place the application can run.
