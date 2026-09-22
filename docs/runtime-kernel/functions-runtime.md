# Run402 Core Functions Runtime

Run402 Core functions run trusted project-owner code for local development and portability testing. This is not a hostile-code sandbox, not public multi-tenant hosting, and not a miniature copy of Run402 Cloud operations.

## Boundary Inventory

Private Cloud owns these production operations and they must not move into the public Core repo:

- Lambda/ECS function deploy, activation, versioning, aliases, and cleanup
- CloudWatch log retrieval and provider log stream metadata
- fleet scheduling, quota enforcement, abuse controls, billing, backups, monitoring, compliance, support, and staff tooling
- Cloud global routing, custom domains, CDN invalidation, POP/region metadata, and provider identifiers
- production secret custody, KMS integrations, and managed environment refresh

Public Core owns the portable semantics:

- `ReleaseSpec.functions` metadata and function route target interpretation
- `ReleaseSpec.functions.replace.<name>.triggers[]` schedule metadata that creates local durable function runs
- pre-bundled Node 22 function bundle identity and content digest verification
- `run402.routed_http.v1` request/response envelope compatibility
- dynamic route fail-closed behavior before the local worker is configured
- local typed errors, request IDs, resource defaults, redaction rules, capability document, fixture contracts, and boundary scans

The public implementation supports only pre-bundled `source` artifacts with no external npm dependencies. Core does not support lockfile npm install.

## Isolation Profile

The machine-readable capability document exposes:

- `maturity: self_hosted_core`
- `security_profile: trusted_local_code`
- `hostile_code_isolation: false`
- `default_executor: docker_compose_worker`
- `app_code_runs_in_gateway_process: false`
- `environment_policy: explicit_allowlist`
- `host_environment_inherited: false`

Dynamic code must execute outside the gateway/control-plane process. Core does not implement an in-process execution fallback.

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

Gateway secrets, database URLs, host environment variables, npm tokens, and your own credentials are not inherited. Declared app secrets are injected only when they are required by the active release and present in the local Core secret store. Secret values are never returned by read APIs.

Current hardening limits:

- No shell execution.
- No npm install mode.
- Max concurrent local invocations defaults to 4.
- Invocation timeout defaults to 10s.
- Response body cap defaults to 6 MiB.
- stdout/stderr capture is capped at 64 KiB per invocation and 16 KiB per line.
- Docker Compose sets the worker service memory limit to 512 MiB.

Temp-dir byte quotas and `node_modules` byte quotas are documented resource defaults; Core does not enforce them with a filesystem quota.

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

| Area | Run402 Core status |
| --- | --- |
| Node runtime | `node22` only |
| bundle form | pre-bundled `source` content ref |
| dependencies | no external deps; platform package `@run402/functions` only |
| route targets | `{ "type": "function", "name": "..." }` in route manifests |
| routed envelope | `run402.routed_http.v1` |
| direct invoke | local `/functions/v1/invoke`, service-key authorized |
| schedules | single-node gateway scheduler from `triggers[]`; each tick creates a durable function run |
| auth gates | `requireAuth` enforced before user-code dispatch |
| role gates | `cacheTtl: 0` only; positive cache TTL rejected |
| secrets | local metadata APIs, required-secret commit checks, target invocation injection, no readback |
| logs | structured platform logs, capped stdout/stderr capture, service-key log reads, request-id/since/tail filters, retention pruning |
| Astro SSR | supported only through `astro.ssr.v1`; see `docs/runtime-kernel/astro-ssr.md` |
| managed jobs | unsupported |
| WebSockets/streaming | unsupported |

## Scheduled Function Runs

Core accepts ReleaseSpec `functions.replace.<name>.triggers[]` entries with `type: "schedule"`, a stable `id`, a 5-field `cron`, and nested `run: { event_type, payload?, retry?, expires_after_seconds? }`. The adapter is single-node and in-process in the Core Gateway: it registers active triggers on startup, refreshes timers after release activation, stops timers during shutdown, and guards stale callbacks from older registrations.

