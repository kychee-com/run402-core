# @run402/runtime-kernel

Public Run402 Core runtime-kernel contracts and application services.

This package is the first self-hostable Core runtime slice. It exposes the runtime capability document, typed runtime errors, port contracts used by the public Core gateway composition root, and the `run402-project-archive.v1` local inspect/verify/import contract.

Run402 Cloud's people and agents act through distinct control-plane principals, but this package does not reproduce that principal, membership, grant, grant key, or Buzz identity graph. It executes the supported runtime contract after the host's authority decision and provides portability for application state—not full managed-control-plane portability.

It is an Apache-2.0 self-hosting runtime component. Core functions are also trusted-local-code semantics: pre-bundled Node 22 artifacts, durable function runs and single-node schedule triggers from release manifests, Cloud-compatible function-run metadata headers including `x-run402-idempotency-key`, no external npm dependency install, explicit resource limits, and no hostile-code isolation claim.

Portable archive schemas ship under `@run402/runtime-kernel/schemas/*`. Archive verification is offline and treats archives as untrusted input; it checks integrity and compatibility but does not make the archive trusted. Core import verifies before mutation and supports new local projects only in v1.

It does not include Cloud archive export creation, Cloud import, existing-project archive merge, hosted OAuth, managed backups, TLS automation, observability, distributed/HA scheduling, Cloud-grade sandboxing, or production hardening.

### Static continuity

The local Postgres adapter records effective publication history when replacing a release. For one hour, a missing public non-HTML path can resolve to its most recently superseded public entry. Current routes, files and failures take precedence. HTML, private backing paths and route-only entries are not retained. Reusing a path serves current bytes; this does not pin backend versions or protect requests after the deadline.

The derived index adds no content copies or storage holds. Archive import does not invent historical publication from archived files. Retained responses identify their source release and cap new shared-cache freshness at the remaining origin interval; browser-cached immutable copies may last longer.
