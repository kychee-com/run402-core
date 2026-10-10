import { canonicalizeJson } from "./canonical-json.js";
import { ReleaseSpecValidationError } from "./errors.js";
import type {
  HttpMethod,
  RoutePricingDiscovery,
  RoutePricingDiscoveryInput,
  RouteDiscoveryBodyType,
} from "./types.js";

// Limits mirror the x402 Bazaar facilitator rules (@x402/extensions 2.24.0:
// isValidServiceName, sanitizeTags, isValidIconUrl; CDP's 500-character
// description cap). The facilitator drops or rejects values outside them
// silently, so release validation refuses them with a field path instead.
export const ROUTE_DISCOVERY_DESCRIPTION_MAX_CHARS = 500;
export const ROUTE_DISCOVERY_SERVICE_NAME_MAX_CHARS = 32;
export const ROUTE_DISCOVERY_TAG_MAX_CHARS = 32;
/** The facilitator keeps five tags; the platform appends `run402` as the fifth. */
export const ROUTE_DISCOVERY_TENANT_TAG_LIMIT = 4;
export const ROUTE_DISCOVERY_ICON_URL_MAX_CHARS = 2048;
/** The declaration rides base64-encoded in the PAYMENT-REQUIRED response header. */
export const ROUTE_DISCOVERY_MAX_BYTES = 4096;
export const ROUTE_DISCOVERY_PLATFORM_TAG = "run402";

const BODY_TYPES: readonly RouteDiscoveryBodyType[] = ["json", "form-data", "text"];
const BODY_METHODS = new Set<HttpMethod>(["POST", "PUT", "PATCH"]);
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;
const MIME_TYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*(\s*;.*)?$/;

export interface RouteDiscoveryContext {
  /** Exact (`/check`) or prefix (`/api/*`) pattern, already normalized. */
  pattern: string;
  /** Declared methods, or null when the route accepts every method. */
  methods: readonly HttpMethod[] | null;
  /** Field path of the route's `methods`, for the one-method refusal. */
  methodsResource: string;
}

/**
 * The single HTTP method a discoverable route describes (HEAD rides along
 * with GET and is never the catalogued method).
 */
export function discoverableRouteMethod(methods: readonly HttpMethod[] | null): HttpMethod | null {
  if (methods === null) return null;
  const meaningful = [...new Set(methods)].filter((method) => method !== "HEAD");
  if (meaningful.length === 1) return meaningful[0]!;
  if (meaningful.length === 0 && methods.includes("HEAD")) return "HEAD";
  return null;
}

export function validateRouteDiscovery(
  discovery: unknown,
  resource: string,
  context: RouteDiscoveryContext,
): RoutePricingDiscovery | undefined {
  if (discovery === undefined) return undefined;
  if (!isRecord(discovery)) throw invalid(resource, "route pricing discovery must be an object");
  rejectUnknownKeys(discovery, resource, ["description", "mime_type", "service_name", "tags", "icon_url", "input", "output"]);
  if (context.pattern.endsWith("/*")) {
    throw invalid(resource, "route pricing discovery requires an exact route pattern; a prefix /* route cannot describe one catalogued resource");
  }
  const method = discoverableRouteMethod(context.methods);
  if (method === null) {
    throw invalid(context.methodsResource, "a discoverable priced route must declare exactly one HTTP method (GET may include HEAD)");
  }

  const out: RoutePricingDiscovery = { description: validateDescription(discovery.description, `${resource}.description`) };
  if (discovery.mime_type !== undefined) out.mime_type = validateMimeType(discovery.mime_type, `${resource}.mime_type`);
  if (discovery.service_name !== undefined) {
    out.service_name = validateAsciiLabel(discovery.service_name, `${resource}.service_name`, ROUTE_DISCOVERY_SERVICE_NAME_MAX_CHARS, "service_name");
  }
  if (discovery.tags !== undefined) out.tags = validateTags(discovery.tags, `${resource}.tags`);
  if (discovery.icon_url !== undefined) out.icon_url = validateIconUrl(discovery.icon_url, `${resource}.icon_url`);
  if (discovery.input !== undefined) out.input = validateInput(discovery.input, `${resource}.input`, method);
  if (discovery.output !== undefined) out.output = validateOutput(discovery.output, `${resource}.output`);

  let bytes: number;
  try {
    bytes = Buffer.byteLength(canonicalizeJson(out), "utf-8");
  } catch {
    throw invalid(resource, "route pricing discovery must contain only JSON values");
  }
  if (bytes > ROUTE_DISCOVERY_MAX_BYTES) {
    throw invalid(resource, `route pricing discovery is ${bytes} bytes of canonical JSON; the limit is ${ROUTE_DISCOVERY_MAX_BYTES}`);
  }
  return out;
}

function validateDescription(value: unknown, resource: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalid(resource, "route pricing discovery requires a non-empty description");
  }
  const chars = [...value].length;
  if (chars > ROUTE_DISCOVERY_DESCRIPTION_MAX_CHARS) {
    throw invalid(resource, `description is ${chars} characters; the x402 Bazaar limit is ${ROUTE_DISCOVERY_DESCRIPTION_MAX_CHARS}`);
  }
  return value;
}

function validateMimeType(value: unknown, resource: string): string {
  if (typeof value !== "string" || value.length > 127 || !MIME_TYPE.test(value)) {
    throw invalid(resource, "mime_type must be a media type such as application/json");
  }
  return value;
}

