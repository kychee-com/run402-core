#!/usr/bin/env node
// Tarball smoke test for @run402/release.

import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RELEASE_DIR = resolve(__dirname, "..");
const SCRATCH = mkdtempSync(join(tmpdir(), "run402-release-smoke-"));

function run(cmd, opts = {}) {
  return execSync(cmd, { stdio: "pipe", encoding: "utf-8", ...opts });
}

function step(label, fn) {
  process.stdout.write(`${label} ... `);
  try {
    const out = fn();
    process.stdout.write("OK\n");
    return out;
  } catch (err) {
    process.stdout.write("FAIL\n");
    console.error(err.stdout?.toString() ?? "");
    console.error(err.stderr?.toString() ?? "");
    console.error(err.message);
    process.exit(1);
  }
}

try {
  let tarball;
  step("npm run build", () => {
    run("npm run build", { cwd: RELEASE_DIR });
  });
  step("npm pack", () => {
    run(`npm pack --pack-destination "${SCRATCH}"`, { cwd: RELEASE_DIR });
    const tgz = readdirSync(SCRATCH).find((file) => file.endsWith(".tgz"));
    if (!tgz) throw new Error("npm pack produced no tarball");
    tarball = join(SCRATCH, tgz);
  });

  const installDir = join(SCRATCH, "install");
  mkdirSync(installDir);
  step("install tarball in clean consumer", () => {
    run("npm init -y", { cwd: installDir });
    run(`npm install --before=9999-12-31 "${tarball}"`, { cwd: installDir });
  });

  step("import public entrypoint", () => {
    const result = run(
      `node --input-type=module -e "import { RELEASE_PACKAGE_NAME, releasePackageInfo, digestApplyRequest, digestPortableManifest, emptyPortableReleaseState, digestMaterializedRelease, parseReleaseSpec } from '@run402/release'; if (RELEASE_PACKAGE_NAME !== '@run402/release') process.exit(1); const info = releasePackageInfo(); if (info.plannerSemanticsVersion !== 'run402.release_planner.v1') process.exit(1); const spec = parseReleaseSpec({ project: 'p_smoke' }); if (!digestApplyRequest(spec).startsWith('run402-apply-request-v1:')) process.exit(1); if (!digestPortableManifest(spec).startsWith('run402-portable-manifest-v1:')) process.exit(1); if (!digestMaterializedRelease(emptyPortableReleaseState()).startsWith('run402-materialized-release-v1:')) process.exit(1); console.log('release smoke OK');"`,
      { cwd: installDir },
    );
    if (!result.includes("release smoke OK")) {
      throw new Error(`unexpected smoke output: ${result}`);
    }
  });

  step("tarball excludes private implementation details", () => {
    const listing = run(`tar -tzf "${tarball}"`);
    const required = [
      "package/schemas/release-spec.v1.schema.json",
      "package/schemas/portable-release-state.v1.schema.json",
      "package/docs/canonicalization.md",
      "package/docs/compatibility.md",
      "package/docs/field-support.md",
      "package/LICENSE",
    ];
    const missing = required.filter((needle) => !listing.includes(needle));
    if (missing.length > 0) {
      throw new Error(`missing tarball entries: ${missing.join(", ")}`);
    }
    const forbidden = [
      "open" + "spec/",
      "run402-" + "private",
      "packages/" + "gateway",
      ".env",
      "aws",
      "aurora",
      "fl" + "eet",
    ];
    const found = forbidden.filter((needle) => listing.toLowerCase().includes(needle.toLowerCase()));
    if (found.length > 0) {
      throw new Error(`forbidden tarball entries: ${found.join(", ")}`);
    }
  });

  console.log("All @run402/release smoke checks passed");
} finally {
  rmSync(SCRATCH, { recursive: true, force: true });
}
