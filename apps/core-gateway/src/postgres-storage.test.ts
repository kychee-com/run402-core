import assert from "node:assert/strict";
import test from "node:test";

import {
  ApplyInvariantError,
  CORE_FUNCTION_DEPENDENCY_MODE,
  StorageValidationError,
  type CoreFunctionApplyEffects,
  type CoreStorageApplyEffects,
} from "@run402/runtime-kernel";
import { emptyPortableReleaseState } from "@run402/release";
import type { Pool as PgPool } from "pg";

import { PostgresStorageStore } from "./postgres-storage.js";

const PROJECT_ID = "prj_test";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

interface QueryRecord {
  text: string;
  values?: readonly unknown[];
}

type QueryResult<T = unknown> = {
  rows: T[];
  rowCount: number;
};

type QueryHandler = (text: string, values?: readonly unknown[]) => QueryResult | Promise<QueryResult | void> | void;

class FakeStorageClient {
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

class FakeStoragePool {
  readonly queries: QueryRecord[] = [];

  constructor(readonly client: FakeStorageClient, readonly handler: QueryHandler = () => undefined) {}

  async connect(): Promise<FakeStorageClient> {
    return this.client;
  }

  async query<T = unknown>(input: unknown, values?: readonly unknown[]): Promise<QueryResult<T>> {
    const text = typeof input === "string" ? input : String(input);
    this.queries.push({ text, values });
    return (await this.handler(text, values) ?? { rows: [], rowCount: 0 }) as QueryResult<T>;
  }
}

function storeFor(pool: FakeStoragePool): PostgresStorageStore {
  return new PostgresStorageStore(pool as unknown as PgPool, {
    publicBaseUrl: "http://core.local/",
    signedReadSecret: "test-secret",
    maxObjectBytes: 1024 * 1024,
  });
}

function queryTexts(client: FakeStorageClient): string[] {
  return client.queries.map((query) => query.text.trim());
}

test("postgres storage rolls back upload completion before object writes when byte counts drift", async () => {
  const client = new FakeStorageClient((text) => {
    if (text.includes("FROM internal.core_upload_sessions") && text.includes("FOR UPDATE")) {
      return { rows: [uploadSessionRow({ bytes_written: 10 })], rowCount: 1 };
    }
  });
  const store = storeFor(new FakeStoragePool(client));

  await assert.rejects(
    () => store.completeUploadSession({ projectId: PROJECT_ID, uploadId: "upl_test" }),
    (error) => error instanceof StorageValidationError && error.code === "upload_size_mismatch",
  );

  const texts = queryTexts(client);
  assert.equal(texts[0], "BEGIN");
  assert.match(texts[1] ?? "", /FROM internal\.core_upload_sessions/);
  assert.equal(texts.at(-1), "ROLLBACK");
  assert.equal(texts.some((text) => text.includes("INSERT INTO internal.core_content_objects")), false);
  assert.equal(texts.some((text) => text.includes("INSERT INTO internal.core_storage_objects")), false);
  assert.equal(texts.includes("COMMIT"), false);
  assert.equal(client.released, true);
});

test("postgres storage completes immutable uploads with content, object, version, and public URLs", async () => {
  const client = new FakeStorageClient((text) => {
    if (text.includes("FROM internal.core_upload_sessions") && text.includes("FOR UPDATE")) {
      return { rows: [uploadSessionRow({ bytes_written: 12 })], rowCount: 1 };
    }
    if (text.includes("INSERT INTO internal.core_storage_objects")) {
      return {
        rows: [storageObjectRow({
          content_sha256: SHA_A,
          immutable: true,
          visibility: "public",
        })],
        rowCount: 1,
      };
    }
  });
  const store = storeFor(new FakeStoragePool(client));

  const object = await store.completeUploadSession({ projectId: PROJECT_ID, uploadId: "upl_test" });

  assert.equal(object.key, "assets/app.js");
  assert.equal(object.sha256, SHA_A);
  assert.equal(object.public_url, "http://core.local/projects/v1/prj_test/storage/public/assets/app.js");
  assert.equal(
    object.immutable_url,
    `http://core.local/projects/v1/prj_test/storage/immutable/${SHA_A}/assets/app.js`,
  );

  const texts = queryTexts(client);
  assert.equal(texts[0], "BEGIN");
  assert.equal(texts.some((text) => text.includes("INSERT INTO internal.core_content_objects")), true);
  assert.equal(texts.some((text) => text.includes("INSERT INTO internal.core_storage_objects")), true);
  assert.equal(texts.some((text) => text.includes("INSERT INTO internal.core_storage_versions")), true);
  assert.equal(texts.some((text) => text.includes("UPDATE internal.core_upload_sessions")), true);
  assert.equal(texts.at(-1), "COMMIT");
  assert.equal(client.released, true);
});

test("postgres storage rejects stale release activation before applying storage effects", async () => {
  const client = new FakeStorageClient((text) => {
    if (text.includes("SELECT active_release_id")) {
      return { rows: [{ active_release_id: "rel_live" }], rowCount: 1 };
    }
  });
  const store = storeFor(new FakeStoragePool(client));

  await assert.rejects(
    () => store.activateReleaseWithStorage({
      projectId: PROJECT_ID,
      releaseId: "rel_next",
      digest: "sha256:test",
      release: emptyPortableReleaseState(),
      expectedBaseReleaseId: "rel_previous",
      effects: storageEffects({
        puts: [{
          key: "assets/app.js",
          sha256: SHA_A,
          size_bytes: 12,
          content_type: "text/javascript",
          visibility: "public",
          immutable: true,
        }],
      }),
    }),
    (error) => error instanceof ApplyInvariantError && error.code === "stale_plan",
  );

  const texts = queryTexts(client);
  assert.equal(texts[0], "BEGIN");
  assert.match(texts[1] ?? "", /SELECT active_release_id/);
  assert.equal(texts.at(-1), "ROLLBACK");
  assert.equal(texts.some((text) => text.includes("INSERT INTO internal.core_storage_objects")), false);
  assert.equal(texts.some((text) => text.includes("INSERT INTO internal.core_releases")), false);
  assert.equal(texts.includes("COMMIT"), false);
  assert.equal(client.released, true);
});

test("postgres storage persists function schedule and mutable schedule metadata on activation", async () => {
  const client = new FakeStorageClient((text) => {
    if (text.includes("SELECT active_release_id")) {
      return { rows: [{ active_release_id: null }], rowCount: 1 };
    }
  });
  const store = storeFor(new FakeStoragePool(client));

  await store.activateReleaseWithStorage({
    projectId: PROJECT_ID,
    releaseId: "rel_scheduled",
    digest: "sha256:scheduled",
    release: emptyPortableReleaseState(),
    expectedBaseReleaseId: null,
    functionEffects: functionEffects({
      bundles: [{
        name: "reminder",
        runtime: "node22",
        entrypoint: "default",
        source: { sha256: SHA_A, size: 12, contentType: "application/javascript" },
        bundle_sha256: SHA_A,
        bundle_size_bytes: 12,
        dependency_mode: CORE_FUNCTION_DEPENDENCY_MODE,
        dependency_lock_digest: null,
        deps: [],
        required_secrets: [],
        timeout_ms: 10_000,
        memory_bytes: 128 * 1024 * 1024,
        require_auth: false,
        require_role: null,
        schedule: null,
        schedule_meta: null,
        triggers: [{
          id: "reminder_every_5m",
          type: "schedule",
          cron: "*/5 * * * *",
          timezone: "UTC",
          misfire_policy: "skip",
          overlap_policy: "allow",
          run: { event_type: "reminder.due", payload: {} },
          schedule_meta: {
            last_enqueued_at: null,
            last_run_id: null,
            last_run_status: null,
            run_count: 0,
            last_error: null,
            next_tick_at: "2026-01-01T00:05:00.000Z",
          },
        }],
        class: "standard",
        capabilities: [],
      }],
    }),
  });

  const bundleInsert = client.queries.find((query) => query.text.includes("INSERT INTO internal.core_function_bundles"));
  assert.ok(bundleInsert);
  assert.equal(bundleInsert.values?.[15], null);
  assert.equal(bundleInsert.values?.[16], null);
  assert.equal(bundleInsert.values?.[17], JSON.stringify([{
    id: "reminder_every_5m",
    type: "schedule",
    cron: "*/5 * * * *",
    timezone: "UTC",
    misfire_policy: "skip",
    overlap_policy: "allow",
    run: { event_type: "reminder.due", payload: {} },
    schedule_meta: {
      last_enqueued_at: null,
      last_run_id: null,
      last_run_status: null,
      run_count: 0,
      last_error: null,
      next_tick_at: "2026-01-01T00:05:00.000Z",
    },
  }]));
  assert.equal(client.queries.map((query) => query.text.trim()).at(-1), "COMMIT");
});

test("postgres storage rolls back asset sync-prune drift before deletes or puts", async () => {
  const client = new FakeStorageClient((text) => {
    if (text.includes("SELECT key") && text.includes("FROM internal.core_storage_objects")) {
      return { rows: [{ key: "assets/a.txt" }], rowCount: 1 };
    }
  });
  const store = storeFor(new FakeStoragePool(client));

  await assert.rejects(
    () => store.commitAssetPlan({
      projectId: PROJECT_ID,
      effects: storageEffects({
        puts: [{
          key: "assets/app.js",
          sha256: SHA_A,
          size_bytes: 12,
          content_type: "text/javascript",
          visibility: "public",
          immutable: true,
        }],
        deletes: ["assets/manual-delete.txt"],
        sync_prune: {
          prefix: "assets/",
          base_revision: "stale",
          delete_set_digest: SHA_B,
          planned_delete_keys: ["assets/pruned.txt"],
        },
      }),
    }),
    (error) => error instanceof ApplyInvariantError && error.code === "asset_sync_drift",
  );

  const texts = queryTexts(client);
  assert.equal(texts[0], "BEGIN");
  assert.match(texts[1] ?? "", /SELECT key/);
  assert.equal(texts.at(-1), "ROLLBACK");
  assert.equal(texts.some((text) => text.includes("DELETE FROM internal.core_storage_objects")), false);
  assert.equal(texts.some((text) => text.includes("INSERT INTO internal.core_storage_objects")), false);
  assert.equal(texts.includes("COMMIT"), false);
  assert.equal(client.released, true);
});

test("postgres storage validates secret names before touching the database", async () => {
  const client = new FakeStorageClient();
  const pool = new FakeStoragePool(client);
  const store = storeFor(pool);

  await assert.rejects(
    () => store.setSecret({ projectId: PROJECT_ID, name: "api-key", value: "secret" }),
    (error) => error instanceof StorageValidationError && error.code === "invalid_secret_name",
  );

  assert.deepEqual(pool.queries, []);
  assert.deepEqual(client.queries, []);
});

test("postgres storage decodes function secrets and normalizes log filters", async () => {
  const pool = new FakeStoragePool(new FakeStorageClient(), (text, values) => {
    if (text.includes("FROM internal.core_function_secrets")) {
      assert.deepEqual(values, [PROJECT_ID, ["API_KEY"], "api"]);
      return {
        rows: [secretRow("API_KEY", "local:v1:ZnVuY3Rpb24tc2VjcmV0")],
        rowCount: 1,
      };
    }
    if (text.includes("FROM internal.core_function_logs")) {
      assert.deepEqual(values, [
        PROJECT_ID,
        2,
        "api",
        "req_abcdef",
        "2026-06-25T22:00:00.000Z",
      ]);
      return {
        rows: [{
          timestamp: new Date("2026-06-26T00:00:01.000Z"),
          request_id: "req_abcdef",
          project_id: PROJECT_ID,
          release_id: "rel_live",
          function_name: "api",
          stream: "stdout",
          level: "info",
          message: "hello",
          redacted: false,
        }],
        rowCount: 1,
      };
    }
  });
  const store = storeFor(pool);

  assert.deepEqual(
    await store.getSecretValues({ projectId: PROJECT_ID, functionName: "api", names: ["API_KEY", "API_KEY"] }),
    { API_KEY: "function-secret" },
  );
  assert.deepEqual(
    await store.listLogs({
      projectId: PROJECT_ID,
      functionName: "api",
      requestId: "req_abcdef",
      since: "2026-06-26T00:00:00+02:00",
      tail: 2,
    }),
    [{
      timestamp: "2026-06-26T00:00:01.000Z",
      request_id: "req_abcdef",
      project_id: PROJECT_ID,
      release_id: "rel_live",
      function_name: "api",
      stream: "stdout",
      level: "info",
      message: "hello",
      redacted: false,
    }],
  );
});

function storageEffects(overrides: Partial<CoreStorageApplyEffects> = {}): CoreStorageApplyEffects {
  return {
    puts: [],
    deletes: [],
    sync_prune: null,
    noop: false,
    ...overrides,
  };
}

function functionEffects(overrides: Partial<CoreFunctionApplyEffects> = {}): CoreFunctionApplyEffects {
  return {
    bundles: [],
    dynamic_routes: [],
    astro_ssr_fallback: null,
    required_secrets: [],
    dependency_mode: CORE_FUNCTION_DEPENDENCY_MODE,
    noop: false,
    ...overrides,
  };
}

function uploadSessionRow(overrides: Partial<{
  bytes_written: string | number;
  status: "active" | "uploaded" | "completed" | "aborted";
  immutable: boolean;
  visibility: "public" | "private";
}> = {}) {
  return {
    upload_id: "upl_test",
    project_id: PROJECT_ID,
    key: "assets/app.js",
    declared_size: 12,
    declared_sha256: SHA_A,
    content_type: "text/javascript",
    visibility: overrides.visibility ?? "public",
    immutable: overrides.immutable ?? true,
    status: overrides.status ?? "uploaded",
    bytes_written: overrides.bytes_written ?? 12,
    expires_at: "2999-01-01T00:00:00.000Z",
    completed_at: null,
    aborted_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

function storageObjectRow(overrides: Partial<{
  content_sha256: string;
  immutable: boolean;
  visibility: "public" | "private";
}> = {}) {
  return {
    project_id: PROJECT_ID,
    key: "assets/app.js",
    content_sha256: overrides.content_sha256 ?? SHA_A,
    size_bytes: 12,
    content_type: "text/javascript",
    visibility: overrides.visibility ?? "public",
    immutable: overrides.immutable ?? true,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:01.000Z",
  };
}

function secretRow(name: string, encryptedValueRef: string) {
  return {
    project_id: PROJECT_ID,
    name,
    scope: "function" as const,
    function_name: "api",
    encrypted_value_ref: encryptedValueRef,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:01.000Z",
  };
}
