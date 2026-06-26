# Core Functions Runtime Developer Preview

Run402 Core functions run trusted project-owner code for local development and portability testing. This is not a hostile-code sandbox, not public multi-tenant hosting, and not a miniature copy of Run402 Cloud operations.

## Boundary Inventory

Private Cloud owns these production operations and they must not move into the public Core repo:

- Lambda/ECS function deployment, activation, versioning, aliases, and cleanup
- CloudWatch log retrieval and provider log stream metadata
- fleet scheduling, quota enforcement, abuse controls, billing, backups, monitoring, compliance, support, and operator tooling
- Cloud global routing, custom domains, CDN invalidation, POP/region metadata, and provider identifiers
- production secret custody, KMS integrations, and managed environment refresh

Public Core owns the portable semantics:

- `ReleaseSpec.functions` metadata and function route target interpretation
- pre-bundled Node 22 function bundle identity and content digest verification
- `run402.routed_http.v1` request/response envelope compatibility
- dynamic route fail-closed behavior before the local worker is configured
- local typed errors, request IDs, resource defaults, redaction rules, capability document, fixture contracts, and boundary scans

The first public implementation supports only pre-bundled `source` artifacts with no external npm dependencies. Lockfile npm install is a later mode, not part of this checkpoint.

## Isolation Profile

The machine-readable capability document exposes:

- `maturity: developer_preview`
- `security_profile: trusted_local_code`
- `hostile_code_isolation: false`
- `default_executor: docker_compose_worker`
- `app_code_runs_in_gateway_process: false`
- `environment_policy: explicit_allowlist`
- `host_environment_inherited: false`

Dynamic code must execute outside the gateway/control-plane process once invocation is enabled. The legacy private in-process fallback is not a Core conformance path.

## Local Executor Adapter

The first public adapter is a Docker Compose `function-worker` service built from the same open Core image and started with `node apps/core-gateway/dist/function-worker.js`. The gateway container does not import or execute application code.

The worker service exposes a local `/invoke` control endpoint, verifies the function `source` content ref, writes the bundle under `CORE_FUNCTION_WORK_DIR`, and spawns a per-invocation Node child process to import the user module. The child is launched without a shell, with a scrubbed environment, a request timeout, Node old-space memory derived from the function bundle metadata, and a process-group kill on timeout where the platform supports it.

The child environment is allowlisted:

- `PATH`
- `NODE_ENV`
- `HOME`
- `TMPDIR`
- `RUN402_PROJECT_ID`
- `RUN402_RELEASE_ID`
- `RUN402_FUNCTION_NAME`
- `RUN402_REQUEST_ID`

Gateway secrets, database URLs, host environment variables, npm tokens, and operator credentials are not inherited. Declared app secrets are injected only when they are required by the active release and present in the local Core secret store. Secret values are never returned by read APIs.

Current hardening limits:

- No shell execution.
- No npm install mode.
- Max concurrent local invocations defaults to 4.
- Invocation timeout defaults to 10s.
- Response body cap defaults to 6 MiB.
- stdout/stderr capture is capped at 64 KiB per invocation and 16 KiB per line.
- Docker Compose sets the worker service memory limit to 512 MiB.

Temp-dir byte quotas and `node_modules` byte quotas are documented resource defaults but are not yet enforced by a filesystem quota in this Developer Preview adapter.

## Resource Defaults

| Setting | Default |
| --- | ---: |
| request body cap | 6 MiB |
| response body cap | 6 MiB |
| invocation timeout | 10s |
| startup timeout | 5s |
| dependency install timeout | 120s |
| max concurrent local invocations per project | 4 |
| max pending invocation queue | 16 |
| stdout/stderr cap per invocation | 64 KiB |
| max log line length | 16 KiB |
| local log retention | 10 MiB or 24h |
| worker memory limit | 512 MiB |
| temp dir size | 512 MiB |
| `node_modules` size | 256 MiB |

## Supported Matrix

