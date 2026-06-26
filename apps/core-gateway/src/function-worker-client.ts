import {
  LocalExecutorError,
  RuntimeKernelTypedError,
  type RuntimeKernelTypedErrorDetails,
} from "@run402/runtime-kernel";
import type {
  LocalFunctionExecutorInput,
  LocalFunctionExecutorResult,
} from "./local-function-executor.js";

export class HttpFunctionWorkerClient {
  readonly #baseUrl: string;

  constructor(baseUrl: string) {
    this.#baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async invoke(input: LocalFunctionExecutorInput): Promise<LocalFunctionExecutorResult> {
    const response = await fetch(`${this.#baseUrl}/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    const body = await response.json().catch(() => null) as {
      error?: string;
      message?: string;
      details?: RuntimeKernelTypedErrorDetails;
    } | LocalFunctionExecutorResult | null;
    if (!response.ok) {
      if (body && "error" in body && body.error) {
        throw new RuntimeKernelTypedError(body.error, response.status, body.message ?? "Function worker failed.", body.details ?? {});
      }
      throw new LocalExecutorError("Function worker failed.", { status: response.status });
    }
    return body as LocalFunctionExecutorResult;
  }
}
