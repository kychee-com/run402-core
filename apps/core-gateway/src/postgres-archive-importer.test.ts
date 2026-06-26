import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PortableArchiveError,
  type ContentStorePort,
} from "@run402/runtime-kernel";
import { emptyPortableReleaseState } from "@run402/release";
import type { Pool as PgPool } from "pg";

import { PostgresArchiveImporter } from "./postgres-archive-importer.js";

interface QueryRecord {
  text: string;
  values?: readonly unknown[];
}

type QueryResult<T = unknown> = {
  rows: T[];
  rowCount: number;
};

type QueryHandler = (text: string, values?: readonly unknown[]) => QueryResult | Promise<QueryResult | void> | void;

class FakeArchiveClient {
  readonly queries: QueryRecord[] = [];
  released = false;

  constructor(readonly handler: QueryHandler = () => undefined) {}

  async query<T = unknown>(input: unknown, values?: readonly unknown[]): Promise<QueryResult<T>> {
    const text = typeof input === "string" ? input : String(input);
    this.queries.push({ text, values });
    return (await this.handler(text, values) ?? { rows: [], rowCount: 0 }) as QueryResult<T>;
  }

  release(): void {
    this.released = true;
  }
}

class FakeArchivePool {
  connectCount = 0;

  constructor(readonly client: FakeArchiveClient) {}

  async connect(): Promise<FakeArchiveClient> {
    this.connectCount += 1;
    return this.client;
  }
}

class FakeContentStore implements ContentStorePort {
  readonly puts: Array<{ projectId: string; sha256: string; bytes: Uint8Array; contentType: string }> = [];

  async putStatic(input: { projectId: string; sha256: string; bytes: Uint8Array; contentType: string }): Promise<void> {
    this.puts.push(input);
  }

  async hasContent(): Promise<boolean> {
    return false;
  }

  async readStatic(): Promise<null> {
    return null;
  }
}

function importerFor(pool: FakeArchivePool, content = new FakeContentStore()): PostgresArchiveImporter {
  return new PostgresArchiveImporter(pool as unknown as PgPool, content, {
    publicBaseUrl: "http://core.local",
    postgrestPublicUrl: "http://postgrest.local",
  });
}

function queryTexts(client: FakeArchiveClient): string[] {
  return client.queries.map((query) => query.text.trim());
}

test("archive importer rejects credential-bearing auth exports before opening a database transaction", async (t) => {
  const archivePath = await createArchiveFixture({
    authConfig: { auth_export: "credentials" },
  });
  t.after(async () => {
    await rm(archivePath, { recursive: true, force: true });
  });
  const client = new FakeArchiveClient();
  const pool = new FakeArchivePool(client);

  await assert.rejects(
    () => importerFor(pool).importVerifiedArchive({
      archive_path: archivePath,
      project_name: "imported-app",
      secret_values: {},
    }),
    (error) => error instanceof PortableArchiveError && error.code === "AUTH_CREDENTIALS_NOT_EXPORTED",
  );

  assert.equal(pool.connectCount, 0);
  assert.deepEqual(client.queries, []);
});

test("archive importer rolls back unsafe pre-data SQL after creating the local project shell", async (t) => {
  const archivePath = await createArchiveFixture({
    preDataSql: "CREATE EXTENSION untrusted_extension;",
  });
  t.after(async () => {
    await rm(archivePath, { recursive: true, force: true });
  });
  const client = new FakeArchiveClient((text) => {
    if (text.includes("SELECT project_id FROM internal.core_projects WHERE name")) {
      return { rows: [], rowCount: 0 };
    }
  });
  const pool = new FakeArchivePool(client);

  await assert.rejects(
    () => importerFor(pool).importVerifiedArchive({
      archive_path: archivePath,
      project_name: "imported-app",
      secret_values: {},
    }),
    (error) => error instanceof PortableArchiveError && error.code === "DATABASE_EXTENSION_UNSUPPORTED",
  );

  const texts = queryTexts(client);
  assert.equal(texts[0], "BEGIN");
  assert.equal(texts.some((text) => text.includes("CREATE SCHEMA \"project_")), true);
  assert.equal(texts.some((text) => text.includes("SET LOCAL ROLE \"run402_archive_importer\"")), true);
  assert.equal(texts.some((text) => text.includes("CREATE EXTENSION")), false);
  assert.equal(texts.includes("RESET ROLE"), true);
  assert.equal(texts.at(-1), "ROLLBACK");
  assert.equal(texts.includes("COMMIT"), false);
  assert.equal(client.released, true);
});

test("archive importer rolls back duplicate local project names before schema creation", async (t) => {
  const archivePath = await createArchiveFixture();
  t.after(async () => {
    await rm(archivePath, { recursive: true, force: true });
  });
  const client = new FakeArchiveClient((text) => {
    if (text.includes("SELECT project_id FROM internal.core_projects WHERE name")) {
      return { rows: [{ project_id: "prj_existing" }], rowCount: 1 };
    }
  });
  const pool = new FakeArchivePool(client);

  await assert.rejects(
    () => importerFor(pool).importVerifiedArchive({
      archive_path: archivePath,
      project_name: "imported-app",
      secret_values: {},
    }),
    (error) => error instanceof PortableArchiveError && error.code === "PROJECT_ALREADY_EXISTS",
  );

  const texts = queryTexts(client);
  assert.equal(texts[0], "BEGIN");
  assert.match(texts[1] ?? "", /SELECT project_id FROM internal\.core_projects/);
  assert.equal(texts.some((text) => text.includes("CREATE SCHEMA")), false);
  assert.equal(texts.at(-1), "ROLLBACK");
  assert.equal(client.released, true);
});

async function createArchiveFixture(options: {
  preDataSql?: string;
  postDataSql?: string;
  authConfig?: Record<string, unknown>;
  authSubjects?: Array<Record<string, unknown>>;
} = {}): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "run402-archive-importer-test-"));
  await mkdir(path.join(root, "manifest"), { recursive: true });
  await mkdir(path.join(root, "database"), { recursive: true });
  await mkdir(path.join(root, "storage"), { recursive: true });
  await mkdir(path.join(root, "runtime"), { recursive: true });
  await mkdir(path.join(root, "secrets"), { recursive: true });
  await mkdir(path.join(root, "auth"), { recursive: true });

  await writeJson(root, "index.json", {
    consistency: { pinned_release_id: "rel_fixture" },
  });
  await writeJson(root, "manifest/portable-release-state.json", emptyPortableReleaseState());
  await writeFile(path.join(root, "database", "pre-data.sql"), options.preDataSql ?? "", "utf8");
  await writeJson(root, "database/tables.json", { tables: [] });
  await writeJson(root, "database/sequences.json", { sequences: [] });
  await writeFile(path.join(root, "database", "post-data.sql"), options.postDataSql ?? "", "utf8");
  await writeJson(root, "storage/index.json", { objects: [] });
  await writeJson(root, "runtime/index.json", { functions: [] });
  await writeJson(root, "secrets/requirements.json", { secrets: [] });
  await writeJson(root, "auth/config.json", options.authConfig ?? { auth_export: "stubs" });

  const authSubjects = options.authSubjects?.map((subject) => JSON.stringify(subject)).join("\n") ?? "";
  await writeFile(
    path.join(root, "auth", "subjects.ndjson"),
    authSubjects ? `${authSubjects}\n` : "",
    "utf8",
  );

  return root;
}

async function writeJson(root: string, relativePath: string, value: unknown): Promise<void> {
  await writeFile(path.join(root, relativePath), `${JSON.stringify(value)}\n`, "utf8");
}
