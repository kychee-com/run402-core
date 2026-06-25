# Cloud Vs Core

Run402 Core and Run402 Cloud make different promises.

## Run402 Core

Run402 Core is public runtime and server code. Its job is to reduce vendor-lock-in risk by making the application runtime inspectable, buildable, testable, and progressively portable.

The public repo now includes the production-used function helper package, deterministic release compiler boundary, public runtime-kernel contracts, and a Developer Preview Core gateway with local project creation, Postgres/PostgREST/RLS, apply, static serving, storage objects, and static route-manifest behavior.

Future phases can add the function runtime, Astro SSR adapter, export/import archive format, stronger self-hosting assets, and broader compatibility tests.

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
| Functions and Astro SSR | No |
| S3-compatible storage operations | No |
| Export/import a Cloud project | No |

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

This repo does not yet provide a complete self-hosted Run402 control plane. It includes Docker Compose, local Postgres/PostgREST, Core gateway execution, and storage/routing conformance for the supported subset. It does not include export/import, functions, Astro SSR, HA, TLS automation, managed backups, monitoring, custom domains, global routing, or Cloud import.

The Developer Preview proves the public/private split with real production-used packages and a runnable local data plane first.
