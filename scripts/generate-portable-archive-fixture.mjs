import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PROJECT_ARCHIVE_INDEX_SCHEMA_VERSION,
  PROJECT_ARCHIVE_LAYOUT_SCHEMA_VERSION,
  PROJECT_ARCHIVE_MEDIA_TYPES,
  PROJECT_ARCHIVE_VERSION,
  computePortableArchiveBytesDigest,
  computePortableArchiveLogicalDigest,
  verifyPortableArchive,
} from "../packages/runtime-kernel/src/archive.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = path.join(repoRoot, "fixtures/portable-project-archive-core");
const archiveRoot = path.join(fixtureRoot, "archive");
const corruptRoot = path.join(fixtureRoot, "corrupt");
const goldensRoot = path.join(fixtureRoot, "goldens");

await rm(fixtureRoot, { recursive: true, force: true });
await mkdir(path.join(archiveRoot, "manifest"), { recursive: true });
await mkdir(path.join(archiveRoot, "database/data"), { recursive: true });
await mkdir(path.join(archiveRoot, "auth"), { recursive: true });
await mkdir(path.join(archiveRoot, "storage"), { recursive: true });
await mkdir(path.join(archiveRoot, "runtime"), { recursive: true });
await mkdir(path.join(archiveRoot, "secrets"), { recursive: true });
await mkdir(path.join(archiveRoot, "blobs/sha256"), { recursive: true });
await mkdir(goldensRoot, { recursive: true });

const descriptors = {};

const staticHtml = Buffer.from("<!doctype html><title>Run402 portable archive fixture</title><h1>Portable archive fixture</h1>\n");
const staticDigest = computePortableArchiveBytesDigest(staticHtml);
const staticBlobPath = `blobs/sha256/${staticDigest.slice("sha256:".length)}`;
await writeFile(path.join(archiveRoot, staticBlobPath), staticHtml);

const objectBytes = Buffer.from("public object from archive fixture\n");
const objectDigest = computePortableArchiveBytesDigest(objectBytes);
const objectBlobPath = `blobs/sha256/${objectDigest.slice("sha256:".length)}`;
await writeFile(path.join(archiveRoot, objectBlobPath), objectBytes);

const functionBytes = Buffer.from("export default async function handler() { return new Response('hello from portable archive function'); }\n");
const functionDigest = computePortableArchiveBytesDigest(functionBytes);
const functionBlobPath = `blobs/sha256/${functionDigest.slice("sha256:".length)}`;
await writeFile(path.join(archiveRoot, functionBlobPath), functionBytes);

const astroBytes = Buffer.from("export default async function ssr(request) { return new Response('astro ssr fixture'); }\n");
const astroDigest = computePortableArchiveBytesDigest(astroBytes);
const astroBlobPath = `blobs/sha256/${astroDigest.slice("sha256:".length)}`;
await writeFile(path.join(archiveRoot, astroBlobPath), astroBytes);

