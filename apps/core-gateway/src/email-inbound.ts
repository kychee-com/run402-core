import { createHash, timingSafeEqual } from "node:crypto";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { stripHtml } from "./email-validation.js";
import type {
  CoreEmailMessageRecord,
  CoreMailboxStorePort,
  StoreInboundMessageInput,
} from "./postgres-mailboxes.js";

export type EmailInboundProviderName = "disabled" | "mock" | "ses";
export type EmailInboundReadinessStatus = "configured" | "not_configured" | "misconfigured";
export type EmailInboundRawStorageProvider = "inline" | "s3";

export interface EmailInboundProviderReadiness {
  status: EmailInboundReadinessStatus;
  provider: EmailInboundProviderName;
  inbound_domains: string[];
  raw_store?: EmailInboundRawStorageProvider;
  max_raw_bytes: number;
  reason?: string;
}

export interface EmailInboundProviderConfig {
  provider: string;
  inboundDomains: string[];
  ingestToken?: string;
  sesRegion?: string;
  sesEndpoint?: string;
  rawBucket?: string;
  rawPrefix?: string;
  maxRawBytes: number;
}

export interface EmailInboundProviderPort {
  readiness(): EmailInboundProviderReadiness;
  authenticate(token: string | null): boolean;
  ingest(input: unknown, store: CoreMailboxStorePort): Promise<EmailInboundIngestionResult>;
  readRawMessage(message: CoreEmailMessageRecord): Promise<Buffer | null>;
}

export interface EmailInboundIngestionResult {
  provider: EmailInboundProviderName;
  provider_message_id: string;
  accepted_count: number;
  dropped_count: number;
  results: EmailInboundRecipientResult[];
}

export interface EmailInboundRecipientResult {
  recipient: string;
  status: "accepted" | "duplicate" | "dropped";
  reason?: string;
  mailbox_id?: string;
  message_id?: string;
}

interface NormalizedInboundEvent {
  provider: EmailInboundProviderName;
  providerMessageId: string;
  recipients: string[];
  source: string | null;
  commonFrom: string | null;
  receiptTimestamp: string | null;
  bucket?: string;
  key?: string;
  rawMime?: Buffer;
}

interface ParsedMime {
  subject: string;
  bodyText: string;
  inReplyTo: string | null;
  references: string | null;
}

export class EmailInboundError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "EmailInboundError";
  }
}

export function emailInboundProviderConfigFromEnv(env: NodeJS.ProcessEnv): EmailInboundProviderConfig {
  const domains = splitDomains(
    env.CORE_EMAIL_INBOUND_DOMAINS ??
    env.CORE_EMAIL_INBOUND_DOMAIN ??
    env.CORE_EMAIL_FROM_DOMAIN,
  );
  return {
    provider: env.CORE_EMAIL_INBOUND_PROVIDER ?? "disabled",
    inboundDomains: domains,
    ingestToken: cleanOptional(env.CORE_EMAIL_INBOUND_INGEST_TOKEN),
    sesRegion: cleanOptional(env.CORE_EMAIL_INBOUND_SES_REGION ?? env.CORE_EMAIL_SES_REGION ?? env.AWS_REGION),
    sesEndpoint: cleanOptional(env.CORE_EMAIL_INBOUND_S3_ENDPOINT),
    rawBucket: cleanOptional(env.CORE_EMAIL_INBOUND_RAW_BUCKET),
    rawPrefix: cleanOptional(env.CORE_EMAIL_INBOUND_RAW_PREFIX),
    maxRawBytes: parsePositiveInteger(env.CORE_EMAIL_INBOUND_MAX_RAW_BYTES, 10 * 1024 * 1024),
  };
}

export function createEmailInboundProvider(config: EmailInboundProviderConfig): EmailInboundProviderPort {
  const provider = config.provider.trim().toLowerCase();
  if (provider === "mock") return new MockEmailInboundProvider(config);
  if (provider === "ses") return new SesEmailInboundProvider(config);
  return new DisabledEmailInboundProvider(provider === "disabled" || provider === "none"
    ? "CORE_EMAIL_INBOUND_PROVIDER is not configured."
    : `Unsupported CORE_EMAIL_INBOUND_PROVIDER: ${config.provider}`);
}

