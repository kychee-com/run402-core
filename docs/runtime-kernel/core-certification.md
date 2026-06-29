# Core Portability Certification

`scripts/core-certify.mjs` verifies an already-deployed Run402 Core project and writes redacted JSON evidence.

It does not provision, deploy, import, or create a new API. App repos should still use:

```sh
run402 deploy apply --manifest app.json
```

Then run certification against the deployed Core project.

## Config

```json
{
  "base_url": "http://127.0.0.1:4020",
  "project_id": "prj_...",
  "service_key": "service_...",
  "postgrest_url": "http://127.0.0.1:4300",
  "probes": {
    "static": {
      "path": "/projects/v1/{project_id}/static/",
      "expect_text": "<!doctype html"
    },
    "runtime_config": {
      "path": "/projects/v1/{project_id}/static/env.js",
      "expect_text": "RUN402"
    },
    "function": {
      "path": "/projects/v1/{project_id}/static/api/health"
    },
    "ssr": {
      "path": "/projects/v1/{project_id}/static/settings",
      "expect_text": "settings"
    },
    "rls": {
      "path": "todos?select=id",
      "anon_expect_count": 0,
      "user": {
        "sub": "user_a",
        "expect_count": 1
      }
    }
  }
}
```

Run:

```sh
npm run core:certify -- --config core-certify.json --out core-evidence.json
```

## Evidence

The output shape is:

```json
{
  "version": "run402.core_certification.v1",
  "status": "pass",
  "target": {
    "base_url": "http://127.0.0.1:4020",
    "project_id": "prj_..."
  },
  "summary": {
    "passed": 7,
    "failed": 0,
    "skipped": 0,
    "blockers": 0
  },
  "probes": [],
  "blockers": []
}
```

Service keys, bearer tokens, cookies, signed URLs, and configured redaction values are redacted before writing evidence.

## Blocker Kinds

- `docs_friction` - config/instructions are incomplete or ambiguous.
- `app_source_deploy_mapping` - the app did not expose the expected route/static/runtime-config path after deploy.
- `core_runtime_capability_gap` - Core is missing or failed a runtime capability needed by the app.
- `public_sdk_cli_package_gap` - the public SDK/CLI/package surface produced or rejected the wrong manifest shape.
- `intentionally_unsupported_cloud_only_feature` - the app asked Core to do something intentionally retained by Run402 Cloud.
