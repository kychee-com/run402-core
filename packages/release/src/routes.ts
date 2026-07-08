import { createHash } from "node:crypto";

import { ReleaseSpecValidationError } from "./errors.js";
import {
  SUPPORTED_HTTP_METHODS,
  SUPPORTED_ROUTE_PRICING_NETWORKS,
  type HttpMethod,
  type MaterializedRoutes,
  type RouteEntry,
  type RoutePricingNetwork,
  type RoutePricingSpec,
  type RouteSpec,
  type RouteTarget,
} from "./types.js";

export const ROUTE_TABLE_LIMIT = 100;
export const ROUTE_PATTERN_BYTE_LIMIT = 256;
export const DEFAULT_ROUTE_PRICING_NETWORKS: readonly RoutePricingNetwork[] = ["mainnet"];

const SUPPORTED_METHOD_SET = new Set<string>(SUPPORTED_HTTP_METHODS);
const SUPPORTED_ROUTE_PRICING_NETWORK_SET = new Set<string>(SUPPORTED_ROUTE_PRICING_NETWORKS);

export function emptyRoutes(): MaterializedRoutes {
  return { manifest_sha256: null, entries: [] };
}

export function canonicalizeRouteEntries(specs: RouteSpec[]): RouteEntry[] {
  if (!Array.isArray(specs)) {
    throw routeError("routes", "routes.replace must be an array");
  }
  if (specs.length > ROUTE_TABLE_LIMIT) {
    throw routeError("routes", `routes.replace exceeds ${ROUTE_TABLE_LIMIT}-entry limit`);
  }
  const seen = new Set<string>();
  const entries = specs.map((spec, index) => {
    const entry = routeEntryFromSpec(spec, `routes.replace.${index}`);
    for (const method of effectiveMethods(entry.methods)) {
      const identity = `${routePatternIdentity(entry)} ${method}`;
      if (seen.has(identity)) {
        throw routeError(`routes.replace.${index}.methods`, `duplicate route pattern and effective method after normalization: ${entry.pattern} ${method}`);
      }
      seen.add(identity);
    }
    return entry;
  });
  return sortRouteEntries(entries);
}

export function materializeRoutes(specs: RouteSpec[]): MaterializedRoutes {
  const entries = canonicalizeRouteEntries(specs);
  return {
    manifest_sha256: computeRouteManifestSha256(entries),
    entries,
  };
}

export function computeRouteManifestSha256(entries: RouteEntry[]): string | null {
  if (entries.length === 0) return null;
  const json = JSON.stringify(sortRouteEntries(entries).map(stableRouteEntryObject));
  return createHash("sha256").update(json).digest("hex");
}

export function sortRouteEntries(entries: RouteEntry[]): RouteEntry[] {
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "exact" ? -1 : 1;
    if (a.kind === "prefix" && b.kind === "prefix") {
      const prefixDelta = (b.prefix?.length ?? 0) - (a.prefix?.length ?? 0);
      if (prefixDelta !== 0) return prefixDelta;
    }
    const pattern = compareAscii(a.pattern, b.pattern);
    if (pattern !== 0) return pattern;
    const methods = compareAscii(methodSortKey(a.methods), methodSortKey(b.methods));
    if (methods !== 0) return methods;
    return compareAscii(targetSortKey(a.target), targetSortKey(b.target));
  });
}

function routeEntryFromSpec(spec: RouteSpec, resource: string): RouteEntry {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    throw routeError(resource, "route entry must be an object");
  }
  rejectUnknownKeys(spec as unknown as Record<string, unknown>, resource, ["pattern", "methods", "target", "pricing"]);
  const raw = spec as { pattern?: unknown; methods?: unknown; target?: unknown; pricing?: unknown };
  if (typeof raw.pattern !== "string") {
    throw routeError(`${resource}.pattern`, "route pattern must be a string");
  }
  const pattern = validateAndNormalizePattern(raw.pattern, `${resource}.pattern`);
  const target = validateTarget(raw.target, `${resource}.target`);
  const methods = normalizeMethods(raw.methods, `${resource}.methods`, target);
  const pricing = validateRoutePricing(raw.pricing, `${resource}.pricing`, target);
  const kind: RouteEntry["kind"] = pattern.endsWith("/*") ? "prefix" : "exact";
  if (target.type === "static" && kind !== "exact") {
    throw routeError(`${resource}.pattern`, "static route aliases must use exact path patterns; prefix /* patterns are not supported");
  }
  return {
    pattern,
    kind,
    prefix: kind === "prefix" ? pattern.slice(0, -1) : null,
    methods,
    target,
    ...(pricing ? { pricing } : {}),
  };
}

