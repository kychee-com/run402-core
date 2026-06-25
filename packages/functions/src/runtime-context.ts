/**
 * SSR request context primitive — capability `functions-sdk-auth-model`.
 *
 * The SSR Lambda runtime establishes this context via `als.run(...)`
 * BEFORE importing or executing the Astro server bundle (or any other
 * user-supplied code). SDK functions that need request-scoped state
 * (`db()`, `getUser()`, `cache.*`, `assets.*`, `email.*`, `ai.*`) read
 * from `getCurrentContext()` rather than requiring explicit context
 * parameters at the call site.
 *
 * The `active` flag exists because Node's AsyncLocalStorage propagates
 * into timers, microtasks, and unawaited promises created inside
 * `als.run()`. Without an explicit flag, a `setTimeout(() => db()..., 60_000)`
 * scheduled inside a handler would, when the timer fires later, still
 * observe an `als.getStore()` pointing at the (now-completed) request —
 * leading to stale or incorrect SDK behavior. The SSR runtime sets
 * `active.value = false` IMMEDIATELY after the response body is fully
 * materialized; SDK functions check the flag and throw
 * `R402_SDK_OUTSIDE_REQUEST_CONTEXT` when it's false.
 *
 * Likewise `cacheBypassTainted.value` is set to `true` by `getUser()`
 * and payment-primitive SDK calls during render; the SSR runtime returns
 * its final value to the gateway in the Lambda response metadata envelope
 * (NOT via in-process ALS — the gateway runs in a different process).
 *
 * @see openspec/changes/astro-ssr-runtime/specs/functions-sdk-auth-model/spec.md
 * @see openspec/changes/astro-ssr-runtime/specs/routed-http-functions/spec.md
 */

import { AsyncLocalStorage } from "node:async_hooks";
import {
  verifyActorContextEnvelope,
  ACTOR_CONTEXT_HEADER,
  type VerifiedActorPayload,
  type VerifyFailureReason,
} from "./lib/actor-context-verify.js";

/** Capability `auth-aware-ssr`: the verified actor payload the SDK
 *  exposes via `auth.user()` etc. Populated by `runWithContext` after
 *  it verifies the inbound actor-context envelope. `null` when the
 *  request is anonymous OR when verification failed (defense in depth:
 *  forged envelopes never surface as a non-null actor). */
export type ActorContext = VerifiedActorPayload & { sessionId: string };

/** The shape stored in AsyncLocalStorage. See the spec referenced above
 *  for the canonical definition. */
export interface RunRequestContext {
  /** Unique per-request id; matches `x-run402-request-id`. */
  requestId: string;
  projectId: string;
  releaseId: string;
  /** v1.49-negotiated locale string. `null` when the active release has
   *  no i18n slice. */
  locale: string | null;
  /** Echoed verbatim from the active release's `i18n.defaultLocale`,
   *  `null` when the release has no i18n slice. */
  defaultLocale: string | null;
  /** Validated host from the routed-function envelope — NOT the raw
   *  `Host` header. Cache-key host comes from here. */
  host: string;
  /** Request information SDK functions need (cookies for `getUser()`,
   *  url for invalidate path-form, etc.). Body is intentionally absent
   *  — user code reads body via the standard Web Request API passed to
   *  the handler. */
  request: {
    method: string;
    url: string;
    headers: Record<string, string | string[] | undefined>;
  };
  /** Capability `auth-aware-ssr`: actor populated from the verified
   *  gateway-signed envelope. The SDK's `auth.user()` returns this
   *  verbatim; consumer code never sees the raw envelope. */
  actor: ActorContext | null;
  /** Capability `auth-hosted-surface-parity`: invocation class. For
   *  `"routed_http"` (browser SSR) the actor is resolved ONLY from the
   *  verified cookie envelope above — `auth.user()` does NOT fall back
   *  to decoding an `Authorization: Bearer` header, so the
   *  "cookie is the only browser actor input" invariant holds. For
   *  `"direct"` (machine / mobile / CI function invocation) the Bearer
   *  fallback is preserved. Defaults to `"direct"` when unset so
   *  pre-existing callers keep the machine contract. */
  invocationKind: "routed_http" | "direct";
  /** Mutable ref: SDK functions that read request-scoped auth or invoke
   *  payment primitives set `value = true`. The SSR Lambda runtime
   *  returns the final value to the gateway in the response metadata
   *  envelope. */
  cacheBypassTainted: { value: boolean };
  /** Mutable ref: SSR runtime sets `value = false` after the response
   *  body has been fully materialized. SDK functions check this AND
   *  the store presence; either being false produces
   *  `R402_SDK_OUTSIDE_REQUEST_CONTEXT`. */
  active: { value: boolean };
}

