export type ReleaseCoreErrorCode =
  | "RUN402_CORE_INVALID_SPEC"
  | "RUN402_CORE_UNSUPPORTED_VERSION"
  | "RUN402_CORE_CANONICALIZE_UNSUPPORTED_VALUE"
  | "RUN402_CORE_FACT_UNSUPPORTED_VERSION"
  | "RUN402_CORE_FACT_INVALID"
  | "RUN402_CORE_FACT_DUPLICATE"
  | "RUN402_CORE_FACT_UNKNOWN"
  | "RUN402_CORE_FACT_INCOMPLETE_SET"
  | "RUN402_CORE_FACT_UNAVAILABLE";

export class ReleaseCoreError extends Error {
  readonly code: ReleaseCoreErrorCode;
  readonly resource: string;
  readonly details: Record<string, unknown>;

  constructor(opts: {
    code: ReleaseCoreErrorCode;
    message: string;
    resource?: string;
    details?: Record<string, unknown>;
  }) {
    super(opts.message);
    this.name = "ReleaseCoreError";
    this.code = opts.code;
    this.resource = opts.resource ?? "release";
    this.details = opts.details ?? {};
  }
}

export class ReleaseSpecValidationError extends ReleaseCoreError {
  constructor(resource: string, message: string, details?: Record<string, unknown>) {
    super({
      code: "RUN402_CORE_INVALID_SPEC",
      message,
      resource,
      details,
    });
    this.name = "ReleaseSpecValidationError";
  }
}

export class ReleaseFactProtocolError extends ReleaseCoreError {
  constructor(opts: {
    code: Extract<ReleaseCoreErrorCode, `RUN402_CORE_FACT_${string}`>;
    message: string;
    resource?: string;
    details?: Record<string, unknown>;
  }) {
    super(opts);
    this.name = "ReleaseFactProtocolError";
  }
}
