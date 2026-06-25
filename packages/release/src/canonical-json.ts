import { ReleaseCoreError } from "./errors.js";

export type JsonCompatible =
  | null
  | boolean
  | number
  | string
  | JsonCompatible[]
  | { [key: string]: JsonCompatible };

export function canonicalizeJson(value: unknown): string {
  return canonicalize(value);
}

function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw unsupported("non-finite number");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const parts = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`);
    return `{${parts.join(",")}}`;
  }
  throw unsupported(typeof value);
}

function unsupported(kind: string): ReleaseCoreError {
  return new ReleaseCoreError({
    code: "RUN402_CORE_CANONICALIZE_UNSUPPORTED_VALUE",
    resource: "canonical_json",
    message: `Cannot canonicalize unsupported JSON value: ${kind}`,
  });
}
