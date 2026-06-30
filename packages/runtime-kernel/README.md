# @run402/runtime-kernel

Public Run402 Core runtime-kernel contracts and application services.

This package is the first self-hostable Core runtime slice. It currently exposes the runtime capability document, typed runtime errors, port contracts used by the public Core gateway composition root, and the `run402-project-archive.v1` local inspect/verify/import contract.

It is an Apache-2.0 self-hosting runtime component. Core functions are also trusted-local-code semantics: pre-bundled Node 22 artifacts, single-node scheduled functions from release manifests, no external npm dependency install, explicit resource limits, and no hostile-code isolation claim.

Portable archive schemas ship under `@run402/runtime-kernel/schemas/*`. Archive verification is offline and treats archives as untrusted input; it checks integrity and compatibility but does not make the archive trusted. Core import verifies before mutation and supports new local projects only in v1.

It does not include Cloud archive export creation, Cloud import, existing-project archive merge, hosted OAuth, managed backups, TLS automation, observability, distributed/HA scheduling, Cloud-grade sandboxing, or production hardening.
