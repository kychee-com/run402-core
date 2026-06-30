import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";

import {
  ApplyInvariantError,
  createStorageReadSignature,
  emptyCoreReleaseState,
  verifyStorageReadSignature,
  verifyContentRefBytes,
  CORE_ASTRO_SSR_OUTPUT_CONTRACT_VERSION,
  CORE_FUNCTION_DEPENDENCY_MODE,
  CORE_FUNCTION_RESOURCE_DEFAULTS,
  LocalExecutorError,
  runtimeCapabilities,
  type CoreFunctionBundleMetadata,
  type CoreFunctionInvocationRecord,
  type CoreFunctionLogEntry,
  type CoreProject,
  type CoreStorageObject,
  type CoreUploadSession,
  type FunctionLogPort,
  type ProjectCatalogPort,
  type RuntimeKernelPorts,
  type SignedReadPort,
  type StoredCoreApplyPlan,
  type StorageObjectVisibility,
  type StoragePort,
} from "@run402/runtime-kernel";
import { STATIC_MANIFEST_VERSION, type PortableReleaseState } from "@run402/release";
import { MockEmailInboundProvider } from "./email-inbound.js";
import { DisabledEmailProvider, EmailProviderError, MockEmailProvider, type EmailProviderPort } from "./email-provider.js";
import type {
  LocalFunctionExecutorInput,
  LocalFunctionExecutorResult,
} from "./local-function-executor.js";
import { CoreMailboxError } from "./postgres-mailboxes.js";
import type {
  CoreEmailMessageRecord,
  CoreMailboxRecord,
  CoreMailboxSettings,
  CoreMailboxWebhookRecord,
  CoreWebhookDeliveryRecord,
  CoreMailboxStorePort,
  CoreEmailSuppressionRecord,
  EnqueueWebhookDeliveryInput,
  ApplyDeliveryEventInput,
  ApplyDeliveryEventResult,
  StageMessageInput,
  StoreInboundMessageInput,
} from "./postgres-mailboxes.js";
import { coreGatewayResponse, loadConfig } from "./server.js";
import { DEFAULT_WEBHOOK_DELIVERY_CONFIG, drainWebhookDeliveries } from "./webhook-delivery.js";

test("loadConfig does not require Cloud environment variables", () => {
  assert.deepEqual(loadConfig({}), {
    host: "127.0.0.1",
    port: 4020,
    databaseUrl: undefined,
    publicBaseUrl: "http://127.0.0.1:4020",
    functionApiBaseUrl: "http://127.0.0.1:4020",
    postgrestUrl: "http://127.0.0.1:4300",
    postgrestPublicUrl: "http://127.0.0.1:4300",
    rootProjectId: undefined,
    contentDir: ".run402-core/content",
    jwtSecret: "run402-core-local-jwt-secret-change-me",
    signedReadSecret: "run402-core-local-signed-read-secret-change-me",
    maxObjectBytes: 104857600,
    functionWorkerUrl: undefined,
    emailProvider: { provider: "disabled", fromDomain: undefined, sesRegion: undefined, sesEndpoint: undefined, sesConfigurationSet: undefined },
    emailInboundProvider: {
      provider: "disabled",
      inboundDomains: [],
      ingestToken: undefined,
      sesRegion: undefined,
      sesEndpoint: undefined,
      rawBucket: undefined,
      rawPrefix: undefined,
      maxRawBytes: 10 * 1024 * 1024,
    },
    emailDeliveryEvents: { provider: "disabled", ingestToken: undefined },
    emailSendRateLimit: { enabled: true, maxPerWindow: 60, windowMs: 60_000 },
    webhookDelivery: DEFAULT_WEBHOOK_DELIVERY_CONFIG,
  });
});

test("health route returns core mode", async () => {
  const response = await coreGatewayResponse("/health");
  assert.equal(response.status, 200);
  assert.equal((response.body as { mode?: string }).mode, "core");
});

test("capability route returns supported and unsupported feature lists", async () => {
  const response = await coreGatewayResponse("/capabilities/v1");
  const body = response.body as {
    supported_features?: string[];
    unsupported_features?: Array<{ feature: string; error: string }>;
  };

  assert.equal(response.status, 200);
  assert.ok(body.supported_features?.includes("projects.create.local"));
  assert.ok(body.supported_features?.includes("functions.node"));
  assert.equal(body.unsupported_features?.some((entry) => entry.feature === "functions.node"), false);
});

test("function runtime route fails closed while worker is unavailable", async () => {
  const response = await coreGatewayResponse("/functions/v1/invoke");
  assert.equal(response.status, 503);
  assert.equal((response.body as { error?: string }).error, "dynamic_runtime_unavailable");
});

test("project create and inspect routes use the configured catalog", async () => {
  const catalog = new MemoryProjectCatalog();
  const create = await coreGatewayResponse({
    method: "POST",
    pathname: "/projects/v1",
    body: { name: "agent app" },
  }, { projects: catalog });
  const created = create.body as CoreProject;

  assert.equal(create.status, 201);
  assert.equal(catalog.createdNames[0], "agent app");
  assert.equal(created.project_id, "prj_0000000000000001");

  const inspect = await coreGatewayResponse({
    method: "GET",
    pathname: `/projects/v1/${created.project_id}`,
  }, { projects: catalog });

  assert.equal(inspect.status, 200);
  assert.deepEqual(inspect.body, created);
});

test("project inspect maps invalid and missing ids", async () => {
  const catalog = new MemoryProjectCatalog();

  const invalid = await coreGatewayResponse({
    method: "GET",
    pathname: "/projects/v1/not-a-project",
  }, { projects: catalog });
  assert.equal(invalid.status, 400);
  assert.equal((invalid.body as { error?: string }).error, "invalid_project_id");

  const missing = await coreGatewayResponse({
    method: "GET",
    pathname: "/projects/v1/prj_0000000000000001",
  }, { projects: catalog });
  assert.equal(missing.status, 404);
  assert.equal((missing.body as { error?: string }).error, "project_not_found");
});

test("mailbox routes create a default mailbox and send raw email through the configured provider", async () => {
  const catalog = new MemoryProjectCatalog();
  const project = await catalog.create({ name: "email app" });
  const mailboxes = new MemoryMailboxStore();
  const emailProvider = new MockEmailProvider("example.com");
  const runtime = { projects: catalog, projectKeys: catalog, mailboxes, emailProvider };

  const created = await coreGatewayResponse({
    method: "POST",
    pathname: "/mailboxes/v1",
    headers: { authorization: `Bearer ${project.service_key}` },
    body: { slug: "signing" },
  }, runtime);

  assert.equal(created.status, 201);
  assert.equal((created.body as { address?: string }).address, "signing@example.com");
  assert.equal((created.body as { can_send?: boolean }).can_send, true);
  assert.equal((created.body as { is_default_outbound?: boolean }).is_default_outbound, true);

  const sent = await coreGatewayResponse({
    method: "POST",
    pathname: `/mailboxes/v1/${(created.body as { mailbox_id: string }).mailbox_id}/messages`,
    headers: { authorization: `Bearer ${project.service_key}` },
    body: {
      to: "signer@example.net",
      subject: "Signature requested",
      html: "<p>Please sign.</p>",
      attachments: [{
        filename: "../contract.pdf",
        content_type: "application/pdf",
        content_base64: Buffer.from("%PDF-1.7\n").toString("base64"),
      }],
    },
  }, runtime);

  assert.equal(sent.status, 201);
  assert.equal((sent.body as { delivery_state?: string }).delivery_state, "accepted");
  assert.equal((sent.body as { provider?: string }).provider, "mock");
  assert.deepEqual((sent.body as { attachments_meta?: unknown }).attachments_meta, [{
    filename: "contract.pdf",
    content_type: "application/pdf",
    size_bytes: 9,
  }]);
  assert.equal(emailProvider.sent.length, 1);
  assert.ok(emailProvider.sent[0]?.rawMime);

  const listed = await coreGatewayResponse({
    method: "GET",
    pathname: `/mailboxes/v1/${(created.body as { mailbox_id: string }).mailbox_id}/messages`,
    headers: { authorization: `Bearer ${project.service_key}` },
  }, runtime);
  assert.equal(listed.status, 200);
  assert.equal((listed.body as { messages: unknown[] }).messages.length, 1);
  assert.equal(JSON.stringify(listed.body).includes("%PDF-1.7"), false);
});

test("mailbox routes report provider-not-configured without staging sends", async () => {
  const catalog = new MemoryProjectCatalog();
  const project = await catalog.create({ name: "email app" });
  const mailboxes = new MemoryMailboxStore();
  const runtime = {
    projects: catalog,
    projectKeys: catalog,
    mailboxes,
    emailProvider: new DisabledEmailProvider("not configured for test"),
  };

  const created = await coreGatewayResponse({
    method: "POST",
    pathname: "/mailboxes/v1",
    headers: { authorization: `Bearer ${project.service_key}` },
    body: { slug: "notify" },
  }, runtime);

  assert.equal(created.status, 201);
  assert.equal((created.body as { can_send?: boolean }).can_send, false);
  assert.equal((created.body as { send_blocked_reason?: string }).send_blocked_reason, "provider_not_configured");

  const sent = await coreGatewayResponse({
    method: "POST",
    pathname: `/mailboxes/v1/${(created.body as { mailbox_id: string }).mailbox_id}/messages`,
    headers: { authorization: `Bearer ${project.service_key}` },
    body: { to: "a@example.com", subject: "Hi", html: "<p>Hi</p>" },
  }, runtime);

  assert.equal(sent.status, 503);
  assert.equal((sent.body as { error?: string }).error, "provider_not_configured");
  assert.equal(mailboxes.messages.size, 0);
});

test("Core delivery event ingestion marks bounces, suppresses recipients, and enqueues durable webhooks", async () => {
  const catalog = new MemoryProjectCatalog();
  const project = await catalog.create({ name: "delivery ops app" });
  const mailboxes = new MemoryMailboxStore();
  const sentByProvider: unknown[] = [];
  const emailProvider: EmailProviderPort = {
    readiness: () => ({ status: "configured", provider: "ses", from_domain: "example.com" }),
    sendRaw: async (input) => {
      sentByProvider.push(input);
      return { provider: "ses", providerMessageId: "ses_msg_1", deliveryState: "accepted" };
    },
  };
  const runtime = {
    projects: catalog,
    projectKeys: catalog,
    mailboxes,
    emailProvider,
    emailDeliveryEvents: { provider: "ses", ingestToken: "events-secret" },
  };

  const created = await coreGatewayResponse({
    method: "POST",
    pathname: "/mailboxes/v1",
    headers: { authorization: `Bearer ${project.service_key}` },
    body: { slug: "signing" },
  }, runtime);
  assert.equal(created.status, 201);
  const mailboxId = (created.body as { mailbox_id: string }).mailbox_id;

  const webhook = await coreGatewayResponse({
    method: "POST",
    pathname: `/mailboxes/v1/${mailboxId}/webhooks`,
    headers: { authorization: `Bearer ${project.service_key}` },
    body: { url: "https://example.net/run402-email-webhook", events: ["bounced", "delivery", "complained"] },
  }, runtime);
  assert.equal(webhook.status, 201);
  assert.deepEqual((webhook.body as { events: string[] }).events, ["bounced", "delivery", "complained"]);

  const sent = await coreGatewayResponse({
    method: "POST",
    pathname: `/mailboxes/v1/${mailboxId}/messages`,
    headers: { authorization: `Bearer ${project.service_key}` },
    body: { to: "bad@example.net", subject: "Signature requested", html: "<p>Please sign.</p>" },
  }, runtime);
  assert.equal(sent.status, 201);
  assert.equal((sent.body as { provider_message_id?: string }).provider_message_id, "ses_msg_1");

  const unauthenticated = await coreGatewayResponse({
    method: "POST",
    pathname: "/mailboxes/v1/events/ingestions",
    body: { eventType: "Bounce", mail: { messageId: "ses_msg_1" } },
  }, runtime);
  assert.equal(unauthenticated.status, 401);

  const bounced = await coreGatewayResponse({
    method: "POST",
    pathname: "/mailboxes/v1/events/ingestions",
    headers: { authorization: "Bearer events-secret" },
    body: {
      eventType: "Bounce",
      mail: { messageId: "ses_msg_1", destination: ["bad@example.net"] },
      bounce: {
        bounceType: "Permanent",
        timestamp: "2026-06-30T10:00:00.000Z",
        bouncedRecipients: [{ emailAddress: "bad@example.net" }],
      },
    },
  }, runtime);
  assert.equal(bounced.status, 202);
  const body = bounced.body as { accepted_count: number; results: Array<{ matched: boolean; suppression?: { scope: string; reason: string }; webhook_deliveries?: unknown[] }> };
  assert.equal(body.accepted_count, 1);
  assert.equal(body.results[0]?.matched, true);
  assert.equal(body.results[0]?.suppression?.scope, "project");
  assert.equal(body.results[0]?.suppression?.reason, "bounce");
  assert.equal(body.results[0]?.webhook_deliveries?.length, 1);

  const listed = await coreGatewayResponse({
    method: "GET",
    pathname: `/mailboxes/v1/${mailboxId}/messages/${(sent.body as { message_id: string }).message_id}`,
    headers: { authorization: `Bearer ${project.service_key}` },
  }, runtime);
  assert.equal(listed.status, 200);
  assert.equal((listed.body as { status?: string; delivery_state?: string }).status, "bounced");
  assert.equal((listed.body as { status?: string; delivery_state?: string }).delivery_state, "bounced");

  const deliveries = await coreGatewayResponse({
    method: "GET",
    pathname: `/mailboxes/v1/${mailboxId}/webhooks/deliveries`,
    headers: { authorization: `Bearer ${project.service_key}` },
  }, runtime);
  assert.equal(deliveries.status, 200);
  const rows = (deliveries.body as { deliveries: Array<{ event_type: string; source: string; payload: { type: string; idempotency_key: string; payload: { message_id: string; bounce_type: string } } }> }).deliveries;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event_type, "bounced");
  assert.equal(rows[0].source, "core-email-events");
  assert.equal(rows[0].payload.type, "bounced");
  assert.equal(rows[0].payload.payload.message_id, (sent.body as { message_id: string }).message_id);
  assert.equal(rows[0].payload.payload.bounce_type, "Permanent");
  const idempotencyKey = rows[0].payload.idempotency_key;

  const duplicate = await coreGatewayResponse({
    method: "POST",
    pathname: "/mailboxes/v1/events/ingestions",
    headers: { authorization: "Bearer events-secret" },
    body: {
      eventType: "Bounce",
      mail: { messageId: "ses_msg_1", destination: ["bad@example.net"] },
      bounce: { bounceType: "Permanent", bouncedRecipients: [{ emailAddress: "bad@example.net" }] },
    },
  }, runtime);
  assert.equal(duplicate.status, 202);
  assert.equal(mailboxes.suppressions.size, 1);
  assert.equal(mailboxes.deliveries.size, 1);
  assert.equal(([...mailboxes.deliveries.values()][0]?.payload as { idempotency_key: string }).idempotency_key, idempotencyKey);

  const suppressed = await coreGatewayResponse({
    method: "POST",
    pathname: `/mailboxes/v1/${mailboxId}/messages`,
    headers: { authorization: `Bearer ${project.service_key}` },
    body: { to: "bad@example.net", subject: "retry", html: "<p>Nope</p>" },
  }, runtime);
  assert.equal(suppressed.status, 403);
  assert.equal((suppressed.body as { error?: string; suppression_scope?: string }).error, "recipient_suppressed");
  assert.equal((suppressed.body as { error?: string; suppression_scope?: string }).suppression_scope, "project");
  assert.equal(sentByProvider.length, 1);
});

test("Core delivery event ingestion safely reports ignored and unmatched SES events", async () => {
  const mailboxes = new MemoryMailboxStore();
  const runtime = {
    mailboxes,
    emailDeliveryEvents: { provider: "ses", ingestToken: "events-secret" },
  };

  const response = await coreGatewayResponse({
    method: "POST",
    pathname: "/mailboxes/v1/events/ingestions",
    headers: { "x-run402-core-email-events-token": "events-secret" },
    body: {
      Records: [
        { Sns: { Message: JSON.stringify({ eventType: "Delivery", mail: { messageId: "missing" }, delivery: { recipients: ["a@example.com"] } }) } },
        { Sns: { Message: JSON.stringify({ eventType: "Open", mail: { messageId: "ignored" } }) } },
        { Sns: { Message: "{not-json" } },
      ],
    },
  }, runtime);

  assert.equal(response.status, 202);
  const body = response.body as { accepted_count: number; ignored_count: number; results: Array<{ matched: boolean; provider_message_id: string }>; ignored: Array<{ reason: string }> };
  assert.equal(body.accepted_count, 1);
  assert.equal(body.ignored_count, 2);
  assert.equal(body.results[0]?.matched, false);
  assert.equal(body.results[0]?.provider_message_id, "missing");
  assert.equal(body.ignored[0]?.reason, "event_type_unsupported");
});

