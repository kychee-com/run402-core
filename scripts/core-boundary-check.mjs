import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const root = new URL("../", import.meta.url).pathname;
const execFileAsync = promisify(execFile);
const checkedRoots = [
  ".github/workflows",
  "apps/core-gateway",
  "packages/runtime-kernel",
  "docker",
  "fixtures/astro-ssr-core",
  "fixtures/functions-runtime-core",
  "fixtures/portable-project-archive-core",
  "fixtures/runtime-kernel-static-rest",
  "fixtures/storage-routing-core",
  "scripts",
];
const forbiddenText = [
  "run402-private",
  "/run402-private",
  "/Users/talweiss",
  "npm.pkg.github.com",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "BEGIN PRIVATE KEY",
  "AKIA",
  "ASIA",
  "arn:aws",
  "amazonaws.com",
  "cloudfront.net",
  "x-amz-",
  "CloudFront-Key-Pair-Id",
  "s3://",
  "S3_BUCKET",
  "CLOUDFRONT_DISTRIBUTION",
  "tenant_id",
  "tenantId",
  "billing_ledger",
  "operator_only",
  "mail.run402.com",
  "RUN402_SES_CONFIGURATION_SET_NAME",
  "email_pack",
  "billing_email_overage",
  "billing-email-overage",
  "support_workflow",
  "supportWorkflow",
];
const archiveForbiddenText = [
  "tenant_id",
  "tenantId",
  "provider_account_id",
  "providerAccountId",
  "aurora_cluster",
  "auroraCluster",
  "CloudWatch",
  "cloudwatch",
  "log_group",
  "logGroup",
  "log_stream",
  "logStream",
  "fleet_id",
  "fleetId",
  "scheduler_id",
  "schedulerId",
  "billing_ledger",
  "billingLedger",
  "allowance_id",
  "allowanceId",
  "spend_cap",
  "spendCap",
  "abuse_decision",
  "abuseDecision",
  "support_note",
  "supportNote",
  "operator_note",
  "operatorNote",
  "signed_url",
  "signedUrl",
  "secret_value",
  "secretValue",
];
const forbiddenImports = [
  "@aws-sdk/",
  "aws-sdk",
  "packages/gateway",
  "services/billing",
  "middleware/x402",
  "lifecycle-gate",
  "cloudfront",
  "CloudFront",
  "s3-presign",
  "s3",
  "S3",
];
const requiredRedactionFixtureMarkers = [
  "Authorization: Bearer",
  "cookie=sessionid",
  "x-run402-payment",
  "API_TOKEN=",
  "api_key=",
];
const requiredAstroSsrFixtureMarkers = [
  "astro.ssr.v1",
  "static public asset wins before Astro SSR",
  "x-run402-route-pattern",
  "SESSION_SECRET",
];

const failures = [];
const packageManifests = [];
const textFiles = [];
let runtimeKernelSourceMapFiles = 0;