function validateAsciiLabel(value: unknown, resource: string, max: number, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || !PRINTABLE_ASCII.test(value)) {
    throw invalid(resource, `${name} must be 1-${max} printable ASCII characters`);
  }
  return value;
}

function validateTags(value: unknown, resource: string): string[] {
  if (!Array.isArray(value)) throw invalid(resource, "tags must be an array of strings");
  if (value.length > ROUTE_DISCOVERY_TENANT_TAG_LIMIT) {
    throw invalid(
      resource,
      `at most ${ROUTE_DISCOVERY_TENANT_TAG_LIMIT} tags are available to a route; the x402 Bazaar keeps five and the platform adds '${ROUTE_DISCOVERY_PLATFORM_TAG}'`,
    );
  }
  const seen = new Set<string>();
  return value.map((tag, index) => {
    const checked = validateAsciiLabel(tag, `${resource}.${index}`, ROUTE_DISCOVERY_TAG_MAX_CHARS, "tag");
    if (seen.has(checked)) throw invalid(`${resource}.${index}`, `duplicate tag ${checked}`);
    seen.add(checked);
    return checked;
  });
}

function validateIconUrl(value: unknown, resource: string): string {
  const message = "icon_url must be an absolute https URL on a public host name, without credentials";
  if (typeof value !== "string" || value.length > ROUTE_DISCOVERY_ICON_URL_MAX_CHARS || /[\x00-\x1f\x7f]/.test(value)) {
    throw invalid(resource, message);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid(resource, message);
  }
  const host = url.hostname.toLowerCase();
  const ipLiteral = host.startsWith("[") || /^[0-9.]+$/.test(host) || /^0x[0-9a-f]+$/i.test(host);
  if (url.protocol !== "https:" || url.username || url.password || ipLiteral || !host.includes(".") || host.startsWith("localhost")) {
    throw invalid(resource, message);
  }
  return value;
}

function validateInput(value: unknown, resource: string, method: HttpMethod): RoutePricingDiscoveryInput {
  if (!isRecord(value)) throw invalid(resource, "input must be an object");
  rejectUnknownKeys(value, resource, ["query_params_schema", "body_type", "body_schema", "example"]);
  const isBodyMethod = BODY_METHODS.has(method);
  const hasBodyKeys = value.body_type !== undefined || value.body_schema !== undefined;
  if (hasBodyKeys && value.query_params_schema !== undefined) {
    throw invalid(resource, "input describes either query parameters or a body, not both");
  }
  if (isBodyMethod) {
    if (value.query_params_schema !== undefined) {
      throw invalid(`${resource}.query_params_schema`, `a ${method} route describes its body; use body_type and body_schema`);
    }
    if (typeof value.body_type !== "string" || !BODY_TYPES.includes(value.body_type as RouteDiscoveryBodyType)) {
      throw invalid(`${resource}.body_type`, `body_type must be one of ${BODY_TYPES.join(", ")}`);
    }
    const out: RoutePricingDiscoveryInput = { body_type: value.body_type as RouteDiscoveryBodyType };
    if (value.body_schema !== undefined) out.body_schema = validateSchema(value.body_schema, `${resource}.body_schema`);
    if (value.example !== undefined) out.example = value.example;
    return out;
  }
  if (hasBodyKeys) {
    throw invalid(resource, `a ${method} route describes query parameters; use query_params_schema`);
  }
  const out: RoutePricingDiscoveryInput = {};
  if (value.query_params_schema !== undefined) {
    out.query_params_schema = validateSchema(value.query_params_schema, `${resource}.query_params_schema`);
  }
  if (value.example !== undefined) {
    if (!isRecord(value.example)) throw invalid(`${resource}.example`, "a query-parameter example must be an object");
    out.example = value.example;
  }
  return out;
}

function validateOutput(value: unknown, resource: string): NonNullable<RoutePricingDiscovery["output"]> {
  if (!isRecord(value)) throw invalid(resource, "output must be an object");
  rejectUnknownKeys(value, resource, ["example", "schema"]);
  const out: NonNullable<RoutePricingDiscovery["output"]> = {};
  if (value.example !== undefined) out.example = value.example;
  if (value.schema !== undefined) out.schema = validateSchema(value.schema, `${resource}.schema`);
  return out;
}

function validateSchema(value: unknown, resource: string): Record<string, unknown> {
  if (!isRecord(value)) throw invalid(resource, "schema must be a JSON Schema object");
  const external = findExternalReference(value, resource);
  if (external) throw invalid(external, "schemas may reference only local '#' fragments ($ref/$id)");
  return value;
}

function findExternalReference(node: unknown, path: string): string | null {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const found = findExternalReference(node[i], `${path}.${i}`);
      if (found) return found;
    }
    return null;
  }
  if (!isRecord(node)) return null;
  for (const [key, child] of Object.entries(node)) {
    if ((key === "$ref" || key === "$id") && (typeof child !== "string" || !child.startsWith("#"))) {
      return `${path}.${key}`;
    }
    const found = findExternalReference(child, `${path}.${key}`);
    if (found) return found;
  }
  return null;
}

function rejectUnknownKeys(raw: Record<string, unknown>, resource: string, allowed: readonly string[]): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      throw invalid(`${resource}.${key}`, `unknown key '${key}' (allowed: ${allowed.join(", ")})`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(resource: string, message: string): ReleaseSpecValidationError {
  return new ReleaseSpecValidationError(resource, message);
}
