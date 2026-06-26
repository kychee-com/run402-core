# Portable Project Archives

Run402 portable archives are the public no-lock-in artifact for the supported Run402 Core runtime slice. Cloud is the easiest place to start, not the only place the supported application can run. This archive claim is separate from allowance and spend-cap financial-risk controls.

Portable archive v1 exports the supported Run402 Core runtime slice of a Cloud project: active release descriptors, phased Postgres schema/data descriptors, storage/static bytes, trusted-code function artifacts, limited Astro SSR runtime metadata, disabled auth subject stubs, and value-free secret requirements. It does not export an entire Cloud project. Managed Cloud operations, global routing, billing, allowance/spend state, abuse controls, monitoring, compliance, support, logs, diagnostics, credentials, sessions, OAuth tokens, signed URLs, provider IDs, tenant IDs, fleet IDs, and backups are outside this artifact.

## Format

The format version is `run402-project-archive.v1`. The default file extension is `.r402ar`. Core supports local verification from either a directory tree or an uncompressed tar transport. Compressed envelopes are rejected in v1; Core does not decompress untrusted archive input. Logical archive identity is computed from canonical JSON descriptors and referenced blob digests, not tar entry order, mtime, uid/gid, compression metadata, operation IDs, tenant IDs, provider paths, or export timestamps.

Minimum layout:

```text
run402-layout.json
index.json
manifest/release-spec.json
manifest/portable-release-state.json
manifest/fact-set.json
manifest/portability-report.json
manifest/export-report.json
database/pre-data.sql
database/tables.json
database/data/<table-id>.copy
database/sequences.json
database/post-data.sql
auth/config.json
auth/subjects.ndjson
storage/index.json
runtime/index.json
secrets/requirements.json
secrets/required.env.template
blobs/sha256/<digest>
```

`index.json` is the authoritative graph. Each descriptor uses `mediaType`, `digest`, `size`, and optional `path` and `annotations`. The `identity_descriptors` list names the descriptors that participate in the logical archive digest. Any checksum-list convenience output, such as `checksums/sha256.json`, is generated from descriptors and is non-authoritative in v1.

Public JSON Schemas ship in `@run402/runtime-kernel/schemas/*`:

- `project-archive-layout.v1.schema.json`
- `project-archive-index.v1.schema.json`
- `project-archive-descriptor.v1.schema.json`
- `project-archive-export-report.v1.schema.json`
- `project-archive-portability-report.v1.schema.json`
- `project-archive-database-tables.v1.schema.json`
- `project-archive-auth-stubs.v1.schema.json`
- `project-archive-storage-index.v1.schema.json`
- `project-archive-runtime-index.v1.schema.json`
- `project-archive-secret-requirements.v1.schema.json`
- `project-archive-import-result.v1.schema.json`

## Verification

`verifyPortableArchive()` and `inspectPortableArchive()` are offline. They require no Cloud credentials and perform no network calls. Verification checks archive integrity and Core compatibility only; it does not make the archive trusted.

Core treats every archive as hostile input. The verifier rejects absolute paths, `..`, backslashes, duplicate paths, symlinks, hardlinks, device entries, unsupported tar entry types, duplicate JSON object keys, unsupported versions, unknown required capabilities, unsupported media types, missing descriptors, missing blobs, digest mismatches, size mismatches, excessive file count, excessive expanded size, excessive descriptor size, and excessive descriptor depth.

Import is intentionally not best-effort. When import lands, it will verify before mutating state and will target a new local project only. Existing-project merge, Cloud import, partial import, credential migration, incremental archives, and multi-release history are not v1 features.

## Stable Diagnostics

Archive diagnostics are machine-readable for coding agents. Each entry contains `code`, `severity`, `resource_type`, optional safe `resource_id`, `message`, `next_action`, `retryable`, and safe context fields.

Stable v1 codes include:

- `EXPORT_CONSISTENCY_UNAVAILABLE`
- `EXPORT_SCOPE_UNSUPPORTED`
- `ARCHIVE_EXPIRED`
- `ARCHIVE_DIGEST_MISMATCH`
- `ARCHIVE_UNSUPPORTED_VERSION`
- `ARCHIVE_UNSUPPORTED_REQUIRED_CAPABILITY`
- `ARCHIVE_PATH_UNSAFE`
- `ARCHIVE_SIZE_LIMIT_EXCEEDED`
- `DATABASE_EXTENSION_UNSUPPORTED`
- `DATABASE_RLS_IMPORT_UNSUPPORTED`
- `DATABASE_SCHEMA_UNSAFE`
- `DATABASE_SEQUENCE_RESTORE_FAILED`
- `STORAGE_OBJECT_CHANGED_DURING_EXPORT`
- `STORAGE_OBJECT_DIGEST_MISMATCH`
- `AUTH_CREDENTIALS_NOT_EXPORTED`
- `AUTH_SUBJECT_STUBS_IMPORTED`
- `SECRET_VALUES_REQUIRED`
- `CLOUD_ONLY_FEATURE_EXCLUDED`
- `PROJECT_ALREADY_EXISTS`
- `IMPORT_VERIFY_FAILED`
- `IMPORT_CONFORMANCE_FAILED`

`next_action.type` is one of `run_command`, `set_secret`, `change_export_scope`, `remove_unsupported_feature`, `retry_later`, `contact_support`, `read_docs`, or `none`.

## Agent Path

The canonical agent flow is:

```bash
run402 cloud archives create <project-id> --scope portable-runtime-v1 --auth stubs --consistency pause-writes --wait --output ./project.r402ar --json
run402 archives inspect ./project.r402ar --json
run402 archives verify ./project.r402ar --json
run402 core projects import ./project.r402ar --name imported-project --env-file ./required.env --json
```

The public runtime-kernel package currently implements the local schema, canonical digest, inspect, and verify foundation. Cloud export and Core import are the next implementation slices.
