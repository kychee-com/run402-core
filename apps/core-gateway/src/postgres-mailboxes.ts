import { randomBytes } from "node:crypto";
import type { Pool as PgPool } from "pg";
import type { EmailInboundProviderReadiness, EmailInboundRawStorageProvider } from "./email-inbound.js";
import type { EmailProviderReadiness } from "./email-provider.js";
import { mailboxAddress } from "./email-validation.js";

export type CoreMailboxStatus = "active" | "suspended" | "tombstoned";
export type CoreMessageDirection = "outbound" | "inbound";
export type CoreMessageStatus = "pending" | "sent" | "failed" | "received";
export type CoreDeliveryState = "pending_provider" | "accepted" | "failed" | "received";
export type CoreWebhookDeliveryStatus = "pending" | "delivered" | "failed_permanent";

export interface CoreMailboxRecord {
  mailbox_id: string;
  slug: string;
  project_id: string;
  status: CoreMailboxStatus;
  footer_policy: "none" | "run402_transparency";
  created_at: string;
  updated_at: string;
  tombstoned_at: string | null;
}

export interface CoreMailboxSettings {
  project_id: string;
  default_outbound_mailbox_id: string | null;
  updated_at: string | null;
}

export interface CoreEmailMessageRecord {
  message_id: string;
  project_id: string;
  mailbox_id: string;
  direction: CoreMessageDirection;
  from_address: string;
  to_address: string;
  subject: string;
  body_text: string;
  status: CoreMessageStatus;
  delivery_state: CoreDeliveryState;
  provider: string | null;
  provider_message_id: string | null;
  attachments_meta: Array<{ filename: string; content_type: string; size_bytes: number }> | null;
  raw_storage_provider: EmailInboundRawStorageProvider | null;
  raw_ref: string | null;
  in_reply_to_message_id: string | null;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
  received_at: string | null;
}

export interface CoreMailboxWebhookRecord {
  webhook_id: string;
  project_id: string;
  mailbox_id: string;
  url: string;
  events: string[];
  status: "active" | "deleted";
  created_at: string;
  updated_at: string;
}

export interface CoreWebhookDeliveryRecord {
  delivery_id: string;
  source: string;
  source_event_id: string;
  project_id: string;
  mailbox_id: string;
  webhook_id: string;
  event_type: string;
  target_url: string;
  payload: unknown;
  status: CoreWebhookDeliveryStatus;
  attempts: number;
  next_attempt_at: string;
  last_status: number | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  delivered_at: string | null;
}

export interface CoreMailboxResponse extends CoreMailboxRecord {
  address: string;
  is_default_outbound: boolean;
  can_send: boolean;
  send_blocked_reason: string | null;
  provider_readiness: EmailProviderReadiness;
  can_receive: boolean;
  receive_blocked_reason: string | null;
  inbound_provider_readiness: EmailInboundProviderReadiness;
}

export interface CoreMailboxStorePort {
  createMailbox(input: { projectId: string; slug: string }): Promise<CoreMailboxRecord>;
  listMailboxes(projectId: string): Promise<CoreMailboxRecord[]>;
  getMailbox(mailboxId: string): Promise<CoreMailboxRecord | null>;
  requireOwnedMailbox(projectId: string, mailboxId: string): Promise<CoreMailboxRecord>;
  deleteMailbox(input: { projectId: string; mailboxId: string }): Promise<CoreMailboxRecord | null>;
  updateMailbox(input: { projectId: string; mailboxId: string; footerPolicy?: "none" | "run402_transparency" }): Promise<CoreMailboxRecord>;
  getSettings(projectId: string): Promise<CoreMailboxSettings>;
  updateSettings(input: { projectId: string; defaultOutboundMailboxId: string | null }): Promise<CoreMailboxSettings>;
  stageMessage(input: StageMessageInput): Promise<CoreEmailMessageRecord>;
  markMessageSent(input: { messageId: string; provider: string; providerMessageId?: string | null }): Promise<CoreEmailMessageRecord>;
  markMessageFailed(input: { messageId: string; provider?: string | null; reason: string }): Promise<CoreEmailMessageRecord>;
  listMessages(input: { projectId: string; mailboxId: string; direction?: CoreMessageDirection }): Promise<CoreEmailMessageRecord[]>;
  getMessage(input: { projectId: string; mailboxId: string; messageId: string }): Promise<CoreEmailMessageRecord | null>;
  resolveMailboxByInboundAddress(input: { address: string; inboundDomains: string[] }): Promise<CoreMailboxRecord | null>;
  findOutboundReplyCandidate(input: { mailboxId: string; senderCandidates: string[]; threadingCandidates: string[] }): Promise<CoreEmailMessageRecord | null>;
  storeInboundMessage(input: StoreInboundMessageInput): Promise<{ message: CoreEmailMessageRecord; created: boolean }>;
  getInboundRawMessage(input: { projectId: string; mailboxId: string; messageId: string }): Promise<Buffer | null>;
  createWebhook(input: { projectId: string; mailboxId: string; url: string; events: string[] }): Promise<CoreMailboxWebhookRecord>;
  listWebhooks(input: { projectId: string; mailboxId: string }): Promise<CoreMailboxWebhookRecord[]>;
  getWebhook(input: { projectId: string; mailboxId: string; webhookId: string }): Promise<CoreMailboxWebhookRecord | null>;
  updateWebhook(input: { projectId: string; mailboxId: string; webhookId: string; url?: string; events?: string[] }): Promise<CoreMailboxWebhookRecord>;
  deleteWebhook(input: { projectId: string; mailboxId: string; webhookId: string }): Promise<CoreMailboxWebhookRecord | null>;
  enqueueWebhookDelivery(input: EnqueueWebhookDeliveryInput): Promise<CoreWebhookDeliveryRecord[]>;
  listWebhookDeliveries(input: { projectId: string; mailboxId: string; status?: CoreWebhookDeliveryStatus }): Promise<CoreWebhookDeliveryRecord[]>;
  redriveWebhookDelivery(input: { projectId: string; mailboxId: string; deliveryId: string }): Promise<CoreWebhookDeliveryRecord>;
  claimDueWebhookDeliveries(input: { limit: number; leaseMs: number; now?: Date }): Promise<CoreWebhookDeliveryRecord[]>;
  markWebhookDeliveryDelivered(input: { deliveryId: string; status: number; now?: Date }): Promise<CoreWebhookDeliveryRecord | null>;
  markWebhookDeliveryFailed(input: { deliveryId: string; status: number | null; error: string; maxAttempts: number; retryDelayMs: number; now?: Date }): Promise<CoreWebhookDeliveryRecord | null>;
}

