# @run402/release Changelog

## Unreleased

- Add `routes[].pricing` for fixed-price x402 function routes in ReleaseSpec
  validation, materialization, schemas, and diffing.
- Default omitted static route alias `methods` to `GET` plus `HEAD` instead of rejecting the route entry (the only method set a static alias can normalize to).
- Let a `route_static_alias` override a manufactured implicit-mode compatibility entry (`/` for a root `index.html`, or a trailing-slash directory path) instead of rejecting the release. Explicit `public_paths` declarations and real file paths keep the hard `conflicting direct public path and static alias` error. Unblocks the "static home page + SPA shell" recipe (kychee-com/run402-private#556).
- Add pure typed-config descriptor helpers and normalization for SDK/CLI executable configs.
- Add reviewed-plan fingerprint helpers for gateway-approved deployment plans.
- Add `@run402/release/app-kit` for public app repos that generate CLI-compatible Run402 deploy manifests.
- Add deterministic function source materialization, local-dir site refs, migration checksum helpers, Run402 Core diagnostics, and explicit omitted-feature reporting.
- Allow Core app manifests to materialize schedule triggers now that Run402 Core includes trigger-backed durable function runs.

## 0.1.1

- Accept standard Content-Type parameters such as `text/html; charset=utf-8` in `ReleaseSpec` content references.

## 0.1.0

- Initial public package scaffold for the Run402 release compiler extraction.
- Adds version constants and package metadata only; compiler APIs land in follow-up extraction steps.
