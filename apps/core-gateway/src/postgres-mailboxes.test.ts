import assert from "node:assert/strict";
import test from "node:test";
import { PostgresCoreMailboxStore } from "./postgres-mailboxes.js";

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
  assert.match(sql, /received_at timestamptz/);
  assert.match(sql, /core_email_messages_inbound_provider_unique/);
  assert.match(sql, /core_email_inbound_raw_messages/);
  assert.match(sql, /core_mailbox_webhooks/);
  assert.match(sql, /core_webhook_deliveries/);
});