function validateAndNormalizePattern(pattern: string, resource: string): string {
  if (!pattern.startsWith("/")) {
    throw routeError(resource, "route pattern must start with /");
  }
  if (Buffer.byteLength(pattern, "utf-8") > ROUTE_PATTERN_BYTE_LIMIT) {
    throw routeError(resource, `route pattern exceeds ${ROUTE_PATTERN_BYTE_LIMIT}-byte limit`);
  }
  if (pattern.includes("?")) {
    throw routeError(resource, "route pattern must not include a query string");
  }
  try {
    decodeURI(pattern);
  } catch {
    throw routeError(resource, "route pattern contains invalid percent encoding");
  }
  const wildcardIndex = pattern.indexOf("*");
  if (wildcardIndex >= 0 && !pattern.endsWith("/*")) {
    throw routeError(resource, "wildcards are only supported as final /*");
  }
  if (pattern === "*") {
    throw routeError(resource, "route pattern must be an absolute path");
  }
  if (pattern.endsWith("/*") && pattern === "/*") {
    throw routeError(resource, "prefix wildcard must include a path segment before /*");
  }
  return pattern;
}

function validateTarget(target: unknown, resource: string): RouteTarget {
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    throw routeError(resource, "route target must be an object");
  }
  const raw = target as { type?: unknown; name?: unknown; file?: unknown };
  if (raw.type === "function") {
    if (typeof raw.name !== "string" || raw.name.length === 0) {
      throw routeError(`${resource}.name`, "route target.name must be a non-empty string");
    }
    return { type: "function", name: raw.name };
  }
  if (raw.type === "static") {
    if (typeof raw.file !== "string") {
      throw routeError(`${resource}.file`, "static route target.file must be a string");
    }
    validateStaticTargetFile(raw.file, `${resource}.file`);
    return { type: "static", file: raw.file };
  }
  throw routeError(`${resource}.type`, "route target.type must be 'function' or 'static'");
}

function validateStaticTargetFile(file: string, resource: string): void {
  if (file.length === 0) {
    throw routeError(resource, "static route target.file must be non-empty");
  }
  if (file.startsWith("/")) {
    throw routeError(resource, "static route target.file must not start with /");
  }
  if (file.includes("?") || file.includes("#")) {
    throw routeError(resource, "static route target.file must not include query strings or fragments");
  }
  if (file.includes("\\")) {
    throw routeError(resource, "static route target.file must use / path separators, not backslashes");
  }
  if (file.endsWith("/")) {
    throw routeError(resource, "static route target.file must name a file, not a directory shorthand");
  }
  for (const segment of file.split("/")) {
    if (segment.length === 0) {
      throw routeError(resource, "static route target.file must not contain empty path segments");
    }
    if (segment === "." || segment === "..") {
      throw routeError(resource, "static route target.file must not contain . or .. path segments");
    }
  }
}

function normalizeMethods(methods: unknown, resource: string, target: RouteTarget): HttpMethod[] | null {
  if (methods === undefined || methods === null) {
    if (target.type === "static") {
      // GET plus HEAD is the only method set a static alias can normalize
      // to, so an omitted list is unambiguous.
      return ["GET", "HEAD"];
    }
    return null;
  }
  if (!Array.isArray(methods)) {
    throw routeError(resource, "route methods must be an array");
  }
  if (methods.length === 0) {
    throw routeError(resource, "route methods must not be empty");
  }
  const out = new Set<HttpMethod>();
  for (const method of methods) {
    if (typeof method !== "string") {
      throw routeError(resource, "route method must be a string");
    }
    const upper = method.toUpperCase();
    if (!SUPPORTED_METHOD_SET.has(upper)) {
      throw routeError(resource, `unsupported route method: ${method}`);
    }
    out.add(upper as HttpMethod);
  }
  const normalized = [...out].sort(compareAscii);
  if (target.type === "static") {
    const validStaticMethods =
      normalized.length === 1 && normalized[0] === "GET" ||
      normalized.length === 2 && normalized[0] === "GET" && normalized[1] === "HEAD";
    if (!validStaticMethods) {
      throw routeError(resource, "static route aliases support only GET or GET plus HEAD methods");
    }
    return ["GET", "HEAD"];
  }
  return normalized;
}

