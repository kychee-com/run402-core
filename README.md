# Run402 Core

Run402 Core is the open-source server/runtime core for Run402.

The current Core runtime-kernel slice is an Apache-2.0 self-hosting runtime. It can create a local project, plan and commit a supported ReleaseSpec, run inline PostgreSQL migrations, serve PostgREST/RLS behavior, serve active-release static content, handle local storage objects and route manifests, execute trusted local functions including durable function runs and single-node schedule triggers, run a narrow Astro SSR target, and import verified portable project archives.

## What Is Here Today

- `packages/functions` - `@run402/functions`, the helper library for deployed Run402 functions.
- `packages/release` - `@run402/release`, the release manifest semantics package.
- `packages/runtime-kernel` - public Core runtime contracts and application services.
- `apps/core-gateway` - public Core gateway composition root.
- `docker-compose.yml` - local Core, Postgres, and PostgREST stack.
- `fixtures/runtime-kernel-static-rest` - canonical static + Postgres/RLS conformance fixture.
- `fixtures/storage-routing-core` - canonical storage + static routing conformance fixture.
- CI for clean install, lint, build, tests, tarball verification, boundary checks, Compose boot, and Core conformance.

## What Is Not Here Yet

This repo is not a complete production self-hosted Run402 distribution. It does not include Cloud fleet scheduling, Aurora operations, global routing, Cloud billing operations, managed abuse controls, managed backups, monitoring, compliance automation, TLS automation, HA, custom domains, arbitrary dependency installation, hostile multi-tenant code isolation, or Cloud import back into managed Run402.

The promise of this slice is smaller and concrete: the supported Core runtime path is public, buildable, testable, and suitable for Run402 Cloud to consume or verify directly.

## Extraction Status

Run402 Core is an open-source ratchet. Public-safe, production-used runtime code moves here, and Run402 Cloud consumes the public package or verifies against the public implementation.

| Extracted surface | Current status |
| --- | --- |
| `@run402/functions` | Public package consumed by Cloud |
| `@run402/release` | Public release/apply semantics package |
| `@run402/runtime-kernel` | Public Core runtime contracts and services |
| Core gateway + Compose | self-hosted local runtime |
| Storage/routing | Supported Core subset |
| Functions runtime | Trusted local execution |
| Astro SSR runtime | Supported narrow output contract |
| Portable archives | Cloud export to Core import for the supported runtime slice |

Run402 Cloud remains the managed service. Core reduces vendor-lock-in risk; it does not open-source fleet operations.

## Packages

### `@run402/functions`

In-function helper library for Run402 serverless functions. It provides typed access to caller-context database queries, admin database queries, auth helpers, email, AI, storage assets, cache helpers, routed HTTP utilities, and webhook verification.

```bash
npm install @run402/functions
```

Most users do not install it manually for deployed functions because Run402 Cloud auto-bundles the package at deploy time. Installing it locally is useful for TypeScript autocomplete and tests.

### `@run402/release`

Release manifest semantics package. It is the public source for ReleaseSpec schemas, canonicalization rules, digest identities, portable state shape, and compatibility policy.

```bash
npm install @run402/release
```

Current package scope:

| Capability | Included |
| --- | ---: |
| Parse and validate ReleaseSpec | Yes |
| Canonicalize and digest | Yes |
| Materialize desired release state | Yes |
| Compute release diff | Yes |
| Derive fact and content requirements | Yes |
| Deploy resources | No |
| Execute migrations | No |
| Store secrets/content | No |
| Provide auth or HTTP gateway | No |
| Run a local control plane | No |
| Export/import a Cloud project | No |

### `@run402/runtime-kernel`

Public Core runtime contracts, capability document, project services, and apply plan/commit services.

Current runtime-kernel scope:

| Capability | Included |
| --- | ---: |
| Local project create/inspect | Yes |
| Supported ReleaseSpec plan/commit | Yes |
| Inline PostgreSQL migrations | Yes |
| PostgREST/RLS fixture | Yes |
| Static content staging and serving | Yes |
| Local storage upload/list/read/delete/sign | Yes |
| Public/private object visibility | Yes |
| Immutable local object URLs | Yes |
| Exact static aliases and explicit public paths | Yes |
| Deterministic dev JWTs | Yes |
| Trusted local functions | Yes |
| Single-node schedule triggers | Yes, backed by durable function runs |
| Astro SSR | Yes |
| Portable archive inspect/verify/import | Yes |
| S3-compatible storage | No |
| Cloud import into managed Run402 | No |

## Development

```bash
npm ci
npm run lint
npm run build
npm test
npm run test:functions:smoke
npm run test:release:smoke
npm run core:boundary
docker compose up -d --build core
npm run core:health
npm run core:conformance
CORE_CONFORMANCE_RESTART=1 npm run core:storage-routing
docker compose down -v
```

See [docs/runtime-kernel/quickstart.md](./docs/runtime-kernel/quickstart.md), [docs/runtime-kernel/capabilities.md](./docs/runtime-kernel/capabilities.md), [docs/runtime-kernel/storage-routing.md](./docs/runtime-kernel/storage-routing.md), [docs/runtime-kernel/portable-archives.md](./docs/runtime-kernel/portable-archives.md), [docs/runtime-kernel/security-defaults.md](./docs/runtime-kernel/security-defaults.md), and [docs/open-source-readiness.md](./docs/open-source-readiness.md).

For the full Docker-hosted Core Gateway verification path, see [docs/runtime-kernel/docker-compose-howto.md](./docs/runtime-kernel/docker-compose-howto.md).

For app-level portability evidence after a deploy, see [docs/runtime-kernel/core-certification.md](./docs/runtime-kernel/core-certification.md).

For the first generic AWS target, see [docs/deployment/aws-ec2/README.md](./docs/deployment/aws-ec2/README.md).

## Cloud Vs Core

Run402 Cloud is the managed service. Run402 Core is the public runtime and release-semantics code that can move toward self-hosting and portability over time.

Run402 Cloud should be the easiest place to start, not the only place an application can run.

See [CLOUD_VS_CORE.md](./CLOUD_VS_CORE.md).

## Security

Please report vulnerabilities privately. See [SECURITY.md](./SECURITY.md).

## License

Apache License 2.0. See [LICENSE](./LICENSE).