export interface StageMessageInput {
  projectId: string;
  mailboxId: string;
  fromAddress: string;
  to: string;
  subject: string;
  bodyText: string;
  attachmentsMeta: Array<{ filename: string; content_type: string; size_bytes: number }> | null;
}

export interface StoreInboundMessageInput {
  projectId: string;
  mailboxId: string;
  fromAddress: string;
  toAddress: string;
  subject: string;
  bodyText: string;
  provider: string;
  providerMessageId: string;
  rawStorageProvider: EmailInboundRawStorageProvider;
  rawRef: string;
  rawMime: Buffer | null;
  inReplyToMessageId: string | null;
  receivedAt: string;
}

export interface EnqueueWebhookDeliveryInput {
  projectId: string;
  mailboxId: string;
  eventType: "reply_received";
  discriminator: string;
  payload: Record<string, unknown>;
}

export class CoreMailboxError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = "CoreMailboxError";
  }
}

export class PostgresCoreMailboxStore implements CoreMailboxStorePort {
  readonly #pool: PgPool;

  constructor(pool: PgPool) {
    this.#pool = pool;
  }

  async bootstrap(): Promise<void> {
    await this.#pool.query(`
      CREATE TABLE IF NOT EXISTS internal.core_mailboxes (
        mailbox_id text PRIMARY KEY,
        slug text NOT NULL UNIQUE,
        project_id text NOT NULL REFERENCES internal.core_projects(project_id) ON DELETE CASCADE,
        status text NOT NULL DEFAULT 'active',
        footer_policy text NOT NULL DEFAULT 'none',
        tombstoned_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT core_mailboxes_status_check CHECK (status IN ('active', 'suspended', 'tombstoned')),
        CONSTRAINT core_mailboxes_footer_policy_check CHECK (footer_policy IN ('none', 'run402_transparency'))
      );

      CREATE INDEX IF NOT EXISTS core_mailboxes_project_idx
        ON internal.core_mailboxes(project_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS internal.core_project_mailbox_settings (
        project_id text PRIMARY KEY REFERENCES internal.core_projects(project_id) ON DELETE CASCADE,
        default_outbound_mailbox_id text REFERENCES internal.core_mailboxes(mailbox_id),
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS internal.core_email_messages (
        message_id text PRIMARY KEY,
        project_id text NOT NULL REFERENCES internal.core_projects(project_id) ON DELETE CASCADE,
        mailbox_id text NOT NULL REFERENCES internal.core_mailboxes(mailbox_id),
        direction text NOT NULL DEFAULT 'outbound',
        from_address text NOT NULL,
        to_address text NOT NULL,
        subject text NOT NULL,
        body_text text NOT NULL,
        status text NOT NULL,
        delivery_state text NOT NULL,
        provider text,
        provider_message_id text,
        attachments_meta jsonb,
        raw_storage_provider text,
        raw_ref text,
        in_reply_to_message_id text,
        failure_reason text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        sent_at timestamptz,
        received_at timestamptz,
        CONSTRAINT core_email_messages_direction_check CHECK (direction IN ('outbound', 'inbound')),
        CONSTRAINT core_email_messages_status_check CHECK (status IN ('pending', 'sent', 'failed', 'received')),
        CONSTRAINT core_email_messages_delivery_state_check CHECK (delivery_state IN ('pending_provider', 'accepted', 'failed', 'received')),
        CONSTRAINT core_email_messages_raw_storage_check CHECK (raw_storage_provider IS NULL OR raw_storage_provider IN ('inline', 's3'))
      );

      ALTER TABLE internal.core_email_messages
        ADD COLUMN IF NOT EXISTS direction text NOT NULL DEFAULT 'outbound',
        ADD COLUMN IF NOT EXISTS raw_storage_provider text,
        ADD COLUMN IF NOT EXISTS raw_ref text,
        ADD COLUMN IF NOT EXISTS in_reply_to_message_id text,
        ADD COLUMN IF NOT EXISTS received_at timestamptz;

      ALTER TABLE internal.core_email_messages
        DROP CONSTRAINT IF EXISTS core_email_messages_direction_check,
        DROP CONSTRAINT IF EXISTS core_email_messages_status_check,
        DROP CONSTRAINT IF EXISTS core_email_messages_delivery_state_check,
        DROP CONSTRAINT IF EXISTS core_email_messages_raw_storage_check;

      ALTER TABLE internal.core_email_messages
        ADD CONSTRAINT core_email_messages_direction_check CHECK (direction IN ('outbound', 'inbound')),
        ADD CONSTRAINT core_email_messages_status_check CHECK (status IN ('pending', 'sent', 'failed', 'received')),
        ADD CONSTRAINT core_email_messages_delivery_state_check CHECK (delivery_state IN ('pending_provider', 'accepted', 'failed', 'received')),
        ADD CONSTRAINT core_email_messages_raw_storage_check CHECK (raw_storage_provider IS NULL OR raw_storage_provider IN ('inline', 's3'));

      CREATE INDEX IF NOT EXISTS core_email_messages_mailbox_idx
        ON internal.core_email_messages(project_id, mailbox_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS core_email_messages_direction_idx
        ON internal.core_email_messages(project_id, mailbox_id, direction, created_at DESC);

      CREATE UNIQUE INDEX IF NOT EXISTS core_email_messages_inbound_provider_unique
        ON internal.core_email_messages(mailbox_id, provider, provider_message_id, to_address)
        WHERE direction = 'inbound' AND provider IS NOT NULL AND provider_message_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS internal.core_email_inbound_raw_messages (
        raw_ref text PRIMARY KEY,
        raw_mime bytea NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS internal.core_mailbox_webhooks (
        webhook_id text PRIMARY KEY,
        project_id text NOT NULL REFERENCES internal.core_projects(project_id) ON DELETE CASCADE,
        mailbox_id text NOT NULL REFERENCES internal.core_mailboxes(mailbox_id),
        url text NOT NULL,
        events jsonb NOT NULL,
        status text NOT NULL DEFAULT 'active',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT core_mailbox_webhooks_status_check CHECK (status IN ('active', 'deleted'))
      );

      CREATE INDEX IF NOT EXISTS core_mailbox_webhooks_mailbox_idx
        ON internal.core_mailbox_webhooks(project_id, mailbox_id, created_at DESC)
        WHERE status = 'active';

      CREATE TABLE IF NOT EXISTS internal.core_webhook_deliveries (
        delivery_id text PRIMARY KEY,
        source text NOT NULL,
        source_event_id text NOT NULL,
        project_id text NOT NULL REFERENCES internal.core_projects(project_id) ON DELETE CASCADE,
        mailbox_id text NOT NULL REFERENCES internal.core_mailboxes(mailbox_id),
        webhook_id text NOT NULL REFERENCES internal.core_mailbox_webhooks(webhook_id),
        event_type text NOT NULL,
        target_url text NOT NULL,
        payload jsonb NOT NULL,
        status text NOT NULL DEFAULT 'pending',
        attempts integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz NOT NULL DEFAULT now(),
        last_status integer,
        last_error text,
        delivered_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT core_webhook_deliveries_status_check CHECK (status IN ('pending', 'delivered', 'failed_permanent'))
      );

      CREATE UNIQUE INDEX IF NOT EXISTS core_webhook_deliveries_source_unique
        ON internal.core_webhook_deliveries(source, source_event_id);

      CREATE INDEX IF NOT EXISTS core_webhook_deliveries_mailbox_idx
        ON internal.core_webhook_deliveries(project_id, mailbox_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS core_webhook_deliveries_due_idx
        ON internal.core_webhook_deliveries(next_attempt_at, created_at)
        WHERE status = 'pending';
    `);
  }

  async createMailbox(input: { projectId: string; slug: string }): Promise<CoreMailboxRecord> {
    const activeCount = await this.#pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM internal.core_mailboxes WHERE project_id = $1 AND status = 'active'",
      [input.projectId],
    );
    if (Number(activeCount.rows[0]?.count ?? "0") >= 5) {
      throw new CoreMailboxError("Project mailbox limit reached (5)", 409, "mailbox_limit_reached");
    }

    const mailboxId = `mbx_${randomToken(16)}`;
    try {
      const result = await this.#pool.query<MailboxRow>(
        `
          INSERT INTO internal.core_mailboxes (mailbox_id, slug, project_id)
          VALUES ($1, $2, $3)
          RETURNING mailbox_id, slug, project_id, status, footer_policy, created_at, updated_at, tombstoned_at
        `,
        [mailboxId, input.slug, input.projectId],
      );
      if (Number(activeCount.rows[0]?.count ?? "0") === 0) {
        await this.updateSettings({ projectId: input.projectId, defaultOutboundMailboxId: mailboxId });
      }
      return mailboxFromRow(result.rows[0]);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new CoreMailboxError("Slug already in use", 409, "slug_already_in_use");
      }
      throw error;
    }
  }

  async listMailboxes(projectId: string): Promise<CoreMailboxRecord[]> {
    const result = await this.#pool.query<MailboxRow>(
      `
        SELECT mailbox_id, slug, project_id, status, footer_policy, created_at, updated_at, tombstoned_at
        FROM internal.core_mailboxes
        WHERE project_id = $1 AND status <> 'tombstoned'
        ORDER BY created_at DESC
      `,
      [projectId],
    );
    return result.rows.map(mailboxFromRow);
  }

  async getMailbox(mailboxId: string): Promise<CoreMailboxRecord | null> {
    const result = await this.#pool.query<MailboxRow>(
      `
        SELECT mailbox_id, slug, project_id, status, footer_policy, created_at, updated_at, tombstoned_at
        FROM internal.core_mailboxes
        WHERE mailbox_id = $1
      `,
      [mailboxId],
    );
    return result.rows[0] ? mailboxFromRow(result.rows[0]) : null;
  }

  async updateMailbox(input: { projectId: string; mailboxId: string; footerPolicy?: "none" | "run402_transparency" }): Promise<CoreMailboxRecord> {
    const mailbox = await this.requireOwnedMailbox(input.projectId, input.mailboxId);
    if (input.footerPolicy === undefined) return mailbox;
    const result = await this.#pool.query<MailboxRow>(
      `
        UPDATE internal.core_mailboxes
           SET footer_policy = $3, updated_at = now()
         WHERE project_id = $1 AND mailbox_id = $2
         RETURNING mailbox_id, slug, project_id, status, footer_policy, created_at, updated_at, tombstoned_at
      `,
      [input.projectId, input.mailboxId, input.footerPolicy],
    );
    return mailboxFromRow(result.rows[0]);
  }

  async deleteMailbox(input: { projectId: string; mailboxId: string }): Promise<CoreMailboxRecord | null> {
    await this.requireOwnedMailbox(input.projectId, input.mailboxId);
    const result = await this.#pool.query<MailboxRow>(
      `
        UPDATE internal.core_mailboxes
           SET status = 'tombstoned', tombstoned_at = now(), updated_at = now()
         WHERE project_id = $1 AND mailbox_id = $2
         RETURNING mailbox_id, slug, project_id, status, footer_policy, created_at, updated_at, tombstoned_at
      `,
      [input.projectId, input.mailboxId],
    );
    await this.#pool.query(
      `
        UPDATE internal.core_project_mailbox_settings
           SET default_outbound_mailbox_id = NULL, updated_at = now()
         WHERE project_id = $1 AND default_outbound_mailbox_id = $2
      `,
      [input.projectId, input.mailboxId],
    );
    return result.rows[0] ? mailboxFromRow(result.rows[0]) : null;
  }

  async getSettings(projectId: string): Promise<CoreMailboxSettings> {
    const result = await this.#pool.query<SettingsRow>(
      `
        SELECT project_id, default_outbound_mailbox_id, updated_at
        FROM internal.core_project_mailbox_settings
        WHERE project_id = $1
      `,
      [projectId],
    );
    return result.rows[0]
      ? settingsFromRow(result.rows[0])
      : { project_id: projectId, default_outbound_mailbox_id: null, updated_at: null };
  }

  async updateSettings(input: { projectId: string; defaultOutboundMailboxId: string | null }): Promise<CoreMailboxSettings> {
    if (input.defaultOutboundMailboxId !== null) {
      const mailbox = await this.requireOwnedMailbox(input.projectId, input.defaultOutboundMailboxId);
      if (mailbox.status !== "active") {
        throw new CoreMailboxError("Mailbox cannot be used as a default because it is not active", 409, "default_mailbox_invalid");
      }
    }
    const result = await this.#pool.query<SettingsRow>(
      `
        INSERT INTO internal.core_project_mailbox_settings (project_id, default_outbound_mailbox_id, updated_at)
        VALUES ($1, $2, now())
        ON CONFLICT (project_id) DO UPDATE
          SET default_outbound_mailbox_id = EXCLUDED.default_outbound_mailbox_id,
              updated_at = now()
        RETURNING project_id, default_outbound_mailbox_id, updated_at
      `,
      [input.projectId, input.defaultOutboundMailboxId],
    );
    return settingsFromRow(result.rows[0]);
  }

  async stageMessage(input: StageMessageInput): Promise<CoreEmailMessageRecord> {
    const messageId = `msg_${Date.now()}_${randomToken(8)}`;
    const result = await this.#pool.query<MessageRow>(
      `
        INSERT INTO internal.core_email_messages (
          message_id, project_id, mailbox_id, from_address, to_address, subject,
          body_text, status, delivery_state, attachments_meta
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', 'pending_provider', $8::jsonb)
        RETURNING *
      `,
      [
        messageId,
        input.projectId,
        input.mailboxId,
        input.fromAddress,
        input.to,
        input.subject,
        input.bodyText,
        input.attachmentsMeta ? JSON.stringify(input.attachmentsMeta) : null,
      ],
    );
    return messageFromRow(result.rows[0]);
  }

  async markMessageSent(input: { messageId: string; provider: string; providerMessageId?: string | null }): Promise<CoreEmailMessageRecord> {
    const result = await this.#pool.query<MessageRow>(
      `
        UPDATE internal.core_email_messages
           SET status = 'sent',
               delivery_state = 'accepted',
               provider = $2,
               provider_message_id = $3,
               sent_at = now(),
               updated_at = now()
         WHERE message_id = $1
         RETURNING *
      `,
      [input.messageId, input.provider, input.providerMessageId ?? null],
    );
    return messageFromRow(result.rows[0]);
  }

  async markMessageFailed(input: { messageId: string; provider?: string | null; reason: string }): Promise<CoreEmailMessageRecord> {
    const result = await this.#pool.query<MessageRow>(
      `
        UPDATE internal.core_email_messages
           SET status = 'failed',
               delivery_state = 'failed',
               provider = $2,
               failure_reason = $3,
               updated_at = now()
         WHERE message_id = $1
         RETURNING *
      `,
      [input.messageId, input.provider ?? null, input.reason],
    );
    return messageFromRow(result.rows[0]);
  }

  async listMessages(input: { projectId: string; mailboxId: string; direction?: CoreMessageDirection }): Promise<CoreEmailMessageRecord[]> {
    await this.requireOwnedMailbox(input.projectId, input.mailboxId);
    const directionClause = input.direction ? "AND direction = $3" : "";
    const params = input.direction
      ? [input.projectId, input.mailboxId, input.direction]
      : [input.projectId, input.mailboxId];
    const result = await this.#pool.query<MessageRow>(
      `
        SELECT *
        FROM internal.core_email_messages
        WHERE project_id = $1 AND mailbox_id = $2
        ${directionClause}
        ORDER BY created_at DESC
      `,
      params,
    );
    return result.rows.map(messageFromRow);
  }

  async getMessage(input: { projectId: string; mailboxId: string; messageId: string }): Promise<CoreEmailMessageRecord | null> {
    await this.requireOwnedMailbox(input.projectId, input.mailboxId);
    const result = await this.#pool.query<MessageRow>(
      `
        SELECT *
        FROM internal.core_email_messages
        WHERE project_id = $1 AND mailbox_id = $2 AND message_id = $3
      `,
      [input.projectId, input.mailboxId, input.messageId],
    );
    return result.rows[0] ? messageFromRow(result.rows[0]) : null;
  }

  async resolveMailboxByInboundAddress(input: { address: string; inboundDomains: string[] }): Promise<CoreMailboxRecord | null> {
    const parsed = parseAddressForDomain(input.address, input.inboundDomains);
    if (!parsed) return null;
    const result = await this.#pool.query<MailboxRow>(
      `
        SELECT mailbox_id, slug, project_id, status, footer_policy, created_at, updated_at, tombstoned_at
        FROM internal.core_mailboxes
        WHERE slug = $1 AND status <> 'tombstoned'
        LIMIT 1
      `,
      [parsed.slug],
    );
    return result.rows[0] ? mailboxFromRow(result.rows[0]) : null;
  }

  async findOutboundReplyCandidate(input: { mailboxId: string; senderCandidates: string[]; threadingCandidates: string[] }): Promise<CoreEmailMessageRecord | null> {
    if (input.threadingCandidates.length > 0) {
      const byThread = await this.#pool.query<MessageRow>(
        `
          SELECT *
          FROM internal.core_email_messages
          WHERE mailbox_id = $2
            AND direction = 'outbound'
            AND (provider_message_id = ANY($1::text[]) OR message_id = ANY($1::text[]))
          ORDER BY array_position($1::text[], provider_message_id) NULLS LAST, created_at DESC
          LIMIT 1
        `,
        [input.threadingCandidates, input.mailboxId],
      );
      if (byThread.rows[0]) return messageFromRow(byThread.rows[0]);
    }
    if (input.senderCandidates.length === 0) return null;
    const bySender = await this.#pool.query<MessageRow>(
      `
        SELECT *
        FROM internal.core_email_messages
        WHERE mailbox_id = $1
          AND direction = 'outbound'
          AND lower(to_address) = ANY($2::text[])
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [input.mailboxId, input.senderCandidates.map((value) => value.toLowerCase())],
    );
    return bySender.rows[0] ? messageFromRow(bySender.rows[0]) : null;
  }

  async storeInboundMessage(input: StoreInboundMessageInput): Promise<{ message: CoreEmailMessageRecord; created: boolean }> {
    if (input.rawMime) {
      await this.#pool.query(
        `
          INSERT INTO internal.core_email_inbound_raw_messages (raw_ref, raw_mime)
          VALUES ($1, $2)
          ON CONFLICT (raw_ref) DO NOTHING
        `,
        [input.rawRef, input.rawMime],
      );
    }
    const messageId = `msg_${Date.now()}_${randomToken(8)}`;
    const result = await this.#pool.query<MessageRow>(
      `
        INSERT INTO internal.core_email_messages (
          message_id, project_id, mailbox_id, direction, from_address, to_address, subject,
          body_text, status, delivery_state, provider, provider_message_id,
          raw_storage_provider, raw_ref, in_reply_to_message_id, received_at
        )
        VALUES ($1, $2, $3, 'inbound', $4, $5, $6, $7, 'received', 'received', $8, $9, $10, $11, $12, $13::timestamptz)
        ON CONFLICT (mailbox_id, provider, provider_message_id, to_address)
          WHERE direction = 'inbound' AND provider IS NOT NULL AND provider_message_id IS NOT NULL
          DO NOTHING
        RETURNING *
      `,
      [
        messageId,
        input.projectId,
        input.mailboxId,
        input.fromAddress,
        input.toAddress,
        input.subject,
        input.bodyText,
        input.provider,
        input.providerMessageId,
        input.rawStorageProvider,
        input.rawRef,
        input.inReplyToMessageId,
        input.receivedAt,
      ],
    );
    if (result.rows[0]) return { message: messageFromRow(result.rows[0]), created: true };
    const existing = await this.#pool.query<MessageRow>(
      `
        SELECT *
        FROM internal.core_email_messages
        WHERE mailbox_id = $1
          AND provider = $2
          AND provider_message_id = $3
          AND to_address = $4
          AND direction = 'inbound'
        LIMIT 1
      `,
      [input.mailboxId, input.provider, input.providerMessageId, input.toAddress],
    );
    return { message: messageFromRow(existing.rows[0]), created: false };
  }

  async getInboundRawMessage(input: { projectId: string; mailboxId: string; messageId: string }): Promise<Buffer | null> {
    const message = await this.getMessage(input);
    if (!message || message.direction !== "inbound" || message.raw_storage_provider !== "inline" || !message.raw_ref) return null;
    const result = await this.#pool.query<{ raw_mime: Buffer }>(
      `
        SELECT raw_mime
        FROM internal.core_email_inbound_raw_messages
        WHERE raw_ref = $1
      `,
      [message.raw_ref],
    );
    return result.rows[0]?.raw_mime ?? null;
  }

  async createWebhook(input: { projectId: string; mailboxId: string; url: string; events: string[] }): Promise<CoreMailboxWebhookRecord> {
    await this.requireOwnedMailbox(input.projectId, input.mailboxId);
    const webhookId = `wh_${randomToken(12)}`;
    const result = await this.#pool.query<WebhookRow>(
      `
        INSERT INTO internal.core_mailbox_webhooks (webhook_id, project_id, mailbox_id, url, events)
        VALUES ($1, $2, $3, $4, $5::jsonb)
        RETURNING *
      `,
      [webhookId, input.projectId, input.mailboxId, input.url, JSON.stringify(input.events)],
    );
    return webhookFromRow(result.rows[0]);
  }

