import { config } from "./config.js";
import {
  requireActiveContext,
  Run402OutsideRequestContextError,
  type RunRequestContext,
} from "./runtime-context.js";

export type FunctionRunStatus =
  | "scheduled"
  | "queued"
  | "running"
  | "retrying"
  | "blocked"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired";

export interface FunctionRunAttemptEnvelope {
  attempt_id: string;
  number: number;
  max: number;
}

export interface FunctionRunSource {
  type: string;
  [key: string]: unknown;
}

export interface FunctionRunEnvelope<Payload extends Record<string, unknown> = Record<string, unknown>> {
  trigger: "function_run";
  run_id: string;
  generation: number;
  event_type: string;
  idempotency_key: string;
  run_at: string;
  attempt: FunctionRunAttemptEnvelope;
  source: FunctionRunSource;
  payload: Payload;
}

export interface FunctionRunHandle {
  run_id: string;
  function_name: string;
  event_type: string;
  status: FunctionRunStatus;
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
    error?: FunctionRunErrorInfo;
  };
  last_error?: FunctionRunErrorInfo;
  created_at: string;
  updated_at: string;
  completed_at?: string;
  deduplicated?: boolean;
  next_actions: Array<Record<string, unknown>>;
}

export interface FunctionRunErrorInfo {
  code: string;
  message: string;
  retryable: boolean;
}

export interface FunctionRunRetryPolicy {
  preset?: "standard" | string;
  maxAttempts?: number;
  max_attempts?: number;
  minDelaySeconds?: number;
  min_delay_seconds?: number;
  maxDelaySeconds?: number;
  max_delay_seconds?: number;
  [key: string]: unknown;
}

export interface FunctionRunCreateOptions<Payload extends Record<string, unknown> = Record<string, unknown>> {
  eventType: string;
  payload?: Payload;
  idempotencyKey?: string;
  runAt?: string | Date;
  delay?: string | number;
  delaySeconds?: number;
  expiresAt?: string | Date;
  expiresAfter?: string | number;
  retry?: FunctionRunRetryPolicy;
}

interface GatewayCreateBody {
  event_type: string;
  payload?: Record<string, unknown>;
  idempotency_key: string;
  run_at?: string;
  delay_seconds?: number;
  expires_at?: string;
  retry?: Record<string, unknown>;
}

export class Run402FunctionRunInputError extends Error {
  readonly code = "R402_FUNCTION_RUN_INVALID_INPUT";
  readonly field?: string;

  constructor(message: string, field?: string) {
    super(message);
    this.name = "Run402FunctionRunInputError";
    this.field = field;
  }
}

export class Run402FunctionRunContextError extends Error {
  readonly code = "R402_FUNCTION_RUN_MISSING_CONTEXT";

  constructor(message = "functions.runs.create requires an active Run402 function context.") {
    super(message);
    this.name = "Run402FunctionRunContextError";
  }
}

export class Run402FunctionRunPlatformError extends Error {
  readonly code: string;
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.name = "Run402FunctionRunPlatformError";
    this.status = status;
    this.body = body;
    this.code = platformCode(body);
  }
}

export class Run402FunctionRunFailure extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    options: {
      code: string;
      retryable: boolean;
      status: number;
      details?: Record<string, unknown>;
    },
  ) {
    super(message);
    this.name = "Run402FunctionRunFailure";
    this.code = options.code;
    this.retryable = options.retryable;
    this.status = options.status;
    this.details = options.details;
  }
}

export function permanentFunctionRunError(
  message: string,
  code = "function_run_permanent_error",
  details?: Record<string, unknown>,
): Run402FunctionRunFailure {
  return new Run402FunctionRunFailure(message, {
    code,
    retryable: false,
    status: 400,
    details,
  });
}

export function retryableFunctionRunError(
  message: string,
  code = "function_run_retryable_error",
  details?: Record<string, unknown>,
): Run402FunctionRunFailure {
  return new Run402FunctionRunFailure(message, {
    code,
    retryable: true,
    status: 500,
    details,
  });
}

