import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  bytes,
  isRequest,
  json,
  routedHttp,
  text,
  type RoutedHttpRequestV1,
  type RoutedHttpResponseV1,
} from "./index.js";

describe("routed HTTP helpers", () => {
  it("encodes text responses with a default content type", () => {
    const res = text("hello");
    assert.equal(res.status, 200);
    assert.deepEqual(res.headers, [["content-type", "text/plain; charset=utf-8"]]);
    assert.deepEqual(res.body, {
      encoding: "base64",
      data: "aGVsbG8=",
      size: 5,
    });
  });

  it("encodes json and preserves explicit headers and cookies", () => {
    const res = json({ ok: true }, {
      status: 201,
      headers: [["content-type", "application/vnd.test+json"]],
      cookies: ["sid=abc; HttpOnly", "theme=dark"],
    });
    assert.equal(res.status, 201);
    assert.deepEqual(res.headers, [["content-type", "application/vnd.test+json"]]);
    assert.deepEqual(res.cookies, ["sid=abc; HttpOnly", "theme=dark"]);
    assert.equal(Buffer.from(res.body!.data, "base64").toString("utf8"), '{"ok":true}');
  });

  it("encodes bytes and exposes the routedHttp namespace", () => {
    const res = routedHttp.bytes(new Uint8Array([0, 1, 2]));
    assert.deepEqual(res.body, {
      encoding: "base64",
      data: "AAEC",
      size: 3,
    });
    assert.deepEqual(bytes(new Uint8Array([3])).body?.size, 1);
  });

  it("narrows routed request envelopes", () => {
    const req: RoutedHttpRequestV1 = {
      version: "run402.routed_http.v1",
      method: "GET",
      url: "https://example.com/api/hello?limit=1",
      path: "/api/hello",
      rawPath: "/api/hello",
      rawQuery: "limit=1",
      headers: [["host", "example.com"]],
      cookies: { raw: null },
      body: null,
      context: {
        source: "route",
        projectId: "prj_test",
        releaseId: "rel_test",
        deploymentId: "dpl_test",
        host: "example.com",
        proto: "https",
        routePattern: "/api/*",
        routeKind: "prefix",
        routeTarget: { type: "function", name: "api" },
        requestId: "req_test",
      },
    };
    assert.equal(isRequest(req), true);
    assert.equal(routedHttp.isRequest({}), false);
  });

  it("lets TypeScript assign helper output to the public response type", () => {
    const res: RoutedHttpResponseV1 = routedHttp.json({ ok: true });
    assert.equal(res.status, 200);
  });

  // Capability `routed-locale-context`. The envelope adds optional
  // `locale` and `defaultLocale` on `context`. Tests verify three shapes:
  // present, omitted (older gateway), and null (gateway with i18n absent).
  it("exposes ctx.locale and ctx.defaultLocale when present", () => {
    const req: RoutedHttpRequestV1 = baseEnvelope({
      locale: "es",
      defaultLocale: "en",
    });
    assert.equal(req.context.locale, "es");
    assert.equal(req.context.defaultLocale, "en");
    // The Kychon "skip translation JOIN if default" pattern.
    const isDefault = req.context.locale === req.context.defaultLocale;
    assert.equal(isDefault, false);
  });

  it("envelope from older gateways omits locale fields; ?? null normalizes them", () => {
    const req: RoutedHttpRequestV1 = baseEnvelope({});
    assert.equal(req.context.locale ?? null, null);
    assert.equal(req.context.defaultLocale ?? null, null);
  });

  it("envelope with explicit null locale (no i18n slice on release)", () => {
    const req: RoutedHttpRequestV1 = baseEnvelope({
      locale: null,
      defaultLocale: null,
    });
    assert.equal(req.context.locale, null);
    assert.equal(req.context.defaultLocale, null);
  });
});

/** Minimal routed envelope for ctx-locale shape tests. */
function baseEnvelope(opts: {
  locale?: string | null;
  defaultLocale?: string | null;
}): RoutedHttpRequestV1 {
  return {
    version: "run402.routed_http.v1",
    method: "GET",
    url: "https://example.com/about",
    path: "/about",
    rawPath: "/about",
    rawQuery: "",
    headers: [],
    cookies: { raw: null },
    body: null,
    context: {
      source: "route",
      projectId: "prj_test",
      releaseId: "rel_test",
      deploymentId: "dpl_test",
      host: "example.com",
      proto: "https",
      routePattern: "/about",
      routeKind: "exact",
      routeTarget: { type: "function", name: "page" },
      requestId: "req_test",
      ...(opts.locale !== undefined ? { locale: opts.locale } : {}),
      ...(opts.defaultLocale !== undefined ? { defaultLocale: opts.defaultLocale } : {}),
    },
  };
}