export class DisabledEmailInboundProvider implements EmailInboundProviderPort {
  constructor(private readonly reason: string) {}

  readiness(): EmailInboundProviderReadiness {
    return {
      status: "not_configured",
      provider: "disabled",
      inbound_domains: [],
      max_raw_bytes: 10 * 1024 * 1024,
      reason: this.reason,
    };
  }

  authenticate(): boolean {
    return false;
  }

  async ingest(): Promise<EmailInboundIngestionResult> {
    throw new EmailInboundError("Inbound email provider is not configured.", "provider_not_configured", 503);
  }

  async readRawMessage(): Promise<Buffer | null> {
    return null;
  }
}

export class MockEmailInboundProvider implements EmailInboundProviderPort {
  readonly #domains: string[];
  readonly #ingestToken?: string;
  readonly #maxRawBytes: number;

  constructor(config: EmailInboundProviderConfig) {
    this.#domains = config.inboundDomains;
    this.#ingestToken = config.ingestToken;
    this.#maxRawBytes = config.maxRawBytes;
  }

  readiness(): EmailInboundProviderReadiness {
    if (this.#domains.length === 0) {
      return {
        status: "misconfigured",
        provider: "mock",
        inbound_domains: [],
        raw_store: "inline",
        max_raw_bytes: this.#maxRawBytes,
        reason: "CORE_EMAIL_INBOUND_DOMAIN or CORE_EMAIL_INBOUND_DOMAINS is required when CORE_EMAIL_INBOUND_PROVIDER=mock.",
      };
    }
    if (!this.#ingestToken) {
      return {
        status: "misconfigured",
        provider: "mock",
        inbound_domains: this.#domains,
        raw_store: "inline",
        max_raw_bytes: this.#maxRawBytes,
        reason: "CORE_EMAIL_INBOUND_INGEST_TOKEN is required when inbound email is enabled.",
      };
    }
    return {
      status: "configured",
      provider: "mock",
      inbound_domains: this.#domains,
      raw_store: "inline",
      max_raw_bytes: this.#maxRawBytes,
    };
  }

