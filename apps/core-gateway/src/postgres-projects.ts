import { randomBytes } from "node:crypto";
import pg, { type Pool as PgPool, type PoolClient, type QueryResult } from "pg";
import {
  runtimeCapabilities,
  type CoreProject,
  type ProjectCatalogPort,
  type RuntimeCapabilityDocument,
} from "@run402/runtime-kernel";

const { Pool } = pg;

export interface PostgresProjectCatalogOptions {
  databaseUrl: string;
  publicBaseUrl: string;
  postgrestPublicUrl: string;
  capabilities?: RuntimeCapabilityDocument;
}

interface ProjectRow {
  project_id: string;
  name: string;
  schema_slot: string;
  public_id: string;
  anon_key: string;
  service_key: string;
  active_release_id: string | null;
}

export function createPostgresPool(databaseUrl: string): PgPool {
  return new Pool({ connectionString: databaseUrl });
}

export class PostgresProjectCatalog implements ProjectCatalogPort {
  readonly #pool: PgPool;
  readonly #publicBaseUrl: string;
  readonly #postgrestPublicUrl: string;
  readonly #capabilities: RuntimeCapabilityDocument;

  constructor(pool: PgPool, options: Omit<PostgresProjectCatalogOptions, "databaseUrl">) {
    this.#pool = pool;
    this.#publicBaseUrl = trimTrailingSlash(options.publicBaseUrl);
    this.#postgrestPublicUrl = trimTrailingSlash(options.postgrestPublicUrl);
    this.#capabilities = options.capabilities ?? runtimeCapabilities();
  }

  async bootstrap(): Promise<void> {
    await this.#pool.query(`
      CREATE SCHEMA IF NOT EXISTS internal;

      CREATE TABLE IF NOT EXISTS internal.core_projects (
        project_id text PRIMARY KEY,
        name text NOT NULL,
        schema_slot text NOT NULL UNIQUE,
        public_id text NOT NULL UNIQUE,
        anon_key text NOT NULL,
        service_key text NOT NULL,
        active_release_id text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS core_projects_created_at_idx
        ON internal.core_projects (created_at);

      CREATE UNIQUE INDEX IF NOT EXISTS core_projects_anon_key_idx
        ON internal.core_projects (anon_key);

      CREATE UNIQUE INDEX IF NOT EXISTS core_projects_service_key_idx
        ON internal.core_projects (service_key);
    `);
  }

  async create(input: { name: string }): Promise<CoreProject> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const projectId = createProjectId();
      const row: ProjectRow = {
        project_id: projectId,
        name: input.name,
        schema_slot: `project_${projectId.slice("prj_".length)}`,
        public_id: `local_${randomToken(10)}`,
        anon_key: `r402_anon_${randomToken(24)}`,
        service_key: `r402_service_${randomToken(24)}`,
        active_release_id: null,
      };

      const client = await this.#pool.connect();
      try {
        await client.query("BEGIN");
        await createProjectSchema(client, row.schema_slot);
        const insert = await client.query<ProjectRow>(
          `
            INSERT INTO internal.core_projects (
              project_id,
              name,
              schema_slot,
              public_id,
              anon_key,
              service_key,
              active_release_id
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT DO NOTHING
            RETURNING project_id, name, schema_slot, public_id, anon_key, service_key, active_release_id
          `,
          [
            row.project_id,
            row.name,
            row.schema_slot,
            row.public_id,
            row.anon_key,
            row.service_key,
            row.active_release_id,
          ],
        );

        if (insert.rowCount === 0) {
          await client.query("ROLLBACK");
          continue;
        }

        await client.query("COMMIT");
        return this.#toCoreProject(insert.rows[0]);
      } catch (error) {
        await rollbackQuietly(client);
        throw error;
      } finally {
        client.release();
      }
    }

    throw new Error("Could not allocate a unique local Run402 Core project id.");
  }

  async inspect(projectId: string): Promise<CoreProject | null> {
    const result = await this.#pool.query<ProjectRow>(
      `
        SELECT project_id, name, schema_slot, public_id, anon_key, service_key, active_release_id
        FROM internal.core_projects
        WHERE project_id = $1
      `,
      [projectId],
    );

    return result.rows[0] ? this.#toCoreProject(result.rows[0]) : null;
  }

  async inspectByKey(key: string): Promise<CoreProject | null> {
    const result = await this.#pool.query<ProjectRow>(
      `
        SELECT project_id, name, schema_slot, public_id, anon_key, service_key, active_release_id
        FROM internal.core_projects
        WHERE anon_key = $1 OR service_key = $1
        LIMIT 1
      `,
      [key],
    );

    return result.rows[0] ? this.#toCoreProject(result.rows[0]) : null;
  }

  #toCoreProject(row: ProjectRow): CoreProject {
    return {
      project_id: row.project_id,
      schema_slot: row.schema_slot,
      public_id: row.public_id,
      anon_key: row.anon_key,
      service_key: row.service_key,
      endpoints: {
        rest_url: `${this.#postgrestPublicUrl}`,
        static_base_url: `${this.#publicBaseUrl}/projects/v1/${row.project_id}/static`,
        storage_base_url: `${this.#publicBaseUrl}/projects/v1/${row.project_id}/storage`,
      },
      active_release_id: row.active_release_id,
      capabilities: this.#capabilities,
    };
  }
}

export interface ProjectSqlResult {
  status: "ok";
  schema: string;
  rows: Record<string, unknown>[];
  row_count: number;
  fields: Array<{ name: string; type: string }>;
}

export class PostgresProjectSql {
  readonly #pool: PgPool;

