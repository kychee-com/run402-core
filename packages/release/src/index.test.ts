import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CANONICALIZATION_VERSION,
  FACT_PROTOCOL_VERSION,
  PLANNER_SEMANTICS_VERSION,
  PORTABLE_RELEASE_STATE_VERSION,
  REVIEWED_PLAN_FINGERPRINT_IDENTITY,
  REVIEWED_PLAN_FINGERPRINT_VERSION,
  RELEASE_PACKAGE_NAME,
  RELEASE_SPEC_VERSION,
  STATIC_MANIFEST_VERSION,
  TYPED_CONFIG_DESCRIPTOR_VERSION,
  cacheControlForStaticCacheClass,
  releasePackageInfo,
  canonicalizeJson,
  canonicalizeStaticManifest,
  classifyStaticCacheClass,
  collectLegacyImmutableRisks,
  computeReleaseDiff,
  computeApplyRequestDigestHex,
  computeMaterializedReleaseDigestHex,
  computePortableManifestDigestHex,
  computeReviewedPlanFingerprintHex,
  computeStaticManifestSha256,
  detectPreviousImmutableViolations,
  deriveFactRequirements,
  derivePlanMigrations,
  deriveReleaseRequirements,
  digestApplyRequest,
  digestEvaluatedPlan,
  digestMaterializedRelease,
  digestPortableManifest,
  digestReviewedPlanFingerprint,
  dir,
  emptyPortableReleaseState,
  file,
  materializeRelease,
  materializeRoutes,
  nodeFunction,
  normalizePortableManifest,
  normalizeManifestResponseHeaders,
  normalizeReviewedPlanFingerprint,
  normalizeTypedConfigReleaseSpec,
  evaluateReleaseFacts,
  parseReleaseSpec,
  sqlFile,
  summarizeStaticManifest,
  validateReleaseSpec,
  ReleaseCoreError,
  ReleaseSpecValidationError,
  ReleaseFactProtocolError,
  StaticManifestError,
  UnsupportedStaticManifestVersionError,
  type ReleaseSpec,
  type PortableReleaseState,
  type PlanDiffEnvelope,
  type StaticManifest,
} from "./index.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

describe("@run402/release package identity", () => {
  it("exports stable version identifiers", () => {
    assert.equal(RELEASE_PACKAGE_NAME, "@run402/release");
    assert.equal(RELEASE_SPEC_VERSION, "run402.release_spec.v1");
    assert.equal(PORTABLE_RELEASE_STATE_VERSION, "run402.portable_release_state.v1");
    assert.equal(STATIC_MANIFEST_VERSION, "run402.static_manifest.v1");
    assert.equal(FACT_PROTOCOL_VERSION, "run402.release_facts.v1");
    assert.equal(CANONICALIZATION_VERSION, "run402.canonical_json.v1");
    assert.equal(PLANNER_SEMANTICS_VERSION, "run402.release_planner.v1");
    assert.equal(TYPED_CONFIG_DESCRIPTOR_VERSION, "run402.typed_config.v1");
    assert.equal(REVIEWED_PLAN_FINGERPRINT_VERSION, "run402.reviewed_plan_fingerprint.v1");
  });

  it("returns package info without mutable process state", () => {
    assert.deepEqual(releasePackageInfo(), {
      packageName: "@run402/release",
      releaseSpecVersion: "run402.release_spec.v1",
      portableReleaseStateVersion: "run402.portable_release_state.v1",
      staticManifestVersion: "run402.static_manifest.v1",
      factProtocolVersion: "run402.release_facts.v1",
      canonicalizationVersion: "run402.canonical_json.v1",
      plannerSemanticsVersion: "run402.release_planner.v1",
      typedConfigDescriptorVersion: "run402.typed_config.v1",
      reviewedPlanFingerprintVersion: "run402.reviewed_plan_fingerprint.v1",
    });
  });

  it("ships parseable public JSON Schemas", async () => {
    for (const schemaName of [
      "release-spec.v1.schema.json",
      "portable-release-state.v1.schema.json",
      "release-fact-set.v1.schema.json",
    ]) {
      const raw = await readFile(resolve(packageRoot, "schemas", schemaName), "utf8");
      const parsed = JSON.parse(raw) as { $schema?: string; $id?: string };
      assert.equal(parsed.$schema, "https://json-schema.org/draft/2020-12/schema");
      assert.ok(parsed.$id?.startsWith("https://run402.com/schemas/"));
    }
  });
});