/** The shared ALS instance. Modules in @run402/functions read from
 *  this; the SSR Lambda runtime (in @run402/astro) writes to it. */
export const als = new AsyncLocalStorage<RunRequestContext>();

/**
 * Read the current request context, or `undefined` if no SSR request
 * is in flight. SDK functions check both this AND `active.value` to
 * decide whether to honor the call.
 */
export function getCurrentContext(): RunRequestContext | undefined {
  return als.getStore();
}

/**
 * Establish a request context and run a callback inside it. The SSR
 * Lambda runtime calls this exactly once per invocation, wrapping the
 * full `App.render(request)` + body-materialization sequence.
 *
 * The `active` flag is set to `true` initially; the caller (the SSR
 * runtime) flips it to `false` after the response body is materialized.
 * Don't call this from user code — it's the runtime's primitive.
 */
export function runWithContext<T>(
  context: Omit<
    RunRequestContext,
    "cacheBypassTainted" | "active" | "actor" | "invocationKind"
  > &
    Partial<
      Pick<
        RunRequestContext,
        "cacheBypassTainted" | "active" | "actor" | "invocationKind"
      >
    >,
  callback: () => Promise<T> | T,
): Promise<T> | T {
  // Resolve the actor either from the caller-provided override (tests, the
  // SSR runtime when it has pre-verified the envelope) or by verifying the
  // inbound actor-context header against the request bound to this context.
  // Failure is non-fatal: the request becomes anonymous AND we log
  // `R402_AUTH_ACTOR_HEADER_SPOOF` so spoof attempts surface in metrics.
  const actor = context.actor !== undefined
    ? context.actor
    : verifyEnvelopeFromRequest(context);
  const full: RunRequestContext = {
    ...context,
    actor,
    // Default to "direct" so pre-existing callers (and tests) keep the
    // machine Bearer-fallback contract; the gateway's routed-HTTP path
    // sets "routed_http" explicitly.
    invocationKind: context.invocationKind ?? "direct",
    cacheBypassTainted: context.cacheBypassTainted ?? { value: false },
    active: context.active ?? { value: true },
  };
  return als.run(full, callback);
}