test("Core send rate limit rejects before provider calls or staging", async () => {
  const catalog = new MemoryProjectCatalog();
  const project = await catalog.create({ name: "rate limited app" });
  const mailboxes = new MemoryMailboxStore();
  const emailProvider = new MockEmailProvider("example.com");
  const runtime = {
    projects: catalog,
    projectKeys: catalog,
    mailboxes,
    emailProvider,
    emailSendRateLimit: { enabled: true, maxPerWindow: 1, windowMs: 60_000 },
  };

  const created = await coreGatewayResponse({
    method: "POST",
    pathname: "/mailboxes/v1",
    headers: { authorization: `Bearer ${project.service_key}` },
    body: { slug: "notify" },
  }, runtime);
  const mailboxId = (created.body as { mailbox_id: string }).mailbox_id;

  const first = await coreGatewayResponse({
    method: "POST",
    pathname: `/mailboxes/v1/${mailboxId}/messages`,
    headers: { authorization: `Bearer ${project.service_key}` },
    body: { to: "a@example.com", subject: "one", html: "<p>one</p>" },
  }, runtime);
  assert.equal(first.status, 201);

  const second = await coreGatewayResponse({
    method: "POST",
    pathname: `/mailboxes/v1/${mailboxId}/messages`,
    headers: { authorization: `Bearer ${project.service_key}` },
    body: { to: "b@example.com", subject: "two", html: "<p>two</p>" },
  }, runtime);
  assert.equal(second.status, 429);
  assert.equal(second.headers?.["Retry-After"], "60");
  assert.equal((second.body as { error?: string }).error, "mailbox_send_rate_limited");
  assert.equal(emailProvider.sent.length, 1);
  assert.equal(mailboxes.messages.size, 1);
});

test("mailbox routes surface actionable SES IAM next actions on provider access denial", async () => {
  const catalog = new MemoryProjectCatalog();
  const project = await catalog.create({ name: "email app" });
  const mailboxes = new MemoryMailboxStore();
  const emailProvider: EmailProviderPort = {
    readiness: () => ({ status: "configured", provider: "ses", from_domain: "kysigned.com" }),
    sendRaw: async () => {
      throw new EmailProviderError("not authorized to perform ses:SendRawEmail", "provider_access_denied", 502);
    },
  };
  const runtime = { projects: catalog, projectKeys: catalog, mailboxes, emailProvider };

  const created = await coreGatewayResponse({
    method: "POST",
    pathname: "/mailboxes/v1",
    headers: { authorization: `Bearer ${project.service_key}` },
    body: { slug: "notify" },
  }, runtime);

  assert.equal(created.status, 201);

  const sent = await coreGatewayResponse({
    method: "POST",
    pathname: `/mailboxes/v1/${(created.body as { mailbox_id: string }).mailbox_id}/messages`,
    headers: { authorization: `Bearer ${project.service_key}` },
    body: { to: "a@example.com", subject: "Hi", html: "<p>Hi</p>" },
  }, runtime);

  assert.equal(sent.status, 502);
  assert.equal((sent.body as { error?: string }).error, "provider_access_denied");
  const nextActions = (sent.body as { next_actions?: Array<{ fields?: { iam_actions?: string[] } }> }).next_actions ?? [];
  assert.ok(nextActions.some((action) => action.fields?.iam_actions?.includes("ses:SendEmail")));
  assert.ok(nextActions.some((action) => action.fields?.iam_actions?.includes("ses:SendRawEmail")));
});

test("mailbox routes return 403 before revealing another project's mailbox", async () => {
  const catalog = new MemoryProjectCatalog();
  const projectA = await catalog.create({ name: "project a" });
  const projectB = makeProject("prj_0000000000000002", "anon_b", "service_b");
  catalog.projects.set(projectB.project_id, projectB);
  const mailboxes = new MemoryMailboxStore();
  const runtime = {
    projects: catalog,
    projectKeys: catalog,
    mailboxes,
    emailProvider: new MockEmailProvider("example.com"),
  };

  const created = await coreGatewayResponse({
    method: "POST",
    pathname: "/mailboxes/v1",
    headers: { authorization: `Bearer ${projectA.service_key}` },
    body: { slug: "alpha" },
  }, runtime);

  const read = await coreGatewayResponse({
    method: "GET",
    pathname: `/mailboxes/v1/${(created.body as { mailbox_id: string }).mailbox_id}`,
    headers: { authorization: `Bearer ${projectB.service_key}` },
  }, runtime);

  assert.equal(read.status, 403);
  assert.equal(JSON.stringify(read.body).includes("alpha@example.com"), false);
});

test("mailbox responses diagnose receive readiness separately from send readiness", async () => {
  const catalog = new MemoryProjectCatalog();
  const project = await catalog.create({ name: "inbound app" });
  const mailboxes = new MemoryMailboxStore();
  const runtime = {
    projects: catalog,
    projectKeys: catalog,
    mailboxes,
    emailProvider: new DisabledEmailProvider("outbound disabled for test"),
    emailInboundProvider: new MockEmailInboundProvider({
      provider: "mock",
      inboundDomains: ["example.com"],
      ingestToken: "inbound-secret",
      maxRawBytes: 1024 * 1024,
    }),
  };

  const created = await coreGatewayResponse({
    method: "POST",
    pathname: "/mailboxes/v1",
    headers: { authorization: `Bearer ${project.service_key}` },
    body: { slug: "signing" },
  }, runtime);

  assert.equal(created.status, 201);
  assert.equal((created.body as { address?: string }).address, "signing@example.com");
  assert.equal((created.body as { can_send?: boolean }).can_send, false);
  assert.equal((created.body as { send_blocked_reason?: string }).send_blocked_reason, "provider_not_configured");
  assert.equal((created.body as { can_receive?: boolean }).can_receive, true);
  assert.equal((created.body as { receive_blocked_reason?: string | null }).receive_blocked_reason, null);
});

test("Core inbound ingestion stores reply messages, raw MIME, and reply_received webhook deliveries", async () => {
  const catalog = new MemoryProjectCatalog();
  const project = await catalog.create({ name: "reply app" });
  const projectB = makeProject("prj_0000000000000002", "anon_b", "service_b");
  catalog.projects.set(projectB.project_id, projectB);
  const mailboxes = new MemoryMailboxStore();
  const runtime = {
    projects: catalog,
    projectKeys: catalog,
    mailboxes,
    emailProvider: new MockEmailProvider("example.com"),
    emailInboundProvider: new MockEmailInboundProvider({
      provider: "mock",
      inboundDomains: ["example.com"],
      ingestToken: "inbound-secret",
      maxRawBytes: 1024 * 1024,
    }),
  };

  const created = await coreGatewayResponse({
    method: "POST",
    pathname: "/mailboxes/v1",
    headers: { authorization: `Bearer ${project.service_key}` },
    body: { slug: "signing" },
  }, runtime);
  const mailboxId = (created.body as { mailbox_id: string }).mailbox_id;

  const outbound = await coreGatewayResponse({
    method: "POST",
    pathname: `/mailboxes/v1/${mailboxId}/messages`,
    headers: { authorization: `Bearer ${project.service_key}` },
    body: {
      to: "signer@example.net",
      subject: "Signature requested",
      html: "<p>Please sign.</p>",
    },
  }, runtime);
  assert.equal(outbound.status, 201);
  assert.equal((outbound.body as { provider_message_id?: string }).provider_message_id, "mock_1");

  const webhook = await coreGatewayResponse({
    method: "POST",
    pathname: `/mailboxes/v1/${mailboxId}/webhooks`,
    headers: { authorization: `Bearer ${project.service_key}` },
    body: { url: "https://example.net/run402-email-webhook", events: ["reply_received"] },
  }, runtime);
  assert.equal(webhook.status, 201);

  const rejected = await coreGatewayResponse({
    method: "POST",
    pathname: "/mailboxes/v1/inbound/ingestions",
    body: { provider: "mock", ses_message_id: "ses_in_1", recipients: ["signing@example.com"], raw_mime: "Subject: no auth\r\n\r\nnope" },
  }, runtime);
  assert.equal(rejected.status, 401);

  const rawMime = [
    "From: Signer <signer@example.net>",
    "To: signing@example.com",
    "Subject: Re: Signature requested",
    "In-Reply-To: <mock_1>",
    "References: <mock_1>",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "I approve this signature.",
    "> quoted text",
  ].join("\r\n");

  const ingested = await coreGatewayResponse({
    method: "POST",
    pathname: "/mailboxes/v1/inbound/ingestions",
    headers: { authorization: "Bearer inbound-secret" },
    body: {
      provider: "mock",
      ses_message_id: "ses_in_1",
      recipients: ["signing@example.com", "missing@example.com"],
      source: "signer@example.net",
      common_headers: { from: ["Signer <signer@example.net>"] },
      raw_mime: rawMime,
    },
  }, runtime);
  assert.equal(ingested.status, 202);
  assert.equal((ingested.body as { accepted_count?: number }).accepted_count, 1);
  assert.equal((ingested.body as { dropped_count?: number }).dropped_count, 1);

  const duplicate = await coreGatewayResponse({
    method: "POST",
    pathname: "/mailboxes/v1/inbound/ingestions",
    headers: { authorization: "Bearer inbound-secret" },
    body: {
      provider: "mock",
      ses_message_id: "ses_in_1",
      recipients: ["signing@example.com"],
      source: "signer@example.net",
      common_headers: { from: ["Signer <signer@example.net>"] },
      raw_mime: rawMime,
    },
  }, runtime);
  assert.equal(duplicate.status, 202);
  assert.equal((duplicate.body as { accepted_count?: number }).accepted_count, 0);

  const listed = await coreGatewayResponse({
    method: "GET",
    pathname: `/mailboxes/v1/${mailboxId}/messages`,
    headers: { authorization: `Bearer ${project.service_key}` },
  }, runtime);
  assert.equal(listed.status, 200);
  assert.equal((listed.body as { messages: unknown[] }).messages.length, 2);

  const inboundList = await coreGatewayResponse({
    method: "GET",
    pathname: `/mailboxes/v1/${mailboxId}/messages?direction=inbound`,
    headers: { authorization: `Bearer ${project.service_key}` },
  }, runtime);
  assert.equal(inboundList.status, 200);
  const inboundMessages = (inboundList.body as { messages: Array<{ message_id: string; direction: string; body_text: string; in_reply_to_message_id: string | null }> }).messages;
  assert.equal(inboundMessages.length, 1);
  assert.equal(inboundMessages[0].direction, "inbound");
  assert.equal(inboundMessages[0].body_text, "I approve this signature.");
  assert.equal(inboundMessages[0].in_reply_to_message_id, (outbound.body as { message_id: string }).message_id);

  const invalidDirection = await coreGatewayResponse({
    method: "GET",
    pathname: `/mailboxes/v1/${mailboxId}/messages?direction=sideways`,
    headers: { authorization: `Bearer ${project.service_key}` },
  }, runtime);
  assert.equal(invalidDirection.status, 400);

  const raw = await coreGatewayResponse({
    method: "GET",
    pathname: `/mailboxes/v1/${mailboxId}/messages/${inboundMessages[0].message_id}/raw`,
    headers: { authorization: `Bearer ${project.service_key}` },
  }, runtime);
  assert.equal(raw.status, 200);
  assert.equal(Buffer.from(raw.body as Uint8Array).toString("utf8"), rawMime);
  assert.equal(raw.headers?.["Content-Type"], "message/rfc822");

  const outboundRaw = await coreGatewayResponse({
    method: "GET",
    pathname: `/mailboxes/v1/${mailboxId}/messages/${(outbound.body as { message_id: string }).message_id}/raw`,
    headers: { authorization: `Bearer ${project.service_key}` },
  }, runtime);
  assert.equal(outboundRaw.status, 404);
  assert.equal((outboundRaw.body as { error?: string }).error, "raw_message_not_found");

  const forbiddenRaw = await coreGatewayResponse({
    method: "GET",
    pathname: `/mailboxes/v1/${mailboxId}/messages/${inboundMessages[0].message_id}/raw`,
    headers: { authorization: `Bearer ${projectB.service_key}` },
  }, runtime);
  assert.equal(forbiddenRaw.status, 403);

  const deliveries = await coreGatewayResponse({
    method: "GET",
    pathname: `/mailboxes/v1/${mailboxId}/webhooks/deliveries?status=pending`,
    headers: { authorization: `Bearer ${project.service_key}` },
  }, runtime);
  assert.equal(deliveries.status, 200);
  const rows = (deliveries.body as { deliveries: Array<{ event_type: string; status: string; payload: { idempotency_key: string; payload: { message_id: string } } }> }).deliveries;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event_type, "reply_received");
  assert.equal(rows[0].status, "pending");
  assert.equal(rows[0].payload.payload.message_id, inboundMessages[0].message_id);
  assert.match(rows[0].payload.idempotency_key, /^wh_/);
});

test("Core webhook delivery drain posts pending reply_received deliveries with stable identity", async () => {
  const fixture = await createInboundReplyFixture("http://localhost/run402-email-webhook");
  const calls: Array<{ url: string; headers: Headers; body: unknown }> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push({
      url: String(url),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    });
    return new Response("ok", { status: 200 });
  };

  const drained = await drainWebhookDeliveries({
    store: fixture.mailboxes,
    fetch: fetchImpl,
    now: new Date(1_000),
    config: { batchSize: 10, leaseMs: 60_000, timeoutMs: 1_000 },
  });

  assert.equal(drained.claimed, 1);
  assert.equal(drained.results[0]?.status, "delivered");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://localhost/run402-email-webhook");
  assert.equal(calls[0].headers.get("X-Run402-Webhook-Attempt"), "1");
  assert.equal(calls[0].headers.get("X-Run402-Webhook-Event-Type"), "reply_received");
  const body = calls[0].body as { id: string; idempotency_key: string; payload: { message_id: string } };
  assert.equal(calls[0].headers.get("X-Run402-Webhook-Delivery-Id"), body.id);
  assert.equal(calls[0].headers.get("X-Run402-Webhook-Idempotency-Key"), body.idempotency_key);
  assert.equal(body.payload.message_id, fixture.inboundMessageId);

  const delivered = await coreGatewayResponse({
    method: "GET",
    pathname: `/mailboxes/v1/${fixture.mailboxId}/webhooks/deliveries?status=delivered`,
    headers: { authorization: `Bearer ${fixture.project.service_key}` },
  }, fixture.runtime);
  assert.equal(delivered.status, 200);
  const rows = (delivered.body as { deliveries: Array<{ status: string; attempts: number; last_status: number; delivered_at: string | null }> }).deliveries;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "delivered");
  assert.equal(rows[0].attempts, 1);
  assert.equal(rows[0].last_status, 200);
  assert.ok(rows[0].delivered_at);
});

test("Core webhook delivery drain retries, fails permanently, redrives, and preserves raw readback", async () => {
  const fixture = await createInboundReplyFixture("http://localhost/run402-email-webhook");
  const fetchImpl: typeof fetch = async () => new Response("retry later", { status: 503 });

  const first = await drainWebhookDeliveries({
    store: fixture.mailboxes,
    fetch: fetchImpl,
    now: new Date(1_000),
    config: { batchSize: 10, leaseMs: 60_000, timeoutMs: 1_000, maxAttempts: 2, retryBaseMs: 1_000, retryMaxMs: 1_000 },
  });
  assert.equal(first.claimed, 1);
  assert.equal(first.results[0]?.status, "retrying");

  const early = await drainWebhookDeliveries({
    store: fixture.mailboxes,
    fetch: fetchImpl,
    now: new Date(1_500),
    config: { batchSize: 10, leaseMs: 60_000, timeoutMs: 1_000, maxAttempts: 2, retryBaseMs: 1_000, retryMaxMs: 1_000 },
  });
  assert.equal(early.claimed, 0);

  const second = await drainWebhookDeliveries({
    store: fixture.mailboxes,
    fetch: fetchImpl,
    now: new Date(3_000),
    config: { batchSize: 10, leaseMs: 60_000, timeoutMs: 1_000, maxAttempts: 2, retryBaseMs: 1_000, retryMaxMs: 1_000 },
  });
  assert.equal(second.claimed, 1);
  assert.equal(second.results[0]?.status, "failed_permanent");

  const failed = await coreGatewayResponse({
    method: "GET",
    pathname: `/mailboxes/v1/${fixture.mailboxId}/webhooks/deliveries?status=failed_permanent`,
    headers: { authorization: `Bearer ${fixture.project.service_key}` },
  }, fixture.runtime);
  assert.equal(failed.status, 200);
  const failedRows = (failed.body as { deliveries: Array<{ delivery_id: string; attempts: number; last_status: number; last_error: string }> }).deliveries;
  assert.equal(failedRows.length, 1);
  assert.equal(failedRows[0].attempts, 2);
  assert.equal(failedRows[0].last_status, 503);
  assert.equal(failedRows[0].last_error, "HTTP 503");

  const raw = await coreGatewayResponse({
    method: "GET",
    pathname: `/mailboxes/v1/${fixture.mailboxId}/messages/${fixture.inboundMessageId}/raw`,
    headers: { authorization: `Bearer ${fixture.project.service_key}` },
  }, fixture.runtime);
  assert.equal(raw.status, 200);
  assert.equal(Buffer.from(raw.body as Uint8Array).toString("utf8"), fixture.rawMime);

  const redrive = await coreGatewayResponse({
    method: "POST",
    pathname: `/mailboxes/v1/${fixture.mailboxId}/webhooks/deliveries/${failedRows[0].delivery_id}/redrive`,
    headers: { authorization: `Bearer ${fixture.project.service_key}` },
  }, fixture.runtime);
  assert.equal(redrive.status, 200);
  assert.equal((redrive.body as { status?: string; attempts?: number }).status, "pending");
  assert.equal((redrive.body as { status?: string; attempts?: number }).attempts, 0);
});

