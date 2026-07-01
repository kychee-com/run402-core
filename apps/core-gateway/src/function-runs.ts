import { createHash, randomUUID } from "node:crypto";
import type { Pool as PgPool } from "pg";

export type CoreFunctionRunStatus =
  | "scheduled"
  | "queued"
  | "running"
  | "retrying"
  | "blocked"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired";

export interface CoreFunctionRunCreateInput {
  event_type: string;
  payload?: Record<string, unknown>;
  idempotency_key?: string;
  run_at?: string;
  delay_seconds?: number;
  expires_at?: string;
  retry?: Record<string, unknown>;
}

export interface CoreFunctionRunCreateOptions {
  idempotencyKeyHeader?: string | string[];
  source?: Record<string, unknown>;
}

export interface CoreFunctionRunListOptions {
  status?: CoreFunctionRunStatus;
  eventType?: string;
  since?: string;
  until?: string;
  limit?: number;
  cursor?: string;
}

export interface CoreFunctionRunPublicResponse {
  run_id: string;
  function_name: string;
  event_type: string;
  status: CoreFunctionRunStatus;
  terminal: boolean;
  generation: number;
  run_at: string;
  expires_at?: string;
  source: Record<string, unknown>;
  attempts: {
    current: number;
    max: number;
    total: number;
    next_attempt_at?: string;
  };
  last_attempt?: {
    attempt_id: string;
    number: number;
    started_at?: string;
    completed_at?: string;
    duration_ms?: number;
    response_status?: number;
    error?: CoreFunctionRunErrorInfo;
  };
  last_error?: CoreFunctionRunErrorInfo;
  created_at: string;
  updated_at: string;
  completed_at?: string;
  deduplicated?: boolean;
  next_actions: Array<Record<string, unknown>>;
}

export interface CoreFunctionRunErrorInfo {
  code: string;
  message: string;
  retryable: boolean;
}

export interface CoreFunctionRunRow {
  id: string;
  project_id: string;
  function_name: string;
  event_type: string;
  idempotency_key: string;
  submitted_intent_sha256?: Buffer | Uint8Array | string | null;
  payload?: Record<string, unknown> | null;
  source?: Record<string, unknown> | null;
  retry_policy?: Record<string, unknown> | null;
  status: CoreFunctionRunStatus;
  generation: number | string;
  run_at: Date | string;
  expires_at?: Date | string | null;
  next_attempt_at?: Date | string | null;
  current_generation_attempts?: number | string | null;
  max_attempts?: number | string | null;
  total_attempts?: number | string | null;
  lease_token?: string | null;
  lease_expires_at?: Date | string | null;
  locked_at?: Date | string | null;
  last_attempt_id?: string | null;
  last_attempt_number?: number | string | null;
  last_attempt_started_at?: Date | string | null;
  last_attempt_completed_at?: Date | string | null;
  last_attempt_duration_ms?: number | string | null;
  last_attempt_response_status?: number | string | null;
  last_attempt_error?: unknown;
  last_status?: number | string | null;
  last_error?: unknown;
  release_id?: string | null;
  completed_at?: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface CoreFunctionRunClaim {
  run: CoreFunctionRunRow;
  attemptId: string;
  attemptNumber: number;
  leaseToken: string;
  startedAt: Date;
}

export interface CoreFunctionRunCreateResult {
  httpStatus: 200 | 202;
  run: CoreFunctionRunPublicResponse;
}

export interface CoreFunctionRunListResult {
  runs: CoreFunctionRunPublicResponse[];
  next_cursor?: string;
}

export interface CoreFunctionRunStorePort {
  createRun(input: {
    projectId: string;
    functionName: string;
    body: CoreFunctionRunCreateInput;
    idempotencyKeyHeader?: string | string[];
    source?: Record<string, unknown>;
  }): Promise<CoreFunctionRunCreateResult>;
  listRuns(input: {
    projectId: string;
    functionName: string;
    options?: CoreFunctionRunListOptions;
  }): Promise<CoreFunctionRunListResult>;
  getRun(input: {
    projectId: string;
    runId: string;
  }): Promise<CoreFunctionRunPublicResponse>;
  cancelRun(input: {
    projectId: string;
    runId: string;
    now?: Date;
  }): Promise<CoreFunctionRunPublicResponse>;
  redriveRun(input: {
    projectId: string;
    runId: string;
    retry?: Record<string, unknown>;
    now?: Date;
  }): Promise<CoreFunctionRunPublicResponse>;
  claimDueRun(input: {
    now: Date;
    leaseMs: number;
  }): Promise<CoreFunctionRunClaim | null>;
  completeRun(input: {
    claim: CoreFunctionRunClaim;
    outcome: CoreFunctionRunWorkerResult;
    now: Date;
  }): Promise<CoreFunctionRunPublicResponse>;
  blockRun(input: {
    claim: CoreFunctionRunClaim;
    error: CoreFunctionRunErrorInfo;
    now: Date;
  }): Promise<CoreFunctionRunPublicResponse>;
}

export interface CoreFunctionRunWorkerResult {
  statusCode: number;
  error?: CoreFunctionRunErrorInfo | null;
}

export interface CoreFunctionRunInvokerPort {
  invokeFunctionRun(claim: CoreFunctionRunClaim): Promise<CoreFunctionRunWorkerResult>;
}

export interface CoreFunctionRunProcessOptions {
  now?: Date;
  leaseMs?: number;
}

export interface CoreFunctionRunWorkerOptions extends CoreFunctionRunProcessOptions {
  intervalMs?: number;
  concurrency?: number;
}

export class CoreFunctionRunError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CoreFunctionRunError";
  }
}

