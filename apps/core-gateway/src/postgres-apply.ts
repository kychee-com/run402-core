import { randomBytes } from "node:crypto";
import pg, { type Pool as PgPool, type PoolClient } from "pg";
import {
  ApplyInvariantError,
  emptyCoreReleaseState,
  type ApplyPlanStorePort,
  type CoreApplyPlan,
  type MigrationPort,
  type ReleaseStatePort,
  type StoredCoreApplyPlan,
} from "@run402/runtime-kernel";
import type { PortableReleaseState } from "@run402/release";

const { Pool } = pg;

export function createPostgresPool(databaseUrl: string): PgPool {
  return new Pool({ connectionString: databaseUrl });
}

interface ReleaseRow {
  release_id: string;
  state: PortableReleaseState;
}

interface ActiveReleaseRow {
  active_release_id: string | null;
}

interface PlanRow {
  plan_id: string;
  project_id: string;
  spec: unknown;
  release_spec_digest: string;
  base_release_id: string | null;
  target_release_id: string;
  target_release_digest: string;
  target_release: PortableReleaseState;
  storage_effects: StoredCoreApplyPlan["storage_effects"] | null;
  function_effects: StoredCoreApplyPlan["function_effects"] | null;
  noop: boolean;
  status: "planned" | "committed";
  created_at: Date;
}

export class PostgresApplyStore implements ReleaseStatePort, ApplyPlanStorePort, MigrationPort {
  readonly #pool: PgPool;

  constructor(pool: PgPool) {
    this.#pool = pool;
  }

