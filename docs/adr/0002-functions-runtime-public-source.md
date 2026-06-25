# ADR 0002: `@run402/functions` Moves First

## Status

Accepted

## Context

`@run402/functions` is a production-used package bundled into deployed Run402 functions. It is visible to application authors and central to the portability story, but its source previously lived in the private Cloud monorepo.

## Decision

Move `@run402/functions` source, tests, package metadata, README, changelog, and tarball smoke test into `run402-core` as the Phase 0 Core slice.

## Consequences

- A skeptical reader can build and test a real production-used Run402 runtime package from public source.
- The move does not claim complete self-hosting.
- The package can keep its current runtime behavior while changing source-of-truth and license metadata.