describe("static manifest model", () => {
  it("canonicalizes, validates, and hashes manifest bytes deterministically", () => {
    const manifest = canonicalizeStaticManifest({
      version: STATIC_MANIFEST_VERSION,
      files: {
        "assets/app.1234abcd.js": {
          sha256: SHA_A,
          size: 12,
          content_type: "application/javascript",
        },
        "/index.html": {
          sha256: SHA_B,
          size: 7,
          content_type: "text/html; charset=utf-8",
        },
      },
      spa_fallback: "index.html",
    });

    assert.deepEqual(Object.keys(manifest.files), ["/index.html", "/assets/app.1234abcd.js"]);
    assert.equal(manifest.spa_fallback, "/index.html");
    assert.equal(manifest.files["/index.html"]?.cache_class, "html");
    assert.equal(manifest.files["/assets/app.1234abcd.js"]?.cache_class, "immutable_versioned");

    const second = canonicalizeStaticManifest(JSON.parse(JSON.stringify(manifest)));
    assert.equal(computeStaticManifestSha256(manifest), computeStaticManifestSha256(second));
  });

  it("canonicalizes explicit direct and route-only public path entries", () => {
    const manifest = canonicalizeStaticManifest({
      version: STATIC_MANIFEST_VERSION,
      public_path_mode: "explicit",
      files: {
        "/events": {
          sha256: SHA_A,
          size: 12,
          content_type: "text/html",
          cache_class: "html",
          asset_path: "events.html",
          direct: true,
          authority: "explicit_public_path",
        },
        "/login": {
          sha256: SHA_B,
          size: 8,
          content_type: "text/html",
          asset_path: "login.html",
          direct: false,
          authority: "route_static_alias",
          route_id: "/login:GET,HEAD",
          methods: ["HEAD", "GET"],
        },
      },
      spa_fallback: null,
    });

    assert.equal(manifest.public_path_mode, "explicit");
    assert.equal(manifest.files["/events"]?.asset_path, "events.html");
    assert.equal(manifest.files["/events"]?.direct, true);
    assert.equal(manifest.files["/login"]?.direct, false);
    assert.deepEqual(manifest.files["/login"]?.methods, ["GET", "HEAD"]);
    assert.equal(manifest.spa_fallback, null);
  });

  it("throws typed unsupported-version errors", () => {
    assert.throws(
      () => canonicalizeStaticManifest({ version: "run402.static_manifest.v2", files: {} }),
      (err) => err instanceof UnsupportedStaticManifestVersionError &&
        err.code === "UNSUPPORTED_STATIC_MANIFEST_VERSION",
    );
  });

  it("rejects platform-owned response headers and can strip them", () => {
    assert.throws(
      () => normalizeManifestResponseHeaders({
        "x-run402-static-sha256": SHA_A,
      }),
      (err) => err instanceof StaticManifestError &&
        err.code === "STATIC_RESPONSE_HEADER_FORBIDDEN",
    );
    assert.deepEqual(
      normalizeManifestResponseHeaders({
        "x-run402-static-sha256": SHA_A,
        "content-disposition": "attachment",
      }, { mode: "strip" }),
      { "content-disposition": "attachment" },
    );
    assert.throws(
      () => normalizeManifestResponseHeaders({ "set-cookie": "a=b" }),
      (err) => err instanceof StaticManifestError &&
        err.code === "STATIC_RESPONSE_HEADER_FORBIDDEN",
    );
  });

  it("classifies cache classes and detects previous immutable hard failures", () => {
    assert.equal(
      classifyStaticCacheClass({
        path: "/index.html",
        contentType: "text/html",
      }).cache_class,
      "html",
    );
    assert.equal(
      classifyStaticCacheClass({
        path: "/assets/app.1234abcd.js",
        contentType: "application/javascript",
      }).cache_class,
      "immutable_versioned",
    );
    const unversioned = classifyStaticCacheClass({
      path: "/logo.png",
      contentType: "image/png",
      declaredCacheClass: "immutable_versioned",
    });
    assert.equal(unversioned.cache_class, "revalidating_asset");
    assert.equal(unversioned.cache_class_source, "downgraded");

    const previous = canonicalizeStaticManifest({
      version: STATIC_MANIFEST_VERSION,
      files: {
        "/assets/app.1234abcd.js": {
          sha256: SHA_A,
          size: 1,
          content_type: "application/javascript",
          cache_class: "immutable_versioned",
        },
      },
    }) as StaticManifest;
    const candidate = canonicalizeStaticManifest({
      version: STATIC_MANIFEST_VERSION,
      files: {
        "/assets/app.1234abcd.js": {
          sha256: SHA_B,
          size: 1,
          content_type: "application/javascript",
          cache_class: "immutable_versioned",
        },
      },
    }) as StaticManifest;
    assert.deepEqual(detectPreviousImmutableViolations(previous, candidate), [{
      path: "/assets/app.1234abcd.js",
      previous_sha256: SHA_A,
      candidate_sha256: SHA_B,
      previous_cache_class: "immutable_versioned",
    }]);
  });

  it("reports legacy immutable risks, metadata summaries, and cache-control policies", () => {
    const manifest = canonicalizeStaticManifest({
      version: STATIC_MANIFEST_VERSION,
      files: {
        "/logo.png": {
          sha256: SHA_A,
          size: 1,
          content_type: "image/png",
          cache_class: "immutable_versioned",
          cache_class_source: "legacy",
        },
      },
    });
    assert.deepEqual(collectLegacyImmutableRisks(manifest), [{
      path: "/logo.png",
      sha256: SHA_A,
      reason: "legacy_immutable_unfingerprinted",
    }]);
    assert.deepEqual(summarizeStaticManifest(manifest), {
      file_count: 1,
      total_bytes: 1,
      cache_classes: { immutable_versioned: 1 },
      cache_class_sources: { legacy: 1 },
      spa_fallback: null,
    });
    assert.equal(
      cacheControlForStaticCacheClass("immutable_versioned"),
      "public, max-age=31536000, immutable",
    );
    assert.equal(
      cacheControlForStaticCacheClass("revalidating_asset"),
      "public, max-age=0, must-revalidate",
    );
  });
});

