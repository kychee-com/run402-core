import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ROUTE_TABLE_LIMIT,
  ReleaseSpecValidationError,
  computeApplyRequestDigestHex,
  computeReleaseDiff,
  isValidAppRepoName,
  materializeRelease,
  materializeRoutes,
  validateReleaseSpec,
  type ReleaseSpec,
  type RouteSpec,
} from "./index.js";

const GATE = { table: "members", idColumn: "user_id", roleColumn: "role", allowed: ["admin"] };

function isInvalidAt(resource: string, message?: RegExp) {
  return (error: unknown) =>
    error instanceof ReleaseSpecValidationError &&
    error.resource === resource &&
    (message === undefined || message.test(error.message));
}

describe("repo route targets", () => {
  it("accepts a prefix repo route and normalizes path to a directory prefix", () => {
    const materialized = materializeRoutes([
      { pattern: "/content/*", target: { type: "repo", repo: "default", path: "public" } },
    ]);
    const entry = materialized.entries[0]!;
    assert.equal(entry.kind, "prefix");
    assert.equal(entry.prefix, "/content/");
    assert.deepEqual(entry.methods, ["GET", "HEAD"]);
    assert.deepEqual(entry.target, { type: "repo", repo: "default", path: "public/" });
    assert.match(materialized.manifest_sha256 ?? "", /^[0-9a-f]{64}$/);
  });

  it("defaults a prefix repo route's path to the repo root", () => {
    const materialized = materializeRoutes([
      { pattern: "/data/*", methods: ["GET"], target: { type: "repo", repo: "site.data_1" } },
    ]);
    assert.deepEqual(materialized.entries[0]?.target, { type: "repo", repo: "site.data_1", path: "" });
    assert.deepEqual(materialized.entries[0]?.methods, ["GET", "HEAD"]);
  });

  it("accepts an exact repo route whose path names the file", () => {
    const materialized = materializeRoutes([
      { pattern: "/robots.txt", target: { type: "repo", repo: "default", path: "public/robots.txt" } },
    ]);
    assert.equal(materialized.entries[0]?.kind, "exact");
    assert.deepEqual(materialized.entries[0]?.target, { type: "repo", repo: "default", path: "public/robots.txt" });
  });

  it("requires a file path on an exact repo route", () => {
    assert.throws(
      () => materializeRoutes([{ pattern: "/robots.txt", target: { type: "repo", repo: "default" } }]),
      isInvalidAt("routes.replace.0.target.path", /required for an exact pattern/),
    );
    assert.throws(
      () => materializeRoutes([{ pattern: "/robots.txt", target: { type: "repo", repo: "default", path: "public/" } }]),
      isInvalidAt("routes.replace.0.target.path", /name a file/),
    );
  });

  it("rejects bad repo names", () => {
    for (const repo of ["", "Default", "-x", ".x", "a/b", "repo.git", "a".repeat(65), 7]) {
      assert.throws(
        () => materializeRoutes([{ pattern: "/c/*", target: { type: "repo", repo } } as never]),
        isInvalidAt("routes.replace.0.target.repo"),
        `repo ${String(repo)}`,
      );
    }
    assert.equal(isValidAppRepoName("a".repeat(64)), true);
    assert.equal(isValidAppRepoName("my.repo-1_x"), true);
  });

  it("rejects bad repo paths", () => {
    for (const path of ["/public", "a//b", "a/./b", "../x", "a/..", ".git/config", "a/.GIT/", "a\\b", "a?x", "a#x", 3]) {
      assert.throws(
        () => materializeRoutes([{ pattern: "/c/*", target: { type: "repo", repo: "default", path } } as never]),
        isInvalidAt("routes.replace.0.target.path"),
        `path ${String(path)}`,
      );
    }
  });

  it("rejects unknown repo target keys", () => {
    assert.throws(
      () => materializeRoutes([{ pattern: "/c/*", target: { type: "repo", repo: "default", file: "x" } } as never]),
      isInvalidAt("routes.replace.0.target.file"),
    );
  });

  it("allows only GET and HEAD on repo routes", () => {
    assert.throws(
      () => materializeRoutes([{ pattern: "/c/*", methods: ["POST"], target: { type: "repo", repo: "default" } }]),
      isInvalidAt("routes.replace.0.methods", /repo route targets support only GET/),
    );
    assert.throws(
      () => materializeRoutes([{ pattern: "/c/*", methods: ["HEAD"], target: { type: "repo", repo: "default" } }]),
      ReleaseSpecValidationError,
    );
  });

  it("rejects pricing on repo routes", () => {
    assert.throws(
      () => materializeRoutes([{
        pattern: "/c/*",
        target: { type: "repo", repo: "default" },
        pricing: { mode: "always", amount_usd_micros: 1000, pay_to: "org_default_payout" },
      }]),
      isInvalidAt("routes.replace.0.pricing", /only supported on function routes/),
    );
  });

  it("validates role gates like functions and canonicalizes them", () => {
    const materialized = materializeRoutes([
      {
        pattern: "/private/*",
        target: { type: "repo", repo: "default", requireAuth: true, requireRole: { ...GATE, cacheTtl: 30 } },
      },
      { pattern: "/open/*", target: { type: "repo", repo: "default", requireAuth: false, requireRole: null } },
    ]);
    assert.deepEqual(materialized.entries.find((e) => e.pattern === "/private/*")?.target, {
      type: "repo",
      repo: "default",
      path: "",
      requireAuth: true,
      requireRole: { ...GATE, cacheTtl: 30 },
    });
    assert.deepEqual(materialized.entries.find((e) => e.pattern === "/open/*")?.target, {
      type: "repo",
      repo: "default",
      path: "",
    });
    assert.throws(
      () => materializeRoutes([{ pattern: "/c/*", target: { type: "repo", repo: "default", requireAuth: "yes" } } as never]),
      isInvalidAt("routes.replace.0.target.requireAuth"),
    );
    assert.throws(
      () => materializeRoutes([{ pattern: "/c/*", target: { type: "repo", repo: "default", requireRole: { ...GATE, table: "public.members" } } }]),
      isInvalidAt("routes.replace.0.target.requireRole.table"),
    );
    assert.throws(
      () => materializeRoutes([{ pattern: "/c/*", target: { type: "repo", repo: "default", requireRole: { ...GATE, extra: 1 } } } as never]),
      isInvalidAt("routes.replace.0.target.requireRole.extra"),
    );
  });

  it("counts repo routes toward the route table limit", () => {
    const routes: RouteSpec[] = Array.from({ length: ROUTE_TABLE_LIMIT + 1 }, (_, i) => ({
      pattern: `/c${i}/*`,
      target: { type: "repo", repo: "default" },
    }));
    assert.throws(() => materializeRoutes(routes), /exceeds 100-entry limit/);
  });

  it("names all three target types when the type is unsupported", () => {
    assert.throws(
      () => materializeRoutes([{ pattern: "/c", target: { type: "handler" } } as never]),
      /'function', 'static' or 'repo'/,
    );
    assert.throws(
      () => validateReleaseSpec({ project: "p0001", routes: { replace: [{ pattern: "/c", target: { type: "handler" } }] } } as never),
      /function, static or repo/,
    );
  });

  it("validateReleaseSpec accepts repo routes and rejects bad ones without a repo lookup", () => {
    const spec: ReleaseSpec = {
      project: "p0001",
      routes: { replace: [{ pattern: "/data/*", target: { type: "repo", repo: "default", path: "public/" } }] },
    };
    validateReleaseSpec(spec);
    assert.match(computeApplyRequestDigestHex(spec), /^[0-9a-f]{64}$/);
    assert.throws(
      () => validateReleaseSpec({ project: "p0001", routes: { replace: [{ pattern: "/x", target: { type: "repo", repo: "default" } }] } }),
      isInvalidAt("routes.replace.0.target.path"),
    );
    assert.throws(
      () => validateReleaseSpec({ project: "p0001", routes: { replace: [{ pattern: "/x/*", methods: ["POST"], target: { type: "repo", repo: "default" } }] } }),
      isInvalidAt("routes.replace.0.methods"),
    );
    assert.throws(
      () => validateReleaseSpec({
        project: "p0001",
        routes: { replace: [{
          pattern: "/x/*",
          target: { type: "repo", repo: "default" },
          pricing: { mode: "always", amount_usd_micros: 1, pay_to: "org_default_payout" },
        }] },
      }),
      isInvalidAt("routes.replace.0.pricing"),
    );
    assert.throws(
      () => validateReleaseSpec({ project: "p0001", routes: { replace: [{ pattern: "/x/*", target: { type: "repo", repo: "Bad" } }] } }),
      isInvalidAt("routes.replace.0.target.repo"),
    );
  });

  it("materializes a release carrying repo targets with no static file and no manifest entry", () => {
    const first = materializeRelease({
      spec: {
        project: "p0001",
        routes: { replace: [
          { pattern: "/data/*", target: { type: "repo", repo: "default", path: "public/" } },
          { pattern: "/robots.txt", target: { type: "repo", repo: "default", path: "robots.txt" } },
        ] },
      },
    });
    assert.deepEqual(first.routes.entries.map((e) => e.target.type), ["repo", "repo"]);
    assert.equal(first.static_manifest, null);

    // Carried forward from the base without a routes slice, next to a site.
    const second = materializeRelease({
      spec: {
        project: "p0001",
        site: { replace: { "index.html": { sha256: "a".repeat(64), size: 1, contentType: "text/html" } } },
      },
      concreteBase: first,
    });
    assert.deepEqual(second.routes, first.routes);
    assert.equal(
      Object.values(second.static_manifest?.files ?? {}).some((f) => f.authority === "route_static_alias"),
      false,
    );

    const diff = computeReleaseDiff(first, first);
    assert.deepEqual(diff.routes.changed, []);
    const changed = materializeRelease({
      spec: { project: "p0001", routes: { replace: [
        { pattern: "/data/*", target: { type: "repo", repo: "default", path: "content/" } },
        { pattern: "/robots.txt", target: { type: "repo", repo: "default", path: "robots.txt" } },
      ] } },
    });
    assert.deepEqual(computeReleaseDiff(first, changed).routes.changed.map((c) => c.pattern), ["/data/*"]);
  });
});
