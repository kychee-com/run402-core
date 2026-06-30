import { createHash, randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { from as copyFrom } from "pg-copy-streams";
import type { Pool as PgPool, PoolClient } from "pg";
import {
  PortableArchiveError,
  PROJECT_ARCHIVE_MEDIA_TYPES,
  runtimeCapabilities,
  type ContentStorePort,
  type PortableArchiveImportedProject,
  type PortableArchiveImporterPort,
  type PortableArchiveVerifiedImportInput,
} from "@run402/runtime-kernel";
import { digestMaterializedRelease, type PortableReleaseState } from "@run402/release";

const ARCHIVE_IMPORTER_ROLE = "run402_archive_importer";

export interface PostgresArchiveImporterOptions {
  publicBaseUrl: string;
  postgrestPublicUrl: string;
}

interface ArchiveDatabaseTables {
  tables: Array<{
    id: string;
    schema?: string;
    name: string;
    copy_path: string;
    row_count: number;
    columns?: Array<{ name: string; type: string; nullable?: boolean }>;
  }>;
}

interface ArchiveSequences {
  sequences?: Array<{
    schema?: string;
    name: string;
    value: string;
    is_called: boolean;
  }>;
}

interface ArchiveStorageIndex {
  objects?: Array<{
    key: string;
    visibility: "public" | "private";
    content_type: string;
    cache_control?: string;
    immutable?: boolean;
    size: number;
    digest: `sha256:${string}`;
    blob_path: string;
  }>;
}

interface ArchiveRuntimeIndex {
  functions?: Array<{
    name: string;
    runtime: "node22";
    entrypoint?: string;
    artifact_digest: `sha256:${string}`;
    artifact_path: string;
    required_secrets?: string[];
    class?: "standard" | "ssr";
  }>;
  astro_ssr?: {
    enabled: boolean;
    function?: string;
  };
}

interface ArchiveSecretRequirements {
  secrets?: Array<{
    name: string;
    required: boolean;
    targets?: string[];
  }>;
}

interface ArchiveAuthConfig {
  auth_export?: string;
}

interface AuthSubjectStub {
  subject_id: string;
  disabled: true;
  references?: string[];
}

export class PostgresArchiveImporter implements PortableArchiveImporterPort {
  readonly #pool: PgPool;
  readonly #content: ContentStorePort;
  readonly #publicBaseUrl: string;
  readonly #postgrestPublicUrl: string;

  constructor(pool: PgPool, content: ContentStorePort, options: PostgresArchiveImporterOptions) {
    this.#pool = pool;
    this.#content = content;
    this.#publicBaseUrl = trimTrailingSlash(options.publicBaseUrl);
    this.#postgrestPublicUrl = trimTrailingSlash(options.postgrestPublicUrl);
  }

  async bootstrap(): Promise<void> {
    await this.#pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ARCHIVE_IMPORTER_ROLE}') THEN
          CREATE ROLE ${ARCHIVE_IMPORTER_ROLE} NOLOGIN;
        END IF;
        EXECUTE format('GRANT ${ARCHIVE_IMPORTER_ROLE} TO %I', current_user);
      END $$;
      GRANT USAGE ON SCHEMA auth TO ${ARCHIVE_IMPORTER_ROLE};

      CREATE TABLE IF NOT EXISTS internal.core_auth_subject_stubs (
        project_id text NOT NULL REFERENCES internal.core_projects(project_id) ON DELETE CASCADE,
        subject_id text NOT NULL,
        disabled boolean NOT NULL DEFAULT true,
        subject_references jsonb NOT NULL DEFAULT '[]'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (project_id, subject_id)
      );
    `);
  }

  async importVerifiedArchive(input: PortableArchiveVerifiedImportInput): Promise<PortableArchiveImportedProject> {
    const archivePath = await assertDirectoryArchive(input.archive_path);
    const releaseId = await releaseIdFromArchive(archivePath);
    const releaseState = await readArchiveJson<PortableReleaseState>(archivePath, "manifest/portable-release-state.json");
    const releaseDigest = digestMaterializedRelease(releaseState);
    const projectRow = createProjectRow(input.project_name);
    const database = await readDatabaseFiles(archivePath);
    const storage = await readArchiveJson<ArchiveStorageIndex>(archivePath, "storage/index.json");
    const runtime = await readArchiveJson<ArchiveRuntimeIndex>(archivePath, "runtime/index.json");
    const secrets = await readArchiveJson<ArchiveSecretRequirements>(archivePath, "secrets/requirements.json");
    const authConfig = await readArchiveJson<ArchiveAuthConfig>(archivePath, "auth/config.json");
    const authStubs = await readAuthStubs(archivePath, "auth/subjects.ndjson");
    validateAuthConfig(authConfig, authStubs);

    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await assertProjectNameAvailable(client, projectRow.name);
      await createProject(client, projectRow);
      await this.#importDatabase(client, projectRow, database);
      await this.#importStorage(client, archivePath, projectRow.project_id, storage);
      await this.#importRuntime(client, archivePath, projectRow.project_id, releaseId, runtime);
      await importSecretRequirements(client, projectRow.project_id, secrets, input.secret_values);
      await importAuthStubs(client, projectRow.project_id, authStubs);
      await activateRelease(client, projectRow.project_id, releaseId, releaseDigest, releaseState);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    return {
      project_id: projectRow.project_id,
      project_name: projectRow.name,
      release_id: releaseId,
      endpoints: {
        rest_url: this.#postgrestPublicUrl,
        static_base_url: `${this.#publicBaseUrl}/projects/v1/${projectRow.project_id}/static`,
        storage_base_url: `${this.#publicBaseUrl}/projects/v1/${projectRow.project_id}/storage`,
      },
    };
  }

  async #importDatabase(
    client: PoolClient,
    project: ProjectRow,
    database: Awaited<ReturnType<typeof readDatabaseFiles>>,
  ): Promise<void> {
    await client.query(`SET LOCAL ROLE ${quoteIdentifier(ARCHIVE_IMPORTER_ROLE)}`);
    try {
      await client.query(`SET LOCAL search_path TO ${quoteIdentifier(project.schema_slot)}, public, auth`);
      await runArchiveSql(client, database.preDataSql, "pre-data");

      for (const table of database.tables.tables) {
        if (table.schema && table.schema !== "public") {
          throw new PortableArchiveError("DATABASE_SCHEMA_UNSAFE", `Unsupported table schema in archive: ${table.schema}.`, {
            table: table.name,
            schema: table.schema,
          });
        }
        const tableName = quoteIdentifier(table.name);
        const columns = table.columns?.map((column) => quoteIdentifier(column.name)).join(", ");
        const copySql = `COPY ${tableName}${columns ? ` (${columns})` : ""} FROM STDIN WITH (FORMAT text)`;
        const copyStream = (client as unknown as { query(query: unknown): Writable }).query(copyFrom(copySql));
        await pipeline(Readable.from([database.copyPayloads.get(table.id) ?? Buffer.alloc(0)]), copyStream);
        const count = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${tableName}`);
        if (Number(count.rows[0]?.count ?? 0) !== table.row_count) {
          throw new PortableArchiveError("DATABASE_SCHEMA_UNSAFE", `Imported row count mismatch for table ${table.name}.`, {
            table: table.name,
            expected: table.row_count,
            actual: Number(count.rows[0]?.count ?? 0),
          });
        }
      }

      for (const sequence of database.sequences.sequences ?? []) {
        const sequenceName = sequence.schema && sequence.schema !== "public"
          ? `${quoteIdentifier(sequence.schema)}.${quoteIdentifier(sequence.name)}`
          : quoteIdentifier(sequence.name);
        await client.query("SELECT setval($1::regclass, $2::bigint, $3::boolean)", [
          sequenceName,
          sequence.value,
          sequence.is_called,
        ]);
      }

      await runArchiveSql(client, database.postDataSql, "post-data");
    } finally {
      await client.query("RESET ROLE").catch(() => undefined);
    }
  }

  async #importStorage(
    client: PoolClient,
    archivePath: string,
    projectId: string,
    storage: ArchiveStorageIndex,
  ): Promise<void> {
    for (const object of storage.objects ?? []) {
      const digest = stripSha256Prefix(object.digest);
      const bytes = await readArchiveFile(archivePath, object.blob_path);
      assertDigest(bytes, object.digest, object.blob_path);
      await this.#content.putStatic({
        projectId,
        sha256: digest,
        bytes,
        contentType: object.content_type,
      });
      await client.query(
        `
          INSERT INTO internal.core_content_objects (sha256, size_bytes, content_type)
          VALUES ($1, $2, $3)
          ON CONFLICT (sha256) DO UPDATE
          SET size_bytes = EXCLUDED.size_bytes,
              content_type = EXCLUDED.content_type,
              last_verified_at = now()
        `,
        [digest, object.size, object.content_type],
      );
      await client.query(
        `
          INSERT INTO internal.core_storage_objects (
            project_id, key, content_sha256, size_bytes, content_type, visibility, immutable
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (project_id, key) DO UPDATE
          SET content_sha256 = EXCLUDED.content_sha256,
              size_bytes = EXCLUDED.size_bytes,
              content_type = EXCLUDED.content_type,
              visibility = EXCLUDED.visibility,
              immutable = EXCLUDED.immutable,
              updated_at = now(),
              deleted_at = NULL
        `,
        [projectId, object.key, digest, object.size, object.content_type, object.visibility, object.immutable ?? false],
      );
    }
  }

  async #importRuntime(
    client: PoolClient,
    archivePath: string,
    projectId: string,
    releaseId: string,
    runtime: ArchiveRuntimeIndex,
  ): Promise<void> {
    for (const fn of runtime.functions ?? []) {
      const digest = stripSha256Prefix(fn.artifact_digest);
      const bytes = await readArchiveFile(archivePath, fn.artifact_path);
      assertDigest(bytes, fn.artifact_digest, fn.artifact_path);
      await this.#content.putStatic({
        projectId,
        sha256: digest,
        bytes,
        contentType: "application/javascript",
      });
      await client.query(
        `
          INSERT INTO internal.core_content_objects (sha256, size_bytes, content_type)
          VALUES ($1, $2, 'application/javascript')
          ON CONFLICT (sha256) DO NOTHING
        `,
        [digest, bytes.byteLength],
      );
      await client.query(
        `
          INSERT INTO internal.core_function_bundles (
            project_id, release_id, name, runtime, entrypoint, bundle_sha256, bundle_size_bytes,
            dependency_mode, dependency_lock_digest, deps, required_secrets, require_auth,
            require_role, class, capabilities, schedule, schedule_meta, timeout_ms, memory_bytes
          )
          VALUES ($1, $2, $3, 'node22', $4, $5, $6, 'bundled', NULL, '[]'::jsonb,
            $7::jsonb, false, NULL, $8, $9::jsonb, NULL, NULL, 10000, 134217728)
        `,
        [
          projectId,
          releaseId,
          fn.name,
          fn.entrypoint ?? "default",
          digest,
          bytes.byteLength,
          JSON.stringify(fn.required_secrets ?? []),
          fn.class ?? "standard",
          JSON.stringify(fn.class === "ssr" ? ["astro.ssr.v1"] : []),
        ],
      );
    }
  }
}

interface ProjectRow {
  project_id: string;
  name: string;
  schema_slot: string;
  public_id: string;
  anon_key: string;
  service_key: string;
}

async function readDatabaseFiles(archivePath: string): Promise<{
  preDataSql: string;
  tables: ArchiveDatabaseTables;
  copyPayloads: Map<string, Buffer>;
  sequences: ArchiveSequences;
  postDataSql: string;
}> {
  const tables = await readArchiveJson<ArchiveDatabaseTables>(archivePath, "database/tables.json");
  const copyPayloads = new Map<string, Buffer>();
  for (const table of tables.tables) {
    copyPayloads.set(table.id, await readArchiveFile(archivePath, table.copy_path));
  }
  return {
    preDataSql: await readArchiveText(archivePath, "database/pre-data.sql"),
    tables,
    copyPayloads,
    sequences: await readArchiveJson<ArchiveSequences>(archivePath, "database/sequences.json"),
    postDataSql: await readArchiveText(archivePath, "database/post-data.sql"),
  };
}

async function createProject(client: PoolClient, row: ProjectRow): Promise<void> {
  await client.query(`CREATE SCHEMA ${quoteIdentifier(row.schema_slot)} AUTHORIZATION ${quoteIdentifier(ARCHIVE_IMPORTER_ROLE)}`);
  await client.query(`GRANT USAGE ON SCHEMA ${quoteIdentifier(row.schema_slot)} TO anon, authenticated, service_role`);
  await client.query(
    `
      INSERT INTO internal.core_projects (
        project_id, name, schema_slot, public_id, anon_key, service_key, active_release_id
      )
      VALUES ($1, $2, $3, $4, $5, $6, NULL)
    `,
    [row.project_id, row.name, row.schema_slot, row.public_id, row.anon_key, row.service_key],
  );
}

async function assertProjectNameAvailable(client: PoolClient, name: string): Promise<void> {
  const existing = await client.query<{ project_id: string }>(
    "SELECT project_id FROM internal.core_projects WHERE name = $1 LIMIT 1 FOR SHARE",
    [name],
  );
  if (existing.rows[0]) {
    throw new PortableArchiveError("PROJECT_ALREADY_EXISTS", `A local Core project named ${name} already exists.`, {
      project_name: name,
      next_name_hint: `${name}-imported`,
    });
  }
}

async function activateRelease(
  client: PoolClient,
  projectId: string,
  releaseId: string,
  digest: string,
  release: PortableReleaseState,
): Promise<void> {
  await client.query(
    `
      INSERT INTO internal.core_releases (project_id, release_id, digest, state)
      VALUES ($1, $2, $3, $4)
    `,
    [projectId, releaseId, digest, release],
  );
  await client.query(
    `
      UPDATE internal.core_projects
      SET active_release_id = $2, updated_at = now()
      WHERE project_id = $1
    `,
    [projectId, releaseId],
  );
  await client.query("NOTIFY pgrst, 'reload config'");
  await client.query("NOTIFY pgrst, 'reload schema'");
}

async function importSecretRequirements(
  client: PoolClient,
  projectId: string,
  requirements: ArchiveSecretRequirements,
  secretValues: Record<string, string>,
): Promise<void> {
  for (const secret of requirements.secrets ?? []) {
    await client.query(
      `
        INSERT INTO internal.core_function_secrets (
          project_id, name, scope, function_name, encrypted_value_ref
        )
        VALUES ($1, $2, 'project', '', $3)
        ON CONFLICT (project_id, name, scope, function_name)
        DO UPDATE SET encrypted_value_ref = EXCLUDED.encrypted_value_ref, updated_at = now()
      `,
      [projectId, secret.name, Object.hasOwn(secretValues, secret.name) ? `local-env:${secret.name}` : null],
    );
  }
}

async function importAuthStubs(client: PoolClient, projectId: string, stubs: AuthSubjectStub[]): Promise<void> {
  for (const stub of stubs) {
    await client.query(
      `
        INSERT INTO internal.core_auth_subject_stubs (project_id, subject_id, disabled, subject_references)
        VALUES ($1, $2, true, $3::jsonb)
        ON CONFLICT (project_id, subject_id)
        DO UPDATE SET disabled = true, subject_references = EXCLUDED.subject_references
      `,
      [projectId, stub.subject_id, JSON.stringify(stub.references ?? [])],
    );
  }
}

function validateAuthConfig(config: ArchiveAuthConfig, stubs: AuthSubjectStub[]): void {
  const mode = config.auth_export ?? "stubs";
  if (mode !== "none" && mode !== "stubs") {
    throw new PortableArchiveError("AUTH_CREDENTIALS_NOT_EXPORTED", "Portable archive v1 imports auth_export none or stubs only.", {
      auth_export: mode,
    });
  }
  for (const stub of stubs) {
    if (stub.disabled !== true) {
      throw new PortableArchiveError("AUTH_CREDENTIALS_NOT_EXPORTED", "Portable archive v1 requires disabled auth subject stubs.", {
        subject_id: stub.subject_id,
      });
    }
  }
}

async function runArchiveSql(client: PoolClient, sql: string, phase: string): Promise<void> {
  validateArchiveSql(sql, phase);
  if (sql.trim()) {
    await client.query(sql);
  }
}

function validateArchiveSql(sql: string, phase: string): void {
  if (/\bCREATE\s+EXTENSION\b/i.test(sql)) {
    throw new PortableArchiveError("DATABASE_EXTENSION_UNSUPPORTED", `Unsupported extension in ${phase} SQL.`);
  }
  const unsafe = [
    /\bCOPY\b/i,
    /\bPROGRAM\b/i,
    /\\copy/i,
    /\bALTER\s+SYSTEM\b/i,
    /\bpg_(read|write|ls)_/i,
    /\blo_import\b/i,
    /\blo_export\b/i,
  ];
  if (unsafe.some((pattern) => pattern.test(sql))) {
    throw new PortableArchiveError("DATABASE_SCHEMA_UNSAFE", `Unsafe database archive SQL in ${phase}.`);
  }
}

async function releaseIdFromArchive(archivePath: string): Promise<string> {
  const index = await readArchiveJson<{ consistency?: { pinned_release_id?: string | null } }>(archivePath, "index.json");
  const releaseId = index.consistency?.pinned_release_id;
  if (!releaseId) {
    throw new PortableArchiveError("ARCHIVE_DESCRIPTOR_MISSING", "Archive is missing pinned release identity.");
  }
  return releaseId;
}

async function readAuthStubs(archivePath: string, relativePath: string): Promise<AuthSubjectStub[]> {
  const text = await readArchiveText(archivePath, relativePath);
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AuthSubjectStub);
}

async function readArchiveJson<T>(archivePath: string, relativePath: string): Promise<T> {
  return JSON.parse(await readArchiveText(archivePath, relativePath)) as T;
}

async function readArchiveText(archivePath: string, relativePath: string): Promise<string> {
  return (await readArchiveFile(archivePath, relativePath)).toString("utf8");
}

async function readArchiveFile(archivePath: string, relativePath: string): Promise<Buffer> {
  if (!isSafeArchivePath(relativePath)) {
    throw new PortableArchiveError("ARCHIVE_PATH_UNSAFE", `Unsafe archive path: ${relativePath}`);
  }
  return readFile(path.join(archivePath, relativePath));
}

async function assertDirectoryArchive(archivePath: string): Promise<string> {
  const stats = await stat(archivePath);
  if (!stats.isDirectory()) {
    throw new PortableArchiveError(
      "IMPORT_VERIFY_FAILED",
      "Core import currently requires an unpacked archive directory after verification.",
    );
  }
  return archivePath;
}

function assertDigest(bytes: Uint8Array, digest: `sha256:${string}`, relativePath: string): void {
  const actual = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (actual !== digest) {
    throw new PortableArchiveError("ARCHIVE_DIGEST_MISMATCH", `Digest mismatch while importing ${relativePath}.`, {
      expected: digest,
      actual,
    });
  }
}

function createProjectRow(name: string): ProjectRow {
  const token = randomToken(8);
  return {
    project_id: `prj_${token}`,
    name,
    schema_slot: `project_${token}`,
    public_id: `local_${randomToken(10)}`,
    anon_key: `r402_anon_${randomToken(24)}`,
    service_key: `r402_service_${randomToken(24)}`,
  };
}

function stripSha256Prefix(digest: `sha256:${string}`): string {
  return digest.slice("sha256:".length);
}

function isSafeArchivePath(value: string): boolean {
  return Boolean(value) &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    path.posix.normalize(value) === value &&
    !value.split("/").some((segment) => segment === "." || segment === ".." || segment.length === 0);
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) {
    throw new PortableArchiveError("DATABASE_SCHEMA_UNSAFE", `Unsafe SQL identifier: ${value}`);
  }
  return `"${value.replaceAll('"', '""')}"`;
}

function randomToken(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