function verifyEnvelopeFromRequest(
  ctx: Pick<RunRequestContext, "projectId" | "requestId" | "host" | "request">,
): ActorContext | null {
  // `ctx.request.headers` is TYPED as a plain record, but the Lambda runtime
  // and @run402/astro both pass a Web `Request` whose `.headers` is a Web
  // `Headers` instance — read via `.get()` when present, falling back to
  // record access for plain-object callers (tests / custom adapters). Bracket
  // access on a Web `Headers` silently returns undefined, which is why the
  // cookie-derived actor never surfaced in production.
  const encoded = readRequestHeader(ctx.request.headers, ACTOR_CONTEXT_HEADER);
  if (!encoded || typeof encoded !== "string") return null;

  // The gateway binds the envelope to host + path (pathname, query stripped)
  // + request id + method. In the Lambda runtime `ctx.request.url` is the
  // ABSOLUTE URL (`new Request(event.url)`), and `ctx.host` / `ctx.requestId`
  // are NOT populated on the routed-HTTP context — so recover host + pathname
  // from the URL and the request id from the `x-run402-request-id` header the
  // gateway sent alongside the envelope. Plain-object / path-only callers
  // (tests) fall back to the raw url + the ctx fields.
  let host = ctx.host;
  let path = ctx.request.url;
  try {
    const parsed = new URL(ctx.request.url);
    host = parsed.host;
    path = parsed.pathname;
  } catch {
    const q = path.indexOf("?");
    if (q >= 0) path = path.slice(0, q);
  }
  const requestId =
    readRequestHeader(ctx.request.headers, "x-run402-request-id") ?? ctx.requestId;

  const outcome = verifyActorContextEnvelope(encoded, {
    projectId: ctx.projectId,
    requestId,
    method: ctx.request.method,
    host,
    path,
  });

  if (!outcome.ok) {
    logActorContextSpoof(outcome.reason, requestId);
    return null;
  }

  return {
    id: outcome.envelope.actor.id,
    email: outcome.envelope.actor.email,
    emailVerified: outcome.envelope.actor.emailVerified,
    authTime: outcome.envelope.actor.authTime,
    amr: outcome.envelope.actor.amr,
    amrTimes: outcome.envelope.actor.amrTimes,
    authzVersion: outcome.envelope.actor.authzVersion,
    // session_id is NOT in the envelope — it's gateway-internal state.
    // For now we mint a deterministic-by-request id so downstream code
    // has a string to hang `db()` set_config on. Once the gateway adds
    // session_id to the envelope (planned in section 4 of the spec),
    // populate it here from outcome.envelope.actor.sessionId.
    sessionId: outcome.envelope.request_id,
  };
}

/** Read one header value from either a Web `Headers` instance (the Lambda
 *  runtime + @run402/astro pass a real `Request`) or a plain Node-style
 *  record (tests / custom adapters). `RunRequestContext.request.headers` is
 *  typed as a record, but the production callers pass `Headers` — so bracket
 *  access alone silently misses every header. Returns undefined when absent. */
function readRequestHeader(
  headers: RunRequestContext["request"]["headers"],
  name: string,
): string | undefined {
  const maybeHeaders = headers as unknown as {
    get?: (n: string) => string | null;
  };
  if (maybeHeaders && typeof maybeHeaders.get === "function") {
    return maybeHeaders.get(name) ?? undefined;
  }
  const v = (headers as Record<string, string | string[] | undefined>)?.[name];
  return Array.isArray(v) ? v[0] : v;
}

function logActorContextSpoof(reason: VerifyFailureReason, requestId: string): void {
  // Structured one-line log so observability can alert on rate. The
  // SDK runs in Lambda; CloudWatch picks this up.
  // eslint-disable-next-line no-console
  console.warn(
    JSON.stringify({
      level: "warn",
      event: "R402_AUTH_ACTOR_HEADER_SPOOF",
      reason,
      request_id: requestId,
    }),
  );
}

/**
 * Throw a structured `R402_SDK_OUTSIDE_REQUEST_CONTEXT` error. Used by
 * SDK functions when they're invoked with no ALS store OR while the
 * context has been marked inactive.
 *
 * Per the api-error-envelope spec, the thrown error carries:
 *   - `code: 'R402_SDK_OUTSIDE_REQUEST_CONTEXT'`
 *   - `message`: names the SDK function and the cause
 *   - `suggestedFix`: recommends moving the call inside a handler OR
 *     not scheduling background work that outlives the response
 *   - `docs`: `https://run402.com/errors/#R402_SDK_OUTSIDE_REQUEST_CONTEXT`
 */
export class Run402OutsideRequestContextError extends Error {
  readonly code = "R402_SDK_OUTSIDE_REQUEST_CONTEXT";
  readonly docs = "https://run402.com/errors/#R402_SDK_OUTSIDE_REQUEST_CONTEXT";
  readonly suggestedFix: string;
  readonly sdkFunction: string;
  readonly cause: "no_context" | "context_inactive";