export class CoreFunctionRunWorker {
  readonly #store: CoreFunctionRunStorePort;
  readonly #invoker: CoreFunctionRunInvokerPort;
  readonly #intervalMs: number;
  readonly #concurrency: number;
  readonly #leaseMs: number;
  #timer: NodeJS.Timeout | null = null;
  #active = 0;
  #started = false;

  constructor(input: {
    store: CoreFunctionRunStorePort;
    invoker: CoreFunctionRunInvokerPort;
    options?: CoreFunctionRunWorkerOptions;
  }) {
    this.#store = input.store;
    this.#invoker = input.invoker;
    this.#intervalMs = input.options?.intervalMs ?? 1_000;
    this.#concurrency = input.options?.concurrency ?? 1;
    this.#leaseMs = input.options?.leaseMs ?? 60_000;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#schedule(0);
  }

  stop(): void {
    this.#started = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  get started(): boolean {
    return this.#started;
  }

  async drainOnce(now = new Date()): Promise<CoreFunctionRunPublicResponse[]> {
    const results: CoreFunctionRunPublicResponse[] = [];
    while (results.length < this.#concurrency) {
      const result = await processCoreFunctionRunOnce({
        store: this.#store,
        invoker: this.#invoker,
      }, { now, leaseMs: this.#leaseMs });
      if (!result) break;
      results.push(result);
    }
    return results;
  }

  #schedule(delayMs: number): void {
    if (!this.#started) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (!this.#started || this.#active > 0) {
        this.#schedule(this.#intervalMs);
        return;
      }
      this.#active += 1;
      this.drainOnce()
        .catch((error: unknown) => {
          console.error("Run402 Core function run worker tick failed:", error);
        })
        .finally(() => {
          this.#active -= 1;
          this.#schedule(this.#intervalMs);
        });
    }, delayMs);
  }
}

export async function processCoreFunctionRunOnce(
  input: {
    store: CoreFunctionRunStorePort;
    invoker: CoreFunctionRunInvokerPort;
  },
  options: CoreFunctionRunProcessOptions = {},
): Promise<CoreFunctionRunPublicResponse | null> {
  const now = options.now ?? new Date();
  const claim = await input.store.claimDueRun({
    now,
    leaseMs: options.leaseMs ?? 60_000,
  });
  if (!claim) return null;

  try {
    const result = await input.invoker.invokeFunctionRun(claim);
    return await input.store.completeRun({
      claim,
      outcome: result,
      now: new Date(),
    });
  } catch (error) {
    const statusCode = typeof (error as { statusCode?: unknown }).statusCode === "number"
      ? Number((error as { statusCode: number }).statusCode)
      : 500;
    return await input.store.completeRun({
      claim,
      outcome: {
        statusCode,
        error: boundedError("FUNCTION_RUN_PLATFORM_ERROR", error instanceof Error ? error.message : String(error), true),
      },
      now: new Date(),
    });
  }
}

export function serializeCoreFunctionRun(row: CoreFunctionRunRow, deduplicated = false): CoreFunctionRunPublicResponse {
  const lastAttemptError = normalizeError(row.last_attempt_error);
  return {
    run_id: row.id,
    function_name: row.function_name,
    event_type: row.event_type,
    status: row.status,
    terminal: TERMINAL_STATUSES.has(row.status),
    generation: asNumber(row.generation, 1),
    run_at: toIso(row.run_at) ?? new Date(0).toISOString(),
    expires_at: toIso(row.expires_at),
    source: row.source ?? { type: "api" },
    attempts: {
      current: asNumber(row.current_generation_attempts),
      max: asNumber(row.max_attempts, 5),
      total: asNumber(row.total_attempts),
      next_attempt_at: toIso(row.next_attempt_at),
    },
    last_attempt: row.last_attempt_id
      ? {
          attempt_id: row.last_attempt_id,
          number: asNumber(row.last_attempt_number, 1),
          started_at: toIso(row.last_attempt_started_at),
          completed_at: toIso(row.last_attempt_completed_at),
          duration_ms: row.last_attempt_duration_ms == null ? undefined : asNumber(row.last_attempt_duration_ms),
          response_status: row.last_attempt_response_status == null ? undefined : asNumber(row.last_attempt_response_status),
          error: lastAttemptError,
        }
      : undefined,
    last_error: normalizeError(row.last_error),
    created_at: toIso(row.created_at) ?? new Date(0).toISOString(),
    updated_at: toIso(row.updated_at) ?? new Date(0).toISOString(),
    completed_at: toIso(row.completed_at),
    deduplicated: deduplicated || undefined,
    next_actions: nextActionsFor(row),
  };
}

