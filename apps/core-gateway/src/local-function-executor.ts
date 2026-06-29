import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CORE_FUNCTION_RESOURCE_DEFAULTS,
  DynamicRuntimeBusyError,
  DynamicRuntimeTimeoutError,
  LocalExecutorError,
  ResponseBodyTooLargeError,
  verifyContentRefBytes,
  type ContentStorePort,
  type CoreFunctionBundleMetadata,
  type CoreFunctionInvocationInput,
  type CoreFunctionInvocationResult,
  type CoreFunctionLogEntry,
} from "@run402/runtime-kernel";

export interface LocalFunctionExecutorInput extends CoreFunctionInvocationInput {
  bundle: CoreFunctionBundleMetadata;
  secrets?: Record<string, string>;
  run402Env?: {
    apiBaseUrl: string;
    anonKey: string;
    serviceKey: string;
    jwtSecret?: string;
  };
}

export interface LocalFunctionExecutorResult extends CoreFunctionInvocationResult {
  duration_ms: number;
  logs: CoreFunctionLogEntry[];
}

export interface LocalFunctionExecutorOptions {
  content: ContentStorePort;
  workDir: string;
  runnerPath?: string;
  invocationTimeoutMs?: number;
  responseBodyLimitBytes?: number;
  maxConcurrentInvocations?: number;
  maxPendingInvocations?: number;
  nodeExecArgv?: string[];
}

interface RunnerPayload {
  module_path: string;
  entrypoint: string;
  function_class: CoreFunctionBundleMetadata["class"];
  invocation: CoreFunctionInvocationInput;
  env: Record<string, string>;
  response_body_limit_bytes: number;
  stdout_stderr_limit_bytes: number;
  max_log_line_bytes: number;
}

interface RunnerOutput {
  ok: boolean;
  response?: CoreFunctionInvocationResult["response"];
  logs?: CoreFunctionLogEntry[];
  error?: {
    message?: string;
    code?: string;
    stack?: string;
  };
}

export class LocalFunctionExecutor {
  readonly #content: ContentStorePort;
  readonly #workDir: string;
  readonly #runnerPath: string;
  readonly #invocationTimeoutMs: number;
  readonly #responseBodyLimitBytes: number;
  readonly #maxConcurrentInvocations: number;
  readonly #maxPendingInvocations: number;
  readonly #nodeExecArgv: string[];
  #activeInvocations = 0;
  readonly #pendingInvocations: Array<() => void> = [];

  constructor(options: LocalFunctionExecutorOptions) {
    this.#content = options.content;
    this.#workDir = options.workDir;
    this.#runnerPath = options.runnerPath ?? defaultRunnerPath();
    this.#invocationTimeoutMs = options.invocationTimeoutMs ?? CORE_FUNCTION_RESOURCE_DEFAULTS.invocationTimeoutMs;
    this.#responseBodyLimitBytes = options.responseBodyLimitBytes ?? CORE_FUNCTION_RESOURCE_DEFAULTS.responseBodyLimitBytes;
    this.#maxConcurrentInvocations = options.maxConcurrentInvocations ?? CORE_FUNCTION_RESOURCE_DEFAULTS.maxConcurrentInvocationsPerProject;
    this.#maxPendingInvocations = options.maxPendingInvocations ?? CORE_FUNCTION_RESOURCE_DEFAULTS.maxPendingInvocationQueue;
    this.#nodeExecArgv = options.nodeExecArgv ?? defaultNodeExecArgv(this.#runnerPath);
  }

