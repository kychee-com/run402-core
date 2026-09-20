import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isVersionedSiteAsset, isHtmlSitePath } from "./static-cache.js";
import { buildStaticManifestFromPortableState } from "./materialize.js";
import { classifyStaticCacheClass, buildStaticManifestFromEntries } from "./static-manifest.js";
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
  }
});
