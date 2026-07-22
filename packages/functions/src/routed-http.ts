import { Buffer } from "node:buffer";

export type RoutedHttpHeaderList = Array<[string, string]>;

export interface RoutedHttpPaymentContextV1 {
  scheme: "x402";
  paymentId: string;
  /** Caller-owned business key accepted by Run402, or null for proof-keyed requests. */
  idempotencyKey: string | null;
  /** True when this request reused a payment identity admitted by an earlier request. */
  deduplicated: boolean;
  /** Whether this is the first tenant invocation for the payment or a safe replay. */
  delivery: "first" | "replay";
  amountUsdMicros: number;
  payer: string | null;
  network: string;
  asset: string | null;
  payTo: string;
  transaction: string | null;
  settledAt: string;
}

export interface RoutedHttpRequestV1 {
  version: "run402.routed_http.v1";
  method: string;
  url: string;
  path: string;
  rawPath: string;
  rawQuery: string;
  headers: RoutedHttpHeaderList;
  cookies: { raw: string | null };
  body: null | {
    encoding: "base64";
    data: string;
    size: number;
  };
  context: {
    source: "route";
    projectId: string;
    releaseId: string | null;
    deploymentId: string | null;
    host: string;
    proto: "https" | "http";
    routePattern: string;
    routeKind: "exact" | "prefix";
    routeTarget: { type: "function"; name: string };
    requestId: string;
    clientIp?: string;
    userAgent?: string;
    /** Capability `routed-locale-context`. Canonical locale tag (byte-
     *  identical to an entry in the active release's `i18n.locales[]`)
     *  when the release declares an i18n slice, `null` otherwise.
     *
     *  **User functions read this via REQUEST HEADERS, not via `event.context`.**
     *  The bundled `@run402/functions` runtime translates the routed envelope
     *  into a Web-standard `Request` before calling user code, dropping
     *  `event.context`. The gateway also adds `x-run402-locale` to the
     *  forwarded request headers, alongside `x-run402-project-id` etc.:
     *  `const locale = req.headers.get('x-run402-locale');`
     *
     *  This `context.locale` field is preserved for raw-envelope consumers
     *  (custom Lambda runtimes that bypass `buildEntryWrapper`). OPTIONAL on
     *  the type: gateways predating 2.3.0 / releases without `spec.i18n`
     *  omit this field entirely. Read as `event.context.locale ?? null`. */
    locale?: string | null;
    /** Echoed verbatim from the active release's `i18n.defaultLocale`,
     *  `null` when the release has no i18n slice. Same access rules as
     *  `locale`: user functions read `req.headers.get('x-run402-default-locale')`;
     *  raw-envelope consumers read `event.context.defaultLocale ?? null`. */
    defaultLocale?: string | null;
    /** Confirmed tenant x402 payment context for priced routed function
     *  routes. Present only after the gateway has verified and settled the
     *  route payment. Unpriced routes omit this field or set it to `null`.
     *  Web `Request` handlers should use `getRoutedPaymentContext(request)`
     *  or read the corresponding `x-run402-payment-*` headers. */
    payment?: RoutedHttpPaymentContextV1 | null;
  };
}

type HeaderGetter = { get(name: string): string | null };

type RoutedHttpPaymentHeaderSource =
  | HeaderGetter
  | { headers: HeaderGetter | RoutedHttpHeaderList | Record<string, string | string[] | undefined> }
  | RoutedHttpHeaderList
  | Record<string, string | string[] | undefined>;

export type RoutedHttpPaymentContextSource =
  | RoutedHttpRequestV1
  | RoutedHttpPaymentHeaderSource;

export interface RoutedHttpResponseV1 {
  status: number;
  headers?: RoutedHttpHeaderList;
  cookies?: string[];
  body?: null | {
    encoding: "base64";
    data: string;
    size: number;
  };
}

export interface RoutedHttpResponseInit {
  status?: number;
  headers?: RoutedHttpHeaderList;
  cookies?: string[];
}