await writeDescriptor("release_spec", "manifest/release-spec.json", PROJECT_ARCHIVE_MEDIA_TYPES.releaseSpec, {
  project: "portable-archive-fixture",
  base: { release: "empty" },
  database: {
    migrations: [{
      id: "001_archive_fixture",
      checksum: "sha256:8bb7e9214568f6f4d7a0b2e1e122b6236c59b15a8d038d2ee04a35597d4fef77",
      sql: "create table todos (id bigint primary key, owner_id text not null, title text not null);",
    }],
    expose: {
      schemas: ["public"],
      tables: ["todos"],
    },
  },
  secrets: { require: ["OPENAI_API_KEY"] },
  routes: {
    replace: [
      { pattern: "/api", methods: ["GET"], target: { type: "function", name: "api" } },
      { pattern: "/*", methods: ["GET"], target: { type: "function", name: "ssr" } },
    ],
  },
});
await writeDescriptor("portable_release_state", "manifest/portable-release-state.json", PROJECT_ARCHIVE_MEDIA_TYPES.portableReleaseState, {
  state_version: "run402.portable_release_state.v1",
  site: {
    paths: [
      {
        path: "/index.html",
        content_sha256: staticDigest.slice("sha256:".length),
        size_bytes: staticHtml.byteLength,
        content_type: "text/html",
      },
    ],
  },
  static_manifest: {
    version: "run402.static_manifest.v1",
    public_path_mode: "explicit",
    files: {
      "/index.html": {
        sha256: staticDigest.slice("sha256:".length),
        size: staticHtml.byteLength,
        content_type: "text/html",
        cache_class: "html",
        cache_class_source: "declared",
      },
    },
  },
  functions: [
    {
      name: "api",
      code_hash: functionDigest,
      runtime: "node22",
      timeout_seconds: 10,
      memory_mb: 128,
      schedule: null,
      deps: [],
      require_auth: false,
      require_role: null,
      class: "standard",
      capabilities: [],
    },
    {
      name: "ssr",
      code_hash: astroDigest,
      runtime: "node22",
      timeout_seconds: 10,
      memory_mb: 128,
      schedule: null,
      deps: [],
      require_auth: false,
      require_role: null,
      class: "ssr",
      capabilities: ["astro.ssr.v1"],
    },
  ],
  secrets: { keys: ["OPENAI_API_KEY"] },
  subdomains: { names: [] },
  routes: {
    manifest_sha256: null,
    entries: [
      { pattern: "/api", kind: "exact", prefix: null, methods: ["GET"], target: { type: "function", name: "api" } },
      { pattern: "/*", kind: "prefix", prefix: "/", methods: ["GET"], target: { type: "function", name: "ssr" } },
    ],
  },
  migrations: [{ migration_id: "001_archive_fixture", checksum_hex: "8bb7e9214568f6f4d7a0b2e1e122b6236c59b15a8d038d2ee04a35597d4fef77", transaction: "default" }],
  i18n: null,
});
await writeDescriptor("fact_set", "manifest/fact-set.json", PROJECT_ARCHIVE_MEDIA_TYPES.releaseFactSet, {
  schema_version: "run402.release_fact_set.v1",
  facts: [
    { protocol: "run402.fact.content.v1", resource: "static:/index.html", digest: staticDigest },
    { protocol: "run402.fact.content.v1", resource: "function:api", digest: functionDigest },
    { protocol: "run402.fact.content.v1", resource: "function:ssr", digest: astroDigest },
  ],
});
await writeDescriptor("portability_report", "manifest/portability-report.json", PROJECT_ARCHIVE_MEDIA_TYPES.portabilityReport, {
  schema_version: "run402.project_archive.portability_report.v1",
  entries: [
    {
      code: "AUTH_SUBJECT_STUBS_IMPORTED",
      severity: "info",
      resource_type: "auth_subject",
      message: "Disabled auth subject stubs preserve database references but cannot sign in.",
      next_action: { type: "none" },
      retryable: false,
    },
    {
      code: "SECRET_VALUES_REQUIRED",
      severity: "warning",
      resource_type: "secret",
      resource_id: "OPENAI_API_KEY",
      message: "Set OPENAI_API_KEY before requiring runnable import.",
      next_action: { type: "set_secret", env_var: "OPENAI_API_KEY" },
      retryable: true,
    },
    {
      code: "CLOUD_ONLY_FEATURE_EXCLUDED",
      severity: "warning",
      resource_type: "custom_domain",
      resource_id: "example.com",
      message: "Custom domains are Cloud operations and are not runnable state in Core archive v1.",
      next_action: { type: "remove_unsupported_feature", message: "Recreate custom domains in your target platform." },
      retryable: false,
    },
  ],
});
await writeDescriptor("export_report", "manifest/export-report.json", PROJECT_ARCHIVE_MEDIA_TYPES.exportReport, {
  schema_version: "run402.project_archive.export_report.v1",
  export_scope: "portable-runtime-v1",
  auth_export: "stubs",
  consistency: "core_fixture_v1",
  omitted_sensitive_resource_count: 0,
  unsupported_resource_count: 1,
  counts: { tables: 1, rows: 2, storage_objects: 2, functions: 2, auth_subject_stubs: 2 },
  bytes: { storage: staticHtml.byteLength + objectBytes.byteLength, runtime: functionBytes.byteLength + astroBytes.byteLength },
});
await writeTextDescriptor(
  "database.pre_data_sql",
  "database/pre-data.sql",
  PROJECT_ARCHIVE_MEDIA_TYPES.databaseSql,
  [
    "create table todos (",
    "  id bigint primary key,",
    "  owner_id text not null,",
    "  title text not null",
    ");",
    "create index todos_owner_id_idx on todos(owner_id);",
    "",
  ].join("\n"),
);
await writeDescriptor("database.tables", "database/tables.json", PROJECT_ARCHIVE_MEDIA_TYPES.databaseTables, {
  schema_version: "run402.project_archive.database_tables.v1",
  tables: [{
    id: "todos",
    schema: "public",
    name: "todos",
    copy_path: "database/data/todos.copy",
    row_count: 2,
    columns: [
      { name: "id", type: "bigint", nullable: false },
      { name: "owner_id", type: "text", nullable: false },
      { name: "title", type: "text", nullable: false },
    ],
  }],
});
await writeTextDescriptor(
  "database.data.todos",
  "database/data/todos.copy",
  PROJECT_ARCHIVE_MEDIA_TYPES.databaseCopy,
  "1\tauth_subject_alice\tShip portable archives\n2\tauth_subject_bob\tKeep DX boringly good\n",
);
await writeDescriptor("database.sequences", "database/sequences.json", PROJECT_ARCHIVE_MEDIA_TYPES.databaseSequences, {
  schema_version: "run402.project_archive.database_sequences.v1",
  sequences: [{ schema: "public", name: "todos_id_seq", value: "2", is_called: true }],
});
await writeTextDescriptor(
  "database.post_data_sql",
  "database/post-data.sql",
  PROJECT_ARCHIVE_MEDIA_TYPES.databaseSql,
  [
    "alter table todos enable row level security;",
    "create policy todos_owner_read on todos for select using (owner_id = auth.uid());",
    "",
  ].join("\n"),
);
await writeDescriptor("auth.config", "auth/config.json", PROJECT_ARCHIVE_MEDIA_TYPES.authConfig, {
  schema_version: "run402.project_archive.auth_config.v1",
  auth_export: "stubs",
  subject_id_namespace: "run402-auth-subject",
});
await writeTextDescriptor(
  "auth.subjects",
  "auth/subjects.ndjson",
  PROJECT_ARCHIVE_MEDIA_TYPES.authSubjects,
  "{\"subject_id\":\"auth_subject_alice\",\"disabled\":true,\"references\":[\"todos.owner_id\"]}\n{\"subject_id\":\"auth_subject_bob\",\"disabled\":true,\"references\":[\"todos.owner_id\"]}\n",
);
await writeDescriptor("storage.index", "storage/index.json", PROJECT_ARCHIVE_MEDIA_TYPES.storageIndex, {
  schema_version: "run402.project_archive.storage_index.v1",
  objects: [
    {
      key: "site/index.html",
      visibility: "public",
      content_type: "text/html",
      cache_control: "public, max-age=60",
      immutable: false,
      size: staticHtml.byteLength,
      digest: staticDigest,
      blob_path: staticBlobPath,
    },
    {
      key: "objects/public.txt",
      visibility: "public",
      content_type: "text/plain",
      immutable: true,
      size: objectBytes.byteLength,
      digest: objectDigest,
      blob_path: objectBlobPath,
    },
  ],
  static_routes: [{ path: "/index.html", object_key: "site/index.html" }],
});
await writeDescriptor("runtime.index", "runtime/index.json", PROJECT_ARCHIVE_MEDIA_TYPES.runtimeIndex, {
  schema_version: "run402.project_archive.runtime_index.v1",
  functions: [
    {
      name: "api",
      runtime: "node22",
      entrypoint: "index.mjs",
      artifact_digest: functionDigest,
      artifact_path: functionBlobPath,
      required_secrets: ["OPENAI_API_KEY"],
      class: "standard",
    },
    {
      name: "ssr",
      runtime: "node22",
      entrypoint: "server.mjs",
      artifact_digest: astroDigest,
      artifact_path: astroBlobPath,
      required_secrets: [],
      class: "ssr",
    },
  ],
  astro_ssr: { enabled: true, function: "ssr" },
});
await writeDescriptor("secret_requirements", "secrets/requirements.json", PROJECT_ARCHIVE_MEDIA_TYPES.secretRequirements, {
  schema_version: "run402.project_archive.secret_requirements.v1",
  secrets: [{ name: "OPENAI_API_KEY", required: true, targets: ["function:api"], description: "Used by the API fixture." }],
});
await writeTextDescriptor("secret_env_template", "secrets/required.env.template", PROJECT_ARCHIVE_MEDIA_TYPES.envTemplate, "OPENAI_API_KEY=\n");

