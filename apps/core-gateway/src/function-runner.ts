import { Buffer } from "node:buffer";
import { pathToFileURL } from "node:url";
import {
  runWithContext,
  type RoutedHttpHeaderList,
  type RoutedHttpRequestV1,
  type RoutedHttpResponseV1,
} from "@run402/functions";
import type {
  CoreFunctionInvocationInput,
  CoreFunctionLogEntry,
} from "@run402/runtime-kernel";

interface RunnerPayload {
  module_path: string;
  entrypoint: string;
  invocation: CoreFunctionInvocationInput;
  env: Record<string, string>;
  response_body_limit_bytes: number;
  stdout_stderr_limit_bytes: number;
  max_log_line_bytes: number;
}

interface RunnerOutput {
  ok: boolean;
  response?: RoutedHttpResponseV1;
  logs: CoreFunctionLogEntry[];
  error?: {
    message: string;
    code: string;
    stack?: string;
  };
}

const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const logs: CoreFunctionLogEntry[] = [];
let payload: RunnerPayload | null = null;

installLogCapture("stdout");
installLogCapture("stderr");

main().catch((error: unknown) => {
  writeControl({
    ok: false,
    logs,
    error: {
      code: "runner_uncaught",
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
    },
  });
  process.exitCode = 0;
});

async function main(): Promise<void> {
  payload = JSON.parse(await readStdin()) as RunnerPayload;
  for (const [name, value] of Object.entries(payload.env)) {
    process.env[name] = value;
  }

  const moduleUrl = pathToFileURL(payload.module_path).href;
  const mod = await import(moduleUrl);
  const handler = selectHandler(mod, payload.entrypoint);
  const value = await runWithContext(contextFromInvocation(payload.invocation), async () => {
    return await handler(payload?.invocation.request ?? payload?.invocation);
  });
  const response = await normalizeResponse(value);
  enforceResponseLimit(response, payload.response_body_limit_bytes);
  writeControl({
    ok: true,
    response,
    logs,
  });
}

function selectHandler(mod: Record<string, unknown>, entrypoint: string): (event: unknown) => Promise<unknown> | unknown {
  const candidate = entrypoint === "default"
    ? mod.default ?? mod.handler
    : mod[entrypoint];
  if (typeof candidate !== "function") {
    throw new Error(`Function entrypoint not found: ${entrypoint}`);
  }
  return candidate as (event: unknown) => Promise<unknown> | unknown;
}

async function normalizeResponse(value: unknown): Promise<RoutedHttpResponseV1> {
  if (isRoutedResponse(value)) return value;
  if (value instanceof Response) {
    const bytes = Buffer.from(await value.arrayBuffer());
    return {
      status: value.status,
      headers: headersToList(value.headers),
      body: {
        encoding: "base64",
        data: bytes.toString("base64"),
        size: bytes.byteLength,
      },
    };
  }
  const bytes = Buffer.from(JSON.stringify(value ?? null), "utf8");
  return {
    status: 200,
    headers: [["content-type", "application/json; charset=utf-8"]],
    body: {
      encoding: "base64",
      data: bytes.toString("base64"),
      size: bytes.byteLength,
    },
  };
}

function isRoutedResponse(value: unknown): value is RoutedHttpResponseV1 {
  return typeof value === "object" &&
    value !== null &&
    typeof (value as { status?: unknown }).status === "number";
}

function enforceResponseLimit(response: RoutedHttpResponseV1, limitBytes: number): void {
  if ((response.body?.size ?? 0) > limitBytes) {
    throw new Error(`Function response body exceeds ${limitBytes} bytes.`);
  }
}

function contextFromInvocation(invocation: CoreFunctionInvocationInput) {
  const request = invocation.request;
  const headers = headersRecord(request?.headers ?? []);
  return {
    requestId: invocation.requestId,
    projectId: invocation.projectId,
    releaseId: invocation.releaseId ?? "",
    locale: request?.context.locale ?? null,
    defaultLocale: request?.context.defaultLocale ?? null,
    host: request?.context.host ?? "localhost",
    request: {
      method: request?.method ?? "POST",
      url: request?.url ?? "run402://direct",
      headers,
    },
    actor: null,
    invocationKind: invocation.invocationKind,
  };
}

function headersRecord(headers: RoutedHttpHeaderList): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = {};
  for (const [name, value] of headers) {
    const key = name.toLowerCase();
    const existing = out[key];
    if (existing === undefined) {
      out[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      out[key] = [existing, value];
    }
  }
  return out;
}

function headersToList(headers: Headers): RoutedHttpHeaderList {
  return [...headers.entries()];
}

function installLogCapture(stream: "stdout" | "stderr"): void {
  const target = stream === "stdout" ? process.stdout : process.stderr;
  const original = target.write.bind(target);
  target.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
    appendLog(stream, chunk);
    const cb = typeof encoding === "function" ? encoding : callback;
    if (cb) queueMicrotask(() => cb());
    return true;
  }) as typeof target.write;
  if (stream === "stderr") {
    process.on("warning", (warning) => {
      original(`${warning.name}: ${warning.message}\n`);
    });
  }
}

function appendLog(stream: "stdout" | "stderr", chunk: string | Uint8Array): void {
  const currentPayload = payload;
  if (!currentPayload) return;
  const raw = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
  const max = currentPayload.max_log_line_bytes;
  const message = raw.length > max ? `${raw.slice(0, max)}...[truncated]` : raw;
  const used = logs.reduce((sum, entry) => sum + Buffer.byteLength(entry.message), 0);
  if (used >= currentPayload.stdout_stderr_limit_bytes) return;
  logs.push({
    timestamp: new Date().toISOString(),
    request_id: currentPayload.invocation.requestId,
    project_id: currentPayload.invocation.projectId,
    release_id: currentPayload.invocation.releaseId,
    function_name: currentPayload.invocation.functionName,
    stream,
    level: stream === "stderr" ? "error" : "info",
    message,
    redacted: false,
  });
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      input += chunk;
    });
    process.stdin.on("error", reject);
    process.stdin.on("end", () => resolve(input));
  });
}

function writeControl(output: RunnerOutput): void {
  originalStdoutWrite(`${JSON.stringify(output)}\n`);
}
