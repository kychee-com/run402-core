import { config } from "./config.js";

export interface EmailRawOptions {
  to: string;
  /**
   * Blind copies: one address or up to 5. Each receives the same message, no
   * header of any copy names them, and each counts as one send against the
   * project's email limits. The platform validates them; Core refuses them.
   */
  bcc?: string | string[];
  subject: string;
  html: string;
  text?: string;
  from_name?: string;
  template?: never;
  variables?: never;
}

export interface EmailTemplateOptions {
  to: string;
  /** Blind copies, as on {@link EmailRawOptions.bcc}. */
  bcc?: string | string[];
  template: string;
  variables?: Record<string, string>;
  from_name?: string;
  subject?: never;
  html?: never;
  text?: never;
}

export type EmailSendOptions = EmailRawOptions | EmailTemplateOptions;

export interface EmailSendResult {
  message_id?: string;
  id?: string;
  mailbox_id?: string;
  from_address?: string;
  /** The blind copies the message went to (lower-cased, each `status: "sent"`); absent when it had none. */
  bcc?: Array<{ address: string; status: string; bounce_type: string | null }>;
  [key: string]: unknown;
}

interface MailboxSummary {
  mailbox_id: string;
  slug?: string;
  address?: string;
  status?: string;
  is_default_outbound?: boolean;
  is_auth_sender?: boolean;
  can_send?: boolean;
  send_blocked_reason?: string | null;
}

interface MailboxListResponse {
  mailboxes?: MailboxSummary[];
  mailbox_settings?: {
    default_outbound_mailbox_id?: string | null;
    auth_sender_mailbox_id?: string | null;
  };
  provider_readiness?: {
    status?: string;
    provider?: string;
    reason?: string;
  };
  next_actions?: unknown[];
}

export class EmailConfigurationError extends Error {
  constructor(
    message: string,
    public code: "AMBIGUOUS_MAILBOX" | "DEFAULT_MAILBOX_REQUIRED" | "DEFAULT_MAILBOX_INVALID" | "PROVIDER_NOT_CONFIGURED",
    public details: Record<string, unknown> = {},
    public next_actions: unknown[] = [],
  ) {
    super(message);
    this.name = "EmailConfigurationError";
  }
}

/**
 * Structured error thrown by `email.send()` when the gateway rejects the send
 * (a non-2xx response from `POST /mailboxes/v1/:mailbox_id/messages`). A
 * faithful passthrough of the gateway's error envelope: `code`, `details` and
 * `next_actions` are kept exactly as returned, and `message` stays
 * human-readable (`Email send failed (<status>): <gateway message>`).
 *
 * `code` is the envelope's `code` (or its `error` when that is the only field),
 * or `email_platform_error` when the body carries neither.
 *
 * Branch on `err.code` / `err.status` / `err.details`, not on `message`.
 */
export class Run402EmailPlatformError extends Error {
  readonly code: string;
  readonly status: number;
  /** `details` from the gateway's error envelope, when present. */
  readonly details: Record<string, unknown> | undefined;
  /** `next_actions` from the gateway's error envelope, when present. */
  readonly next_actions: unknown[] | undefined;
  /** Full response body — parsed object, or `{ message: <raw text> }` when unparseable. */
  readonly body: unknown;

  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.name = "Run402EmailPlatformError";
    this.status = status;
    this.body = body;
    this.code = envelopeString(body, "code", "error") ?? "email_platform_error";
    this.details = envelopeDetails(body);
    this.next_actions = envelopeNextActions(body);
  }
}

function envelopeString(body: unknown, ...keys: string[]): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const record = body as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

function envelopeDetails(body: unknown): Record<string, unknown> | undefined {
  if (!body || typeof body !== "object") return undefined;
  const details = (body as Record<string, unknown>).details;
  return details && typeof details === "object" && !Array.isArray(details)
    ? (details as Record<string, unknown>)
    : undefined;
}

function envelopeNextActions(body: unknown): unknown[] | undefined {
  if (!body || typeof body !== "object") return undefined;
  const actions = (body as Record<string, unknown>).next_actions;
  return Array.isArray(actions) ? actions : undefined;
}

async function sendFailure(res: Response): Promise<Run402EmailPlatformError> {
  const text = await res.text();
  let body: unknown = {};
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = { message: text };
    }
  }
  const message = envelopeString(body, "message", "error") ?? (text || "Run402 rejected the email.");
  return new Run402EmailPlatformError(res.status, body, "Email send failed (" + res.status + "): " + message);
}