describe("portable release materialization", () => {
  it("site replace builds portable site state and implicit static manifest", () => {
    const materialized = materializeRelease({
      spec: {
        project: "p0001",
        site: {
          replace: {
            "index.html": { sha256: SHA_A, size: 100, contentType: "text/html" },
            "assets/app.1234abcd.js": { sha256: SHA_B, size: 25, contentType: "application/javascript" },
          },
        },
      },
    });

    assert.deepEqual(
      materialized.site.paths.map((entry) => entry.path),
      ["assets/app.1234abcd.js", "index.html"],
    );
    assert.equal(materialized.static_manifest?.spa_fallback, "/index.html");
    assert.deepEqual(
      Object.keys(materialized.static_manifest?.files ?? {}),
      ["/", "/assets/app.1234abcd.js", "/index.html"],
    );
    assert.equal(materialized.static_manifest?.files["/"]?.asset_path, "index.html");
  });

  it("explicit public path mode carries forward and hides newly patched assets", () => {
    const first = materializeRelease({
      spec: {
        project: "p0001",
        site: {
          replace: {
            "events.html": { sha256: SHA_A, size: 100, contentType: "text/html" },
          },
          public_paths: {
            mode: "explicit",
            replace: {
              "/events": { asset: "events.html" },
            },
          },
        },
      },
    });

    const next = materializeRelease({
      concreteBase: first,
      spec: {
        project: "p0001",
        site: {
          patch: {
            put: {
              "debug.json": { sha256: SHA_B, size: 25, contentType: "application/json" },
            },
          },
        },
      },
    });

    assert.equal(next.static_manifest?.public_path_mode, "explicit");
    assert.deepEqual(Object.keys(next.static_manifest?.files ?? {}), ["/events"]);
    assert.equal(next.static_manifest?.files["/debug.json"], undefined);
  });

  it("materializes static aliases as route-only manifest entries", () => {
    const materialized = materializeRelease({
      spec: {
        project: "p0001",
        site: {
          replace: {
            "events.html": { sha256: SHA_A, size: 100, contentType: "text/html" },
          },
          public_paths: { mode: "explicit", replace: {} },
        },
        routes: {
          replace: [
            { pattern: "/events", methods: ["GET"], target: { type: "static", file: "events.html" } },
          ],
        },
      },
    });

    assert.equal(materialized.static_manifest?.public_path_mode, "explicit");
    assert.equal(materialized.static_manifest?.files["/events"]?.asset_path, "events.html");
    assert.equal(materialized.static_manifest?.files["/events"]?.direct, false);
    assert.equal(materialized.static_manifest?.files["/events"]?.authority, "route_static_alias");
    assert.deepEqual(materialized.static_manifest?.files["/events"]?.methods, ["GET", "HEAD"]);
  });

  it("validates route targets against the post-state", () => {
    assert.throws(
      () => materializeRelease({
        spec: {
          project: "p0001",
          routes: {
            replace: [
              { pattern: "/events", methods: ["GET"], target: { type: "static", file: "events.html" } },
            ],
          },
        },
      }),
      (err) => err instanceof ReleaseSpecValidationError &&
        /static file events\.html/.test(err.message),
    );
  });

  it("applies functions, secrets, subdomains, i18n, and timestamp-free migrations", () => {
    const materialized = materializeRelease({
      concreteBase: {
        ...emptyPortableReleaseState(),
        secrets: { keys: ["EXISTING", "OLD"] },
        subdomains: { names: ["app-a"] },
      },
      spec: {
        project: "p0001",
        functions: {
          replace: {
            api: {
              runtime: "node22",
              source: { sha256: SHA_A, size: 10 },
              config: { timeoutSeconds: 30, memoryMb: 256 },
              requireAuth: true,
              deps: ["@run402/functions"],
            },
          },
        },
        secrets: { require: ["NEW", "EXISTING"], delete: ["OLD"] },
        subdomains: { add: ["app-b"] },
        database: {
          migrations: [
            { id: "001_init", checksum: SHA_B, sql: "select 1", transaction: "none" },
          ],
        },
        i18n: { defaultLocale: "en", locales: ["en", "es"] },
      },
    });

    assert.deepEqual(materialized.functions, [{
      name: "api",
      code_hash: SHA_A,
      runtime: "node22",
      timeout_seconds: 30,
      memory_mb: 256,
      schedule: null,
      deps: ["@run402/functions"],
      require_auth: true,
      require_role: null,
    }]);
    assert.deepEqual(materialized.secrets.keys, ["EXISTING", "NEW"]);
    assert.deepEqual(materialized.subdomains.names, ["app-a", "app-b"]);
    assert.deepEqual(materialized.migrations, [{
      migration_id: "001_init",
      checksum_hex: SHA_B,
      transaction: "none",
    }]);
    assert.deepEqual(materialized.i18n, {
      defaultLocale: "en",
      locales: ["en", "es"],
      detect: ["accept-language"],
      unknownLocalePolicy: "reject",
    });
  });
});

