import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  PROJECT_ARCHIVE_INDEX_SCHEMA_VERSION,
  PROJECT_ARCHIVE_LAYOUT_SCHEMA_VERSION,
  PROJECT_ARCHIVE_MEDIA_TYPES,
  PROJECT_ARCHIVE_VERSION,
  computePortableArchiveBytesDigest,
  computePortableArchiveLogicalDigest,
  importPortableArchive,
  verifyPortableArchive,
  type PortableArchiveImporterPort,
  type PortableArchiveVerifiedImportInput,
  type PortableArchiveDescriptor,
  type PortableArchiveIndex,
  type PortableArchiveLayout,
} from "./index.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

test("portable archive verifies a local directory without Cloud credentials", async () => {
  const fixture = await createArchiveFixture();
  try {
    const result = await verifyPortableArchive({ archivePath: fixture.root });

    assert.equal(result.ok, true);
    assert.equal(result.archive_version, PROJECT_ARCHIVE_VERSION);
    assert.equal(result.archive_digest, fixture.archiveDigest);
    assert.equal(result.transport, "directory");
    assert.equal(result.descriptor_count, 18);
    assert.equal(result.required_secrets.map((secret) => secret.name).join(","), "OPENAI_API_KEY");
    assert.equal(result.auth_subject_stub_count, 1);
    assert.deepEqual(result.diagnostics, []);
  } finally {
    await fixture.cleanup();
  }
});

