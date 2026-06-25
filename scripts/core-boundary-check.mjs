import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const root = new URL("../", import.meta.url).pathname;
const checkedRoots = [
  "apps/core-gateway",
  "packages/runtime-kernel",
  "docker",
  "fixtures/runtime-kernel-static-rest",
  "scripts",
];
const forbiddenText = [
  "run402-private",
  "npm.pkg.github.com",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "BEGIN PRIVATE KEY",
];
const forbiddenImports = [
  "@aws-sdk/",
  "aws-sdk",
  "packages/gateway",
  "services/billing",
  "middleware/x402",
  "lifecycle-gate",
  "cloudfront",
  "s3-presign",
];

const failures = [];
const packageManifests = [];

for (const relativeRoot of checkedRoots) {
  for (const file of await walk(path.join(root, relativeRoot))) {
    const text = await readFile(file, "utf8");
    for (const forbidden of forbiddenText) {
      if (text.includes(forbidden)) {
        failures.push(`${relative(file)} contains forbidden text: ${forbidden}`);
      }
    }
    for (const line of text.split("\n")) {
      if (!/^\s*import\b/.test(line)) continue;
      for (const forbidden of forbiddenImports) {
        if (line.includes(forbidden)) {
          failures.push(`${relative(file)} imports forbidden dependency pattern: ${forbidden}`);
        }
      }
    }
    if (path.basename(file) === "package.json") {
      packageManifests.push(relative(file));
      checkPackageManifest(file, JSON.parse(text));
    }
  }
}

const lockfile = await readFile(path.join(root, "package-lock.json"), "utf8");
const lock = JSON.parse(lockfile);
for (const forbidden of ["run402-private", "git+ssh://", "npm.pkg.github.com"]) {
  if (lockfile.includes(forbidden)) {
    failures.push(`package-lock.json contains forbidden dependency marker: ${forbidden}`);
  }
}
const sbom = Object.entries(lock.packages ?? {})
  .filter(([name]) => name.startsWith("node_modules/"))
  .map(([name, metadata]) => ({
    name: name.replace(/^node_modules\//, ""),
    version: metadata.version ?? "workspace",
    license: metadata.license ?? null,
  }))
  .sort((a, b) => a.name.localeCompare(b.name));

if (failures.length > 0) {
  console.error(JSON.stringify({ status: "failed", failures }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  status: "ok",
  checked_roots: checkedRoots,
  package_manifests: packageManifests.sort(),
  sbom_component_count: sbom.length,
}, null, 2));

function checkPackageManifest(file, manifest) {
  const dependencySections = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
  for (const section of dependencySections) {
    for (const [name, version] of Object.entries(manifest[section] ?? {})) {
      if (String(version).includes("git+") || String(version).includes("file:../..")) {
        failures.push(`${relative(file)} ${section}.${name} uses a non-public dependency reference: ${version}`);
      }
      if (name.startsWith("@kychee/")) {
        failures.push(`${relative(file)} ${section}.${name} uses private package scope`);
      }
    }
  }
  if (manifest.publishConfig?.registry?.includes("npm.pkg.github.com")) {
    failures.push(`${relative(file)} publishConfig points at a private registry`);
  }
}

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === "dist" || entry.name === "node_modules") continue;
    const absolute = path.join(dir, entry.name);
    if (relative(absolute) === "scripts/core-boundary-check.mjs") continue;
    if (entry.isDirectory()) {
      files.push(...await walk(absolute));
    } else if (isTextFile(entry.name)) {
      files.push(absolute);
    }
  }
  return files;
}

function isTextFile(name) {
  return /\.(json|js|mjs|ts|tsx|md|sql|yml|yaml|html|Dockerfile)$/.test(name) || name === "Dockerfile";
}

function relative(file) {
  return path.relative(root, file);
}
