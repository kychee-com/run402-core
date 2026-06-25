# Canonicalization

`@run402/release` uses deterministic canonical JSON for release compiler digests.

## Versions

- Canonicalization version: `run402.canonical_json.v1`
- Apply request digest identity: `run402-apply-request-v1:<sha256-hex>`
- Portable manifest digest identity: `run402-portable-manifest-v1:<sha256-hex>`
- Materialized release digest identity: `run402-materialized-release-v1:<sha256-hex>`
- Evaluated plan digest identity: `run402-evaluated-plan-v1:<sha256-hex>`

## Rules

1. Inputs must be JSON-compatible values: objects, arrays, strings, finite numbers, booleans, and `null`.
2. `undefined`, functions, symbols, BigInt, NaN, Infinity, and -Infinity are rejected.
3. Object keys are sorted lexicographically by Unicode code point before serialization.
4. Array order is preserved only when the field defines order as meaningful. Otherwise the compiler normalizes order before digesting.
5. Strings are serialized with JSON string escaping. The compiler does not trim, lowercase, or normalize Unicode unless a field's schema says so.
6. Line endings inside string fields are exact bytes of the string value unless a field's schema says otherwise.
7. Absent optional fields and explicit `null` are distinct unless a field's schema defines null as semantic absence.
8. Every digest string carries an identity prefix. Bare SHA-256 hex is an implementation detail, not the public digest contract.

## Context Separation

`run402-apply-request-v1` preserves the Cloud apply request digest contract, including the request fields that are part of today's apply identity.

`run402-portable-manifest-v1` excludes Cloud context such as project IDs, tenant IDs, operation IDs, provider identifiers, timestamps, and base selectors.

`run402-materialized-release-v1` hashes `PortableReleaseState` only. It must not depend on wall clock time, randomness, process environment, database reads, provider availability, or mutable Cloud facts.
