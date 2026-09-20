# @run402/release

`@run402/release` is the public home for Run402 release manifest semantics.

This package defines the production-used, deterministic behavior for parsing, validating, canonicalizing, materializing, and diffing a Run402 release manifest. It is a prerequisite for portable execution, not a self-hosted Run402 control plane.

The semantics are participant-neutral: the same reviewed application intent can be authored by a person or agent. The package deliberately does not authenticate that participant or decide its authority; Run402 Cloud or a Core host performs those control-plane checks before invoking these pure release operations.

## Included

- Version identifiers for release specs, portable release state, canonicalization, and planner semantics.
- JSON Schemas in `schemas/`.
- Canonicalization rules in `docs/canonicalization.md`.
- Typed-config descriptor helpers and normalization for SDK/CLI executable configs.
- Reviewed-plan fingerprint helpers for gateway-approved deployment plans.
- Field support matrix in `docs/field-support.md`.
- Compatibility policy in `docs/compatibility.md`.
- App authoring helpers in `docs/app-kit.md` and `@run402/release/app-kit`.
- Static manifest construction, canonicalization, digesting, metadata summaries, and public path helpers.
- Pure materialization from `ReleaseSpec` plus a concrete `PortableReleaseState`.
- Release diff envelopes, count-only summaries, truncation metadata, logical effect requirements, content-reference discovery, and `RUN402_CORE_*` warnings.
- Package metadata and clean public build/test/publish scaffolding.
- Fact protocol APIs (`FactRequirement`, fact evaluation) in `docs/canonicalization.md` and `src/facts.ts`.

## Capability Table

| Capability | Included |
| --- | ---: |
| Parse and validate ReleaseSpec | Yes |
| Canonicalize and digest | Yes |
| Materialize desired release state | Yes |
| Compute release diff | Yes |
| Derive fact and content requirements | Yes |
| Generate CLI-compatible app manifests | Yes |
| Normalize typed config descriptors | Yes |
| Fingerprint gateway-reviewed plans | Yes |
| Materialize local function source files | Yes |
| Diagnose Run402 Core omissions | Yes |
| Deploy resources | No |
| Execute migrations | No |
| Store secrets/content | No |
| Provide auth or HTTP gateway | No |
| Run a local control plane | No |
| Export/import a Cloud project | No |

## Not Included

- Deploying resources.
- Executing migrations.
- Storing content or secrets.
- Providing auth, billing, quota, abuse controls, backups, monitoring, fleet scheduling, or a managed HTTP gateway.
- Running a local Run402 control plane.

## Typed Config And Reviewed Plans

Executable SDK/CLI config stays outside this package. `@run402/release` only defines the pure descriptor contract: `defineConfig`, `dir`, `file`, `sqlFile`, and `nodeFunction` create JSON-compatible descriptors, and `normalizeTypedConfigReleaseSpec` turns already-resolved descriptors into an ordinary `ReleaseSpec`.

That means Core does not execute TypeScript, walk directories, read files, inspect environment variables, or talk to the network. The SDK/CLI may do those jobs, then pass resolved content refs, SQL checksums, and bundled function refs back through Core for canonical validation.

Reviewed plans use the same split. `digestReviewedPlanFingerprint` binds the semantic approval set -- release spec digest, concrete base identity, planner version, warnings, destructive actions, and policy/cost/quota facts -- while ignoring display-only fields such as wording, timestamps, and command examples.

Run402 Cloud should be the easiest place to start, not the only place the supported application can run. This package is one of the portability ratchets that makes that bounded promise inspectable.

Open source reduces vendor-lock-in risk. Run402 Cloud allowances and spend caps reduce financial-risk exposure. These are separate trust claims.

Priced function routes may opt into portable merchant-evidence intent with
`pricing.receipt: "on_fulfillment"`. This field declares that the function will
use `payment.fulfilled(response)` after its business mutation commits. Omission
preserves the existing payment behavior. Static and unpriced routes reject
receipt configuration.

## Static cache classification

The release compiler owns filename inference. Edge-compatible callers import
`isVersionedSiteAsset` and `isHtmlSitePath` from
`@run402/release/static-cache`; this subpath has no Node imports or dependencies.
Use `classifyStaticCacheClass` for manifest metadata, declarations and prior-path
policy. The historical wire source `inferred_sha_filename` also covers bundler
fingerprints; it does not assert that the filename is a SHA digest.

Recognized names have a terminal hexadecimal fingerprint of at least eight
characters (twelve without an extension), containing a hexadecimal letter, or an
eight-character base64url token containing mixed case or both letters and digits.
A fingerprint may precede an extension and optional `.map`. Vite/Rollup's
`index-2RHH4Euo.js` and Astro's `index.DRf8L97S.js` qualify. Hidden path
segments, numeric dates, ordinary words and an `_astro/` directory alone do not.
HTML extensions and HTML/XHTML MIME types take precedence. Query/fragment text
is not part of the filename.

Filename inference is a convention, not cryptographic verification. Ambiguous
all-lowercase non-hexadecimal hashes and non-default custom hash lengths revalidate.
Explicit revalidating declarations and previously revalidating paths remain
authoritative; changed bytes at a previously immutable path still fail the
existing immutable-path check. Stored manifests are not retroactively rewritten.
This classifier never gates retained-public continuity eligibility or extends
the one-hour origin deadline.

Reference formats: [Rollup hash characters](https://rollupjs.org/configuration-options/#output-hashcharacters)
and [Astro output filenames](https://docs.astro.build/en/recipes/customizing-output-filenames/).
Regression fixtures live in `test/fixtures/static-cache.json`.