export function coreFunctionRunEnvelope(claim: CoreFunctionRunClaim): Record<string, unknown> {
  return {
    trigger: "function_run",
    run_id: claim.run.id,
    generation: asNumber(claim.run.generation, 1),
    event_type: claim.run.event_type,
    idempotency_key: claim.run.idempotency_key,
    run_at: toIso(claim.run.run_at),
    attempt: {
      attempt_id: claim.attemptId,
      number: claim.attemptNumber,
      max: asNumber(claim.run.max_attempts, 5),
    },
    source: claim.run.source ?? { type: "api" },
    payload: claim.run.payload ?? {},
  };
}

export class PostgresCoreFunctionRunStore implements CoreFunctionRunStorePort {
  readonly #pool: PgPool;

  constructor(pool: PgPool) {
    this.#pool = pool;
  }

  async bootstrap(): Promise<void> {
    await this.#pool.query(`
      CREATE TABLE IF NOT EXISTS internal.core_function_runs (
        id text PRIMARY KEY,
        project_id text NOT NULL REFERENCES internal.core_projects(project_id) ON DELETE CASCADE,
        function_name text NOT NULL,
        event_type text NOT NULL,
        idempotency_key text NOT NULL,
        submitted_intent_sha256 bytea NOT NULL,
        payload jsonb NOT NULL DEFAULT '{}'::jsonb,
        source jsonb NOT NULL DEFAULT '{"type":"api"}'::jsonb,
        retry_policy jsonb NOT NULL DEFAULT '{"preset":"standard","max_attempts":5}'::jsonb,
        status text NOT NULL
          CHECK (status IN ('scheduled', 'queued', 'running', 'retrying', 'blocked', 'succeeded', 'failed', 'cancelled', 'expired')),
        generation integer NOT NULL DEFAULT 1 CHECK (generation >= 1),
        run_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz,
        next_attempt_at timestamptz,
        current_generation_attempts integer NOT NULL DEFAULT 0 CHECK (current_generation_attempts >= 0),
        max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
        total_attempts integer NOT NULL DEFAULT 0 CHECK (total_attempts >= 0),
        lease_token text,
        lease_expires_at timestamptz,
        locked_at timestamptz,
        last_attempt_id text,
        last_attempt_number integer,
        last_attempt_started_at timestamptz,
        last_attempt_completed_at timestamptz,
        last_attempt_duration_ms integer CHECK (last_attempt_duration_ms IS NULL OR last_attempt_duration_ms >= 0),
        last_attempt_response_status integer
          CHECK (last_attempt_response_status IS NULL OR last_attempt_response_status BETWEEN 100 AND 599),
        last_attempt_error jsonb,
        last_status integer CHECK (last_status IS NULL OR last_status BETWEEN 100 AND 599),
        last_error jsonb,
        release_id text,
        cancel_requested_at timestamptz,
        completed_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT core_function_runs_expiry_after_run_at
          CHECK (expires_at IS NULL OR expires_at > run_at),
        CONSTRAINT core_function_runs_completed_at_terminal
          CHECK (
            (status IN ('succeeded', 'failed', 'cancelled', 'expired') AND completed_at IS NOT NULL)
            OR (status NOT IN ('succeeded', 'failed', 'cancelled', 'expired'))
          )
      );

      CREATE UNIQUE INDEX IF NOT EXISTS core_function_runs_idempotency
        ON internal.core_function_runs (project_id, function_name, idempotency_key);

      CREATE INDEX IF NOT EXISTS core_function_runs_due
        ON internal.core_function_runs (next_attempt_at, run_at, created_at)
        WHERE status IN ('scheduled', 'queued', 'retrying');

      CREATE INDEX IF NOT EXISTS core_function_runs_project_function_created
        ON internal.core_function_runs (project_id, function_name, created_at DESC);

      CREATE INDEX IF NOT EXISTS core_function_runs_lease_expiry
        ON internal.core_function_runs (lease_expires_at)
        WHERE status = 'running' AND lease_expires_at IS NOT NULL;

      CREATE TABLE IF NOT EXISTS internal.core_function_run_attempts (
        id text PRIMARY KEY,
        run_id text NOT NULL REFERENCES internal.core_function_runs(id) ON DELETE CASCADE,
        project_id text NOT NULL,
        function_name text NOT NULL,
        generation integer NOT NULL CHECK (generation >= 1),
        attempt_number integer NOT NULL CHECK (attempt_number >= 1),
        lease_token text NOT NULL,
        status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled', 'expired')),
        started_at timestamptz NOT NULL DEFAULT now(),
        completed_at timestamptz,
        duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
        response_status integer CHECK (response_status IS NULL OR response_status BETWEEN 100 AND 599),
        error jsonb,
        retryable boolean,
        request_id text,
        release_id text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(run_id, generation, attempt_number)
      );

      CREATE INDEX IF NOT EXISTS core_function_run_attempts_run_started
        ON internal.core_function_run_attempts (run_id, started_at DESC);
    `);
  }

  async createRun(input: {
    projectId: string;
    functionName: string;
    body: CoreFunctionRunCreateInput;
    idempotencyKeyHeader?: string | string[];
    source?: Record<string, unknown>;
  }): Promise<CoreFunctionRunCreateResult> {
    const normalized = normalizeCreateInput(input.body, {
      idempotencyKeyHeader: input.idempotencyKeyHeader,
      source: input.source,
    });
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query<CoreFunctionRunRow>(
        `
          SELECT *
          FROM internal.core_function_runs
          WHERE project_id = $1 AND function_name = $2 AND idempotency_key = $3
          FOR UPDATE
        `,
        [input.projectId, input.functionName, normalized.idempotencyKey],
      );
      if (existing.rows[0]) {
        const digest = digestFromRow(existing.rows[0].submitted_intent_sha256);
        if (!digest || !digest.equals(normalized.submittedIntentDigest)) {
          throw new CoreFunctionRunError("function_run_idempotency_conflict", 409, "idempotency_key already belongs to a different function run", {
            next_actions: [{ type: "get", href: `/functions/v1/runs/${existing.rows[0].id}` }],
          });
        }
        await client.query("COMMIT");
        return { httpStatus: 200, run: serializeCoreFunctionRun(existing.rows[0], true) };
      }

      const inserted = await client.query<CoreFunctionRunRow>(
        `
          INSERT INTO internal.core_function_runs (
            id, project_id, function_name, event_type, idempotency_key,
            submitted_intent_sha256, payload, source, retry_policy, status,
            generation, run_at, expires_at, next_attempt_at, max_attempts
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, 1, $11, $12, $11, $13)
          RETURNING *
        `,
        [
          newId("fnrun"),
          input.projectId,
          input.functionName,
          normalized.eventType,
          normalized.idempotencyKey,
          normalized.submittedIntentDigest,
          JSON.stringify(normalized.payload),
          JSON.stringify(normalized.source),
          JSON.stringify(normalized.retry),
          normalized.status,
          normalized.runAt,
          normalized.expiresAt,
          normalized.maxAttempts,
        ],
      );
      await client.query("COMMIT");
      return { httpStatus: 202, run: serializeCoreFunctionRun(inserted.rows[0]) };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async listRuns(input: {
    projectId: string;
    functionName: string;
    options?: CoreFunctionRunListOptions;
  }): Promise<CoreFunctionRunListResult> {
    const options = input.options ?? {};
    if (options.status && !FUNCTION_RUN_STATUSES.has(options.status)) {
      throw new CoreFunctionRunError("invalid_function_run_request", 400, "status is invalid", { field: "status" });
    }
    const limit = Math.max(1, Math.min(Math.floor(options.limit ?? 20), 100));
    const params: unknown[] = [input.projectId, input.functionName];
    const clauses = ["project_id = $1", "function_name = $2"];
    if (options.status) {
      params.push(options.status);
      clauses.push(`status = $${params.length}`);
    }
    if (options.eventType) {
      params.push(options.eventType);
      clauses.push(`event_type = $${params.length}`);
    }
    if (options.since) {
      params.push(parseDate(options.since, "since"));
      clauses.push(`created_at >= $${params.length}`);
    }
    if (options.until) {
      params.push(parseDate(options.until, "until"));
      clauses.push(`created_at < $${params.length}`);
    }
    if (options.cursor) {
      const cursor = decodeCursor(options.cursor);
      params.push(cursor.createdAt, cursor.id);
      const createdParam = params.length - 1;
      const idParam = params.length;
      clauses.push(`(created_at < $${createdParam} OR (created_at = $${createdParam} AND id < $${idParam}))`);
    }
    params.push(limit + 1);
    const result = await this.#pool.query<CoreFunctionRunRow>(
      `
        SELECT *
        FROM internal.core_function_runs
        WHERE ${clauses.join(" AND ")}
        ORDER BY created_at DESC, id DESC
        LIMIT $${params.length}
      `,
      params,
    );
    const visible = result.rows.slice(0, limit);
    const nextRow = result.rows.length > limit ? visible[visible.length - 1] : undefined;
    return {
      runs: visible.map((row) => serializeCoreFunctionRun(row)),
      ...(nextRow ? { next_cursor: encodeCursor(nextRow) } : {}),
    };
  }

  async getRun(input: { projectId: string; runId: string }): Promise<CoreFunctionRunPublicResponse> {
    return serializeCoreFunctionRun(await this.#getRunRow(input.projectId, input.runId));
  }

  async cancelRun(input: { projectId: string; runId: string; now?: Date }): Promise<CoreFunctionRunPublicResponse> {
    const now = input.now ?? new Date();
    const result = await this.#pool.query<CoreFunctionRunRow>(
      `
        UPDATE internal.core_function_runs
        SET status = 'cancelled',
            cancel_requested_at = $3,
            completed_at = $3,
            updated_at = $3,
            lease_token = NULL,
            lease_expires_at = NULL,
            locked_at = NULL,
            last_error = jsonb_build_object(
              'code', 'FUNCTION_RUN_CANCELLED',
              'message', 'Function run was cancelled.',
              'retryable', false
            )
        WHERE project_id = $1
          AND id = $2
          AND status IN ('scheduled', 'queued', 'running', 'retrying', 'blocked')
        RETURNING *
      `,
      [input.projectId, input.runId, now],
    );
    return serializeCoreFunctionRun(result.rows[0] ?? await this.#getRunRow(input.projectId, input.runId));
  }

  async redriveRun(input: {
    projectId: string;
    runId: string;
    retry?: Record<string, unknown>;
    now?: Date;
  }): Promise<CoreFunctionRunPublicResponse> {
    const now = input.now ?? new Date();
    const retry = input.retry ? normalizeRetry(input.retry) : null;
    const result = await this.#pool.query<CoreFunctionRunRow>(
      `
        UPDATE internal.core_function_runs
        SET status = 'queued',
            generation = generation + 1,
            run_at = $3,
            next_attempt_at = $3,
            expires_at = NULL,
            current_generation_attempts = 0,
            max_attempts = COALESCE($4, max_attempts),
            retry_policy = COALESCE($5::jsonb, retry_policy),
            lease_token = NULL,
            lease_expires_at = NULL,
            locked_at = NULL,
            last_error = NULL,
            last_attempt_error = NULL,
            completed_at = NULL,
            updated_at = $3
        WHERE project_id = $1
          AND id = $2
          AND status IN ('failed', 'cancelled', 'expired')
        RETURNING *
      `,
      [
        input.projectId,
        input.runId,
        now,
        retry?.maxAttempts ?? null,
        retry ? JSON.stringify(retry.retry) : null,
      ],
    );
    return serializeCoreFunctionRun(result.rows[0] ?? await this.#getRunRow(input.projectId, input.runId));
  }

  async claimDueRun(input: { now: Date; leaseMs: number }): Promise<CoreFunctionRunClaim | null> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await expireStaleRuns(client, input.now);
      await recoverStaleLeases(client, input.now);
      const due = await client.query<CoreFunctionRunRow>(
        `
          SELECT *
          FROM internal.core_function_runs
          WHERE status IN ('scheduled', 'queued', 'retrying')
            AND run_at <= $1
            AND (next_attempt_at IS NULL OR next_attempt_at <= $1)
            AND (expires_at IS NULL OR expires_at > $1)
          ORDER BY COALESCE(next_attempt_at, run_at), created_at
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        `,
        [input.now],
      );
      const row = due.rows[0];
      if (!row) {
        await client.query("COMMIT");
        return null;
      }
      const attemptId = newId("fnatt");
      const leaseToken = randomUUID();
      const attemptNumber = asNumber(row.current_generation_attempts) + 1;
      const leaseExpiresAt = new Date(input.now.getTime() + input.leaseMs);
      await client.query(
        `
          INSERT INTO internal.core_function_run_attempts (
            id, run_id, project_id, function_name, generation, attempt_number,
            lease_token, status, started_at, request_id, release_id
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, 'running', $8, $2, $9)
        `,
        [
          attemptId,
          row.id,
          row.project_id,
          row.function_name,
          asNumber(row.generation, 1),
          attemptNumber,
          leaseToken,
          input.now,
          row.release_id ?? null,
        ],
      );
      const running = await client.query<CoreFunctionRunRow>(
        `
          UPDATE internal.core_function_runs
          SET status = 'running',
              lease_token = $2,
              last_attempt_id = $3,
              lease_expires_at = $4,
              locked_at = $5,
              current_generation_attempts = current_generation_attempts + 1,
              total_attempts = total_attempts + 1,
              last_attempt_number = $6,
              last_attempt_started_at = $5,
              last_attempt_completed_at = NULL,
              last_attempt_duration_ms = NULL,
              last_attempt_response_status = NULL,
              last_attempt_error = NULL,
              updated_at = $5
          WHERE id = $1
          RETURNING *
        `,
        [row.id, leaseToken, attemptId, leaseExpiresAt, input.now, attemptNumber],
      );
      await client.query("COMMIT");
      return {
        run: running.rows[0] ?? row,
        attemptId,
        attemptNumber,
        leaseToken,
        startedAt: input.now,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async completeRun(input: {
    claim: CoreFunctionRunClaim;
    outcome: CoreFunctionRunWorkerResult;
    now: Date;
  }): Promise<CoreFunctionRunPublicResponse> {
    return await finalizeAttempt(this.#pool, input.claim, input.outcome, input.now);
  }

  async blockRun(input: {
    claim: CoreFunctionRunClaim;
    error: CoreFunctionRunErrorInfo;
    now: Date;
  }): Promise<CoreFunctionRunPublicResponse> {
    await markAttemptComplete(this.#pool, input.claim, "failed", input.now, null, input.error);
    const result = await this.#pool.query<CoreFunctionRunRow>(
      `
        UPDATE internal.core_function_runs
        SET status = 'blocked',
            lease_token = NULL,
            lease_expires_at = NULL,
            locked_at = NULL,
            last_attempt_completed_at = $4,
            last_attempt_duration_ms = $5,
            last_attempt_error = $6::jsonb,
            last_error = $6::jsonb,
            updated_at = $4
        WHERE id = $1 AND last_attempt_id = $2 AND lease_token = $3
        RETURNING *
      `,
      [
        input.claim.run.id,
        input.claim.attemptId,
        input.claim.leaseToken,
        input.now,
        Math.max(0, input.now.getTime() - input.claim.startedAt.getTime()),
        JSON.stringify(input.error),
      ],
    );
    return serializeCoreFunctionRun(result.rows[0] ?? { ...input.claim.run, status: "blocked", last_error: input.error, updated_at: input.now });
  }

  async #getRunRow(projectId: string, runId: string): Promise<CoreFunctionRunRow> {
    const result = await this.#pool.query<CoreFunctionRunRow>(
      "SELECT * FROM internal.core_function_runs WHERE project_id = $1 AND id = $2",
      [projectId, runId],
    );
    const row = result.rows[0];
    if (!row) throw new CoreFunctionRunError("function_run_not_found", 404, "function run not found");
    return row;
  }
}

const TERMINAL_STATUSES = new Set<CoreFunctionRunStatus>([
  "succeeded",
  "failed",
  "cancelled",
  "expired",
]);

export const FUNCTION_RUN_STATUSES = new Set<CoreFunctionRunStatus>([
  "scheduled",
  "queued",
  "running",
  "retrying",
  "blocked",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
]);

interface NormalizedCreateInput {
  eventType: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  runAt: Date;
  expiresAt: Date | null;
  retry: Record<string, unknown>;
  maxAttempts: number;
  source: Record<string, unknown>;
  submittedIntentDigest: Buffer;
  status: Extract<CoreFunctionRunStatus, "queued" | "scheduled">;
}

function normalizeCreateInput(
  body: CoreFunctionRunCreateInput,
  options: CoreFunctionRunCreateOptions,
): NormalizedCreateInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new CoreFunctionRunError("invalid_function_run_request", 400, "request body must be a JSON object");
  }
  if (typeof body.event_type !== "string" || body.event_type.trim() === "") {
    throw new CoreFunctionRunError("invalid_function_run_request", 400, "event_type is required", { field: "event_type" });
  }
  const bodyIdempotency = typeof body.idempotency_key === "string" ? body.idempotency_key : undefined;
  const headerIdempotency = normalizeHeaderIdempotency(options.idempotencyKeyHeader);
  if (bodyIdempotency && headerIdempotency && bodyIdempotency !== headerIdempotency) {
    throw new CoreFunctionRunError("invalid_function_run_request", 400, "idempotency_key and Idempotency-Key differ", {
      fields: ["idempotency_key", "Idempotency-Key"],
    });
  }
  const idempotencyKey = bodyIdempotency ?? headerIdempotency;
  if (!idempotencyKey) {
    throw new CoreFunctionRunError("invalid_function_run_request", 400, "idempotency_key is required", { field: "idempotency_key" });
  }
  if (body.run_at != null && body.delay_seconds != null) {
    throw new CoreFunctionRunError("invalid_function_run_request", 400, "run_at and delay_seconds are mutually exclusive", {
      fields: ["run_at", "delay_seconds"],
    });
  }

  const now = new Date();
  let runAt = parseOptionalDate(body.run_at, "run_at") ?? now;
  let delaySeconds: number | null = null;
  if (body.delay_seconds != null) {
    if (!Number.isFinite(body.delay_seconds) || body.delay_seconds < 0) {
      throw new CoreFunctionRunError("invalid_function_run_request", 400, "delay_seconds must be a non-negative number", { field: "delay_seconds" });
    }
    delaySeconds = body.delay_seconds;
    runAt = new Date(now.getTime() + delaySeconds * 1000);
  }
  const expiresAt = parseOptionalDate(body.expires_at, "expires_at");
  if (expiresAt && expiresAt.getTime() <= runAt.getTime()) {
    throw new CoreFunctionRunError("invalid_function_run_request", 400, "expires_at must be after run_at", {
      fields: ["expires_at", "run_at"],
    });
  }
  const retry = normalizeRetry(body.retry);
  const payload = asPlainObject(body.payload, "payload");
  const source = options.source ?? { type: "api" };
  const submittedIntent = {
    event_type: body.event_type,
    payload,
    delay_seconds: delaySeconds,
    run_at: body.run_at ?? null,
    expires_at: body.expires_at ?? null,
    retry: body.retry == null ? { preset: "standard" } : asPlainObject(body.retry, "retry"),
  };
  return {
    eventType: body.event_type,
    payload,
    idempotencyKey,
    runAt,
    expiresAt,
    retry: retry.retry,
    maxAttempts: retry.maxAttempts,
    source,
    submittedIntentDigest: sha256Intent(submittedIntent),
    status: runAt.getTime() > now.getTime() ? "scheduled" : "queued",
  };
}

function normalizeRetry(value: unknown): { retry: Record<string, unknown>; maxAttempts: number } {
  const retry = value == null ? { preset: "standard" } : asPlainObject(value, "retry");
  const raw = retry.max_attempts ?? retry.maxAttempts ?? 5;
  if (!Number.isInteger(raw) || Number(raw) <= 0) {
    throw new CoreFunctionRunError("invalid_function_run_request", 400, "retry.max_attempts must be a positive integer", {
      field: "retry.max_attempts",
    });
  }
  return {
    retry: {
      ...retry,
      max_attempts: Number(raw),
    },
    maxAttempts: Number(raw),
  };
}

function normalizeHeaderIdempotency(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function parseOptionalDate(value: unknown, field: string): Date | null {
  if (value == null) return null;
  return parseDate(value, field);
}

function parseDate(value: unknown, field: string): Date {
  if (typeof value !== "string" || value.trim() === "") {
    throw new CoreFunctionRunError("invalid_function_run_request", 400, `${field} must be an ISO-8601 timestamp`, { field });
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new CoreFunctionRunError("invalid_function_run_request", 400, `${field} must be an ISO-8601 timestamp`, { field });
  }
  return date;
}

function asPlainObject(value: unknown, field: string): Record<string, unknown> {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new CoreFunctionRunError("invalid_function_run_request", 400, `${field} must be a JSON object`, { field });
  }
  return value as Record<string, unknown>;
}

function sha256Intent(value: unknown): Buffer {
  return Buffer.from(createHash("sha256").update(JSON.stringify(value)).digest("hex"), "hex");
}

function digestFromRow(value: CoreFunctionRunRow["submitted_intent_sha256"]): Buffer | null {
  if (value == null) return null;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value.startsWith("\\x") ? value.slice(2) : value, "hex");
  return null;
}

function newId(prefix: "fnrun" | "fnatt"): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function toIso(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return new Date(value).toISOString();
  return undefined;
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  return fallback;
}

function normalizeError(value: unknown): CoreFunctionRunErrorInfo | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  return {
    code: typeof record.code === "string" ? record.code : "function_run_error",
    message: typeof record.message === "string" ? record.message : "Function run failed",
    retryable: record.retryable === true,
  };
}

function boundedError(code: string, message: string, retryable: boolean): CoreFunctionRunErrorInfo {
  return {
    code,
    message: message.length > 1000 ? `${message.slice(0, 997)}...` : message,
    retryable,
  };
}

function isRetryableStatus(statusCode: number): boolean {
  return statusCode === 429 || statusCode >= 500;
}

function retryDelayMs(row: CoreFunctionRunRow): number {
  const retry = row.retry_policy ?? {};
  const minSeconds = typeof retry.min_delay_seconds === "number" ? retry.min_delay_seconds : 30;
  const maxSeconds = typeof retry.max_delay_seconds === "number" ? retry.max_delay_seconds : 21_600;
  const attempt = Math.max(1, asNumber(row.current_generation_attempts, 1));
  return Math.min(maxSeconds, minSeconds * 2 ** Math.max(0, attempt - 1)) * 1000;
}

function nextActionsFor(row: CoreFunctionRunRow): Array<Record<string, unknown>> {
  if (row.status === "failed" || row.status === "cancelled" || row.status === "expired") {
    return [
      { type: "logs", href: `/functions/v1/runs/${row.id}/logs` },
      { type: "redrive", href: `/functions/v1/runs/${row.id}/redrive` },
    ];
  }
  if (row.status === "scheduled" || row.status === "queued" || row.status === "retrying" || row.status === "blocked") {
    return [{ type: "cancel", href: `/functions/v1/runs/${row.id}/cancel` }];
  }
  if (row.status === "running") {
    return [
      { type: "logs", href: `/functions/v1/runs/${row.id}/logs` },
      { type: "cancel", href: `/functions/v1/runs/${row.id}/cancel`, best_effort: true },
    ];
  }
  return [{ type: "logs", href: `/functions/v1/runs/${row.id}/logs` }];
}

function encodeCursor(row: CoreFunctionRunRow): string {
  return Buffer.from(JSON.stringify({
    created_at: toIso(row.created_at),
    id: row.id,
  })).toString("base64url");
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new CoreFunctionRunError("invalid_function_run_request", 400, "cursor is invalid", { field: "cursor" });
  }
  if (!parsed || typeof parsed !== "object") {
    throw new CoreFunctionRunError("invalid_function_run_request", 400, "cursor is invalid", { field: "cursor" });
  }
  const record = parsed as Record<string, unknown>;
  const createdAt = parseDate(record.created_at, "cursor.created_at");
  if (typeof record.id !== "string" || record.id.trim() === "") {
    throw new CoreFunctionRunError("invalid_function_run_request", 400, "cursor is invalid", { field: "cursor" });
  }
  return { createdAt, id: record.id };
}

async function expireStaleRuns(client: Pick<PgPool, "query">, now: Date): Promise<void> {
  await client.query(
    `
      UPDATE internal.core_function_runs
      SET status = 'expired',
          completed_at = $1,
          updated_at = $1,
          last_error = jsonb_build_object(
            'code', 'FUNCTION_RUN_EXPIRED',
            'message', 'Function run expired before execution.',
            'retryable', false
          )
      WHERE status IN ('scheduled', 'queued', 'retrying', 'blocked')
        AND expires_at IS NOT NULL
        AND expires_at <= $1
    `,
    [now],
  );
}

async function recoverStaleLeases(client: Pick<PgPool, "query">, now: Date): Promise<void> {
  await client.query(
    `
      UPDATE internal.core_function_runs
      SET status = CASE WHEN current_generation_attempts < max_attempts THEN 'retrying' ELSE 'failed' END,
          next_attempt_at = CASE WHEN current_generation_attempts < max_attempts THEN $1 ELSE NULL END,
          completed_at = CASE WHEN current_generation_attempts < max_attempts THEN NULL ELSE $1 END,
          lease_token = NULL,
          lease_expires_at = NULL,
          locked_at = NULL,
          updated_at = $1,
          last_error = jsonb_build_object(
            'code', 'FUNCTION_RUN_LEASE_EXPIRED',
            'message', 'Worker lease expired before finalization.',
            'retryable', current_generation_attempts < max_attempts
          )
      WHERE status = 'running'
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at <= $1
    `,
    [now],
  );
}

async function markAttemptComplete(
  pool: PgPool,
  claim: CoreFunctionRunClaim,
  status: "succeeded" | "failed" | "cancelled" | "expired",
  now: Date,
  responseStatus: number | null,
  error: CoreFunctionRunErrorInfo | null,
): Promise<void> {
  await pool.query(
    `
      UPDATE internal.core_function_run_attempts
      SET status = $3,
          completed_at = $4,
          duration_ms = $5,
          response_status = $6,
          error = $7::jsonb,
          retryable = COALESCE(($7::jsonb->>'retryable')::boolean, false),
          updated_at = $4
      WHERE run_id = $1 AND id = $2
    `,
    [
      claim.run.id,
      claim.attemptId,
      status,
      now,
      Math.max(0, now.getTime() - claim.startedAt.getTime()),
      responseStatus,
      error ? JSON.stringify(error) : null,
    ],
  );
}

async function finalizeAttempt(
  pool: PgPool,
  claim: CoreFunctionRunClaim,
  outcome: CoreFunctionRunWorkerResult,
  now: Date,
): Promise<CoreFunctionRunPublicResponse> {
  const durationMs = Math.max(0, now.getTime() - claim.startedAt.getTime());
  if (outcome.statusCode >= 200 && outcome.statusCode < 300 && !outcome.error) {
    await markAttemptComplete(pool, claim, "succeeded", now, outcome.statusCode, null);
    const updated = await pool.query<CoreFunctionRunRow>(
      `
        UPDATE internal.core_function_runs
        SET status = 'succeeded',
            completed_at = $4,
            lease_token = NULL,
            lease_expires_at = NULL,
            locked_at = NULL,
            last_attempt_completed_at = $4,
            last_attempt_duration_ms = $5,
            last_attempt_response_status = $6,
            last_status = $6,
            last_attempt_error = NULL,
            last_error = NULL,
            updated_at = $4
        WHERE id = $1 AND last_attempt_id = $2 AND lease_token = $3
        RETURNING *
      `,
      [claim.run.id, claim.attemptId, claim.leaseToken, now, durationMs, outcome.statusCode],
    );
    return serializeCoreFunctionRun(updated.rows[0] ?? { ...claim.run, status: "succeeded", completed_at: now, updated_at: now });
  }

  const retryable = outcome.error?.retryable ?? isRetryableStatus(outcome.statusCode);
  const attemptsRemain = asNumber(claim.run.current_generation_attempts, 1) < asNumber(claim.run.max_attempts, 5);
  const finalStatus: CoreFunctionRunStatus = retryable && attemptsRemain ? "retrying" : "failed";
  const error = outcome.error ?? boundedError(
    `FUNCTION_RUN_HTTP_${outcome.statusCode}`,
    `Function run attempt returned HTTP ${outcome.statusCode}.`,
    retryable,
  );
  const nextAttemptAt = finalStatus === "retrying" ? new Date(now.getTime() + retryDelayMs(claim.run)) : null;
  await markAttemptComplete(pool, claim, "failed", now, outcome.statusCode, error);
  const updated = await pool.query<CoreFunctionRunRow>(
    `
      UPDATE internal.core_function_runs
      SET status = $4,
          completed_at = CASE WHEN $4 = 'failed' THEN $5 ELSE NULL END,
          next_attempt_at = $6,
          lease_token = NULL,
          lease_expires_at = NULL,
          locked_at = NULL,
          last_attempt_completed_at = $5,
          last_attempt_duration_ms = $7,
          last_attempt_response_status = $8,
          last_status = $8,
          last_attempt_error = $9::jsonb,
          last_error = $9::jsonb,
          updated_at = $5
      WHERE id = $1 AND last_attempt_id = $2 AND lease_token = $3
      RETURNING *
    `,
    [
      claim.run.id,
      claim.attemptId,
      claim.leaseToken,
      finalStatus,
      now,
      nextAttemptAt,
      durationMs,
      outcome.statusCode,
      JSON.stringify(error),
    ],
  );
  return serializeCoreFunctionRun(updated.rows[0] ?? { ...claim.run, status: finalStatus, last_error: error, updated_at: now });
}
