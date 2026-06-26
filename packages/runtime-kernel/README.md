# @run402/runtime-kernel

Public Run402 Core runtime-kernel contracts and application services.

This package is the first self-hostable Core runtime slice. It currently exposes the runtime capability document, typed runtime errors, and port contracts used by the public Core gateway composition root.

It is a Developer Preview / single-node reference runtime component. Core functions are also Developer Preview trusted-local-code semantics: pre-bundled Node 22 artifacts, no external npm dependency install, explicit resource limits, and no hostile-code isolation claim.

It does not include Astro SSR, export/import, hosted OAuth, managed backups, TLS automation, observability, Cloud-grade sandboxing, or production hardening.