  async listWebhooks(input: { projectId: string; mailboxId: string }): Promise<CoreMailboxWebhookRecord[]> {
    await this.requireOwnedMailbox(input.projectId, input.mailboxId);
    const result = await this.#pool.query<WebhookRow>(
      `
        SELECT *
        FROM internal.core_mailbox_webhooks
        WHERE project_id = $1 AND mailbox_id = $2 AND status = 'active'
        ORDER BY created_at DESC
      `,
      [input.projectId, input.mailboxId],
    );
    return result.rows.map(webhookFromRow);
  }

  async getWebhook(input: { projectId: string; mailboxId: string; webhookId: string }): Promise<CoreMailboxWebhookRecord | null> {
    await this.requireOwnedMailbox(input.projectId, input.mailboxId);
    const result = await this.#pool.query<WebhookRow>(
      `
        SELECT *
        FROM internal.core_mailbox_webhooks
        WHERE project_id = $1 AND mailbox_id = $2 AND webhook_id = $3 AND status = 'active'
      `,
      [input.projectId, input.mailboxId, input.webhookId],
    );
    return result.rows[0] ? webhookFromRow(result.rows[0]) : null;
  }

  async updateWebhook(input: { projectId: string; mailboxId: string; webhookId: string; url?: string; events?: string[] }): Promise<CoreMailboxWebhookRecord> {
    await this.requireOwnedMailbox(input.projectId, input.mailboxId);
    const current = await this.getWebhook(input);
    if (!current) throw new CoreMailboxError("Webhook not found", 404, "webhook_not_found");
    const result = await this.#pool.query<WebhookRow>(
      `
        UPDATE internal.core_mailbox_webhooks
           SET url = $4,
               events = $5::jsonb,
               updated_at = now()
         WHERE project_id = $1 AND mailbox_id = $2 AND webhook_id = $3 AND status = 'active'
         RETURNING *
      `,
      [
        input.projectId,
        input.mailboxId,
        input.webhookId,
        input.url ?? current.url,
        JSON.stringify(input.events ?? current.events),
      ],
    );
    return webhookFromRow(result.rows[0]);
  }

  async deleteWebhook(input: { projectId: string; mailboxId: string; webhookId: string }): Promise<CoreMailboxWebhookRecord | null> {
    await this.requireOwnedMailbox(input.projectId, input.mailboxId);
    const result = await this.#pool.query<WebhookRow>(
      `
        UPDATE internal.core_mailbox_webhooks
           SET status = 'deleted', updated_at = now()
         WHERE project_id = $1 AND mailbox_id = $2 AND webhook_id = $3 AND status = 'active'
         RETURNING *
      `,
      [input.projectId, input.mailboxId, input.webhookId],
    );
    return result.rows[0] ? webhookFromRow(result.rows[0]) : null;
  }

  async enqueueWebhookDelivery(input: EnqueueWebhookDeliveryInput): Promise<CoreWebhookDeliveryRecord[]> {
    const webhooks = await this.listWebhooks({ projectId: input.projectId, mailboxId: input.mailboxId });
    const deliveries: CoreWebhookDeliveryRecord[] = [];
    for (const webhook of webhooks.filter((entry) => entry.events.includes(input.eventType))) {
      const sourceEventId = `${webhook.webhook_id}:${input.eventType}:${input.discriminator}`;
      const deliveryId = `whd_${randomToken(12)}`;
      const envelope = {
        id: deliveryId,
        type: input.eventType,
        created_at: new Date().toISOString(),
        schema_version: "1",
        idempotency_key: sourceEventId,
        payload: input.payload,
      };
      const result = await this.#pool.query<DeliveryRow>(
        `
          INSERT INTO internal.core_webhook_deliveries (
            delivery_id, source, source_event_id, project_id, mailbox_id,
            webhook_id, event_type, target_url, payload
          )
          VALUES ($1, 'core-email-inbound', $2, $3, $4, $5, $6, $7, $8::jsonb)
          ON CONFLICT (source, source_event_id) DO NOTHING
          RETURNING *
        `,
        [
          deliveryId,
          sourceEventId,
          input.projectId,
          input.mailboxId,
          webhook.webhook_id,
          input.eventType,
          webhook.url,
          JSON.stringify(envelope),
        ],
      );
      if (result.rows[0]) deliveries.push(deliveryFromRow(result.rows[0]));
    }
    return deliveries;
  }

  async listWebhookDeliveries(input: { projectId: string; mailboxId: string; status?: CoreWebhookDeliveryStatus }): Promise<CoreWebhookDeliveryRecord[]> {
    await this.requireOwnedMailbox(input.projectId, input.mailboxId);
    const statusClause = input.status ? "AND status = $3" : "";
    const params = input.status
      ? [input.projectId, input.mailboxId, input.status]
      : [input.projectId, input.mailboxId];
    const result = await this.#pool.query<DeliveryRow>(
      `
        SELECT *
        FROM internal.core_webhook_deliveries
        WHERE project_id = $1 AND mailbox_id = $2
        ${statusClause}
        ORDER BY created_at DESC
      `,
      params,
    );
    return result.rows.map(deliveryFromRow);
  }

  async redriveWebhookDelivery(input: { projectId: string; mailboxId: string; deliveryId: string }): Promise<CoreWebhookDeliveryRecord> {
    await this.requireOwnedMailbox(input.projectId, input.mailboxId);
    const current = await this.#pool.query<DeliveryRow>(
      `
        SELECT *
        FROM internal.core_webhook_deliveries
        WHERE project_id = $1 AND mailbox_id = $2 AND delivery_id = $3
      `,
      [input.projectId, input.mailboxId, input.deliveryId],
    );
    if (!current.rows[0]) throw new CoreMailboxError("Webhook delivery not found", 404, "webhook_delivery_not_found");
    if (current.rows[0].status !== "failed_permanent") {
      throw new CoreMailboxError("Only failed_permanent deliveries can be redriven", 409, "webhook_delivery_not_failed");
    }
    const result = await this.#pool.query<DeliveryRow>(
      `
        UPDATE internal.core_webhook_deliveries
           SET status = 'pending',
               attempts = 0,
               next_attempt_at = now(),
               last_status = NULL,
               last_error = NULL,
               updated_at = now()
         WHERE project_id = $1 AND mailbox_id = $2 AND delivery_id = $3
         RETURNING *
      `,
      [input.projectId, input.mailboxId, input.deliveryId],
    );
    return deliveryFromRow(result.rows[0]);
  }

  async claimDueWebhookDeliveries(input: { limit: number; leaseMs: number; now?: Date }): Promise<CoreWebhookDeliveryRecord[]> {
    const now = input.now ?? new Date();
    const result = await this.#pool.query<DeliveryRow>(
      `
        WITH due AS (
          SELECT delivery_id
          FROM internal.core_webhook_deliveries
          WHERE status = 'pending'
            AND next_attempt_at <= $2::timestamptz
          ORDER BY next_attempt_at ASC, created_at ASC
          LIMIT $1
          FOR UPDATE SKIP LOCKED
        )
        UPDATE internal.core_webhook_deliveries AS delivery
           SET attempts = delivery.attempts + 1,
               next_attempt_at = $2::timestamptz + ($3::integer * INTERVAL '1 millisecond'),
               last_error = NULL,
               updated_at = $2::timestamptz
          FROM due
         WHERE delivery.delivery_id = due.delivery_id
         RETURNING delivery.*
      `,
      [input.limit, now.toISOString(), input.leaseMs],
    );
    return result.rows.map(deliveryFromRow);
  }

  async markWebhookDeliveryDelivered(input: { deliveryId: string; status: number; now?: Date }): Promise<CoreWebhookDeliveryRecord | null> {
    const now = input.now ?? new Date();
    const result = await this.#pool.query<DeliveryRow>(
      `
        UPDATE internal.core_webhook_deliveries
           SET status = 'delivered',
               last_status = $2,
               last_error = NULL,
               delivered_at = $3::timestamptz,
               updated_at = $3::timestamptz
         WHERE delivery_id = $1
         RETURNING *
      `,
      [input.deliveryId, input.status, now.toISOString()],
    );
    return result.rows[0] ? deliveryFromRow(result.rows[0]) : null;
  }

  async markWebhookDeliveryFailed(input: {
    deliveryId: string;
    status: number | null;
    error: string;
    maxAttempts: number;
    retryDelayMs: number;
    now?: Date;
  }): Promise<CoreWebhookDeliveryRecord | null> {
    const now = input.now ?? new Date();
    const result = await this.#pool.query<DeliveryRow>(
      `
        UPDATE internal.core_webhook_deliveries
           SET status = CASE WHEN attempts >= $4 THEN 'failed_permanent' ELSE 'pending' END,
               last_status = $2,
               last_error = $3,
               next_attempt_at = CASE
                 WHEN attempts >= $4 THEN next_attempt_at
                 ELSE $5::timestamptz + ($6::integer * INTERVAL '1 millisecond')
               END,
               updated_at = $5::timestamptz
         WHERE delivery_id = $1
         RETURNING *
      `,
      [input.deliveryId, input.status, truncateWebhookError(input.error), input.maxAttempts, now.toISOString(), input.retryDelayMs],
    );
    return result.rows[0] ? deliveryFromRow(result.rows[0]) : null;
  }

  async requireOwnedMailbox(projectId: string, mailboxId: string): Promise<CoreMailboxRecord> {
    const mailbox = await this.getMailbox(mailboxId);
    if (!mailbox) {
      throw new CoreMailboxError("Mailbox not found", 404, "mailbox_not_found");
    }
    if (mailbox.project_id !== projectId) {
      throw new CoreMailboxError("Mailbox owned by different project", 403, "mailbox_forbidden");
    }
    return mailbox;
  }
}

