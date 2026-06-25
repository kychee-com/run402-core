# Run402 Core

Run402 Core is the open-source server/runtime core for Run402.

Phase 0 contains the source for `@run402/functions`, the in-function runtime helper package that Run402 Cloud bundles into deployed functions. This repo is intentionally narrow today: it proves the public Core boundary with a real production-used package before expanding toward a runnable self-hosted control plane.

## What Is Here Today

- `packages/functions` - `@run402/functions`, the helper library for deployed Run402 functions.
- Package tests and a tarball smoke test.
- Public architecture and Cloud/Core boundary docs.
- CI for clean install, build, tests, and tarball verification.

## What Is Not Here Yet

Phase 0 is not a complete self-hosted Run402 distribution. It does not include Docker Compose, local Postgres/PostgREST, export/import, fleet scheduling, Cloud billing operations, monitoring, backups, abuse controls, or global routing.

Those are separate phases. The promise of this first repo is smaller and more concrete: a production-used runtime package is public, buildable, testable, and suitable for Run402 Cloud to consume directly.

## Packages

### `@run402/functions`

In-function helper library for Run402 serverless functions. It provides typed access to caller-context database queries, admin database queries, auth helpers, email, AI, storage assets, cache helpers, routed HTTP utilities, and webhook verification.

```bash
npm install @run402/functions
```

Most users do not install it manually for deployed functions because Run402 Cloud auto-bundles the package at deploy time. Installing it locally is useful for TypeScript autocomplete and tests.

## Development

```bash
npm ci
npm run build
npm test
npm run test:functions:smoke
```

## Cloud Vs Core

Run402 Cloud is the managed service. Run402 Core is the public runtime code that can move toward self-hosting and portability over time.

Run402 Cloud should be the easiest place to start, not the only place an application can run.

See [CLOUD_VS_CORE.md](./CLOUD_VS_CORE.md).

## Security

Please report vulnerabilities privately. See [SECURITY.md](./SECURITY.md).

## License

Apache License 2.0. See [LICENSE](./LICENSE).
