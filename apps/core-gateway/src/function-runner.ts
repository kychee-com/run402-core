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
  function_class: "standard" | "ssr";
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
  const currentPayload = JSON.parse(await readStdin()) as RunnerPayload;
  payload = currentPayload;
  for (const [name, value] of Object.entries(currentPayload.env)) {
    process.env[name] = value;
  }

  const moduleUrl = pathToFileURL(currentPayload.module_path).href;
  const mod = await import(moduleUrl);
  const handler = selectHandler(mod, currentPayload.entrypoint);
  const value = await runWithContext(contextFromInvocation(currentPayload.invocation), async () => {
    return await handler(handlerInput(currentPayload));
  });
  const response = await normalizeResponse(value);
  writeControl({
    ok: true,
    response,
    logs,
  });
}

function handlerInput(current: RunnerPayload): unknown {
  if (!current.invocation.request) {
    if (current.function_class === "ssr") {
      throw new Error("Astro SSR invocation requires routed HTTP request metadata.");
    }
    return current.invocation;
  }
  return webRequestFromRouted(current.invocation.request);
}

function webRequestFromRouted(request: RoutedHttpRequestV1): Request {
  const init: RequestInit = {
    method: request.method,
    headers: new Headers(request.headers),
  };
  if (request.method !== "GET" && request.method !== "HEAD" && request.body) {
    init.body = Buffer.from(request.body.data, "base64");
  }
  const webRequest = new Request(request.url, init);
  Object.defineProperties(webRequest, {
    version: { value: request.version, enumerable: true },
    path: { value: request.path, enumerable: true },
    rawQuery: { value: request.rawQuery, enumerable: true },
    cookies: { value: request.cookies, enumerable: true },
    context: { value: request.context, enumerable: true },
    routedBody: { value: request.body, enumerable: true },
  });
  return webRequest;
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
  if (value instanceof Response) {
    const bytes = Buffer.from(await value.arrayBuffer());
    const responseHeaders = responseHeadersToList(value.headers);
    return {
      status: value.status,
      headers: responseHeaders.headers,
      cookies: responseHeaders.cookies,
      body: {
        encoding: "base64",
        data: bytes.toString("base64"),
        size: bytes.byteLength,
      },
    };
  }
  if (isRoutedResponse(value)) return value;
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

function contextFromInvocation(invocation: CoreFunctionInvocationInput) {
  const request = invocation.request;
  const headers = headersRecord(request?.headers ?? []);
  if (invocation.actor) {
    headers["x-run402-user-id"] = invocation.actor.id;
    if (invocation.actor.role) headers["x-run402-user-role"] = invocation.actor.role;
  }
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
    actor: invocation.actor ? {
      id: invocation.actor.id,
      projectId: invocation.projectId,
      sessionId: `local:${invocation.actor.id}`,
      email: "",
      emailVerified: false,
      authTime: Math.floor(Date.now() / 1000),
      authzVersion: 0,
      amr: [],
      amrTimes: {},
    } : null,
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

function responseHeadersToList(headers: Headers): { headers: RoutedHttpHeaderList; cookies: string[] } {
  const out: RoutedHttpHeaderList = [];
  const cookies: string[] = [];
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const setCookies = typeof getSetCookie === "function" ? getSetCookie.call(headers) : [];
  for (const [name, value] of headers.entries()) {
    if (name.toLowerCase() === "set-cookie") {
      if (setCookies.length === 0) cookies.push(value);
      continue;
    }
    out.push([name, value]);
  }
  cookies.push(...setCookies);
  return { headers: out, cookies };
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
  const message = truncateUtf8(raw, currentPayload.max_log_line_bytes);
  const used = logs.reduce((sum, entry) => sum + Buffer.byteLength(entry.message), 0);
  const remaining = currentPayload.stdout_stderr_limit_bytes - used;
  if (remaining <= 0) return;
  const cappedMessage = truncateUtf8(message, remaining);
  if (!cappedMessage) return;
  logs.push({
    timestamp: new Date().toISOString(),
    request_id: currentPayload.invocation.requestId,
    project_id: currentPayload.invocation.projectId,
    release_id: currentPayload.invocation.releaseId,
    function_name: currentPayload.invocation.functionName,
    stream,
    level: stream === "stderr" ? "error" : "info",
    message: cappedMessage,
    redacted: false,
  });
}

function truncateUtf8(value: string, maxBytes: number): string {
  const suffix = "...[truncated]";
  if (Buffer.byteLength(value) <= maxBytes) return value;
  const suffixBytes = Buffer.byteLength(suffix);
  if (maxBytes <= suffixBytes) return "";
  const contentLimit = maxBytes - suffixBytes;
  let output = "";
  let used = 0;
  for (const char of value) {
    const next = Buffer.byteLength(char);
    if (used + next > contentLimit) break;
    output += char;
    used += next;
  }
  return `${output}${suffix}`;
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