export function text(
  body: string,
  init: RoutedHttpResponseInit = {},
): RoutedHttpResponseV1 {
  return withBody(Buffer.from(body, "utf8"), {
    status: init.status,
    headers: withDefaultContentType(init.headers, "text/plain; charset=utf-8"),
    cookies: init.cookies,
  });
}

export function json(
  value: unknown,
  init: RoutedHttpResponseInit = {},
): RoutedHttpResponseV1 {
  return withBody(Buffer.from(JSON.stringify(value), "utf8"), {
    status: init.status,
    headers: withDefaultContentType(init.headers, "application/json; charset=utf-8"),
    cookies: init.cookies,
  });
}

export function bytes(
  value: Uint8Array,
  init: RoutedHttpResponseInit = {},
): RoutedHttpResponseV1 {
  return withBody(value, init);
}

export function isRequest(event: unknown): event is RoutedHttpRequestV1 {
  return isRecord(event) && event.version === "run402.routed_http.v1";
}

export function getRoutedPaymentContext(
  source: RoutedHttpPaymentContextSource,
): RoutedHttpPaymentContextV1 | null {
  if (isRequest(source)) {
    return normalizePaymentContext(source.context.payment) ??
      paymentContextFromHeaders(source.headers);
  }
  return paymentContextFromHeaders(source);
}

export const routedHttp = {
  text,
  json,
  bytes,
  isRequest,
  paymentContext: getRoutedPaymentContext,
};

function withBody(
  value: Uint8Array,
  init: RoutedHttpResponseInit,
): RoutedHttpResponseV1 {
  const bodyBytes = value instanceof Buffer ? value : Buffer.from(value);
  const response: RoutedHttpResponseV1 = {
    status: init.status ?? 200,
    body: {
      encoding: "base64",
      data: bodyBytes.toString("base64"),
      size: bodyBytes.byteLength,
    },
  };
  if (init.headers !== undefined) response.headers = init.headers;
  if (init.cookies !== undefined) response.cookies = init.cookies;
  return response;
}

