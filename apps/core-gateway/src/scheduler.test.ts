import assert from "node:assert/strict";
import test from "node:test";

import type { CoreFunctionScheduleMetadata } from "@run402/runtime-kernel";
import {
  CoreFunctionScheduler,
  CoreSchedulerError,
  type CoreScheduleStorePort,
  type CoreScheduledFunctionRecord,
} from "./scheduler.js";

test("CoreFunctionScheduler registers, refreshes, cancels, and ignores old stopped jobs", async () => {
  const store = new MemoryScheduleStore();
  store.set(scheduleRecord({ projectId: "prj_a", functionName: "tick", schedule: "*/15 * * * *" }));
  const invocations: string[] = [];
  const scheduler = new CoreFunctionScheduler({
    store,
    invoker: {
      invokeScheduledFunction: async (input) => {
        invocations.push(`${input.projectId}:${input.functionName}:${input.trigger}`);
        return { requestId: "req_tick", status: 200, body: { ok: true } };
      },
    },
  });

  await scheduler.start();
  const oldJob = scheduler.__getJobForTests("prj_a", "tick");
  assert.ok(oldJob);
  assert.equal(scheduler.started, true);
  assert.equal(scheduler.size, 1);

  store.set(scheduleRecord({ projectId: "prj_a", functionName: "tick", schedule: "*/5 * * * *" }));
  await scheduler.refresh("prj_a");
  const newJob = scheduler.__getJobForTests("prj_a", "tick");
  assert.ok(newJob);
  assert.notEqual(newJob, oldJob);
  assert.equal(scheduler.size, 1);

  await oldJob.trigger();
  await flushMicrotasks();
  assert.deepEqual(invocations, []);

  await newJob.trigger();
  await flushMicrotasks();
  assert.deepEqual(invocations, ["prj_a:tick:cron"]);
  assert.equal(store.lastMeta?.last_status, 200);
  assert.equal(store.lastMeta?.run_count, 1);

  store.delete("prj_a", "tick");
  await scheduler.refresh("prj_a");
  assert.equal(scheduler.size, 0);

  scheduler.stop();
  assert.equal(scheduler.started, false);
});

test("CoreFunctionScheduler manual trigger updates metadata and reports missing schedules", async () => {
  const store = new MemoryScheduleStore();
  store.set(scheduleRecord({ projectId: "prj_a", functionName: "reminder", schedule: "*/5 * * * *" }));
  const scheduler = new CoreFunctionScheduler({
    store,
    invoker: {
      invokeScheduledFunction: async (input) => ({
        requestId: "req_manual",
        status: input.trigger === "manual" ? 204 : 500,
        body: null,
      }),
    },
  });

  const result = await scheduler.triggerNow({ projectId: "prj_a", functionName: "reminder" });
  assert.equal(result.requestId, "req_manual");
  assert.equal(result.status, 204);
  assert.equal(result.schedule_meta.last_status, 204);
  assert.equal(result.schedule_meta.last_error, null);
  assert.equal(result.schedule_meta.run_count, 1);

  await assert.rejects(
    () => scheduler.triggerNow({ projectId: "prj_a", functionName: "missing" }),
    (error) => error instanceof CoreSchedulerError && error.code === "scheduled_function_not_found",
  );
});

test("CoreFunctionScheduler enforces per-project scheduled invocation concurrency", async () => {
  const store = new MemoryScheduleStore();
  store.set(scheduleRecord({ projectId: "prj_a", functionName: "slow", schedule: "*/5 * * * *" }));
  let releaseFirstInvocation!: () => void;
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  const scheduler = new CoreFunctionScheduler({
    store,
    limits: {
      enabled: true,
      maxScheduledFunctionsPerProject: 20,
      minIntervalMinutes: 1,
      maxConcurrentScheduledInvocationsPerProject: 1,
    },
    invoker: {
      invokeScheduledFunction: async () => {
        markFirstStarted();
        await new Promise<void>((resolveRelease) => {
          releaseFirstInvocation = resolveRelease;
        });
        return { requestId: "req_slow", status: 200, body: null };
      },
    },
  });

  const first = scheduler.triggerNow({ projectId: "prj_a", functionName: "slow" });
  await firstStarted;
  const second = await scheduler.triggerNow({ projectId: "prj_a", functionName: "slow" });
  assert.equal(second.status, 429);
  assert.equal(second.schedule_meta.last_error, "scheduled invocation skipped: concurrency limit reached");
  releaseFirstInvocation();
  await first;
  scheduler.stop();
});

class MemoryScheduleStore implements CoreScheduleStorePort {
  readonly #records = new Map<string, CoreScheduledFunctionRecord>();
  lastMeta: CoreFunctionScheduleMetadata | null = null;

  set(record: CoreScheduledFunctionRecord): void {
    this.#records.set(scheduleKey(record.projectId, record.functionName), record);
  }

  delete(projectId: string, functionName: string): void {
    this.#records.delete(scheduleKey(projectId, functionName));
  }

  async listActiveSchedules(projectId?: string): Promise<CoreScheduledFunctionRecord[]> {
    return [...this.#records.values()].filter((record) => !projectId || record.projectId === projectId);
  }

  async getActiveSchedule(input: {
    projectId: string;
    functionName: string;
  }): Promise<CoreScheduledFunctionRecord | null> {
    return this.#records.get(scheduleKey(input.projectId, input.functionName)) ?? null;
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
    const record = this.#records.get(scheduleKey(input.projectId, input.functionName));
    const previous = record?.scheduleMeta;
    const meta: CoreFunctionScheduleMetadata = {
      last_run_at: input.ranAt,
      last_status: input.status,
      run_count: (previous?.run_count ?? 0) + 1,
      last_error: input.error,
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
  schedule: string;
}): CoreScheduledFunctionRecord {
  return {
    projectId: input.projectId,
    releaseId: "rel_test",
    functionName: input.functionName,
    schedule: input.schedule,
    scheduleMeta: null,
  };
}

function scheduleKey(projectId: string, functionName: string): string {
  return `${projectId}:${functionName}`;
}

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
