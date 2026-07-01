import { randomBytes } from "node:crypto";
import type { Pool as PgPool } from "pg";
import {
  clampSignedReadTtlSeconds,
  computeStorageInventoryRevision,
  createStorageReadSignature,
  encodeStorageKeyPath,
  ApplyInvariantError,
  CORE_FUNCTION_RESOURCE_DEFAULTS,
  normalizeSha256Hex,
  normalizeStorageContentType,
  normalizeStorageKey,
  normalizeStoragePrefix,
  normalizeStorageSize,
  normalizeStorageVisibility,
  StorageValidationError,
  verifyStorageReadSignature,
  type CoreImmutableObjectVersion,
  type CoreFunctionApplyEffects,
  type CoreFunctionBundleMetadata,
  type CoreFunctionInvocationRecord,
  type CoreFunctionLogEntry,
  type CoreFunctionScheduleMetadata,
  type CoreFunctionSecretMetadata,
  type CoreStorageObject,
  type CoreStorageObjectList,
  type CoreUploadSession,
  type CoreStorageApplyEffects,
  type CleanupPort,
  type FunctionLogPort,
  type FunctionSecretPort,
  type SignedReadPort,
  type StorageObjectVisibility,
  type StoragePort,
} from "@run402/runtime-kernel";
import type { PortableReleaseState } from "@run402/release";

export interface PostgresStorageStoreOptions {
  publicBaseUrl: string;
  signedReadSecret: string;
  maxObjectBytes: number;
}

interface UploadSessionRow {
  upload_id: string;
  project_id: string;
  key: string;
  declared_size: string | number;
  declared_sha256: string;
  content_type: string;
  visibility: StorageObjectVisibility;
  immutable: boolean;
  status: CoreUploadSession["status"];
  bytes_written: string | number;
  expires_at: Date | string;
  completed_at: Date | string | null;
  aborted_at: Date | string | null;
  created_at: Date | string;
}

interface StorageObjectRow {
  project_id: string;
  key: string;
  content_sha256: string;
  size_bytes: string | number;
  content_type: string;
  visibility: StorageObjectVisibility;
  immutable: boolean;
  created_at: Date | string;
  updated_at: Date | string;
}

interface StorageVersionRow {
  project_id: string;
  key: string;
  sha256: string;
  version_id: string;
  size_bytes: string | number;
  content_type: string;
  visibility: StorageObjectVisibility;
  public_url_key: string;
  created_at: Date | string;
  retained_until: Date | string | null;
}

interface FunctionBundleRow {
  name: string;
  runtime: "node22";
  entrypoint: string;
  bundle_sha256: string;
  bundle_size_bytes: string | number;
  dependency_mode: CoreFunctionBundleMetadata["dependency_mode"];
  dependency_lock_digest: null;
  deps: [];
  required_secrets: string[];
  require_auth: boolean;
  require_role: CoreFunctionBundleMetadata["require_role"];
  class: CoreFunctionBundleMetadata["class"];
  capabilities: string[];
  schedule: string | null;
  schedule_meta: CoreFunctionScheduleMetadata | null;
  timeout_ms: number;
  memory_bytes: string | number;
}

interface FunctionSecretRow {
  project_id: string;
  name: string;
  scope: "project" | "release" | "function";
  function_name: string;
  encrypted_value_ref: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface FunctionLogRow {
  timestamp: Date | string;
  request_id: string;
  project_id: string;
  release_id: string | null;
  function_name: string;
  stream: "platform" | "stdout" | "stderr";
  level: "debug" | "info" | "warn" | "error";
  message: string;
  redacted: boolean;
}

export class PostgresStorageStore implements StoragePort, SignedReadPort, CleanupPort, FunctionSecretPort, FunctionLogPort {
  readonly #pool: PgPool;
  readonly #publicBaseUrl: string;
  readonly #signedReadSecret: string;
  readonly #maxObjectBytes: number;

  constructor(pool: PgPool, options: PostgresStorageStoreOptions) {
    this.#pool = pool;
    this.#publicBaseUrl = trimTrailingSlash(options.publicBaseUrl);
    this.#signedReadSecret = options.signedReadSecret;
    this.#maxObjectBytes = options.maxObjectBytes;
  }

