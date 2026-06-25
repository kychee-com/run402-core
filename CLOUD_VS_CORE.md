# Cloud Vs Core

Run402 Core and Run402 Cloud make different promises.

## Run402 Core

Run402 Core is public runtime and server code. Its job is to reduce vendor-lock-in risk by making the application runtime inspectable, buildable, testable, and progressively portable.

Phase 0 includes `@run402/functions`.

The next included package is `@run402/release`, the public deterministic release compiler boundary. It is the public source for ReleaseSpec schemas, canonicalization, digest identities, portable state shape, and compatibility policy.

Future phases can add more of the gateway, apply engine, Postgres/RLS behavior, storage API, function runtime, self-hosting assets, export/import, and compatibility tests.

Current `@run402/release` capability table:

| Capability | Included |
| --- | ---: |
| Parse and validate ReleaseSpec | Yes |
| Canonicalize and digest | Yes |
| Materialize desired release state | Yes |
| Compute release diff | Yes |
| Derive fact and content requirements | Yes |
| Deploy resources | No |
| Execute migrations | No |
| Store secrets/content | No |
| Provide auth or HTTP gateway | No |
| Run a local control plane | No |
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

## Phase 0 Scope

This repo does not yet provide a complete self-hosted Run402 control plane. It does not include Docker Compose, local Postgres/PostgREST, export/import, or full gateway/API execution.

Phase 0 proves the public/private split with real production-used packages first.
