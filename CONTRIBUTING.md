# Contributing

Thanks for taking a look at Run402 Core.

This repository owns the public functions helper, release compiler, runtime kernel and local gateway. Keep changes within the supported boundary described in [CLOUD_VS_CORE.md](CLOUD_VS_CORE.md).

## Development

```bash
npm ci
npm run build
npm test
npm run test:functions:smoke
```

## Pull Requests

- Keep changes scoped to the public Core package in this repository.
- Preserve documented package exports and runtime behavior unless the change explicitly proposes a compatibility break.
- Add or update tests for behavior changes.
- For agent-facing release/runtime/functions/storage/routing/config/schema changes, run the [Agent DX Core Applicability](docs/agent-dx-core-applicability.md) checklist and update every affected Core package README, changelog, fixture, schema, smoke test, or conformance script.
- Avoid adding runtime dependencies unless the package genuinely needs them.
- Do not include secrets, customer data, private infrastructure runbooks, or abuse-control internals.

## Planning

Run402's private OpenSpec workspace is not published. Public decisions that affect contributors should be captured in docs, tests, schemas, or ADRs in this repository.

## Error documentation contributions

After changing a public literal runtime error code, run `node scripts/export-error-docs.mjs` and `node scripts/export-error-docs.mjs --check`. The generated `docs/generated/error-codes.json` is safe public metadata (source paths, digests and code names). Vendor that contribution into the public client docs repository; package source remains the owner. Detailed recovery guidance and hosted acceptance are separate from code parity.
