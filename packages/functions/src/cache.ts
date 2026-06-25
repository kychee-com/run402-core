/**
 * SSR cache invalidation SDK — capability `ssr-isr-cache`.
 *
 * Server-side (function-context) only. Reads the current request's
 * project_id and host from `getCurrentContext()` (AsyncLocalStorage) to
 * scope invalidations safely.
 *
 * Four operations:
 *
 *   - `cache.invalidate(urlOrPath)` — delete cache rows for a specific
 *     path (or absolute URL). Returns `{ deleted, generation, host, path }`.
 *   - `cache.invalidatePrefix({ host, prefix })` — delete all rows
 *     under a path prefix on the given host.
 *   - `cache.invalidateAll({ host })` — delete all rows on the given
 *     host. Atomic with a generation bump.
 *   - `cache.invalidateMany(urls)` — bulk invalidate in one round-trip.
 *
 * Host authorization: absolute-URL forms (or explicit `host` in the
 * options bag) MUST be hosts owned by the caller's authenticated
 * project. Cross-project hosts throw `R402_CACHE_INVALIDATION_HOST_FORBIDDEN`.
 *
 * Path-string form requires an active request context (the SDK reads
 * the current host from ALS); calling it outside a handler throws
 * `R402_CACHE_INVALIDATION_HOST_REQUIRED`.
 *
 * Tag-based invalidation is NOT in v1; future v1.5 work.
 *
 * @see openspec/changes/astro-ssr-runtime/specs/ssr-isr-cache/spec.md
 */

import { config } from "./config.js";
import { getCurrentContext, requireActiveContext } from "./runtime-context.js";

/** Result envelope returned by every invalidation API. */
export interface CacheInvalidateResult {
  /** Number of `internal.ssr_cache` rows DELETEd by this call. */
  deleted: number;
  /** Post-increment generation. Each invalidate bumps the per-(project,
   *  host) generation counter, which gates in-flight MISS writes from
   *  populating stale content after the invalidate. */
  generation: bigint;
  /** The host the invalidation targeted. */
  host: string;
  /** The pathname targeted (single-URL form only); undefined for
   *  prefix/all/many. */
  path?: string;
}

export interface InvalidatePrefixOptions {
  host: string;
  prefix: string;
}

export interface InvalidateAllOptions {
  host: string;
}

/**
 * Structured error thrown when path-string form is called outside an
 * active request context. The caller has no host to scope against.
 * Use the absolute-URL form instead OR move the call into a handler.
 */
export class CacheInvalidationHostRequiredError extends Error {
  readonly code = "R402_CACHE_INVALIDATION_HOST_REQUIRED";
  readonly docs = "https://run402.com/errors/#R402_CACHE_INVALIDATION_HOST_REQUIRED";
  readonly suggestedFix =
    "Pass an absolute URL (e.g., `new URL('https://eagles.kychon.com/the-guys')`) OR move the call into a request handler so the SDK can resolve the current host.";

  constructor() {
    super(
      "cache.invalidate(path) called outside a request context. " +
        "Path-string form needs the current host from request scope.",
    );
    this.name = "CacheInvalidationHostRequiredError";
  }
}

/**
 * Structured error thrown when an invalidation targets a host that is
 * not owned by the caller's authenticated project. Prevents project A
 * from invalidating project B's cache.
 */
export class CacheInvalidationHostForbiddenError extends Error {
  readonly code = "R402_CACHE_INVALIDATION_HOST_FORBIDDEN";
  readonly docs = "https://run402.com/errors/#R402_CACHE_INVALIDATION_HOST_FORBIDDEN";
  readonly host: string;
  readonly suggestedFix: string;

  constructor(host: string) {
    super(`host ${host} is not owned by the current project`);
    this.name = "CacheInvalidationHostForbiddenError";
    this.host = host;
    this.suggestedFix = `Use a host attached to your project. List your project's hosts with \`r.domains.list()\` or check Run402 dashboard. The cache layer rejects cross-project invalidations to preserve tenant isolation.`;
  }
}

/**
 * Internal: call the gateway's cache invalidation endpoint with the
 * resolved scope. The gateway enforces project ownership of the host
 * server-side; this function relies on that enforcement but ALSO
 * validates the response shape.
 */
async function callCacheInvalidate(body: {
  kind: "exact" | "prefix" | "all" | "many";
  host?: string;
  path?: string;
  prefix?: string;
  urls?: string[];
}): Promise<CacheInvalidateResult & { results?: CacheInvalidateResult[] }> {
  const url = `${config.API_BASE}/cache/v1/invalidate`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // The gateway resolves the caller's project from the service key.
      // Cache invalidation is server-side only; the SDK is bundled into
      // user functions and runs with RUN402_SERVICE_KEY in scope.
      Authorization: "Bearer " + config.SERVICE_KEY,
    },
    body: JSON.stringify(body),
  });

  if (response.status === 403) {
    const errBody = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const host = typeof errBody.host === "string" ? errBody.host : (body.host ?? "");
    throw new CacheInvalidationHostForbiddenError(host);
  }
  if (!response.ok) {
    const errBody = await response.text().catch(() => "");
    throw new Error(
      `cache.invalidate(${body.kind}) failed: HTTP ${response.status} ${errBody.slice(0, 200)}`,
    );
  }

  const json = (await response.json()) as {
    deleted: number;
    generation: string | number;
    host: string;
    path?: string;
    results?: Array<{ deleted: number; generation: string | number; host: string; path?: string }>;
  };

  return {
    deleted: json.deleted,
    generation: BigInt(json.generation),
    host: json.host,
    path: json.path,
    results: json.results?.map((r) => ({
      ...r,
      generation: BigInt(r.generation),
    })),
  };
}

