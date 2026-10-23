import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

mock.module("./config.js", {
  namedExports: {
    config: {
      API_BASE: "https://test.run402.com",
      PROJECT_ID: "prj_test",
      SERVICE_KEY: "sk_test",
    },
  },
});

const { email, EmailConfigurationError, Run402EmailPlatformError } = await import("./email.js");

// email is a module-level singleton with an internal _mailboxId cache.
// The first describe block must handle discovery + send (two fetch calls).
// Subsequent blocks hit the cached mailbox ID (one fetch call each).

describe("email.send — default mailbox discovery rejects unsafe implicit selection", () => {
  it("throws a typed ambiguity error when multiple send-ready mailboxes have no default", async () => {
    const calls: Array<{ url: string; opts: RequestInit }> = [];
    mock.method(globalThis, "fetch", async (url: string, opts: RequestInit) => {
      calls.push({ url, opts });
      return new Response(
        JSON.stringify({
          mailboxes: [
            { mailbox_id: "mbx_a", slug: "a", address: "a@example.com", status: "active", can_send: true },
            { mailbox_id: "mbx_b", slug: "b", address: "b@example.com", status: "active", can_send: true },
          ],
          mailbox_settings: { default_outbound_mailbox_id: null, auth_sender_mailbox_id: null },
          next_actions: [{ type: "edit_request", path: "/mailboxes/v1/settings" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    await assert.rejects(
      () => email.send({ to: "user@example.com", subject: "Hi", html: "<p>Hello</p>" }),
      (err: unknown) => {
        assert.ok(err instanceof EmailConfigurationError);
        assert.equal(err.code, "AMBIGUOUS_MAILBOX");
        assert.equal((err.details.candidates as unknown[]).length, 2);
        assert.ok(Array.isArray(err.next_actions));
        return true;
      },
    );
    assert.equal(calls.length, 1, "should fail before POST /messages");
  });

  it("throws a typed missing-default error when no active mailbox exists", async () => {
    const calls: Array<{ url: string; opts: RequestInit }> = [];
    mock.method(globalThis, "fetch", async (url: string, opts: RequestInit) => {
      calls.push({ url, opts });
      return new Response(
        JSON.stringify({ mailboxes: [], mailbox_settings: {} }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    await assert.rejects(
      () => email.send({ to: "user@example.com", subject: "Hi", html: "<p>Hello</p>" }),
      (err: unknown) => {
        assert.ok(err instanceof EmailConfigurationError);
        assert.equal(err.code, "DEFAULT_MAILBOX_REQUIRED");
        return true;
      },
    );
    assert.equal(calls.length, 1, "should fail before POST /messages");
  });

  it("throws a provider configuration error when Core has mailboxes but no outbound provider", async () => {
    const calls: Array<{ url: string; opts: RequestInit }> = [];
    mock.method(globalThis, "fetch", async (url: string, opts: RequestInit) => {
      calls.push({ url, opts });
      return new Response(
        JSON.stringify({
          mailboxes: [{
            mailbox_id: "mbx_core",
            slug: "notify",
            address: "notify@run402-core.local",
            status: "active",
            can_send: false,
            send_blocked_reason: "provider_not_configured",
          }],
          mailbox_settings: { default_outbound_mailbox_id: "mbx_core", auth_sender_mailbox_id: null },
          provider_readiness: { status: "not_configured", provider: "disabled" },
          next_actions: [{ type: "edit_request", path: "host environment" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    await assert.rejects(
      () => email.send({ to: "user@example.com", subject: "Hi", html: "<p>Hello</p>" }),
      (err: unknown) => {
        assert.ok(err instanceof EmailConfigurationError);
        assert.equal(err.code, "PROVIDER_NOT_CONFIGURED");
        assert.deepEqual(err.details.provider_readiness, { status: "not_configured", provider: "disabled" });
        assert.ok(Array.isArray(err.next_actions));
        return true;
      },
    );
    assert.equal(calls.length, 1, "should fail before POST /messages");
  });
});

describe("email.send — first call discovers default mailbox via GET /mailboxes/v1", () => {
  it("uses configured default_outbound_mailbox_id instead of mailbox list position", async () => {
    const calls: Array<{ url: string; opts: RequestInit }> = [];
    mock.method(globalThis, "fetch", async (url: string, opts: RequestInit) => {
      calls.push({ url, opts });
      if (url.endsWith("/mailboxes/v1")) {
        return new Response(
          JSON.stringify({
            mailboxes: [
              { mailbox_id: "mbx_other", slug: "other", status: "active", can_send: true },
              { mailbox_id: "mbx_test", slug: "default", status: "active", can_send: true },
            ],
            mailbox_settings: { default_outbound_mailbox_id: "mbx_test", auth_sender_mailbox_id: null },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ id: "msg_001" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const result = await email.send({ to: "user@example.com", subject: "Hi", html: "<p>Hello</p>" });

    // Discovery call
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, "https://test.run402.com/mailboxes/v1");
    assert.equal(calls[0].opts.method, undefined); // GET (default)
    const discoverHeaders = calls[0].opts.headers as Record<string, string>;
    assert.equal(discoverHeaders.Authorization, "Bearer sk_test");

    // Send call
    assert.equal(calls[1].url, "https://test.run402.com/mailboxes/v1/mbx_test/messages");
    assert.equal(calls[1].opts.method, "POST");
    const sendHeaders = calls[1].opts.headers as Record<string, string>;
    assert.equal(sendHeaders.Authorization, "Bearer sk_test");
    assert.equal(sendHeaders["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(calls[1].opts.body as string), {
      to: "user@example.com",
      subject: "Hi",
      html: "<p>Hello</p>",
    });
    assert.deepEqual(result, { id: "msg_001" });
  });
});

describe("email.send — subsequent calls use cached mailboxId (no re-discover)", () => {
  it("posts raw HTML email with optional text and from_name", async () => {
    const calls: Array<{ url: string; opts: RequestInit }> = [];
    mock.method(globalThis, "fetch", async (url: string, opts: RequestInit) => {
      calls.push({ url, opts });
      return new Response(
        JSON.stringify({ id: "msg_002" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    await email.send({
      to: "user@example.com",
      subject: "Welcome",
      html: "<p>Welcome!</p>",
      text: "Welcome!",
      from_name: "MyApp",
    });

    assert.equal(calls.length, 1, "no re-discovery on cached mailbox");
    assert.equal(calls[0].url, "https://test.run402.com/mailboxes/v1/mbx_test/messages");
    assert.deepEqual(JSON.parse(calls[0].opts.body as string), {
      to: "user@example.com",
      subject: "Welcome",
      html: "<p>Welcome!</p>",
      text: "Welcome!",
      from_name: "MyApp",
    });
  });

  it("posts template email with variables to /mailboxes/v1/:id/messages", async () => {
    let capturedUrl = "";
    let capturedOpts: RequestInit = {};
    mock.method(globalThis, "fetch", async (url: string, opts: RequestInit) => {
      capturedUrl = url;
      capturedOpts = opts;
      return new Response(
        JSON.stringify({ id: "msg_003" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const result = await email.send({
      to: "alice@example.com",
      template: "welcome",
      variables: { name: "Alice" },
      from_name: "MyApp",
    });

    assert.equal(capturedUrl, "https://test.run402.com/mailboxes/v1/mbx_test/messages");
    assert.deepEqual(JSON.parse(capturedOpts.body as string), {
      to: "alice@example.com",
      template: "welcome",
      variables: { name: "Alice" },
      from_name: "MyApp",
    });
    assert.deepEqual(result, { id: "msg_003" });
  });

  it("omits optional fields not provided", async () => {
    let capturedBody = "";
    mock.method(globalThis, "fetch", async (_url: string, opts: RequestInit) => {
      capturedBody = opts.body as string;
      return new Response(JSON.stringify({ id: "msg_004" }), { status: 200 });
    });

    await email.send({ to: "user@example.com", template: "reset" });

    const body = JSON.parse(capturedBody);
    assert.equal(body.from_name, undefined);
    assert.deepEqual(body.variables, {});
  });

  it("throws on send failure", async () => {
    mock.method(globalThis, "fetch", async () =>
      new Response(JSON.stringify({ error: "over quota" }), { status: 429 }),
    );

    await assert.rejects(
      async () => {
        await email.send({ to: "user@example.com", subject: "x", html: "<p>x</p>" });
      },
      (err: unknown) => {
        assert.ok(err instanceof Run402EmailPlatformError);
        assert.equal(err.status, 429);
        assert.match(err.message, /Email send failed \(429\): over quota/);
        return true;
      },
    );
  });

  it("keeps the gateway error envelope's code, details and next_actions on a send failure", async () => {
    const envelope = {
      code: "QUOTA_EXCEEDED",
      message: "Daily email quota exhausted for this organization",
      details: { resource: "emails_per_day", scope: "organization", used: 100, limit: 100 },
      next_actions: [{ type: "renew_tier", method: "POST", path: "/tiers/v1/hobby" }],
    };
    mock.method(globalThis, "fetch", async () =>
      new Response(JSON.stringify(envelope), { status: 403, headers: { "Content-Type": "application/json" } }),
    );

    await assert.rejects(
      () => email.send({ to: "user@example.com", subject: "x", html: "<p>x</p>" }),
      (err: unknown) => {
        assert.ok(err instanceof Run402EmailPlatformError);
        assert.ok(err instanceof Error);
        assert.equal(err.name, "Run402EmailPlatformError");
        assert.equal(err.status, 403);
        assert.equal(err.code, "QUOTA_EXCEEDED");
        assert.deepEqual(err.details, envelope.details);
        assert.deepEqual(err.next_actions, envelope.next_actions);
        assert.deepEqual(err.body, envelope);
        assert.equal(err.message, "Email send failed (403): Daily email quota exhausted for this organization");
        return true;
      },
    );
  });

  it("reads a snake_case error code from a Core-style { error, message } envelope", async () => {
    mock.method(globalThis, "fetch", async () =>
      new Response(
        JSON.stringify({ error: "provider_not_configured", message: "Core outbound email provider is not configured" }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      ),
    );

    await assert.rejects(
      () => email.send({ to: "user@example.com", subject: "x", html: "<p>x</p>" }),
      (err: unknown) => {
        assert.ok(err instanceof Run402EmailPlatformError);
        assert.equal(err.status, 503);
        assert.equal(err.code, "provider_not_configured");
        assert.equal(err.details, undefined);
        assert.equal(err.next_actions, undefined);
        assert.match(err.message, /Email send failed \(503\): Core outbound email provider is not configured/);
        return true;
      },
    );
  });

  it("a non-JSON error body still produces a typed error with the raw text as message", async () => {
    mock.method(globalThis, "fetch", async () =>
      new Response("upstream 502 Bad Gateway", { status: 502 }),
    );

    await assert.rejects(
      () => email.send({ to: "user@example.com", subject: "x", html: "<p>x</p>" }),
      (err: unknown) => {
        assert.ok(err instanceof Run402EmailPlatformError);
        assert.equal(err.status, 502);
        assert.equal(err.code, "email_platform_error");
        assert.equal(err.message, "Email send failed (502): upstream 502 Bad Gateway");
        return true;
      },
    );
  });
});
