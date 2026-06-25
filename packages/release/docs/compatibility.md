# Compatibility Policy

`@run402/release` follows SemVer for the package API and explicit schema versions for release semantics.

## Public Compatibility Surface

The compatibility surface includes:

- Exported TypeScript types and functions.
- JSON Schemas under `schemas/`.
- Canonicalization rules.
- Digest identity strings.
- Compatibility fixtures and golden outputs.
- Documented warning and error codes.

## Compatible Changes

Patch or minor releases may:

- Add optional fields that old inputs do not use.
- Add warnings that do not change materialized state.
- Add fixtures for existing behavior.
- Improve documentation.
- Add new helper exports without changing existing outputs.

## Breaking Changes

A major package version or new schema version is required for:

- Changing materialized output for an existing supported input.
- Changing digest bytes for an existing supported input.
- Removing or renaming exported API.
- Reinterpreting a manifest field.
- Treating previously accepted input as invalid, unless the input was already outside the schema.
- Treating previously invalid input as valid when that affects materialization.

## Behavior Changes

Behavior changes discovered during extraction should be fixed for compatibility or moved to a behavior-scoped change. The release compiler extraction is not a redesign pass.

## Cloud Consumption Ratchet

Run402 Cloud must consume the public npm artifact identified by package version and registry integrity hash before the extraction is accepted. Compatibility tests are required, but they do not replace direct artifact consumption.
