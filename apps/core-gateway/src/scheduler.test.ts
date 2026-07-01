import assert from "node:assert/strict";
import test from "node:test";

import type { CoreFunctionScheduleMetadata } from "@run402/runtime-kernel";
import {
  CoreFunctionScheduler,
  CoreSchedulerError,
  type CoreScheduleStorePort,
  type CoreScheduledFunctionRecord,
} from "./scheduler.js";
import type {
  CoreFunctionRunCreateInput,
  CoreFunctionRunCreateResult,
  CoreFunctionRunListResult,
  CoreFunctionRunPublicResponse,
  CoreFunctionRunStorePort,
  CoreFunctionRunClaim,
} from "./function-runs.js";

test("CoreFunctionScheduler registers, refreshes, cancels, and ignores old stopped jobs", async () => {
  const store = new MemoryScheduleStore();
  store.set(scheduleRecord({ projectId: "prj_a", functionName: "tick", triggerId: "tick_every_15m", schedule: "*/15 * * * *" }));
  const functionRuns = new MemoryFunctionRunStore();
  const scheduler = new CoreFunctionScheduler({
    store,
    functionRuns,
  });

  await scheduler.start();
  const oldJob = scheduler.__getTriggerJobForTests("prj_a", "tick", "tick_every_15m");
  assert.ok(oldJob);
  assert.equal(scheduler.started, true);
  assert.equal(scheduler.size, 1);

  store.set(scheduleRecord({ projectId: "prj_a", functionName: "tick", triggerId: "tick_every_15m", schedule: "*/5 * * * *" }));
  await scheduler.refresh("prj_a");
  const newJob = scheduler.__getTriggerJobForTests("prj_a", "tick", "tick_every_15m");
  assert.ok(newJob);
  assert.notEqual(newJob, oldJob);
  assert.equal(scheduler.size, 1);

  await oldJob.trigger();
  await flushMicrotasks();
  assert.deepEqual(functionRuns.creates, []);

  await newJob.trigger();
  await flushMicrotasks();
  assert.equal(functionRuns.creates.length, 1);
  assert.equal(functionRuns.creates[0]?.source?.mode, "cron");
  assert.equal(functionRuns.creates[0]?.source?.trigger_id, "tick_every_15m");
  assert.equal(functionRuns.creates[0]?.body.event_type, "tick.due");
  assert.equal(store.lastMeta?.last_run_id, "fnrun_test_1");
  assert.equal(store.lastMeta?.last_run_status, "queued");
  assert.equal(store.lastMeta?.run_count, 1);

  store.delete("prj_a", "tick", "tick_every_15m");
  await scheduler.refresh("prj_a");
  assert.equal(scheduler.size, 0);

  scheduler.stop();
  assert.equal(scheduler.started, false);
});

test("CoreFunctionScheduler manual trigger updates metadata and reports missing schedules", async () => {
  const store = new MemoryScheduleStore();
  store.set(scheduleRecord({ projectId: "prj_a", functionName: "reminder", triggerId: "reminder_every_5m", schedule: "*/5 * * * *" }));
  const functionRuns = new MemoryFunctionRunStore();
  const scheduler = new CoreFunctionScheduler({
    store,
    functionRuns,
  });

  const result = await scheduler.triggerNow({ projectId: "prj_a", functionName: "reminder", triggerId: "reminder_every_5m" });
  assert.equal(result.requestId, "fnrun_test_1");
  assert.equal(result.status, 202);
  assert.equal(result.run?.run_id, "fnrun_test_1");
  assert.equal(result.schedule_meta.last_run_id, "fnrun_test_1");
  assert.equal(result.schedule_meta.last_run_status, "queued");
  assert.equal(result.schedule_meta.last_error, null);
  assert.equal(result.schedule_meta.run_count, 1);
  assert.equal(functionRuns.creates[0]?.source?.mode, "manual");

  await assert.rejects(
    () => scheduler.triggerNow({ projectId: "prj_a", functionName: "missing" }),
    (error) => error instanceof CoreSchedulerError && error.code === "scheduled_function_not_found",
  );
});

class MemoryScheduleStore implements CoreScheduleStorePort {
  readonly #records = new Map<string, CoreScheduledFunctionRecord>();
  lastMeta: CoreFunctionScheduleMetadata | null = null;

  set(record: CoreScheduledFunctionRecord): void {
    this.#records.set(scheduleKey(record.projectId, record.functionName, record.triggerId), record);
  }