export function formatMailboxResponse(input: {
  mailbox: CoreMailboxRecord;
  settings: CoreMailboxSettings;
  providerReadiness: EmailProviderReadiness;
  inboundProviderReadiness: EmailInboundProviderReadiness;
}): CoreMailboxResponse {
  const providerBlockedReason = providerBlockedReasonFor(input.providerReadiness);
  const inboundProviderBlockedReason = inboundProviderBlockedReasonFor(input.inboundProviderReadiness);
  const mailboxBlockedReason = mailboxBlockedReasonFor(input.mailbox);
  return {
    ...input.mailbox,
    address: mailboxAddress(input.mailbox.slug, input.providerReadiness.from_domain ?? input.inboundProviderReadiness.inbound_domains[0]),
    is_default_outbound: input.settings.default_outbound_mailbox_id === input.mailbox.mailbox_id,
    can_send: input.mailbox.status === "active" && input.providerReadiness.status === "configured",
    send_blocked_reason: mailboxBlockedReason ?? providerBlockedReason,
    provider_readiness: input.providerReadiness,
    can_receive: input.mailbox.status === "active" && input.inboundProviderReadiness.status === "configured",
    receive_blocked_reason: mailboxBlockedReason ?? inboundProviderBlockedReason,
    inbound_provider_readiness: input.inboundProviderReadiness,
  };
}

