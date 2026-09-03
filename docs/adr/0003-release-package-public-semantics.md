# ADR 0003: `@run402/release` Owns Release Manifest Semantics

## Status

Accepted

## Context

Run402's strongest anti-lock-in claim depends on release manifests being interpretable outside Run402 Cloud. The private gateway currently owns the production-used ReleaseSpec types, canonicalization, materialization, diffing, and fact-dependent planning behavior.

Opening the entire managed control plane in one step would mix portable semantics with Cloud operations. The first durable boundary is the context-free release compiler.

## Decision

`@run402/release` is the public Apache 2.0 package in `run402-core` that owns ReleaseSpec semantics, portable release state, canonicalization, digest identities, compatibility fixtures, and fact evaluation.

Run402 Cloud keeps fact acquisition, auth, billing, quota, operation persistence, migration execution, provider activation, routing infrastructure, backups, monitoring, abuse controls, compliance, and support operations private.

## Consequences

- Public docs, schemas, ADRs, fixtures, and API declarations become the normative source for external readers.
- Run402 Cloud must consume the public package artifact instead of maintaining a private semantic fork.
- The package is a portability prerequisite, not a complete self-hosted Run402 control plane.
- Compatibility work must preserve existing `/apply/v1` behavior unless a separate behavior-scoped change says otherwise.