  delete(projectId: string, functionName: string, triggerId: string): void {
    this.#records.delete(scheduleKey(projectId, functionName, triggerId));
  }

  async listActiveSchedules(projectId?: string): Promise<CoreScheduledFunctionRecord[]> {
    return [...this.#records.values()].filter((record) => !projectId || record.projectId === projectId);
  }

  async getActiveSchedule(input: {
    projectId: string;
    functionName: string;
    triggerId?: string;
  }): Promise<CoreScheduledFunctionRecord | null> {
    return [...this.#records.values()].find((record) =>
      record.projectId === input.projectId &&
      record.functionName === input.functionName &&
      (input.triggerId === undefined || record.triggerId === input.triggerId)
    ) ?? null;
  }

  async updateScheduleMeta(input: {
    projectId: string;
    releaseId: string;
    functionName: string;
    triggerId: string;
    runId: string | null;
    status: number | string | null;
    error: string | null;
    schedule: string;
    enqueuedAt: string;
  }): Promise<CoreFunctionScheduleMetadata> {
    const record = this.#records.get(scheduleKey(input.projectId, input.functionName, input.triggerId));
    const previous = record?.scheduleMeta;
    const meta: CoreFunctionScheduleMetadata = {
      last_enqueued_at: input.enqueuedAt,
      last_run_id: input.runId,
      last_run_status: input.status === null ? null : String(input.status),
      last_status: input.status,
      last_run_at: input.enqueuedAt,
      run_count: (previous?.run_count ?? 0) + 1,
      last_error: input.error,
      next_tick_at: "2099-01-01T00:00:00.000Z",
      next_run_at: "2099-01-01T00:00:00.000Z",
    };
    this.lastMeta = meta;
    if (record) record.scheduleMeta = meta;
    return meta;
  }
}

function scheduleRecord(input: {
  projectId: string;
  functionName: string;
  triggerId: string;
  schedule: string;
}): CoreScheduledFunctionRecord {
  return {
    projectId: input.projectId,
    releaseId: "rel_test",
    functionName: input.functionName,
    triggerId: input.triggerId,
    schedule: input.schedule,
    run: { event_type: `${input.functionName}.due`, payload: {} },
    scheduleMeta: null,
  };
}

function scheduleKey(projectId: string, functionName: string, triggerId: string): string {
  return `${projectId}:${functionName}:${triggerId}`;
}

class MemoryFunctionRunStore implements CoreFunctionRunStorePort {
  readonly creates: Array<{
    projectId: string;
    functionName: string;
    body: CoreFunctionRunCreateInput;
    idempotencyKeyHeader?: string | string[];
    source?: Record<string, unknown>;
  }> = [];

  async createRun(input: {
    projectId: string;
    functionName: string;
    body: CoreFunctionRunCreateInput;
    idempotencyKeyHeader?: string | string[];
    source?: Record<string, unknown>;
  }): Promise<CoreFunctionRunCreateResult> {
    this.creates.push(input);
    const run = publicRun({
      run_id: `fnrun_test_${this.creates.length}`,
      function_name: input.functionName,
      event_type: input.body.event_type,
      status: "queued",
    });
    return { httpStatus: 202, run };
  }

  async listRuns(): Promise<CoreFunctionRunListResult> {
    return { runs: [] };
  }

  async getRun(): Promise<CoreFunctionRunPublicResponse> {
    throw new Error("not implemented");
  }

  async cancelRun(): Promise<CoreFunctionRunPublicResponse> {
    throw new Error("not implemented");
  }

  async redriveRun(): Promise<CoreFunctionRunPublicResponse> {
    throw new Error("not implemented");
  }

  async claimDueRun(): Promise<CoreFunctionRunClaim | null> {
    return null;
  }

  async completeRun(): Promise<CoreFunctionRunPublicResponse> {
    throw new Error("not implemented");
  }

  async blockRun(): Promise<CoreFunctionRunPublicResponse> {
    throw new Error("not implemented");
  }
}

function publicRun(input: {
  run_id: string;
  function_name: string;
  event_type: string;
  status: CoreFunctionRunPublicResponse["status"];
}): CoreFunctionRunPublicResponse {
  return {
    run_id: input.run_id,
    function_name: input.function_name,
    event_type: input.event_type,
    status: input.status,
    terminal: false,
    generation: 1,
    run_at: "2026-07-01T00:00:00.000Z",
    source: { type: "schedule" },
    attempts: { current: 0, max: 5, total: 0 },
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    next_actions: [],
  };
}

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
