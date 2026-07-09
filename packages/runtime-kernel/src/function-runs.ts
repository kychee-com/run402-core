import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import type { FunctionScheduleTriggerSpec } from "@run402/release";
import type {
  CoreFunctionInvocationInput,
  CoreFunctionInvocationResult,
  CoreFunctionLogEntry,
} from "./functions-runtime.js";

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

export interface CoreFunctionRunRetryPolicy {
  preset?: "standard" | string;
  max_attempts?: number;
  min_delay_seconds?: number;
  max_delay_seconds?: number;
}

export interface CoreFunctionRunCreateInput {
  projectId: string;
  functionName: string;
  releaseId?: string | null;
  eventType: string;
  payload?: Record<string, unknown>;
  idempotencyKey: string;
  runAt?: string;
  delaySeconds?: number;
  expiresAt?: string;
  retry?: CoreFunctionRunRetryPolicy;
  source?: Record<string, unknown>;
}

export interface CoreFunctionRunAttempt {
  attempt_id: string;
  generation: number;
  number: number;
  status: "running" | "succeeded" | "failed";
  lease_token: string;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  response_status: number | null;
  error: CoreFunctionRunError | null;
}

export interface CoreFunctionRunError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface CoreFunctionRun {
  run_id: string;
  project_id: string;
  function_name: string;
  release_id: string | null;
  event_type: string;
  payload: Record<string, unknown>;
  idempotency_key: string;
  status: CoreFunctionRunStatus;
  terminal: boolean;
  generation: number;
  run_at: string;
  expires_at: string | null;
  source: Record<string, unknown>;
  attempts: {
    current: number;
    max: number;
    total: number;
    next_attempt_at: string | null;
  };
  last_attempt: CoreFunctionRunAttempt | null;
  last_error: CoreFunctionRunError | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface CoreFunctionRunServiceOptions {
  invoke(input: CoreFunctionInvocationInput): Promise<CoreFunctionInvocationResult>;
  listLogs?(input: {
    projectId: string;
    functionName?: string;
    requestId?: string;
    since?: string;
    tail?: number;
  }): Promise<CoreFunctionLogEntry[]>;
  now?: () => Date;
  limits?: Partial<{
    maxAttempts: number;
    maxDelaySeconds: number;
    leaseMs: number;
  }>;
}

const TERMINAL_STATUSES = new Set<CoreFunctionRunStatus>([
  "succeeded",
  "failed",
  "cancelled",
  "expired",
]);

const DEFAULT_LIMITS = {
  maxAttempts: 5,
  maxDelaySeconds: 90 * 24 * 60 * 60,
  leaseMs: 60_000,
};

function newId(prefix: "fnrun" | "fnatt"): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function iso(date: Date): string {
  return date.toISOString();
}

function parseIso(value: string, field: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`${field} must be an ISO-8601 timestamp.`);
  }
  return date;
}

