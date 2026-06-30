# ReleaseSpec Field Support

This matrix defines how `@run402/release` treats the current ReleaseSpec surface.

| Field | Status | Notes |
| --- | --- | --- |
| `project` | Cloud-only context | Included in apply request digest compatibility; excluded from portable manifest and portable state. |
| `base.release` | Cloud-only selector | Cloud resolves to a concrete portable base state before Core preparation. |
| `base.release_id` | Cloud-only selector | Cloud resolves and authorizes before Core preparation. |
| `database.migrations[]` | Publicly interpreted | Declarative migration identity, checksum, SQL reference, and transaction mode are portable. |
| `database.expose` | Public shape, Cloud execution | Shape is part of ReleaseSpec; RLS/PostgREST convergence remains Cloud behavior. |
| `database.zero_downtime` | Publicly interpreted | Affects requirements and warnings; migration execution remains Cloud behavior. |
| `secrets.require[]` | Publicly interpreted | Produces secret fact requirements. Secret values are never represented. |
| `secrets.delete[]` | Publicly interpreted | Logical desired deletion; mutation remains Cloud behavior. |
| `functions.replace` | Publicly interpreted | Desired logical function set. |
| `functions.patch` | Publicly interpreted | Desired logical function updates and deletes. |
| `functions.*.source` | Public content requirement | CAS presence is a fact supplied by adapters. |
| `functions.*.files` | Public content requirement | Bundling and activation remain Cloud behavior. |
| `functions.*.config` | Publicly interpreted | Provider limits and tier caps remain Cloud policy. |
| `functions.*.schedule` | Publicly interpreted | Core runs schedules with a single-node gateway scheduler; distributed scheduling and fleet replay remain Cloud behavior. |
| `functions.*.deps` | Publicly interpreted | Dependency resolution and bundling remain Cloud behavior. |
| `functions.*.requireAuth` | Publicly interpreted | Runtime enforcement remains Cloud/data-plane behavior. |
| `functions.*.requireRole` | Publicly interpreted | Role lookup and enforcement remain Cloud/data-plane behavior. |
| `functions.*.class` | Publicly interpreted | SSR class is logical; provider optimizations remain Cloud behavior. |
| `functions.*.capabilities` | Publicly interpreted | Capability enforcement remains Cloud/data-plane behavior. |
| `site.replace` | Publicly interpreted | Desired static file set. |
| `site.patch` | Publicly interpreted | Desired static file upserts and deletes. |
| `site.public_paths` | Publicly interpreted | Drives logical static manifest/public path mode. |
| `subdomains` | Publicly interpreted | Desired logical names; claiming and routing remain Cloud behavior. |
| `routes` | Publicly interpreted | Logical route graph; provider routing records remain Cloud behavior. |
| `checks` | Reserved/rejected | Non-null values are rejected in v1. |
| `assets` | Opaque/preserved plus Cloud execution | Participates in apply request digest compatibility; asset storage semantics are Cloud-only in phase 1. |
| `i18n` | Publicly interpreted | Materializes locale policy and defaults. |
| Unknown fields | Reserved/rejected | Strict rejection protects forward compatibility. |
