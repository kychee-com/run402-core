import http, { type IncomingMessage, type ServerResponse } from "node:http";
import {
  CORE_FUNCTION_RESOURCE_DEFAULTS,
  runtimeKernelErrorEnvelope,
  RuntimeKernelTypedError,
  type CoreFunctionBundleMetadata,
  type CoreFunctionInvocationInput,
} from "@run402/runtime-kernel";
import { FilesystemContentStore } from "./filesystem-content.js";
import { LocalFunctionExecutor } from "./local-function-executor.js";

interface FunctionWorkerConfig {
  host: string;
  port: number;
  contentDir: string;
  workDir: string;
}

interface WorkerInvokeBody extends CoreFunctionInvocationInput {
  bundle: CoreFunctionBundleMetadata;
}

export function loadFunctionWorkerConfig(env: NodeJS.ProcessEnv = process.env): FunctionWorkerConfig {
  return {
    host: env.CORE_FUNCTION_WORKER_HOST || "127.0.0.1",
    port: Number.parseInt(env.CORE_FUNCTION_WORKER_PORT || "4021", 10),
    contentDir: env.CORE_CONTENT_DIR || ".run402-core/content",
    workDir: env.CORE_FUNCTION_WORK_DIR || ".run402-core/functions-runtime",
  };
}

export function createFunctionWorkerHandler(config: FunctionWorkerConfig) {
  const content = new FilesystemContentStore(config.contentDir);
  const executor = new LocalFunctionExecutor({
    content,
    workDir: config.workDir,
  });

  return async function functionWorkerHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", "http://run402-core-function-worker.local");
      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, { status: "ok", mode: "core-function-worker" });
        return;
      }
      if (req.method === "POST" && url.pathname === "/invoke") {
        const body = await readJson(req) as WorkerInvokeBody;
        const result = await executor.invoke(body);
        sendJson(res, 200, result);
        return;
      }
      sendJson(res, 404, { error: "not_found", message: "Function worker route not found." });
    } catch (error) {
      if (error instanceof RuntimeKernelTypedError) {
        sendJson(res, error.status, runtimeKernelErrorEnvelope(error));
        return;
      }
      if (error instanceof SyntaxError || error instanceof RangeError) {
        sendJson(res, 400, { error: "invalid_request", message: error.message });
        return;
      }
      throw error;
    }
  };
}

export function startFunctionWorker(config = loadFunctionWorkerConfig()): Promise<http.Server> {
  const handler = createFunctionWorkerHandler(config);
  const server = http.createServer((req, res) => {
    handler(req, res).catch((error: unknown) => {
      console.error(error);
      if (!res.headersSent) {
        sendJson(res, 500, { error: "internal_error", message: "Function worker failed." });
      } else {
        res.destroy();
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(config.port, config.host, () => resolve(server));
  });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > workerInvokeBodyLimit()) throw new RangeError("Function worker request body is too large.");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function workerInvokeBodyLimit(): number {
  return Math.ceil((CORE_FUNCTION_RESOURCE_DEFAULTS.requestBodyLimitBytes + 1024) * 4 / 3) +
    1024 * 1024;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const bytes = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(bytes.byteLength),
  });
  res.end(bytes);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startFunctionWorker().then((server) => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : loadFunctionWorkerConfig().port;
    console.log(JSON.stringify({ event: "run402_core_function_worker_started", port }));
  }).catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