  async bootstrap(): Promise<void> {
    await this.#pool.query(`
      CREATE SCHEMA IF NOT EXISTS internal;
      CREATE SCHEMA IF NOT EXISTS auth;
      GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;

      CREATE OR REPLACE FUNCTION auth.jwt_claim(name text)
      RETURNS text AS $$
        SELECT COALESCE(
          NULLIF(current_setting('request.jwt.claim.' || name, true), ''),
          NULLIF(NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> name, '')
        );
      $$ LANGUAGE sql STABLE;

      CREATE OR REPLACE FUNCTION auth.uid()
      RETURNS text AS $$
        SELECT auth.jwt_claim('sub');
      $$ LANGUAGE sql STABLE;

      CREATE OR REPLACE FUNCTION auth.role()
      RETURNS text AS $$
        SELECT auth.jwt_claim('role');
      $$ LANGUAGE sql STABLE;

      CREATE OR REPLACE FUNCTION auth.project_id()
      RETURNS text AS $$
        SELECT auth.jwt_claim('project_id');
      $$ LANGUAGE sql STABLE;

      CREATE SCHEMA IF NOT EXISTS postgrest;
      GRANT USAGE ON SCHEMA postgrest TO authenticator;

      CREATE OR REPLACE FUNCTION postgrest.pre_config()
      RETURNS void AS $$
        SELECT
          set_config(
            'pgrst.db_schemas',
            COALESCE('public,' || string_agg(nspname, ',' ORDER BY nspname), 'public'),
            true
          )
        FROM pg_namespace
        WHERE nspname LIKE 'project_%';
      $$ LANGUAGE sql;

      CREATE TABLE IF NOT EXISTS internal.core_releases (
        project_id text NOT NULL REFERENCES internal.core_projects(project_id) ON DELETE CASCADE,
        release_id text NOT NULL,
        digest text NOT NULL,
        state jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (project_id, release_id)
      );

      CREATE TABLE IF NOT EXISTS internal.core_apply_plans (
        plan_id text PRIMARY KEY,
        project_id text NOT NULL REFERENCES internal.core_projects(project_id) ON DELETE CASCADE,
        spec jsonb NOT NULL,
        release_spec_digest text NOT NULL,
        base_release_id text,
        target_release_id text NOT NULL,
        target_release_digest text NOT NULL,
        target_release jsonb NOT NULL,
        storage_effects jsonb,
        function_effects jsonb,
        noop boolean NOT NULL,
        status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'committed')),
        created_at timestamptz NOT NULL DEFAULT now(),
        committed_at timestamptz
      );

      ALTER TABLE internal.core_apply_plans
        ADD COLUMN IF NOT EXISTS storage_effects jsonb;

      ALTER TABLE internal.core_apply_plans
        ADD COLUMN IF NOT EXISTS function_effects jsonb;

      CREATE TABLE IF NOT EXISTS internal.core_function_bundles (
        project_id text NOT NULL REFERENCES internal.core_projects(project_id) ON DELETE CASCADE,
        release_id text NOT NULL,
        name text NOT NULL,
        runtime text NOT NULL,
        entrypoint text NOT NULL,
        bundle_sha256 text NOT NULL,
        bundle_size_bytes bigint NOT NULL,
        dependency_mode text NOT NULL,
        dependency_lock_digest text,
        deps jsonb NOT NULL DEFAULT '[]'::jsonb,
        required_secrets jsonb NOT NULL DEFAULT '[]'::jsonb,
        require_auth boolean NOT NULL DEFAULT false,
        require_role jsonb,
        class text NOT NULL DEFAULT 'standard',
        capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
        timeout_ms integer NOT NULL,
        memory_bytes bigint NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (project_id, release_id, name)
      );

      CREATE TABLE IF NOT EXISTS internal.core_function_secrets (
        project_id text NOT NULL REFERENCES internal.core_projects(project_id) ON DELETE CASCADE,
        name text NOT NULL,
        scope text NOT NULL CHECK (scope IN ('project', 'release', 'function')),
        function_name text NOT NULL DEFAULT '',
        encrypted_value_ref text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (project_id, name, scope, function_name)
      );

      CREATE TABLE IF NOT EXISTS internal.core_function_invocations (
        request_id text PRIMARY KEY,
        project_id text NOT NULL REFERENCES internal.core_projects(project_id) ON DELETE CASCADE,
        release_id text,
        function_name text NOT NULL,
        invocation_kind text NOT NULL CHECK (invocation_kind IN ('routed_http', 'direct')),
        status text NOT NULL,
        started_at timestamptz NOT NULL DEFAULT now(),
        finished_at timestamptz,
        duration_ms integer,
        error_code text
      );

      CREATE TABLE IF NOT EXISTS internal.core_function_logs (
        id bigserial PRIMARY KEY,
        timestamp timestamptz NOT NULL DEFAULT now(),
        request_id text NOT NULL,
        project_id text NOT NULL REFERENCES internal.core_projects(project_id) ON DELETE CASCADE,
        release_id text,
        function_name text NOT NULL,
        stream text NOT NULL CHECK (stream IN ('platform', 'stdout', 'stderr')),
        level text NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
        message text NOT NULL,
        redacted boolean NOT NULL DEFAULT false
      );

      CREATE INDEX IF NOT EXISTS core_function_logs_project_request_idx
        ON internal.core_function_logs(project_id, request_id, timestamp);

      CREATE INDEX IF NOT EXISTS core_function_logs_project_timestamp_idx
        ON internal.core_function_logs(project_id, timestamp, id);

      CREATE TABLE IF NOT EXISTS internal.core_applied_migrations (
        project_id text NOT NULL REFERENCES internal.core_projects(project_id) ON DELETE CASCADE,
        migration_id text NOT NULL,
        checksum_hex text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (project_id, migration_id)
      );
    `);
  }

  async getBase(projectId: string, target: "empty" | "current" | { release_id: string }): Promise<{
    release_id: string | null;
    state: PortableReleaseState;
  }> {
    if (target === "empty") {
      return { release_id: null, state: emptyCoreReleaseState() };
    }

    const releaseId = typeof target === "string"
      ? await this.#activeReleaseId(projectId)
      : target.release_id;
    if (!releaseId) {
      return { release_id: null, state: emptyCoreReleaseState() };
    }

    const release = await this.#pool.query<ReleaseRow>(
      `
        SELECT release_id, state
        FROM internal.core_releases
        WHERE project_id = $1 AND release_id = $2
      `,
      [projectId, releaseId],
    );
    if (!release.rows[0]) {
      throw new ApplyInvariantError("release_not_found", `Release ${releaseId} was not found for project ${projectId}.`);
    }
    return {
      release_id: release.rows[0].release_id,
      state: release.rows[0].state,
    };
  }

  async setActiveRelease(input: {
    projectId: string;
    releaseId: string;
    digest: string;
    release: PortableReleaseState;
    expectedBaseReleaseId: string | null;
  }): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const active = await client.query<ActiveReleaseRow>(
        "SELECT active_release_id FROM internal.core_projects WHERE project_id = $1 FOR UPDATE",
        [input.projectId],
      );
      if (!active.rows[0]) {
        throw new ApplyInvariantError("project_not_found", `Run402 Core project not found: ${input.projectId}`);
      }
      if (active.rows[0].active_release_id !== input.expectedBaseReleaseId) {
        throw new ApplyInvariantError("stale_plan", "Apply plan base release no longer matches the active release.");
      }

      await client.query(
        `
          INSERT INTO internal.core_releases (project_id, release_id, digest, state)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (project_id, release_id)
          DO UPDATE SET digest = EXCLUDED.digest, state = EXCLUDED.state
        `,
        [input.projectId, input.releaseId, input.digest, input.release],
      );
      await client.query(
        `
          UPDATE internal.core_projects
          SET active_release_id = $2, updated_at = now()
          WHERE project_id = $1
        `,
        [input.projectId, input.releaseId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async create(input: Omit<StoredCoreApplyPlan, "plan_id" | "created_at" | "status">): Promise<StoredCoreApplyPlan> {
    const result = await this.#pool.query<PlanRow>(
      `
        INSERT INTO internal.core_apply_plans (
          plan_id,
          project_id,
          spec,
          release_spec_digest,
          base_release_id,
          target_release_id,
          target_release_digest,
          target_release,
          storage_effects,
          function_effects,
          noop
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING plan_id, project_id, spec, release_spec_digest, base_release_id,
          target_release_id, target_release_digest, target_release, storage_effects, function_effects, noop, status, created_at
      `,
      [
        `plan_${randomToken(12)}`,
        input.project_id,
        input.spec,
        input.release_spec_digest,
        input.base_release_id,
        input.target_release_id,
        input.target_release_digest,
        input.target_release,
        input.storage_effects ?? null,
        input.function_effects ?? null,
        input.noop,
      ],
    );
    return rowToPlan(result.rows[0]);
  }

  async get(planId: string): Promise<StoredCoreApplyPlan | null> {
    const result = await this.#pool.query<PlanRow>(
      `
        SELECT plan_id, project_id, spec, release_spec_digest, base_release_id,
          target_release_id, target_release_digest, target_release, storage_effects, function_effects, noop, status, created_at
        FROM internal.core_apply_plans
        WHERE plan_id = $1
      `,
      [planId],
    );
    return result.rows[0] ? rowToPlan(result.rows[0]) : null;
  }

  async markCommitted(planId: string): Promise<void> {
    await this.#pool.query(
      `
        UPDATE internal.core_apply_plans
        SET status = 'committed', committed_at = now()
        WHERE plan_id = $1
      `,
      [planId],
    );
  }

  async check(projectId: string, migrationId: string): Promise<
    | { state: "absent" }
    | { state: "present"; checksum_hex: string }
  > {
    const result = await this.#pool.query<{ checksum_hex: string }>(
      `
        SELECT checksum_hex
        FROM internal.core_applied_migrations
        WHERE project_id = $1 AND migration_id = $2
      `,
      [projectId, migrationId],
    );
    return result.rows[0]
      ? { state: "present", checksum_hex: result.rows[0].checksum_hex }
      : { state: "absent" };
  }

  async applyInline(input: {
    projectId: string;
    schema: string;
    migrationId: string;
    checksum_hex: string;
    sql: string;
    transaction: "default" | "none";
  }): Promise<void> {
    const client = await this.#pool.connect();
    try {
      if (input.transaction === "none") {
        await client.query(`SET search_path TO ${quoteIdentifier(input.schema)}, public`);
        await client.query(input.sql);
        await grantProjectSchemaAccess(client, input.schema);
        await reloadPostgrest(client);
        await client.query(
          `
            INSERT INTO internal.core_applied_migrations (project_id, migration_id, checksum_hex)
            VALUES ($1, $2, $3)
            ON CONFLICT (project_id, migration_id) DO NOTHING
          `,
          [input.projectId, input.migrationId, input.checksum_hex],
        );
        return;
      }

      await client.query("BEGIN");
      await client.query(`SET LOCAL search_path TO ${quoteIdentifier(input.schema)}, public`);
      await client.query(input.sql);
      await grantProjectSchemaAccess(client, input.schema);
      await reloadPostgrest(client);
      await client.query(
        `
          INSERT INTO internal.core_applied_migrations (project_id, migration_id, checksum_hex)
          VALUES ($1, $2, $3)
          ON CONFLICT (project_id, migration_id) DO NOTHING
        `,
        [input.projectId, input.migrationId, input.checksum_hex],
      );
      await client.query("COMMIT");
    } catch (error) {
      if (input.transaction === "default") await rollbackQuietly(client);
      throw error;
    } finally {
      await client.query("RESET search_path").catch(() => undefined);
      client.release();
    }
  }

  async #activeReleaseId(projectId: string): Promise<string | null> {
    const result = await this.#pool.query<ActiveReleaseRow>(
      "SELECT active_release_id FROM internal.core_projects WHERE project_id = $1",
      [projectId],
    );
    if (!result.rows[0]) {
      throw new ApplyInvariantError("project_not_found", `Run402 Core project not found: ${projectId}`);
    }
    return result.rows[0].active_release_id;
  }
}

function rowToPlan(row: PlanRow): StoredCoreApplyPlan {
  const publicFields: CoreApplyPlan = {
    plan_id: row.plan_id,
    project_id: row.project_id,
    release_spec_digest: row.release_spec_digest,
    base_release_id: row.base_release_id,
    target_release_id: row.target_release_id,
    target_release_digest: row.target_release_digest,
    ...(row.storage_effects ? { storage_effects: row.storage_effects } : {}),
    ...(row.function_effects ? { function_effects: row.function_effects } : {}),
    noop: row.noop,
    status: row.status,
    created_at: row.created_at.toISOString(),
  };
  return {
    ...publicFields,
    spec: row.spec,
    target_release: row.target_release,
  };
}

async function grantProjectSchemaAccess(client: PoolClient, schemaSlot: string): Promise<void> {
  const schema = quoteIdentifier(schemaSlot);
  await client.query(`GRANT USAGE ON SCHEMA ${schema} TO anon, authenticated, service_role`);
  await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO anon`);
  await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO authenticated, service_role`);
  await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO authenticated, service_role`);
}

async function reloadPostgrest(client: PoolClient): Promise<void> {
  await client.query("NOTIFY pgrst, 'reload config'");
  await client.query("NOTIFY pgrst, 'reload schema'");
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) {
    throw new Error(`Unsafe SQL identifier: ${value}`);
  }
  return `"${value.replaceAll('"', '""')}"`;
}

function randomToken(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original query error.
  }
}