  async bootstrap(): Promise<void> {
    await this.#pool.query(`
      CREATE TABLE IF NOT EXISTS internal.core_content_objects (
        sha256 text PRIMARY KEY CHECK (sha256 ~ '^[a-f0-9]{64}$'),
        size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
        content_type text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        last_verified_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS internal.core_storage_objects (
        project_id text NOT NULL REFERENCES internal.core_projects(project_id) ON DELETE CASCADE,
        key text NOT NULL,
        content_sha256 text NOT NULL REFERENCES internal.core_content_objects(sha256) ON DELETE RESTRICT,
        size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
        content_type text NOT NULL,
        visibility text NOT NULL CHECK (visibility IN ('public', 'private')),
        immutable boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        deleted_at timestamptz,
        PRIMARY KEY (project_id, key)
      );

      CREATE INDEX IF NOT EXISTS core_storage_objects_project_key_live_idx
        ON internal.core_storage_objects (project_id, key)
        WHERE deleted_at IS NULL;

      CREATE TABLE IF NOT EXISTS internal.core_storage_versions (
        project_id text NOT NULL REFERENCES internal.core_projects(project_id) ON DELETE CASCADE,
        key text NOT NULL,
        sha256 text NOT NULL REFERENCES internal.core_content_objects(sha256) ON DELETE RESTRICT,
        version_id text NOT NULL,
        size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
        content_type text NOT NULL,
        visibility text NOT NULL CHECK (visibility IN ('public', 'private')),
        public_url_key text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        retained_until timestamptz,
        revoked_at timestamptz,
        PRIMARY KEY (project_id, key, sha256)
      );

      CREATE INDEX IF NOT EXISTS core_storage_versions_project_key_idx
        ON internal.core_storage_versions (project_id, key, created_at DESC);

      CREATE TABLE IF NOT EXISTS internal.core_upload_sessions (
        upload_id text PRIMARY KEY,
        project_id text NOT NULL REFERENCES internal.core_projects(project_id) ON DELETE CASCADE,
        key text NOT NULL,
        declared_size bigint NOT NULL CHECK (declared_size > 0),
        declared_sha256 text NOT NULL CHECK (declared_sha256 ~ '^[a-f0-9]{64}$'),
        content_type text NOT NULL,
        visibility text NOT NULL CHECK (visibility IN ('public', 'private')),
        immutable boolean NOT NULL DEFAULT false,
        status text NOT NULL CHECK (status IN ('active', 'uploaded', 'completed', 'aborted')),
        bytes_written bigint NOT NULL DEFAULT 0,
        expires_at timestamptz NOT NULL,
        completed_at timestamptz,
        aborted_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS core_upload_sessions_project_status_idx
        ON internal.core_upload_sessions (project_id, status, expires_at);

      CREATE TABLE IF NOT EXISTS internal.core_cleanup_runs (
        run_id text PRIMARY KEY,
        started_at timestamptz NOT NULL DEFAULT now(),
        finished_at timestamptz,
        removed jsonb NOT NULL DEFAULT '{}'::jsonb
      );
    `);
  }

  async createUploadSession(input: {
    projectId: string;
    key: string;
    sizeBytes: number;
    sha256: string;
    contentType: string;
    visibility: StorageObjectVisibility;
    immutable: boolean;
    ttlSeconds?: number;
  }): Promise<CoreUploadSession> {
    const key = normalizeStorageKey(input.key);
    const sizeBytes = normalizeStorageSize(input.sizeBytes, this.#maxObjectBytes);
    const sha256 = normalizeSha256Hex(input.sha256);
    const contentType = normalizeStorageContentType(input.contentType);
    const visibility = normalizeStorageVisibility(input.visibility);
    const ttlSeconds = clampUploadTtl(input.ttlSeconds);
    const uploadId = `upl_${randomToken(12)}`;
    const result = await this.#pool.query<UploadSessionRow>(
      `
        INSERT INTO internal.core_upload_sessions (
          upload_id, project_id, key, declared_size, declared_sha256,
          content_type, visibility, immutable, status, expires_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', now() + ($9::int * interval '1 second'))
        RETURNING upload_id, project_id, key, declared_size, declared_sha256, content_type,
          visibility, immutable, status, bytes_written, expires_at, completed_at, aborted_at, created_at
      `,
      [
        uploadId,
        input.projectId,
        key,
        sizeBytes,
        sha256,
        contentType,
        visibility,
        input.immutable,
        ttlSeconds,
      ],
    );
    return this.#uploadRow(result.rows[0]);
  }

  async getUploadSession(input: { projectId: string; uploadId: string }): Promise<CoreUploadSession | null> {
    const result = await this.#pool.query<UploadSessionRow>(
      `
        SELECT upload_id, project_id, key, declared_size, declared_sha256, content_type,
          visibility, immutable, status, bytes_written, expires_at, completed_at, aborted_at, created_at
        FROM internal.core_upload_sessions
        WHERE project_id = $1 AND upload_id = $2
      `,
      [input.projectId, input.uploadId],
    );
    return result.rows[0] ? this.#uploadRow(result.rows[0]) : null;
  }

  async markUploadBytesStored(input: {
    projectId: string;
    uploadId: string;
    sizeBytes: number;
  }): Promise<CoreUploadSession> {
    const result = await this.#pool.query<UploadSessionRow>(
      `
        UPDATE internal.core_upload_sessions
        SET bytes_written = $3, status = 'uploaded'
        WHERE project_id = $1
          AND upload_id = $2
          AND status = 'active'
          AND expires_at > now()
        RETURNING upload_id, project_id, key, declared_size, declared_sha256, content_type,
          visibility, immutable, status, bytes_written, expires_at, completed_at, aborted_at, created_at
      `,
      [input.projectId, input.uploadId, input.sizeBytes],
    );
    if (!result.rows[0]) throw new StorageValidationError("upload_not_active", "Upload session is not active.");
    return this.#uploadRow(result.rows[0]);
  }

  async completeUploadSession(input: { projectId: string; uploadId: string }): Promise<CoreStorageObject> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const sessionResult = await client.query<UploadSessionRow>(
        `
          SELECT upload_id, project_id, key, declared_size, declared_sha256, content_type,
            visibility, immutable, status, bytes_written, expires_at, completed_at, aborted_at, created_at
          FROM internal.core_upload_sessions
          WHERE project_id = $1 AND upload_id = $2
          FOR UPDATE
        `,
        [input.projectId, input.uploadId],
      );
      const session = sessionResult.rows[0];
      if (!session) throw new StorageValidationError("upload_not_found", "Upload session was not found.");
      if (session.status === "aborted") throw new StorageValidationError("upload_aborted", "Upload session was aborted.");
      if (session.status === "completed") {
        const existing = await this.getObject({ projectId: input.projectId, key: session.key });
        if (!existing) throw new StorageValidationError("object_not_found", "Completed upload object was not found.");
        await client.query("COMMIT");
        return existing;
      }
      if (new Date(session.expires_at).getTime() <= Date.now()) {
        throw new StorageValidationError("upload_expired", "Upload session has expired.");
      }
      if (Number(session.bytes_written) !== Number(session.declared_size)) {
        throw new StorageValidationError("upload_size_mismatch", "Uploaded byte count does not match declared size.");
      }

      await client.query(
        `
          INSERT INTO internal.core_content_objects (sha256, size_bytes, content_type)
          VALUES ($1, $2, $3)
          ON CONFLICT (sha256) DO UPDATE
          SET size_bytes = EXCLUDED.size_bytes,
              content_type = EXCLUDED.content_type,
              last_verified_at = now()
        `,
        [session.declared_sha256, Number(session.declared_size), session.content_type],
      );

      const objectResult = await client.query<StorageObjectRow>(
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
          RETURNING project_id, key, content_sha256, size_bytes, content_type,
            visibility, immutable, created_at, updated_at
        `,
        [
          session.project_id,
          session.key,
          session.declared_sha256,
          Number(session.declared_size),
          session.content_type,
          session.visibility,
          session.immutable,
        ],
      );

      if (session.immutable) {
        await client.query(
          `
            INSERT INTO internal.core_storage_versions (
              project_id, key, sha256, version_id, size_bytes, content_type, visibility, public_url_key
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (project_id, key, sha256) DO NOTHING
          `,
          [
            session.project_id,
            session.key,
            session.declared_sha256,
            versionId(session.declared_sha256),
            Number(session.declared_size),
            session.content_type,
            session.visibility,
            `${session.declared_sha256}/${session.key}`,
          ],
        );
      }

      await client.query(
        `
          UPDATE internal.core_upload_sessions
          SET status = 'completed', completed_at = now()
          WHERE project_id = $1 AND upload_id = $2
        `,
        [input.projectId, input.uploadId],
      );

      await client.query("COMMIT");
      return this.#objectRow(objectResult.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async abortUploadSession(input: { projectId: string; uploadId: string }): Promise<CoreUploadSession> {
    const result = await this.#pool.query<UploadSessionRow>(
      `
        UPDATE internal.core_upload_sessions
        SET status = 'aborted', aborted_at = COALESCE(aborted_at, now())
        WHERE project_id = $1
          AND upload_id = $2
          AND status IN ('active', 'uploaded')
        RETURNING upload_id, project_id, key, declared_size, declared_sha256, content_type,
          visibility, immutable, status, bytes_written, expires_at, completed_at, aborted_at, created_at
      `,
      [input.projectId, input.uploadId],
    );
    if (!result.rows[0]) throw new StorageValidationError("upload_not_active", "Upload session is not active.");
    return this.#uploadRow(result.rows[0]);
  }

  async getObject(input: { projectId: string; key: string }): Promise<CoreStorageObject | null> {
    const key = normalizeStorageKey(input.key);
    const result = await this.#pool.query<StorageObjectRow>(
      `
        SELECT project_id, key, content_sha256, size_bytes, content_type,
          visibility, immutable, created_at, updated_at
        FROM internal.core_storage_objects
        WHERE project_id = $1 AND key = $2 AND deleted_at IS NULL
      `,
      [input.projectId, key],
    );
    return result.rows[0] ? this.#objectRow(result.rows[0]) : null;
  }