  async invoke(input: LocalFunctionExecutorInput): Promise<LocalFunctionExecutorResult> {
    await this.#acquireInvocationSlot(input);
    const started = Date.now();
    try {
      const modulePath = await this.#stageBundle(input);
      const payload: RunnerPayload = {
        module_path: modulePath,
        entrypoint: input.bundle.entrypoint,
        function_class: input.bundle.class,
        invocation: {
          projectId: input.projectId,
          releaseId: input.releaseId,
          functionName: input.functionName,
          invocationKind: input.invocationKind,
          requestId: input.requestId,
          ...(input.actor ? { actor: input.actor } : {}),
          ...(input.request ? { request: input.request } : {}),
        },
        env: executorEnv(input),
        response_body_limit_bytes: this.#responseBodyLimitBytes,
        stdout_stderr_limit_bytes: CORE_FUNCTION_RESOURCE_DEFAULTS.stdoutStderrLimitBytes,
        max_log_line_bytes: CORE_FUNCTION_RESOURCE_DEFAULTS.maxLogLineBytes,
      };
      const output = await this.#runChild(input, payload);
      if (!output.ok || !output.response) {
        throw new LocalExecutorError(output.error?.message ?? "Function runner failed.", {
          function_name: input.functionName,
          runner_error: output.error?.code ?? "runner_failed",
        });
      }
      enforceResponseLimit(output.response, this.#responseBodyLimitBytes);
      return {
        requestId: input.requestId,
        response: output.response,
        logs: output.logs ?? [],
        duration_ms: Date.now() - started,
      };
    } finally {
      this.#releaseInvocationSlot();
    }
  }

  async #acquireInvocationSlot(input: LocalFunctionExecutorInput): Promise<void> {
    if (this.#activeInvocations < this.#maxConcurrentInvocations) {
      this.#activeInvocations += 1;
      return;
    }
    if (this.#pendingInvocations.length >= this.#maxPendingInvocations) {
      throw new DynamicRuntimeBusyError("Run402 Core local function executor is busy.", {
        function_name: input.functionName,
        max_concurrent_invocations: this.#maxConcurrentInvocations,
        max_pending_invocations: this.#maxPendingInvocations,
      });
    }
    await new Promise<void>((resolve) => {
      this.#pendingInvocations.push(resolve);
    });
  }

  #releaseInvocationSlot(): void {
    const next = this.#pendingInvocations.shift();
    if (next) {
      queueMicrotask(next);
      return;
    }
    this.#activeInvocations -= 1;
  }

  async #stageBundle(input: LocalFunctionExecutorInput): Promise<string> {
    const content = await this.#content.readStatic(input.projectId, input.bundle.source.sha256);
    if (!content) {
      throw new LocalExecutorError("Function bundle content is missing from the local content store.", {
        function_name: input.functionName,
        sha256: input.bundle.source.sha256,
      });
    }
    verifyContentRefBytes(input.bundle.source, content.bytes);
    const bundleDir = path.join(
      this.#workDir,
      safeSegment(input.projectId),
      safeSegment(input.releaseId ?? "empty"),
      safeSegment(input.functionName),
      input.bundle.bundle_sha256,
    );
    await mkdir(bundleDir, { recursive: true });
    const modulePath = path.join(bundleDir, "entry.mjs");
    await writeFile(modulePath, content.bytes);
    return modulePath;
  }

  async #runChild(input: LocalFunctionExecutorInput, payload: RunnerPayload): Promise<RunnerOutput> {
    const tmpDir = path.join(process.cwd(), ".run402-core", "tmp", input.requestId || randomUUID());
    await mkdir(tmpDir, { recursive: true });
    return new Promise((resolve, reject) => {
      const child = spawnRunner(this.#runnerPath, this.#nodeExecArgv, input, tmpDir);
      let settled = false;
      let stdout = "";
      let stderr = "";
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        killChildTree(child);
        reject(new DynamicRuntimeTimeoutError("Run402 Core local function invocation timed out.", {
          function_name: input.functionName,
          timeout_ms: this.#invocationTimeoutMs,
        }));
      }, this.#invocationTimeoutMs);

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (Buffer.byteLength(stdout) > controlStdoutLimit(this.#responseBodyLimitBytes) && !settled) {
          settled = true;
          clearTimeout(timeout);
          killChildTree(child);
          reject(new LocalExecutorError("Function runner stdout exceeded the control-plane limit.", {
            function_name: input.functionName,
          }));
        }
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(new LocalExecutorError(error.message, {
          function_name: input.functionName,
        }));
      });
      child.on("close", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (code !== 0) {
          reject(new LocalExecutorError("Function runner exited before returning a response.", {
            function_name: input.functionName,
            exit_code: code,
            signal,
            stderr: stderr.slice(-4096),
          }));
          return;
        }
        try {
          resolve(JSON.parse(stdout) as RunnerOutput);
        } catch (error) {
          reject(new LocalExecutorError("Function runner returned invalid control JSON.", {
            function_name: input.functionName,
            stderr: stderr.slice(-4096),
            parse_error: error instanceof Error ? error.message : String(error),
          }));
        }
      });
      child.stdin.end(JSON.stringify(payload));
    });
  }
}

