# Architecture

Run402 Core is the public home for production-used server/runtime code that is safe to publish.

## Current Boundary

The first Core slice is `@run402/functions`.

`@run402/functions` runs inside deployed Run402 functions and SSR runtimes. It is intentionally dependency-light:

- Node built-ins for crypto, buffers, and async local storage.
- Runtime `fetch`, `Request`, `Response`, and `Headers`.
- Environment variables injected by Run402 Cloud.
- Package-local helpers for JWT and actor-context verification.

It does not import Run402 Cloud gateway source or private shared packages.

The next Core slice is `@run402/release`.

`@run402/release` owns the public release manifest semantics:

- ReleaseSpec schemas.
- PortableReleaseState schemas.
- Canonicalization rules.
- Digest identities.
- Field support matrix.
- Compatibility policy.
- Eventually: public parsing, validation, materialization, diffing, requirement derivation, Core warnings, and fact evaluation.

It does not provision resources, execute migrations, store content or secrets, provide auth, run the HTTP gateway, or operate a local control plane.

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

## Release Compiler Contracts

Release compiler contracts are intentionally separated from Cloud operations:

- `run402-apply-request-v1` preserves Cloud apply request digest compatibility.
- `run402-portable-manifest-v1` excludes Cloud context and mutable provider state.
- `run402-materialized-release-v1` hashes only portable desired state.
- `run402-evaluated-plan-v1` will bind desired state to complete caller-supplied facts.

`PortableReleaseState` must not contain database row IDs, provider resource identifiers, storage paths, operation IDs, tenant IDs, fleet IDs, internal timestamps, or managed-service metadata.

## One-Way Core Ratchet

When code is described as Run402 Core:

1. It moves to this public repository.
2. Run402 Cloud consumes the public artifact.
3. The private implementation is deleted.
4. Compatibility tests supplement direct consumption; they do not replace it.

That rule is more important than the size of the first extraction.
