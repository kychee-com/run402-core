import assert from "node:assert/strict";
import test from "node:test";

import { ApplyInvariantError, emptyCoreReleaseState } from "@run402/runtime-kernel";
import type { Pool as PgPool } from "pg";

import { PostgresApplyStore } from "./postgres-apply.js";

interface QueryRecord {
  text: string;
  values?: readonly unknown[];
}

type QueryResult<T = unknown> = {
  rows: T[];
  rowCount: number;
};

type QueryHandler = (text: string, values?: readonly unknown[]) => QueryResult | Promise<QueryResult | void> | void;

class FakeApplyClient {
  readonly queries: QueryRecord[] = [];
  released = false;

  constructor(readonly handler: QueryHandler = () => undefined) {}

  async query<T = unknown>(text: string, values?: readonly unknown[]): Promise<QueryResult<T>> {
    this.queries.push({ text, values });
    return (await this.handler(text, values) ?? { rows: [], rowCount: 0 }) as QueryResult<T>;
  }

  release(): void {
    this.released = true;
  }
}

function poolFor(client: FakeApplyClient): PgPool {
  return {
    connect: async () => client,
  } as unknown as PgPool;
}

function queryTexts(client: FakeApplyClient): string[] {
  return client.queries.map((query) => query.text.trim());
}

test("postgres apply store rolls back stale active-release commits before writes", async () => {
  const client = new FakeApplyClient((text) => {
    if (text.includes("SELECT active_release_id")) {
      return { rows: [{ active_release_id: "rel_live" }], rowCount: 1 };
    }
  });
  const store = new PostgresApplyStore(poolFor(client));

  await assert.rejects(
    () => store.setActiveRelease({
      projectId: "prj_test",
      releaseId: "rel_next",
      digest: "sha256:test",
      release: emptyCoreReleaseState(),
      expectedBaseReleaseId: "rel_previous",
    }),
    (error) => error instanceof ApplyInvariantError && error.code === "stale_plan",
  );

  const texts = queryTexts(client);
  assert.equal(texts[0], "BEGIN");
  assert.match(texts[1] ?? "", /SELECT active_release_id/);
  assert.equal(texts.at(-1), "ROLLBACK");
  assert.equal(texts.some((text) => text.includes("INSERT INTO internal.core_releases")), false);
  assert.equal(texts.some((text) => text.includes("UPDATE internal.core_projects")), false);
  assert.equal(texts.includes("COMMIT"), false);
  assert.equal(client.released, true);
});

test("postgres apply store rejects unsafe migration schemas before executing caller SQL", async () => {
  const client = new FakeApplyClient();
  const store = new PostgresApplyStore(poolFor(client));

  await assert.rejects(
    () => store.applyInline({
      projectId: "prj_test",
      schema: "project-unsafe",
      migrationId: "001_bad_schema",
      checksum_hex: "a".repeat(64),
      sql: "DROP TABLE important_data",
      transaction: "none",
    }),
    /Unsafe SQL identifier: project-unsafe/,
  );

  assert.deepEqual(queryTexts(client), ["RESET search_path"]);
  assert.equal(client.released, true);
});

test("postgres apply store rolls back transactional migration SQL failures", async () => {
  const failingSql = "CREATE TABLE todos (id integer primary key)";
  const client = new FakeApplyClient((text) => {
    if (text === failingSql) {
      throw new Error("boom");
    }
  });
  const store = new PostgresApplyStore(poolFor(client));

  await assert.rejects(
    () => store.applyInline({
      projectId: "prj_test",
      schema: "project_safe",
      migrationId: "001_failure",
      checksum_hex: "b".repeat(64),
      sql: failingSql,
      transaction: "default",
    }),
    /boom/,
  );

  const texts = queryTexts(client);
  assert.equal(texts[0], "BEGIN");
  assert.equal(texts[1], "SET LOCAL search_path TO \"project_safe\", public");
  assert.equal(texts[2], failingSql);
  assert.equal(texts.includes("ROLLBACK"), true);
  assert.equal(texts.at(-1), "RESET search_path");
  assert.equal(texts.some((text) => text.includes("INSERT INTO internal.core_applied_migrations")), false);
  assert.equal(texts.includes("COMMIT"), false);
  assert.equal(client.released, true);
});