  async listObjects(input: {
    projectId: string;
    prefix?: string;
    limit?: number;
    cursor?: string;
  }): Promise<CoreStorageObjectList> {
    const prefix = normalizeStoragePrefix(input.prefix);
    const cursor = input.cursor ? normalizeStorageKey(input.cursor) : null;
    const limit = clampListLimit(input.limit);
    const params: unknown[] = [input.projectId, limit + 1];
    const predicates = ["project_id = $1", "deleted_at IS NULL"];
    if (prefix) {
      params.push(prefix);
      predicates.push(`starts_with(key, $${params.length})`);
    }
    if (cursor) {
      params.push(cursor);
      predicates.push(`key > $${params.length}`);
    }
    const result = await this.#pool.query<StorageObjectRow>(
      `
        SELECT project_id, key, content_sha256, size_bytes, content_type,
          visibility, immutable, created_at, updated_at
        FROM internal.core_storage_objects
        WHERE ${predicates.join(" AND ")}
        ORDER BY key ASC
        LIMIT $2
      `,
      params,
    );
    const rows = result.rows.slice(0, limit);
    return {
      objects: rows.map((row) => this.#objectRow(row)),
      next_cursor: result.rows.length > limit ? rows.at(-1)?.key ?? null : null,
    };
  }

  async inventoryRevision(input: {
    projectId: string;
    prefix: string;
  }): Promise<{ keys: string[]; revision: string }> {
    const prefix = normalizeStoragePrefix(input.prefix);
    const params: unknown[] = [input.projectId];
    const predicates = ["project_id = $1", "deleted_at IS NULL"];
    if (prefix) {
      params.push(prefix);
      predicates.push(`starts_with(key, $${params.length})`);
    }
    const result = await this.#pool.query<{ key: string }>(
      `
        SELECT key
        FROM internal.core_storage_objects
        WHERE ${predicates.join(" AND ")}
        ORDER BY key ASC
      `,
      params,
    );
    const keys = result.rows.map((row) => row.key);
    return {
      keys,
      revision: computeStorageInventoryRevision(keys),
    };
  }