describe("release diff, warnings, and requirements", () => {
  it("computes sorted diff buckets and count-only summaries", () => {
    const from = materializeRelease({
      spec: {
        project: "p0001",
        site: {
          replace: {
            "a.html": { sha256: "11".repeat(32), size: 10, contentType: "text/html" },
            "z.html": { sha256: "22".repeat(32), size: 20, contentType: "text/html" },
          },
        },
        functions: {
          replace: {
            "auth-handler": { runtime: "node22", source: { sha256: "33".repeat(32), size: 1 } },
          },
        },
      },
    });
    const to = materializeRelease({
      spec: {
        project: "p0001",
        site: {
          replace: {
            "a.html": { sha256: "44".repeat(32), size: 10, contentType: "text/html" },
            "b.html": { sha256: "55".repeat(32), size: 20, contentType: "text/html" },
            "m.html": { sha256: "66".repeat(32), size: 30, contentType: "text/html" },
          },
        },
      },
    });
    const diff = computeReleaseDiff(from, to, {
      plan_migrations: { new: [{ id: "m1", checksum_hex: SHA_A, transaction: "default" }], noop: [] },
    }) as PlanDiffEnvelope;

    assert.deepEqual(diff.site.added.map((entry) => entry.path), ["b.html", "m.html"]);
    assert.deepEqual(diff.site.removed, ["z.html"]);
    assert.equal(diff.site.changed[0]?.path, "a.html");
    assert.match(diff.summary, /1 migration new/);
    assert.match(diff.summary, /2 site paths added/);
    assert.match(diff.summary, /1 function removed/);
    assert.equal(diff.summary.includes("auth-handler"), false);
    assert.equal(/\$|USD|cost|storage|tier|pricing/i.test(diff.summary), false);
  });

  it("preserves legacy diff behavior for auth-only function metadata changes", () => {
    const from = materializeRelease({
      spec: {
        project: "p0001",
        functions: {
          replace: {
            api: { runtime: "node22", source: { sha256: SHA_A, size: 1 } },
          },
        },
      },
    });
    const to = materializeRelease({
      concreteBase: from,
      spec: {
        project: "p0001",
        functions: {
          patch: {
            set: {
              api: {
                runtime: "node22",
                source: { sha256: SHA_A, size: 1 },
                requireAuth: true,
              },
            },
          },
        },
      },
    });
    const diff = computeReleaseDiff(from, to, {
      plan_migrations: { new: [], noop: [] },
    }) as PlanDiffEnvelope;

    assert.equal(diff.is_noop, true);
    assert.deepEqual(diff.functions.changed, []);
  });

  it("emits RUN402_CORE warnings for truncation and destructive portable-state changes", () => {
    const from = materializeRelease({
      spec: {
        project: "p0001",
        site: {
          replace: Object.fromEntries(Array.from({ length: 12 }, (_, index) => [
            `page-${index}.html`,
            { sha256: index.toString(16).padStart(64, "0"), size: 1, contentType: "text/html" },
          ])),
        },
        functions: {
          replace: {
            old: { runtime: "node22", source: { sha256: SHA_A, size: 1 } },
          },
        },
        secrets: { require: ["OLD_SECRET"] },
      },
    });
    const to = materializeRelease({
      concreteBase: from,
      spec: {
        project: "p0001",
        site: { replace: {} },
        functions: { replace: {} },
        secrets: { delete: ["OLD_SECRET"] },
      },
    });
    const diff = computeReleaseDiff(from, to, {
      plan_migrations: { new: [], noop: [] },
      site_cap: 2,
      include_core_warnings: true,
    }) as PlanDiffEnvelope;

    assert.deepEqual(diff.site.totals, { added: 0, removed: 12, changed: 0 });
    assert.ok(diff.warnings.every((warning) => warning.code.startsWith("RUN402_CORE_")));
    assert.deepEqual(
      diff.warnings.map((warning) => warning.code).filter((code) =>
        [
          "RUN402_CORE_DESTRUCTIVE_FUNCTION_REMOVAL",
          "RUN402_CORE_DESTRUCTIVE_SECRET_REMOVAL",
          "RUN402_CORE_DESTRUCTIVE_SITE_BULK_REMOVAL",
          "RUN402_CORE_DIFF_TRUNCATED",
          "RUN402_CORE_ZERO_FUNCTIONS_AFTER",
          "RUN402_CORE_ZERO_SITE_FILES_AFTER",
        ].includes(code),
      ).sort(),
      [
        "RUN402_CORE_DESTRUCTIVE_FUNCTION_REMOVAL",
        "RUN402_CORE_DESTRUCTIVE_SECRET_REMOVAL",
        "RUN402_CORE_DESTRUCTIVE_SITE_BULK_REMOVAL",
        "RUN402_CORE_DIFF_TRUNCATED",
        "RUN402_CORE_ZERO_FUNCTIONS_AFTER",
        "RUN402_CORE_ZERO_SITE_FILES_AFTER",
      ],
    );
  });

  it("derives plan migrations and logical effect requirements from portable inputs", () => {
    const base = {
      ...emptyPortableReleaseState(),
      migrations: [{ migration_id: "000_seen", checksum_hex: SHA_A, transaction: "default" as const }],
    };
    const spec: ReleaseSpec = {
      project: "p0001",
      database: {
        migrations: [
          { id: "000_seen", checksum: SHA_A, sql: "select 1" },
          { id: "001_new", checksum: SHA_B, sql_ref: { sha256: SHA_B, size: 7 }, transaction: "none" },
        ],
      },
      functions: {
        patch: {
          set: { api: { runtime: "node22", source: { sha256: SHA_A, size: 3 } } },
          delete: ["old"],
        },
      },
      routes: { replace: [] },
      site: {
        patch: {
          put: { "index.html": { sha256: SHA_B, size: 11, contentType: "text/html" } },
        },
      },
    };

    assert.deepEqual(derivePlanMigrations(base, spec), {
      new: [{ id: "001_new", checksum_hex: SHA_B, transaction: "none" }],
      noop: [{ id: "000_seen", checksum_hex: SHA_A }],
    });
    assert.deepEqual(
      deriveReleaseRequirements({ spec, from: base }).map((requirement) => requirement.kind),
      [
        "content-required",
        "content-required",
        "function-change",
        "function-change",
        "migration-required",
        "migration-required",
        "route-change",
        "static-site-change",
      ],
    );
  });
});