  authenticate(token: string | null): boolean {
    return constantTimeTokenEquals(token, this.#ingestToken);
  }

  async ingest(input: unknown, store: CoreMailboxStorePort): Promise<EmailInboundIngestionResult> {
    const readiness = this.readiness();
    if (readiness.status !== "configured") {
      throw new EmailInboundError(readiness.reason ?? "Inbound email provider is not configured.", "provider_misconfigured", 503);
    }
    const event = inboundEventFromBody(input, "mock");
    if (!event.rawMime) {
      throw new EmailInboundError("raw_mime or raw_mime_base64 is required for mock inbound ingestion.", "raw_mime_required", 400);
    }
    return processInboundEvent({
      event,
      store,
      rawMime: enforceRawLimit(event.rawMime, this.#maxRawBytes),
      rawStorageProvider: "inline",
      rawRef: inlineRawRef(event.providerMessageId, event.rawMime),
      inboundDomains: this.#domains,
    });
  }

  async readRawMessage(): Promise<Buffer | null> {
    return null;
  }
}

class SesEmailInboundProvider implements EmailInboundProviderPort {
  readonly #domains: string[];
  readonly #ingestToken?: string;
  readonly #region?: string;
  readonly #endpoint?: string;
  readonly #rawBucket?: string;
  readonly #rawPrefix?: string;
  readonly #maxRawBytes: number;
  #client?: S3Client;

  constructor(config: EmailInboundProviderConfig) {
    this.#domains = config.inboundDomains;
    this.#ingestToken = config.ingestToken;
    this.#region = config.sesRegion;
    this.#endpoint = config.sesEndpoint;
    this.#rawBucket = config.rawBucket;
    this.#rawPrefix = config.rawPrefix;
    this.#maxRawBytes = config.maxRawBytes;
  }

  readiness(): EmailInboundProviderReadiness {
    if (this.#domains.length === 0) {
      return {
        status: "misconfigured",
        provider: "ses",
        inbound_domains: [],
        raw_store: "s3",
        max_raw_bytes: this.#maxRawBytes,
        reason: "CORE_EMAIL_INBOUND_DOMAIN or CORE_EMAIL_INBOUND_DOMAINS is required when CORE_EMAIL_INBOUND_PROVIDER=ses.",
      };
    }
    if (!this.#ingestToken) {
      return {
        status: "misconfigured",
        provider: "ses",
        inbound_domains: this.#domains,
        raw_store: "s3",
        max_raw_bytes: this.#maxRawBytes,
        reason: "CORE_EMAIL_INBOUND_INGEST_TOKEN is required when inbound email is enabled.",
      };
    }
    if (!this.#region) {
      return {
        status: "misconfigured",
        provider: "ses",
        inbound_domains: this.#domains,
        raw_store: "s3",
        max_raw_bytes: this.#maxRawBytes,
        reason: "CORE_EMAIL_INBOUND_SES_REGION, CORE_EMAIL_SES_REGION, or AWS_REGION is required when CORE_EMAIL_INBOUND_PROVIDER=ses.",
      };
    }
    if (!this.#rawBucket) {
      return {
        status: "misconfigured",
        provider: "ses",
        inbound_domains: this.#domains,
        raw_store: "s3",
        max_raw_bytes: this.#maxRawBytes,
        reason: "CORE_EMAIL_INBOUND_RAW_BUCKET is required when CORE_EMAIL_INBOUND_PROVIDER=ses.",
      };
    }
    return {
      status: "configured",
      provider: "ses",
      inbound_domains: this.#domains,
      raw_store: "s3",
      max_raw_bytes: this.#maxRawBytes,
    };
  }

  authenticate(token: string | null): boolean {
    return constantTimeTokenEquals(token, this.#ingestToken);
  }

  async ingest(input: unknown, store: CoreMailboxStorePort): Promise<EmailInboundIngestionResult> {
    const readiness = this.readiness();
    if (readiness.status !== "configured") {
      throw new EmailInboundError(readiness.reason ?? "Inbound email provider is not configured.", "provider_misconfigured", 503);
    }
    const event = inboundEventFromBody(input, "ses");
    if (!event.bucket || !event.key) {
      throw new EmailInboundError("bucket and key are required for SES inbound ingestion.", "raw_message_ref_required", 400);
    }
    if (event.bucket !== this.#rawBucket) {
      throw new EmailInboundError("SES inbound raw bucket does not match Core configuration.", "raw_bucket_mismatch", 400);
    }
    if (this.#rawPrefix && !event.key.startsWith(this.#rawPrefix)) {
      throw new EmailInboundError("SES inbound raw key is outside the configured prefix.", "raw_key_prefix_mismatch", 400);
    }
    const rawMime = await this.#readS3Object(event.bucket, event.key);
    return processInboundEvent({
      event,
      store,
      rawMime: enforceRawLimit(rawMime, this.#maxRawBytes),
      rawStorageProvider: "s3",
      rawRef: s3RawRef(event.bucket, event.key),
      inboundDomains: this.#domains,
    });
  }

  async readRawMessage(message: CoreEmailMessageRecord): Promise<Buffer | null> {
    if (message.raw_storage_provider !== "s3" || !message.raw_ref) return null;
    const parsed = parseS3RawRef(message.raw_ref);
    if (!parsed) return null;
    if (this.#rawBucket && parsed.bucket !== this.#rawBucket) return null;
    return enforceRawLimit(await this.#readS3Object(parsed.bucket, parsed.key), this.#maxRawBytes);
  }

  async #readS3Object(bucket: string, key: string): Promise<Buffer> {
    const result = await this.#s3().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = result.Body;
    if (!body) throw new EmailInboundError("Raw inbound message object has no body.", "raw_message_empty", 502);
    if (typeof (body as { transformToByteArray?: unknown }).transformToByteArray === "function") {
      return Buffer.from(await (body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray());
    }
    if (typeof (body as { transformToString?: unknown }).transformToString === "function") {
      return Buffer.from(await (body as { transformToString(): Promise<string> }).transformToString(), "utf8");
    }
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  #s3(): S3Client {
    this.#client ??= new S3Client({
      region: this.#region,
      ...(this.#endpoint ? { endpoint: this.#endpoint } : {}),
    });
    return this.#client;
  }
}

async function processInboundEvent(input: {
  event: NormalizedInboundEvent;
  store: CoreMailboxStorePort;
  rawMime: Buffer;
  rawStorageProvider: EmailInboundRawStorageProvider;
  rawRef: string;
  inboundDomains: string[];
}): Promise<EmailInboundIngestionResult> {
  const parsed = parseMime(input.rawMime.toString("utf8"));
  const { fromEmail, senderCandidates } = resolveSenderEmails(input.event);
  const threadingCandidates = threadingHeaderCandidates({
    inReplyTo: parsed.inReplyTo,
    references: parsed.references,
  });
  const results: EmailInboundRecipientResult[] = [];
  const seen = new Set<string>();

  for (const recipient of uniqueNonEmpty(input.event.recipients.map((value) => normalizeEmail(value)))) {
    const mailbox = await input.store.resolveMailboxByInboundAddress({
      address: recipient,
      inboundDomains: input.inboundDomains,
    });
    if (!mailbox) {
      results.push({ recipient, status: "dropped", reason: "recipient_not_resolvable" });
      continue;
    }
    if (seen.has(`${mailbox.mailbox_id}:${input.event.providerMessageId}`)) {
      results.push({ recipient, status: "duplicate", mailbox_id: mailbox.mailbox_id });
      continue;
    }
    seen.add(`${mailbox.mailbox_id}:${input.event.providerMessageId}`);
    if (mailbox.status !== "active") {
      results.push({ recipient, status: "dropped", reason: "mailbox_not_active", mailbox_id: mailbox.mailbox_id });
      continue;
    }
    if (!fromEmail) {
      results.push({ recipient, status: "dropped", reason: "sender_missing", mailbox_id: mailbox.mailbox_id });
      continue;
    }
    const replyCandidate = await input.store.findOutboundReplyCandidate({
      mailboxId: mailbox.mailbox_id,
      senderCandidates,
      threadingCandidates,
    });
    if (!replyCandidate) {
      results.push({ recipient, status: "dropped", reason: "sender_not_in_sent_history", mailbox_id: mailbox.mailbox_id });
      continue;
    }

    const stored = await input.store.storeInboundMessage({
      projectId: mailbox.project_id,
      mailboxId: mailbox.mailbox_id,
      fromAddress: fromEmail,
      toAddress: recipient,
      subject: parsed.subject,
      bodyText: parsed.bodyText,
      provider: input.event.provider,
      providerMessageId: input.event.providerMessageId,
      rawStorageProvider: input.rawStorageProvider,
      rawRef: input.rawRef,
      rawMime: input.rawStorageProvider === "inline" ? input.rawMime : null,
      inReplyToMessageId: replyCandidate.message_id,
      receivedAt: input.event.receiptTimestamp ?? new Date().toISOString(),
    });
    if (stored.created) {
      await input.store.enqueueWebhookDelivery({
        projectId: mailbox.project_id,
        mailboxId: mailbox.mailbox_id,
        eventType: "reply_received",
        discriminator: stored.message.message_id,
        payload: {
          mailbox_id: mailbox.mailbox_id,
          message_id: stored.message.message_id,
          from: fromEmail,
          body_text: parsed.bodyText,
          received_at: stored.message.received_at,
        },
      });
    }
    results.push({
      recipient,
      status: stored.created ? "accepted" : "duplicate",
      mailbox_id: mailbox.mailbox_id,
      message_id: stored.message.message_id,
    });
  }

  const accepted = results.filter((result) => result.status === "accepted").length;
  return {
    provider: input.event.provider,
    provider_message_id: input.event.providerMessageId,
    accepted_count: accepted,
    dropped_count: results.length - accepted,
    results,
  };
}

function inboundEventFromBody(body: unknown, expectedProvider: EmailInboundProviderName): NormalizedInboundEvent {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new EmailInboundError("request body must be a JSON object", "invalid_request", 400);
  }
  const record = body as Record<string, unknown>;
  const provider = optionalString(record.provider)?.toLowerCase() ?? expectedProvider;
  if (provider !== expectedProvider) {
    throw new EmailInboundError(`provider must be ${expectedProvider}`, "provider_mismatch", 400);
  }
  const sesLikeMail = objectRecord(record.mail);
  const sesLikeReceipt = objectRecord(record.receipt);
  const commonHeaders = objectRecord(record.common_headers) ?? objectRecord(sesLikeMail?.commonHeaders);
  const messageId = optionalString(record.ses_message_id) ??
    optionalString(record.provider_message_id) ??
    optionalString(record.message_id) ??
    optionalString(sesLikeMail?.messageId);
  if (!messageId) {
    throw new EmailInboundError("ses_message_id or provider_message_id is required.", "provider_message_id_required", 400);
  }
  const recipients = stringArray(record.recipients) ??
    stringArray(sesLikeReceipt?.recipients) ??
    stringArray(sesLikeMail?.destination);
  if (!recipients || recipients.length === 0) {
    throw new EmailInboundError("recipients must be a non-empty string array.", "recipients_required", 400);
  }
  return {
    provider: expectedProvider,
    providerMessageId: messageId,
    recipients,
    source: optionalString(record.source) ?? optionalString(sesLikeMail?.source) ?? null,
    commonFrom: firstString(commonHeaders?.from),
    receiptTimestamp: optionalString(record.receipt_timestamp) ?? optionalString(sesLikeMail?.timestamp) ?? null,
    bucket: optionalString(record.bucket),
    key: optionalString(record.key),
    rawMime: rawMimeFromRecord(record),
  };
}

export function parseMime(raw: string): ParsedMime {
  const normalized = raw.replace(/\r\n/g, "\n");
  const split = normalized.search(/\n\n/);
  const headersPart = split >= 0 ? normalized.slice(0, split) : normalized;
  const bodyPart = split >= 0 ? normalized.slice(split + 2) : "";
  const unfolded = headersPart.replace(/\n[ \t]+/g, " ");
  const headers: Record<string, string> = {};
  for (const line of unfolded.split("\n")) {
    const colon = line.indexOf(":");
    if (colon > 0) {
      const key = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      headers[key] = value;
    }
  }

  const subject = decodeHeader(headers.subject || "(no subject)");
  const inReplyTo = headers["in-reply-to"] || null;
  const references = headers.references || null;
  const contentType = (headers["content-type"] || "text/plain").toLowerCase();
  let bodyText = "";
  if (contentType.includes("multipart/")) {
    const boundaryMatch = contentType.match(/boundary="?([^";\s]+)"?/);
    bodyText = boundaryMatch ? extractTextFromMultipart(bodyPart, boundaryMatch[1]) : bodyPart;
  } else if (contentType.includes("text/html")) {
    bodyText = stripHtml(bodyPart);
  } else {
    bodyText = bodyPart;
  }
  bodyText = stripQuotedContent(bodyText).replace(/\r\n/g, "\n").trim();
  if (bodyText.length > 10_000) bodyText = `${bodyText.slice(0, 10_000)}\n[truncated]`;
  return { subject, bodyText, inReplyTo, references };
}

export function resolveSenderEmails(event: NormalizedInboundEvent): {
  fromEmail: string;
  senderCandidates: string[];
} {
  const headerEmail = extractEmailAddress(event.commonFrom ?? "");
  const envelopeEmail = extractEmailAddress(event.source ?? "");
  const fromEmail = headerEmail || envelopeEmail;
  return {
    fromEmail,
    senderCandidates: uniqueNonEmpty([fromEmail, headerEmail, envelopeEmail]),
  };
}

export function extractEmailAddress(value: string): string {
  const input = String(value || "").trim().toLowerCase();
  if (!input) return "";
  const bracketed = input.match(/<([^>]+)>/);
  const candidate = (bracketed?.[1] || input).trim();
  return /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(candidate) ? candidate : "";
}

export function threadingHeaderCandidates(input: { inReplyTo: string | null; references: string | null }): string[] {
  const candidates: string[] = [];
  for (const value of splitMessageIds(input.inReplyTo)) candidates.push(value);
  const references = splitMessageIds(input.references);
  for (let i = references.length - 1; i >= 0; i -= 1) candidates.push(references[i]);
  return uniqueNonEmpty(candidates);
}

function extractTextFromMultipart(body: string, boundary: string): string {
  const parts = body.split(`--${boundary}`);
  let plainText = "";
  let htmlText = "";
  for (const part of parts) {
    if (part.trim() === "--" || part.trim() === "") continue;
    const split = part.search(/\n\n/);
    if (split < 0) continue;
    const headers = part.slice(0, split).toLowerCase();
    const partBody = part.slice(split + 2);
    if (headers.includes("text/plain")) plainText = partBody;
    if (!plainText && headers.includes("text/html")) htmlText = partBody;
  }
  if (plainText) return plainText;
  if (htmlText) return stripHtml(htmlText);
  return body;
}

function stripQuotedContent(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  for (const line of lines) {
    if (/^on .+ wrote:$/i.test(line.trim())) break;
    if (/^-{2,}\s*original message/i.test(line.trim())) break;
    if (/^>/.test(line)) continue;
    result.push(line);
  }
  return result.join("\n");
}

function decodeHeader(value: string): string {
  return value.replace(/=\?([^?]+)\?([BQ])\?([^?]+)\?=/gi, (_match, _charset, encoding, text) => {
    if (String(encoding).toUpperCase() === "B") return Buffer.from(String(text), "base64").toString("utf8");
    return String(text)
      .replace(/_/g, " ")
      .replace(/=([0-9A-F]{2})/gi, (_inner, hex) => String.fromCharCode(Number.parseInt(String(hex), 16)));
  });
}

function splitMessageIds(value: string | null): string[] {
  return String(value || "")
    .split(/\s+/)
    .map((part) => part.replace(/[<>]/g, "").trim())
    .filter(Boolean);
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out = value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  return out.length > 0 ? out : null;
}

function firstString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.find((entry): entry is string => typeof entry === "string") ?? null;
  return null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function rawMimeFromRecord(record: Record<string, unknown>): Buffer | undefined {
  if (typeof record.raw_mime === "string") return Buffer.from(record.raw_mime, "utf8");
  if (typeof record.raw_mime_base64 === "string") return Buffer.from(record.raw_mime_base64, "base64");
  return undefined;
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function uniqueNonEmpty(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function splitDomains(value: string | undefined): string[] {
  return uniqueNonEmpty((value ?? "").split(",").map((domain) => domain.trim().toLowerCase()));
}

function cleanOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function constantTimeTokenEquals(candidate: string | null, expected: string | undefined): boolean {
  if (!candidate || !expected) return false;
  const candidateBytes = Buffer.from(candidate);
  const expectedBytes = Buffer.from(expected);
  if (candidateBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(candidateBytes, expectedBytes);
}

function enforceRawLimit(raw: Buffer, maxRawBytes: number): Buffer {
  if (raw.byteLength > maxRawBytes) {
    throw new EmailInboundError(`raw inbound email exceeds ${maxRawBytes} bytes`, "raw_message_too_large", 413);
  }
  return raw;
}

function inlineRawRef(providerMessageId: string, rawMime: Buffer): string {
  const digest = createHash("sha256").update(rawMime).digest("hex").slice(0, 16);
  return `inline:${providerMessageId}:${digest}`;
}

function s3RawRef(bucket: string, key: string): string {
  return JSON.stringify({ bucket, key });
}

function parseS3RawRef(rawRef: string): { bucket: string; key: string } | null {
  try {
    const parsed = JSON.parse(rawRef) as { bucket?: unknown; key?: unknown };
    if (typeof parsed.bucket === "string" && typeof parsed.key === "string") return { bucket: parsed.bucket, key: parsed.key };
  } catch {
    return null;
  }
  return null;
}

export type { StoreInboundMessageInput };
