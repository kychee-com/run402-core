# Contributing

Thanks for taking a look at Run402 Core.

This repository is new and intentionally narrow. Phase 0 focuses on `@run402/functions`, the runtime helper package bundled into deployed Run402 functions.

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
- Avoid adding runtime dependencies unless the package genuinely needs them.
- Do not include secrets, customer data, private infrastructure runbooks, or abuse-control internals.

## Planning

Run402's private OpenSpec workspace is not published. Public decisions that affect contributors should be captured in docs, tests, schemas, or ADRs in this repository.
