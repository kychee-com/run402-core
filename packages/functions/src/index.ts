export { db, adminDb, QueryBuilder, R402DbError } from "./db.js";
export type { R402DbErrorCode, AdminSqlResult } from "./db.js";
export { getUser, getUserId, getRole } from "./auth.js";
export type { User } from "./auth.js";

// Capability `auth-aware-ssr` (v3.0). The canonical server-side auth
// namespace. `auth.user()` / `auth.requireUser()` / `auth.requireRole(...)`
// / `auth.requireMembership(...)` / `auth.requireFresh({...})` /
// `auth.fetch(...)` / `auth.csrfField()` / `auth.sessions.*` /
// `auth.identities.link(...)` are the only documented identity surfaces.
// See openspec/changes/auth-aware-ssr/specs/auth-sdk-namespace/spec.md.
export { auth } from "./auth/index.js";
export type {
  Actor,
  RoleSource,
  IdentityProof,
  TenantUser,
  CreateResponseFromTenantAssertionOptions,
  AccountSecurity,
  Run402Identity,
  TenantAssertionRef,
} from "./auth/index.js";
export {
  Run402AuthError,
  AuthRequiredError,
  InsufficientRoleError,
  InsufficientMembershipError,
  RoleGateNotConfiguredError,
  MembershipGateNotWiredError,
  FreshnessRequiredError,
  FetchAbsoluteUrlError,
  PrerenderedError,
  UnknownExportError,
  SessionBridgeUnverifiedError,
  IdentityLinkConflictError,
  UnknownIdentityError,
  InvalidCredentialsError,
  TenantSubjectInvalidError,
  RenamedExportError,
} from "./auth/index.js";
// Throwing-sentinel exports for the top legacy bare-name imports. These
// fire `R402_AUTH_UNKNOWN_EXPORT` at runtime with a structured fix-it,
// catching the case where `run402 doctor` and the ESLint rule didn't run
// (e.g. agent paste straight into a route handler). Excluded from public
// docs intentionally — they exist to fail loudly, not as API.
export { getSession, currentUser, getCurrentUser, getServerSession } from "./auth/index.js";
export { email } from "./email.js";
export type { EmailSendOptions, EmailRawOptions, EmailTemplateOptions, EmailSendResult } from "./email.js";
export { ai } from "./ai.js";
export type {
  GenerateImageOptions,
  GenerateImageResult,
  ImageAspect,
  TranslateOptions,
  TranslateResult,
  ModerateResult,
} from "./ai.js";
export { assets } from "./assets.js";
// `verifyWebhook(headers, rawBody, secret)` — verify a Run402-signed
// operator-notifications webhook delivery. Stripe-shape HMAC SHA256 with
// dual-secret rotation grace.
export { verifyWebhook } from "./verify-webhook.js";
export type { VerifyWebhookOptions, VerifyWebhookResult, HeadersLike } from "./verify-webhook.js";
// `getRun402Context(request)` — zero-dep helper for non-Astro Node22
// functions (webhooks, auth endpoints, admin tools) to read the
// per-request context the gateway populates as `x-run402-*` headers.
// Returns the same shape `Astro.locals.run402` exposes in `@run402/astro`,
// so Astro and plain-function code share one mental model.
export { getRun402Context } from "./request-context.js";
export type { Run402RequestContext } from "./request-context.js";
export type {
  AssetPutOptions,
  AssetPutSource,
  AssetPutSourceInput,
  AssetRef,
  AssetVisibility,
  AssetVariant,
  // v1.50
  AssetListRow,
  AssetsListFilter,
  AssetsListOptions,
  AssetsListResult,
  AssetsListSort,
  ImageInfo,
} from "./assets.js";
export { bytes, getRoutedPaymentContext, isRequest, json, routedHttp, text } from "./routed-http.js";
export type {
  RoutedHttpHeaderList,
  RoutedHttpFulfillmentDirectiveV1,
  RoutedHttpPaymentContextSource,
  RoutedHttpPaymentContextV1,
  RoutedHttpRequestV1,
  RoutedHttpResponseInit,
  RoutedHttpResponseV1,
} from "./routed-http.js";
export {
  consumeMerchantFulfillmentDirective,
  decodeMerchantFulfillmentDirective,
  MERCHANT_FULFILLMENT_DIRECTIVE_HEADER,
  MERCHANT_RECEIPT_MODE_HEADER,
  payment,
  Run402PaymentFulfillmentError,
} from "./payment.js";
export type { Run402PaymentFulfillmentErrorCode } from "./payment.js";
export {
  defineFunctionRuns,
  functions,
  isFunctionRun,
  parseFunctionRun,
  parseFunctionRunEnvelope,
  permanentFunctionRunError,
  retryableFunctionRunError,
  Run402FunctionRunContextError,
  Run402FunctionRunFailure,
  Run402FunctionRunInputError,
  Run402FunctionRunPlatformError,
} from "./function-runs.js";
export type {
  FunctionRunAttemptEnvelope,
  FunctionRunCreateOptions,
  FunctionRunEnvelope,
  FunctionRunErrorInfo,
  FunctionRunHandle,
  FunctionRunHandler,
  FunctionRunHandlerContext,
  FunctionRunHandlerDefinition,
  FunctionRunHandlers,
  FunctionRunPayloadParser,
  FunctionRunPayloadValidator,
  FunctionRunRetryPolicy,
  FunctionRunSafePayloadParser,
  FunctionRunSource,
  FunctionRunStatus,
} from "./function-runs.js";
// Capability `astro-ssr-runtime` (v1.52).
// `cache.*` — sub-second admin-edit visibility via origin-side ISR
// cache invalidation. Server-side (function-context) only.
export { cache } from "./cache.js";
export type {
  Cache,
  CacheInvalidateResult,
  InvalidatePrefixOptions,
  InvalidateAllOptions,
} from "./cache.js";
export {
  CacheInvalidationHostRequiredError,
  CacheInvalidationHostForbiddenError,
} from "./cache.js";
// Runtime context primitives — used internally by SDK functions to read
// the current SSR request from AsyncLocalStorage. The SSR Lambda runtime
// (in @run402/astro) uses `runWithContext` to establish the store; user
// code typically does not import these directly.
export {
  als,
  getCurrentContext,
  runWithContext,
  requireActiveContext,
  taintCacheBypass,
  withPaymentTaint,
  PAYMENT_PRIMITIVES,
  Run402OutsideRequestContextError,
} from "./runtime-context.js";
export type { RunRequestContext } from "./runtime-context.js";
// auth-hosted-surface-parity: the generated Lambda entry wrapper awaits this
// before resolving a cookie-derived actor. It fetches the gateway-only
// actor-context verify key once at cold start (the key is never in the
// tenant Lambda env). No-op in local dev / in-process gateway (key in env).
export { ensureActorContextKeysLoaded } from "./lib/actor-context-verify.js";
// `events.emit(type, payload?, opts?)` — emit a fact into this project's
// cursored event feed (gateway change `app-events-emit-lane`). Service-key
// context inside deployed functions; the gateway owns vocabulary/quota
// policy, this namespace is a dumb pipe plus idempotency-key ergonomics.
export { events, Run402EventsPlatformError } from "./events.js";
export type { EventEmitOptions, EventEmitResult, EventNextAction } from "./events.js";
