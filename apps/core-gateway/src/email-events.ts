import { timingSafeEqual } from "node:crypto";

export type EmailDeliveryEventProviderName = "disabled" | "ses";
export type EmailDeliveryEventType = "delivery" | "bounced" | "complained";
export type EmailDeliveryEventReadinessStatus = "configured" | "not_configured" | "misconfigured";

export interface EmailDeliveryEventConfig {
  provider: string;
  ingestToken?: string;
}

export interface EmailDeliveryEventReadiness {
  status: EmailDeliveryEventReadinessStatus;
  provider: EmailDeliveryEventProviderName;
  reason?: string;
}

export interface NormalizedEmailDeliveryEvent {
  provider: "ses";
  event_type: EmailDeliveryEventType;
  provider_message_id: string;
  recipient: string | null;
  bounce_type: string | null;
  occurred_at: string | null;
  raw_event_type: string;
}

export interface IgnoredEmailDeliveryEvent {
  reason: string;
  raw_event_type?: string;
  provider_message_id?: string;
}

export interface NormalizedEmailDeliveryEventBatch {
  provider: "ses";
  events: NormalizedEmailDeliveryEvent[];
  ignored: IgnoredEmailDeliveryEvent[];
}

export class EmailDeliveryEventError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "EmailDeliveryEventError";
  }
}

export function emailDeliveryEventConfigFromEnv(env: NodeJS.ProcessEnv): EmailDeliveryEventConfig {
  return {
    provider: cleanOptional(env.CORE_EMAIL_EVENTS_PROVIDER) ?? (cleanOptional(env.CORE_EMAIL_EVENTS_INGEST_TOKEN) ? "ses" : "disabled"),
    ingestToken: cleanOptional(env.CORE_EMAIL_EVENTS_INGEST_TOKEN),
  };
}

export function emailDeliveryEventReadiness(config: EmailDeliveryEventConfig): EmailDeliveryEventReadiness {
  const provider = config.provider.trim().toLowerCase();
  if (provider === "disabled" || provider === "none") {
    return {
      status: "not_configured",
      provider: "disabled",
      reason: "CORE_EMAIL_EVENTS_INGEST_TOKEN is not configured.",
    };
  }
  if (provider !== "ses") {
    return {
      status: "misconfigured",
      provider: "disabled",
      reason: `Unsupported CORE_EMAIL_EVENTS_PROVIDER: ${config.provider}`,
    };
  }
  if (!config.ingestToken) {
    return {
      status: "misconfigured",
      provider: "ses",
      reason: "CORE_EMAIL_EVENTS_INGEST_TOKEN is required when delivery-event ingestion is enabled.",
    };
  }
  return { status: "configured", provider: "ses" };
}

export function authenticateEmailDeliveryEventToken(token: string | null, config: EmailDeliveryEventConfig): boolean {
  return constantTimeTokenEquals(token, config.ingestToken);
}

export function normalizeSesDeliveryEvents(input: unknown): NormalizedEmailDeliveryEventBatch {
  const candidates = unwrapSesEventCandidates(input);
  const events: NormalizedEmailDeliveryEvent[] = [];
  const ignored: IgnoredEmailDeliveryEvent[] = [];

  for (const candidate of candidates) {
    const normalized = normalizeSesDeliveryEvent(candidate);
    if ("event" in normalized) {
      events.push(normalized.event);
    } else {
      ignored.push(normalized.ignored);
    }
  }

  return { provider: "ses", events, ignored };
}

function normalizeSesDeliveryEvent(input: unknown): { event: NormalizedEmailDeliveryEvent } | { ignored: IgnoredEmailDeliveryEvent } {
  const record = objectRecord(input);
  if (!record) return { ignored: { reason: "event_not_object" } };

  const rawEventType = optionalString(record.eventType) ?? optionalString(record.notificationType);
  const eventType = normalizeEventType(rawEventType);
  if (!eventType) {
    return { ignored: { reason: "event_type_unsupported", ...(rawEventType ? { raw_event_type: rawEventType } : {}) } };
  }

  const mail = objectRecord(record.mail);
  const providerMessageId = optionalString(record.provider_message_id) ??
    optionalString(record.ses_message_id) ??
    optionalString(record.message_id) ??
    optionalString(mail?.messageId);
  if (!providerMessageId) {
    return { ignored: { reason: "provider_message_id_missing", raw_event_type: rawEventType ?? eventType } };
  }

  const delivery = objectRecord(record.delivery);
  const bounce = objectRecord(record.bounce);
  const complaint = objectRecord(record.complaint);

  return {
    event: {
      provider: "ses",
      event_type: eventType,
      provider_message_id: providerMessageId,
      recipient: firstRecipientFor(eventType, record, mail, delivery, bounce, complaint),
      bounce_type: eventType === "bounced" ? optionalString(bounce?.bounceType) ?? null : null,
      occurred_at: optionalString(delivery?.timestamp) ??
        optionalString(bounce?.timestamp) ??
        optionalString(complaint?.timestamp) ??
        optionalString(mail?.timestamp) ??
        optionalString(record.timestamp) ??
        null,
      raw_event_type: rawEventType ?? eventType,
    },
  };
}

function unwrapSesEventCandidates(input: unknown): unknown[] {
  const record = objectRecord(input);
  if (!record) return [input];
  const records = Array.isArray(record.Records) ? record.Records : null;
  if (!records) return [input];
  const out: unknown[] = [];
  for (const item of records) {
    const sns = objectRecord(objectRecord(item)?.Sns);
    const message = optionalString(sns?.Message);
    if (!message) {
      out.push(item);
      continue;
    }
    try {
      out.push(JSON.parse(message) as unknown);
    } catch {
      out.push({ notificationType: "Malformed", message_id: optionalString(sns?.MessageId) });
    }
  }
  return out;
}

function normalizeEventType(value: string | undefined): EmailDeliveryEventType | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "delivery" || normalized === "delivered") return "delivery";
  if (normalized === "bounce" || normalized === "bounced") return "bounced";
  if (normalized === "complaint" || normalized === "complained") return "complained";
  return null;
}

function firstRecipientFor(
  eventType: EmailDeliveryEventType,
  record: Record<string, unknown>,
  mail: Record<string, unknown> | null,
  delivery: Record<string, unknown> | null,
  bounce: Record<string, unknown> | null,
  complaint: Record<string, unknown> | null,
): string | null {
  if (eventType === "delivery") {
    return firstString(delivery?.recipients) ?? firstString(record.recipients) ?? firstString(mail?.destination) ?? null;
  }
  if (eventType === "bounced") {
    return firstRecipientObjectEmail(bounce?.bouncedRecipients) ?? firstString(record.recipients) ?? firstString(mail?.destination) ?? null;
  }
  return firstRecipientObjectEmail(complaint?.complainedRecipients) ?? firstString(record.recipients) ?? firstString(mail?.destination) ?? null;
}

function firstRecipientObjectEmail(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  for (const item of value) {
    const email = optionalString(objectRecord(item)?.emailAddress);
    if (email) return email;
  }
  return null;
}

function firstString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (!Array.isArray(value)) return null;
  for (const item of value) {
    if (typeof item === "string" && item.trim()) return item.trim();
  }
  return null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function cleanOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function constantTimeTokenEquals(candidate: string | null, expected: string | undefined): boolean {
  if (!candidate || !expected) return false;
  const candidateBytes = Buffer.from(candidate);
  const expectedBytes = Buffer.from(expected);
  if (candidateBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(candidateBytes, expectedBytes);
}