function terminal(status: CoreFunctionRunStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

function boundedError(code: string, message: string, retryable: boolean): CoreFunctionRunError {
  return {
    code,
    message: message.length > 1000 ? `${message.slice(0, 997)}...` : message,
    retryable,
  };
}

function retryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function retryDelayMs(run: CoreFunctionRun): number {
  const retry = runRetry(run);
  const minSeconds = retry.min_delay_seconds ?? 30;
  const maxSeconds = retry.max_delay_seconds ?? 21_600;
  const attempt = Math.max(1, run.attempts.current);
  return Math.min(maxSeconds, minSeconds * 2 ** Math.max(0, attempt - 1)) * 1000;
}

function runRetry(run: CoreFunctionRun): CoreFunctionRunRetryPolicy {
  return (run as CoreFunctionRun & { retry_policy?: CoreFunctionRunRetryPolicy }).retry_policy ?? { preset: "standard" };
}

function cloneRun(run: CoreFunctionRun): CoreFunctionRun {
  return JSON.parse(JSON.stringify(run)) as CoreFunctionRun;
}

export class CoreFunctionRunService {
  readonly #runs = new Map<string, CoreFunctionRun>();
  readonly #idempotency = new Map<string, string>();
  readonly #attempts = new Map<string, CoreFunctionRunAttempt[]>();
  readonly #invoke: CoreFunctionRunServiceOptions["invoke"];
  readonly #listLogs: CoreFunctionRunServiceOptions["listLogs"];
  readonly #now: () => Date;
  readonly #limits: typeof DEFAULT_LIMITS;
  #timer: NodeJS.Timeout | null = null;
  #stopping = false;

  constructor(options: CoreFunctionRunServiceOptions) {
    this.#invoke = options.invoke;
    this.#listLogs = options.listLogs;
    this.#now = options.now ?? (() => new Date());
    this.#limits = { ...DEFAULT_LIMITS, ...options.limits };
  }

  create(input: CoreFunctionRunCreateInput): CoreFunctionRun {
    if (!input.eventType) throw new Error("eventType is required.");
    if (!input.idempotencyKey) throw new Error("idempotencyKey is required.");
    if (input.runAt && input.delaySeconds !== undefined) {
      throw new Error("runAt and delaySeconds are mutually exclusive.");
    }

    const now = this.#now();
    const runAt = input.runAt
      ? parseIso(input.runAt, "runAt")
      : new Date(now.getTime() + (input.delaySeconds ?? 0) * 1000);
    const expiresAt = input.expiresAt ? parseIso(input.expiresAt, "expiresAt") : null;
    if (expiresAt && expiresAt.getTime() <= runAt.getTime()) {
      throw new Error("expiresAt must be after runAt.");
    }
    if (runAt.getTime() - now.getTime() > this.#limits.maxDelaySeconds * 1000) {
      throw new Error(`Core function run delay exceeds host limit of ${this.#limits.maxDelaySeconds} seconds.`);
    }

    const idemKey = `${input.projectId}:${input.functionName}:${input.idempotencyKey}`;
    const existingId = this.#idempotency.get(idemKey);
    if (existingId) {
      const existing = this.#runs.get(existingId);
      if (existing) return cloneRun(existing);
    }

    const maxAttempts = Math.min(input.retry?.max_attempts ?? 5, this.#limits.maxAttempts);
    const run: CoreFunctionRun & { retry_policy?: CoreFunctionRunRetryPolicy } = {
      run_id: newId("fnrun"),
      project_id: input.projectId,
      function_name: input.functionName,
      release_id: input.releaseId ?? null,
      event_type: input.eventType,
      payload: input.payload ?? {},
      idempotency_key: input.idempotencyKey,
      status: runAt.getTime() > now.getTime() ? "scheduled" : "queued",
      terminal: false,
      generation: 1,
      run_at: iso(runAt),
      expires_at: expiresAt ? iso(expiresAt) : null,
      source: input.source ?? { type: "api" },
      attempts: {
        current: 0,
        max: maxAttempts,
        total: 0,
        next_attempt_at: iso(runAt),
      },
      last_attempt: null,
      last_error: null,
      created_at: iso(now),
      updated_at: iso(now),
      completed_at: null,
      retry_policy: { preset: "standard", ...input.retry, max_attempts: maxAttempts },
    };

    this.#runs.set(run.run_id, run);
    this.#idempotency.set(idemKey, run.run_id);
    this.#attempts.set(run.run_id, []);
    return cloneRun(run);
  }

  createFromScheduleTrigger(input: {
    projectId: string;
    functionName: string;
    releaseId?: string | null;
    trigger: FunctionScheduleTriggerSpec;
    scheduledAt: string;
    generation?: number;
  }): CoreFunctionRun {
    return this.create({
      projectId: input.projectId,
      functionName: input.functionName,
      releaseId: input.releaseId,
      eventType: input.trigger.run.event_type,
      payload: input.trigger.run.payload ?? {},
      idempotencyKey: `schedule:${input.projectId}:${input.functionName}:${input.generation ?? 1}:${input.trigger.id}:${input.scheduledAt}`,
      retry: input.trigger.run.retry as CoreFunctionRunRetryPolicy | undefined,
      expiresAt: input.trigger.run.expires_after_seconds
        ? iso(new Date(parseIso(input.scheduledAt, "scheduledAt").getTime() + input.trigger.run.expires_after_seconds * 1000))
        : undefined,
      source: {
        type: "schedule",
        trigger_id: input.trigger.id,
        scheduled_at: input.scheduledAt,
        generation: input.generation ?? 1,
      },
    });
  }

  get(projectId: string, runId: string): CoreFunctionRun | null {
    const run = this.#runs.get(runId);
    return run && run.project_id === projectId ? cloneRun(run) : null;
  }

  list(projectId: string, functionName?: string): CoreFunctionRun[] {
    return [...this.#runs.values()]
      .filter((run) => run.project_id === projectId && (!functionName || run.function_name === functionName))
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.run_id.localeCompare(b.run_id))
      .map(cloneRun);
  }

  cancel(projectId: string, runId: string): CoreFunctionRun {
    const run = this.#requireRun(projectId, runId);
    if (!terminal(run.status)) {
      const now = iso(this.#now());
      run.status = "cancelled";
      run.terminal = true;
      run.completed_at = now;
      run.updated_at = now;
    }
    return cloneRun(run);
  }

  redrive(projectId: string, runId: string, retry?: CoreFunctionRunRetryPolicy): CoreFunctionRun {
    const run = this.#requireRun(projectId, runId);
    if (run.status !== "failed" && run.status !== "cancelled" && run.status !== "expired") {
      throw new Error("Only failed, cancelled, or expired Core function runs can be redriven.");
    }
    const now = this.#now();
    run.status = new Date(run.run_at).getTime() > now.getTime() ? "scheduled" : "queued";
    run.terminal = false;
    run.generation += 1;
    run.attempts.current = 0;
    run.attempts.next_attempt_at = new Date(Math.max(new Date(run.run_at).getTime(), now.getTime())).toISOString();
    run.completed_at = null;
    run.updated_at = iso(now);
    if (retry) {
      (run as CoreFunctionRun & { retry_policy?: CoreFunctionRunRetryPolicy }).retry_policy = {
        preset: "standard",
        ...retry,
        max_attempts: Math.min(retry.max_attempts ?? run.attempts.max, this.#limits.maxAttempts),
      };
      run.attempts.max = (run as CoreFunctionRun & { retry_policy: CoreFunctionRunRetryPolicy }).retry_policy.max_attempts ?? run.attempts.max;
    }
    return cloneRun(run);
  }

  async logs(projectId: string, runId: string, options: { attemptId?: string; tail?: number; since?: string } = {}): Promise<CoreFunctionLogEntry[]> {
    const run = this.#requireRun(projectId, runId);
    return this.#listLogs?.({
      projectId,
      functionName: run.function_name,
      requestId: options.attemptId ?? run.run_id,
      tail: options.tail,
      since: options.since,
    }) ?? [];
  }

  async processOnce(): Promise<CoreFunctionRun | null> {
    const now = this.#now();
    this.#expireAndRecover(now);
    const run = [...this.#runs.values()]
      .filter((candidate) =>
        (candidate.status === "scheduled" || candidate.status === "queued" || candidate.status === "retrying") &&
        new Date(candidate.run_at).getTime() <= now.getTime() &&
        (!candidate.attempts.next_attempt_at || new Date(candidate.attempts.next_attempt_at).getTime() <= now.getTime()))
      .sort((a, b) => (a.attempts.next_attempt_at ?? a.run_at).localeCompare(b.attempts.next_attempt_at ?? b.run_at))[0];
    if (!run) return null;

    const attempt = this.#claim(run, now);
    try {
      const result = await this.#invoke(this.#invocationInput(run, attempt));
      this.#finalize(run, attempt, result.response.status, null);
    } catch (error) {
      this.#finalize(run, attempt, 500, boundedError(
        "CORE_FUNCTION_RUN_PLATFORM_ERROR",
        error instanceof Error ? error.message : String(error),
        true,
      ));
    }
    return cloneRun(run);
  }

  start(intervalMs = 1000): void {
    if (this.#timer) return;
    this.#stopping = false;
    this.#timer = setInterval(() => {
      if (!this.#stopping) void this.processOnce();
    }, intervalMs);
  }

  stop(): void {
    this.#stopping = true;
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  #requireRun(projectId: string, runId: string): CoreFunctionRun {
    const run = this.#runs.get(runId);
    if (!run || run.project_id !== projectId) throw new Error("Core function run not found.");
    return run;
  }

  #claim(run: CoreFunctionRun, now: Date): CoreFunctionRunAttempt {
    const attempt: CoreFunctionRunAttempt = {
      attempt_id: newId("fnatt"),
      generation: run.generation,
      number: run.attempts.current + 1,
      status: "running",
      lease_token: randomUUID(),
      started_at: iso(now),
      completed_at: null,
      duration_ms: null,
      response_status: null,
      error: null,
    };
    run.status = "running";
    run.attempts.current += 1;
    run.attempts.total += 1;
    run.last_attempt = attempt;
    run.updated_at = iso(now);
    (run as CoreFunctionRun & { lease_expires_at?: string }).lease_expires_at = iso(new Date(now.getTime() + this.#limits.leaseMs));
    this.#attempts.get(run.run_id)?.push(attempt);
    return attempt;
  }

  #finalize(run: CoreFunctionRun, attempt: CoreFunctionRunAttempt, status: number, error: CoreFunctionRunError | null): void {
    const now = this.#now();
    const retryable = error?.retryable ?? retryableStatus(status);
    const attemptsRemain = run.attempts.current < run.attempts.max;
    attempt.status = status >= 200 && status < 300 && !error ? "succeeded" : "failed";
    attempt.completed_at = iso(now);
    attempt.duration_ms = now.getTime() - new Date(attempt.started_at).getTime();
    attempt.response_status = status;
    attempt.error = error ?? (attempt.status === "failed"
      ? boundedError(`CORE_FUNCTION_RUN_HTTP_${status}`, `Core function run attempt returned HTTP ${status}.`, retryable)
      : null);
    run.last_attempt = attempt;
    run.last_error = attempt.error;
    run.updated_at = iso(now);
    delete (run as CoreFunctionRun & { lease_expires_at?: string }).lease_expires_at;

    if (attempt.status === "succeeded") {
      run.status = "succeeded";
      run.terminal = true;
      run.completed_at = iso(now);
      run.attempts.next_attempt_at = null;
      return;
    }
    if (retryable && attemptsRemain) {
      run.status = "retrying";
      run.terminal = false;
      run.attempts.next_attempt_at = iso(new Date(now.getTime() + retryDelayMs(run)));
      return;
    }
    run.status = "failed";
    run.terminal = true;
    run.completed_at = iso(now);
    run.attempts.next_attempt_at = null;
  }

  #expireAndRecover(now: Date): void {
    for (const run of this.#runs.values()) {
      if (!terminal(run.status) && run.expires_at && new Date(run.expires_at).getTime() <= now.getTime()) {
        run.status = "expired";
        run.terminal = true;
        run.completed_at = iso(now);
        run.updated_at = iso(now);
        run.last_error = boundedError("CORE_FUNCTION_RUN_EXPIRED", "Core function run expired before execution.", false);
        continue;
      }
      const leaseExpiresAt = (run as CoreFunctionRun & { lease_expires_at?: string }).lease_expires_at;
      if (run.status === "running" && leaseExpiresAt && new Date(leaseExpiresAt).getTime() <= now.getTime()) {
        run.status = run.attempts.current < run.attempts.max ? "retrying" : "failed";
        run.terminal = run.status === "failed";
        run.attempts.next_attempt_at = run.status === "retrying" ? iso(now) : null;
        run.completed_at = run.status === "failed" ? iso(now) : null;
        run.updated_at = iso(now);
        run.last_error = boundedError("CORE_FUNCTION_RUN_LEASE_EXPIRED", "Core function run lease expired before finalization.", run.status === "retrying");
        delete (run as CoreFunctionRun & { lease_expires_at?: string }).lease_expires_at;
      }
    }
  }

  #invocationInput(run: CoreFunctionRun, attempt: CoreFunctionRunAttempt): CoreFunctionInvocationInput {
    const body = Buffer.from(JSON.stringify({
      trigger: "function_run",
      run_id: run.run_id,
      generation: run.generation,
      event_type: run.event_type,
      idempotency_key: run.idempotency_key,
      run_at: run.run_at,
      attempt: {
        attempt_id: attempt.attempt_id,
        number: attempt.number,
        max: run.attempts.max,
      },
      source: run.source,
      payload: run.payload,
    }), "utf8");
    return {
      projectId: run.project_id,
      releaseId: run.release_id,
      functionName: run.function_name,
      invocationKind: "function_run",
      requestId: run.run_id,
      request: {
        version: "run402.routed_http.v1",
        method: "POST",
        url: `run402://function-runs/${run.function_name}`,
        path: `/functions/v1/${run.function_name}`,
        rawPath: `/functions/v1/${run.function_name}`,
        rawQuery: "",
        headers: [
          ["content-type", "application/json"],
          ["x-run402-trigger", "function_run"],
          ["x-run402-run-id", run.run_id],
          ["x-run402-request-id", run.run_id],
          ["x-run402-attempt-id", attempt.attempt_id],
          ["x-run402-idempotency-key", run.idempotency_key],
        ],
        cookies: { raw: null },
        body: { encoding: "base64", data: body.toString("base64"), size: body.byteLength },
        context: {
          source: "route",
          projectId: run.project_id,
          releaseId: run.release_id,
          deploymentId: null,
          host: "localhost",
          proto: "http",
          routePattern: `/functions/v1/${run.function_name}`,
          routeKind: "exact",
          routeTarget: { type: "function", name: run.function_name },
          requestId: run.run_id,
        },
      },
    };
  }
}