export function mailboxSettingsBody(settings: CoreMailboxSettings): {
  default_outbound_mailbox_id: string | null;
} {
  return {
    default_outbound_mailbox_id: settings.default_outbound_mailbox_id,
  };
}

export function createMailboxNextActions() {
  return [
    {
      type: "edit_request",
      method: "POST",
      path: "/mailboxes/v1",
      auth: "service_key",
      why: "Create a mailbox before calling email.send().",
      fields: { slug: "notifications" },
    },
    ...defaultMailboxNextActions(),
  ];
}

export function defaultMailboxNextActions() {
  return [
    {
      type: "edit_request",
      method: "PATCH",
      path: "/mailboxes/v1/settings",
      auth: "service_key",
      why: "Set default_outbound_mailbox_id to the mailbox email.send() should use.",
      fields: { default_outbound_mailbox_id: "mbx_..." },
    },
  ];
}

function providerBlockedReasonFor(readiness: EmailProviderReadiness): string | null {
  if (readiness.status === "configured") return null;
  if (readiness.status === "misconfigured") return "provider_misconfigured";
  return "provider_not_configured";
}

function inboundProviderBlockedReasonFor(readiness: EmailInboundProviderReadiness): string | null {
  if (readiness.status === "configured") return null;
  if (readiness.status === "misconfigured") return "inbound_provider_misconfigured";
  return "provider_not_configured";
}

