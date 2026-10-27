# @run402/release Changelog

## Unreleased

- Add the function trigger type `{ id, type: "app_repo", repo, paths?, run }`, which runs a function on each commit to an app repo. `repo` is an app repo name (not checked for existence); `paths` is 1-50 repo path prefixes matched with `startsWith` (so `people` also matches `peoplex.json`; no trailing `/` is added), every path when omitted. Schedule and email fields are refused on it, and `repo`/`paths` on the other types. The JSON Schema now describes `triggers` for all three types.

- Add a third route target type, `{ type: "repo", repo, path?, requireAuth?, requireRole? }`, which serves a file from an app repo. It is prefix-capable (`path` is a directory prefix, canonically ending in `/`; for an exact pattern `path` is required and names the file), GET/HEAD only, never priced, and its role gate is validated like a function's. Validation, canonicalization, materialization (no static-file check and no static-manifest entry), diffing and the JSON Schema know it; the repo's existence is the host's check.

- `computeReleaseDiff` states public path changes: both envelopes carry `public_paths: { mode_old, mode_new, added, removed, changed, totals? }`, and a change to `site.public_paths` alone (a path added, removed or pointed at another asset, or a mode switch) is no longer a noop and is named in the summary. A file reachable by its own name in implicit mode stays in the `site` diff only.

- Wire prior mutable-path protection through actual implicit and explicit manifest compilation. Inferred classes are no longer mistaken for explicit immutable declarations during materialization.

- Consolidate filename inference in the pure `static-cache` subpath. Recognize default Vite/Rollup and Astro base64url fingerprints; keep mutable, hidden, numeric-version and nonterminal false positives revalidating. Preserve explicit/prior mutable policy and retained-public eligibility.

## Unreleased

- Add opt-in `routes[].pricing.receipt: "on_fulfillment"` for priced
  function routes, including strict validation, canonicalization, schemas,
  and diffing.
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
