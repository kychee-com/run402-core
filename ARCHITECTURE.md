# Architecture

Run402 Core is the public home for production-used server/runtime code that is safe to publish.

## Phase 0 Boundary

The first Core slice is `@run402/functions`.

`@run402/functions` runs inside deployed Run402 functions and SSR runtimes. It is intentionally dependency-light:

- Node built-ins for crypto, buffers, and async local storage.
- Runtime `fetch`, `Request`, `Response`, and `Headers`.
- Environment variables injected by Run402 Cloud.
- Package-local helpers for JWT and actor-context verification.

It does not import Run402 Cloud gateway source or private shared packages.

## Runtime Contracts

The package consumes public runtime contracts:

- `RUN402_API_BASE`
- `RUN402_PROJECT_ID`
- `RUN402_SERVICE_KEY`
- `RUN402_ANON_KEY`
- `RUN402_JWT_SECRET`
- routed HTTP envelopes and `x-run402-*` headers
- gateway REST/Admin REST/SQL endpoints used by deployed functions

These contracts are part of the application runtime surface. Cloud-specific implementations of the gateway routes remain outside Phase 0.

## One-Way Core Ratchet

When code is described as Run402 Core:

1. It moves to this public repository.
2. Run402 Cloud consumes the public artifact.
3. The private implementation is deleted.
4. Compatibility tests supplement direct consumption; they do not replace it.

That rule is more important than the size of the first extraction.
