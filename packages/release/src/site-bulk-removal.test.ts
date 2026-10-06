import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifySiteBulkRemoval,
  computeReleaseDiff,
  materializeRelease,
  type PlanDiffEnvelope,
} from "./index.js";

// Eight-character mixed-case base64url tokens: the Vite/Astro default.
function hash(i: number, salt: string): string {
  return `${salt}${String(i).padStart(3, "0")}XyZ`;
}

function pages(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `docs/page-${i}/index.html`);
}

function bundles(n: number, salt: string, dir = "_astro", ext = "js"): string[] {
  return Array.from({ length: n }, (_, i) => `${dir}/chunk${i}.${hash(i, salt)}.${ext}`);
}

function siteOf(paths: string[]) {
  return Object.fromEntries(paths.map((path, index) => [
    path,
    { sha256: index.toString(16).padStart(64, "0"), size: 1, contentType: path.endsWith(".html") ? "text/html" : "text/javascript" },
  ]));
}

describe("classifySiteBulkRemoval", () => {
  it("does not count fingerprinted bundles a rebuild replaces (kychee-com/run402#614)", () => {
    const stable = [...pages(80), "index.html", "favicon.ico", "manifest.webmanifest", "robots.txt", "img/logo.png", "img/hero.jpg", "sitemap.xml"];
    const base = [...stable, ...bundles(33, "Ab")];
    const to = [...stable, ...bundles(33, "Cd")];
    assert.equal(base.length, 120);
    assert.equal(classifySiteBulkRemoval(base, to), null);
  });

  it("still fires on a real bulk removal and lists the paths", () => {
    const result = classifySiteBulkRemoval(["index.html", "about.html", "a.js", "b.js", "c.css"], ["index.html", "about.html"]);
    assert.ok(result);
    assert.equal(result.counted_removed, 3);
    assert.deepEqual(result.affected, ["a.js", "b.js", "c.css"]);
    assert.deepEqual(result.counted_removed_by_dir, { "/": 3 });
  });

  it("counts bundles a plan drops without replacements, and the excess of a shrinking build", () => {
    const dropped = classifySiteBulkRemoval([...pages(10), ...bundles(10, "Ab")], pages(10));
    assert.ok(dropped);
    assert.equal(dropped.counted_removed, 10);
    assert.deepEqual(dropped.counted_removed_by_dir, { "/_astro/": 10 });

    const shrunk = classifySiteBulkRemoval([...pages(10), ...bundles(10, "Ab")], [...pages(10), ...bundles(4, "Cd")]);
    assert.ok(shrunk);
    assert.equal(shrunk.replaced_fingerprinted, 4);
    assert.equal(shrunk.counted_removed, 6);
  });

  it("does not pair across directories or extensions, nor treat unfingerprinted paths as replaced", () => {
    const crossed = classifySiteBulkRemoval(
      [...pages(10), ...bundles(5, "Ab", "_astro", "js")],
      [...pages(10), ...bundles(5, "Cd", "assets", "js"), ...bundles(5, "Ef", "_astro", "css")],
    );
    assert.ok(crossed);
    assert.equal(crossed.replaced_fingerprinted, 0);

    const plain = classifySiteBulkRemoval(
      [...pages(5), "_astro/settings.json", "app.js", "styles.css"],
      [...pages(5), ...bundles(3, "Cd", "_astro", "json"), "app.AbC12345.js"],
    );
    assert.ok(plain);
    assert.deepEqual(plain.affected, ["_astro/settings.json", "app.js", "styles.css"]);
  });

  it("stays quiet at exactly the threshold and on an empty base", () => {
    assert.equal(classifySiteBulkRemoval(pages(10), pages(9)), null);
    assert.equal(classifySiteBulkRemoval([], ["index.html"]), null);
  });

  it("drives RUN402_CORE_DESTRUCTIVE_SITE_BULK_REMOVAL in computeReleaseDiff", () => {
    const stable = pages(20);
    const from = materializeRelease({ spec: { project: "p0001", site: { replace: siteOf([...stable, ...bundles(10, "Ab")]) } } });
    const rebuilt = materializeRelease({ concreteBase: from, spec: { project: "p0001", site: { replace: siteOf([...stable, ...bundles(10, "Cd")]) } } });
    const codes = (to: typeof from) =>
      (computeReleaseDiff(from, to, { plan_migrations: { new: [], noop: [] }, include_core_warnings: true }) as PlanDiffEnvelope)
        .warnings.map((warning) => warning.code);
    assert.ok(!codes(rebuilt).includes("RUN402_CORE_DESTRUCTIVE_SITE_BULK_REMOVAL"));

    const gutted = materializeRelease({ concreteBase: from, spec: { project: "p0001", site: { replace: siteOf(stable.slice(0, 10)) } } });
    const diff = computeReleaseDiff(from, gutted, { plan_migrations: { new: [], noop: [] }, include_core_warnings: true }) as PlanDiffEnvelope;
    const warning = diff.warnings.find((entry) => entry.code === "RUN402_CORE_DESTRUCTIVE_SITE_BULK_REMOVAL");
    assert.ok(warning);
    assert.equal(warning.affected.length, 20);
    assert.equal(warning.details?.counted_removed, 20);
    assert.deepEqual(warning.details?.counted_removed_by_dir, { "/_astro/": 10, "/docs/": 10 });
  });
});