export function isFunctionRun(input: unknown): input is FunctionRunEnvelope {
  try {
    parseFunctionRunEnvelope(input);
    return true;
  } catch {
    return false;
  }
}

export function parseFunctionRunEnvelope(input: unknown): FunctionRunEnvelope {
  const value = record(input, "function run envelope");
  if (value.trigger !== "function_run") {
    throw new Run402FunctionRunInputError("function run envelope trigger must be \"function_run\".", "trigger");
  }
  const attempt = record(value.attempt, "attempt");
  const source = record(value.source, "source");
  const payload = value.payload === undefined ? {} : record(value.payload, "payload");
  const envelope: FunctionRunEnvelope = {
    trigger: "function_run",
    run_id: stringField(value.run_id, "run_id"),
    generation: positiveInteger(value.generation, "generation"),
    event_type: stringField(value.event_type, "event_type"),
    idempotency_key: stringField(value.idempotency_key, "idempotency_key"),
    run_at: isoStringField(value.run_at, "run_at"),
    attempt: {
      attempt_id: stringField(attempt.attempt_id, "attempt.attempt_id"),
      number: positiveInteger(attempt.number, "attempt.number"),
      max: positiveInteger(attempt.max, "attempt.max"),
    },
    source: {
      ...source,
      type: stringField(source.type, "source.type"),
    },
    payload,
  };
  return envelope;
}

export async function parseFunctionRun(input: unknown): Promise<FunctionRunEnvelope> {
  if (isRequestLike(input)) {
    let body: unknown;
    try {
      body = await input.json();
    } catch (err) {
      throw new Run402FunctionRunInputError(
        `function run request body must be JSON: ${err instanceof Error ? err.message : String(err)}`,
        "body",
      );
    }
    return parseFunctionRunEnvelope(body);
  }
  return parseFunctionRunEnvelope(input);
}

export interface FunctionRunHandlerContext<Payload extends Record<string, unknown> = Record<string, unknown>> {
  run: {
    id: string;
    generation: number;
    eventType: string;
    event_type: string;
    runAt: string;
    run_at: string;
    source: FunctionRunSource;
    envelope: FunctionRunEnvelope<Payload>;
  };
  attempt: {
    id: string;
    attempt_id: string;
    number: number;
    max: number;
  };
  idempotency: {
    key: string;
    fromParts: (...parts: Array<string | number | boolean | null | undefined>) => string;
  };
  functions: typeof functions;
}

type MaybePromise<T> = T | Promise<T>;

export interface FunctionRunPayloadParser<Payload> {
  parse(value: unknown): Payload;
}

export interface FunctionRunSafePayloadParser<Payload> {
  safeParse(value: unknown):
    | { success: true; data: Payload }
    | { success: false; error: unknown };
}

export type FunctionRunPayloadValidator<Payload> =
  | FunctionRunPayloadParser<Payload>
  | FunctionRunSafePayloadParser<Payload>
  | ((value: unknown) => Payload);

export interface FunctionRunHandlerDefinition<Payload extends Record<string, unknown> = Record<string, unknown>> {
  payload?: FunctionRunPayloadValidator<Payload>;
  run(
    ctx: FunctionRunHandlerContext<Payload>,
    payload: Payload,
    envelope: FunctionRunEnvelope<Payload>,
  ): MaybePromise<void | Response | Record<string, unknown> | null | undefined>;
}

export type FunctionRunHandler<Payload extends Record<string, unknown> = Record<string, unknown>> =
  | FunctionRunHandlerDefinition<Payload>
  | ((
      ctx: FunctionRunHandlerContext<Payload>,
      payload: Payload,
      envelope: FunctionRunEnvelope<Payload>,
    ) => MaybePromise<void | Response | Record<string, unknown> | null | undefined>);

