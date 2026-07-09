import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { getRun402Context } from "./request-context.js";

describe("getRun402Context", () => {
  it("reads all six fields from a Web Headers-like .get() source", () => {
    const headers = new Headers({
      "x-run402-request-id": "req_abc",
      "x-run402-project-id": "prj_xyz",
      "x-run402-release-id": "rel_123",
      "x-run402-host": "eagles.kychon.com",
      "x-run402-locale": "pt-BR",
      "x-run402-default-locale": "en",
      "x-run402-idempotency-key": "paid-call-1",
    });
    const ctx = getRun402Context(headers);
    assert.equal(ctx.requestId, "req_abc");
    assert.equal(ctx.projectId, "prj_xyz");
    assert.equal(ctx.releaseId, "rel_123");
    assert.equal(ctx.host, "eagles.kychon.com");
    assert.equal(ctx.locale, "pt-BR");
    assert.equal(ctx.defaultLocale, "en");
    assert.equal(ctx.idempotencyKey, "paid-call-1");
  });

  it("reads from a Request-like .headers source", () => {
    const req = new Request("https://eagles.kychon.com/x", {
      headers: {
        "x-run402-request-id": "req_def",
        "x-run402-project-id": "prj_xyz",
        "x-run402-host": "eagles.kychon.com",
      },
    });
    const ctx = getRun402Context(req);
    assert.equal(ctx.requestId, "req_def");
    assert.equal(ctx.projectId, "prj_xyz");
    assert.equal(ctx.host, "eagles.kychon.com");
    assert.equal(ctx.releaseId, null);
    assert.equal(ctx.locale, null);
    assert.equal(ctx.defaultLocale, null);
    assert.equal(ctx.idempotencyKey, null);
  });

  it("reads from a plain header-map object", () => {
    const event = {
      "x-run402-request-id": "req_ghi",
      "x-run402-project-id": "prj_xyz",
    };
    const ctx = getRun402Context(event);
    assert.equal(ctx.requestId, "req_ghi");
    assert.equal(ctx.projectId, "prj_xyz");
    assert.equal(ctx.host, null);
    assert.equal(ctx.idempotencyKey, null);
  });

  it("returns null for absent headers (does not throw)", () => {
    const ctx = getRun402Context(new Headers({}));
    assert.equal(ctx.requestId, null);
    assert.equal(ctx.projectId, null);
    assert.equal(ctx.releaseId, null);
    assert.equal(ctx.host, null);
    assert.equal(ctx.locale, null);
    assert.equal(ctx.defaultLocale, null);
    assert.equal(ctx.idempotencyKey, null);
  });

  it("collapses empty-string headers to null", () => {
    const headers = new Headers({
      "x-run402-request-id": "",
      "x-run402-locale": "   ",
      "x-run402-idempotency-key": "   ",
    });
    const ctx = getRun402Context(headers);
    assert.equal(ctx.requestId, null);
    assert.equal(ctx.locale, null);
    assert.equal(ctx.idempotencyKey, null);
  });

  it("handles array-form header values (first wins)", () => {
    const event = {
      "x-run402-host": ["eagles.kychon.com", "shadow-other.example"],
      "x-run402-request-id": ["req_arr"],
      "x-run402-idempotency-key": ["idem_arr"],
    };
    const ctx = getRun402Context(event);
    assert.equal(ctx.host, "eagles.kychon.com");
    assert.equal(ctx.requestId, "req_arr");
    assert.equal(ctx.idempotencyKey, "idem_arr");
  });

  it("is case-insensitive against Node-style header maps", () => {
    const event = {
      "X-Run402-Request-Id": "req_mixed",
      "X-Run402-Locale": "en",
      "X-Run402-Idempotency-Key": "idem_mixed",
    };
    const ctx = getRun402Context(event);
    assert.equal(ctx.requestId, "req_mixed");
    assert.equal(ctx.locale, "en");
    assert.equal(ctx.idempotencyKey, "idem_mixed");
  });

  it("trims whitespace from header values", () => {
    const headers = new Headers({
      "x-run402-host": "  eagles.kychon.com  ",
    });
    const ctx = getRun402Context(headers);
    assert.equal(ctx.host, "eagles.kychon.com");
  });
});
