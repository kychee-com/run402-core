import { randomBytes } from "node:crypto";
import type { Pool as PgPool } from "pg";
import {
  clampSignedReadTtlSeconds,
  createStorageReadSignature,
  encodeStorageKeyPath,
  normalizeSha256Hex,
  normalizeStorageContentType,
  normalizeStorageKey,
  normalizeStoragePrefix,
  normalizeStorageSize,
  normalizeStorageVisibility,
  StorageValidationError,
  verifyStorageReadSignature,
  type CoreImmutableObjectVersion,
  type CoreStorageObject,
  type CoreStorageObjectList,
  type CoreUploadSession,
  type SignedReadPort,
  type StorageObjectVisibility,
  type StoragePort,
} from "@run402/runtime-kernel";

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

export class PostgresStorageStore implements StoragePort, SignedReadPort {
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
      predicates.push(`key >= $${params.length}`);
      const upper = prefixUpperBound(prefix);
      if (upper) {
        params.push(upper);
        predicates.push(`key < $${params.length}`);
      }
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

function prefixUpperBound(prefix: string): string | null {
  if (!prefix) return null;
  const last = prefix.charCodeAt(prefix.length - 1);
  return `${prefix.slice(0, -1)}${String.fromCharCode(last + 1)}`;
}

function versionId(sha256: string): string {
  return `ver_${sha256.slice(0, 24)}`;
}

function randomToken(bytes: number): string {
  return randomBytes(bytes).toString("hex");
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