export type FunctionRunHandlers = Record<string, FunctionRunHandler<Record<string, unknown>>>;

export function defineFunctionRuns(
  handlers: FunctionRunHandlers,
): (input: unknown) => Promise<Response> {
  return async (input: unknown): Promise<Response> => {
    let envelope: FunctionRunEnvelope;
    try {
      envelope = await parseFunctionRun(input);
    } catch (err) {
      return errorResponse("function_run_invalid_envelope", err, 400, false);
    }

    const handler = handlers[envelope.event_type];
    if (!handler) {
      return jsonResponse({
        error: "function_run_unknown_event",
        message: `No handler is registered for function run event_type \"${envelope.event_type}\".`,
        event_type: envelope.event_type,
        retryable: false,
      }, 400);
    }

    let payload: Record<string, unknown>;
    try {
      payload = parsePayload(handler, envelope.payload);
    } catch (err) {
      return errorResponse("function_run_invalid_payload", err, 400, false);
    }

    try {
      const ctx = handlerContext(envelope as FunctionRunEnvelope<Record<string, unknown>>);
      const result = typeof handler === "function"
        ? await handler(ctx, payload, envelope)
        : await handler.run(ctx, payload, envelope);
      return normalizeHandlerResult(result);
    } catch (err) {
      if (err instanceof Run402FunctionRunFailure) {
        return jsonResponse({
          error: err.code,
          message: err.message,
          retryable: err.retryable,
          ...(err.details ? { details: err.details } : {}),
        }, err.status);
      }
      throw err;
    }
  };
}

