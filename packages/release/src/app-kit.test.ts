import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AppKitError,
  assertCoreCompatible,
  buildPortableAppManifest,
  databaseMigrationsSlice,
  diagnoseCoreCompatibility,
  inlineSqlMigration,
  localDirSiteReplace,
  materializeFunctionManifestMap,
  materializeFunctionSource,
  omittedFeatureDiagnostic,
  safeAppKitFileName,
  sha256Hex,
  siteReplaceFromLocalDir,
  sqlFileMigration,
  writePortableAppManifest,
} from "./app-kit.js";

function withScratch<T>(fn: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "run402-app-kit-test-"));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("@run402/release/app-kit function materialization", () => {
  it("writes deterministic safe function files and preserves metadata", () => withScratch((root) => {
    const result = materializeFunctionManifestMap({
      "api/v1": {
        runtime: "node22",
        source: "export default () => new Response('api');\n",
        config: { timeoutSeconds: 15, memoryMb: 256 },
        class: "ssr",
        capabilities: ["z.capability", "astro.ssr.v1"],
        requireAuth: true,
        requireRole: { table: "members", allowed: ["owner"] },
      },
      worker: {
        source: "export default () => new Response('worker');\n",
      },
    }, {
      rootDir: root,
      outDir: join(root, "dist", "run402", "functions"),
      targetPolicy: "core",
    });

    assert.deepEqual(Object.keys(result.functions), ["api/v1", "worker"]);
    assert.deepEqual(result.omittedFunctionNames, []);
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(result.writtenFiles.map((path) => path.endsWith(".js")), [true, true]);
    assert.equal(readFileSync(join(root, "dist", "run402", "functions", "api_v1.js"), "utf-8"), "export default () => new Response('api');\n");
    assert.deepEqual(result.functions["api/v1"], {
      runtime: "node22",
      source: { path: "dist/run402/functions/api_v1.js" },
      config: { timeout_seconds: 15, memory_mb: 256 },
      class: "ssr",
      capabilities: ["astro.ssr.v1", "z.capability"],
      require_auth: true,
      require_role: { table: "members", allowed: ["owner"] },
    });
    assert.deepEqual(result.functions.worker, {
      runtime: "node22",
      source: { path: "dist/run402/functions/worker.js" },
    });
  }));

  it("preserves scheduled functions in Core manifests", () => withScratch((root) => {
    const result = materializeFunctionManifestMap({
      cron: {
        source: "export default () => new Response('cron');\n",
        schedule: "*/5 * * * *",
      },
      http: {
        source: "export default () => new Response('http');\n",
      },
    }, {
      rootDir: root,
      outDir: join(root, "functions"),
      targetPolicy: "core",
    });

    assert.deepEqual(Object.keys(result.functions), ["cron", "http"]);
    assert.deepEqual(result.functions.cron.schedule, "*/5 * * * *");
    assert.deepEqual(result.omittedFunctionNames, []);
    assert.deepEqual(result.diagnostics, []);
  }));

  it("materializes a single scheduled function source", () => withScratch((root) => {
    const materialized = materializeFunctionSource("cron", {
      source: "export default () => new Response('cron');\n",
      schedule: "0 * * * *",
    }, {
      rootDir: root,
      outDir: join(root, "functions"),
      targetPolicy: "core",
    });

    assert.equal(materialized.spec.schedule, "0 * * * *");
  }));

  it("rejects paths outside the manifest root", () => withScratch((root) => {
    assert.throws(
      () => materializeFunctionSource("api", {
        source: "export default () => new Response('api');\n",
      }, {
        rootDir: join(root, "app"),
        outDir: join(root, "outside"),
      }),
      (err) => err instanceof AppKitError &&
        err.diagnostics[0]?.code === "run402.app_kit.path_outside_root",
    );
  }));

  it("normalizes safe filenames deterministically", () => {
    assert.equal(safeAppKitFileName("api/v1"), "api_v1.js");
    assert.equal(safeAppKitFileName("..secret"), "_secret.js");
    assert.equal(safeAppKitFileName("already.mjs", ".mjs"), "already.mjs");
  });
});