for (const relativeRoot of checkedRoots) {
  for (const file of await walk(path.join(root, relativeRoot))) {
    textFiles.push(relative(file));
    const text = await readFile(file, "utf8");
    for (const forbidden of forbiddenText) {
      if (text.includes(forbidden)) {
        failures.push(`${relative(file)} contains forbidden text: ${forbidden}`);
      }
    }
    if (isArchiveBoundaryFile(file)) {
      for (const forbidden of archiveForbiddenText) {
        if (text.includes(forbidden)) {
          failures.push(`${relative(file)} contains forbidden archive metadata marker: ${forbidden}`);
        }
      }
    }
    for (const line of text.split("\n")) {
      if (!/^\s*import\b/.test(line)) continue;
      for (const forbidden of forbiddenImports) {
        if (isAllowedCoreEmailAwsSdkImport(file, line, forbidden)) continue;
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

const redactionFixture = await readFile(path.join(root, "fixtures/functions-runtime-core/functions/api-v1.mjs"), "utf8");
for (const marker of requiredRedactionFixtureMarkers) {
  if (!redactionFixture.includes(marker)) {
    failures.push(`functions redaction fixture is missing marker: ${marker}`);
  }
}
const astroSsrFixtureText = await Promise.all([
  readFile(path.join(root, "scripts/core-astro-ssr-smoke.mjs"), "utf8"),
  readFile(path.join(root, "fixtures/astro-ssr-core/functions/ssr.mjs"), "utf8"),
  readFile(path.join(root, "fixtures/astro-ssr-core/site/assets/app.txt"), "utf8"),
]).then((parts) => parts.join("\n"));
for (const marker of requiredAstroSsrFixtureMarkers) {
  if (!astroSsrFixtureText.includes(marker)) {
    failures.push(`Astro SSR fixture is missing marker: ${marker}`);
  }
}

const runtimeKernelPack = await packageDryRun("packages/runtime-kernel");
for (const file of runtimeKernelPack.files) {
  if (file.path.includes("run402-private") || file.path.includes("node_modules/")) {
    failures.push(`runtime-kernel package includes forbidden path: ${file.path}`);
  }
  if (/\.map$/.test(file.path)) {
    runtimeKernelSourceMapFiles += 1;
  }
}

const lockfile = await readFile(path.join(root, "package-lock.json"), "utf8");
const lock = JSON.parse(lockfile);
for (const forbidden of ["run402-private", "git+ssh://", "npm.pkg.github.com", "@kychee/"]) {
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
  checked_text_file_count: textFiles.length,
  package_manifests: packageManifests.sort(),
  runtime_kernel_package_files: runtimeKernelPack.files.length,
  runtime_kernel_source_map_files: runtimeKernelSourceMapFiles,
  runtime_kernel_unpacked_size: runtimeKernelPack.unpackedSize,
  sbom_component_count: sbom.length,
}, null, 2));

async function packageDryRun(workspace) {
  const { stdout } = await execFileAsync("npm", ["pack", "-w", workspace, "--dry-run", "--json"], {
    cwd: root,
    timeout: 60_000,
    maxBuffer: 1024 * 1024 * 4,
  });
  const parsed = JSON.parse(stdout);
  if (!Array.isArray(parsed) || !parsed[0]) {
    failures.push(`npm pack --dry-run returned no package metadata for ${workspace}`);
    return { files: [], unpackedSize: 0 };
  }
  return {
    files: parsed[0].files ?? [],
    unpackedSize: parsed[0].unpackedSize ?? 0,
  };
}

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
    if (entry.name === "node_modules") continue;
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
  return /\.(json|js|mjs|cjs|ts|tsx|d\.ts|md|sql|yml|yaml|html|css|txt|map|Dockerfile)$/.test(name) || name === "Dockerfile";
}

function relative(file) {
  return path.relative(root, file);
}

function isArchiveBoundaryFile(file) {
  const rel = relative(file);
  return rel.startsWith("fixtures/portable-project-archive-core/") ||
    rel.startsWith("packages/runtime-kernel/schemas/");
}

function isAllowedCoreEmailAwsSdkImport(file, line, forbidden) {
  const rel = relative(file);
  if (
    rel === "apps/core-gateway/src/email-provider.ts" ||
    rel === "apps/core-gateway/dist/email-provider.js"
  ) {
    return (forbidden === "@aws-sdk/" || forbidden === "aws-sdk") && line.includes("@aws-sdk/client-sesv2");
  }
  if (
    rel === "apps/core-gateway/src/email-inbound.ts" ||
    rel === "apps/core-gateway/dist/email-inbound.js"
  ) {
    return (forbidden === "@aws-sdk/" || forbidden === "aws-sdk" || forbidden === "s3" || forbidden === "S3") &&
      line.includes("@aws-sdk/client-s3");
  }
  return false;
}
