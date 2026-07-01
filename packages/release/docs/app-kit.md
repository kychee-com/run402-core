# Run402 App Kit

`@run402/release/app-kit` is a small public authoring layer for app repos that want to generate a Run402 deploy manifest and then use the normal deploy command:

```sh
run402 deploy apply --manifest app.json
```

The app kit does not deploy, provision projects, read Run402 credentials, or create a new import API. It only helps app build scripts produce CLI-compatible manifest JSON with deterministic local files and clear Core compatibility diagnostics.

## What It Builds

- Function source files under an app-chosen output directory.
- `functions.replace` entries whose `source.path` values are relative to the manifest root.
- `site.replace` entries using the SDK/CLI `{"__source":"local-dir","path":"..."}` authoring form.
- Database migration entries with stable SHA-256 checksums.
- Explicit omitted-feature diagnostics for Core-compatible app slices.

## Minimal Example

```ts
import {
  buildPortableAppManifest,
  databaseMigrationsSlice,
  inlineSqlMigration,
  materializeFunctionManifestMap,
  siteReplaceFromLocalDir,
  writePortableAppManifest,
} from "@run402/release/app-kit";

const rootDir = process.cwd();

const functions = materializeFunctionManifestMap({
  api: {
    source: "export default () => new Response('ok');\n",
    config: { timeoutSeconds: 10 },
  },
}, {
  rootDir,
  outDir: `${rootDir}/dist/run402/functions`,
  targetPolicy: "core",
});

const manifest = buildPortableAppManifest({
  database: databaseMigrationsSlice([
    inlineSqlMigration({
      id: "001_init",
      sql: "create table if not exists todos (id bigint primary key);\n",
    }),
  ]),
  functions: { replace: functions.functions },
  site: siteReplaceFromLocalDir("dist/client", {
    rootDir,
    publicPaths: { mode: "implicit" },
  }),
  routes: {
    replace: [{
      pattern: "/api/todos",
      methods: ["GET"],
      target: { type: "function", name: "api" },
    }],
  },
});

writePortableAppManifest("app.json", manifest);
```

Then deploy the generated manifest through the normal SDK/CLI path.

## Run402 Core Policy

Use `targetPolicy: "core"` when building a manifest intended for Run402 Core. The policy reports features that are not part of Run402 Core, including:

- managed subdomains and custom domains
- i18n routing
- hosted OAuth
- deploy-time email resources (Core outbound email is configured through the gateway provider and `/mailboxes/v1`; managed inbound/delivery operations remain Cloud-only)
- billing
- monitoring
- backups
- compliance operations
- fleet operations

Schedule triggers are part of the Core manifest surface. Core runs them with
the gateway's single-node scheduler and creates durable function runs for each
tick; distributed scheduling, missed-tick replay, and fleet operations remain
outside the Run402 Core policy.

Apps can omit an unsupported feature intentionally and record that decision:

```ts
const manifest = buildPortableAppManifest({
  omittedFeatures: [{
    resource: "functions.email-webhook",
    capability: "email.managed",
    reason: "Managed inbound email is Cloud-only for this Core build.",
  }],
});
```

The manifest extension is named `x-run402-omitted_features`. It is evidence for humans and coding agents; it is not a new deploy resource.

## Boundary

This package is for public app repos and coding agents. App-specific decisions stay in the app repo:

- which functions belong in the Core slice
- which tables are exposed through PostgREST
- which routes point at static files or functions
- which Cloud-only features are omitted

Run402 target profile parsing, project provisioning, auth, and deploy execution stay in the public SDK/CLI/MCP surface.