  async commitAssetPlan(input: {
    projectId: string;
    effects: CoreStorageApplyEffects;
  }): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await this.#applyStorageEffects(client, input.projectId, input.effects);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async activateReleaseWithStorage(input: {
    projectId: string;
    releaseId: string;
    digest: string;
    release: PortableReleaseState;
    expectedBaseReleaseId: string | null;
    effects?: CoreStorageApplyEffects;
    functionEffects?: CoreFunctionApplyEffects;
  }): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const active = await client.query<{ active_release_id: string | null }>(
        "SELECT active_release_id FROM internal.core_projects WHERE project_id = $1 FOR UPDATE",
        [input.projectId],
      );
      if (!active.rows[0]) {
        throw new ApplyInvariantError("project_not_found", `Run402 Core project not found: ${input.projectId}`);
      }
      if (active.rows[0].active_release_id !== input.expectedBaseReleaseId) {
        throw new ApplyInvariantError("stale_plan", "Apply plan base release no longer matches the active release.");
      }
      if (input.effects && !input.effects.noop) {
        await this.#applyStorageEffects(client, input.projectId, input.effects);
      }
      if (input.functionEffects) {
        await this.#replaceFunctionBundles(client, input.projectId, input.releaseId, input.functionEffects);
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
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async #replaceFunctionBundles(
    client: Pick<PgPool, "query">,
    projectId: string,
    releaseId: string,
    effects: CoreFunctionApplyEffects,
  ): Promise<void> {
    await client.query(
      `
        DELETE FROM internal.core_function_bundles
        WHERE project_id = $1 AND release_id = $2
      `,
      [projectId, releaseId],
    );

    for (const bundle of effects.bundles) {
      await client.query(
        `
          INSERT INTO internal.core_function_bundles (
            project_id,
            release_id,
            name,
            runtime,
            entrypoint,
            bundle_sha256,
            bundle_size_bytes,
            dependency_mode,
            dependency_lock_digest,
            deps,
            required_secrets,
            require_auth,
            require_role,
            class,
            capabilities,
            schedule,
            schedule_meta,
            timeout_ms,
            memory_bytes
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13::jsonb, $14, $15::jsonb, $16, $17::jsonb, $18, $19)
          ON CONFLICT (project_id, release_id, name)
          DO UPDATE SET
            runtime = EXCLUDED.runtime,
            entrypoint = EXCLUDED.entrypoint,
            bundle_sha256 = EXCLUDED.bundle_sha256,
            bundle_size_bytes = EXCLUDED.bundle_size_bytes,
            dependency_mode = EXCLUDED.dependency_mode,
            dependency_lock_digest = EXCLUDED.dependency_lock_digest,
            deps = EXCLUDED.deps,
            required_secrets = EXCLUDED.required_secrets,
            require_auth = EXCLUDED.require_auth,
            require_role = EXCLUDED.require_role,
            class = EXCLUDED.class,
            capabilities = EXCLUDED.capabilities,
            schedule = EXCLUDED.schedule,
            schedule_meta = EXCLUDED.schedule_meta,
            timeout_ms = EXCLUDED.timeout_ms,
            memory_bytes = EXCLUDED.memory_bytes
        `,
        [
          projectId,
          releaseId,
          bundle.name,
          bundle.runtime,
          bundle.entrypoint,
          bundle.bundle_sha256,
          bundle.bundle_size_bytes,
          bundle.dependency_mode,
          bundle.dependency_lock_digest,
          JSON.stringify(bundle.deps),
          JSON.stringify(bundle.required_secrets),
          bundle.require_auth,
          bundle.require_role ? JSON.stringify(bundle.require_role) : null,
          bundle.class,
          JSON.stringify(bundle.capabilities),
          bundle.schedule,
          bundle.schedule_meta ? JSON.stringify(bundle.schedule_meta) : null,
          bundle.timeout_ms,
          bundle.memory_bytes,
        ],
      );
    }
  }

  async deleteObject(input: { projectId: string; key: string }): Promise<boolean> {
    const key = normalizeStorageKey(input.key);
    const result = await this.#pool.query(
      `
        DELETE FROM internal.core_storage_objects
        WHERE project_id = $1 AND key = $2
      `,
      [input.projectId, key],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async getImmutableVersion(input: {
    projectId: string;
    key: string;
    sha256: string;
  }): Promise<CoreImmutableObjectVersion | null> {
    const key = normalizeStorageKey(input.key);
    const sha256 = normalizeSha256Hex(input.sha256);
    const result = await this.#pool.query<StorageVersionRow>(
      `
        SELECT project_id, key, sha256, version_id, size_bytes, content_type,
          visibility, public_url_key, created_at, retained_until
        FROM internal.core_storage_versions
        WHERE project_id = $1
          AND key = $2
          AND sha256 = $3
          AND revoked_at IS NULL
          AND (retained_until IS NULL OR retained_until > now())
      `,
      [input.projectId, key, sha256],
    );
    return result.rows[0] ? this.#versionRow(result.rows[0]) : null;
  }

  async getFunctionBundle(input: {
    projectId: string;
    releaseId: string;
    functionName: string;
  }): Promise<CoreFunctionBundleMetadata | null> {
    const result = await this.#pool.query<FunctionBundleRow>(
      `
        SELECT name, runtime, entrypoint, bundle_sha256, bundle_size_bytes,
          dependency_mode, dependency_lock_digest, deps, required_secrets,
          require_auth, require_role, class, capabilities, schedule, schedule_meta, timeout_ms, memory_bytes
        FROM internal.core_function_bundles
        WHERE project_id = $1 AND release_id = $2 AND name = $3
      `,
      [input.projectId, input.releaseId, input.functionName],
    );
    return result.rows[0] ? functionBundleRow(result.rows[0]) : null;
  }

  async setSecret(input: {
    projectId: string;
    name: string;
    value: string;
    scope?: "project" | "release" | "function";
    functionName?: string | null;
  }): Promise<CoreFunctionSecretMetadata> {
    const name = normalizeSecretName(input.name);
    const scope = input.scope ?? "project";
    const functionName = scope === "function" ? normalizeFunctionSecretName(input.functionName) : "";
    const encoded = encodeSecretValue(input.value);
    const result = await this.#pool.query<FunctionSecretRow>(
      `
        INSERT INTO internal.core_function_secrets (
          project_id, name, scope, function_name, encrypted_value_ref
        )
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (project_id, name, scope, function_name)
        DO UPDATE SET encrypted_value_ref = EXCLUDED.encrypted_value_ref, updated_at = now()
        RETURNING project_id, name, scope, function_name, encrypted_value_ref, created_at, updated_at
      `,
      [input.projectId, name, scope, functionName, encoded],
    );
    return secretMetadataRow(result.rows[0]);
  }

  async listSecrets(input: {
    projectId: string;
    functionName?: string;
  }): Promise<CoreFunctionSecretMetadata[]> {
    const functionName = input.functionName ? normalizeFunctionSecretName(input.functionName) : null;
    const result = await this.#pool.query<FunctionSecretRow>(
      `
        SELECT project_id, name, scope, function_name, encrypted_value_ref, created_at, updated_at
        FROM internal.core_function_secrets
        WHERE project_id = $1
          AND ($2::text IS NULL OR function_name = '' OR function_name = $2)
        ORDER BY name ASC, scope ASC, function_name ASC
      `,
      [input.projectId, functionName],
    );
    return result.rows.map(secretMetadataRow);
  }

  async getSecretValues(input: {
    projectId: string;
    functionName: string;
    names: string[];
  }): Promise<Record<string, string>> {
    const names = [...new Set(input.names.map(normalizeSecretName))].sort();
    if (names.length === 0) return {};
    const functionName = normalizeFunctionSecretName(input.functionName);
    const result = await this.#pool.query<FunctionSecretRow>(
      `
        SELECT DISTINCT ON (name)
          project_id, name, scope, function_name, encrypted_value_ref, created_at, updated_at
        FROM internal.core_function_secrets
        WHERE project_id = $1
          AND name = ANY($2::text[])
          AND (function_name = '' OR function_name = $3)
        ORDER BY name ASC, CASE WHEN function_name = $3 THEN 0 ELSE 1 END, updated_at DESC
      `,
      [input.projectId, names, functionName],
    );
    const out: Record<string, string> = {};
    for (const row of result.rows) {
      if (row.encrypted_value_ref) out[row.name] = decodeSecretValue(row.encrypted_value_ref);
    }
    return out;
  }

  async recordInvocation(input: {
    invocation: CoreFunctionInvocationRecord;
    logs: CoreFunctionLogEntry[];
    retention?: {
      maxAgeMs?: number;
      maxBytes?: number;
    };
  }): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `
          INSERT INTO internal.core_function_invocations (
            request_id,
            project_id,
            release_id,
            function_name,
            invocation_kind,
            status,
            started_at,
            finished_at,
            duration_ms,
            error_code
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, $9, $10)
          ON CONFLICT (request_id)
          DO UPDATE SET
            status = EXCLUDED.status,
            finished_at = EXCLUDED.finished_at,
            duration_ms = EXCLUDED.duration_ms,
            error_code = EXCLUDED.error_code
        `,
        [
          input.invocation.request_id,
          input.invocation.project_id,
          input.invocation.release_id,
          input.invocation.function_name,
          input.invocation.invocation_kind,
          input.invocation.status,
          input.invocation.started_at,
          input.invocation.finished_at,
          input.invocation.duration_ms,
          input.invocation.error_code,
        ],
      );

      for (const log of input.logs) {
        await client.query(
          `
            INSERT INTO internal.core_function_logs (
              timestamp,
              request_id,
              project_id,
              release_id,
              function_name,
              stream,
              level,
              message,
              redacted
            )
            VALUES ($1::timestamptz, $2, $3, $4, $5, $6, $7, $8, $9)
          `,
          [
            log.timestamp,
            log.request_id,
            log.project_id,
            log.release_id,
            log.function_name,
            log.stream,
            log.level,
            log.message,
            log.redacted,
          ],
        );
      }

      await this.#pruneFunctionLogs(client, input.invocation.project_id, input.retention);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async listLogs(input: {
    projectId: string;
    functionName?: string;
    requestId?: string;
    since?: string;
    tail?: number;
  }): Promise<CoreFunctionLogEntry[]> {
    const limit = clampLogTail(input.tail);
    const predicates = ["project_id = $1"];
    const params: unknown[] = [input.projectId, limit];
    if (input.functionName) {
      params.push(normalizeFunctionName(input.functionName, "Function name is invalid."));
      predicates.push(`function_name = $${params.length}`);
    }
    if (input.requestId) {
      params.push(normalizeRequestId(input.requestId));
      predicates.push(`request_id = $${params.length}`);
    }
    if (input.since) {
      params.push(normalizeIsoInstant(input.since, "since"));
      predicates.push(`timestamp >= $${params.length}::timestamptz`);
    }
    const result = await this.#pool.query<FunctionLogRow>(
      `
        WITH selected AS (
          SELECT timestamp, request_id, project_id, release_id, function_name,
            stream, level, message, redacted, id
          FROM internal.core_function_logs
          WHERE ${predicates.join(" AND ")}
          ORDER BY timestamp DESC, id DESC
          LIMIT $2
        )
        SELECT timestamp, request_id, project_id, release_id, function_name,
          stream, level, message, redacted
        FROM selected
        ORDER BY timestamp ASC, id ASC
      `,
      params,
    );
    return result.rows.map(functionLogRow);
  }

  async #pruneFunctionLogs(
    client: Pick<PgPool, "query">,
    projectId: string,
    retention: { maxAgeMs?: number; maxBytes?: number } | undefined,
  ): Promise<void> {
    const maxAgeMs = clampRetentionMs(retention?.maxAgeMs);
    const maxBytes = clampRetentionBytes(retention?.maxBytes);
    await client.query(
      `
        DELETE FROM internal.core_function_logs
        WHERE project_id = $1
          AND timestamp < now() - ($2::bigint * interval '1 millisecond')
      `,
      [projectId, maxAgeMs],
    );
    await client.query(
      `
        WITH ranked AS (
          SELECT id,
            SUM(octet_length(message)) OVER (ORDER BY timestamp DESC, id DESC) AS bytes_from_newest
          FROM internal.core_function_logs
          WHERE project_id = $1
        )
        DELETE FROM internal.core_function_logs logs
        USING ranked
        WHERE logs.id = ranked.id
          AND ranked.bytes_from_newest > $2
      `,
      [projectId, maxBytes],
    );
  }

  async #applyStorageEffects(
    client: Pick<PgPool, "query">,
    projectId: string,
    effects: CoreStorageApplyEffects,
  ): Promise<void> {
    if (effects.sync_prune) {
      const current = await this.#inventoryRevisionWithClient(client, projectId, effects.sync_prune.prefix);
      if (current.revision !== effects.sync_prune.base_revision) {
        throw new ApplyInvariantError("asset_sync_drift", "Storage inventory changed after the apply plan was created.");
      }
    }

    const putKeys = new Set(effects.puts.map((put) => put.key));
    const deleteKeys = new Set([
      ...effects.deletes,
      ...(effects.sync_prune?.planned_delete_keys ?? []),
    ]);
    for (const key of putKeys) deleteKeys.delete(key);
    for (const key of deleteKeys) {
      await client.query(
        `
          DELETE FROM internal.core_storage_objects
          WHERE project_id = $1 AND key = $2
        `,
        [projectId, key],
      );
    }

    for (const put of effects.puts) {
      await client.query(
        `
          INSERT INTO internal.core_content_objects (sha256, size_bytes, content_type)
          VALUES ($1, $2, $3)
          ON CONFLICT (sha256) DO UPDATE
          SET size_bytes = EXCLUDED.size_bytes,
              content_type = EXCLUDED.content_type,
              last_verified_at = now()
        `,
        [put.sha256, put.size_bytes, put.content_type],
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
        [projectId, put.key, put.sha256, put.size_bytes, put.content_type, put.visibility, put.immutable],
      );
      if (put.immutable) {
        await client.query(
          `
            INSERT INTO internal.core_storage_versions (
              project_id, key, sha256, version_id, size_bytes, content_type, visibility, public_url_key
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (project_id, key, sha256) DO NOTHING
          `,
          [projectId, put.key, put.sha256, versionId(put.sha256), put.size_bytes, put.content_type, put.visibility, `${put.sha256}/${put.key}`],
        );
      }
    }
  }

  async #inventoryRevisionWithClient(
    client: Pick<PgPool, "query">,
    projectId: string,
    prefix: string,
  ): Promise<{ keys: string[]; revision: string }> {
    const normalizedPrefix = normalizeStoragePrefix(prefix);
    const params: unknown[] = [projectId];
    const predicates = ["project_id = $1", "deleted_at IS NULL"];
    if (normalizedPrefix) {
      params.push(normalizedPrefix);
      predicates.push(`starts_with(key, $${params.length})`);
    }
    const result = await client.query<{ key: string }>(
      `
        SELECT key
        FROM internal.core_storage_objects
        WHERE ${predicates.join(" AND ")}
        ORDER BY key ASC
      `,
      params,
    );
    const keys = result.rows.map((row) => row.key);
    return { keys, revision: computeStorageInventoryRevision(keys) };
  }

  async signRead(input: {
    projectId: string;
    key: string;
    ttlSeconds?: number;
    sha256?: string | null;
  }): Promise<{ expires_at: string; signed_url: string }> {
    const key = normalizeStorageKey(input.key);
    const ttl = clampSignedReadTtlSeconds(input.ttlSeconds);
    const expiresAtEpochSeconds = Math.floor(Date.now() / 1000) + ttl;
    const signature = createStorageReadSignature({
      secret: this.#signedReadSecret,
      projectId: input.projectId,
      key,
      expiresAtEpochSeconds,
      sha256: input.sha256 ?? null,
    });
    const params = new URLSearchParams({
      expires: String(expiresAtEpochSeconds),
      signature,
    });
    if (input.sha256) params.set("sha256", input.sha256);
    return {
      expires_at: new Date(expiresAtEpochSeconds * 1000).toISOString(),
      signed_url: `${this.#publicBaseUrl}/projects/v1/${input.projectId}/storage/signed/${encodeStorageKeyPath(key)}?${params}`,
    };
  }

  async verifyRead(input: {
    projectId: string;
    key: string;
    expiresAtEpochSeconds: number;
    signature: string;
    sha256?: string | null;
  }): Promise<boolean> {
    return verifyStorageReadSignature({
      secret: this.#signedReadSecret,
      projectId: input.projectId,
      key: normalizeStorageKey(input.key),
      expiresAtEpochSeconds: input.expiresAtEpochSeconds,
      signature: input.signature,
      sha256: input.sha256 ?? null,
    });
  }

  async sweep(projectId?: string): Promise<{
    removed_uploads: number;
    removed_objects: number;
    removed_versions: number;
    removed_cas_objects: number;
    removed_function_logs: number;
    retained_live_sha256: string[];
  }> {
    const projectPredicate = projectId ? "AND project_id = $1" : "";
    const params = projectId ? [projectId] : [];
    const expiredUploads = await this.#pool.query(
      `
        DELETE FROM internal.core_upload_sessions
        WHERE status IN ('active', 'uploaded')
          AND expires_at <= now()
          ${projectPredicate}
      `,
      params,
    );
    const expiredVersions = await this.#pool.query(
      `
        DELETE FROM internal.core_storage_versions
        WHERE retained_until IS NOT NULL
          AND retained_until <= now()
          ${projectPredicate}
      `,
      params,
    );
    const expiredFunctionLogs = await this.#pool.query(
      `
        DELETE FROM internal.core_function_logs
        WHERE timestamp < now() - ($${params.length + 1}::bigint * interval '1 millisecond')
          ${projectPredicate}
      `,
      [...params, CORE_FUNCTION_RESOURCE_DEFAULTS.localLogRetentionMs],
    );
    const live = await this.#pool.query<{ sha256: string }>(
      `
        SELECT DISTINCT sha256
        FROM (
          SELECT content_sha256 AS sha256
            FROM internal.core_storage_objects
           WHERE deleted_at IS NULL
             ${projectPredicate}
          UNION
          SELECT sha256
            FROM internal.core_storage_versions
           WHERE revoked_at IS NULL
             AND (retained_until IS NULL OR retained_until > now())
             ${projectPredicate}
          UNION
          SELECT declared_sha256 AS sha256
            FROM internal.core_upload_sessions
           WHERE status IN ('active', 'uploaded')
             AND expires_at > now()
             ${projectPredicate}
          UNION
          SELECT path.value->>'content_sha256' AS sha256
            FROM internal.core_projects p
            JOIN internal.core_releases r
              ON r.project_id = p.project_id
             AND r.release_id = p.active_release_id
            CROSS JOIN LATERAL jsonb_array_elements(COALESCE(r.state->'site'->'paths', '[]'::jsonb)) AS path(value)
           WHERE path.value ? 'content_sha256'
             ${projectId ? "AND p.project_id = $1" : ""}
          UNION
          SELECT bundle.bundle_sha256 AS sha256
            FROM internal.core_projects p
            JOIN internal.core_function_bundles bundle
              ON bundle.project_id = p.project_id
             AND bundle.release_id = p.active_release_id
           WHERE bundle.bundle_sha256 IS NOT NULL
             ${projectId ? "AND p.project_id = $1" : ""}
          UNION
          SELECT bundle.value->'source'->>'sha256' AS sha256
            FROM internal.core_apply_plans plan
            CROSS JOIN LATERAL jsonb_array_elements(COALESCE(plan.function_effects->'bundles', '[]'::jsonb)) AS bundle(value)
           WHERE plan.status = 'planned'
             ${projectId ? "AND plan.project_id = $1" : ""}
          UNION
          SELECT put.value->>'sha256' AS sha256
            FROM internal.core_apply_plans plan
            CROSS JOIN LATERAL jsonb_array_elements(COALESCE(plan.storage_effects->'puts', '[]'::jsonb)) AS put(value)
           WHERE plan.status = 'planned'
             ${projectId ? "AND plan.project_id = $1" : ""}
        ) live_refs
        WHERE sha256 IS NOT NULL
        ORDER BY sha256
      `,
      params,
    );
    return {
      removed_uploads: expiredUploads.rowCount ?? 0,
      removed_objects: 0,
      removed_versions: expiredVersions.rowCount ?? 0,
      removed_cas_objects: 0,
      removed_function_logs: expiredFunctionLogs.rowCount ?? 0,
      retained_live_sha256: live.rows.map((row) => row.sha256),
    };
  }

  #uploadRow(row: UploadSessionRow): CoreUploadSession {
    return {
      upload_id: row.upload_id,
      project_id: row.project_id,
      key: row.key,
      declared_size: Number(row.declared_size),
      declared_sha256: row.declared_sha256,
      content_type: row.content_type,
      visibility: row.visibility,
      immutable: row.immutable,
      status: row.status,
      upload_url: `${this.#publicBaseUrl}/projects/v1/${row.project_id}/storage/uploads/${row.upload_id}/bytes`,
      bytes_written: Number(row.bytes_written),
      expires_at: iso(row.expires_at),
      completed_at: isoOrNull(row.completed_at),
      aborted_at: isoOrNull(row.aborted_at),
      created_at: iso(row.created_at),
    };
  }

  #objectRow(row: StorageObjectRow): CoreStorageObject {
    const keyPath = encodeStorageKeyPath(row.key);
    const base = `${this.#publicBaseUrl}/projects/v1/${row.project_id}/storage`;
    const object: CoreStorageObject = {
      project_id: row.project_id,
      key: row.key,
      sha256: row.content_sha256,
      size_bytes: Number(row.size_bytes),
      content_type: row.content_type,
      visibility: row.visibility,
      immutable: row.immutable,
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at),
    };
    if (row.visibility === "public") {
      object.public_url = `${base}/public/${keyPath}`;
      if (row.immutable) {
        object.immutable_url = `${base}/immutable/${row.content_sha256}/${keyPath}`;
      }
    }
    return object;
  }

  #versionRow(row: StorageVersionRow): CoreImmutableObjectVersion {
    const version: CoreImmutableObjectVersion = {
      project_id: row.project_id,
      key: row.key,
      sha256: row.sha256,
      version_id: row.version_id,
      size_bytes: Number(row.size_bytes),
      content_type: row.content_type,
      visibility: row.visibility,
      public_url_key: row.public_url_key,
      created_at: iso(row.created_at),
      retained_until: isoOrNull(row.retained_until),
    };
    if (row.visibility === "public") {
      version.public_url = `${this.#publicBaseUrl}/projects/v1/${row.project_id}/storage/immutable/${row.sha256}/${encodeStorageKeyPath(row.key)}`;
    }
    return version;
  }
}

