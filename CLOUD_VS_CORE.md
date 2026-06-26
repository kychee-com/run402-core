# Cloud Vs Core

Run402 Core and Run402 Cloud make different promises.

## Run402 Core

Run402 Core is public runtime and server code. Its job is to reduce vendor-lock-in risk by making the application runtime inspectable, buildable, testable, and progressively portable.

The public repo now includes the production-used function helper package, deterministic release compiler boundary, public runtime-kernel contracts, and a Developer Preview Core gateway with local project creation, Postgres/PostgREST/RLS, apply, static serving, storage objects, static route-manifest behavior, trusted local functions, a narrow Astro SSR target, and portable archive import.

Future phases can add stronger self-hosting assets, broader compatibility tests, S3-compatible storage, harder runtime isolation, and more production packaging.

Current Core capability table:

| Capability | Included |
| --- | ---: |
| Parse and validate ReleaseSpec | Yes |
| Canonicalize and digest | Yes |
| Materialize desired release state | Yes |
| Compute release diff | Yes |
| Derive fact and content requirements | Yes |
| Local project creation | Yes |
| Apply supported releases | Yes |
| Execute inline Postgres migrations | Yes |
| PostgREST/RLS fixture behavior | Yes |
| Local storage upload/list/read/delete/sign | Yes |
| Public/private object visibility | Yes |
| Immutable local object URLs | Yes |
| Explicit public paths and exact static aliases | Yes |
| Trusted local functions Developer Preview | Yes |
| Astro SSR Developer Preview | Yes |
| Portable archive inspect/verify/import | Yes |
| S3-compatible storage operations | No |
| Create Cloud archive exports | No, Cloud creates exports |
| Import archives back into managed Cloud | No |

## Run402 Cloud

Run402 Cloud is the managed production service. It can remain proprietary where the value is operating infrastructure reliably and safely.

Cloud-only areas include:

- multi-tenant allocation
- fleet scheduling
- Aurora operations
- global routing
- billing operations
- abuse controls
- backups
- monitoring
- compliance
- support

## The Trust Claim

Run402 Cloud should be the easiest place to start, not the only place the application can run.

Open source reduces vendor-lock-in risk. Allowances and hard caps reduce financial-risk exposure. These are separate promises.

## Developer Preview Scope

This repo does not yet provide a complete production self-hosted Run402 control plane. It includes Docker Compose, local Postgres/PostgREST, Core gateway execution, storage/routing conformance, trusted local functions, a narrow Astro SSR target, and Core import for verified portable archives. It does not include HA, TLS automation, managed backups, monitoring, custom domains, global routing, S3-compatible storage, hostile multi-tenant runtime isolation, or Cloud import back into managed Run402.

The Developer Preview proves the public/private split with real production-used packages and a runnable local data plane first.