descriptors["blob.static.index"] = blobDescriptor(staticBlobPath, staticDigest, staticHtml.byteLength);
descriptors["blob.storage.public"] = blobDescriptor(objectBlobPath, objectDigest, objectBytes.byteLength);
descriptors["blob.function.api"] = blobDescriptor(functionBlobPath, functionDigest, functionBytes.byteLength);
descriptors["blob.function.ssr"] = blobDescriptor(astroBlobPath, astroDigest, astroBytes.byteLength);

await writeJson(path.join(archiveRoot, "run402-layout.json"), {
  schema_version: PROJECT_ARCHIVE_LAYOUT_SCHEMA_VERSION,
  archive_version: PROJECT_ARCHIVE_VERSION,
  mediaType: PROJECT_ARCHIVE_MEDIA_TYPES.layout,
  index: "index.json",
  blobs: "blobs/sha256",
  transports: ["directory", "tar"],
  checksum_lists_authoritative: false,
});

const index = {
  schema_version: PROJECT_ARCHIVE_INDEX_SCHEMA_VERSION,
  archive_version: PROJECT_ARCHIVE_VERSION,
  mediaType: PROJECT_ARCHIVE_MEDIA_TYPES.index,
  core_compatibility: {
    runtime_kernel: ">=0.1.5",
    release_spec: "run402.release_spec.v1",
  },
  source: {
    platform: "run402-core-fixture",
    label: "public portable archive fixture",
  },
  required_capabilities: [
    "run402.core.release-state.v1",
    "run402.core.database.phased-postgres-copy.v1",
    "run402.core.storage.cas.v1",
    "run402.core.functions.node22.v1",
    "run402.core.astro-ssr.v1",
    "run402.core.auth-stubs.v1",
    "run402.core.secret-requirements.v1",
  ],
  identity_descriptors: [
    "release_spec",
    "portable_release_state",
    "fact_set",
    "portability_report",
    "database.pre_data_sql",
    "database.tables",
    "database.data.todos",
    "database.sequences",
    "database.post_data_sql",
    "auth.config",
    "auth.subjects",
    "storage.index",
    "runtime.index",
    "secret_requirements",
    "secret_env_template",
    "blob.static.index",
    "blob.storage.public",
    "blob.function.api",
    "blob.function.ssr",
  ],
  descriptors,
  consistency: {
    mode: "core_fixture_v1",
    pinned_release_id: "rel_public_portable_archive_fixture_v1",
    storage: { mutation_pause: "not_applicable" },
    runtime: { artifact_capture: "captured" },
  },
};
index.archive_digest = computePortableArchiveLogicalDigest(index);
await writeJson(path.join(archiveRoot, "index.json"), index);