function clampUploadTtl(value: number | undefined): number {
  if (value === undefined) return 24 * 60 * 60;
  if (!Number.isFinite(value) || value < 60) return 24 * 60 * 60;
  return Math.min(Math.floor(value), 7 * 24 * 60 * 60);
}

function clampListLimit(value: number | undefined): number {
  if (value === undefined) return 100;
  if (!Number.isFinite(value) || value < 1) return 100;
  return Math.min(Math.floor(value), 500);
}

function versionId(sha256: string): string {
  return `ver_${sha256.slice(0, 24)}`;
}

function randomToken(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function functionBundleRow(row: FunctionBundleRow): CoreFunctionBundleMetadata {
  return {
    name: row.name,
    runtime: row.runtime,
    entrypoint: row.entrypoint,
    source: {
      sha256: row.bundle_sha256,
      size: Number(row.bundle_size_bytes),
      contentType: "application/javascript",
    },
    bundle_sha256: row.bundle_sha256,
    bundle_size_bytes: Number(row.bundle_size_bytes),
    dependency_mode: row.dependency_mode,
    dependency_lock_digest: row.dependency_lock_digest,
    deps: row.deps,
    required_secrets: row.required_secrets,
    require_auth: row.require_auth,
    require_role: row.require_role,
    schedule: row.schedule,
    schedule_meta: row.schedule_meta,
    class: row.class,
    capabilities: row.capabilities,
    timeout_ms: row.timeout_ms,
    memory_bytes: Number(row.memory_bytes),
  };
}

function secretMetadataRow(row: FunctionSecretRow): CoreFunctionSecretMetadata {
  return {
    project_id: row.project_id,
    name: row.name,
    scope: row.scope,
    function_name: row.function_name || null,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

function normalizeSecretName(name: string): string {
  if (!/^[A-Z_][A-Z0-9_]{0,127}$/.test(name)) {
    throw new StorageValidationError("invalid_secret_name", "Secret name must match [A-Z_][A-Z0-9_]{0,127}.");
  }
  return name;
}

function normalizeFunctionSecretName(name: string | null | undefined): string {
  return normalizeFunctionName(name, "Function-scoped secrets require a valid function name.");
}

function normalizeFunctionName(name: string | null | undefined, message: string): string {
  if (!name || !/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
    throw new StorageValidationError("invalid_function_name", message);
  }
  return name;
}

function normalizeRequestId(requestId: string): string {
  if (!/^(?:req|fnrun|fnatt)_[A-Za-z0-9_-]{4,128}$/.test(requestId)) {
    throw new StorageValidationError("invalid_request_id", "Function log request_id is invalid.");
  }
  return requestId;
}

function normalizeIsoInstant(value: string, name: string): string {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) {
    throw new StorageValidationError("invalid_timestamp", `${name} must be an ISO-8601 timestamp.`);
  }
  return new Date(millis).toISOString();
}

function clampLogTail(value: number | undefined): number {
  if (value === undefined) return 100;
  if (!Number.isFinite(value) || value < 1) return 100;
  return Math.min(Math.floor(value), 1000);
}

function clampRetentionMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 60_000) {
    return CORE_FUNCTION_RESOURCE_DEFAULTS.localLogRetentionMs;
  }
  return Math.min(Math.floor(value), 7 * 24 * 60 * 60 * 1000);
}

function clampRetentionBytes(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 1024) {
    return CORE_FUNCTION_RESOURCE_DEFAULTS.localLogRetentionBytes;
  }
  return Math.min(Math.floor(value), 1024 * 1024 * 1024);
}

function functionLogRow(row: FunctionLogRow): CoreFunctionLogEntry {
  return {
    timestamp: iso(row.timestamp),
    request_id: row.request_id,
    project_id: row.project_id,
    release_id: row.release_id,
    function_name: row.function_name,
    stream: row.stream,
    level: row.level,
    message: row.message,
    redacted: row.redacted,
  };
}

function encodeSecretValue(value: string): string {
  return `local:v1:${Buffer.from(value, "utf8").toString("base64url")}`;
}

function decodeSecretValue(value: string): string {
  if (!value.startsWith("local:v1:")) return "";
  return Buffer.from(value.slice("local:v1:".length), "base64url").toString("utf8");
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isoOrNull(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}
