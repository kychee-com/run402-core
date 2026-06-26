export interface UnsupportedCapabilityDetails {
  capability: string;
  supported_features?: string[];
}

export interface RuntimeKernelTypedErrorDetails {
  [key: string]: unknown;
}

export class RuntimeKernelTypedError extends Error {
  readonly details: RuntimeKernelTypedErrorDetails;

  constructor(readonly code: string, readonly status: number, message: string, details: RuntimeKernelTypedErrorDetails = {}) {
    super(message);
    this.name = "RuntimeKernelTypedError";
    this.details = details;
  }
}

export class UnsupportedCapabilityError extends Error {
  readonly code = "unsupported_capability";
  readonly status = 422;
  readonly details: UnsupportedCapabilityDetails;

  constructor(capability: string, message = `Unsupported runtime capability: ${capability}`) {
    super(message);
    this.name = "UnsupportedCapabilityError";
    this.details = { capability };
  }
}

export function unsupportedCapabilityEnvelope(error: UnsupportedCapabilityError): {
  error: "unsupported_capability";
  message: string;
  capability: string;
} {
  return {
    error: "unsupported_capability",
    message: error.message,
    capability: error.details.capability,
  };
}

export class MissingRequiredSecretError extends RuntimeKernelTypedError {
  constructor(secretName: string, functionName?: string) {
    super("missing_required_secret", 422, `Missing required secret: ${secretName}`, {
      secret_name: secretName,
      ...(functionName ? { function_name: functionName } : {}),
    });
    this.name = "MissingRequiredSecretError";
  }
}

export class FunctionBundleValidationError extends RuntimeKernelTypedError {
  constructor(code: string, message: string, details: RuntimeKernelTypedErrorDetails = {}) {
    super(code, 422, message, details);
    this.name = "FunctionBundleValidationError";
  }
}

export class AstroSsrUnsupportedFeatureError extends RuntimeKernelTypedError {
  constructor(feature: string, message = `Unsupported Astro SSR feature: ${feature}`, details: RuntimeKernelTypedErrorDetails = {}) {
    super("astro_ssr_unsupported_feature", 422, message, {
      feature,
      ...details,
    });
    this.name = "AstroSsrUnsupportedFeatureError";
  }
}

export class DependencyInstallRejectedError extends RuntimeKernelTypedError {
  constructor(message: string, details: RuntimeKernelTypedErrorDetails = {}) {
    super("dependency_install_rejected", 422, message, details);
    this.name = "DependencyInstallRejectedError";
  }
}

export class DependencyInstallFailedError extends RuntimeKernelTypedError {
  constructor(message: string, details: RuntimeKernelTypedErrorDetails = {}) {
    super("dependency_install_failed", 422, message, details);
    this.name = "DependencyInstallFailedError";
  }
}

export class DynamicRuntimeUnavailableError extends RuntimeKernelTypedError {
  constructor(message = "Run402 Core dynamic functions runtime is not configured.", details: RuntimeKernelTypedErrorDetails = {}) {
    super("dynamic_runtime_unavailable", 503, message, details);
    this.name = "DynamicRuntimeUnavailableError";
  }
}

export class DynamicRuntimeTimeoutError extends RuntimeKernelTypedError {
  constructor(message = "Run402 Core dynamic runtime invocation timed out.", details: RuntimeKernelTypedErrorDetails = {}) {
    super("dynamic_runtime_timeout", 504, message, details);
    this.name = "DynamicRuntimeTimeoutError";
  }
}

export class DynamicRuntimeBusyError extends RuntimeKernelTypedError {
  constructor(message = "Run402 Core dynamic runtime is busy.", details: RuntimeKernelTypedErrorDetails = {}) {
    super("dynamic_runtime_busy", 503, message, details);
    this.name = "DynamicRuntimeBusyError";
  }
}

export class RequestBodyTooLargeError extends RuntimeKernelTypedError {
  constructor(limitBytes: number) {
    super("request_body_too_large", 413, `Request body exceeds ${limitBytes} bytes.`, {
      limit_bytes: limitBytes,
    });
    this.name = "RequestBodyTooLargeError";
  }
}

export class ResponseBodyTooLargeError extends RuntimeKernelTypedError {
  constructor(limitBytes: number) {
    super("response_body_too_large", 502, `Function response body exceeds ${limitBytes} bytes.`, {
      limit_bytes: limitBytes,
    });
    this.name = "ResponseBodyTooLargeError";
  }
}

export class LocalExecutorError extends RuntimeKernelTypedError {
  constructor(message: string, details: RuntimeKernelTypedErrorDetails = {}) {
    super("local_executor_failed", 500, message, details);
    this.name = "LocalExecutorError";
  }
}

export function runtimeKernelErrorEnvelope(error: RuntimeKernelTypedError): {
  error: string;
  message: string;
  details?: RuntimeKernelTypedErrorDetails;
} {
  return {
    error: error.code,
    message: error.message,
    ...(Object.keys(error.details).length > 0 ? { details: error.details } : {}),
  };
}
