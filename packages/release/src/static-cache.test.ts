import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isVersionedSiteAsset, isHtmlSitePath } from "./static-cache.js";
import { buildStaticManifestFromPortableState } from "./materialize.js";
import { classifyStaticCacheClass, buildStaticManifestFromEntries, canonicalizeStaticManifest } from "./static-manifest.js";
import { STATIC_MANIFEST_VERSION } from "./versions.js";
const fixtures = JSON.parse(readFileSync(new URL("../test/fixtures/static-cache.json", import.meta.url), "utf8")) as { immutable: string[]; revalidating: string[] };
describe("canonical static cache classifier", () => {
  for (const [group, paths] of Object.entries(fixtures)) for (const path of paths) {
    it(path, () => {
      const immutable = group === "immutable";
      assert.equal(isVersionedSiteAsset(path), immutable);
      assert.equal(isVersionedSiteAsset("/" + path + "?v=deadbeef#ignored"), immutable);
      const cacheClass = isHtmlSitePath(path) ? "html" : immutable ? "immutable_versioned" : "revalidating_asset";
      assert.equal(classifyStaticCacheClass({ path }).cache_class, cacheClass);
      const manifest = buildStaticManifestFromEntries([{ public_path: path, asset_path: path, authority: "implicit_file_path", direct: true, sha256: "a".repeat(64), size: 1, content_type: "application/octet-stream" }]);
      assert.equal(manifest.files["/" + path]!.cache_class, cacheClass);
    });
  }
  it("HTML MIME types win over fingerprinted names", () => {
    for (const type of ["TEXT/HTML; charset=utf-8", "application/xhtml+xml"]) {
      assert.equal(classifyStaticCacheClass({ path: "/app-2RHH4Euo.js", contentType: type }).cache_class, "html");
    }
  });
  it("explicit mutable declarations and prior mutable paths stay authoritative", () => {
    assert.equal(classifyStaticCacheClass({ path: "/app-2RHH4Euo.js", declaredCacheClass: "revalidating_asset" }).cache_class, "revalidating_asset");
    assert.equal(classifyStaticCacheClass({ path: "/app-2RHH4Euo.js", previous: { sha256: "a".repeat(64), cache_class: "revalidating_asset" } }).cache_class, "revalidating_asset");
    assert.equal(classifyStaticCacheClass({ path: "/_astro/settings.json", declaredCacheClass: "immutable_versioned" }).cache_class, "revalidating_asset");
  });
  it("unchanged bytes shed an older classifier's revalidating verdict", () => {
    const path = "/_astro/auth-hosted.DcxaOapR.css";
    const sha = "a".repeat(64);
    for (const source of ["downgraded", "inferred_sha_filename"] as const) {
      const result = classifyStaticCacheClass({ path, sha256: sha, previous: { sha256: sha, cache_class: "revalidating_asset", cache_class_source: source } });
      assert.equal(result.cache_class, "immutable_versioned");
      assert.equal(result.cache_class_source, "inferred_sha_filename");
      assert.deepEqual(result.warnings, []);
    }
  });
  it("changed bytes, a mutable declaration or an unknown history keep the prior revalidating verdict", () => {
    const path = "/assets/pdf.worker.min-BjVQVX8e.js";
    const sha = "a".repeat(64);
    const cases = [
      { sha256: "b".repeat(64), previous: { sha256: sha, cache_class: "revalidating_asset", cache_class_source: "downgraded" } },
      { sha256: sha, previous: { sha256: sha, cache_class: "revalidating_asset", cache_class_source: "declared" } },
      { sha256: sha, previous: { sha256: sha, cache_class: "revalidating_asset", cache_class_source: "legacy" } },
      { sha256: sha, previous: { sha256: sha, cache_class: "revalidating_asset" } },
      { previous: { sha256: sha, cache_class: "revalidating_asset", cache_class_source: "downgraded" } },
    ] as const;
    for (const input of cases) {
      const result = classifyStaticCacheClass({ path, ...input });
      assert.equal(result.cache_class, "revalidating_asset");
      assert.equal(result.cache_class_source, "downgraded");
    }
  });
});

// Exercise the actual compiler, not only the classification helper. The live
// upgrade regression was caused by forgetting to pass the prior entry here.
describe("compiler preserves prior mutable policy", () => {
  for (const mode of ["implicit", "explicit"] as const) {
    it(mode + " public paths retain their previous mutable class", () => {
      const path = "/assets/index-BBEEV3ml.js";
      const previous = buildStaticManifestFromEntries([{ public_path: path, asset_path: path.slice(1), sha256: "a".repeat(64), size: 1, cache_class: "revalidating_asset", authority: "explicit_public_path", direct: true }]);
      const paths = [{ path: path.slice(1), content_sha256: "b".repeat(64), size_bytes: 1, content_type: "application/javascript" }];
      const routes = { manifest_sha256: null, entries: [] };
      const spec = mode === "implicit" ? { mode } : { mode, replace: { [path]: { asset: path.slice(1) } } };
      const result = buildStaticManifestFromPortableState(paths, routes, previous, spec);
      assert.equal(result.manifest!.files[path]!.cache_class, "revalidating_asset");
      assert.equal(result.manifest!.files[path]!.cache_class_source, "downgraded");
      const fresh = buildStaticManifestFromPortableState(paths, routes, null, spec);
      assert.equal(fresh.manifest!.files[path]!.cache_class, "immutable_versioned");
    });
    it(mode + " public paths regain immutable when an older classifier downgraded unchanged bytes", () => {
      const path = "/_astro/auth-hosted.DcxaOapR.css";
      const previous = canonicalizeStaticManifest({ version: STATIC_MANIFEST_VERSION, files: { [path]: { sha256: "a".repeat(64), size: 1, content_type: "text/css", cache_class: "revalidating_asset", cache_class_source: "downgraded" } } });
      const routes = { manifest_sha256: null, entries: [] };
      const spec = mode === "implicit" ? { mode } : { mode, replace: { [path]: { asset: path.slice(1) } } };
      const unchanged = [{ path: path.slice(1), content_sha256: "a".repeat(64), size_bytes: 1, content_type: "text/css" }];
      const regained = buildStaticManifestFromPortableState(unchanged, routes, previous, spec).manifest!.files[path]!;
      assert.equal(regained.cache_class, "immutable_versioned");
      assert.equal(regained.cache_class_source, "inferred_sha_filename");
      const changed = [{ path: path.slice(1), content_sha256: "b".repeat(64), size_bytes: 1, content_type: "text/css" }];
      const held = buildStaticManifestFromPortableState(changed, routes, previous, spec).manifest!.files[path]!;
      assert.equal(held.cache_class, "revalidating_asset");
      assert.equal(held.cache_class_source, "downgraded");
    });
  }
});