const verifyResult = await verifyPortableArchive({ archivePath: archiveRoot });
if (!verifyResult.ok) {
  throw new Error(`Generated archive fixture does not verify: ${JSON.stringify(verifyResult.diagnostics, null, 2)}`);
}

await writeJson(path.join(goldensRoot, "archive-summary.json"), {
  archive_digest: verifyResult.archive_digest,
  descriptor_count: verifyResult.descriptor_count,
  file_count: verifyResult.file_count,
  total_bytes: verifyResult.total_bytes,
  required_capabilities: verifyResult.required_capabilities,
  required_secrets: verifyResult.required_secrets,
  auth_subject_stub_count: verifyResult.auth_subject_stub_count,
});
await writeJson(path.join(goldensRoot, "descriptor-digests.json"), Object.fromEntries(
  Object.entries(index.descriptors).map(([name, descriptor]) => [name, descriptor.digest]).sort(([a], [b]) => a.localeCompare(b)),
));
await writeJson(
  path.join(goldensRoot, "portability-report.json"),
  JSON.parse(await readFile(path.join(archiveRoot, "manifest/portability-report.json"), "utf8")),
);
await writeJson(
  path.join(goldensRoot, "export-report.json"),
  JSON.parse(await readFile(path.join(archiveRoot, "manifest/export-report.json"), "utf8")),
);
await writeJson(path.join(goldensRoot, "required-secrets.json"), verifyResult.required_secrets);
await writeJson(
  path.join(goldensRoot, "auth-stubs.json"),
  (await readFile(path.join(archiveRoot, "auth/subjects.ndjson"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line)),
);
await writeJson(path.join(goldensRoot, "release-identity.json"), {
  archive_digest: verifyResult.archive_digest,
  pinned_release_id: index.consistency.pinned_release_id,
  portable_release_state_digest: index.descriptors.portable_release_state.digest,
  fact_set_digest: index.descriptors.fact_set.digest,
});
await writeCorruptVariants(index);

async function writeDescriptor(name, relativePath, mediaType, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  await writeFile(path.join(archiveRoot, relativePath), bytes);
  descriptors[name] = {
    mediaType,
    path: relativePath,
    digest: computePortableArchiveBytesDigest(bytes),
    size: bytes.byteLength,
  };
}

async function writeTextDescriptor(name, relativePath, mediaType, text) {
  const bytes = Buffer.from(text);
  await writeFile(path.join(archiveRoot, relativePath), bytes);
  descriptors[name] = {
    mediaType,
    path: relativePath,
    digest: computePortableArchiveBytesDigest(bytes),
    size: bytes.byteLength,
  };
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function blobDescriptor(blobPath, digest, size) {
  return {
    mediaType: PROJECT_ARCHIVE_MEDIA_TYPES.blob,
    path: blobPath,
    digest,
    size,
  };
}

async function writeCorruptVariants(validIndex) {
  await makeVariant("digest-mismatch", async (variantRoot) => {
    await writeFile(path.join(variantRoot, "manifest/export-report.json"), "{\"schema_version\":\"tampered\"}\n");
  });

  await makeVariant("unsafe-path", async (variantRoot) => {
    const variantIndex = structuredClone(validIndex);
    variantIndex.descriptors.export_report.path = "../export-report.json";
    variantIndex.archive_digest = computePortableArchiveLogicalDigest(variantIndex);
    await writeJson(path.join(variantRoot, "index.json"), variantIndex);
  });

  await makeVariant("unknown-required-capability", async (variantRoot) => {
    const variantIndex = structuredClone(validIndex);
    variantIndex.required_capabilities = [
      ...variantIndex.required_capabilities,
      "run402.future.unsupported-required-capability.v1",
    ];
    variantIndex.archive_digest = computePortableArchiveLogicalDigest(variantIndex);
    await writeJson(path.join(variantRoot, "index.json"), variantIndex);
  });

  await makeVariant("oversized-descriptor", async (variantRoot) => {
    const oversized = Buffer.from(`${JSON.stringify({ padding: "x".repeat(2 * 1024 * 1024 + 1) })}\n`);
    const oversizedPath = "manifest/oversized.json";
    await writeFile(path.join(variantRoot, oversizedPath), oversized);
    const variantIndex = structuredClone(validIndex);
    variantIndex.descriptors.oversized = {
      mediaType: PROJECT_ARCHIVE_MEDIA_TYPES.exportReport,
      path: oversizedPath,
      digest: computePortableArchiveBytesDigest(oversized),
      size: oversized.byteLength,
    };
    variantIndex.archive_digest = computePortableArchiveLogicalDigest(variantIndex);
    await writeJson(path.join(variantRoot, "index.json"), variantIndex);
  });

  await makeVariant("unsupported-version", async (variantRoot) => {
    const variantIndex = structuredClone(validIndex);
    variantIndex.archive_version = "run402-project-archive.v999";
    await writeJson(path.join(variantRoot, "index.json"), variantIndex);
    await writeJson(path.join(variantRoot, "run402-layout.json"), {
      schema_version: PROJECT_ARCHIVE_LAYOUT_SCHEMA_VERSION,
      archive_version: "run402-project-archive.v999",
      mediaType: PROJECT_ARCHIVE_MEDIA_TYPES.layout,
      index: "index.json",
      blobs: "blobs/sha256",
      transports: ["directory", "tar"],
      checksum_lists_authoritative: false,
    });
  });

  await makeVariant("missing-blob", async (variantRoot) => {
    await rm(path.join(variantRoot, validIndex.descriptors["blob.storage.public"].path), { force: true });
  });
}

async function makeVariant(name, mutate) {
  const variantRoot = path.join(corruptRoot, name);
  await cp(archiveRoot, variantRoot, { recursive: true });
  await mutate(variantRoot);
}