| Area | Developer Preview status |
| --- | --- |
| Node runtime | `node22` only |
| bundle form | pre-bundled `source` content ref |
| dependencies | no external deps; platform package `@run402/functions` only |
| route targets | `{ "type": "function", "name": "..." }` in route manifests |
| routed envelope | `run402.routed_http.v1` |
| direct invoke | local `/functions/v1/invoke`, service-key authorized |
| auth gates | `requireAuth` enforced before user-code dispatch |
| role gates | `cacheTtl: 0` only; positive cache TTL rejected |
| secrets | local metadata APIs, required-secret commit checks, target invocation injection, no readback |
| logs | structured platform logs, capped stdout/stderr capture, service-key log reads, request-id/since/tail filters, retention pruning |
| Astro SSR | supported only through `astro.ssr.v1`; see `docs/runtime-kernel/astro-ssr.md` |
| schedules/background jobs | unsupported |
| WebSockets/streaming | unsupported |

## Local Secrets

Set and list local function secrets through Core preview endpoints:

```bash
curl -X POST "$CORE_URL/projects/v1/$PROJECT_ID/functions/secrets" \
  -H "content-type: application/json" \
  -H "apikey: $SERVICE_KEY" \
  -d '{"name":"API_TOKEN","value":"local-secret"}'

curl "$CORE_URL/projects/v1/$PROJECT_ID/functions/secrets" \
  -H "apikey: $SERVICE_KEY"
```

The list response contains metadata only: name, scope, function name, and timestamps. A release that declares `secrets.require` fails commit with `missing_required_secret` until all required names exist. If a required value disappears after activation, invocation fails closed before user code runs.

## Logs And Diagnostics

Routed dynamic responses include `X-Run402-Request-Id: req_...`. Logs can be read with the project service key:

```bash
curl "$CORE_URL/projects/v1/$PROJECT_ID/functions/logs?request_id=$REQUEST_ID&tail=100" \
  -H "apikey: $SERVICE_KEY"
```

Supported filters are `request_id`, `function_name`, `since` as an ISO-8601 timestamp, and `tail` capped at 1000 rows. Responses are chronological within the selected tail. Platform log messages are structured JSON strings and intentionally omit headers, bodies, raw env, provider metadata, and raw user exception text. User stdout/stderr is capped and best-effort redacted for known secret values, authorization/cookie/payment/service-key patterns, and secret-looking tokens.

Local retention defaults to 10 MiB or 24h, whichever prunes first. The cleanup path reports function log cleanup counts; bundle-directory cleanup remains conservative in Developer Preview and must preserve active release references.

## Dependency Policy

Core currently rejects function specs with `deps`. Future npm mode must be lockfile-only and use:

```bash
npm ci --ignore-scripts --omit=dev --no-audit --no-fund
```

Future npm mode must also force the public registry, ignore host npm config, use a scrubbed environment, and reject `file:`, `link:`, `workspace:`, git URLs, HTTP/HTTPS tarballs, local paths, private registries, npm aliases, lifecycle-script-dependent packages, and native postinstall assumptions unless separately tested.

## Leakage And Redaction Checklist

Boundary scans and code review must check source, package tarballs, source maps, env templates, container layers, generated SBOM, fixtures, docs, and logs for:

- private repo paths and private package scopes
- AWS/Lambda/ECS/CloudWatch/CloudFront/S3 identifiers or SDK imports
- tenant ids, billing meter names, quota class names, abuse decision ids, fleet states, and operator-only terms
- gateway signing keys, service keys, database admin URLs, npm tokens, AWS/GCP credentials, and raw host environment variables
- request bodies and response bodies in platform diagnostics
- sensitive headers such as `Authorization`, `Cookie`, `Set-Cookie`, payment headers, service keys, and inbound spoofed `x-run402-*`
- Astro SSR adapter artifacts, source maps, manifests, env templates, package tarballs, container layers, provider identifiers, private paths, and Cloud-only strings

Platform diagnostics must not intentionally include secrets. User-code stdout/stderr redaction is best-effort only; trusted code can print secrets it is allowed to read.

## Evidence Expectations

Before this change can be archived, implementation notes must record:

- public package version and tarball integrity
- public commit SHA
- public image digest when an image is published
- Core functions conformance output
- private Cloud/Core comparison output
- private deploy run URL
- post-deploy functions smoke output
- boundary scan output

Open source addresses portability and lock-in risk. Allowances and spend controls address financial-risk exposure. Keep those as separate trust claims.