test("committed portable archive fixture matches goldens", async () => {
  const archivePath = path.join(REPO_ROOT, "fixtures/portable-project-archive-core/archive");
  const result = await verifyPortableArchive({ archivePath });
  const summaryGolden = JSON.parse(
    await readFile(path.join(REPO_ROOT, "fixtures/portable-project-archive-core/goldens/archive-summary.json"), "utf8"),
  ) as Record<string, unknown>;
  const descriptorGolden = JSON.parse(
    await readFile(path.join(REPO_ROOT, "fixtures/portable-project-archive-core/goldens/descriptor-digests.json"), "utf8"),
  ) as Record<string, string>;
  const portabilityReportGolden = JSON.parse(
    await readFile(path.join(REPO_ROOT, "fixtures/portable-project-archive-core/goldens/portability-report.json"), "utf8"),
  ) as Record<string, unknown>;
  const exportReportGolden = JSON.parse(
    await readFile(path.join(REPO_ROOT, "fixtures/portable-project-archive-core/goldens/export-report.json"), "utf8"),
  ) as Record<string, unknown>;
  const requiredSecretsGolden = JSON.parse(
    await readFile(path.join(REPO_ROOT, "fixtures/portable-project-archive-core/goldens/required-secrets.json"), "utf8"),
  ) as unknown[];
  const authStubsGolden = JSON.parse(
    await readFile(path.join(REPO_ROOT, "fixtures/portable-project-archive-core/goldens/auth-stubs.json"), "utf8"),
  ) as unknown[];
  const releaseIdentityGolden = JSON.parse(
    await readFile(path.join(REPO_ROOT, "fixtures/portable-project-archive-core/goldens/release-identity.json"), "utf8"),
  ) as Record<string, unknown>;
  const index = JSON.parse(await readFile(path.join(archivePath, "index.json"), "utf8")) as PortableArchiveIndex;
  const authStubs = (await readFile(path.join(archivePath, "auth/subjects.ndjson"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as unknown);
  const descriptorDigests = Object.fromEntries(
    Object.entries(index.descriptors).map(([name, descriptor]) => [name, descriptor.digest]).sort(([a], [b]) => a.localeCompare(b)),
  );

  assert.equal(result.ok, true);
  assert.deepEqual({
    archive_digest: result.archive_digest,
    descriptor_count: result.descriptor_count,
    file_count: result.file_count,
    total_bytes: result.total_bytes,
    required_capabilities: result.required_capabilities,
    required_secrets: result.required_secrets,
    auth_subject_stub_count: result.auth_subject_stub_count,
  }, summaryGolden);
  assert.deepEqual(descriptorDigests, descriptorGolden);
  assert.deepEqual(result.portability_report, portabilityReportGolden);
  assert.deepEqual(result.export_report, exportReportGolden);
  assert.deepEqual(result.required_secrets, requiredSecretsGolden);
  assert.deepEqual(authStubs, authStubsGolden);
  assert.deepEqual({
    archive_digest: result.archive_digest,
    pinned_release_id: index.consistency?.pinned_release_id,
    portable_release_state_digest: index.descriptors.portable_release_state.digest,
    fact_set_digest: index.descriptors.fact_set.digest,
  }, releaseIdentityGolden);
});

test("committed corrupt archive variants fail with stable codes", async () => {
  const cases: Array<[string, string]> = [
    ["digest-mismatch", "ARCHIVE_DIGEST_MISMATCH"],
    ["unsafe-path", "ARCHIVE_PATH_UNSAFE"],
    ["unknown-required-capability", "ARCHIVE_UNSUPPORTED_REQUIRED_CAPABILITY"],
    ["oversized-descriptor", "ARCHIVE_SIZE_LIMIT_EXCEEDED"],
    ["unsupported-version", "ARCHIVE_UNSUPPORTED_VERSION"],
    ["missing-blob", "ARCHIVE_BLOB_MISSING"],
  ];

  for (const [name, code] of cases) {
    const result = await verifyPortableArchive({
      archivePath: path.join(REPO_ROOT, "fixtures/portable-project-archive-core/corrupt", name),
    });
    assert.equal(result.ok, false, name);
    assert.equal(result.diagnostics.some((entry) => entry.code === code), true, name);
  }
});

test("portable archive import refuses existing-project targets before mutation", async () => {
  const importer = new RecordingArchiveImporter();

  const result = await importPortableArchive({ importer }, {
    archivePath: path.join(REPO_ROOT, "fixtures/portable-project-archive-core/archive"),
    target: { kind: "existing_project", project_id: "prj_existing" },
  });

  assert.equal(result.status, "failed");
  assert.equal(result.diagnostics[0]?.code, "PROJECT_ALREADY_EXISTS");
  assert.equal(importer.calls.length, 0);
});

test("portable archive import verifies before mutation", async () => {
  const importer = new RecordingArchiveImporter();

  const result = await importPortableArchive({ importer }, {
    archivePath: path.join(REPO_ROOT, "fixtures/portable-project-archive-core/corrupt/digest-mismatch"),
    target: { kind: "new_project", name: "bad-archive" },
  });

  assert.equal(result.status, "failed");
  assert.equal(result.diagnostics[0]?.code, "IMPORT_VERIFY_FAILED");
  assert.equal(importer.calls.length, 0);
});

test("portable archive import dry-run verifies without mutation", async () => {
  const importer = new RecordingArchiveImporter();

  const result = await importPortableArchive({ importer }, {
    archivePath: path.join(REPO_ROOT, "fixtures/portable-project-archive-core/archive"),
    target: { kind: "new_project", name: "dry-run-archive" },
    dryRun: true,
  });

  assert.equal(result.status, "dry_run");
  assert.equal(result.project_name, "dry-run-archive");
  assert.equal(importer.calls.length, 0);
});

test("portable archive import requireRunnable blocks missing secrets before mutation", async () => {
  const importer = new RecordingArchiveImporter();

  const result = await importPortableArchive({ importer }, {
    archivePath: path.join(REPO_ROOT, "fixtures/portable-project-archive-core/archive"),
    target: { kind: "new_project", name: "needs-secrets" },
    requireRunnable: true,
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.diagnostics[0]?.code, "SECRET_VALUES_REQUIRED");
  assert.equal(importer.calls.length, 0);
});

test("portable archive import calls the concrete importer only after gates pass", async () => {
  const importer = new RecordingArchiveImporter();

  const result = await importPortableArchive({ importer }, {
    archivePath: path.join(REPO_ROOT, "fixtures/portable-project-archive-core/archive"),
    target: { kind: "new_project", name: "imported-archive" },
    requireRunnable: true,
    secretValues: { OPENAI_API_KEY: "present" },
  });

  assert.equal(result.status, "imported");
  assert.equal(result.project_id, "prj_imported_archive");
  assert.equal(importer.calls.length, 1);
  assert.equal(importer.calls[0]?.project_name, "imported-archive");
  assert.equal(importer.calls[0]?.verification.ok, true);
});

test("portable archive logical digest ignores descriptor map insertion order", async () => {
  const fixture = await createArchiveFixture();
  try {
    const index = fixture.index;
    const reordered: PortableArchiveIndex = {
      ...index,
      archive_digest: undefined,
      descriptors: Object.fromEntries(Object.entries(index.descriptors).reverse()),
      identity_descriptors: [...index.identity_descriptors].reverse(),
    };

    assert.equal(computePortableArchiveLogicalDigest(reordered), fixture.archiveDigest);
  } finally {
    await fixture.cleanup();
  }
});

test("portable archive reports unknown required capabilities as blocking compatibility failures", async () => {
  const fixture = await createArchiveFixture({
    mutateIndex(index) {
      index.required_capabilities.push("run402.future.teleport.v9");
    },
  });
  try {
    const result = await verifyPortableArchive({ archivePath: fixture.root });

    assert.equal(result.ok, false);
    assert.equal(result.diagnostics.some((entry) => entry.code === "ARCHIVE_UNSUPPORTED_REQUIRED_CAPABILITY"), true);
  } finally {
    await fixture.cleanup();
  }
});

test("portable archive reports nondeterministic table ordering as a warning", async () => {
  const fixture = await createArchiveFixture();
  try {
    const tablesPath = path.join(fixture.root, "database/tables.json");
    const tables = JSON.parse(await readFile(tablesPath, "utf8")) as {
      tables: Array<{ deterministic_order?: boolean; order_by?: string[] }>;
    };
    tables.tables[0].deterministic_order = false;
    tables.tables[0].order_by = [];
    await writeJson(tablesPath, tables);
    const bytes = await readFile(tablesPath);
    fixture.index.descriptors["database.tables"].digest = computePortableArchiveBytesDigest(bytes);
    fixture.index.descriptors["database.tables"].size = bytes.byteLength;
    fixture.index.archive_digest = computePortableArchiveLogicalDigest(fixture.index);
    await writeJson(path.join(fixture.root, "index.json"), fixture.index);

    const result = await verifyPortableArchive({ archivePath: fixture.root });

    assert.equal(result.ok, true);
    assert.ok(result.diagnostics.some((entry) =>
      entry.code === "NON_DETERMINISTIC_TABLE_ORDER" &&
      entry.severity === "warning" &&
      entry.resource_id === "todos",
    ));
  } finally {
    await fixture.cleanup();
  }
});

test("portable archive reports missing blobs and digest mismatches", async () => {
  const fixture = await createArchiveFixture();
  try {
    await rm(path.join(fixture.root, fixture.storageBlobPath));
    await writeFile(path.join(fixture.root, "manifest/export-report.json"), "{\"schema_version\":\"tampered\"}\n");

    const result = await verifyPortableArchive({ archivePath: fixture.root });

    assert.equal(result.ok, false);
    assert.equal(result.diagnostics.some((entry) => entry.code === "ARCHIVE_BLOB_MISSING"), true);
    assert.equal(result.diagnostics.some((entry) => entry.code === "ARCHIVE_DIGEST_MISMATCH"), true);
  } finally {
    await fixture.cleanup();
  }
});

test("portable archive rejects duplicate JSON keys before trusting descriptor contents", async () => {
  const fixture = await createArchiveFixture();
  try {
    await writeFile(
      path.join(fixture.root, "manifest/export-report.json"),
      "{\"schema_version\":\"run402.project_archive.export_report.v1\",\"schema_version\":\"duplicate\"}\n",
    );

    const result = await verifyPortableArchive({ archivePath: fixture.root });

    assert.equal(result.ok, false);
    assert.equal(result.diagnostics.some((entry) => entry.code === "ARCHIVE_DUPLICATE_JSON_KEY"), true);
  } finally {
    await fixture.cleanup();
  }
});

test("portable archive rejects unsafe descriptor paths", async () => {
  const fixture = await createArchiveFixture({
    mutateIndex(index) {
      index.descriptors.export_report.path = "../export-report.json";
    },
  });
  try {
    const result = await verifyPortableArchive({ archivePath: fixture.root });

    assert.equal(result.ok, false);
    assert.equal(result.diagnostics.some((entry) => entry.code === "ARCHIVE_PATH_UNSAFE"), true);
  } finally {
    await fixture.cleanup();
  }
});

test("portable archive tar transport rejects links", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "run402-archive-tar-"));
  const tarPath = path.join(root, "archive.r402ar");
  try {
    await writeFile(tarPath, Buffer.concat([
      tarEntry("index.json", Buffer.alloc(0), "2"),
      Buffer.alloc(1024),
    ]));

    const result = await verifyPortableArchive({ archivePath: tarPath });

    assert.equal(result.ok, false);
    assert.equal(result.diagnostics[0]?.code, "ARCHIVE_ENTRY_TYPE_UNSUPPORTED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("portable archive rejects compressed envelopes instead of decompressing untrusted input", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "run402-archive-gzip-"));
  const tarPath = path.join(root, "archive.r402ar.gz");
  try {
    await writeFile(tarPath, Buffer.from([0x1f, 0x8b, 0x08, 0x00]));

    const result = await verifyPortableArchive({ archivePath: tarPath });

    assert.equal(result.ok, false);
    assert.equal(result.diagnostics[0]?.code, "ARCHIVE_ENTRY_TYPE_UNSUPPORTED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

interface ArchiveFixtureOptions {
  mutateIndex?(index: PortableArchiveIndex): void;
}

interface ArchiveFixture {
  root: string;
  archiveDigest: string;
  index: PortableArchiveIndex;
  storageBlobPath: string;
  cleanup(): Promise<void>;
}

async function createArchiveFixture(options: ArchiveFixtureOptions = {}): Promise<ArchiveFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "run402-archive-"));
  const descriptors: Record<string, PortableArchiveDescriptor> = {};

  await mkdir(path.join(root, "manifest"), { recursive: true });
  await mkdir(path.join(root, "database/data"), { recursive: true });
  await mkdir(path.join(root, "auth"), { recursive: true });
  await mkdir(path.join(root, "storage"), { recursive: true });
  await mkdir(path.join(root, "runtime"), { recursive: true });
  await mkdir(path.join(root, "secrets"), { recursive: true });
  await mkdir(path.join(root, "blobs/sha256"), { recursive: true });

  const storageBytes = Buffer.from("hello from portable storage\n");
  const storageDigest = computePortableArchiveBytesDigest(storageBytes);
  const storageBlobPath = `blobs/sha256/${storageDigest.slice("sha256:".length)}`;
  await writeFile(path.join(root, storageBlobPath), storageBytes);

  const functionBytes = Buffer.from("export default async () => new Response('hello from archive')\n");
  const functionDigest = computePortableArchiveBytesDigest(functionBytes);
  const functionBlobPath = `blobs/sha256/${functionDigest.slice("sha256:".length)}`;
  await writeFile(path.join(root, functionBlobPath), functionBytes);

  await writeDescriptor(descriptors, root, "release_spec", "manifest/release-spec.json", PROJECT_ARCHIVE_MEDIA_TYPES.releaseSpec, {
    project: "portable-fixture",
    base: { release: "empty" },
    database: { migrations: [{ id: "001", checksum: "sha256:fixture", sql: "select 1;" }] },
  });
  await writeDescriptor(
    descriptors,
    root,
    "portable_release_state",
    "manifest/portable-release-state.json",
    PROJECT_ARCHIVE_MEDIA_TYPES.portableReleaseState,
    {
      state_version: "run402.portable_release_state.v1",
      site: { paths: [{ path: "/index.html", content_sha256: storageDigest.slice("sha256:".length), content_type: "text/html" }] },
      static_manifest: null,
      functions: [],
      secrets: { keys: ["OPENAI_API_KEY"] },
      subdomains: { names: [] },
      routes: { manifest_sha256: null, entries: [] },
      migrations: [],
      i18n: null,
    },
  );
  await writeDescriptor(descriptors, root, "fact_set", "manifest/fact-set.json", PROJECT_ARCHIVE_MEDIA_TYPES.releaseFactSet, {
    schema_version: "run402.release_fact_set.v1",
    facts: [],
  });
  await writeDescriptor(
    descriptors,
    root,
    "portability_report",
    "manifest/portability-report.json",
    PROJECT_ARCHIVE_MEDIA_TYPES.portabilityReport,
    {
      schema_version: "run402.project_archive.portability_report.v1",
      entries: [
        {
          code: "AUTH_SUBJECT_STUBS_IMPORTED",
          severity: "info",
          resource_type: "auth_subject",
          message: "Disabled auth subject stubs will be imported.",
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
      ],
    },
  );
  await writeDescriptor(
    descriptors,
    root,
    "export_report",
    "manifest/export-report.json",
    PROJECT_ARCHIVE_MEDIA_TYPES.exportReport,
    {
      schema_version: "run402.project_archive.export_report.v1",
      export_scope: "portable-runtime-v1",
      auth_export: "stubs",
      consistency: "core_fixture_v1",
      omitted_sensitive_resource_count: 0,
      unsupported_resource_count: 0,
    },
  );
  await writeTextDescriptor(
    descriptors,
    root,
    "database.pre_data_sql",
    "database/pre-data.sql",
    PROJECT_ARCHIVE_MEDIA_TYPES.databaseSql,
    "create table todos (id bigint primary key, owner_id text not null, title text not null);\n",
  );
  await writeDescriptor(descriptors, root, "database.tables", "database/tables.json", PROJECT_ARCHIVE_MEDIA_TYPES.databaseTables, {
    schema_version: "run402.project_archive.database_tables.v1",
    tables: [{ id: "todos", name: "todos", copy_path: "database/data/todos.copy", row_count: 1 }],
  });
  await writeTextDescriptor(
    descriptors,
    root,
    "database.data.todos",
    "database/data/todos.copy",
    PROJECT_ARCHIVE_MEDIA_TYPES.databaseCopy,
    "1\tauth_subject_1\tShip portability\n",
  );
  await writeDescriptor(
    descriptors,
    root,
    "database.sequences",
    "database/sequences.json",
    PROJECT_ARCHIVE_MEDIA_TYPES.databaseSequences,
    { schema_version: "run402.project_archive.database_sequences.v1", sequences: [] },
  );
  await writeTextDescriptor(
    descriptors,
    root,
    "database.post_data_sql",
    "database/post-data.sql",
    PROJECT_ARCHIVE_MEDIA_TYPES.databaseSql,
    "alter table todos enable row level security;\n",
  );
  await writeDescriptor(descriptors, root, "auth.config", "auth/config.json", PROJECT_ARCHIVE_MEDIA_TYPES.authConfig, {
    schema_version: "run402.project_archive.auth_config.v1",
    auth_export: "stubs",
  });
  await writeTextDescriptor(
    descriptors,
    root,
    "auth.subjects",
    "auth/subjects.ndjson",
    PROJECT_ARCHIVE_MEDIA_TYPES.authSubjects,
    "{\"subject_id\":\"auth_subject_1\",\"disabled\":true}\n",
  );
  await writeDescriptor(descriptors, root, "storage.index", "storage/index.json", PROJECT_ARCHIVE_MEDIA_TYPES.storageIndex, {
    schema_version: "run402.project_archive.storage_index.v1",
    objects: [{
      key: "public/index.html",
      visibility: "public",
      content_type: "text/html",
      size: storageBytes.byteLength,
      digest: storageDigest,
      blob_path: storageBlobPath,
    }],
  });
  await writeDescriptor(descriptors, root, "runtime.index", "runtime/index.json", PROJECT_ARCHIVE_MEDIA_TYPES.runtimeIndex, {
    schema_version: "run402.project_archive.runtime_index.v1",
    functions: [{
      name: "api",
      runtime: "node22",
      artifact_digest: functionDigest,
      artifact_path: functionBlobPath,
      required_secrets: ["OPENAI_API_KEY"],
    }],
    astro_ssr: {
      enabled: true,
      function: "api",
    },
  });
  await writeDescriptor(
    descriptors,
    root,
    "secret_requirements",
    "secrets/requirements.json",
    PROJECT_ARCHIVE_MEDIA_TYPES.secretRequirements,
    {
      schema_version: "run402.project_archive.secret_requirements.v1",
      secrets: [{ name: "OPENAI_API_KEY", required: true, targets: ["function:api"] }],
    },
  );
  await writeTextDescriptor(
    descriptors,
    root,
    "secret_env_template",
    "secrets/required.env.template",
    PROJECT_ARCHIVE_MEDIA_TYPES.envTemplate,
    "OPENAI_API_KEY=\n",
  );

  descriptors["blob.storage.public_index"] = {
    mediaType: PROJECT_ARCHIVE_MEDIA_TYPES.blob,
    path: storageBlobPath,
    digest: storageDigest,
    size: storageBytes.byteLength,
  };
  descriptors["blob.function.api"] = {
    mediaType: PROJECT_ARCHIVE_MEDIA_TYPES.blob,
    path: functionBlobPath,
    digest: functionDigest,
    size: functionBytes.byteLength,
  };

  const layout: PortableArchiveLayout = {
    schema_version: PROJECT_ARCHIVE_LAYOUT_SCHEMA_VERSION,
    archive_version: PROJECT_ARCHIVE_VERSION,
    mediaType: PROJECT_ARCHIVE_MEDIA_TYPES.layout,
    index: "index.json",
    blobs: "blobs/sha256",
    transports: ["directory", "tar"],
    checksum_lists_authoritative: false,
  };
  await writeJson(path.join(root, "run402-layout.json"), layout);

  const index: PortableArchiveIndex = {
    schema_version: PROJECT_ARCHIVE_INDEX_SCHEMA_VERSION,
    archive_version: PROJECT_ARCHIVE_VERSION,
    mediaType: PROJECT_ARCHIVE_MEDIA_TYPES.index,
    core_compatibility: {
      runtime_kernel: ">=0.1.5",
      release_spec: "run402.release_spec.v1",
    },
    source: {
      platform: "run402-core-fixture",
      label: "portable archive unit fixture",
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
      "blob.storage.public_index",
      "blob.function.api",
    ],
    descriptors,
    consistency: {
      mode: "core_fixture_v1",
      pinned_release_id: "rel_fixture_archive_v1",
      storage: { mutation_pause: "not_applicable" },
      runtime: { artifact_capture: "captured" },
    },
  };
  options.mutateIndex?.(index);
  index.archive_digest = computePortableArchiveLogicalDigest(index);
  await writeJson(path.join(root, "index.json"), index);

  return {
    root,
    archiveDigest: index.archive_digest,
    index,
    storageBlobPath,
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function writeDescriptor(
  descriptors: Record<string, PortableArchiveDescriptor>,
  root: string,
  name: string,
  relativePath: string,
  mediaType: string,
  value: unknown,
): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  await writeFile(path.join(root, relativePath), bytes);
  descriptors[name] = {
    mediaType,
    path: relativePath,
    digest: computePortableArchiveBytesDigest(bytes),
    size: bytes.byteLength,
  };
}

async function writeTextDescriptor(
  descriptors: Record<string, PortableArchiveDescriptor>,
  root: string,
  name: string,
  relativePath: string,
  mediaType: string,
  text: string,
): Promise<void> {
  const bytes = Buffer.from(text);
  await writeFile(path.join(root, relativePath), bytes);
  descriptors[name] = {
    mediaType,
    path: relativePath,
    digest: computePortableArchiveBytesDigest(bytes),
    size: bytes.byteLength,
  };
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function tarEntry(name: string, body: Buffer, typeFlag: string): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, "utf8");
  header.write("0000644\0", 100, "ascii");
  header.write("0000000\0", 108, "ascii");
  header.write("0000000\0", 116, "ascii");
  header.write(octal(body.byteLength, 11), 124, "ascii");
  header.write("00000000000\0", 136, "ascii");
  header.fill(" ", 148, 156);
  header.write(typeFlag, 156, "ascii");
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(octal(checksum, 6), 148, "ascii");
  header[154] = 0;
  header[155] = 32;
  const padding = Buffer.alloc(Math.ceil(body.byteLength / 512) * 512 - body.byteLength);
  return Buffer.concat([header, body, padding]);
}

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width, "0");
}

class RecordingArchiveImporter implements PortableArchiveImporterPort {
  readonly calls: PortableArchiveVerifiedImportInput[] = [];

  async importVerifiedArchive(input: PortableArchiveVerifiedImportInput) {
    this.calls.push(input);
    return {
      project_id: "prj_imported_archive",
      project_name: input.project_name,
      release_id: "rel_imported_archive",
    };
  }
}
