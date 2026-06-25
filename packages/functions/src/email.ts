import { config } from "./config.js";

export interface EmailRawOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
  from_name?: string;
  template?: never;
  variables?: never;
}

export interface EmailTemplateOptions {
  to: string;
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
  next_actions?: unknown[];
}

export class EmailConfigurationError extends Error {
  constructor(
    message: string,
    public code: "AMBIGUOUS_MAILBOX" | "DEFAULT_MAILBOX_REQUIRED" | "DEFAULT_MAILBOX_INVALID",
    public details: Record<string, unknown> = {},
    public next_actions: unknown[] = [],
  ) {
    super(message);
    this.name = "EmailConfigurationError";
  }
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
      if (!res.ok) {
        const errBody = await res.text();
        let msg: string;
        try {
          msg = (JSON.parse(errBody) as { error?: string }).error || errBody;
        } catch {
          msg = errBody;
        }
        throw new Error("Email send failed (" + res.status + "): " + msg);
      }
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