  constructor(pool: PgPool) {
    this.#pool = pool;
  }

  async execute(input: {
    project: CoreProject;
    sql: string;
    params?: unknown[];
  }): Promise<ProjectSqlResult> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL search_path TO ${quoteIdentifier(input.project.schema_slot)}, public, auth`);
      await client.query(
        "SELECT set_config('request.jwt.claims', $1, true)",
        [JSON.stringify({
          project_id: input.project.project_id,
          role: "service_role",
          sub: "service",
          iss: "run402-core",
        })],
      );
      const result = input.params && input.params.length > 0
        ? await client.query(input.sql, input.params)
        : await client.query(input.sql);
      await client.query("COMMIT");
      const normalized = normalizeQueryResult(result);
      return {
        status: "ok",
        schema: input.project.schema_slot,
        rows: normalized.last.rows as Record<string, unknown>[],
        row_count: normalized.rowCount,
        fields: normalized.last.fields.map((field) => ({
          name: field.name,
          type: pgTypeName(field.dataTypeID),
        })),
      };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }
}

function normalizeQueryResult(result: QueryResult | QueryResult[]): {
  last: QueryResult;
  rowCount: number;
} {
  if (Array.isArray(result)) {
    const last = result[result.length - 1] ?? { rows: [], rowCount: 0, fields: [] };
    return {
      last,
      rowCount: result.reduce((sum, item) => sum + (item.rowCount ?? 0), 0),
    };
  }
  return {
    last: result,
    rowCount: result.rowCount ?? 0,
  };
}

function pgTypeName(typeOid: number): string {
  const names: Record<number, string> = {
    16: "bool",
    20: "int8",
    21: "int2",
    23: "int4",
    25: "text",
    700: "float4",
    701: "float8",
    1043: "varchar",
    1082: "date",
    1114: "timestamp",
    1184: "timestamptz",
    1700: "numeric",
    2950: "uuid",
    3802: "jsonb",
    1009: "text[]",
  };
  return names[typeOid] ?? `oid:${typeOid}`;
}

async function createProjectSchema(client: PoolClient, schemaSlot: string): Promise<void> {
  const schema = quoteIdentifier(schemaSlot);
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  await client.query(`GRANT USAGE ON SCHEMA ${schema} TO anon, authenticated, service_role`);
  await client.query("NOTIFY pgrst, 'reload config'");
  await client.query("NOTIFY pgrst, 'reload schema'");
}

function createProjectId(): string {
  return `prj_${randomToken(8)}`;
}

function randomToken(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) {
    throw new Error(`Unsafe SQL identifier: ${value}`);
  }
  return `"${value.replaceAll('"', '""')}"`;
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original query error.
  }
}