test("Core inbound ingestion validates provider payloads and drops unsolicited senders", async () => {
  const catalog = new MemoryProjectCatalog();
  const project = await catalog.create({ name: "unsolicited app" });
  const mailboxes = new MemoryMailboxStore();
  const runtime = {
    projects: catalog,
    projectKeys: catalog,
    mailboxes,
    emailProvider: new MockEmailProvider("example.com"),
    emailInboundProvider: new MockEmailInboundProvider({
      provider: "mock",
      inboundDomains: ["example.com"],
      ingestToken: "inbound-secret",
      maxRawBytes: 1024 * 1024,
    }),
  };

  const created = await coreGatewayResponse({
    method: "POST",
    pathname: "/mailboxes/v1",
    headers: { authorization: `Bearer ${project.service_key}` },
    body: { slug: "signing" },
  }, runtime);
  const mailboxId = (created.body as { mailbox_id: string }).mailbox_id;

  const wrongProvider = await coreGatewayResponse({
    method: "POST",
    pathname: "/mailboxes/v1/inbound/ingestions",
    headers: { authorization: "Bearer inbound-secret" },
    body: { provider: "ses", ses_message_id: "ses_wrong_provider", recipients: ["signing@example.com"], raw_mime: "Subject: nope\r\n\r\nnope" },
  }, runtime);
  assert.equal(wrongProvider.status, 400);
  assert.equal((wrongProvider.body as { error?: string }).error, "provider_mismatch");

  const missingMessageId = await coreGatewayResponse({
    method: "POST",
    pathname: "/mailboxes/v1/inbound/ingestions",
    headers: { authorization: "Bearer inbound-secret" },
    body: { provider: "mock", recipients: ["signing@example.com"], raw_mime: "Subject: nope\r\n\r\nnope" },
  }, runtime);
  assert.equal(missingMessageId.status, 400);
  assert.equal((missingMessageId.body as { error?: string }).error, "provider_message_id_required");

  const missingRaw = await coreGatewayResponse({
    method: "POST",
    pathname: "/mailboxes/v1/inbound/ingestions",
    headers: { authorization: "Bearer inbound-secret" },
    body: { provider: "mock", ses_message_id: "ses_missing_raw", recipients: ["signing@example.com"] },
  }, runtime);
  assert.equal(missingRaw.status, 400);
  assert.equal((missingRaw.body as { error?: string }).error, "raw_mime_required");

  const unsolicited = await coreGatewayResponse({
    method: "POST",
    pathname: "/mailboxes/v1/inbound/ingestions",
    headers: { authorization: "Bearer inbound-secret" },
    body: {
      provider: "mock",
      ses_message_id: "ses_unsolicited",
      recipients: ["signing@example.com"],
      source: "stranger@example.net",
      common_headers: { from: ["Stranger <stranger@example.net>"] },
      raw_mime: "From: Stranger <stranger@example.net>\r\nTo: signing@example.com\r\nSubject: hello\r\n\r\nfirst contact",
    },
  }, runtime);
  assert.equal(unsolicited.status, 202);
  assert.equal((unsolicited.body as { accepted_count?: number }).accepted_count, 0);
  assert.equal((unsolicited.body as { dropped_count?: number }).dropped_count, 1);

  const inboundList = await coreGatewayResponse({
    method: "GET",
    pathname: `/mailboxes/v1/${mailboxId}/messages?direction=inbound`,
    headers: { authorization: `Bearer ${project.service_key}` },
  }, runtime);
  assert.equal(inboundList.status, 200);
  assert.equal((inboundList.body as { messages: unknown[] }).messages.length, 0);
});

test("Core inbound ingestion handles multiple valid recipients with recency fallback and malformed MIME", async () => {
  const catalog = new MemoryProjectCatalog();
  const project = await catalog.create({ name: "multi recipient app" });
  const mailboxes = new MemoryMailboxStore();
  const runtime = {
    projects: catalog,
    projectKeys: catalog,
    mailboxes,
    emailProvider: new MockEmailProvider("example.com"),
    emailInboundProvider: new MockEmailInboundProvider({
      provider: "mock",
      inboundDomains: ["example.com"],
      ingestToken: "inbound-secret",
      maxRawBytes: 1024 * 1024,
    }),
  };

  const signing = await coreGatewayResponse({
    method: "POST",
    pathname: "/mailboxes/v1",
    headers: { authorization: `Bearer ${project.service_key}` },
    body: { slug: "signing" },
  }, runtime);
  const approvals = await coreGatewayResponse({
    method: "POST",
    pathname: "/mailboxes/v1",
    headers: { authorization: `Bearer ${project.service_key}` },
    body: { slug: "approvals" },
  }, runtime);
  const signingMailboxId = (signing.body as { mailbox_id: string }).mailbox_id;
  const approvalsMailboxId = (approvals.body as { mailbox_id: string }).mailbox_id;

  for (const mailboxId of [signingMailboxId, approvalsMailboxId]) {
    const outbound = await coreGatewayResponse({
      method: "POST",
      pathname: `/mailboxes/v1/${mailboxId}/messages`,
      headers: { authorization: `Bearer ${project.service_key}` },
      body: {
        to: "signer@example.net",
        subject: "Signature requested",
        html: "<p>Please sign.</p>",
      },
    }, runtime);
    assert.equal(outbound.status, 201);
  }

  const rawMime = [
    "From: Signer <signer@example.net>",
    "To: signing@example.com, approvals@example.com",
    "Subject: =?UTF-8?B?UmU6IFNpZ25hdHVyZSByZXF1ZXN0ZWQ=?=",
    "Content-Type: multipart/mixed",
    "",
    "Accepted through the recency fallback.",
  ].join("\r\n");

  const ingested = await coreGatewayResponse({
    method: "POST",
    pathname: "/mailboxes/v1/inbound/ingestions",
    headers: { authorization: "Bearer inbound-secret" },
    body: {
      provider: "mock",
      ses_message_id: "ses_multi_recipient",
      recipients: ["bad-address", "signing@example.com", "approvals@example.com", "outside@elsewhere.test"],
      source: "signer@example.net",
      common_headers: { from: ["Signer <signer@example.net>"] },
      raw_mime: rawMime,
    },
  }, runtime);
  assert.equal(ingested.status, 202);
  assert.equal((ingested.body as { accepted_count?: number }).accepted_count, 2);
  assert.equal((ingested.body as { dropped_count?: number }).dropped_count, 2);

  for (const mailboxId of [signingMailboxId, approvalsMailboxId]) {
    const inboundList = await coreGatewayResponse({
      method: "GET",
      pathname: `/mailboxes/v1/${mailboxId}/messages?direction=inbound`,
      headers: { authorization: `Bearer ${project.service_key}` },
    }, runtime);
    assert.equal(inboundList.status, 200);
    const messages = (inboundList.body as { messages: Array<{ subject: string; body_text: string; direction: string; in_reply_to_message_id: string | null }> }).messages;
    assert.equal(messages.length, 1);
    assert.equal(messages[0].direction, "inbound");
    assert.equal(messages[0].subject, "Re: Signature requested");
    assert.equal(messages[0].body_text, "Accepted through the recency fallback.");
    assert.ok(messages[0].in_reply_to_message_id);
  }
});

test("apply plan route accepts SDK project_id alias inside request spec", async () => {
  const runtime = new MemoryRuntimePorts();
  const projectId = "prj_0000000000000001";

  const response = await coreGatewayResponse({
    method: "POST",
    pathname: "/apply/v1/plans",
    body: {
      spec: {
        project_id: projectId,
        routes: { replace: [] },
      },
    },
  }, runtime);

  assert.equal(response.status, 201);
  assert.equal((response.body as { project_id?: string }).project_id, projectId);

  const stored = await runtime.plans.get("plan_1");
  assert.ok(stored);
  assert.equal((stored.spec as { project?: string }).project, projectId);
  assert.equal("project_id" in (stored.spec as Record<string, unknown>), false);
});

test("dev token route is deterministic for stable fixture inputs", async () => {
  const body = {
    project_id: "prj_0000000000000001",
    role: "authenticated",
    sub: "user_a",
  };
  const first = await coreGatewayResponse({
    method: "POST",
    pathname: "/auth/v1/dev-tokens",
    body,
  });
  const second = await coreGatewayResponse({
    method: "POST",
    pathname: "/auth/v1/dev-tokens",
    body,
  });

  assert.equal(first.status, 201);
  assert.equal(
    (first.body as { token?: string }).token,
    (second.body as { token?: string }).token,
  );
  assert.match((first.body as { authorization?: string }).authorization ?? "", /^Bearer /);
});

test("routed functions receive Run402 helper env and redact injected keys from logs", async () => {
  const catalog = new MemoryProjectCatalog();
  const project = await catalog.create({ name: "env app" });
  const state: PortableReleaseState = {
    ...emptyCoreReleaseState(),
    routes: {
      manifest_sha256: "env-route-test",
      entries: [{
        pattern: "/api/*",
        kind: "prefix",
        prefix: "/api/",
        methods: ["GET"],
        target: { type: "function", name: "api" },
      }],
    },
  };
  const functionLogs = new MemoryFunctionLogs();
  const executor = new MemoryFunctionExecutor({
    logs: (input) => [
      userLog(
        input,
        "stdout",
        `RUN402_SERVICE_KEY=${input.run402Env?.serviceKey} RUN402_ANON_KEY=${input.run402Env?.anonKey}`,
      ),
    ],
  });
  const runtime = {
    projects: catalog,
    releases: new MemoryReleaseState(state),
    content: new MemoryContentStore(),
    functionBundles: new MemoryFunctionBundles(functionBundle("a".repeat(64), 12)),
    functionExecutor: executor,
    functionLogs,
    publicBaseUrl: "https://public.core.test",
    functionApiBaseUrl: "http://core:4020",
    jwtSecret: "env-test-secret",
  };

  const response = await coreGatewayResponse({
    method: "GET",
    pathname: `/projects/v1/${project.project_id}/static/api/env`,
  }, runtime);

  assert.equal(response.status, 201);
  assert.deepEqual(executor.last?.run402Env, {
    apiBaseUrl: "http://core:4020",
    anonKey: project.anon_key,
    serviceKey: project.service_key,
    jwtSecret: "env-test-secret",
  });

  const logs = await coreGatewayResponse({
    method: "GET",
    pathname: `/projects/v1/${project.project_id}/functions/logs?request_id=${executor.last?.requestId}`,
    headers: { apikey: project.service_key },
  }, runtime);
  assert.equal(logs.status, 200);
  const text = (logs.body as { logs: CoreFunctionLogEntry[] }).logs.map((entry) => entry.message).join("\n");
  assert.equal(text.includes(project.service_key), false);
  assert.equal(text.includes(project.anon_key), false);
  assert.equal(text.includes("[redacted]"), true);
});