function validateRoutePricing(pricing: unknown, resource: string, target: RouteTarget): RoutePricingSpec | undefined {
  if (pricing === undefined) return undefined;
  if (target.type !== "function") {
    throw routeError(resource, "route pricing is only supported on function routes");
  }
  if (!pricing || typeof pricing !== "object" || Array.isArray(pricing)) {
    throw routeError(resource, "route pricing must be an object");
  }
  rejectUnknownKeys(pricing as Record<string, unknown>, resource, ["mode", "amount_usd_micros", "pay_to", "networks"]);
  const raw = pricing as {
    mode?: unknown;
    amount_usd_micros?: unknown;
    pay_to?: unknown;
    networks?: unknown;
  };
  if (raw.mode !== "always") {
    throw routeError(`${resource}.mode`, "route pricing mode must be 'always'");
  }
  const amount = raw.amount_usd_micros;
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount <= 0) {
    throw routeError(`${resource}.amount_usd_micros`, "route pricing amount_usd_micros must be a positive safe integer");
  }
  if (raw.pay_to !== "org_default_payout") {
    throw routeError(`${resource}.pay_to`, "route pricing pay_to must be 'org_default_payout'");
  }
  return {
    mode: "always",
    amount_usd_micros: amount,
    pay_to: "org_default_payout",
    networks: normalizePricingNetworks(raw.networks, `${resource}.networks`),
  };
}

function normalizePricingNetworks(networks: unknown, resource: string): RoutePricingNetwork[] {
  if (networks === undefined) return [...DEFAULT_ROUTE_PRICING_NETWORKS];
  if (!Array.isArray(networks)) {
    throw routeError(resource, "route pricing networks must be an array");
  }
  if (networks.length === 0) {
    throw routeError(resource, "route pricing networks must not be empty");
  }
  const out = new Set<RoutePricingNetwork>();
  for (const network of networks) {
    if (typeof network !== "string") {
      throw routeError(resource, "route pricing network must be a string");
    }
    if (!SUPPORTED_ROUTE_PRICING_NETWORK_SET.has(network)) {
      throw routeError(resource, `unsupported route pricing network: ${network}`);
    }
    if (out.has(network as RoutePricingNetwork)) {
      throw routeError(resource, `duplicate route pricing network: ${network}`);
    }
    out.add(network as RoutePricingNetwork);
  }
  return [...out].sort(compareAscii);
}

function effectiveMethods(methods: HttpMethod[] | null): HttpMethod[] {
  if (methods === null) return [...SUPPORTED_HTTP_METHODS];
  const set = new Set<HttpMethod>(methods);
  if (set.has("GET")) set.add("HEAD");
  return [...set].sort(compareAscii);
}

function stableRouteEntryObject(entry: RouteEntry): unknown {
  const stable = {
    pattern: entry.pattern,
    kind: entry.kind,
    prefix: entry.prefix,
    methods: entry.methods,
    target: stableRouteTarget(entry.target),
    pricing: entry.pricing ? stableRoutePricing(entry.pricing) : undefined,
  };
  return stable;
}

function stableRouteTarget(target: RouteTarget): unknown {
  return target.type === "function"
    ? { type: "function", name: target.name }
    : { type: "static", file: target.file };
}

function stableRoutePricing(pricing: RoutePricingSpec): unknown {
  return {
    mode: pricing.mode,
    amount_usd_micros: pricing.amount_usd_micros,
    pay_to: pricing.pay_to,
    networks: pricing.networks ?? [...DEFAULT_ROUTE_PRICING_NETWORKS],
  };
}

function routePatternIdentity(entry: RouteEntry): string {
  return entry.kind === "exact"
    ? `exact:${normalizeExact(entry.pattern)}`
    : `prefix:${entry.pattern}`;
}

function methodSortKey(methods: HttpMethod[] | null): string {
  return methods === null ? "*" : effectiveMethods(methods).join(",");
}

function targetSortKey(target: RouteTarget): string {
  return target.type === "function" ? `function:${target.name}` : `static:${target.file}`;
}

function compareAscii(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function normalizeExact(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

function rejectUnknownKeys(raw: Record<string, unknown>, resource: string, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) {
      throw routeError(resource ? `${resource}.${key}` : key, `unknown field ${key}`);
    }
  }
}

function routeError(resource: string, message: string): ReleaseSpecValidationError {
  return new ReleaseSpecValidationError(resource, message);
}
