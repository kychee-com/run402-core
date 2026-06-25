/**
 * `getRun402Context(request)` — zero-dependency helper for **non-Astro**
 * Node22 functions (plain webhook handlers, auth endpoints, admin tools)
 * to read the per-request context the gateway already populates as
 * `x-run402-*` request headers. Returns the same shape `Astro.locals.run402`
 * exposes in `@run402/astro`, so Astro and plain-function code share one
 * mental model.
 *
 * Why this exists: every non-Astro function in production today hand-rolls
 * header parsing (`request.headers.get('x-run402-request-id')` ...). That's
 * error-prone, untyped, and inconsistent — different functions read
 * different headers, miss optional fields, mis-spell names. This helper
 * centralizes the shape so:
 *
 *   - Adding a new request-context field is one place to update (here
 *     and in `@run402/astro`'s `Run402Locals`).
 *   - Header names stay private to the helper — if the gateway renames
 *     `x-run402-*` to something else in v2, the helper signature is
 *     unchanged.
 *   - Plain functions get the same per-field typing Astro pages get.
 *
 * Header sources (all set by the gateway on the forwarded `Request`):
 *
 *   - `x-run402-request-id`     → `requestId`
 *   - `x-run402-project-id`     → `projectId`
 *   - `x-run402-release-id`     → `releaseId` (null if no active release)
 *   - `x-run402-host`           → `host`
 *   - `x-run402-locale`         → `locale` (null when no spec.i18n)
 *   - `x-run402-default-locale` → `defaultLocale` (null when no spec.i18n)
 *
 * If the gateway didn't set a given header (rare — would mean the request
 * bypassed the routed-http pipeline), the field is `null`. The helper
 * never throws.
 */

/**
 * Per-request context the gateway populates on routed-http invocations.
 * Identical shape to `@run402/astro`'s `Run402Locals` so Astro and plain-
 * function code can pass the value around interchangeably.
 */
export interface Run402RequestContext {
  /** Gateway-assigned request id; flows to logs + error envelopes. */
  requestId: string | null;
  /** Project id this function is deployed under. */
  projectId: string | null;
  /** Active release id at request time; `null` until the first activation. */
  releaseId: string | null;
  /** Host portion of the request URL (e.g., `eagles.kychon.com`). */
  host: string | null;
  /** Negotiated locale per the release's `spec.i18n.detect` chain.
   *  `null` when the release has no i18n slice. Byte-identical to a
   *  `spec.i18n.locales[]` entry when non-null. */
  locale: string | null;
  /** Release's default locale (`spec.i18n.defaultLocale`).
   *  `null` when the release has no i18n slice. */
  defaultLocale: string | null;
}

/**
 * Web-standard headers object — `Request.headers`, `Headers`, or a
 * `Record<string, string>`. We accept the loose shape so callers don't
 * have to construct a `Headers` instance just to read a few fields.
 */
type HeaderSource =
  | { get(name: string): string | null }
  | { headers: { get(name: string): string | null } }
  | Record<string, string | string[] | undefined>;

/**
 * Read the Run402 per-request context off the inbound `Request`.
 *
 * Accepts either a `Request` directly, or any object with a `.headers`
 * property exposing `.get(name)` (which covers AWS Lambda v2 event
 * objects, Node `http.IncomingMessage` wrappers, etc.), or a plain
 * `Record<string, string | string[]>` (which covers `event.headers`
 * shapes from various function platforms).
 *
 * @example
 *   // In a routed-http function (`@run402/functions`'s `routedHttp` helper):
 *   export default routedHttp(async (req) => {
 *     const { requestId, locale, host } = getRun402Context(req);
 *     console.log(`[${requestId}] serving ${host} in ${locale ?? 'default'}`);
 *     return text(`Hello, ${host}`);
 *   });
 *
 *   // In a raw envelope handler (no routedHttp wrapper):
 *   export const handler = async (event) => {
 *     const ctx = getRun402Context(event);
 *     ...
 *   };
 */
export function getRun402Context(source: HeaderSource): Run402RequestContext {
  const get = pickHeaderGetter(source);
  return {
    requestId: nonEmpty(get("x-run402-request-id")),
    projectId: nonEmpty(get("x-run402-project-id")),
    releaseId: nonEmpty(get("x-run402-release-id")),
    host: nonEmpty(get("x-run402-host")),
    locale: nonEmpty(get("x-run402-locale")),
    defaultLocale: nonEmpty(get("x-run402-default-locale")),
  };
}

/**
 * Resolve a `(name) => string | null` accessor regardless of which of
 * the four supported input shapes the caller passed. Case-insensitive
 * matching, because Node-style header maps preserve original casing
 * while Web `Headers` lowercase on insert — the helper papers over the
 * difference.
 */
function pickHeaderGetter(
  source: HeaderSource,
): (name: string) => string | null {
  // Shape 1: object with `.get()` (e.g., `Headers` instance).
  if (typeof (source as { get?: unknown }).get === "function") {
    const g = (source as { get(name: string): string | null }).get.bind(source);
    return (name) => g(name) ?? g(name.toLowerCase()) ?? null;
  }
  // Shape 2: object with `.headers.get()` (e.g., `Request`).
  const nested = (source as { headers?: { get?: unknown } }).headers;
  if (nested && typeof nested.get === "function") {
    const g = nested.get.bind(nested);
    return (name) => g(name) ?? g(name.toLowerCase()) ?? null;
  }
  // Shape 3: plain object map. Build a lowercased lookup once so any
  // casing in the input keys (`X-Run402-Request-Id`, `x-run402-request-id`,
  // `X-RUN402-REQUEST-ID` ...) resolves identically.
  const map = source as Record<string, string | string[] | undefined>;
  const lowered: Record<string, string | string[] | undefined> = {};
  for (const k of Object.keys(map)) {
    lowered[k.toLowerCase()] = map[k];
  }
  return (name) => {
    const v = lowered[name.toLowerCase()];
    if (typeof v === "string") return v;
    if (Array.isArray(v) && v.length > 0) {
      const first = v[0];
      if (typeof first === "string") return first;
    }
    return null;
  };
}

function nonEmpty(v: string | null): string | null {
  if (v === null) return null;
  const trimmed = v.trim();
  return trimmed.length === 0 ? null : trimmed;
}