test("caller REST compatibility proxies anon and authenticated project-scoped JWTs", async () => {
  const catalog = new MemoryProjectCatalog();
  const project = await catalog.create({ name: "caller rest app" });
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const runtime = {
    projects: catalog,
    projectKeys: catalog,
    postgrestUrl: "http://postgrest.local",
    jwtSecret: "caller-rest-secret",
    fetch: async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify([{ key: "value" }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };

  const anonymous = await coreGatewayResponse({
    method: "GET",
    pathname: "/rest/v1/site_config?select=*",
    headers: { apikey: project.anon_key },
  }, runtime);
  assert.equal(anonymous.status, 200);
  assert.deepEqual(jsonFromRaw(anonymous), [{ key: "value" }]);
  assert.equal(calls[0]?.url, "http://postgrest.local/site_config?select=*");
  assert.equal((calls[0]?.init.headers as Record<string, string>)["accept-profile"], project.schema_slot);
  const anonClaims = jwtPayload((calls[0]?.init.headers as Record<string, string>).authorization);
  assert.equal(anonClaims.role, "anon");
  assert.equal(anonClaims.project_id, project.project_id);

  const token = await coreGatewayResponse({
    method: "POST",
    pathname: "/auth/v1/dev-tokens",
    body: { project_id: project.project_id, role: "authenticated", sub: "user_a" },
  }, { jwtSecret: "caller-rest-secret" });
  const userAuth = (token.body as { authorization: string }).authorization;
  const authenticated = await coreGatewayResponse({
    method: "GET",
    pathname: "/rest/v1/sections?select=id",
    headers: { apikey: project.anon_key, authorization: userAuth },
  }, runtime);
  assert.equal(authenticated.status, 200);
  assert.equal((calls[1]?.init.headers as Record<string, string>).authorization, userAuth);

  const wrongProjectToken = await coreGatewayResponse({
    method: "POST",
    pathname: "/auth/v1/dev-tokens",
    body: { project_id: "prj_0000000000000002", role: "authenticated", sub: "user_b" },
  }, { jwtSecret: "caller-rest-secret" });
  const rejected = await coreGatewayResponse({
    method: "GET",
    pathname: "/rest/v1/sections?select=id",
    headers: {
      apikey: project.anon_key,
      authorization: (wrongProjectToken.body as { authorization: string }).authorization,
    },
  }, runtime);
  assert.equal(rejected.status, 403);
  assert.equal(calls.length, 2);

  const missingKey = await coreGatewayResponse({
    method: "GET",
    pathname: "/rest/v1/sections?select=id",
  }, runtime);
  assert.equal(missingKey.status, 401);
});

test("service REST compatibility requires service key and proxies as service role", async () => {
  const catalog = new MemoryProjectCatalog();
  const project = await catalog.create({ name: "service rest app" });
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const runtime = {
    projects: catalog,
    projectKeys: catalog,
    postgrestUrl: "http://postgrest.local",
    jwtSecret: "service-rest-secret",
    fetch: async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify([{ id: 1 }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };

  const read = await coreGatewayResponse({
    method: "GET",
    pathname: "/admin/v1/rest/site_config?select=*",
    headers: { apikey: project.service_key, authorization: `Bearer ${project.service_key}` },
  }, runtime);
  assert.equal(read.status, 200);
  assert.deepEqual(jsonFromRaw(read), [{ id: 1 }]);
  assert.equal(calls[0]?.url, "http://postgrest.local/site_config?select=*");
  const claims = jwtPayload((calls[0]?.init.headers as Record<string, string>).authorization);
  assert.equal(claims.role, "service_role");
  assert.equal(claims.project_id, project.project_id);
  assert.equal((calls[0]?.init.headers as Record<string, string>)["content-profile"], project.schema_slot);

  const anonRejected = await coreGatewayResponse({
    method: "GET",
    pathname: "/admin/v1/rest/site_config?select=*",
    headers: { apikey: project.anon_key },
  }, runtime);
  assert.equal(anonRejected.status, 401);

  const missingRejected = await coreGatewayResponse({
    method: "GET",
    pathname: "/admin/v1/rest/site_config?select=*",
  }, runtime);
  assert.equal(missingRejected.status, 401);
  assert.equal(calls.length, 1);
});

test("admin SQL compatibility is service-key only and project scoped", async () => {
  const catalog = new MemoryProjectCatalog();
  const project = await catalog.create({ name: "sql app" });
  const projectSql = new MemoryProjectSql();
  const runtime = {
    projects: catalog,
    projectSql,
  };

  const response = await coreGatewayResponse({
    method: "POST",
    pathname: `/projects/v1/admin/${project.project_id}/sql`,
    headers: { apikey: project.service_key },
    body: "SELECT key FROM site_config",
  }, runtime);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    status: "ok",
    schema: project.schema_slot,
    rows: [{ ok: true }],
    row_count: 1,
    fields: [{ name: "ok", type: "bool" }],
  });
  assert.equal(projectSql.last?.project.project_id, project.project_id);
  assert.equal(projectSql.last?.sql, "SELECT key FROM site_config");

  const jsonBody = await coreGatewayResponse({
    method: "POST",
    pathname: `/projects/v1/admin/${project.project_id}/sql`,
    headers: { apikey: project.service_key },
    body: { sql: "SELECT $1::int AS n", params: [42] },
  }, runtime);
  assert.equal(jsonBody.status, 200);
  assert.deepEqual(projectSql.last?.params, [42]);

  const anonRejected = await coreGatewayResponse({
    method: "POST",
    pathname: `/projects/v1/admin/${project.project_id}/sql`,
    headers: { apikey: project.anon_key },
    body: "SELECT 1",
  }, runtime);
  assert.equal(anonRejected.status, 401);

  const crossSchemaRejected = await coreGatewayResponse({
    method: "POST",
    pathname: `/projects/v1/admin/${project.project_id}/sql`,
    headers: { apikey: project.service_key },
    body: "SELECT * FROM project_0000000000000002.site_config",
  }, runtime);
  assert.equal(crossSchemaRejected.status, 403);
});

test("storage routes upload, serve, sign, preserve immutable versions, delete, and paginate", async () => {
  const catalog = new MemoryProjectCatalog();
  const project = await catalog.create({ name: "storage app" });
  const content = new MemoryContentStore();
  const storage = new MemoryStoragePort("http://127.0.0.1:4020");
  const runtime = {
    projects: catalog,
    content,
    storage,
    signedReads: storage,
    cleanup: storage,
    maxObjectBytes: 1024 * 1024,
  };
  const headers = { apikey: project.service_key };

  const firstBytes = Buffer.from("console.log('v1');");
  const firstSha = sha256Hex(firstBytes);
  const createFirst = await coreGatewayResponse({
    method: "POST",
    pathname: `/projects/v1/${project.project_id}/storage/uploads`,
    headers,
    body: {
      key: "assets/app.js",
      size_bytes: firstBytes.byteLength,
      sha256: firstSha,
      content_type: "text/javascript",
      visibility: "public",
      immutable: true,
    },
  }, runtime);
  assert.equal(createFirst.status, 201);
  const firstSession = createFirst.body as CoreUploadSession;

  const putFirst = await coreGatewayResponse({
    method: "PUT",
    pathname: `/projects/v1/${project.project_id}/storage/uploads/${firstSession.upload_id}/bytes`,
    headers,
    body: firstBytes,
  }, runtime);
  assert.equal(putFirst.status, 200);

  const completeFirst = await coreGatewayResponse({
    method: "POST",
    pathname: `/projects/v1/${project.project_id}/storage/uploads/${firstSession.upload_id}/complete`,
    headers,
  }, runtime);
  assert.equal(completeFirst.status, 200);
  const firstObject = completeFirst.body as CoreStorageObject;
  assert.equal(firstObject.public_url?.endsWith("/storage/public/assets/app.js"), true);
  assert.equal(firstObject.immutable_url?.includes(`/immutable/${firstSha}/assets/app.js`), true);

  const secondBytes = Buffer.from("console.log('v2');");
  const secondSha = sha256Hex(secondBytes);
  const createSecond = await coreGatewayResponse({
    method: "POST",
    pathname: `/projects/v1/${project.project_id}/storage/uploads`,
    headers,
    body: {
      key: "assets/app.js",
      size_bytes: secondBytes.byteLength,
      sha256: secondSha,
      content_type: "text/javascript",
      visibility: "public",
      immutable: true,
    },
  }, runtime);
  const secondSession = createSecond.body as CoreUploadSession;
  assert.equal(createSecond.status, 201);
  assert.equal((await coreGatewayResponse({
    method: "PUT",
    pathname: `/projects/v1/${project.project_id}/storage/uploads/${secondSession.upload_id}/bytes`,
    headers,
    body: secondBytes,
  }, runtime)).status, 200);
  assert.equal((await coreGatewayResponse({
    method: "POST",
    pathname: `/projects/v1/${project.project_id}/storage/uploads/${secondSession.upload_id}/complete`,
    headers,
  }, runtime)).status, 200);

  const mutableRead = await coreGatewayResponse({
    method: "GET",
    pathname: `/projects/v1/${project.project_id}/storage/public/assets/app.js`,
  }, runtime);
  assert.equal(mutableRead.status, 200);
  assert.equal(Buffer.from(mutableRead.body as Uint8Array).toString("utf8"), secondBytes.toString("utf8"));

  const immutableRead = await coreGatewayResponse({
    method: "GET",
    pathname: `/projects/v1/${project.project_id}/storage/immutable/${firstSha}/assets/app.js`,
  }, runtime);
  assert.equal(immutableRead.status, 200);
  assert.equal(Buffer.from(immutableRead.body as Uint8Array).toString("utf8"), firstBytes.toString("utf8"));

  const privateBytes = Buffer.from("quarterly numbers");
  const privateSha = sha256Hex(privateBytes);
  const privateSession = (await coreGatewayResponse({
    method: "POST",
    pathname: `/projects/v1/${project.project_id}/storage/uploads`,
    headers,
    body: {
      key: "private/report.txt",
      size_bytes: privateBytes.byteLength,
      sha256: privateSha,
      content_type: "text/plain",
      visibility: "private",
    },
  }, runtime)).body as CoreUploadSession;
  assert.equal((await coreGatewayResponse({
    method: "PUT",
    pathname: `/projects/v1/${project.project_id}/storage/uploads/${privateSession.upload_id}/bytes`,
    headers,
    body: privateBytes,
  }, runtime)).status, 200);
  assert.equal((await coreGatewayResponse({
    method: "POST",
    pathname: `/projects/v1/${project.project_id}/storage/uploads/${privateSession.upload_id}/complete`,
    headers,
  }, runtime)).status, 200);

  const privatePublicRead = await coreGatewayResponse({
    method: "GET",
    pathname: `/projects/v1/${project.project_id}/storage/public/private/report.txt`,
  }, runtime);
  assert.equal(privatePublicRead.status, 404);

  const privateAuthRead = await coreGatewayResponse({
    method: "GET",
    pathname: `/projects/v1/${project.project_id}/storage/blob/private/report.txt`,
    headers,
  }, runtime);
  assert.equal(privateAuthRead.status, 200);
  assert.equal(Buffer.from(privateAuthRead.body as Uint8Array).toString("utf8"), "quarterly numbers");

  const sign = await coreGatewayResponse({
    method: "POST",
    pathname: `/projects/v1/${project.project_id}/storage/blob/private/report.txt/sign`,
    headers,
    body: { ttl_seconds: 60 },
  }, runtime);
  assert.equal(sign.status, 201);
  const signedUrl = new URL((sign.body as { signed_url: string }).signed_url);
  const signedRead = await coreGatewayResponse({
    method: "GET",
    pathname: `${signedUrl.pathname}${signedUrl.search}`,
  }, runtime);
  assert.equal(signedRead.status, 200);
  assert.equal(Buffer.from(signedRead.body as Uint8Array).toString("utf8"), "quarterly numbers");

  const listOne = await coreGatewayResponse({
    method: "GET",
    pathname: `/projects/v1/${project.project_id}/storage/objects?prefix=assets/&limit=1`,
    headers,
  }, runtime);
  assert.equal(listOne.status, 200);
  assert.equal((listOne.body as { objects: unknown[]; next_cursor: string | null }).objects.length, 1);

  const deleted = await coreGatewayResponse({
    method: "DELETE",
    pathname: `/projects/v1/${project.project_id}/storage/blob/assets/app.js`,
    headers,
  }, runtime);
  assert.equal(deleted.status, 200);
  assert.equal((await coreGatewayResponse({
    method: "GET",
    pathname: `/projects/v1/${project.project_id}/storage/public/assets/app.js`,
  }, runtime)).status, 404);
  assert.equal((await coreGatewayResponse({
    method: "GET",
    pathname: `/projects/v1/${project.project_id}/storage/immutable/${firstSha}/assets/app.js`,
  }, runtime)).status, 200);

  const cleanup = await coreGatewayResponse({
    method: "POST",
    pathname: `/projects/v1/${project.project_id}/storage/cleanup`,
    headers,
  }, runtime);
  assert.equal(cleanup.status, 200);
  assert.deepEqual(
    (cleanup.body as { retained_live_sha256: string[] }).retained_live_sha256.sort(),
    [firstSha, secondSha, privateSha].sort(),
  );
});

test("storage upload completion rejects content digest mismatches", async () => {
  const catalog = new MemoryProjectCatalog();
  const project = await catalog.create({ name: "storage app" });
  const content = new MemoryContentStore();
  const storage = new MemoryStoragePort("http://127.0.0.1:4020");
  const runtime = { projects: catalog, content, storage };
  const headers = { apikey: project.service_key };
  const bytes = Buffer.from("actual bundle bytes");

  const create = await coreGatewayResponse({
    method: "POST",
    pathname: `/projects/v1/${project.project_id}/storage/uploads`,
    headers,
    body: {
      key: "functions/api.js",
      size_bytes: bytes.byteLength,
      sha256: "a".repeat(64),
      content_type: "application/javascript",
      visibility: "private",
      immutable: true,
    },
  }, runtime);
  assert.equal(create.status, 201);
  const session = create.body as CoreUploadSession;
  assert.equal((await coreGatewayResponse({
    method: "PUT",
    pathname: `/projects/v1/${project.project_id}/storage/uploads/${session.upload_id}/bytes`,
    headers,
    body: bytes,
  }, runtime)).status, 200);

  const complete = await coreGatewayResponse({
    method: "POST",
    pathname: `/projects/v1/${project.project_id}/storage/uploads/${session.upload_id}/complete`,
    headers,
  }, runtime);

  assert.equal(complete.status, 409);
  assert.equal((complete.body as { error?: string }).error, "content_digest_mismatch");
  assert.equal(await storage.getObject({ projectId: project.project_id, key: "functions/api.js" }), null);
});

test("static route manifest serving honors explicit paths, aliases, methods, diagnostics, and dynamic fail-closed", async () => {
  const catalog = new MemoryProjectCatalog();
  const project = await catalog.create({ name: "routes app" });
  const content = new MemoryContentStore();
  const events = Buffer.from("<h1>Events</h1>");
  const login = Buffer.from("<h1>Login</h1>");
  const hidden = Buffer.from("hidden");
  const eventsSha = sha256Hex(events);
  const loginSha = sha256Hex(login);
  const hiddenSha = sha256Hex(hidden);
  await content.putStatic({ sha256: eventsSha, bytes: events, contentType: "text/html" });
  await content.putStatic({ sha256: loginSha, bytes: login, contentType: "text/html" });
  await content.putStatic({ sha256: hiddenSha, bytes: hidden, contentType: "text/plain" });

  const state: PortableReleaseState = {
    ...emptyCoreReleaseState(),
    site: {
      paths: [
        { path: "events.html", content_sha256: eventsSha, content_type: "text/html", size_bytes: events.byteLength },
        { path: "login.html", content_sha256: loginSha, content_type: "text/html", size_bytes: login.byteLength },
        { path: "hidden.txt", content_sha256: hiddenSha, content_type: "text/plain", size_bytes: hidden.byteLength },
      ],
    },
    static_manifest: {
      version: STATIC_MANIFEST_VERSION,
      public_path_mode: "explicit",
      files: {
        "/events": {
          sha256: eventsSha,
          size: events.byteLength,
          content_type: "text/html",
          cache_class: "html",
          cache_class_source: "declared",
          asset_path: "events.html",
          direct: true,
          authority: "explicit_public_path",
        },
        "/login": {
          sha256: loginSha,
          size: login.byteLength,
          content_type: "text/html",
          cache_class: "html",
          cache_class_source: "declared",
          asset_path: "login.html",
          direct: false,
          authority: "route_static_alias",
          methods: ["GET", "HEAD"],
        },
      },
    },
    routes: {
      manifest_sha256: "route-manifest-test",
      entries: [
        {
          pattern: "/login",
          kind: "exact",
          prefix: null,
          methods: ["GET", "HEAD"],
          target: { type: "static", file: "login.html" },
        },
        {
          pattern: "/api/*",
          kind: "prefix",
          prefix: "/api/",
          methods: ["GET"],
          target: { type: "function", name: "api" },
        },
      ],
    },
  };
  const runtime = {
    projects: catalog,
    releases: new MemoryReleaseState(state),
    content,
  };

  const eventsRead = await coreGatewayResponse({
    method: "GET",
    pathname: `/projects/v1/${project.project_id}/static/events?ignored=true`,
  }, runtime);
  assert.equal(eventsRead.status, 200);
  assert.equal(Buffer.from(eventsRead.body as Uint8Array).toString("utf8"), "<h1>Events</h1>");
  assert.equal(eventsRead.headers?.["X-Run402-Content-Sha256"], eventsSha);

  assert.equal((await coreGatewayResponse({
    method: "GET",
    pathname: `/projects/v1/${project.project_id}/static/events.html`,
  }, runtime)).status, 404);

  const loginHead = await coreGatewayResponse({
    method: "HEAD",
    pathname: `/projects/v1/${project.project_id}/static/login/`,
  }, runtime);
  assert.equal(loginHead.status, 200);
  assert.equal(loginHead.headers?.["Content-Length"], String(login.byteLength));
  assert.equal((loginHead.body as Uint8Array).byteLength, 0);

  assert.equal((await coreGatewayResponse({
    method: "POST",
    pathname: `/projects/v1/${project.project_id}/static/login`,
  }, runtime)).status, 405);
  assert.equal((await coreGatewayResponse({
    method: "GET",
    pathname: `/projects/v1/${project.project_id}/static/api/users`,
  }, runtime)).status, 503);

  const diagnostics = await coreGatewayResponse({
    method: "GET",
    pathname: `/projects/v1/${project.project_id}/static-diagnostics`,
    headers: { apikey: project.service_key },
  }, runtime);
  assert.equal(diagnostics.status, 200);
  assert.deepEqual((diagnostics.body as { non_public_asset_paths: string[] }).non_public_asset_paths, ["hidden.txt"]);
});

test("static routes map missing projects to a response instead of throwing", async () => {
  const response = await coreGatewayResponse({
    method: "GET",
    pathname: "/projects/v1/prj_011f366f766/static/index.html",
  }, {
    releases: new MissingProjectReleaseState(),
    content: new MemoryContentStore(),
  });

  assert.equal(response.status, 404);
  assert.deepEqual(response.body, {
    error: "project_not_found",
    message: "Run402 Core project not found: prj_011f366f766",
  });
});

test("dynamic static routes invoke local functions with routed HTTP envelope", async () => {
  const catalog = new MemoryProjectCatalog();
  const project = await catalog.create({ name: "routes app" });
  const state: PortableReleaseState = {
    ...emptyCoreReleaseState(),
    i18n: {
      defaultLocale: "en",
      locales: ["en"],
      detect: [],
      unknownLocalePolicy: "reject",
    },
    routes: {
      manifest_sha256: "route-manifest-test",
      entries: [{
        pattern: "/api/*",
        kind: "prefix",
        prefix: "/api/",
        methods: ["POST", "HEAD"],
        target: { type: "function", name: "api" },
      }],
    },
  };
  const bundle = functionBundle("b".repeat(64), 12);
  const executor = new MemoryFunctionExecutor();
  const runtime = {
    projects: catalog,
    releases: new MemoryReleaseState(state),
    content: new MemoryContentStore(),
    functionBundles: new MemoryFunctionBundles(bundle),
    functionExecutor: executor,
  };

  const response = await coreGatewayResponse({
    method: "POST",
    pathname: `/projects/v1/${project.project_id}/static/api/users?x=1&x=2`,
    headers: {
      host: "example.test",
      cookie: "sid=abc",
      "x-run402-request-id": "spoofed",
      connection: "close",
      "x-custom": ["one", "two"],
    },
    body: Buffer.from("hello"),
  }, runtime);

  assert.equal(response.status, 201);
  assert.equal(Buffer.from(response.body as Uint8Array).toString("utf8"), "ok");
  assert.match(String(response.headers?.["X-Run402-Request-Id"]), /^req_/);
  assert.deepEqual(response.headers?.["Set-Cookie"], ["a=1; Path=/", "b=2; Path=/"]);
  assert.equal(response.headers?.["Cache-Control"], "private, no-store");
  assert.equal(response.headers?.["x-run402-cache"], "dynamic-bypass");
  assert.equal(response.headers?.connection, undefined);

  const invocation = executor.last;
  assert.ok(invocation);
  assert.equal(invocation.request?.version, "run402.routed_http.v1");
  assert.equal(invocation.request?.method, "POST");
  assert.equal(invocation.request?.url, "http://example.test/api/users?x=1&x=2");
  assert.equal(invocation.request?.path, "/api/users");
  assert.equal(invocation.request?.rawQuery, "x=1&x=2");
  assert.equal(invocation.request?.cookies.raw, "sid=abc");
  assert.equal(Buffer.from(invocation.request?.body?.data ?? "", "base64").toString("utf8"), "hello");
  assert.equal(invocation.request?.headers.some(([name, value]) => name === "x-run402-request-id" && value === "spoofed"), false);
  assert.equal(invocation.request?.headers.some(([name]) => name === "connection"), false);
  assert.deepEqual(invocation.request?.headers.filter(([name]) => name === "x-custom"), [["x-custom", "one"], ["x-custom", "two"]]);
  assert.equal(invocation.request?.context.routePattern, "/api/*");
  assert.equal(invocation.request?.context.routeTarget.name, "api");
  assert.equal(invocation.request?.context.locale, "en");
  assert.equal(invocation.request?.context.defaultLocale, "en");

  const head = await coreGatewayResponse({
    method: "HEAD",
    pathname: `/projects/v1/${project.project_id}/static/api/users`,
    headers: { host: "example.test" },
  }, runtime);
  assert.equal(head.status, 201);
  assert.equal((head.body as Uint8Array).byteLength, 0);
  assert.equal(head.headers?.["Content-Length"], "2");
});

test("root project mount serves app paths without taking over control-plane routes", async () => {
  const catalog = new MemoryProjectCatalog();
  const project = await catalog.create({ name: "root-mounted app" });
  const content = new MemoryContentStore();
  const index = Buffer.from("<script src=\"/js/env.js\"></script>");
  const env = Buffer.from("window.__APP=1;");
  const indexSha = sha256Hex(index);
  const envSha = sha256Hex(env);
  await content.putStatic({ sha256: indexSha, bytes: index, contentType: "text/html" });
  await content.putStatic({ sha256: envSha, bytes: env, contentType: "text/javascript" });

  const state: PortableReleaseState = {
    ...emptyCoreReleaseState(),
    site: {
      paths: [
        { path: "index.html", content_sha256: indexSha, content_type: "text/html", size_bytes: index.byteLength },
        { path: "js/env.js", content_sha256: envSha, content_type: "text/javascript", size_bytes: env.byteLength },
      ],
    },
    static_manifest: {
      version: STATIC_MANIFEST_VERSION,
      public_path_mode: "explicit",
      files: {
        "/": {
          sha256: indexSha,
          size: index.byteLength,
          content_type: "text/html",
          cache_class: "html",
          cache_class_source: "declared",
          asset_path: "index.html",
          direct: true,
          authority: "explicit_public_path",
        },
        "/js/env.js": {
          sha256: envSha,
          size: env.byteLength,
          content_type: "text/javascript",
          cache_class: "revalidating_asset",
          cache_class_source: "declared",
          asset_path: "js/env.js",
          direct: true,
          authority: "explicit_public_path",
        },
      },
    },
    routes: {
      manifest_sha256: "root-route-test",
      entries: [{
        pattern: "/api/*",
        kind: "prefix",
        prefix: "/api/",
        methods: ["POST"],
        target: { type: "function", name: "api" },
      }],
    },
  };
  const executor = new MemoryFunctionExecutor();
  const runtime = {
    projects: catalog,
    releases: new MemoryReleaseState(state),
    content,
    functionBundles: new MemoryFunctionBundles(functionBundle("0".repeat(64), 12)),
    functionExecutor: executor,
    rootProjectId: project.project_id,
  };

  const health = await coreGatewayResponse("/health", runtime);
  assert.equal(health.status, 200);
  assert.equal((health.body as { mode?: string }).mode, "core");

  const root = await coreGatewayResponse("/", runtime);
  assert.equal(root.status, 200);
  assert.equal(Buffer.from(root.body as Uint8Array).toString("utf8"), "<script src=\"/js/env.js\"></script>");

  const asset = await coreGatewayResponse("/js/env.js", runtime);
  assert.equal(asset.status, 200);
  assert.equal(Buffer.from(asset.body as Uint8Array).toString("utf8"), "window.__APP=1;");

  const api = await coreGatewayResponse({
    method: "POST",
    pathname: "/api/kychon",
    headers: { host: "app.local" },
    body: { ok: true },
  }, runtime);
  assert.equal(api.status, 201);
  assert.equal(executor.last?.request?.path, "/api/kychon");
  assert.equal(executor.last?.request?.url, "http://app.local/api/kychon");

  const projectInspect = await coreGatewayResponse({
    method: "GET",
    pathname: `/projects/v1/${project.project_id}`,
  }, runtime);
  assert.equal(projectInspect.status, 200);
  assert.equal((projectInspect.body as { project_id?: string }).project_id, project.project_id);
});

test("implicit static html paths resolve clean URLs before SSR fallback", async () => {
  const catalog = new MemoryProjectCatalog();
  const project = await catalog.create({ name: "implicit clean app" });
  const content = new MemoryContentStore();
  const events = Buffer.from("<h1>Events</h1>");
  const eventsSha = sha256Hex(events);
  await content.putStatic({ sha256: eventsSha, bytes: events, contentType: "text/html" });

  const state: PortableReleaseState = {
    ...emptyCoreReleaseState(),
    site: {
      paths: [
        { path: "events.html", content_sha256: eventsSha, content_type: "text/html", size_bytes: events.byteLength },
      ],
    },
    static_manifest: {
      version: STATIC_MANIFEST_VERSION,
      files: {
        "/events.html": {
          sha256: eventsSha,
          size: events.byteLength,
          content_type: "text/html",
          cache_class: "html",
          cache_class_source: "declared",
          asset_path: "events.html",
          direct: true,
          authority: "implicit_file_path",
        },
      },
    },
    functions: [
      portableFunction("ssr", "ssr", [CORE_ASTRO_SSR_OUTPUT_CONTRACT_VERSION]),
    ],
    routes: {
      manifest_sha256: "implicit-clean-url-test",
      entries: [],
    },
  };
  const ssrBundle = functionBundle("5".repeat(64), 12);
  ssrBundle.name = "ssr";
  ssrBundle.class = "ssr";
  ssrBundle.capabilities = [CORE_ASTRO_SSR_OUTPUT_CONTRACT_VERSION];
  const executor = new MemoryFunctionExecutor();
  const runtime = {
    projects: catalog,
    releases: new MemoryReleaseState(state),
    content,
    functionBundles: new MemoryFunctionBundles({ ssr: ssrBundle }),
    functionExecutor: executor,
  };

  const read = await coreGatewayResponse({
    method: "GET",
    pathname: `/projects/v1/${project.project_id}/static/events`,
  }, runtime);
  assert.equal(read.status, 200);
  assert.equal(Buffer.from(read.body as Uint8Array).toString("utf8"), "<h1>Events</h1>");
  assert.equal(executor.last, null);

  const post = await coreGatewayResponse({
    method: "POST",
    pathname: `/projects/v1/${project.project_id}/static/events`,
  }, runtime);
  assert.equal(post.status, 405);
  assert.equal(executor.last, null);
});

test("dynamic static routes reject oversized request bodies before invoking functions", async () => {
  const catalog = new MemoryProjectCatalog();
  const project = await catalog.create({ name: "routes app" });
  const state: PortableReleaseState = {
    ...emptyCoreReleaseState(),
    routes: {
      manifest_sha256: "route-manifest-test",
      entries: [{
        pattern: "/api/*",
        kind: "prefix",
        prefix: "/api/",
        methods: ["POST"],
        target: { type: "function", name: "api" },
      }],
    },
  };
  const executor = new MemoryFunctionExecutor();
  const runtime = {
    projects: catalog,
    releases: new MemoryReleaseState(state),
    content: new MemoryContentStore(),
    functionBundles: new MemoryFunctionBundles(functionBundle("e".repeat(64), 12)),
    functionExecutor: executor,
  };

  const response = await coreGatewayResponse({
    method: "POST",
    pathname: `/projects/v1/${project.project_id}/static/api/too-big`,
    body: Buffer.alloc(CORE_FUNCTION_RESOURCE_DEFAULTS.requestBodyLimitBytes + 1),
  }, runtime);

  assert.equal(response.status, 413);
  assert.equal((response.body as { error?: string }).error, "request_body_too_large");
  assert.equal(executor.last, null);
});

test("astro ssr fallback runs after static assets and function routes", async () => {
  const catalog = new MemoryProjectCatalog();
  const project = await catalog.create({ name: "astro ssr app" });
  const content = new MemoryContentStore();
  const login = Buffer.from("<h1>Login static</h1>");
  const asset = Buffer.from("asset bytes");
  const pre = Buffer.from("<h1>Prerendered</h1>");
  const loginSha = sha256Hex(login);
  const assetSha = sha256Hex(asset);
  const preSha = sha256Hex(pre);
  await content.putStatic({ sha256: loginSha, bytes: login, contentType: "text/html" });
  await content.putStatic({ sha256: assetSha, bytes: asset, contentType: "text/plain" });
  await content.putStatic({ sha256: preSha, bytes: pre, contentType: "text/html" });

  const state: PortableReleaseState = {
    ...emptyCoreReleaseState(),
    site: {
      paths: [
        { path: "login.html", content_sha256: loginSha, content_type: "text/html", size_bytes: login.byteLength },
        { path: "assets/app.txt", content_sha256: assetSha, content_type: "text/plain", size_bytes: asset.byteLength },
        { path: "dashboard.html", content_sha256: preSha, content_type: "text/html", size_bytes: pre.byteLength },
      ],
    },
    static_manifest: {
      version: STATIC_MANIFEST_VERSION,
      public_path_mode: "explicit",
      files: {
        "/login": {
          sha256: loginSha,
          size: login.byteLength,
          content_type: "text/html",
          cache_class: "html",
          cache_class_source: "declared",
          asset_path: "login.html",
          direct: false,
          authority: "route_static_alias",
          methods: ["GET", "HEAD"],
        },
        "/assets/app.txt": {
          sha256: assetSha,
          size: asset.byteLength,
          content_type: "text/plain",
          cache_class: "revalidating_asset",
          cache_class_source: "declared",
          asset_path: "assets/app.txt",
          direct: true,
          authority: "explicit_public_path",
        },
        "/dashboard": {
          sha256: preSha,
          size: pre.byteLength,
          content_type: "text/html",
          cache_class: "html",
          cache_class_source: "declared",
          asset_path: "dashboard.html",
          direct: true,
          authority: "explicit_public_path",
        },
      },
    },
    functions: [
      portableFunction("api", "standard"),
      portableFunction("ssr", "ssr", [CORE_ASTRO_SSR_OUTPUT_CONTRACT_VERSION]),
    ],
    routes: {
      manifest_sha256: "route-manifest-test",
      entries: [
        {
          pattern: "/login",
          kind: "exact",
          prefix: null,
          methods: ["GET", "HEAD"],
          target: { type: "static", file: "login.html" },
        },
        {
          pattern: "/api/*",
          kind: "prefix",
          prefix: "/api/",
          methods: ["GET", "POST"],
          target: { type: "function", name: "api" },
        },
      ],
    },
  };
  const apiBundle = functionBundle("1".repeat(64), 12);
  const ssrBundle = functionBundle("2".repeat(64), 12);
  ssrBundle.name = "ssr";
  ssrBundle.class = "ssr";
  ssrBundle.capabilities = [CORE_ASTRO_SSR_OUTPUT_CONTRACT_VERSION];
  const executor = new MemoryFunctionExecutor();
  const runtime = {
    projects: catalog,
    releases: new MemoryReleaseState(state),
    content,
    functionBundles: new MemoryFunctionBundles({ api: apiBundle, ssr: ssrBundle }),
    functionExecutor: executor,
  };

  const loginRead = await coreGatewayResponse({
    method: "GET",
    pathname: `/projects/v1/${project.project_id}/static/login`,
  }, runtime);
  assert.equal(loginRead.status, 200);
  assert.equal(Buffer.from(loginRead.body as Uint8Array).toString("utf8"), "<h1>Login static</h1>");
  assert.equal(executor.last, null);

  const assetRead = await coreGatewayResponse({
    method: "GET",
    pathname: `/projects/v1/${project.project_id}/static/assets/app.txt`,
  }, runtime);
  assert.equal(assetRead.status, 200);
  assert.equal(Buffer.from(assetRead.body as Uint8Array).toString("utf8"), "asset bytes");
  assert.equal(executor.last, null);

  const prerenderedRead = await coreGatewayResponse({
    method: "GET",
    pathname: `/projects/v1/${project.project_id}/static/dashboard`,
  }, runtime);
  assert.equal(prerenderedRead.status, 200);
  assert.equal(Buffer.from(prerenderedRead.body as Uint8Array).toString("utf8"), "<h1>Prerendered</h1>");
  assert.equal(executor.last, null);

  const apiRead = await coreGatewayResponse({
    method: "GET",
    pathname: `/projects/v1/${project.project_id}/static/api/users`,
  }, runtime);
  assert.equal(apiRead.status, 201);
  assert.equal(executor.last?.functionName, "api");
  assert.equal(executor.last?.bundle.class, "standard");

  executor.last = null;
  const ssrRead = await coreGatewayResponse({
    method: "POST",
    pathname: `/projects/v1/${project.project_id}/static/settings?tab=billing`,
    headers: {
      host: "app.local",
      cookie: "sid=abc",
      "x-run402-function-name": "spoofed",
    },
    body: "body",
  }, runtime);
  assert.equal(ssrRead.status, 201);
  assert.equal(executor.last?.functionName, "ssr");
  assert.equal(executor.last?.bundle.class, "ssr");
  assert.equal(executor.last?.request?.path, "/settings");
  assert.equal(executor.last?.request?.rawQuery, "tab=billing");
  assert.equal(executor.last?.request?.url, "http://app.local/settings?tab=billing");
  assert.equal(executor.last?.request?.context.routePattern, "/*");
  assert.equal(executor.last?.request?.headers.some(([name, value]) => name === "x-run402-function-name" && value === "spoofed"), false);
  assert.equal(executor.last?.request?.headers.some(([name, value]) => name === "x-run402-route-pattern" && value === "/*"), true);

  const ssrHead = await coreGatewayResponse({
    method: "HEAD",
    pathname: `/projects/v1/${project.project_id}/static/settings`,
  }, runtime);
  assert.equal(ssrHead.status, 201);
  assert.equal((ssrHead.body as Uint8Array).byteLength, 0);
  assert.equal(ssrHead.headers?.["Content-Length"], "2");

  executor.last = null;
  const upgrade = await coreGatewayResponse({
    method: "GET",
    pathname: `/projects/v1/${project.project_id}/static/socket`,
    headers: { connection: "Upgrade", upgrade: "websocket" },
  }, runtime);
  assert.equal(upgrade.status, 422);
  assert.equal((upgrade.body as { error?: string }).error, "astro_ssr_unsupported_feature");
  assert.equal(executor.last, null);
});

test("direct function invoke requires service auth and enforces auth gates before dispatch", async () => {
  const catalog = new MemoryProjectCatalog();
  const project = await catalog.create({ name: "functions app" });
  const state = emptyCoreReleaseState();
  const executor = new MemoryFunctionExecutor();
  const runtime = {
    projects: catalog,
    releases: new MemoryReleaseState(state),
    content: new MemoryContentStore(),
    functionBundles: new MemoryFunctionBundles(functionBundle("c".repeat(64), 12)),
    functionExecutor: executor,
    jwtSecret: "test-jwt-secret",
  };

  const unauthorized = await coreGatewayResponse({
    method: "POST",
    pathname: "/functions/v1/invoke",
    body: {
      project_id: project.project_id,
      function_name: "api",
    },
  }, runtime);
  assert.equal(unauthorized.status, 401);

  const direct = await coreGatewayResponse({
    method: "POST",
    pathname: "/functions/v1/invoke",
    headers: { apikey: project.service_key },
    body: {
      project_id: project.project_id,
      function_name: "api",
    },
  }, runtime);

  assert.equal(direct.status, 200);
  assert.equal((direct.body as { response?: { status?: number } }).response?.status, 201);
  assert.equal(executor.last?.invocationKind, "direct");
  assert.equal(executor.last?.request, undefined);

  const gatedBundle = functionBundle("d".repeat(64), 12);
  gatedBundle.require_auth = true;
  const gatedExecutor = new MemoryFunctionExecutor();
  const gated = await coreGatewayResponse({
    method: "POST",
    pathname: "/functions/v1/invoke",
    headers: { apikey: project.service_key },
    body: {
      project_id: project.project_id,
      function_name: "api",
    },
  }, {
    ...runtime,
    functionBundles: new MemoryFunctionBundles(gatedBundle),
    functionExecutor: gatedExecutor,
  });

  assert.equal(gated.status, 401);
  assert.equal((gated.body as { error?: string }).error, "authentication_required");
  assert.equal(gatedExecutor.last, null);

  const userAuth = await devAuthorization(runtime, project.project_id, "user_direct");
  const gatedWithUser = await coreGatewayResponse({
    method: "POST",
    pathname: "/functions/v1/invoke",
    headers: { apikey: project.service_key, authorization: userAuth },
    body: {
      project_id: project.project_id,
      function_name: "api",
    },
  }, {
    ...runtime,
    functionBundles: new MemoryFunctionBundles(gatedBundle),
    functionExecutor: gatedExecutor,
  });

  assert.equal(gatedWithUser.status, 200);
  assert.equal(gatedExecutor.last?.actor?.id, "user_direct");
  assert.equal(gatedExecutor.last?.actor?.role, "authenticated");
});

test("routed function auth and role gates inject generated user context", async () => {
  const catalog = new MemoryProjectCatalog();
  const project = await catalog.create({ name: "gated routes app" });
  const state: PortableReleaseState = {
    ...emptyCoreReleaseState(),
    routes: {
      manifest_sha256: "route-manifest-test",
      entries: [{
        pattern: "/api/*",
        kind: "prefix",
        prefix: "/api/",
        methods: ["GET"],
        target: { type: "function", name: "api" },
      }],
    },
  };
  const authBundle = functionBundle("f".repeat(64), 12);
  authBundle.require_auth = true;
  const authExecutor = new MemoryFunctionExecutor();
  const runtime = {
    projects: catalog,
    releases: new MemoryReleaseState(state),
    content: new MemoryContentStore(),
    functionBundles: new MemoryFunctionBundles(authBundle),
    functionExecutor: authExecutor,
    jwtSecret: "test-jwt-secret",
  };

  const blocked = await coreGatewayResponse({
    method: "GET",
    pathname: `/projects/v1/${project.project_id}/static/api/user`,
  }, runtime);
  assert.equal(blocked.status, 401);
  assert.equal(authExecutor.last, null);

  const userAuth = await devAuthorization(runtime, project.project_id, "user_routed");
  const passed = await coreGatewayResponse({
    method: "GET",
    pathname: `/projects/v1/${project.project_id}/static/api/user`,
    headers: {
      authorization: userAuth,
      "x-run402-user-id": "spoofed",
    },
  }, runtime);
  assert.equal(passed.status, 201);
  assert.equal(authExecutor.last?.actor?.id, "user_routed");
  assert.deepEqual(authExecutor.last?.request?.headers.filter(([name]) => name === "x-run402-user-id"), [["x-run402-user-id", "user_routed"]]);

  const roleBundle = functionBundle("a".repeat(64), 12);
  roleBundle.require_role = {
    table: "members",
    idColumn: "user_id",
    roleColumn: "role",
    allowed: ["admin"],
    cacheTtl: 0,
  };
  const roleExecutor = new MemoryFunctionExecutor();
  const denied = await coreGatewayResponse({
    method: "GET",
    pathname: `/projects/v1/${project.project_id}/static/api/admin`,
    headers: { authorization: userAuth },
  }, {
    ...runtime,
    functionBundles: new MemoryFunctionBundles(roleBundle),
    functionExecutor: roleExecutor,
    roleGates: new MemoryRoleGates("member"),
  });
  assert.equal(denied.status, 403);
  assert.equal((denied.body as { error?: string }).error, "ROLE_FORBIDDEN");
  assert.equal(roleExecutor.last, null);

  const allowed = await coreGatewayResponse({
    method: "GET",
    pathname: `/projects/v1/${project.project_id}/static/api/admin`,
    headers: { authorization: userAuth },
  }, {
    ...runtime,
    functionBundles: new MemoryFunctionBundles(roleBundle),
    functionExecutor: roleExecutor,
    roleGates: new MemoryRoleGates("admin"),
  });
  assert.equal(allowed.status, 201);
  assert.equal(roleExecutor.last?.actor?.role, "admin");
  assert.deepEqual(roleExecutor.last?.request?.headers.filter(([name]) => name === "x-run402-user-role"), [["x-run402-user-role", "admin"]]);
});

test("function secrets expose metadata only and inject required values before dispatch", async () => {
  const catalog = new MemoryProjectCatalog();
  const project = await catalog.create({ name: "secret functions app" });
  const state = emptyCoreReleaseState();
  const secrets = new MemorySecrets();
  const bundle = functionBundle("7".repeat(64), 12);
  bundle.required_secrets = ["API_TOKEN"];
  const executor = new MemoryFunctionExecutor();
  const runtime = {
    projects: catalog,
    releases: new MemoryReleaseState(state),
    content: new MemoryContentStore(),
    functionBundles: new MemoryFunctionBundles(bundle),
    functionExecutor: executor,
    secrets,
  };

  const blockedSet = await coreGatewayResponse({
    method: "POST",
    pathname: `/projects/v1/${project.project_id}/functions/secrets`,
    body: { name: "API_TOKEN", value: "secret-value" },
  }, runtime);
  assert.equal(blockedSet.status, 401);

  const stored = await coreGatewayResponse({
    method: "POST",
    pathname: `/projects/v1/${project.project_id}/functions/secrets`,
    headers: { apikey: project.service_key },
    body: { name: "API_TOKEN", value: "secret-value" },
  }, runtime);
  assert.equal(stored.status, 201);
  assert.equal((stored.body as { name?: string }).name, "API_TOKEN");
  assert.equal("value" in (stored.body as Record<string, unknown>), false);

  const listed = await coreGatewayResponse({
    method: "GET",
    pathname: `/projects/v1/${project.project_id}/functions/secrets`,
    headers: { apikey: project.service_key },
  }, runtime);
  assert.equal(listed.status, 200);
  const listedSecrets = (listed.body as { secrets: Array<Record<string, unknown>> }).secrets;
  assert.equal(listedSecrets[0]?.name, "API_TOKEN");
  assert.equal("value" in listedSecrets[0], false);

  const invoked = await coreGatewayResponse({
    method: "POST",
    pathname: "/functions/v1/invoke",
    headers: { apikey: project.service_key },
    body: {
      project_id: project.project_id,
      function_name: "api",
    },
  }, runtime);
  assert.equal(invoked.status, 200);
  assert.deepEqual(executor.last?.secrets, { API_TOKEN: "secret-value" });

  secrets.clear();
  executor.last = null;
  const missing = await coreGatewayResponse({
    method: "POST",
    pathname: "/functions/v1/invoke",
    headers: { apikey: project.service_key },
    body: {
      project_id: project.project_id,
      function_name: "api",
    },
  }, runtime);
  assert.equal(missing.status, 422);
  assert.equal((missing.body as { error?: string }).error, "missing_required_secret");
  assert.equal(executor.last, null);
});

test("function logs persist platform and user records with request filters", async () => {
  const catalog = new MemoryProjectCatalog();
  const project = await catalog.create({ name: "logged routes app" });
  const state: PortableReleaseState = {
    ...emptyCoreReleaseState(),
    routes: {
      manifest_sha256: "route-manifest-test",
      entries: [{
        pattern: "/api/*",
        kind: "prefix",
        prefix: "/api/",
        methods: ["GET"],
        target: { type: "function", name: "api" },
      }],
    },
  };
  const functionLogs = new MemoryFunctionLogs();
  const executor = new MemoryFunctionExecutor({
    logs: (input) => [userLog(input, "stdout", "hello from user code")],
  });
  const runtime = {
    projects: catalog,
    releases: new MemoryReleaseState(state),
    content: new MemoryContentStore(),
    functionBundles: new MemoryFunctionBundles(functionBundle("8".repeat(64), 12)),
    functionExecutor: executor,
    functionLogs,
  };

  const response = await coreGatewayResponse({
    method: "GET",
    pathname: `/projects/v1/${project.project_id}/static/api/logged`,
  }, runtime);
  assert.equal(response.status, 201);
  const requestId = String(response.headers?.["X-Run402-Request-Id"]);
  assert.match(requestId, /^req_/);

  const unauthorized = await coreGatewayResponse({
    method: "GET",
    pathname: `/projects/v1/${project.project_id}/functions/logs?request_id=${requestId}`,
  }, runtime);
  assert.equal(unauthorized.status, 401);

  const listed = await coreGatewayResponse({
    method: "GET",
    pathname: `/projects/v1/${project.project_id}/functions/logs?request_id=${requestId}&tail=10`,
    headers: { apikey: project.service_key },
  }, runtime);
  assert.equal(listed.status, 200);
  const logs = (listed.body as { logs: CoreFunctionLogEntry[] }).logs;
  assert.ok(logs.length >= 3);
  assert.deepEqual([...logs].sort((a, b) => a.timestamp.localeCompare(b.timestamp)), logs);
  assert.equal(logs.every((entry) => entry.request_id === requestId), true);
  assert.equal(logs.some((entry) => entry.stream === "platform" && entry.message.includes("function_invocation_started")), true);
  assert.equal(logs.some((entry) => entry.stream === "stdout" && entry.message === "hello from user code"), true);
  assert.equal(functionLogs.invocations[0]?.status, "succeeded");

  const future = await coreGatewayResponse({
    method: "GET",
    pathname: `/projects/v1/${project.project_id}/functions/logs?request_id=${requestId}&since=2999-01-01T00:00:00.000Z`,
    headers: { apikey: project.service_key },
  }, runtime);
  assert.deepEqual((future.body as { logs: CoreFunctionLogEntry[] }).logs, []);
});

test("routed function errors return sanitized request diagnostics and platform logs", async () => {
  const catalog = new MemoryProjectCatalog();
  const project = await catalog.create({ name: "failing routes app" });
  const state: PortableReleaseState = {
    ...emptyCoreReleaseState(),
    routes: {
      manifest_sha256: "route-manifest-test",
      entries: [{
        pattern: "/api/*",
        kind: "prefix",
        prefix: "/api/",
        methods: ["GET"],
        target: { type: "function", name: "api" },
      }],
    },
  };
  const functionLogs = new MemoryFunctionLogs();
  const runtime = {
    projects: catalog,
    releases: new MemoryReleaseState(state),
    content: new MemoryContentStore(),
    functionBundles: new MemoryFunctionBundles(functionBundle("9".repeat(64), 12)),
    functionExecutor: new MemoryFunctionExecutor({
      error: new LocalExecutorError("raw user boom secret-value", { function_name: "api" }),
    }),
    functionLogs,
  };

  const response = await coreGatewayResponse({
    method: "GET",
    pathname: `/projects/v1/${project.project_id}/static/api/fails`,
  }, runtime);
  assert.equal(response.status, 500);
  const body = response.body as { error?: string; message?: string; request_id?: string };
  assert.equal(body.error, "local_executor_failed");
  assert.equal(body.message, "Function invocation failed.");
  assert.match(body.request_id ?? "", /^req_/);
  assert.equal(response.headers?.["X-Run402-Request-Id"], body.request_id);
  assert.equal(JSON.stringify(body).includes("raw user boom"), false);

  const listed = await coreGatewayResponse({
    method: "GET",
    pathname: `/projects/v1/${project.project_id}/functions/logs?request_id=${body.request_id}`,
    headers: { apikey: project.service_key },
  }, runtime);
  const logs = (listed.body as { logs: CoreFunctionLogEntry[] }).logs;
  assert.equal(functionLogs.invocations[0]?.status, "failed");
  assert.equal(logs.some((entry) => entry.stream === "platform" && entry.level === "error"), true);
  assert.equal(logs.some((entry) => entry.message.includes("raw user boom")), false);
  assert.equal(logs.some((entry) => entry.message.includes("/api/*") && entry.message.includes("/api/fails")), true);
});

test("function user logs are redacted before readback or direct response", async () => {
  const catalog = new MemoryProjectCatalog();
  const project = await catalog.create({ name: "redacted functions app" });
  const state = emptyCoreReleaseState();
  const secrets = new MemorySecrets();
  await secrets.setSecret({
    projectId: project.project_id,
    name: "API_TOKEN",
    value: "secret-value",
  });
  const bundle = functionBundle("6".repeat(64), 12);
  bundle.required_secrets = ["API_TOKEN"];
  const functionLogs = new MemoryFunctionLogs();
  const executor = new MemoryFunctionExecutor({
    logs: (input) => [
      userLog(input, "stdout", `Authorization: Bearer abcdef123456 cookie=sessionid ${project.service_key}`),
      userLog(input, "stderr", "x-run402-payment: paytoken API_TOKEN=secret-value api_key=abcd1234abcd1234"),
    ],
  });
  const runtime = {
    projects: catalog,
    releases: new MemoryReleaseState(state),
    content: new MemoryContentStore(),
    functionBundles: new MemoryFunctionBundles(bundle),
    functionExecutor: executor,
    functionLogs,
    secrets,
  };

  const invoked = await coreGatewayResponse({
    method: "POST",
    pathname: "/functions/v1/invoke",
    headers: { apikey: project.service_key },
    body: {
      project_id: project.project_id,
      function_name: "api",
    },
  }, runtime);
  assert.equal(invoked.status, 200);
  const directLogs = (invoked.body as { logs: CoreFunctionLogEntry[] }).logs;
  assert.equal(directLogs.every((entry) => entry.redacted), true);
  const directText = directLogs.map((entry) => entry.message).join("\n");
  assert.equal(directText.includes("abcdef123456"), false);
  assert.equal(directText.includes("sessionid"), false);
  assert.equal(directText.includes(project.service_key), false);
  assert.equal(directText.includes("paytoken"), false);
  assert.equal(directText.includes("secret-value"), false);
  assert.equal(directText.includes("abcd1234abcd1234"), false);

  const requestId = (invoked.body as { request_id: string }).request_id;
  const listed = await coreGatewayResponse({
    method: "GET",
    pathname: `/projects/v1/${project.project_id}/functions/logs?request_id=${requestId}`,
    headers: { apikey: project.service_key },
  }, runtime);
  const storedText = (listed.body as { logs: CoreFunctionLogEntry[] }).logs.map((entry) => entry.message).join("\n");
  assert.equal(storedText.includes("secret-value"), false);
  assert.equal(storedText.includes("[redacted]"), true);
});

async function devAuthorization(
  runtime: Parameters<typeof coreGatewayResponse>[1],
  projectId: string,
  sub: string,
): Promise<string> {
  const response = await coreGatewayResponse({
    method: "POST",
    pathname: "/auth/v1/dev-tokens",
    body: {
      project_id: projectId,
      role: "authenticated",
      sub,
    },
  }, runtime);
  assert.equal(response.status, 201);
  return (response.body as { authorization: string }).authorization;
}

class MemoryFunctionBundles {
  readonly #bundles: Map<string, CoreFunctionBundleMetadata>;

  constructor(bundle: CoreFunctionBundleMetadata | Record<string, CoreFunctionBundleMetadata>) {
    this.#bundles = "name" in bundle
      ? new Map([[bundle.name, bundle]])
      : new Map(Object.entries(bundle));
  }

  async getFunctionBundle(input: { functionName: string }): Promise<CoreFunctionBundleMetadata | null> {
    return this.#bundles.get(input.functionName) ?? null;
  }
}

class MemoryRoleGates {
  readonly #role: string | null;

  constructor(role: string | null) {
    this.#role = role;
  }

  async resolveRole(): Promise<string | null> {
    return this.#role;
  }
}

class MemorySecrets {
  readonly #values = new Map<string, string>();

  async setSecret(input: {
    projectId: string;
    name: string;
    value: string;
    scope?: "project" | "release" | "function";
    functionName?: string | null;
  }) {
    this.#values.set(input.name, input.value);
    return secretMetadata(input.projectId, input.name, input.scope ?? "project", input.functionName ?? null);
  }

  async listSecrets(input: { projectId: string }) {
    return [...this.#values.keys()].sort().map((name) => secretMetadata(input.projectId, name, "project", null));
  }

  async getSecretValues(input: { names: string[] }) {
    const out: Record<string, string> = {};
    for (const name of input.names) {
      const value = this.#values.get(name);
      if (value !== undefined) out[name] = value;
    }
    return out;
  }

  clear(): void {
    this.#values.clear();
  }
}

class MemoryFunctionLogs implements FunctionLogPort {
  readonly invocations: CoreFunctionInvocationRecord[] = [];
  readonly logs: CoreFunctionLogEntry[] = [];

  async recordInvocation(input: {
    invocation: CoreFunctionInvocationRecord;
    logs: CoreFunctionLogEntry[];
  }): Promise<void> {
    this.invocations.push(input.invocation);
    this.logs.push(...input.logs);
  }

  async listLogs(input: {
    projectId: string;
    functionName?: string;
    requestId?: string;
    since?: string;
    tail?: number;
  }): Promise<CoreFunctionLogEntry[]> {
    const sinceMs = input.since ? Date.parse(input.since) : null;
    const filtered = this.logs.filter((entry) =>
      entry.project_id === input.projectId &&
      (!input.functionName || entry.function_name === input.functionName) &&
      (!input.requestId || entry.request_id === input.requestId) &&
      (sinceMs === null || Date.parse(entry.timestamp) >= sinceMs)
    );
    const tail = Math.min(Math.max(input.tail ?? 100, 1), 1000);
    return filtered
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
      .slice(-tail);
  }
}

function secretMetadata(
  projectId: string,
  name: string,
  scope: "project" | "release" | "function",
  functionName: string | null,
) {
  return {
    project_id: projectId,
    name,
    scope,
    function_name: functionName,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
  };
}

interface MemoryFunctionExecutorOptions {
  logs?: (input: LocalFunctionExecutorInput) => CoreFunctionLogEntry[];
  error?: Error;
}

class MemoryFunctionExecutor {
  last: LocalFunctionExecutorInput | null = null;
  readonly #options: MemoryFunctionExecutorOptions;

  constructor(options: MemoryFunctionExecutorOptions = {}) {
    this.#options = options;
  }

  async invoke(input: LocalFunctionExecutorInput): Promise<LocalFunctionExecutorResult> {
    this.last = input;
    if (this.#options.error) throw this.#options.error;
    return {
      requestId: input.requestId,
      duration_ms: 1,
      logs: this.#options.logs?.(input) ?? [],
      response: {
        status: 201,
        headers: [
          ["content-type", "text/plain"],
          ["connection", "close"],
        ],
        cookies: ["a=1; Path=/", "b=2; Path=/"],
        body: {
          encoding: "base64" as const,
          data: Buffer.from("ok").toString("base64"),
          size: 2,
        },
      },
    };
  }
}

function functionBundle(sha256: string, size: number): CoreFunctionBundleMetadata {
  return {
    name: "api",
    runtime: "node22",
    entrypoint: "default",
    source: { sha256, size, contentType: "application/javascript" },
    bundle_sha256: sha256,
    bundle_size_bytes: size,
    dependency_mode: CORE_FUNCTION_DEPENDENCY_MODE,
    dependency_lock_digest: null,
    deps: [],
    required_secrets: [],
    timeout_ms: 10_000,
    memory_bytes: 128 * 1024 * 1024,
    require_auth: false,
    require_role: null,
    class: "standard",
    capabilities: [],
  };
}

async function createInboundReplyFixture(webhookUrl: string): Promise<{
  project: CoreProject;
  mailboxId: string;
  inboundMessageId: string;
  rawMime: string;
  mailboxes: MemoryMailboxStore;
  runtime: {
    projects: MemoryProjectCatalog;
    projectKeys: MemoryProjectCatalog;
    mailboxes: MemoryMailboxStore;
    emailProvider: MockEmailProvider;
    emailInboundProvider: MockEmailInboundProvider;
  };
}> {
  const catalog = new MemoryProjectCatalog();
  const project = await catalog.create({ name: "webhook delivery app" });
  const mailboxes = new MemoryMailboxStore();
  const runtime = {
    projects: catalog,
    projectKeys: catalog,
    mailboxes,
    emailProvider: new MockEmailProvider("example.com"),
    emailInboundProvider: new MockEmailInboundProvider({
      provider: "mock",
      inboundDomains: ["example.com"],
      ingestToken: "inbound-secret",
      maxRawBytes: 1024 * 1024,
    }),
  };

  const created = await coreGatewayResponse({
    method: "POST",
    pathname: "/mailboxes/v1",
    headers: { authorization: `Bearer ${project.service_key}` },
    body: { slug: "signing" },
  }, runtime);
  assert.equal(created.status, 201);
  const mailboxId = (created.body as { mailbox_id: string }).mailbox_id;

  const outbound = await coreGatewayResponse({
    method: "POST",
    pathname: `/mailboxes/v1/${mailboxId}/messages`,
    headers: { authorization: `Bearer ${project.service_key}` },
    body: {
      to: "signer@example.net",
      subject: "Signature requested",
      html: "<p>Please sign.</p>",
    },
  }, runtime);
  assert.equal(outbound.status, 201);

  const webhook = await coreGatewayResponse({
    method: "POST",
    pathname: `/mailboxes/v1/${mailboxId}/webhooks`,
    headers: { authorization: `Bearer ${project.service_key}` },
    body: { url: webhookUrl, events: ["reply_received"] },
  }, runtime);
  assert.equal(webhook.status, 201);

  const rawMime = [
    "From: Signer <signer@example.net>",
    "To: signing@example.com",
    "Subject: Re: Signature requested",
    "In-Reply-To: <mock_1>",
    "References: <mock_1>",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "I approve this signature.",
  ].join("\r\n");

  const ingested = await coreGatewayResponse({
    method: "POST",
    pathname: "/mailboxes/v1/inbound/ingestions",
    headers: { authorization: "Bearer inbound-secret" },
    body: {
      provider: "mock",
      ses_message_id: "ses_in_1",
      recipients: ["signing@example.com"],
      source: "signer@example.net",
      common_headers: { from: ["Signer <signer@example.net>"] },
      raw_mime: rawMime,
    },
  }, runtime);
  assert.equal(ingested.status, 202);

  const inboundList = await coreGatewayResponse({
    method: "GET",
    pathname: `/mailboxes/v1/${mailboxId}/messages?direction=inbound`,
    headers: { authorization: `Bearer ${project.service_key}` },
  }, runtime);
  assert.equal(inboundList.status, 200);
  const inboundMessageId = (inboundList.body as { messages: Array<{ message_id: string }> }).messages[0]?.message_id;
  assert.ok(inboundMessageId);

  return { project, mailboxId, inboundMessageId, rawMime, mailboxes, runtime };
}

function portableFunction(
  name: string,
  fnClass: "standard" | "ssr",
  capabilities: string[] = [],
): PortableReleaseState["functions"][number] {
  return {
    name,
    code_hash: `${name.padEnd(64, "0").slice(0, 64)}`,
    runtime: "node22",
    timeout_seconds: 10,
    memory_mb: 128,
    schedule: null,
    deps: [],
    require_auth: false,
    require_role: null,
    class: fnClass,
    capabilities,
  };
}

function userLog(
  input: LocalFunctionExecutorInput,
  stream: "stdout" | "stderr",
  message: string,
): CoreFunctionLogEntry {
  return {
    timestamp: new Date().toISOString(),
    request_id: input.requestId,
    project_id: input.projectId,
    release_id: input.releaseId,
    function_name: input.functionName,
    stream,
    level: stream === "stderr" ? "error" : "info",
    message,
    redacted: false,
  };
}

function jsonFromRaw(response: { body: unknown }): unknown {
  return JSON.parse(Buffer.from(response.body as Uint8Array).toString("utf8")) as unknown;
}

function jwtPayload(authorization: string): Record<string, unknown> {
  const token = authorization.replace(/^Bearer\s+/i, "");
  const payload = token.split(".")[1];
  assert.ok(payload);
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
}

class MemoryProjectCatalog implements ProjectCatalogPort {
  readonly createdNames: string[] = [];
  readonly projects = new Map<string, CoreProject>();

  async create(input: { name: string }): Promise<CoreProject> {
    this.createdNames.push(input.name);
    const project: CoreProject = {
      project_id: "prj_0000000000000001",
      schema_slot: "project_0000000000000001",
      public_id: "local_0000000000000001",
      anon_key: "anon_test",
      service_key: "service_test",
      endpoints: {
        rest_url: "http://127.0.0.1:4300",
        static_base_url: "http://127.0.0.1:4020/projects/v1/prj_0000000000000001/static",
        storage_base_url: "http://127.0.0.1:4020/projects/v1/prj_0000000000000001/storage",
      },
      active_release_id: null,
      capabilities: runtimeCapabilities("test"),
    };
    this.projects.set(project.project_id, project);
    return project;
  }

  async inspect(projectId: string): Promise<CoreProject | null> {
    return this.projects.get(projectId) ?? null;
  }

  async inspectByKey(key: string): Promise<CoreProject | null> {
    for (const project of this.projects.values()) {
      if (project.anon_key === key || project.service_key === key) return project;
    }
    return null;
  }
}

function makeProject(projectId: string, anonKey: string, serviceKey: string): CoreProject {
  return {
    project_id: projectId,
    schema_slot: projectId.replace(/^prj_/, "project_"),
    public_id: `local_${projectId.slice(-16)}`,
    anon_key: anonKey,
    service_key: serviceKey,
    endpoints: {
      rest_url: "http://127.0.0.1:4300",
      static_base_url: `http://127.0.0.1:4020/projects/v1/${projectId}/static`,
      storage_base_url: `http://127.0.0.1:4020/projects/v1/${projectId}/storage`,
    },
    active_release_id: null,
    capabilities: runtimeCapabilities("test"),
  };
}

class MemoryMailboxStore implements CoreMailboxStorePort {
  readonly mailboxes = new Map<string, CoreMailboxRecord>();
  readonly settings = new Map<string, CoreMailboxSettings>();
  readonly messages = new Map<string, CoreEmailMessageRecord>();
  readonly rawMessages = new Map<string, Buffer>();
  readonly webhooks = new Map<string, CoreMailboxWebhookRecord>();
  readonly deliveries = new Map<string, CoreWebhookDeliveryRecord>();
  readonly suppressions = new Map<string, CoreEmailSuppressionRecord>();

  async createMailbox(input: { projectId: string; slug: string }): Promise<CoreMailboxRecord> {
    if ([...this.mailboxes.values()].some((mailbox) => mailbox.slug === input.slug && mailbox.status !== "tombstoned")) {
      throw new Error("duplicate slug");
    }
    const mailbox: CoreMailboxRecord = {
      mailbox_id: `mbx_${String(this.mailboxes.size + 1).padStart(4, "0")}`,
      slug: input.slug,
      project_id: input.projectId,
      status: "active",
      footer_policy: "none",
      tombstoned_at: null,
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
    };
    this.mailboxes.set(mailbox.mailbox_id, mailbox);
    const activeForProject = [...this.mailboxes.values()].filter((entry) => entry.project_id === input.projectId && entry.status === "active");
    if (activeForProject.length === 1) {
      await this.updateSettings({ projectId: input.projectId, defaultOutboundMailboxId: mailbox.mailbox_id });
    }
    return mailbox;
  }

  async listMailboxes(projectId: string): Promise<CoreMailboxRecord[]> {
    return [...this.mailboxes.values()].filter((mailbox) => mailbox.project_id === projectId && mailbox.status !== "tombstoned");
  }

  async getMailbox(mailboxId: string): Promise<CoreMailboxRecord | null> {
    return this.mailboxes.get(mailboxId) ?? null;
  }

  async requireOwnedMailbox(projectId: string, mailboxId: string): Promise<CoreMailboxRecord> {
    const mailbox = this.mailboxes.get(mailboxId);
    if (!mailbox) throw new CoreMailboxError("Mailbox not found", 404, "mailbox_not_found");
    if (mailbox.project_id !== projectId) throw new CoreMailboxError("Mailbox owned by different project", 403, "mailbox_forbidden");
    return mailbox;
  }

  async updateMailbox(input: { projectId: string; mailboxId: string; footerPolicy?: "none" | "run402_transparency" }): Promise<CoreMailboxRecord> {
    const mailbox = await this.requireOwnedMailbox(input.projectId, input.mailboxId);
    const updated = { ...mailbox, ...(input.footerPolicy ? { footer_policy: input.footerPolicy } : {}) };
    this.mailboxes.set(input.mailboxId, updated);
    return updated;
  }

  async deleteMailbox(input: { projectId: string; mailboxId: string }): Promise<CoreMailboxRecord | null> {
    const mailbox = await this.requireOwnedMailbox(input.projectId, input.mailboxId);
    const updated: CoreMailboxRecord = { ...mailbox, status: "tombstoned", tombstoned_at: new Date().toISOString() };
    this.mailboxes.set(input.mailboxId, updated);
    return updated;
  }

  async getSettings(projectId: string): Promise<CoreMailboxSettings> {
    return this.settings.get(projectId) ?? { project_id: projectId, default_outbound_mailbox_id: null, updated_at: null };
  }

  async updateSettings(input: { projectId: string; defaultOutboundMailboxId: string | null }): Promise<CoreMailboxSettings> {
    if (input.defaultOutboundMailboxId !== null) {
      await this.requireOwnedMailbox(input.projectId, input.defaultOutboundMailboxId);
    }
    const settings: CoreMailboxSettings = {
      project_id: input.projectId,
      default_outbound_mailbox_id: input.defaultOutboundMailboxId,
      updated_at: new Date(0).toISOString(),
    };
    this.settings.set(input.projectId, settings);
    return settings;
  }

  async checkSuppression(input: { projectId: string; email: string }) {
    const email = input.email.trim().toLowerCase();
    const global = this.suppressions.get(`global::${email}`);
    if (global) return { suppressed: true, suppression: global };
    const project = this.suppressions.get(`project:${input.projectId}:${email}`);
    return project ? { suppressed: true, suppression: project } : { suppressed: false };
  }

  async addSuppression(input: { scope: "project" | "global"; projectId?: string | null; email: string; reason: "bounce" | "complaint" }): Promise<CoreEmailSuppressionRecord> {
    const email = input.email.trim().toLowerCase();
    const key = `${input.scope}:${input.scope === "project" ? input.projectId : ""}:${email}`;
    const current = this.suppressions.get(key);
    if (current) return current;
    const suppression: CoreEmailSuppressionRecord = {
      suppression_id: `sup_${String(this.suppressions.size + 1).padStart(4, "0")}`,
      email_address: email,
      scope: input.scope,
      project_id: input.scope === "project" ? input.projectId ?? null : null,
      reason: input.reason,
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
    };
    this.suppressions.set(key, suppression);
    return suppression;
  }

  async stageMessage(input: StageMessageInput): Promise<CoreEmailMessageRecord> {
    const message: CoreEmailMessageRecord = {
      message_id: `msg_${String(this.messages.size + 1).padStart(4, "0")}`,
      project_id: input.projectId,
      mailbox_id: input.mailboxId,
      direction: "outbound",
      from_address: input.fromAddress,
      to_address: input.to,
      subject: input.subject,
      body_text: input.bodyText,
      status: "pending",
      delivery_state: "pending_provider",
      provider: null,
      provider_message_id: null,
      attachments_meta: input.attachmentsMeta,
      raw_storage_provider: null,
      raw_ref: null,
      in_reply_to_message_id: null,
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
      sent_at: null,
      received_at: null,
    };
    this.messages.set(message.message_id, message);
    return message;
  }

  async markMessageSent(input: { messageId: string; provider: string; providerMessageId?: string | null }): Promise<CoreEmailMessageRecord> {
    const current = this.messages.get(input.messageId);
    assert.ok(current);
    const updated: CoreEmailMessageRecord = {
      ...current,
      status: "sent",
      delivery_state: "accepted",
      provider: input.provider,
      provider_message_id: input.providerMessageId ?? null,
      sent_at: new Date(0).toISOString(),
    };
    this.messages.set(input.messageId, updated);
    return updated;
  }

  async markMessageFailed(input: { messageId: string; provider?: string | null }): Promise<CoreEmailMessageRecord> {
    const current = this.messages.get(input.messageId);
    assert.ok(current);
    const updated: CoreEmailMessageRecord = {
      ...current,
      status: "failed",
      delivery_state: "failed",
      provider: input.provider ?? null,
    };
    this.messages.set(input.messageId, updated);
    return updated;
  }

  async applyDeliveryEvent(input: ApplyDeliveryEventInput): Promise<ApplyDeliveryEventResult> {
    const current = [...this.messages.values()].find((message) =>
      message.direction === "outbound" &&
      message.provider === input.provider &&
      message.provider_message_id === input.providerMessageId
    );
    if (!current) {
      return {
        matched: false,
        event_type: input.eventType,
        provider: input.provider,
        provider_message_id: input.providerMessageId,
      };
    }
    const status = input.eventType === "delivery" ? "delivered" : input.eventType;
    const message: CoreEmailMessageRecord = {
      ...current,
      status,
      delivery_state: status,
      updated_at: input.occurredAt ?? new Date(0).toISOString(),
    };
    this.messages.set(message.message_id, message);
    const recipient = (input.recipient ?? message.to_address).trim().toLowerCase();
    let suppression: CoreEmailSuppressionRecord | undefined;
    let mailbox_suspended = false;
    if (input.eventType === "bounced" && input.bounceType === "Permanent") {
      suppression = await this.addSuppression({ scope: "project", projectId: message.project_id, email: recipient, reason: "bounce" });
    }
    if (input.eventType === "complained") {
      suppression = await this.addSuppression({ scope: "global", email: recipient, reason: "complaint" });
      const mailbox = this.mailboxes.get(message.mailbox_id);
      if (mailbox?.status === "active") {
        this.mailboxes.set(message.mailbox_id, { ...mailbox, status: "suspended" });
        mailbox_suspended = true;
      }
    }
    const webhook_deliveries = await this.enqueueWebhookDelivery({
      projectId: message.project_id,
      mailboxId: message.mailbox_id,
      eventType: input.eventType,
      discriminator: input.providerMessageId,
      source: "core-email-events",
      payload: {
        mailbox_id: message.mailbox_id,
        message_id: message.message_id,
        to_address: recipient,
        provider: input.provider,
        provider_message_id: input.providerMessageId,
        ...(input.eventType === "bounced" ? { bounce_type: input.bounceType ?? null } : {}),
      },
    });
    return {
      matched: true,
      event_type: input.eventType,
      provider: input.provider,
      provider_message_id: input.providerMessageId,
      message,
      webhook_deliveries,
      ...(suppression ? { suppression } : {}),
      ...(mailbox_suspended ? { mailbox_suspended } : {}),
    };
  }

  async listMessages(input: { projectId: string; mailboxId: string }): Promise<CoreEmailMessageRecord[]> {
    await this.requireOwnedMailbox(input.projectId, input.mailboxId);
    return [...this.messages.values()].filter((message) =>
      message.project_id === input.projectId &&
      message.mailbox_id === input.mailboxId &&
      (!("direction" in input) || input.direction === undefined || message.direction === input.direction)
    );
  }

  async getMessage(input: { projectId: string; mailboxId: string; messageId: string }): Promise<CoreEmailMessageRecord | null> {
    await this.requireOwnedMailbox(input.projectId, input.mailboxId);
    return this.messages.get(input.messageId) ?? null;
  }

  async resolveMailboxByInboundAddress(input: { address: string; inboundDomains: string[] }): Promise<CoreMailboxRecord | null> {
    const normalized = input.address.trim().toLowerCase();
    const [slug, domain, extra] = normalized.split("@");
    if (!slug || !domain || extra || !input.inboundDomains.includes(domain)) return null;
    return [...this.mailboxes.values()].find((mailbox) => mailbox.slug === slug && mailbox.status !== "tombstoned") ?? null;
  }

  async findOutboundReplyCandidate(input: { mailboxId: string; senderCandidates: string[]; threadingCandidates: string[] }): Promise<CoreEmailMessageRecord | null> {
    const outbound = [...this.messages.values()].filter((message) => message.mailbox_id === input.mailboxId && message.direction === "outbound");
    const threaded = outbound.find((message) =>
      input.threadingCandidates.includes(message.provider_message_id ?? "") ||
      input.threadingCandidates.includes(message.message_id)
    );
    if (threaded) return threaded;
    const senders = new Set(input.senderCandidates.map((value) => value.toLowerCase()));
    return outbound.find((message) => senders.has(message.to_address.toLowerCase())) ?? null;
  }

  async storeInboundMessage(input: StoreInboundMessageInput): Promise<{ message: CoreEmailMessageRecord; created: boolean }> {
    const existing = [...this.messages.values()].find((message) =>
      message.direction === "inbound" &&
      message.mailbox_id === input.mailboxId &&
      message.provider === input.provider &&
      message.provider_message_id === input.providerMessageId &&
      message.to_address === input.toAddress
    );
    if (existing) return { message: existing, created: false };
    if (input.rawMime) this.rawMessages.set(input.rawRef, Buffer.from(input.rawMime));
    const message: CoreEmailMessageRecord = {
      message_id: `msg_${String(this.messages.size + 1).padStart(4, "0")}`,
      project_id: input.projectId,
      mailbox_id: input.mailboxId,
      direction: "inbound",
      from_address: input.fromAddress,
      to_address: input.toAddress,
      subject: input.subject,
      body_text: input.bodyText,
      status: "received",
      delivery_state: "received",
      provider: input.provider,
      provider_message_id: input.providerMessageId,
      attachments_meta: null,
      raw_storage_provider: input.rawStorageProvider,
      raw_ref: input.rawRef,
      in_reply_to_message_id: input.inReplyToMessageId,
      created_at: input.receivedAt,
      updated_at: input.receivedAt,
      sent_at: null,
      received_at: input.receivedAt,
    };
    this.messages.set(message.message_id, message);
    return { message, created: true };
  }

  async getInboundRawMessage(input: { projectId: string; mailboxId: string; messageId: string }): Promise<Buffer | null> {
    const message = await this.getMessage(input);
    if (!message?.raw_ref) return null;
    return this.rawMessages.get(message.raw_ref) ?? null;
  }

  async createWebhook(input: { projectId: string; mailboxId: string; url: string; events: string[] }): Promise<CoreMailboxWebhookRecord> {
    await this.requireOwnedMailbox(input.projectId, input.mailboxId);
    const webhook: CoreMailboxWebhookRecord = {
      webhook_id: `wh_${String(this.webhooks.size + 1).padStart(4, "0")}`,
      project_id: input.projectId,
      mailbox_id: input.mailboxId,
      url: input.url,
      events: input.events,
      status: "active",
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
    };
    this.webhooks.set(webhook.webhook_id, webhook);
    return webhook;
  }

  async listWebhooks(input: { projectId: string; mailboxId: string }): Promise<CoreMailboxWebhookRecord[]> {
    await this.requireOwnedMailbox(input.projectId, input.mailboxId);
    return [...this.webhooks.values()].filter((webhook) => webhook.project_id === input.projectId && webhook.mailbox_id === input.mailboxId && webhook.status === "active");
  }

  async getWebhook(input: { projectId: string; mailboxId: string; webhookId: string }): Promise<CoreMailboxWebhookRecord | null> {
    await this.requireOwnedMailbox(input.projectId, input.mailboxId);
    const webhook = this.webhooks.get(input.webhookId);
    return webhook?.project_id === input.projectId && webhook.mailbox_id === input.mailboxId && webhook.status === "active" ? webhook : null;
  }

  async updateWebhook(input: { projectId: string; mailboxId: string; webhookId: string; url?: string; events?: string[] }): Promise<CoreMailboxWebhookRecord> {
    const current = await this.getWebhook(input);
    if (!current) throw new CoreMailboxError("Webhook not found", 404, "webhook_not_found");
    const updated = { ...current, ...(input.url ? { url: input.url } : {}), ...(input.events ? { events: input.events } : {}) };
    this.webhooks.set(input.webhookId, updated);
    return updated;
  }

  async deleteWebhook(input: { projectId: string; mailboxId: string; webhookId: string }): Promise<CoreMailboxWebhookRecord | null> {
    const current = await this.getWebhook(input);
    if (!current) return null;
    const updated: CoreMailboxWebhookRecord = { ...current, status: "deleted" };
    this.webhooks.set(input.webhookId, updated);
    return updated;
  }

  async enqueueWebhookDelivery(input: EnqueueWebhookDeliveryInput): Promise<CoreWebhookDeliveryRecord[]> {
    const deliveries: CoreWebhookDeliveryRecord[] = [];
    const webhooks = await this.listWebhooks({ projectId: input.projectId, mailboxId: input.mailboxId });
    const source = input.source ?? "core-email-inbound";
    for (const webhook of webhooks.filter((entry) => entry.events.includes(input.eventType))) {
      const sourceEventId = `${webhook.webhook_id}:${input.eventType}:${input.discriminator}`;
      if ([...this.deliveries.values()].some((delivery) => delivery.source === source && delivery.source_event_id === sourceEventId)) continue;
      const delivery: CoreWebhookDeliveryRecord = {
        delivery_id: `whd_${String(this.deliveries.size + 1).padStart(4, "0")}`,
        source,
        source_event_id: sourceEventId,
        project_id: input.projectId,
        mailbox_id: input.mailboxId,
        webhook_id: webhook.webhook_id,
        event_type: input.eventType,
        target_url: webhook.url,
        payload: {
          id: `whd_${String(this.deliveries.size + 1).padStart(4, "0")}`,
          type: input.eventType,
          created_at: new Date(0).toISOString(),
          schema_version: "1",
          idempotency_key: sourceEventId,
          payload: input.payload,
        },
        status: "pending",
        attempts: 0,
        next_attempt_at: new Date(0).toISOString(),
        last_status: null,
        last_error: null,
        created_at: new Date(0).toISOString(),
        updated_at: new Date(0).toISOString(),
        delivered_at: null,
      };
      this.deliveries.set(delivery.delivery_id, delivery);
      deliveries.push(delivery);
    }
    return deliveries;
  }

  async listWebhookDeliveries(input: { projectId: string; mailboxId: string; status?: "pending" | "delivered" | "failed_permanent" }): Promise<CoreWebhookDeliveryRecord[]> {
    await this.requireOwnedMailbox(input.projectId, input.mailboxId);
    return [...this.deliveries.values()].filter((delivery) =>
      delivery.project_id === input.projectId &&
      delivery.mailbox_id === input.mailboxId &&
      (!input.status || delivery.status === input.status)
    );
  }

  async redriveWebhookDelivery(input: { projectId: string; mailboxId: string; deliveryId: string }): Promise<CoreWebhookDeliveryRecord> {
    await this.requireOwnedMailbox(input.projectId, input.mailboxId);
    const current = this.deliveries.get(input.deliveryId);
    if (!current || current.project_id !== input.projectId || current.mailbox_id !== input.mailboxId) {
      throw new CoreMailboxError("Webhook delivery not found", 404, "webhook_delivery_not_found");
    }
    if (current.status !== "failed_permanent") {
      throw new CoreMailboxError("Only failed_permanent deliveries can be redriven", 409, "webhook_delivery_not_failed");
    }
    const updated: CoreWebhookDeliveryRecord = { ...current, status: "pending", attempts: 0, next_attempt_at: new Date(0).toISOString() };
    this.deliveries.set(input.deliveryId, updated);
    return updated;
  }

  async claimDueWebhookDeliveries(input: { limit: number; leaseMs: number; now?: Date }): Promise<CoreWebhookDeliveryRecord[]> {
    const now = input.now ?? new Date();
    const claimed = [...this.deliveries.values()]
      .filter((delivery) => delivery.status === "pending" && Date.parse(delivery.next_attempt_at) <= now.getTime())
      .sort((a, b) => Date.parse(a.next_attempt_at) - Date.parse(b.next_attempt_at))
      .slice(0, input.limit)
      .map((delivery) => {
        const updated: CoreWebhookDeliveryRecord = {
          ...delivery,
          attempts: delivery.attempts + 1,
          next_attempt_at: new Date(now.getTime() + input.leaseMs).toISOString(),
          last_error: null,
          updated_at: now.toISOString(),
        };
        this.deliveries.set(delivery.delivery_id, updated);
        return updated;
      });
    return claimed;
  }

  async markWebhookDeliveryDelivered(input: { deliveryId: string; status: number; now?: Date }): Promise<CoreWebhookDeliveryRecord | null> {
    const current = this.deliveries.get(input.deliveryId);
    if (!current) return null;
    const now = input.now ?? new Date();
    const updated: CoreWebhookDeliveryRecord = {
      ...current,
      status: "delivered",
      last_status: input.status,
      last_error: null,
      delivered_at: now.toISOString(),
      updated_at: now.toISOString(),
    };
    this.deliveries.set(input.deliveryId, updated);
    return updated;
  }

  async markWebhookDeliveryFailed(input: {
    deliveryId: string;
    status: number | null;
    error: string;
    maxAttempts: number;
    retryDelayMs: number;
    now?: Date;
  }): Promise<CoreWebhookDeliveryRecord | null> {
    const current = this.deliveries.get(input.deliveryId);
    if (!current) return null;
    const now = input.now ?? new Date();
    const updated: CoreWebhookDeliveryRecord = {
      ...current,
      status: current.attempts >= input.maxAttempts ? "failed_permanent" : "pending",
      next_attempt_at: current.attempts >= input.maxAttempts
        ? current.next_attempt_at
        : new Date(now.getTime() + input.retryDelayMs).toISOString(),
      last_status: input.status,
      last_error: input.error,
      updated_at: now.toISOString(),
    };
    this.deliveries.set(input.deliveryId, updated);
    return updated;
  }
}

class MemoryProjectSql {
  last: { project: CoreProject; sql: string; params?: unknown[] } | null = null;

  async execute(input: {
    project: CoreProject;
    sql: string;
    params?: unknown[];
  }) {
    this.last = input;
    return {
      status: "ok" as const,
      schema: input.project.schema_slot,
      rows: [{ ok: true }],
      row_count: 1,
      fields: [{ name: "ok", type: "bool" }],
    };
  }
}

class MemoryRuntimePorts implements RuntimeKernelPorts {
  readonly projects: RuntimeKernelPorts["projects"];
  readonly releases: RuntimeKernelPorts["releases"];
  readonly plans: RuntimeKernelPorts["plans"];
  readonly content: RuntimeKernelPorts["content"];
  readonly migrations: RuntimeKernelPorts["migrations"];

  readonly #plans = new Map<string, StoredCoreApplyPlan>();
  readonly #releases = new Map<string, PortableReleaseState>();
  #activeReleaseId: string | null = null;

  constructor(projectId = "prj_0000000000000001") {
    const project: CoreProject = {
      project_id: projectId,
      schema_slot: "project_0000000000000001",
      public_id: "local_0000000000000001",
      anon_key: "anon_test",
      service_key: "service_test",
      endpoints: {
        rest_url: "http://127.0.0.1:4300",
        static_base_url: `http://127.0.0.1:4020/projects/v1/${projectId}/static`,
        storage_base_url: `http://127.0.0.1:4020/projects/v1/${projectId}/storage`,
      },
      active_release_id: this.#activeReleaseId,
      capabilities: runtimeCapabilities("test"),
    };
    this.projects = {
      create: async () => project,
      inspect: async (candidateProjectId) => candidateProjectId === project.project_id ? project : null,
    };
    this.releases = {
      getBase: async (_projectId, target) => {
        if (target === "empty") {
          return { release_id: null, state: emptyCoreReleaseState() };
        }
        const releaseId = typeof target === "string" ? this.#activeReleaseId : target.release_id;
        return {
          release_id: releaseId,
          state: releaseId ? this.#releases.get(releaseId) ?? emptyCoreReleaseState() : emptyCoreReleaseState(),
        };
      },
      setActiveRelease: async (input) => {
        if (this.#activeReleaseId !== input.expectedBaseReleaseId) {
          throw new ApplyInvariantError("stale_plan", "Apply plan base release no longer matches the active release.");
        }
        this.#releases.set(input.releaseId, input.release);
        this.#activeReleaseId = input.releaseId;
      },
    };
    this.plans = {
      create: async (input) => {
        const plan: StoredCoreApplyPlan = {
          ...input,
          plan_id: `plan_${this.#plans.size + 1}`,
          status: "planned",
          created_at: new Date(0).toISOString(),
        };
        this.#plans.set(plan.plan_id, plan);
        return plan;
      },
      get: async (planId) => this.#plans.get(planId) ?? null,
      markCommitted: async (planId) => {
        const plan = this.#plans.get(planId);
        if (!plan) return;
        this.#plans.set(planId, { ...plan, status: "committed" });
      },
    };
    this.content = {
      putStatic: async () => undefined,
      hasContent: async () => true,
      readStatic: async () => null,
    };
    this.migrations = {
      check: async () => ({ state: "absent" }),
      applyInline: async () => undefined,
    };
  }
}

class MemoryReleaseState {
  readonly #state: PortableReleaseState;

  constructor(state: PortableReleaseState) {
    this.#state = state;
  }

  async getBase(): Promise<{ release_id: string | null; state: PortableReleaseState }> {
    return { release_id: "rel_test", state: this.#state };
  }

  async setActiveRelease(): Promise<void> {
    throw new Error("not used");
  }
}

class MissingProjectReleaseState {
  async getBase(projectId: string): Promise<never> {
    throw new ApplyInvariantError("project_not_found", `Run402 Core project not found: ${projectId}`);
  }

  async setActiveRelease(): Promise<void> {
    throw new Error("not used");
  }
}

class MemoryContentStore {
  readonly cas = new Map<string, { bytes: Uint8Array; contentType: string }>();
  readonly uploads = new Map<string, Uint8Array>();

  async putStatic(input: { sha256: string; bytes: Uint8Array; contentType: string }): Promise<void> {
    this.cas.set(input.sha256, { bytes: input.bytes, contentType: input.contentType });
  }

  async hasContent(_projectId: string, sha256: string): Promise<boolean> {
    return this.cas.has(sha256);
  }

  async readStatic(_projectId: string, sha256: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    return this.cas.get(sha256) ?? null;
  }

  async readCas(sha256: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    return this.cas.get(sha256) ?? null;
  }

  async putUploadBytes(input: { projectId: string; uploadId: string; bytes: Uint8Array }): Promise<{ size_bytes: number }> {
    this.uploads.set(`${input.projectId}:${input.uploadId}`, input.bytes);
    return { size_bytes: input.bytes.byteLength };
  }

  async promoteUpload(input: {
    projectId: string;
    uploadId: string;
    ref: { sha256: string; size: number; contentType?: string };
  }): Promise<{ sha256: string; size_bytes: number; content_type: string }> {
    const key = `${input.projectId}:${input.uploadId}`;
    const bytes = this.uploads.get(key);
    if (!bytes) throw new Error("missing upload bytes");
    verifyContentRefBytes(input.ref, bytes);
    const contentType = input.ref.contentType ?? "application/octet-stream";
    this.cas.set(input.ref.sha256, { bytes, contentType });
    this.uploads.delete(key);
    return { sha256: input.ref.sha256, size_bytes: input.ref.size, content_type: contentType };
  }

  async deleteUploadBytes(input: { projectId: string; uploadId: string }): Promise<void> {
    this.uploads.delete(`${input.projectId}:${input.uploadId}`);
  }
}

class MemoryStoragePort implements StoragePort, SignedReadPort {
  readonly sessions = new Map<string, CoreUploadSession>();
  readonly objects = new Map<string, CoreStorageObject>();
  readonly versions = new Map<string, CoreStorageObject>();
  readonly #baseUrl: string;
  readonly #secret = "test-signed-read-secret";

  constructor(baseUrl: string) {
    this.#baseUrl = baseUrl;
  }

  async createUploadSession(input: {
    projectId: string;
    key: string;
    sizeBytes: number;
    sha256: string;
    contentType: string;
    visibility: StorageObjectVisibility;
    immutable: boolean;
  }): Promise<CoreUploadSession> {
    const upload_id = `upl_${String(this.sessions.size + 1).padStart(24, "0")}`;
    const session: CoreUploadSession = {
      upload_id,
      project_id: input.projectId,
      key: input.key,
      declared_size: input.sizeBytes,
      declared_sha256: input.sha256,
      content_type: input.contentType,
      visibility: input.visibility,
      immutable: input.immutable,
      status: "active",
      upload_url: `${this.#baseUrl}/projects/v1/${input.projectId}/storage/uploads/${upload_id}/bytes`,
      bytes_written: 0,
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      completed_at: null,
      aborted_at: null,
      created_at: new Date(0).toISOString(),
    };
    this.sessions.set(upload_id, session);
    return session;
  }

  async getUploadSession(input: { uploadId: string }): Promise<CoreUploadSession | null> {
    return this.sessions.get(input.uploadId) ?? null;
  }

  async markUploadBytesStored(input: { uploadId: string; sizeBytes: number }): Promise<CoreUploadSession> {
    const session = this.sessions.get(input.uploadId);
    assert.ok(session);
    const updated: CoreUploadSession = { ...session, status: "uploaded", bytes_written: input.sizeBytes };
    this.sessions.set(input.uploadId, updated);
    return updated;
  }

  async completeUploadSession(input: { uploadId: string }): Promise<CoreStorageObject> {
    const session = this.sessions.get(input.uploadId);
    assert.ok(session);
    const now = new Date().toISOString();
    const object: CoreStorageObject = {
      project_id: session.project_id,
      key: session.key,
      sha256: session.declared_sha256,
      size_bytes: session.declared_size,
      content_type: session.content_type,
      visibility: session.visibility,
      immutable: session.immutable,
      created_at: this.objects.get(this.#objectKey(session.project_id, session.key))?.created_at ?? now,
      updated_at: now,
      ...(session.visibility === "public" ? {
        public_url: `${this.#baseUrl}/projects/v1/${session.project_id}/storage/public/${session.key}`,
        ...(session.immutable ? {
          immutable_url: `${this.#baseUrl}/projects/v1/${session.project_id}/storage/immutable/${session.declared_sha256}/${session.key}`,
        } : {}),
      } : {}),
    };
    this.objects.set(this.#objectKey(session.project_id, session.key), object);
    if (session.immutable) {
      this.versions.set(this.#versionKey(session.project_id, session.key, session.declared_sha256), object);
    }
    this.sessions.set(session.upload_id, { ...session, status: "completed", completed_at: now });
    return object;
  }

  async abortUploadSession(input: { uploadId: string }): Promise<CoreUploadSession> {
    const session = this.sessions.get(input.uploadId);
    assert.ok(session);
    const updated: CoreUploadSession = { ...session, status: "aborted", aborted_at: new Date().toISOString() };
    this.sessions.set(input.uploadId, updated);
    return updated;
  }

  async getObject(input: { projectId: string; key: string }): Promise<CoreStorageObject | null> {
    return this.objects.get(this.#objectKey(input.projectId, input.key)) ?? null;
  }

  async listObjects(input: { projectId: string; prefix?: string; limit?: number; cursor?: string }) {
    const sorted = [...this.objects.values()]
      .filter((object) => object.project_id === input.projectId)
      .filter((object) => !input.prefix || object.key.startsWith(input.prefix))
      .filter((object) => !input.cursor || object.key > input.cursor)
      .sort((a, b) => a.key.localeCompare(b.key));
    const limit = input.limit ?? 100;
    return {
      objects: sorted.slice(0, limit),
      next_cursor: sorted.length > limit ? sorted[limit - 1]!.key : null,
    };
  }

  async deleteObject(input: { projectId: string; key: string }): Promise<boolean> {
    return this.objects.delete(this.#objectKey(input.projectId, input.key));
  }

  async getImmutableVersion(input: { projectId: string; key: string; sha256: string }) {
    const object = this.versions.get(this.#versionKey(input.projectId, input.key, input.sha256));
    if (!object) return null;
    return {
      ...object,
      version_id: `ver_${input.sha256.slice(0, 24)}`,
      public_url_key: `${input.sha256}/${input.key}`,
      retained_until: null,
    };
  }

  async signRead(input: { projectId: string; key: string; ttlSeconds?: number; sha256?: string | null }) {
    const expires = Math.floor(Date.now() / 1000) + (input.ttlSeconds ?? 900);
    const signature = createStorageReadSignature({
      secret: this.#secret,
      projectId: input.projectId,
      key: input.key,
      expiresAtEpochSeconds: expires,
      sha256: input.sha256 ?? null,
    });
    return {
      expires_at: new Date(expires * 1000).toISOString(),
      signed_url: `${this.#baseUrl}/projects/v1/${input.projectId}/storage/signed/${input.key}?expires=${expires}&signature=${signature}`,
    };
  }

  async verifyRead(input: {
    projectId: string;
    key: string;
    expiresAtEpochSeconds: number;
    signature: string;
    sha256?: string | null;
  }) {
    return verifyStorageReadSignature({
      secret: this.#secret,
      ...input,
    });
  }

  async sweep() {
    const retained = new Set<string>();
    for (const object of this.objects.values()) retained.add(object.sha256);
    for (const object of this.versions.values()) retained.add(object.sha256);
    return {
      removed_uploads: 0,
      removed_objects: 0,
      removed_versions: 0,
      removed_cas_objects: 0,
      retained_live_sha256: [...retained].sort(),
    };
  }

  #objectKey(projectId: string, key: string): string {
    return `${projectId}:${key}`;
  }

  #versionKey(projectId: string, key: string, sha256: string): string {
    return `${projectId}:${key}:${sha256}`;
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
