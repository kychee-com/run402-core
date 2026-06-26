# @run402/runtime-kernel

Public Run402 Core runtime-kernel contracts and application services.

This package is the first self-hostable Core runtime slice. It currently exposes the runtime capability document, typed runtime errors, port contracts used by the public Core gateway composition root, and the `run402-project-archive.v1` local inspect/verify foundation.

It is a Developer Preview / single-node reference runtime component. Core functions are also Developer Preview trusted-local-code semantics: pre-bundled Node 22 artifacts, no external npm dependency install, explicit resource limits, and no hostile-code isolation claim.

Portable archive schemas ship under `@run402/runtime-kernel/schemas/*`. Archive verification is offline and treats archives as untrusted input; it checks integrity and compatibility but does not make the archive trusted.

It does not include Cloud archive export creation, Core archive import, Cloud import, hosted OAuth, managed backups, TLS automation, observability, Cloud-grade sandboxing, or production hardening.
