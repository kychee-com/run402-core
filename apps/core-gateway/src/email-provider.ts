import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";

export type EmailProviderReadinessStatus = "configured" | "not_configured" | "misconfigured";

export interface EmailProviderReadiness {
  status: EmailProviderReadinessStatus;
  provider: "disabled" | "mock" | "ses";
  from_domain?: string;
  reason?: string;
}

export interface EmailProviderSendInput {
  fromAddress: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  rawMime?: Buffer;
}

export interface EmailProviderSendResult {
  provider: string;
  providerMessageId?: string;
  deliveryState: "accepted";
}

export class EmailProviderError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 502,
  ) {
    super(message);
    this.name = "EmailProviderError";
  }
}

export interface EmailProviderPort {
  readiness(): EmailProviderReadiness;
  sendRaw(input: EmailProviderSendInput): Promise<EmailProviderSendResult>;
}

export interface EmailProviderConfig {
  provider: string;
  fromDomain?: string;
  sesRegion?: string;
  sesEndpoint?: string;
}

export function emailProviderConfigFromEnv(env: NodeJS.ProcessEnv): EmailProviderConfig {
  return {
    provider: env.CORE_EMAIL_PROVIDER ?? "disabled",
    fromDomain: cleanOptional(env.CORE_EMAIL_FROM_DOMAIN),
    sesRegion: cleanOptional(env.CORE_EMAIL_SES_REGION ?? env.AWS_REGION),
    sesEndpoint: cleanOptional(env.CORE_EMAIL_SES_ENDPOINT),
  };
}

export function createEmailProvider(config: EmailProviderConfig): EmailProviderPort {
  const provider = config.provider.trim().toLowerCase();
  if (provider === "mock") {
    return new MockEmailProvider(config.fromDomain);
  }
  if (provider === "ses") {
    return new SesEmailProvider(config);
  }
  return new DisabledEmailProvider(provider === "disabled" || provider === "none"
    ? "CORE_EMAIL_PROVIDER is not configured."
    : `Unsupported CORE_EMAIL_PROVIDER: ${config.provider}`);
}

export class DisabledEmailProvider implements EmailProviderPort {
  constructor(private readonly reason: string) {}

  readiness(): EmailProviderReadiness {
    return {
      status: "not_configured",
      provider: "disabled",
      reason: this.reason,
    };
  }

  async sendRaw(): Promise<EmailProviderSendResult> {
    throw new EmailProviderError("Outbound email provider is not configured.", "provider_not_configured", 503);
  }
}

export class MockEmailProvider implements EmailProviderPort {
  readonly sent: EmailProviderSendInput[] = [];

  constructor(private readonly fromDomain = "run402-core.local") {}

  readiness(): EmailProviderReadiness {
    return {
      status: "configured",
      provider: "mock",
      from_domain: this.fromDomain,
    };
  }

  async sendRaw(input: EmailProviderSendInput): Promise<EmailProviderSendResult> {
    this.sent.push(input);
    return {
      provider: "mock",
      providerMessageId: `mock_${this.sent.length}`,
      deliveryState: "accepted",
    };
  }
}

class SesEmailProvider implements EmailProviderPort {
  readonly #fromDomain?: string;
  readonly #region?: string;
  readonly #endpoint?: string;
  #client?: SESv2Client;

  constructor(config: EmailProviderConfig) {
    this.#fromDomain = config.fromDomain;
    this.#region = config.sesRegion;
    this.#endpoint = config.sesEndpoint;
  }

  readiness(): EmailProviderReadiness {
    if (!this.#fromDomain) {
      return {
        status: "misconfigured",
        provider: "ses",
        reason: "CORE_EMAIL_FROM_DOMAIN is required when CORE_EMAIL_PROVIDER=ses.",
      };
    }
    if (!this.#region) {
      return {
        status: "misconfigured",
        provider: "ses",
        reason: "CORE_EMAIL_SES_REGION or AWS_REGION is required when CORE_EMAIL_PROVIDER=ses.",
      };
    }
    return {
      status: "configured",
      provider: "ses",
      from_domain: this.#fromDomain,
    };
  }

  async sendRaw(input: EmailProviderSendInput): Promise<EmailProviderSendResult> {
    const readiness = this.readiness();
    if (readiness.status !== "configured") {
      throw new EmailProviderError(readiness.reason ?? "SES provider is not configured.", "provider_misconfigured", 503);
    }
    try {
      const result = await this.#ses().send(new SendEmailCommand({
        FromEmailAddress: input.fromAddress,
        Destination: { ToAddresses: [input.to] },
        Content: input.rawMime
          ? { Raw: { Data: input.rawMime } }
          : {
              Simple: {
                Subject: { Data: input.subject, Charset: "UTF-8" },
                Body: {
                  Html: { Data: input.html, Charset: "UTF-8" },
                  Text: { Data: input.text, Charset: "UTF-8" },
                },
              },
            },
      }));
      return {
        provider: "ses",
        providerMessageId: result.MessageId,
        deliveryState: "accepted",
      };
    } catch (error) {
      throw providerError(error);
    }
  }

  #ses(): SESv2Client {
    this.#client ??= new SESv2Client({
      region: this.#region,
      ...(this.#endpoint ? { endpoint: this.#endpoint } : {}),
    });
    return this.#client;
  }
}

function providerError(error: unknown): EmailProviderError {
  if (error instanceof EmailProviderError) return error;
  const name = typeof error === "object" && error !== null && "name" in error
    ? String((error as { name?: unknown }).name)
    : "ProviderError";
  const message = error instanceof Error ? error.message : String(error);
  const status = providerErrorStatus(name);
  return new EmailProviderError(message, providerErrorCode(name), status);
}

function providerErrorStatus(name: string): number {
  if (/throttl|too.?many/i.test(name)) return 429;
  if (/reject|denied|not.?verified|sandbox|access/i.test(name)) return 502;
  return 502;
}

function providerErrorCode(name: string): string {
  if (/throttl|too.?many/i.test(name)) return "provider_rate_limited";
  if (/not.?verified|sandbox/i.test(name)) return "provider_sender_or_recipient_not_verified";
  if (/access|denied/i.test(name)) return "provider_access_denied";
  if (/reject/i.test(name)) return "provider_rejected";
  return "provider_send_failed";
}

function cleanOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
