import { Cron } from "croner";
import type { Pool as PgPool } from "pg";
import {
  CORE_FUNCTION_SCHEDULE_LIMIT_DEFAULTS,
  nextCoreCronRunIso,
  type CoreFunctionScheduleLimits,
  type CoreFunctionScheduleMetadata,
} from "@run402/runtime-kernel";

export interface CoreScheduledFunctionRecord {
  projectId: string;
  releaseId: string;
  functionName: string;
  schedule: string;
  scheduleMeta: CoreFunctionScheduleMetadata | null;
}

export interface CoreScheduleStorePort {
  listActiveSchedules(projectId?: string): Promise<CoreScheduledFunctionRecord[]>;
  getActiveSchedule(input: {
    projectId: string;
    functionName: string;
  }): Promise<CoreScheduledFunctionRecord | null>;
  updateScheduleMeta(input: {
    projectId: string;
    releaseId: string;
    functionName: string;
    status: number | null;
    error: string | null;
    schedule: string;
    ranAt: string;
  }): Promise<CoreFunctionScheduleMetadata>;
}

export interface CoreScheduleInvokerPort {
  invokeScheduledFunction(input: {
    projectId: string;
    releaseId: string;
    functionName: string;
    trigger: "cron" | "manual";
    scheduledAt: string;
  }): Promise<{
    requestId: string;
    status: number;
    body: unknown;
  }>;
}

export class CoreSchedulerError extends Error {
  constructor(
    readonly code: "scheduled_function_not_found" | "scheduler_disabled",
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "CoreSchedulerError";
  }
}

export class CoreFunctionScheduler {
  readonly #store: CoreScheduleStorePort;
  readonly #invoker: CoreScheduleInvokerPort;
  readonly #limits: CoreFunctionScheduleLimits;
  readonly #jobs = new Map<string, Cron>();
  readonly #jobGenerations = new WeakMap<Cron, number>();
  readonly #runningByProject = new Map<string, number>();
  #generation = 0;
  #started = false;

  constructor(input: {
    store: CoreScheduleStorePort;
    invoker: CoreScheduleInvokerPort;
    limits?: CoreFunctionScheduleLimits;
  }) {
    this.#store = input.store;
    this.#invoker = input.invoker;
    this.#limits = input.limits ?? CORE_FUNCTION_SCHEDULE_LIMIT_DEFAULTS;
  }

  async start(): Promise<void> {
    if (!this.#limits.enabled) return;
    this.#started = true;
    await this.refresh();
  }

  stop(): void {
    for (const job of this.#jobs.values()) job.stop();
    this.#jobs.clear();
    this.#started = false;
  }

  async refresh(projectId?: string): Promise<void> {
    if (!this.#limits.enabled) return;
    const records = await this.#store.listActiveSchedules(projectId);
    const desired = new Set(records.map(scheduleKey));
    for (const record of records) this.#register(record);
    for (const [key, job] of this.#jobs) {
      if (projectId && !key.startsWith(`${projectId}:`)) continue;
      if (desired.has(key)) continue;
      job.stop();
      this.#jobs.delete(key);
    }
  }

  async triggerNow(input: {
    projectId: string;
    functionName: string;
  }): Promise<{
    requestId: string;
    status: number;
    body: unknown;
    schedule_meta: CoreFunctionScheduleMetadata;
  }> {
    if (!this.#limits.enabled) {
      throw new CoreSchedulerError("scheduler_disabled", 422, "Run402 Core scheduled functions are disabled.");
    }
    const record = await this.#store.getActiveSchedule(input);
    if (!record) {
      throw new CoreSchedulerError("scheduled_function_not_found", 404, "Core scheduled function was not found.");
    }
    return await this.#invoke(record, "manual");
  }

  __getJobForTests(projectId: string, functionName: string): Cron | undefined {
    return this.#jobs.get(`${projectId}:${functionName}`);
  }

  get size(): number {
    return this.#jobs.size;
  }

  get started(): boolean {
    return this.#started;
  }

  #register(record: CoreScheduledFunctionRecord): void {
    const key = scheduleKey(record);
    const existing = this.#jobs.get(key);
    if (existing) {
      existing.stop();
      this.#jobs.delete(key);
    }

    const generation = ++this.#generation;
    const job = new Cron(record.schedule, () => {
      const current = this.#jobs.get(key);
      if (!current || this.#jobGenerations.get(current) !== generation) return;
      this.#invoke(record, "cron").catch((error: unknown) => {
        console.error(`Run402 Core scheduler tick failed for ${key}:`, error);
      });
    });
    this.#jobGenerations.set(job, generation);
    this.#jobs.set(key, job);
  }

  async #invoke(
    record: CoreScheduledFunctionRecord,
    trigger: "cron" | "manual",
  ): Promise<{
    requestId: string;
    status: number;
    body: unknown;
    schedule_meta: CoreFunctionScheduleMetadata;
  }> {
    const running = this.#runningByProject.get(record.projectId) ?? 0;
    if (running >= this.#limits.maxConcurrentScheduledInvocationsPerProject) {
      const ranAt = new Date().toISOString();
      const scheduleMeta = await this.#store.updateScheduleMeta({
        projectId: record.projectId,
        releaseId: record.releaseId,
        functionName: record.functionName,
        status: null,
        error: "scheduled invocation skipped: concurrency limit reached",
        schedule: record.schedule,
        ranAt,
      });
      return {
        requestId: "",
        status: 429,
        body: { error: "scheduled_concurrency_limit_reached" },
        schedule_meta: scheduleMeta,
      };
    }

    const scheduledAt = new Date().toISOString();
    this.#runningByProject.set(record.projectId, running + 1);
    try {
      const result = await this.#invoker.invokeScheduledFunction({
        projectId: record.projectId,
        releaseId: record.releaseId,
        functionName: record.functionName,
        trigger,
        scheduledAt,
      });
      const scheduleMeta = await this.#store.updateScheduleMeta({
        projectId: record.projectId,
        releaseId: record.releaseId,
        functionName: record.functionName,
        status: result.status,
        error: result.status >= 400 ? `scheduled invocation returned ${result.status}` : null,
        schedule: record.schedule,
        ranAt: scheduledAt,
      });
      return { ...result, schedule_meta: scheduleMeta };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const scheduleMeta = await this.#store.updateScheduleMeta({
        projectId: record.projectId,
        releaseId: record.releaseId,
        functionName: record.functionName,
        status: 500,
        error: truncateError(message),
        schedule: record.schedule,
        ranAt: scheduledAt,
      });
      throw Object.assign(error instanceof Error ? error : new Error(message), { schedule_meta: scheduleMeta });
    } finally {
      const next = (this.#runningByProject.get(record.projectId) ?? 1) - 1;
      if (next <= 0) this.#runningByProject.delete(record.projectId);
      else this.#runningByProject.set(record.projectId, next);
    }
  }
}