/**
 * Invalidate a single cached SSR response.
 *
 * Accepts either:
 *   - a path string (e.g., `'/the-guys'`) — the SDK reads the current
 *     host from the active request context (throws
 *     `CacheInvalidationHostRequiredError` if no context)
 *   - an absolute URL (e.g., `new URL('https://eagles.kychon.com/the-guys')`)
 *     — multi-host admin scenarios (host MUST be owned by caller's
 *     project; throws `CacheInvalidationHostForbiddenError` otherwise)
 *
 * Deletes GET and HEAD rows for ALL locales and ALL release ids matching
 * the exact canonical pathname + normalized search on the target host.
 *
 * The DELETE and the per-(project, host) generation increment happen in
 * the same transaction; the post-increment generation is returned.
 */
export async function invalidate(urlOrPath: string | URL): Promise<CacheInvalidateResult> {
  let host: string;
  let path: string;

  if (urlOrPath instanceof URL) {
    host = urlOrPath.host.toLowerCase();
    path = urlOrPath.pathname + urlOrPath.search;
  } else if (typeof urlOrPath === "string" && urlOrPath.startsWith("http://")) {
    // Allow http:// only for local-dev parity, but the gateway will
    // typically reject it.
    const u = new URL(urlOrPath);
    host = u.host.toLowerCase();
    path = u.pathname + u.search;
  } else if (typeof urlOrPath === "string" && urlOrPath.startsWith("https://")) {
    const u = new URL(urlOrPath);
    host = u.host.toLowerCase();
    path = u.pathname + u.search;
  } else if (typeof urlOrPath === "string" && urlOrPath.startsWith("/")) {
    // Path-string form: requires active request context to resolve host.
    const ctx = getCurrentContext();
    if (ctx === undefined || !ctx.active.value) {
      throw new CacheInvalidationHostRequiredError();
    }
    host = ctx.host.toLowerCase();
    path = urlOrPath;
  } else {
    throw new Error(
      `cache.invalidate: argument must be a URL, an "https://" URL string, or a path starting with "/". Got: ${typeof urlOrPath === "string" ? `"${urlOrPath}"` : typeof urlOrPath}`,
    );
  }

  const result = await callCacheInvalidate({ kind: "exact", host, path });
  return {
    deleted: result.deleted,
    generation: result.generation,
    host: result.host,
    path: result.path ?? path,
  };
}

/**
 * Invalidate all cache rows under a path prefix on the given host.
 */
export async function invalidatePrefix(opts: InvalidatePrefixOptions): Promise<CacheInvalidateResult> {
  if (!opts.host) throw new Error("cache.invalidatePrefix: host is required");
  if (!opts.prefix || !opts.prefix.startsWith("/")) {
    throw new Error("cache.invalidatePrefix: prefix must start with '/'");
  }
  const result = await callCacheInvalidate({
    kind: "prefix",
    host: opts.host.toLowerCase(),
    prefix: opts.prefix,
  });
  return {
    deleted: result.deleted,
    generation: result.generation,
    host: result.host,
  };
}

/**
 * Invalidate all cache rows for the given host (entire-host purge).
 * Useful for catastrophic content changes (nav restructure, layout
 * update, etc.) where targeted invalidation would be impractical.
 */
export async function invalidateAll(opts: InvalidateAllOptions): Promise<CacheInvalidateResult> {
  if (!opts.host) throw new Error("cache.invalidateAll: host is required");
  const result = await callCacheInvalidate({
    kind: "all",
    host: opts.host.toLowerCase(),
  });
  return {
    deleted: result.deleted,
    generation: result.generation,
    host: result.host,
  };
}

/**
 * Bulk-invalidate many URLs in a single round-trip. Path-string forms
 * use the current request context's host; absolute URLs are scoped
 * individually.
 *
 * Returns a SUMMARY envelope with the total deleted count. Per-URL
 * results are also available on the optional `results` field of the
 * returned object (not in the result type return for the common case;
 * use the internal endpoint if you need per-URL precision).
 */
export async function invalidateMany(urls: Array<string | URL>): Promise<CacheInvalidateResult> {
  if (!Array.isArray(urls) || urls.length === 0) {
    return { deleted: 0, generation: 0n, host: "" };
  }

  // Resolve each URL to its absolute form, using the current context
  // for path-only entries.
  const ctx = getCurrentContext();
  const resolved = urls.map((u) => {
    if (u instanceof URL) return u.toString();
    if (u.startsWith("https://") || u.startsWith("http://")) return u;
    if (u.startsWith("/")) {
      if (ctx === undefined || !ctx.active.value) {
        throw new CacheInvalidationHostRequiredError();
      }
      return `https://${ctx.host}${u}`;
    }
    throw new Error(`cache.invalidateMany: invalid entry "${u}"`);
  });

  const result = await callCacheInvalidate({ kind: "many", urls: resolved });
  return {
    deleted: result.deleted,
    generation: result.generation,
    host: result.host ?? "",
  };
}

/** The full cache namespace exported via the `cache` named export from
 *  `@run402/functions`. */
export const cache = {
  invalidate,
  invalidatePrefix,
  invalidateAll,
  invalidateMany,
} as const;

export type Cache = typeof cache;
