import { Cron } from "croner";
import type { Pool as PgPool } from "pg";
import {
  CORE_FUNCTION_SCHEDULE_LIMIT_DEFAULTS,
  nextCoreCronRunIso,
  type CoreFunctionScheduleLimits,
  type CoreFunctionScheduleMetadata,
} from "@run402/runtime-kernel";
import type {
  CoreFunctionRunCreateInput,
  CoreFunctionRunPublicResponse,
  CoreFunctionRunStatus,
  CoreFunctionRunStorePort,
} from "./function-runs.js";

export interface CoreScheduledFunctionRunSpec {
  event_type: string;
  payload?: Record<string, unknown>;
  retry?: Record<string, unknown>;
  expires_after_seconds?: number;
}

export interface CoreScheduledFunctionRecord {
  projectId: string;
  releaseId: string;
  functionName: string;
  triggerId: string;
  schedule: string;
  run: CoreScheduledFunctionRunSpec;
  scheduleMeta: CoreFunctionScheduleMetadata | null;
}

export interface CoreScheduleStorePort {
  listActiveSchedules(projectId?: string): Promise<CoreScheduledFunctionRecord[]>;
  getActiveSchedule(input: {
    projectId: string;
    functionName: string;
    triggerId?: string;
  }): Promise<CoreScheduledFunctionRecord | null>;
  updateScheduleMeta(input: {
    projectId: string;
    releaseId: string;
    functionName: string;
    triggerId: string;
    runId: string | null;
    status: number | CoreFunctionRunStatus | null;
    error: string | null;
    schedule: string;
    enqueuedAt: string;
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
  readonly #invoker?: CoreScheduleInvokerPort;
  readonly #functionRuns?: CoreFunctionRunStorePort;
  readonly #limits: CoreFunctionScheduleLimits;
  readonly #jobs = new Map<string, Cron>();
  readonly #jobGenerations = new WeakMap<Cron, number>();
  readonly #runningByProject = new Map<string, number>();
  #generation = 0;
  #started = false;

  constructor(input: {
    store: CoreScheduleStorePort;
    invoker?: CoreScheduleInvokerPort;
    functionRuns?: CoreFunctionRunStorePort;
    limits?: CoreFunctionScheduleLimits;
  }) {
    this.#store = input.store;
    this.#invoker = input.invoker;
    this.#functionRuns = input.functionRuns;
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
    triggerId?: string;
  }): Promise<{
    requestId: string;
    status: number;
    body: unknown;
    run?: CoreFunctionRunPublicResponse;
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

  __getTriggerJobForTests(projectId: string, functionName: string, triggerId: string): Cron | undefined {
    return this.#jobs.get(`${projectId}:${functionName}:${triggerId}`);
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
    run?: CoreFunctionRunPublicResponse;
    schedule_meta: CoreFunctionScheduleMetadata;
  }> {
    if (this.#functionRuns) {
      return await this.#enqueueFunctionRun(record, trigger);
    }
    if (!this.#invoker) {
      throw new CoreSchedulerError("scheduler_disabled", 422, "Run402 Core scheduled functions are disabled.");
    }
    const running = this.#runningByProject.get(record.projectId) ?? 0;
    if (running >= this.#limits.maxConcurrentScheduledInvocationsPerProject) {
      const enqueuedAt = new Date().toISOString();
      const scheduleMeta = await this.#store.updateScheduleMeta({
        projectId: record.projectId,
        releaseId: record.releaseId,
        functionName: record.functionName,
        triggerId: record.triggerId,
        runId: null,
        status: null,
        error: "scheduled invocation skipped: concurrency limit reached",
        schedule: record.schedule,
        enqueuedAt,
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
        triggerId: record.triggerId,
        runId: result.requestId,
        status: result.status,
        error: result.status >= 400 ? `scheduled invocation returned ${result.status}` : null,
        schedule: record.schedule,
        enqueuedAt: scheduledAt,
      });
      return { ...result, schedule_meta: scheduleMeta };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const scheduleMeta = await this.#store.updateScheduleMeta({
        projectId: record.projectId,
        releaseId: record.releaseId,
        functionName: record.functionName,
        triggerId: record.triggerId,
        runId: null,
        status: 500,
        error: truncateError(message),
        schedule: record.schedule,
        enqueuedAt: scheduledAt,
      });
      throw Object.assign(error instanceof Error ? error : new Error(message), { schedule_meta: scheduleMeta });
    } finally {
      const next = (this.#runningByProject.get(record.projectId) ?? 1) - 1;
      if (next <= 0) this.#runningByProject.delete(record.projectId);
      else this.#runningByProject.set(record.projectId, next);
    }
  }

  async #enqueueFunctionRun(
    record: CoreScheduledFunctionRecord,
    trigger: "cron" | "manual",
  ): Promise<{
    requestId: string;
    status: number;
    body: unknown;
    run: CoreFunctionRunPublicResponse;
    schedule_meta: CoreFunctionScheduleMetadata;
  }> {
    const enqueuedAt = new Date().toISOString();
    const expiresAt = record.run.expires_after_seconds === undefined
      ? undefined
      : new Date(Date.parse(enqueuedAt) + record.run.expires_after_seconds * 1000).toISOString();
    const body: CoreFunctionRunCreateInput = {
      event_type: record.run.event_type,
      payload: record.run.payload ?? {},
      idempotency_key: `${trigger}:${record.projectId}:${record.functionName}:${record.releaseId}:${record.triggerId}:${enqueuedAt}`,
      ...(record.run.retry !== undefined ? { retry: record.run.retry } : {}),
      ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
    };
    const created = await this.#functionRuns!.createRun({
      projectId: record.projectId,
      functionName: record.functionName,
      body,
      source: {
        type: "schedule",
        mode: trigger,
        trigger_id: record.triggerId,
        scheduled_at: enqueuedAt,
        release_id: record.releaseId,
      },
    });
    const scheduleMeta = await this.#store.updateScheduleMeta({
      projectId: record.projectId,
      releaseId: record.releaseId,
      functionName: record.functionName,
      triggerId: record.triggerId,
      runId: created.run.run_id,
      status: created.run.status,
      error: null,
      schedule: record.schedule,
      enqueuedAt,
    });
    return {
      requestId: created.run.run_id,
      status: created.httpStatus,
      body: created.run,
      run: created.run,
      schedule_meta: scheduleMeta,
    };
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
        SELECT
          b.project_id,
          b.release_id,
          b.name,
          trigger.value->>'id' AS trigger_id,
          trigger.value->>'cron' AS schedule,
          trigger.value->'run' AS run,
          trigger.value->'schedule_meta' AS schedule_meta
        FROM internal.core_projects p
        JOIN internal.core_function_bundles b
          ON b.project_id = p.project_id
         AND b.release_id = p.active_release_id
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(b.triggers, '[]'::jsonb)) AS trigger(value)
        WHERE trigger.value->>'type' = 'schedule'
          ${predicate}
        ORDER BY b.project_id, b.name, trigger.value->>'id'
      `,
      params,
    );
    return result.rows.map(scheduleRow);
  }

  async getActiveSchedule(input: {
    projectId: string;
    functionName: string;
    triggerId?: string;
  }): Promise<CoreScheduledFunctionRecord | null> {
    const result = await this.#pool.query<ScheduleRow>(
      `
        SELECT
          b.project_id,
          b.release_id,
          b.name,
          trigger.value->>'id' AS trigger_id,
          trigger.value->>'cron' AS schedule,
          trigger.value->'run' AS run,
          trigger.value->'schedule_meta' AS schedule_meta
        FROM internal.core_projects p
        JOIN internal.core_function_bundles b
          ON b.project_id = p.project_id
         AND b.release_id = p.active_release_id
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(b.triggers, '[]'::jsonb)) AS trigger(value)
        WHERE b.project_id = $1
          AND b.name = $2
          AND trigger.value->>'type' = 'schedule'
          AND ($3::text IS NULL OR trigger.value->>'id' = $3)
        ORDER BY trigger.value->>'id'
        LIMIT 1
      `,
      [input.projectId, input.functionName, input.triggerId ?? null],
    );
    return result.rows[0] ? scheduleRow(result.rows[0]) : null;
  }

  async updateScheduleMeta(input: {
    projectId: string;
    releaseId: string;
    functionName: string;
    triggerId: string;
    runId: string | null;
    status: number | CoreFunctionRunStatus | null;
    error: string | null;
    schedule: string;
    enqueuedAt: string;
  }): Promise<CoreFunctionScheduleMetadata> {
    const nextRunAt = nextCoreCronRunIso(input.schedule);
    const current = await this.#pool.query<{ triggers: unknown }>(
      `
        SELECT triggers
        FROM internal.core_function_bundles
        WHERE project_id = $1
          AND release_id = $2
          AND name = $3
      `,
      [
        input.projectId,
        input.releaseId,
        input.functionName,
      ],
    );
    const triggers = Array.isArray(current.rows[0]?.triggers)
      ? [...current.rows[0].triggers as Array<Record<string, unknown>>]
      : [];
    const index = triggers.findIndex((trigger) => trigger.id === input.triggerId);
    const previous = index >= 0 && isRecord(triggers[index].schedule_meta)
      ? triggers[index].schedule_meta as Partial<CoreFunctionScheduleMetadata>
      : {};
    const meta: CoreFunctionScheduleMetadata = {
      last_enqueued_at: input.enqueuedAt,
      last_run_id: input.runId,
      last_run_status: input.status === null ? null : String(input.status),
      run_count: 1,
      last_error: input.error,
      next_tick_at: nextRunAt,
      last_run_at: input.enqueuedAt,
      last_status: input.status,
      next_run_at: nextRunAt,
    };
    meta.run_count = (typeof previous.run_count === "number" ? previous.run_count : 0) + 1;
    if (index >= 0) {
      triggers[index] = { ...triggers[index], schedule_meta: meta };
      await this.#pool.query(
        `
          UPDATE internal.core_function_bundles
          SET triggers = $4::jsonb
          WHERE project_id = $1
            AND release_id = $2
            AND name = $3
        `,
        [input.projectId, input.releaseId, input.functionName, JSON.stringify(triggers)],
      );
    }
    return meta;
  }
}

interface ScheduleRow {
  project_id: string;
  release_id: string;
  name: string;
  trigger_id: string;
  schedule: string;
  run: CoreScheduledFunctionRunSpec | null;
  schedule_meta: CoreFunctionScheduleMetadata | null;
}

function scheduleRow(row: ScheduleRow): CoreScheduledFunctionRecord {
  return {
    projectId: row.project_id,
    releaseId: row.release_id,
    functionName: row.name,
    triggerId: row.trigger_id,
    schedule: row.schedule,
    run: normalizeTriggerRun(row.run, row.trigger_id),
    scheduleMeta: row.schedule_meta,
  };
}

function scheduleKey(record: Pick<CoreScheduledFunctionRecord, "projectId" | "functionName" | "triggerId">): string {
  return `${record.projectId}:${record.functionName}:${record.triggerId}`;
}

function truncateError(value: string): string {
  return value.length > 500 ? `${value.slice(0, 500)}...[truncated]` : value;
}

function normalizeTriggerRun(value: CoreScheduledFunctionRunSpec | null, triggerId: string): CoreScheduledFunctionRunSpec {
  if (isRecord(value) && typeof value.event_type === "string" && value.event_type.length > 0) {
    return {
      event_type: value.event_type,
      ...(isRecord(value.payload) ? { payload: value.payload } : {}),
      ...(isRecord(value.retry) ? { retry: value.retry } : {}),
      ...(typeof value.expires_after_seconds === "number" ? { expires_after_seconds: value.expires_after_seconds } : {}),
    };
  }
  return { event_type: `schedule.${triggerId}`, payload: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
