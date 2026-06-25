import { runtimeCapabilities, type RuntimeCapabilityDocument } from "./capabilities.js";

export interface RuntimeKernelHealth {
  status: "ok";
  mode: "core";
  runtime_contract_version: RuntimeCapabilityDocument["runtime_contract_version"];
  supported_features: number;
  unsupported_features: number;
}

export function runtimeHealth(capabilities = runtimeCapabilities()): RuntimeKernelHealth {
  return {
    status: "ok",
    mode: "core",
    runtime_contract_version: capabilities.runtime_contract_version,
    supported_features: capabilities.supported_features.length,
    unsupported_features: capabilities.unsupported_features.length,
  };
}
