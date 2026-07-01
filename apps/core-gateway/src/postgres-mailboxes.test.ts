import assert from "node:assert/strict";
import test from "node:test";
import { PostgresCoreMailboxStore } from "./postgres-mailboxes.js";
import type { CoreFunctionRunStorePort } from "./function-runs.js";

test("postgres mailbox bootstrap includes inbound message and webhook schema", async () => {
  const queries: string[] = [];
  const store = new PostgresCoreMailboxStore({
    query: async (sql: string) => {
      queries.push(sql);
      return { rows: [] };
    },
  } as never);

  await store.bootstrap();
  const sql = queries.join("\n");

  assert.match(sql, /direction text NOT NULL DEFAULT 'outbound'/);
  assert.match(sql, /'delivered', 'bounced', 'complained'/);
  assert.match(sql, /received_at timestamptz/);
  assert.match(sql, /core_email_messages_inbound_provider_unique/);
  assert.match(sql, /core_email_inbound_raw_messages/);
  assert.match(sql, /core_email_suppressions/);
  assert.match(sql, /core_email_suppressions_unique/);
  assert.match(sql, /core_mailbox_webhooks/);
  assert.match(sql, /core_webhook_deliveries/);
});

test("postgres mailbox store enqueues function runs for matching email triggers", async () => {
  const queries: Array<{ text: string; params?: unknown[] }> = [];
  const creates: Array<Parameters<CoreFunctionRunStorePort["createRun"]>[0]> = [];
  const functionRuns = {
    createRun: async (input: Parameters<CoreFunctionRunStorePort["createRun"]>[0]) => {
      creates.push(input);
      return { httpStatus: 202, run: { run_id: "fnrun_1" } };
    },
  } as unknown as CoreFunctionRunStorePort;
  const store = new PostgresCoreMailboxStore({
    query: async (sql: string, params?: unknown[]) => {
      queries.push({ text: sql, params });
      if (sql.includes("FROM internal.core_mailboxes") && sql.includes("WHERE mailbox_id = $1")) {
        return {
          rows: [{
            mailbox_id: "mbx_1",
            slug: "signing-inbox",
            project_id: "prj_1",
            status: "active",
            footer_policy: "none",
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:00.000Z",
            tombstoned_at: null,
          }],
        };
      }
      if (sql.includes("FROM internal.core_mailbox_webhooks")) {
        return { rows: [] };
      }
      if (sql.includes("internal.core_function_bundles")) {
        return {
          rows: [{
            project_id: "prj_1",
            release_id: "rel_1",
            name: "email_worker",
            trigger_id: "mail-events",
            run: {
              event_type: "email.event",
              payload: { configured: true },
              retry: { preset: "standard", max_attempts: 3 },
              expires_after_seconds: 300,
            },
          }],
        };
      }
      return { rows: [] };
    },
  } as never, { functionRuns });

  const deliveries = await store.enqueueWebhookDelivery({
    projectId: "prj_1",
    mailboxId: "mbx_1",
    eventType: "reply_received",
    discriminator: "ses_msg_1",
    payload: { mailbox_id: "mbx_1", message_id: "msg_1" },
  });

  assert.deepEqual(deliveries, []);
  assert.equal(creates.length, 1);
  assert.equal(creates[0]?.projectId, "prj_1");
  assert.equal(creates[0]?.functionName, "email_worker");
  assert.equal(creates[0]?.body.event_type, "email.event");
  assert.equal(creates[0]?.body.idempotency_key, "email:prj_1:email_worker:rel_1:mail-events:reply_received:ses_msg_1");
  assert.deepEqual(creates[0]?.body.payload, {
    configured: true,
    event: { mailbox_id: "mbx_1", message_id: "msg_1" },
  });
  assert.deepEqual(creates[0]?.body.retry, { preset: "standard", max_attempts: 3 });
  assert.ok(creates[0]?.body.expires_at);
  assert.deepEqual(creates[0]?.source, {
    type: "email",
    trigger_id: "mail-events",
    release_id: "rel_1",
    mailbox_id: "mbx_1",
    event_type: "reply_received",
    discriminator: "ses_msg_1",
  });
  assert.ok(queries.some((query) => query.text.includes("jsonb_array_elements") && query.params?.[2] === "reply_received"));
});
