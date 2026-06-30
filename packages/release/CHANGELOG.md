# @run402/release Changelog

## Unreleased

- Add `@run402/release/app-kit` for public app repos that generate CLI-compatible Run402 deploy manifests.
- Add deterministic function source materialization, local-dir site refs, migration checksum helpers, Core Developer Preview diagnostics, and explicit omitted-feature reporting.
- Allow Core app manifests to materialize scheduled functions now that Run402 Core includes a single-node scheduler.

## 0.1.1

- Accept standard Content-Type parameters such as `text/html; charset=utf-8` in `ReleaseSpec` content references.

## 0.1.0

- Initial public package scaffold for the Run402 release compiler extraction.
- Adds version constants and package metadata only; compiler APIs land in follow-up extraction steps.