export class PostgresCoreScheduleStore implements CoreScheduleStorePort {
  readonly #pool: PgPool;

  constructor(pool: PgPool) {
    this.#pool = pool;
  }

  async listActiveSchedules(projectId?: string): Promise<CoreScheduledFunctionRecord[]> {
    const params: unknown[] = [];
    const predicate = projectId ? "AND p.project_id = $1" : "";
    if (projectId) params.push(projectId);
    const result = await this.#pool.query<ScheduleRow>(
      `
        SELECT b.project_id, b.release_id, b.name, b.schedule, b.schedule_meta
        FROM internal.core_projects p
        JOIN internal.core_function_bundles b
          ON b.project_id = p.project_id
         AND b.release_id = p.active_release_id
        WHERE b.schedule IS NOT NULL
          ${predicate}
        ORDER BY b.project_id, b.name
      `,
      params,
    );
    return result.rows.map(scheduleRow);
  }

  async getActiveSchedule(input: {
    projectId: string;
    functionName: string;
  }): Promise<CoreScheduledFunctionRecord | null> {
    const result = await this.#pool.query<ScheduleRow>(
      `
        SELECT b.project_id, b.release_id, b.name, b.schedule, b.schedule_meta
        FROM internal.core_projects p
        JOIN internal.core_function_bundles b
          ON b.project_id = p.project_id
         AND b.release_id = p.active_release_id
        WHERE b.project_id = $1
          AND b.name = $2
          AND b.schedule IS NOT NULL
      `,
      [input.projectId, input.functionName],
    );
    return result.rows[0] ? scheduleRow(result.rows[0]) : null;
  }

  async updateScheduleMeta(input: {
    projectId: string;
    releaseId: string;
    functionName: string;
    status: number | null;
    error: string | null;
    schedule: string;
    ranAt: string;
  }): Promise<CoreFunctionScheduleMetadata> {
    const nextRunAt = nextCoreCronRunIso(input.schedule);
    const result = await this.#pool.query<{ schedule_meta: CoreFunctionScheduleMetadata }>(
      `
        UPDATE internal.core_function_bundles
        SET schedule_meta = jsonb_build_object(
              'last_run_at', $4::text,
              'last_status', to_jsonb($5::int),
              'run_count', COALESCE((schedule_meta->>'run_count')::int, 0) + 1,
              'last_error', $6::text,
              'next_run_at', $7::text
            )
        WHERE project_id = $1
          AND release_id = $2
          AND name = $3
        RETURNING schedule_meta
      `,
      [
        input.projectId,
        input.releaseId,
        input.functionName,
        input.ranAt,
        input.status,
        input.error,
        nextRunAt,
      ],
    );
    return result.rows[0]?.schedule_meta ?? {
      last_run_at: input.ranAt,
      last_status: input.status,
      run_count: 1,
      last_error: input.error,
      next_run_at: nextRunAt,
    };
  }
}

interface ScheduleRow {
  project_id: string;
  release_id: string;
  name: string;
  schedule: string;
  schedule_meta: CoreFunctionScheduleMetadata | null;
}

function scheduleRow(row: ScheduleRow): CoreScheduledFunctionRecord {
  return {
    projectId: row.project_id,
    releaseId: row.release_id,
    functionName: row.name,
    schedule: row.schedule,
    scheduleMeta: row.schedule_meta,
  };
}

function scheduleKey(record: Pick<CoreScheduledFunctionRecord, "projectId" | "functionName">): string {
  return `${record.projectId}:${record.functionName}`;
}

function truncateError(value: string): string {
  return value.length > 500 ? `${value.slice(0, 500)}...[truncated]` : value;
}