function withDefaultContentType(
  headers: RoutedHttpHeaderList | undefined,
  contentType: string,
): RoutedHttpHeaderList {
  const out = headers ? [...headers] : [];
  const hasContentType = out.some(([name]) => name.toLowerCase() === "content-type");
  if (!hasContentType) out.unshift(["content-type", contentType]);
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function normalizePaymentContext(value: unknown): RoutedHttpPaymentContextV1 | null {
  if (!isRecord(value)) return null;
  if (value.scheme !== "x402") return null;
  const paymentId = nonEmptyString(value.paymentId);
  const idempotencyKey = nullableString(value.idempotencyKey);
  const deduplicated = value.deduplicated;
  const delivery = value.delivery;
  const amountUsdMicros = value.amountUsdMicros;
  const network = nonEmptyString(value.network);
  const payTo = nonEmptyString(value.payTo);
  const settledAt = nonEmptyString(value.settledAt);
  if (
    paymentId === null ||
    (value.idempotencyKey !== null && idempotencyKey === null) ||
    typeof deduplicated !== "boolean" ||
    (delivery !== "first" && delivery !== "replay") ||
    typeof amountUsdMicros !== "number" ||
    !Number.isSafeInteger(amountUsdMicros) ||
    amountUsdMicros <= 0 ||
    network === null ||
    payTo === null ||
    settledAt === null
  ) {
    return null;
  }
  return {
    scheme: "x402",
    paymentId,
    idempotencyKey,
    deduplicated,
    delivery,
    amountUsdMicros,
    payer: nullableString(value.payer),
    network,
    asset: nullableString(value.asset),
    payTo,
    transaction: nullableString(value.transaction),
    settledAt,
  };
}

function paymentContextFromHeaders(
  source: RoutedHttpPaymentHeaderSource,
): RoutedHttpPaymentContextV1 | null {
  const get = headerGetter(source);
  if (!get) return null;
  if (nonEmpty(get("x-run402-payment-scheme")) !== "x402") return null;
  const paymentId = nonEmpty(get("x-run402-payment-id"));
  const idempotencyKeyRaw = get("x-run402-payment-idempotency-key");
  const idempotencyKey = nonEmpty(idempotencyKeyRaw);
  const deduplicatedRaw = nonEmpty(get("x-run402-payment-deduplicated"));
  const delivery = nonEmpty(get("x-run402-payment-delivery"));
  const amountRaw = nonEmpty(get("x-run402-payment-amount-usd-micros"));
  const network = nonEmpty(get("x-run402-payment-network"));
  const payTo = nonEmpty(get("x-run402-payment-pay-to"));
  const settledAt = nonEmpty(get("x-run402-payment-settled-at"));
  if (
    paymentId === null ||
    (idempotencyKeyRaw !== null && idempotencyKey === null) ||
    (deduplicatedRaw !== "true" && deduplicatedRaw !== "false") ||
    (delivery !== "first" && delivery !== "replay") ||
    amountRaw === null ||
    network === null ||
    payTo === null ||
    settledAt === null
  ) {
    return null;
  }
  const amountUsdMicros = Number(amountRaw);
  if (!Number.isSafeInteger(amountUsdMicros) || amountUsdMicros <= 0) {
    return null;
  }
  return {
    scheme: "x402",
    paymentId,
    idempotencyKey,
    deduplicated: deduplicatedRaw === "true",
    delivery,
    amountUsdMicros,
    payer: nonEmpty(get("x-run402-payment-payer")),
    network,
    asset: nonEmpty(get("x-run402-payment-asset")),
    payTo,
    transaction: nonEmpty(get("x-run402-payment-transaction")),
    settledAt,
  };
}

function headerGetter(
  source: RoutedHttpPaymentHeaderSource,
): ((name: string) => string | null) | null {
  if (Array.isArray(source)) return headerListGetter(source);
  if (typeof (source as { get?: unknown }).get === "function") {
    const getter = (source as HeaderGetter).get.bind(source);
    return (name) => getter(name) ?? getter(name.toLowerCase()) ?? null;
  }
  const nested = (source as { headers?: unknown }).headers;
  if (Array.isArray(nested)) return headerListGetter(nested);
  if (nested && typeof (nested as { get?: unknown }).get === "function") {
    const getter = (nested as HeaderGetter).get.bind(nested);
    return (name) => getter(name) ?? getter(name.toLowerCase()) ?? null;
  }
  if (isPlainHeaderRecord(nested)) return recordHeaderGetter(nested);
  if (isPlainHeaderRecord(source)) return recordHeaderGetter(source);
  return null;
}

function headerListGetter(
  headers: RoutedHttpHeaderList,
): (name: string) => string | null {
  return (name) => {
    const lower = name.toLowerCase();
    const match = headers.find(([headerName]) => headerName.toLowerCase() === lower);
    return match?.[1] ?? null;
  };
}

function recordHeaderGetter(
  headers: Record<string, string | string[] | undefined>,
): (name: string) => string | null {
  const lowered: Record<string, string | string[] | undefined> = {};
  for (const key of Object.keys(headers)) {
    lowered[key.toLowerCase()] = headers[key];
  }
  return (name) => {
    const value = lowered[name.toLowerCase()];
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      const first = value[0];
      if (typeof first === "string") return first;
    }
    return null;
  };
}

function isPlainHeaderRecord(
  value: unknown,
): value is Record<string, string | string[] | undefined> {
  if (!isRecord(value) || Array.isArray(value)) return false;
  return Object.values(value).every((entry) =>
    entry === undefined ||
    typeof entry === "string" ||
    (Array.isArray(entry) && entry.every((item) => typeof item === "string"))
  );
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : nonEmptyString(value);
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return nonEmpty(value);
}

function nonEmpty(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