Scheduled ticks create durable function runs in the local Core run store. The run worker then uses the same local worker, secrets, request IDs, logs, redaction, timeout, body/response caps, and platform idempotency header as routed functions. The function receives `X-Run402-Trigger: function_run`, `X-Run402-Run-Id`, `X-Run402-Attempt-Id`, `X-Run402-Idempotency-Key`, and the standard function-run envelope, so Cloud and Core handler code can share the same `defineFunctionRuns(...)` path.

The native HTTP testing hook can trigger a schedule immediately. A dedicated CLI command for this hook is not yet available:

```bash
curl -X POST "$CORE_URL/projects/v1/$PROJECT_ID/functions/reminder-sweep/triggers/reminder_every_15m/run" \
  -H "apikey: $SERVICE_KEY"
```

The response includes `{ run, schedule_meta }`; poll or wait on the returned `fnrun_...` just like any other durable function run. This is a testing hook under the existing functions namespace, not a managed jobs API.

Limits are host-owned through `CORE_SCHEDULER_ENABLED`, `CORE_SCHEDULER_MAX_PER_PROJECT`, `CORE_SCHEDULER_MIN_INTERVAL_MINUTES`, and `CORE_SCHEDULER_MAX_CONCURRENT_PER_PROJECT`. Core does not provide HA scheduling, leader election, missed-tick replay, Cloud fleet scheduling, Cloud billing/tier enforcement, or managed abuse controls.

## Local Secrets

For normal operation, use `run402 secrets set API_TOKEN --file ./secret.txt --project <project-id>` and `run402 secrets list --project <project-id>` with your Core target configured. The following native probes document the Core endpoint contract:

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

Routed dynamic responses include `X-Run402-Request-Id: req_...`. Use `run402 logs --request-id <request-id> --project <project-id>` with the Core target configured. This native probe documents the service-key endpoint:

```bash
curl "$CORE_URL/projects/v1/$PROJECT_ID/functions/logs?request_id=$REQUEST_ID&tail=100" \
  -H "apikey: $SERVICE_KEY"
```

Supported filters are `request_id`, `function_name`, `since` as an ISO-8601 timestamp, and `tail` capped at 1000 rows. Responses are chronological within the selected tail. Platform log messages are structured JSON strings and intentionally omit headers, bodies, raw env, provider metadata, and raw user exception text. User stdout/stderr is capped and best-effort redacted for known secret values, authorization/cookie/payment/service-key patterns, and secret-looking tokens.

Local retention defaults to 10 MiB or 24h, whichever prunes first. The cleanup path reports function log cleanup counts; bundle-directory cleanup remains conservative in Run402 Core and must preserve active release references.

## Dependency Policy

Core rejects function specs with `deps`. Function bundles carry no external npm dependencies beyond the platform package `@run402/functions`.

## Leakage And Redaction Checklist

Boundary scans and code review must check source, package tarballs, source maps, env templates, container layers, generated SBOM, fixtures, docs, and logs for:

- private repo paths and private package scopes
- AWS/Lambda/ECS/CloudWatch/CloudFront/S3 identifiers or SDK imports
- tenant ids, billing meter names, quota class names, abuse decision ids, fleet states, and staff-only terms
- gateway signing keys, service keys, database admin URLs, npm tokens, AWS/GCP credentials, and raw host environment variables
- request bodies and response bodies in platform diagnostics
- sensitive headers such as `Authorization`, `Cookie`, `Set-Cookie`, payment headers, service keys, and inbound spoofed `x-run402-*`
- Astro SSR adapter artifacts, source maps, manifests, env templates, package tarballs, container layers, provider identifiers, private paths, and Cloud-only strings

Platform diagnostics must not intentionally include secrets. User-code stdout/stderr redaction is best-effort only; trusted code can print secrets it is allowed to read.

Open source addresses portability and lock-in risk. Allowances and spend controls address financial-risk exposure. Keep those as separate trust claims.
