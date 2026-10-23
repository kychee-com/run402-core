import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  computeReleaseDiff,
  materializeRelease,
  type PlanDiffEnvelope,
  type ReleaseDiffEnvelope,
  type ReleaseSpec,
} from "./index.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

const FILES = {
  "events.html": { sha256: SHA_A, size: 100, contentType: "text/html" },
  "calendar.html": { sha256: SHA_B, size: 100, contentType: "text/html" },
};

function release(site: ReleaseSpec["site"]) {
  return materializeRelease({ spec: { project: "p0001", site } });
}

function planDiff(from: ReturnType<typeof release>, to: ReturnType<typeof release>): PlanDiffEnvelope {
  return computeReleaseDiff(from, to, { plan_migrations: { new: [], noop: [] } }) as PlanDiffEnvelope;
}

describe("computeReleaseDiff — public paths", () => {
  it("a change to site.public_paths alone is not a noop and says what moved", () => {
    const from = release({
      replace: FILES,
      public_paths: { mode: "explicit", replace: { "/events": { asset: "events.html" } } },
    });
    const to = release({
      replace: FILES,
      public_paths: { mode: "explicit", replace: { "/calendar": { asset: "events.html" } } },
    });

    const diff = planDiff(from, to);

    assert.equal(diff.is_noop, false);
    assert.deepEqual(diff.site.added, []);
    assert.deepEqual(diff.site.removed, []);
    assert.deepEqual(diff.public_paths.added, [{ public_path: "/calendar", asset_path: "events.html" }]);
    assert.deepEqual(diff.public_paths.removed, ["/events"]);
    assert.match(diff.summary, /1 public path added, 1 public path removed/);
  });

  it("reports a public path that now serves a different asset as changed", () => {
    const from = release({
      replace: FILES,
      public_paths: { mode: "explicit", replace: { "/events": { asset: "events.html" } } },
    });
    const to = release({
      replace: FILES,
      public_paths: { mode: "explicit", replace: { "/events": { asset: "calendar.html" } } },
    });

    const diff = planDiff(from, to);

    assert.equal(diff.is_noop, false);
    assert.deepEqual(diff.public_paths.changed, [
      { public_path: "/events", asset_path_old: "events.html", asset_path_new: "calendar.html" },
    ]);
    assert.match(diff.summary, /1 public path changed/);
  });

  it("a switch from explicit to implicit mode, which widens reachability, is not a noop", () => {
    const from = release({
      replace: FILES,
      public_paths: { mode: "explicit", replace: { "/events": { asset: "events.html" } } },
    });
    const to = release({ replace: FILES, public_paths: { mode: "implicit" } });

    const diff = planDiff(from, to);

    assert.equal(diff.is_noop, false);
    assert.equal(diff.public_paths.mode_old, "explicit");
    assert.equal(diff.public_paths.mode_new, "implicit");
    assert.match(diff.summary, /public path mode explicit to implicit/);
  });

  it("an unchanged release stays a noop with an empty public path diff", () => {
    const site: ReleaseSpec["site"] = {
      replace: FILES,
      public_paths: { mode: "explicit", replace: { "/events": { asset: "events.html" } } },
    };
    const diff = planDiff(release(site), release(site));

    assert.equal(diff.is_noop, true);
    assert.equal(diff.summary, "No changes (noop)");
    assert.deepEqual(diff.public_paths, {
      mode_old: "explicit",
      mode_new: "explicit",
      added: [],
      removed: [],
      changed: [],
      totals: undefined,
    });
  });

  it("leaves a file reachable by its own name to the site diff in implicit mode", () => {
    const from = release({ replace: { "events.html": FILES["events.html"] } });
    const to = release({ replace: FILES });

    const diff = planDiff(from, to);

    assert.equal(diff.site.added.length, 1);
    assert.deepEqual(diff.public_paths.added, []);
    assert.deepEqual(diff.public_paths.removed, []);
    assert.equal(diff.summary, "1 site path added");
  });

  it("states a public path change in the release-to-release diff too", () => {
    const from = release({
      replace: FILES,
      public_paths: { mode: "explicit", replace: { "/events": { asset: "events.html" } } },
    });
    const to = release({
      replace: FILES,
      public_paths: { mode: "explicit", replace: { "/calendar": { asset: "events.html" } } },
    });

    const diff = computeReleaseDiff(from, to) as ReleaseDiffEnvelope;

    assert.equal(diff.is_noop, false);
    assert.match(diff.summary, /1 public path added, 1 public path removed/);
  });
});