  constructor(sdkFunction: string, cause: "no_context" | "context_inactive") {
    const causeMsg =
      cause === "no_context"
        ? "no active request context (called from module scope or outside a handler)"
        : "request context marked inactive (called from a timer or unawaited promise after response completion)";
    super(`${sdkFunction}: ${causeMsg}`);
    this.name = "Run402OutsideRequestContextError";
    this.sdkFunction = sdkFunction;
    this.cause = cause;
    this.suggestedFix =
      cause === "no_context"
        ? `Move the ${sdkFunction} call inside an HTTP request handler or Astro frontmatter. SDK functions cannot resolve project context outside an active request.`
        : `The request that called ${sdkFunction} has already returned. Don't schedule SDK calls in setTimeout / setInterval / unawaited promises that outlive the handler.`;
  }
}

/**
 * Assert that a request context is active. Returns the context on
 * success; throws `Run402OutsideRequestContextError` on failure.
 *
 * SDK functions call this as the first line, e.g.:
 *
 *   const ctx = requireActiveContext("db");
 *   // use ctx.projectId, ctx.request.headers, etc.
 */
export function requireActiveContext(sdkFunction: string): RunRequestContext {
  const ctx = als.getStore();
  if (ctx === undefined) {
    throw new Run402OutsideRequestContextError(sdkFunction, "no_context");
  }
  if (!ctx.active.value) {
    throw new Run402OutsideRequestContextError(sdkFunction, "context_inactive");
  }
  return ctx;
}

/**
 * Flip the cache-bypass taint flag on the current context. Called by
 * `getUser()` and payment-primitive SDK calls to signal that the
 * rendered response depends on request-scoped auth state and therefore
 * MUST NOT be cached publicly.
 *
 * No-op if there is no active context (rather than throwing — the taint
 * is moot when there's no cache layer to inform).
 */
export function taintCacheBypass(): void {
  const ctx = als.getStore();
  if (ctx !== undefined) {
    ctx.cacheBypassTainted.value = true;
  }
}

/**
 * Canonical registry of SDK functions that are "payment primitives" for
 * cache-taint purposes. Calling any of these inside an active request
 * context MUST flip `cacheBypassTainted.value = true`. The set is
 * defined here so the spec, runtime, and docs share one source of truth.
 *
 * To add a new payment primitive: append to this set AND ensure the
 * function's implementation calls `taintCacheBypass()` on every entry.
 *
 * @see openspec/changes/astro-ssr-runtime/specs/functions-sdk-auth-model/spec.md
 */
export const PAYMENT_PRIMITIVES: ReadonlySet<string> = new Set([
  // None implemented yet — the registry exists so the contract is
  // explicit and discoverable. Payment-primitive SDK functions added
  // in future changes (per Run402 x402/MPP roadmap) will register here
  // as they land.
  // Example future entries (commented to keep the set actually empty
  // until the helpers ship):
  //   "payments.require",
  //   "payments.gate",
  //   "payments.fulfill",
]);

/**
 * Helper for payment-primitive implementations. Wraps the body in a
 * taint-on-entry call so the registry contract is enforced at the
 * SDK layer rather than relying on each implementation to remember.
 *
 * Example:
 *   export const requirePayment = withPaymentTaint("payments.require", async (opts) => {
 *     // ... actual implementation
 *   });
 */
export function withPaymentTaint<TArgs extends unknown[], TReturn>(
  name: string,
  impl: (...args: TArgs) => TReturn,
): (...args: TArgs) => TReturn {
  if (!PAYMENT_PRIMITIVES.has(name)) {
    // Doesn't throw — adding a new primitive is a code change and the
    // dev sees this on first invocation. Throwing would block legitimate
    // experimentation. But emit a warning so the registry stays correct.
    // eslint-disable-next-line no-console
    console.warn(
      `[run402] withPaymentTaint("${name}") called but "${name}" is not in PAYMENT_PRIMITIVES. ` +
        `Add it to packages/functions/src/runtime-context.ts to keep the cache-taint registry consistent.`,
    );
  }
  return (...args: TArgs): TReturn => {
    taintCacheBypass();
    return impl(...args);
  };
}