describe("@run402/release/app-kit site and database helpers", () => {
  it("creates CLI-compatible local-dir site refs without absolute paths", () => withScratch((root) => {
    mkdirSync(join(root, "dist", "client"), { recursive: true });
    assert.deepEqual(localDirSiteReplace(join(root, "dist", "client"), { rootDir: root }), {
      __source: "local-dir",
      path: "dist/client",
    });
    assert.deepEqual(siteReplaceFromLocalDir("dist/client", {
      rootDir: root,
      publicPaths: { mode: "implicit" },
    }), {
      replace: { __source: "local-dir", path: "dist/client" },
      public_paths: { mode: "implicit" },
    });
  }));

  it("builds inline and file migrations with stable checksums", () => withScratch((root) => {
    const inline = inlineSqlMigration({ id: "001_init", sql: "select 1;\n" });
    assert.equal(inline.id, "001_init");
    assert.equal(inline.checksum, sha256Hex("select 1;\n"));
    assert.equal(inline.sql, "select 1;\n");

    mkdirSync(join(root, "db"), { recursive: true });
    writeFileSync(join(root, "db", "002_seed.sql"), "insert into todos values (1);\n", "utf-8");
    assert.deepEqual(sqlFileMigration({
      id: "002_seed",
      path: "db/002_seed.sql",
      rootDir: root,
      transaction: "none",
    }), {
      id: "002_seed",
      checksum: sha256Hex("insert into todos values (1);\n"),
      sql_path: "db/002_seed.sql",
      transaction: "none",
    });

    assert.deepEqual(databaseMigrationsSlice([inline], { expose: { version: "1", tables: ["todos"] } }), {
      migrations: [inline],
      expose: { version: "1", tables: ["todos"] },
    });
  }));

  it("fails clearly when migration SQL is missing", () => {
    assert.throws(
      () => inlineSqlMigration({ id: "001_empty", sql: "" }),
      (err) => err instanceof AppKitError &&
        err.diagnostics[0]?.code === "run402.app_kit.empty_string",
    );
  });
});

describe("@run402/release/app-kit Core capability diagnostics", () => {
  it("reports unsupported Run402 Core features", () => {
    const diagnostics = diagnoseCoreCompatibility({
      functions: {
        replace: {
          cron: { schedule: "0 * * * *" },
        },
      },
      subdomains: { set: [] },
      i18n: { default_locale: "en" },
      auth: { hosted_oauth: { github: true } },
      billing: { stripe: true },
      backups: { pitr: true },
      monitoring: { logs: true },
      compliance: { reports: true },
      custom_domains: { set: [] },
      mailboxes: { set: [] },
      fleet: { placement: "managed" },
    });

    assert.deepEqual(
      diagnostics.map((diagnostic) => diagnostic.capability).sort(),
      [
        "auth.hosted_oauth",
        "backups.managed",
        "billing.managed",
        "compliance.managed",
        "email.outbound_configuration",
        "fleet.operations",
        "i18n.routing",
        "managed.custom_domains",
        "managed.subdomains",
        "monitoring.managed",
      ],
    );
    assert.throws(
      () => assertCoreCompatible({ subdomains: { set: [] } }),
      (err) => err instanceof AppKitError &&
        err.diagnostics[0]?.capability === "managed.subdomains",
    );
  });

  it("records explicit omitted features in a manifest extension", () => withScratch((root) => {
    const diagnostic = omittedFeatureDiagnostic({
      resource: "functions.email-webhook",
      capability: "email.managed",
      reason: "Managed inbound email is Cloud-only for this Core build.",
      nextAction: "Keep this webhook on Run402 Cloud.",
    });
    assert.equal(diagnostic.severity, "omitted");
    assert.equal(diagnostic.owner, "app");

    const manifest = buildPortableAppManifest({
      database: databaseMigrationsSlice([
        inlineSqlMigration({ id: "001_init", sql: "select 1;\n" }),
      ]),
      omittedFeatures: [{
        resource: "functions.email-webhook",
        capability: "email.managed",
        reason: "Managed inbound email is Cloud-only for this Core build.",
      }],
    });
    assert.equal(Array.isArray(manifest["x-run402-omitted_features"]), true);
    const out = join(root, "app.json");
    writePortableAppManifest(out, manifest);
    assert.ok(readFileSync(out, "utf-8").endsWith("\n"));
  }));

  it("keeps app-kit fixtures free of private vocabulary", () => {
    const text = [
      JSON.stringify(buildPortableAppManifest({})),
      JSON.stringify(omittedFeatureDiagnostic({
        resource: "functions.example",
        capability: "functions.scheduled",
        reason: "Example omission",
      })),
    ].join("\n");
    for (const forbidden of [
      "run402-private",
      "/Users/talweiss",
      "billing_ledger",
      "operator_only",
      "tenant_id",
      "@kychee",
      "npm.pkg.github.com",
    ]) {
      assert.equal(text.includes(forbidden), false, forbidden);
    }
  });
});
