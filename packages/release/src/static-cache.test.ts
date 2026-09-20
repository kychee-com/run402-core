import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isVersionedSiteAsset, isHtmlSitePath } from "./static-cache.js";
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