export const email = (() => {
  let _mailboxId: string | null = null;

  async function _discoverMailbox(): Promise<string> {
    if (_mailboxId) return _mailboxId;
    const res = await fetch(config.API_BASE + "/mailboxes/v1", {
      headers: { Authorization: "Bearer " + config.SERVICE_KEY },
    });
    if (!res.ok) throw new Error("Failed to discover mailbox: " + (await res.text()));
    const data = (await res.json()) as MailboxListResponse;
    const mailboxes = data.mailboxes || [];
    const defaultOutboundId = data.mailbox_settings?.default_outbound_mailbox_id ?? null;
    if (defaultOutboundId) {
      const selected = mailboxes.find((mailbox) => mailbox.mailbox_id === defaultOutboundId);
      if (!selected || selected.can_send === false || selected.status === "suspended" || selected.status === "tombstoned") {
        if (selected && isProviderBlocked(selected, data)) {
          throw providerConfigurationError(data, mailboxes);
        }
        throw new EmailConfigurationError(
          "Configured default outbound mailbox is not send-ready",
          "DEFAULT_MAILBOX_INVALID",
          {
            resource_kind: "mailbox",
            selection_purpose: "default_outbound",
            default_mailbox_id: defaultOutboundId,
            candidates: mailboxes.map(safeMailboxCandidate),
          },
          data.next_actions || defaultMailboxNextActions(),
        );
      }
      _mailboxId = defaultOutboundId;
      return _mailboxId;
    }

    const sendReady = mailboxes.filter((mailbox) => mailbox.can_send !== false && mailbox.status !== "suspended" && mailbox.status !== "tombstoned");
    if (sendReady.length === 0) {
      if (mailboxes.length > 0 && isProviderBlocked(mailboxes[0]!, data)) {
        throw providerConfigurationError(data, mailboxes);
      }
      throw new EmailConfigurationError(
        "No active mailbox configured for this project",
        "DEFAULT_MAILBOX_REQUIRED",
        {
          resource_kind: "mailbox",
          selection_purpose: "default_outbound",
          candidates: [],
        },
        data.next_actions || createMailboxNextActions(),
      );
    }
    if (sendReady.length > 1) {
      throw new EmailConfigurationError(
        "Multiple active mailboxes found; configure default_outbound_mailbox_id before calling email.send()",
        "AMBIGUOUS_MAILBOX",
        {
          resource_kind: "mailbox",
          selection_purpose: "default_outbound",
          candidates: sendReady.map(safeMailboxCandidate),
        },
        data.next_actions || defaultMailboxNextActions(),
      );
    }
    _mailboxId = sendReady[0]!.mailbox_id;
    return _mailboxId;
  }

  return {
    async send(opts: EmailSendOptions): Promise<EmailSendResult> {
      const mbxId = await _discoverMailbox();
      const body: Record<string, unknown> = { to: opts.to };
      if (opts.bcc !== undefined) body.bcc = opts.bcc;
      if ("template" in opts && opts.template) {
        body.template = opts.template;
        body.variables = opts.variables || {};
      } else {
        body.subject = (opts as EmailRawOptions).subject;
        body.html = (opts as EmailRawOptions).html;
        if ((opts as EmailRawOptions).text) body.text = (opts as EmailRawOptions).text;
      }
      if (opts.from_name) body.from_name = opts.from_name;
      const res = await fetch(config.API_BASE + "/mailboxes/v1/" + mbxId + "/messages", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + config.SERVICE_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw await sendFailure(res);
      return res.json() as Promise<EmailSendResult>;
    },
  };
})();

function safeMailboxCandidate(mailbox: MailboxSummary): Record<string, unknown> {
  return {
    mailbox_id: mailbox.mailbox_id,
    slug: mailbox.slug,
    address: mailbox.address,
    status: mailbox.status,
    is_default_outbound: mailbox.is_default_outbound === true,
    is_auth_sender: mailbox.is_auth_sender === true,
    can_send: mailbox.can_send !== false,
    send_blocked_reason: mailbox.send_blocked_reason ?? null,
  };
}

function isProviderBlocked(mailbox: MailboxSummary, data: MailboxListResponse): boolean {
  return mailbox.send_blocked_reason === "provider_not_configured" ||
    mailbox.send_blocked_reason === "provider_misconfigured" ||
    data.provider_readiness?.status === "not_configured" ||
    data.provider_readiness?.status === "misconfigured";
}

function providerConfigurationError(data: MailboxListResponse, mailboxes: MailboxSummary[]): EmailConfigurationError {
  const status = data.provider_readiness?.status ?? "not_configured";
  return new EmailConfigurationError(
    status === "misconfigured"
      ? "Core outbound email provider is misconfigured"
      : "Core outbound email provider is not configured",
    "PROVIDER_NOT_CONFIGURED",
    {
      resource_kind: "email_provider",
      provider_readiness: data.provider_readiness ?? { status },
      candidates: mailboxes.map(safeMailboxCandidate),
    },
    data.next_actions || providerNextActions(),
  );
}

function defaultMailboxNextActions(): unknown[] {
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

function createMailboxNextActions(): unknown[] {
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

function providerNextActions(): unknown[] {
  return [
    {
      type: "edit_request",
      path: "host environment",
      auth: "operator",
      why: "Configure the Core gateway outbound email provider before retrying email.send().",
      fields: { CORE_EMAIL_PROVIDER: "ses", CORE_EMAIL_FROM_DOMAIN: "example.com" },
    },
  ];
}
