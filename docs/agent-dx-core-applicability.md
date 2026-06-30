# Agent DX Core Applicability

Use this checklist when a Run402 Cloud, SDK, CLI, MCP, or docs change touches behavior that may depend on Run402 Core.

Core is not Cloud. Core should support the shared application/runtime contracts that make Run402 apps understandable and progressively portable. Core should not absorb Cloud billing, allowance, operator, abuse-control, or managed-infrastructure machinery.

The private Run402 OpenSpec repo enforces the Agent DX Benchmark section markers for applicable designs. This Core checklist is the follow-through surface for package boundaries, fixtures, docs, and conformance evidence.

## Applicability Matrix

| Feature area | Core-applicable by default | Cloud-only by default |
| --- | --- | --- |
| ReleaseSpec parsing, validation, canonicalization, materialization, diffing | yes | no |
| Apply semantics that do not require Cloud billing/fleet state | yes | Cloud tenant allocation and hosted control-plane policy |
| Runtime kernel routing, storage serving, function invocation contracts | yes | global routing, custom-domain automation, CDN operations |
| Static public paths, route manifests, storage visibility | yes | Cloud cache fleet implementation details |
| Function helper APIs | yes | Cloud-only payment/operator integrations |
| Portable archive inspect/verify/import semantics | yes | Cloud archive export and managed-Cloud import operations |
| Schemas, fixtures, conformance evidence | yes | no |
| Billing, x402 allowance, tiers, leases, org payment rails | no | yes |
| Operator/admin, abuse, compliance, hosted account lifecycle | no | yes |

## Required Review For Shared Contracts

If a change touches release, runtime, functions, storage, routing, manifest/config, schema, or portable-app semantics, identify each relevant Core surface:

| Core surface | Applicability | Update when affected |
| --- | --- | --- |
| `@run402/release` | ReleaseSpec semantics, canonicalization, diffing, fixtures | package code, schemas, README, changelog, tests |
| `@run402/functions` | in-function helper API and runtime caller contracts | package code, README, changelog, tests |
| `@run402/runtime-kernel` | runtime services, routing, storage, app-service contracts | package code, schemas, README, tests |
| Core Gateway | runnable local data plane behavior | app code, docs, smoke/conformance scripts |
| fixtures | portable examples and regression inputs | fixture READMEs and generated artifacts |
| smoke/conformance scripts | proof that Core supports the contract | `core:*` scripts and `core:conformance` |
| package docs | contributor/user guidance | README/changelog for each touched package |

Mark a surface `N/A` only with a reason. Typical reasons: x402 payment rails, hosted allowance, Cloud billing, Cloud operator controls, Cloud account lifecycle, global routing operations, or managed-Cloud abuse/compliance internals.

## Canonical Agent Contract Addendum

For agent-facing changes, add this Core row to the canonical contract:

```md
## Run402 Core Applicability

Core-applicable behavior:
Cloud-only behavior:
Core surfaces touched:
- `@run402/release`:
- `@run402/functions`:
- `@run402/runtime-kernel`:
- Core Gateway:
- schemas:
- fixtures:
- smoke/conformance:
- package docs:
Core validation:
Cloud-only rationale:
```

## Validation

Prefer existing deterministic checks:

```sh
npm run build
npm test
npm run core:conformance
npm run core:certify -- --config <config> --out <evidence>
```

Use narrower package checks when only one package is touched:

```sh
npm run test:release
npm run test:functions
npm run test:runtime-kernel
npm run core:apply-smoke
npm run core:storage-routing
npm run core:functions
npm run core:astro-ssr
npm run core:archive-import
```

If a check is not cheap or reliable for the change, document the deferred check and the reason.