describe("route materialization", () => {
  it("canonicalizes route entries and expands static GET to HEAD", () => {
    const materialized = materializeRoutes([
      { pattern: "/z/*", target: { type: "function", name: "api" } },
      { pattern: "/login", methods: ["GET"], target: { type: "static", file: "login.html" } },
      { pattern: "/api", methods: ["POST"], target: { type: "function", name: "api" } },
    ]);
    assert.deepEqual(
      materialized.entries.map((entry) => entry.pattern),
      ["/api", "/login", "/z/*"],
    );
    assert.deepEqual(materialized.entries[1]?.methods, ["GET", "HEAD"]);
    assert.match(materialized.manifest_sha256 ?? "", /^[0-9a-f]{64}$/);
  });

  it("requires static aliases to declare GET or GET plus HEAD explicitly", () => {
    assert.throws(
      () => materializeRoutes([
        { pattern: "/login", target: { type: "static", file: "login.html" } },
      ]),
      ReleaseSpecValidationError,
    );
    assert.throws(
      () => materializeRoutes([
        { pattern: "/login", methods: ["HEAD"], target: { type: "static", file: "login.html" } },
      ]),
      ReleaseSpecValidationError,
    );
    assert.throws(
      () => materializeRoutes([
        { pattern: "/login", methods: ["POST"], target: { type: "static", file: "login.html" } },
      ]),
      ReleaseSpecValidationError,
    );
  });

  it("rejects duplicate normalized exact route identities", () => {
    assert.throws(
      () => materializeRoutes([
        { pattern: "/admin", target: { type: "function", name: "admin" } },
        { pattern: "/admin/", target: { type: "function", name: "admin-slash" } },
      ]),
      ReleaseSpecValidationError,
    );
  });

  it("rejects empty route method lists with a stable diagnostic", () => {
    assert.throws(
      () => materializeRoutes([
        { pattern: "/api", methods: [], target: { type: "function", name: "api" } },
      ]),
      /must not be empty/,
    );
  });

  it("rejects static alias asset paths that are not release file paths", () => {
    for (const file of ["/login.html", "pages//login.html", "pages/../login.html", "pages/login.html?x=1", "pages\\login.html"]) {
      assert.throws(
        () => materializeRoutes([
          { pattern: "/login", methods: ["GET"], target: { type: "static", file } },
        ]),
        ReleaseSpecValidationError,
      );
    }
  });

  it("rejects duplicate effective route methods", () => {
    assert.throws(
      () => materializeRoutes([
        { pattern: "/login", methods: ["GET"], target: { type: "static", file: "login.html" } },
        { pattern: "/login", methods: ["HEAD"], target: { type: "function", name: "head" } },
      ]),
      ReleaseSpecValidationError,
    );
  });
});