function spawnRunner(
  runnerPath: string,
  nodeExecArgv: string[],
  input: LocalFunctionExecutorInput,
  tmpDir: string,
): ChildProcessWithoutNullStreams {
  const memoryMb = Math.max(64, Math.floor(input.bundle.memory_bytes / (1024 * 1024)));
  return spawn(process.execPath, [
    ...nodeExecArgv,
    `--max-old-space-size=${memoryMb}`,
    runnerPath,
  ], {
    cwd: process.cwd(),
    detached: process.platform !== "win32",
    env: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      NODE_ENV: "production",
      HOME: tmpDir,
      TMPDIR: tmpDir,
      RUN402_PROJECT_ID: input.projectId,
      RUN402_RELEASE_ID: input.releaseId ?? "",
      RUN402_FUNCTION_NAME: input.functionName,
      RUN402_REQUEST_ID: input.requestId,
    },
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function killChildTree(child: ChildProcessWithoutNullStreams): void {
  if (!child.pid) return;
  try {
    if (process.platform !== "win32") {
      process.kill(-child.pid, "SIGKILL");
    } else {
      child.kill("SIGKILL");
    }
  } catch {
    child.kill("SIGKILL");
  }
}

function executorEnv(input: LocalFunctionExecutorInput): Record<string, string> {
  return {
    ...(input.secrets ?? {}),
    ...(input.run402Env ? {
      RUN402_API_BASE: input.run402Env.apiBaseUrl,
      RUN402_ANON_KEY: input.run402Env.anonKey,
      RUN402_SERVICE_KEY: input.run402Env.serviceKey,
      ...(input.run402Env.jwtSecret ? { RUN402_JWT_SECRET: input.run402Env.jwtSecret } : {}),
    } : {}),
    RUN402_PROJECT_ID: input.projectId,
    RUN402_RELEASE_ID: input.releaseId ?? "",
    RUN402_FUNCTION_NAME: input.functionName,
    RUN402_REQUEST_ID: input.requestId,
  };
}

function enforceResponseLimit(
  response: CoreFunctionInvocationResult["response"],
  limitBytes: number,
): void {
  const size = response.body?.size ?? 0;
  if (size > limitBytes) throw new ResponseBodyTooLargeError(limitBytes);
}

function controlStdoutLimit(responseBodyLimitBytes: number): number {
  return Math.ceil((responseBodyLimitBytes + 1024) * 4 / 3) +
    CORE_FUNCTION_RESOURCE_DEFAULTS.stdoutStderrLimitBytes +
    1024 * 1024;
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 96);
}

function defaultRunnerPath(): string {
  const current = fileURLToPath(import.meta.url);
  return current.endsWith(".ts")
    ? path.join(path.dirname(current), "function-runner.ts")
    : path.join(path.dirname(current), "function-runner.js");
}

function defaultNodeExecArgv(runnerPath: string): string[] {
  return runnerPath.endsWith(".ts") ? ["--import", "tsx"] : [];
}