async function createFunctionRun<Payload extends Record<string, unknown> = Record<string, unknown>>(
  functionName: string,
  options: FunctionRunCreateOptions<Payload>,
): Promise<FunctionRunHandle> {
  const ctx = requireFunctionRunContext();
  const body = normalizeCreateBody(options);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.SERVICE_KEY}`,
    "Content-Type": "application/json",
    "Idempotency-Key": body.idempotency_key,
  };
  const parentRunId = readHeader(ctx.request.headers, "x-run402-run-id");
  const parentAttemptId = readHeader(ctx.request.headers, "x-run402-attempt-id");
  if (parentRunId) headers["X-Run402-Parent-Run-Id"] = parentRunId;
  if (parentAttemptId) headers["X-Run402-Parent-Attempt-Id"] = parentAttemptId;

  const res = await fetch(
    `${config.API_BASE}/functions/v1/${encodeURIComponent(functionName)}/runs`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    const errorBody = await readErrorBody(res);
    throw new Run402FunctionRunPlatformError(
      res.status,
      errorBody,
      `Function run creation failed (${res.status}): ${platformMessage(errorBody)}`,
    );
  }
  return res.json() as Promise<FunctionRunHandle>;
}

export const functions = {
  isFunctionRun,
  parseFunctionRun,
  parseFunctionRunEnvelope,
  idempotency: {
    fromParts,
  },
  runs: {
    create: createFunctionRun,
  },
};

function handlerContext<Payload extends Record<string, unknown>>(
  envelope: FunctionRunEnvelope<Payload>,
): FunctionRunHandlerContext<Payload> {
  return {
    run: {
      id: envelope.run_id,
      generation: envelope.generation,
      eventType: envelope.event_type,
      event_type: envelope.event_type,
      runAt: envelope.run_at,
      run_at: envelope.run_at,
      source: envelope.source,
      envelope,
    },
    attempt: {
      id: envelope.attempt.attempt_id,
      attempt_id: envelope.attempt.attempt_id,
      number: envelope.attempt.number,
      max: envelope.attempt.max,
    },
    idempotency: {
      key: envelope.idempotency_key,
      fromParts,
    },
    functions,
  };
}

function parsePayload(
  handler: FunctionRunHandler<Record<string, unknown>>,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (typeof handler === "function" || !handler.payload) return payload;
  const validator = handler.payload;
  if (typeof validator === "function") {
    return record(validator(payload), "payload");
  }
  if ("safeParse" in validator && typeof validator.safeParse === "function") {
    const result = validator.safeParse(payload);
    if (result.success) return record(result.data, "payload");
    throw new Error(schemaErrorMessage(result.error));
  }
  if (!("parse" in validator) || typeof validator.parse !== "function") {
    throw new Error("payload validator must expose parse(value) or safeParse(value)");
  }
  return record(validator.parse(payload), "payload");
}

function normalizeHandlerResult(
  result: void | Response | Record<string, unknown> | null | undefined,
): Response {
  if (result instanceof Response) return result;
  if (result === undefined || result === null) return new Response(null, { status: 204 });
  return jsonResponse(result, 200);
}

function normalizeCreateBody<Payload extends Record<string, unknown>>(
  options: FunctionRunCreateOptions<Payload>,
): GatewayCreateBody {
  if (!options || typeof options !== "object") {
    throw new Run402FunctionRunInputError("function run options are required");
  }
  if (typeof options.eventType !== "string" || options.eventType.trim() === "") {
    throw new Run402FunctionRunInputError("eventType is required", "eventType");
  }
  if (typeof options.idempotencyKey !== "string" || options.idempotencyKey.trim() === "") {
    throw new Run402FunctionRunInputError("idempotencyKey is required", "idempotencyKey");
  }
  const hasDelay = options.delay !== undefined || options.delaySeconds !== undefined;
  if (hasDelay && options.runAt !== undefined) {
    throw new Run402FunctionRunInputError("runAt and delay are mutually exclusive", "runAt");
  }
  if (options.delay !== undefined && options.delaySeconds !== undefined) {
    throw new Run402FunctionRunInputError("delay and delaySeconds are mutually exclusive", "delay");
  }

  const body: GatewayCreateBody = {
    event_type: options.eventType.trim(),
    idempotency_key: options.idempotencyKey,
  };
  if (options.payload !== undefined) body.payload = record(options.payload, "payload");
  if (options.runAt !== undefined) body.run_at = isoFromDateInput(options.runAt, "runAt");
  if (options.delay !== undefined) body.delay_seconds = durationSeconds(options.delay, "delay");
  if (options.delaySeconds !== undefined) body.delay_seconds = durationSeconds(options.delaySeconds, "delaySeconds");
  if (options.expiresAt !== undefined) body.expires_at = isoFromDateInput(options.expiresAt, "expiresAt");
  if (options.expiresAfter !== undefined) {
    const seconds = durationSeconds(options.expiresAfter, "expiresAfter");
    body.expires_at = new Date(Date.now() + seconds * 1000).toISOString();
  }
  if (body.expires_at !== undefined) {
    const runAtMs = body.run_at ? Date.parse(body.run_at) : Date.now() + (body.delay_seconds ?? 0) * 1000;
    if (Date.parse(body.expires_at) <= runAtMs) {
      throw new Run402FunctionRunInputError("expiresAt/expiresAfter must be after the run time", "expiresAt");
    }
  }
  if (options.retry !== undefined) body.retry = normalizeRetry(options.retry);
  return body;
}

function normalizeRetry(retry: FunctionRunRetryPolicy): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries({
      ...retry,
      ...(retry.maxAttempts !== undefined ? { max_attempts: retry.maxAttempts } : {}),
      ...(retry.minDelaySeconds !== undefined ? { min_delay_seconds: retry.minDelaySeconds } : {}),
      ...(retry.maxDelaySeconds !== undefined ? { max_delay_seconds: retry.maxDelaySeconds } : {}),
    }).filter(([key]) => key !== "maxAttempts" && key !== "minDelaySeconds" && key !== "maxDelaySeconds"),
  );
}

function requireFunctionRunContext(): RunRequestContext {
  let ctx: RunRequestContext;
  try {
    ctx = requireActiveContext("functions.runs.create");
  } catch (err) {
    if (err instanceof Run402OutsideRequestContextError) {
      throw new Run402FunctionRunContextError();
    }
    throw err;
  }
  if (!ctx.projectId) {
    throw new Run402FunctionRunContextError("functions.runs.create requires a project id in the active Run402 context.");
  }
  if (!config.SERVICE_KEY) {
    throw new Run402FunctionRunContextError("functions.runs.create requires the Run402 runtime service capability.");
  }
  return ctx;
}

function fromParts(...parts: Array<string | number | boolean | null | undefined>): string {
  const cleaned = parts
    .filter((part) => part !== undefined && part !== null && String(part).trim() !== "")
    .map((part) => encodeURIComponent(String(part)));
  if (cleaned.length === 0) {
    throw new Run402FunctionRunInputError("at least one idempotency part is required", "idempotency");
  }
  return cleaned.join(":");
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Run402FunctionRunInputError(`${field} must be a JSON object`, field);
  }
  return value as Record<string, unknown>;
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Run402FunctionRunInputError(`${field} must be a non-empty string`, field);
  }
  return value;
}

function isoStringField(value: unknown, field: string): string {
  const raw = stringField(value, field);
  if (!Number.isFinite(Date.parse(raw))) {
    throw new Run402FunctionRunInputError(`${field} must be an ISO-8601 timestamp`, field);
  }
  return new Date(raw).toISOString();
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new Run402FunctionRunInputError(`${field} must be a positive integer`, field);
  }
  return Number(value);
}

function isoFromDateInput(value: string | Date, field: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Run402FunctionRunInputError(`${field} must be an ISO-8601 timestamp`, field);
  }
  return date.toISOString();
}

function durationSeconds(value: string | number, field: string): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw new Run402FunctionRunInputError(`${field} must be a non-negative duration`, field);
    }
    return Math.ceil(value);
  }
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)$/i);
  if (!match) {
    throw new Run402FunctionRunInputError(`${field} must be a duration such as "10m", "1h", or "3d"`, field);
  }
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier =
    unit.startsWith("ms") ? 0.001 :
    unit.startsWith("s") ? 1 :
    unit.startsWith("m") ? 60 :
    unit.startsWith("h") ? 3600 :
    86400;
  return Math.ceil(amount * multiplier);
}

function jsonResponse(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function errorResponse(error: string, err: unknown, status: number, retryable: boolean): Response {
  return jsonResponse({
    error,
    message: err instanceof Error ? err.message : String(err),
    retryable,
  }, status);
}

function isRequestLike(input: unknown): input is { json(): Promise<unknown> } {
  return typeof input === "object" &&
    input !== null &&
    typeof (input as { json?: unknown }).json === "function" &&
    typeof (input as { headers?: unknown }).headers === "object";
}

function readHeader(
  headers: RunRequestContext["request"]["headers"],
  name: string,
): string | undefined {
  const maybeHeaders = headers as unknown as { get?: (header: string) => string | null };
  if (typeof maybeHeaders.get === "function") {
    return maybeHeaders.get(name) ?? maybeHeaders.get(name.toLowerCase()) ?? undefined;
  }
  const lookup = (headers as Record<string, string | string[] | undefined>);
  const direct = lookup[name] ?? lookup[name.toLowerCase()];
  return Array.isArray(direct) ? direct[0] : direct;
}

async function readErrorBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text };
  }
}

function platformCode(body: unknown): string {
  if (body && typeof body === "object") {
    const recordBody = body as Record<string, unknown>;
    const code = recordBody.code ?? recordBody.error;
    if (typeof code === "string" && code.trim() !== "") return code;
  }
  return "function_run_platform_error";
}

function platformMessage(body: unknown): string {
  if (body && typeof body === "object") {
    const recordBody = body as Record<string, unknown>;
    const message = recordBody.message ?? recordBody.error;
    if (typeof message === "string" && message.trim() !== "") return message;
  }
  return "Run402 rejected the function run request.";
}

function schemaErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error);
}