describe("release fact protocol", () => {
  const factSpec: ReleaseSpec = {
    project: "p0001",
    database: {
      migrations: [
        { id: "001_init", checksum: SHA_A, sql: "select 1", transaction: "none" },
      ],
    },
    secrets: { require: ["API_KEY"] },
    site: {
      patch: {
        put: {
          "index.html": { sha256: SHA_B, size: 12, contentType: "text/html" },
        },
      },
    },
  };

  it("derives portable fact requirements from content, secrets, and migrations", () => {
    assert.deepEqual(
      deriveFactRequirements(factSpec).map((requirement) => requirement.kind),
      ["content", "migration", "secret"],
    );
    assert.deepEqual(
      deriveFactRequirements(factSpec).map((requirement) =>
        requirement.kind === "content"
          ? requirement.sha256
          : requirement.kind === "migration"
            ? requirement.migration_id
            : requirement.key,
      ),
      [SHA_B, "001_init", "API_KEY"],
    );
  });

  it("evaluates absent facts into public issues and migration work", () => {
    const evaluated = evaluateReleaseFacts({
      spec: factSpec,
      factSet: {
        fact_protocol_version: FACT_PROTOCOL_VERSION,
        facts: [
          { kind: "content", sha256: SHA_B, state: "absent" },
          { kind: "migration", migration_id: "001_init", state: "absent" },
          { kind: "secret", key: "API_KEY", state: "absent" },
        ],
      },
    });

    assert.equal(evaluated.ready, false);
    assert.deepEqual(
      evaluated.issues.map((issue) => issue.code),
      ["RUN402_CORE_CONTENT_MISSING", "RUN402_CORE_SECRET_MISSING"],
    );
    assert.deepEqual(evaluated.migrations.new, [{
      id: "001_init",
      checksum_hex: SHA_A,
      transaction: "none",
    }]);
    assert.deepEqual(evaluated.effects.map((effect) => effect.kind), [
      "content-required",
      "migration-required",
      "static-site-change",
    ]);
  });

  it("evaluates present facts and migration checksum conflicts", () => {
    const ready = evaluateReleaseFacts({
      spec: factSpec,
      factSet: {
        fact_protocol_version: FACT_PROTOCOL_VERSION,
        facts: [
          { kind: "content", sha256: SHA_B, state: "present", size: 12, content_type: "text/html" },
          { kind: "migration", migration_id: "001_init", state: "present", checksum_hex: SHA_A },
          { kind: "secret", key: "API_KEY", state: "present" },
        ],
      },
    });
    assert.equal(ready.ready, true);
    assert.deepEqual(ready.migrations.noop, [{ id: "001_init", checksum_hex: SHA_A }]);

    const conflict = evaluateReleaseFacts({
      spec: factSpec,
      factSet: {
        fact_protocol_version: FACT_PROTOCOL_VERSION,
        facts: [
          { kind: "content", sha256: SHA_B, state: "present" },
          { kind: "migration", migration_id: "001_init", state: "present", checksum_hex: "c".repeat(64) },
          { kind: "secret", key: "API_KEY", state: "present" },
        ],
      },
    });
    assert.deepEqual(
      conflict.issues.map((issue) => issue.code),
      ["RUN402_CORE_MIGRATION_CHECKSUM_MISMATCH"],
    );
    assert.deepEqual(conflict.migrations.conflicts, [{
      id: "001_init",
      expected_checksum_hex: SHA_A,
      observed_checksum_hex: "c".repeat(64),
    }]);
  });

  it("fails closed for missing, duplicate, unknown, unavailable, or unsupported fact sets", () => {
    assert.throws(
      () => evaluateReleaseFacts({
        spec: factSpec,
        factSet: {
          fact_protocol_version: FACT_PROTOCOL_VERSION,
          facts: [
            { kind: "content", sha256: SHA_B, state: "present" },
            { kind: "migration", migration_id: "001_init", state: "present", checksum_hex: SHA_A },
          ],
        },
      }),
      (err) => err instanceof ReleaseFactProtocolError &&
        err.code === "RUN402_CORE_FACT_INCOMPLETE_SET",
    );
    assert.throws(
      () => evaluateReleaseFacts({
        spec: factSpec,
        factSet: {
          fact_protocol_version: FACT_PROTOCOL_VERSION,
          facts: [
            { kind: "content", sha256: SHA_B, state: "present" },
            { kind: "content", sha256: SHA_B, state: "present" },
            { kind: "migration", migration_id: "001_init", state: "present", checksum_hex: SHA_A },
            { kind: "secret", key: "API_KEY", state: "present" },
          ],
        },
      }),
      (err) => err instanceof ReleaseFactProtocolError &&
        err.code === "RUN402_CORE_FACT_DUPLICATE",
    );
    assert.throws(
      () => evaluateReleaseFacts({
        spec: factSpec,
        factSet: {
          fact_protocol_version: FACT_PROTOCOL_VERSION,
          facts: [
            { kind: "content", sha256: SHA_B, state: "present" },
            { kind: "migration", migration_id: "001_init", state: "present", checksum_hex: SHA_A },
            { kind: "secret", key: "API_KEY", state: "present" },
            { kind: "secret", key: "OTHER_KEY", state: "present" },
          ],
        },
      }),
      (err) => err instanceof ReleaseFactProtocolError &&
        err.code === "RUN402_CORE_FACT_UNKNOWN",
    );
    assert.throws(
      () => evaluateReleaseFacts({
        spec: factSpec,
        factSet: {
          fact_protocol_version: FACT_PROTOCOL_VERSION,
          facts: [
            { kind: "content", sha256: SHA_B, state: "unavailable", reason: "timeout" },
            { kind: "migration", migration_id: "001_init", state: "present", checksum_hex: SHA_A },
            { kind: "secret", key: "API_KEY", state: "present" },
          ],
        },
      }),
      (err) => err instanceof ReleaseFactProtocolError &&
        err.code === "RUN402_CORE_FACT_UNAVAILABLE",
    );
    assert.throws(
      () => evaluateReleaseFacts({
        spec: factSpec,
        factSet: {
          fact_protocol_version: "run402.release_facts.v2" as typeof FACT_PROTOCOL_VERSION,
          facts: [],
        },
      }),
      (err) => err instanceof ReleaseFactProtocolError &&
        err.code === "RUN402_CORE_FACT_UNSUPPORTED_VERSION",
    );
  });
});

