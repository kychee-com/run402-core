import { randomBytes } from "node:crypto";
import type { Pool as PgPool } from "pg";
import type { EmailProviderReadiness } from "./email-provider.js";
import { mailboxAddress } from "./email-validation.js";

export type CoreMailboxStatus = "active" | "suspended" | "tombstoned";
export type CoreMessageStatus = "pending" | "sent" | "failed";
export type CoreDeliveryState = "pending_provider" | "accepted" | "failed";

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
  from_address: string;
  to_address: string;
  subject: string;
  body_text: string;
  status: CoreMessageStatus;
  delivery_state: CoreDeliveryState;
  provider: string | null;
  provider_message_id: string | null;
  attachments_meta: Array<{ filename: string; content_type: string; size_bytes: number }> | null;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
}

export interface CoreMailboxResponse extends CoreMailboxRecord {
  address: string;
  is_default_outbound: boolean;
  can_send: boolean;
  send_blocked_reason: string | null;
  provider_readiness: EmailProviderReadiness;
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
  listMessages(input: { projectId: string; mailboxId: string }): Promise<CoreEmailMessageRecord[]>;
  getMessage(input: { projectId: string; mailboxId: string; messageId: string }): Promise<CoreEmailMessageRecord | null>;
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
        from_address text NOT NULL,
        to_address text NOT NULL,
        subject text NOT NULL,
        body_text text NOT NULL,
        status text NOT NULL,
        delivery_state text NOT NULL,
        provider text,
        provider_message_id text,
        attachments_meta jsonb,
        failure_reason text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        sent_at timestamptz,
        CONSTRAINT core_email_messages_status_check CHECK (status IN ('pending', 'sent', 'failed')),
        CONSTRAINT core_email_messages_delivery_state_check CHECK (delivery_state IN ('pending_provider', 'accepted', 'failed'))
      );

      CREATE INDEX IF NOT EXISTS core_email_messages_mailbox_idx
        ON internal.core_email_messages(project_id, mailbox_id, created_at DESC);
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

  async listMessages(input: { projectId: string; mailboxId: string }): Promise<CoreEmailMessageRecord[]> {
    await this.requireOwnedMailbox(input.projectId, input.mailboxId);
    const result = await this.#pool.query<MessageRow>(
      `
        SELECT *
        FROM internal.core_email_messages
        WHERE project_id = $1 AND mailbox_id = $2
        ORDER BY created_at DESC
      `,
      [input.projectId, input.mailboxId],
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
}): CoreMailboxResponse {
  const providerBlockedReason = providerBlockedReasonFor(input.providerReadiness);
  const mailboxBlockedReason = mailboxBlockedReasonFor(input.mailbox);
  return {
    ...input.mailbox,
    address: mailboxAddress(input.mailbox.slug, input.providerReadiness.from_domain),
    is_default_outbound: input.settings.default_outbound_mailbox_id === input.mailbox.mailbox_id,
    can_send: input.mailbox.status === "active" && input.providerReadiness.status === "configured",
    send_blocked_reason: mailboxBlockedReason ?? providerBlockedReason,
    provider_readiness: input.providerReadiness,
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
  from_address: string;
  to_address: string;
  subject: string;
  body_text: string;
  status: CoreMessageStatus;
  delivery_state: CoreDeliveryState;
  provider: string | null;
  provider_message_id: string | null;
  attachments_meta: unknown;
  created_at: Date | string;
  updated_at: Date | string;
  sent_at: Date | string | null;
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
    from_address: row.from_address,
    to_address: row.to_address,
    subject: row.subject,
    body_text: row.body_text,
    status: row.status,
    delivery_state: row.delivery_state,
    provider: row.provider,
    provider_message_id: row.provider_message_id,
    attachments_meta: attachmentsMetaFromDb(row.attachments_meta),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
    sent_at: toIsoOrNull(row.sent_at),
  };
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
