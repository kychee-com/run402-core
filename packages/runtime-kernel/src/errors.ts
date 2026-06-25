export interface UnsupportedCapabilityDetails {
  capability: string;
  supported_features?: string[];
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
