import { Buffer } from "node:buffer";

export type RoutedHttpHeaderList = Array<[string, string]>;

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
  };
}

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

export const routedHttp = {
  text,
  json,
  bytes,
  isRequest,
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