function mailboxBlockedReasonFor(mailbox: CoreMailboxRecord): string | null {
  if (mailbox.status === "active") return null;
  if (mailbox.status === "suspended") return "mailbox_suspended";
  return "mailbox_deleted";
}

interface MailboxRow {
  mailbox_id: string;
  slug: string;
  project_id: string;
  status: CoreMailboxStatus;
  footer_policy: "none" | "run402_transparency";
  tombstoned_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface SettingsRow {
  project_id: string;
  default_outbound_mailbox_id: string | null;
  updated_at: Date | string;
}

interface MessageRow {
  message_id: string;
  project_id: string;
  mailbox_id: string;
  direction: CoreMessageDirection;
  from_address: string;
  to_address: string;
  subject: string;
  body_text: string;
  status: CoreMessageStatus;
  delivery_state: CoreDeliveryState;
  provider: string | null;
  provider_message_id: string | null;
  attachments_meta: unknown;
  raw_storage_provider: EmailInboundRawStorageProvider | null;
  raw_ref: string | null;
  in_reply_to_message_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  sent_at: Date | string | null;
  received_at: Date | string | null;
}

interface WebhookRow {
  webhook_id: string;
  project_id: string;
  mailbox_id: string;
  url: string;
  events: unknown;
  status: "active" | "deleted";
  created_at: Date | string;
  updated_at: Date | string;
}

interface DeliveryRow {
  delivery_id: string;
  source: string;
  source_event_id: string;
  project_id: string;
  mailbox_id: string;
  webhook_id: string;
  event_type: string;
  target_url: string;
  payload: unknown;
  status: CoreWebhookDeliveryStatus;
  attempts: number;
  next_attempt_at: Date | string;
  last_status: number | null;
  last_error: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  delivered_at: Date | string | null;
}

function mailboxFromRow(row: MailboxRow): CoreMailboxRecord {
  return {
    mailbox_id: row.mailbox_id,
    slug: row.slug,
    project_id: row.project_id,
    status: row.status,
    footer_policy: row.footer_policy,
    tombstoned_at: toIsoOrNull(row.tombstoned_at),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

function settingsFromRow(row: SettingsRow): CoreMailboxSettings {
  return {
    project_id: row.project_id,
    default_outbound_mailbox_id: row.default_outbound_mailbox_id,
    updated_at: toIso(row.updated_at),
  };
}

function messageFromRow(row: MessageRow): CoreEmailMessageRecord {
  return {
    message_id: row.message_id,
    project_id: row.project_id,
    mailbox_id: row.mailbox_id,
    direction: row.direction,
    from_address: row.from_address,
    to_address: row.to_address,
    subject: row.subject,
    body_text: row.body_text,
    status: row.status,
    delivery_state: row.delivery_state,
    provider: row.provider,
    provider_message_id: row.provider_message_id,
    attachments_meta: attachmentsMetaFromDb(row.attachments_meta),
    raw_storage_provider: row.raw_storage_provider,
    raw_ref: row.raw_ref,
    in_reply_to_message_id: row.in_reply_to_message_id,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
    sent_at: toIsoOrNull(row.sent_at),
    received_at: toIsoOrNull(row.received_at),
  };
}

function webhookFromRow(row: WebhookRow): CoreMailboxWebhookRecord {
  return {
    webhook_id: row.webhook_id,
    project_id: row.project_id,
    mailbox_id: row.mailbox_id,
    url: row.url,
    events: stringArrayFromDb(row.events),
    status: row.status,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

function deliveryFromRow(row: DeliveryRow): CoreWebhookDeliveryRecord {
  return {
    delivery_id: row.delivery_id,
    source: row.source,
    source_event_id: row.source_event_id,
    project_id: row.project_id,
    mailbox_id: row.mailbox_id,
    webhook_id: row.webhook_id,
    event_type: row.event_type,
    target_url: row.target_url,
    payload: jsonFromDb(row.payload),
    status: row.status,
    attempts: row.attempts,
    next_attempt_at: toIso(row.next_attempt_at),
    last_status: row.last_status,
    last_error: row.last_error,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
    delivered_at: toIsoOrNull(row.delivered_at),
  };
}

function truncateWebhookError(value: string): string {
  return value.length > 500 ? `${value.slice(0, 497)}...` : value;
}

function attachmentsMetaFromDb(value: unknown): Array<{ filename: string; content_type: string; size_bytes: number }> | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value as Array<{ filename: string; content_type: string; size_bytes: number }>;
  }
  if (typeof value === "string") {
    return JSON.parse(value) as Array<{ filename: string; content_type: string; size_bytes: number }>;
  }
  return value as Array<{ filename: string; content_type: string; size_bytes: number }>;
}

function stringArrayFromDb(value: unknown): string[] {
  const parsed = jsonFromDb(value);
  return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
}

function jsonFromDb(value: unknown): unknown {
  if (typeof value === "string") return JSON.parse(value) as unknown;
  return value;
}

function parseAddressForDomain(address: string, inboundDomains: string[]): { slug: string; domain: string } | null {
  const normalized = address.trim().toLowerCase();
  const at = normalized.indexOf("@");
  if (at < 1 || at !== normalized.lastIndexOf("@")) return null;
  const slug = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  if (!slug || !domain || !inboundDomains.includes(domain)) return null;
  return { slug, domain };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toIsoOrNull(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}

function randomToken(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505";
}