describe("ReleaseSpec validation and digest identities", () => {
  it("preserves the legacy apply request digest bytes for a minimal spec", () => {
    const spec: ReleaseSpec = { project: "p_oracle_0001" };
    assert.equal(
      computeApplyRequestDigestHex(spec),
      "59b44656df693a83da5281e476167d73ae5736570498e925bff71bd8b3adf0d9",
    );
    assert.equal(
      digestApplyRequest(spec),
      "run402-apply-request-v1:59b44656df693a83da5281e476167d73ae5736570498e925bff71bd8b3adf0d9",
    );
  });

  it("separates portable manifest digest from Cloud context", () => {
    const base: ReleaseSpec = {
      project: "p_a",
      idempotency_key: "idem_a",
      base: { release: "current" },
      site: {
        replace: {
          "index.html": { sha256: "aa".repeat(32), size: 10, contentType: "text/html" },
        },
      },
    };
    const moved: ReleaseSpec = {
      ...base,
      project: "p_b",
      idempotency_key: "idem_b",
      base: { release_id: "rel_other" },
    };
    assert.notEqual(digestApplyRequest(base), digestApplyRequest(moved));
    assert.equal(digestPortableManifest(base), digestPortableManifest(moved));
    assert.equal(computePortableManifestDigestHex(base), computePortableManifestDigestHex(moved));
    assert.deepEqual(normalizePortableManifest(base), {
      site: {
        replace: {
          "index.html": { sha256: "aa".repeat(32), size: 10, contentType: "text/html" },
        },
      },
    });
  });

  it("rejects unknown fields and reserved checks", () => {
    assert.throws(
      () => parseReleaseSpec({ project: "p", surprise: true }),
      ReleaseSpecValidationError,
    );
    assert.throws(
      () => validateReleaseSpec({ project: "p", checks: [{ path: "/" }] }),
      ReleaseSpecValidationError,
    );
  });

  it("accepts content types with standard parameters", () => {
    assert.doesNotThrow(() =>
      validateReleaseSpec({
        project: "p",
        site: {
          replace: {
            "index.html": {
              sha256: "aa".repeat(32),
              size: 10,
              contentType: "text/html; charset=utf-8",
            },
          },
        },
        functions: {
          replace: {
            app: {
              runtime: "node22",
              source: {
                sha256: "bb".repeat(32),
                size: 20,
                contentType: "text/javascript; charset=utf-8",
              },
            },
          },
        },
      }),
    );
    assert.throws(
      () =>
        validateReleaseSpec({
          project: "p",
          site: {
            replace: {
              "index.html": {
                sha256: "aa".repeat(32),
                size: 10,
                contentType: "text/html\ncharset=utf-8",
              },
            },
          },
        }),
      ReleaseSpecValidationError,
    );
  });

  it("canonical JSON sorts object keys and rejects non-finite numbers", () => {
    assert.equal(canonicalizeJson({ b: 1, a: true }), '{"a":true,"b":1}');
    assert.equal(canonicalizeJson({ b: undefined, a: [1, "x"] }), '{"a":[1,"x"]}');
    assert.throws(() => canonicalizeJson({ n: Number.NaN }), /Cannot canonicalize/);
    assert.throws(
      () => canonicalizeJson([undefined]),
      (err) => err instanceof ReleaseCoreError &&
        err.code === "RUN402_CORE_CANONICALIZE_UNSUPPORTED_VALUE",
    );
    assert.throws(
      () => canonicalizeJson({ id: 1n }),
      (err) => err instanceof ReleaseCoreError &&
        err.code === "RUN402_CORE_CANONICALIZE_UNSUPPORTED_VALUE",
    );
  });

  it("digests normalized portable state with identity prefix", () => {
    const digest = digestMaterializedRelease(emptyPortableReleaseState());
    assert.match(digest, /^run402-materialized-release-v1:[0-9a-f]{64}$/);
    assert.match(
      digestEvaluatedPlan({ planner: "run402.release_planner.v1", ok: true }),
      /^run402-evaluated-plan-v1:[0-9a-f]{64}$/,
    );
  });

  it("normalizes resolved typed config descriptors into an ordinary ReleaseSpec", () => {
    const config = {
      project: "p_typed_0001",
      site: {
        replace: dir("./dist", {
          files: {
            "index.html": { sha256: SHA_A, size: 12, contentType: "text/html" },
            "assets\\app.js": { sha256: SHA_B, size: 20, contentType: "text/javascript" },
          },
        }),
        public_paths: { mode: "implicit" as const },
      },
      database: {
        migrations: [
          sqlFile("./db/001_init.sql", {
            checksum: SHA_A,
            sql_ref: { sha256: SHA_A, size: 16, contentType: "text/sql" },
          }),
        ],
      },
      functions: {
        replace: {
          api: nodeFunction("./src/api.ts", {
            source: { sha256: SHA_B, size: 42, contentType: "application/javascript" },
            deps: ["zod", "hono"],
            capabilities: ["storage.write", "storage.read"],
          }),
        },
      },
    };

    assert.deepEqual(normalizeTypedConfigReleaseSpec(config), {
      project: "p_typed_0001",
      database: {
        migrations: [
          {
            id: "001_init",
            checksum: SHA_A,
            sql_ref: { sha256: SHA_A, size: 16, contentType: "text/sql" },
          },
        ],
      },
      functions: {
        replace: {
          api: {
            runtime: "node22",
            source: { sha256: SHA_B, size: 42, contentType: "application/javascript" },
            deps: ["hono", "zod"],
            capabilities: ["storage.read", "storage.write"],
          },
        },
      },
      site: {
        replace: {
          "assets/app.js": { sha256: SHA_B, size: 20, contentType: "text/javascript" },
          "index.html": { sha256: SHA_A, size: 12, contentType: "text/html" },
        },
        public_paths: { mode: "implicit" },
      },
    });
  });

  it("requires typed config descriptors to be resolved before canonical normalization", () => {
    assert.throws(
      () => normalizeTypedConfigReleaseSpec({ project: "p", site: { replace: dir("./dist") } }),
      (err) => err instanceof ReleaseSpecValidationError &&
        /must be resolved with files/.test(err.message),
    );
    assert.throws(
      () => normalizeTypedConfigReleaseSpec({ project: "p", site: { replace: file("../index.html") } }),
      (err) => err instanceof ReleaseSpecValidationError &&
        /content ref/.test(err.message),
    );
    assert.throws(
      () => normalizeTypedConfigReleaseSpec({ project: "p", site: { replace: { "../escape.html": { sha256: SHA_A, size: 1 } } } }),
      (err) => err instanceof ReleaseSpecValidationError &&
        /stay inside/.test(err.message),
    );
  });

  it("reviewed plan fingerprints ignore display-only fields but bind semantic approvals", () => {
    const base = {
      release_spec_digest: digestApplyRequest({ project: "p", site: { replace: { "index.html": { sha256: SHA_A, size: 1 } } } }),
      concrete_base_identity: "release:rel_123",
      materialized_diff_digest: "run402-diff-v1:abc",
      warnings: [
        { code: "run402.warning.sync_prune", resource: "site", details: { delete_count: 2 } },
        { code: "run402.warning.secret_missing", resource: "secrets.API_KEY" },
      ],
      destructive_actions: [
        { kind: "delete_static_assets", resource: "site", count: 2, digest: SHA_A },
      ],
    } as const;

    const reordered = {
      ...base,
      display_summary: "not part of the fingerprint",
      warnings: [...base.warnings].reverse(),
      destructive_actions: [...base.destructive_actions].reverse(),
    };
    assert.equal(
      digestReviewedPlanFingerprint(base),
      digestReviewedPlanFingerprint(reordered),
    );
    assert.match(
      digestReviewedPlanFingerprint(base),
      new RegExp(`^${REVIEWED_PLAN_FINGERPRINT_IDENTITY}:[0-9a-f]{64}$`),
    );
    assert.match(computeReviewedPlanFingerprintHex(base), /^[0-9a-f]{64}$/);
    assert.notEqual(
      digestReviewedPlanFingerprint(base),
      digestReviewedPlanFingerprint({
        ...base,
        warnings: [{ code: "run402.warning.other", resource: "site" }],
      }),
    );
    assert.deepEqual(normalizeReviewedPlanFingerprint(base).planner_semantics_version, "run402.release_planner.v1");
  });

  it("materialized release digests are invariant to unordered state sets", () => {
    const stateA: PortableReleaseState = {
      ...emptyPortableReleaseState(),
      site: {
        paths: [
          { path: "/z.html", content_sha256: SHA_B, size_bytes: 2, content_type: "text/html" },
          { path: "/a.html", content_sha256: SHA_A, size_bytes: 1, content_type: "text/html" },
        ],
      },
      functions: [
        {
          name: "worker",
          code_hash: SHA_B,
          runtime: "node22",
          timeout_seconds: 10,
          memory_mb: 128,
          schedule: null,
          deps: ["z", "a"],
          require_auth: true,
          require_role: {
            table: "members",
            idColumn: "user_id",
            roleColumn: "role",
            allowed: ["owner", "admin"],
          },
          capabilities: ["storage.write", "storage.read"],
        },
        {
          name: "api",
          code_hash: SHA_A,
          runtime: "node22",
          timeout_seconds: 30,
          memory_mb: 256,
          schedule: null,
          deps: [],
          require_auth: false,
          require_role: null,
        },
      ],
      secrets: { keys: ["ZED", "API_KEY"] },
      subdomains: { names: ["www", "api"] },
      migrations: [
        { migration_id: "002_more", checksum_hex: "AB".repeat(32), transaction: "default" },
        { migration_id: "001_init", checksum_hex: "CD".repeat(32), transaction: "none" },
      ],
    };
    const stateB: PortableReleaseState = {
      ...emptyPortableReleaseState(),
      site: {
        paths: [
          { path: "/a.html", content_sha256: SHA_A, size_bytes: 1, content_type: "text/html" },
          { path: "/z.html", content_sha256: SHA_B, size_bytes: 2, content_type: "text/html" },
        ],
      },
      functions: [
        {
          name: "api",
          code_hash: SHA_A,
          runtime: "node22",
          timeout_seconds: 30,
          memory_mb: 256,
          schedule: null,
          deps: [],
          require_auth: false,
          require_role: null,
        },
        {
          name: "worker",
          code_hash: SHA_B,
          runtime: "node22",
          timeout_seconds: 10,
          memory_mb: 128,
          schedule: null,
          deps: ["a", "z"],
          require_auth: true,
          require_role: {
            table: "members",
            idColumn: "user_id",
            roleColumn: "role",
            allowed: ["admin", "owner"],
          },
          capabilities: ["storage.read", "storage.write"],
        },
      ],
      secrets: { keys: ["API_KEY", "ZED"] },
      subdomains: { names: ["api", "www"] },
      migrations: [
        { migration_id: "001_init", checksum_hex: "cd".repeat(32), transaction: "none" },
        { migration_id: "002_more", checksum_hex: "ab".repeat(32), transaction: "default" },
      ],
    };

    assert.equal(computeMaterializedReleaseDigestHex(stateA), computeMaterializedReleaseDigestHex(stateB));
    assert.equal(digestMaterializedRelease(stateA), digestMaterializedRelease(stateB));
  });
});
