import type { CoreMailboxStorePort, CoreWebhookDeliveryRecord } from "./postgres-mailboxes.js";

export interface WebhookDeliveryConfig {
  enabled: boolean;
  intervalMs: number;
  batchSize: number;
  timeoutMs: number;
  leaseMs: number;
  maxAttempts: number;
  retryBaseMs: number;
  retryMaxMs: number;
}

export interface WebhookDeliveryAttemptResult {
  delivery_id: string;
  status: "delivered" | "retrying" | "failed_permanent";
  http_status: number | null;
  error: string | null;
}

export interface WebhookDeliveryDrainResult {
  claimed: number;
  results: WebhookDeliveryAttemptResult[];
}

export const DEFAULT_WEBHOOK_DELIVERY_CONFIG: WebhookDeliveryConfig = {
  enabled: true,
  intervalMs: 1_000,
  batchSize: 10,
  timeoutMs: 10_000,
  leaseMs: 60_000,
  maxAttempts: 8,
  retryBaseMs: 5_000,
  retryMaxMs: 5 * 60_000,
};

export function webhookDeliveryConfigFromEnv(env: NodeJS.ProcessEnv = process.env): WebhookDeliveryConfig {
  return {
    enabled: env.CORE_WEBHOOK_DELIVERY_ENABLED === undefined ? true : env.CORE_WEBHOOK_DELIVERY_ENABLED !== "0" && env.CORE_WEBHOOK_DELIVERY_ENABLED !== "false",
    intervalMs: parsePositiveInteger(env.CORE_WEBHOOK_DELIVERY_INTERVAL_MS, DEFAULT_WEBHOOK_DELIVERY_CONFIG.intervalMs),
    batchSize: parsePositiveInteger(env.CORE_WEBHOOK_DELIVERY_BATCH_SIZE, DEFAULT_WEBHOOK_DELIVERY_CONFIG.batchSize),
    timeoutMs: parsePositiveInteger(env.CORE_WEBHOOK_DELIVERY_TIMEOUT_MS, DEFAULT_WEBHOOK_DELIVERY_CONFIG.timeoutMs),
    leaseMs: parsePositiveInteger(env.CORE_WEBHOOK_DELIVERY_LEASE_MS, DEFAULT_WEBHOOK_DELIVERY_CONFIG.leaseMs),
    maxAttempts: parsePositiveInteger(env.CORE_WEBHOOK_DELIVERY_MAX_ATTEMPTS, DEFAULT_WEBHOOK_DELIVERY_CONFIG.maxAttempts),
    retryBaseMs: parsePositiveInteger(env.CORE_WEBHOOK_DELIVERY_RETRY_BASE_MS, DEFAULT_WEBHOOK_DELIVERY_CONFIG.retryBaseMs),
    retryMaxMs: parsePositiveInteger(env.CORE_WEBHOOK_DELIVERY_RETRY_MAX_MS, DEFAULT_WEBHOOK_DELIVERY_CONFIG.retryMaxMs),
  };
}

export class CoreWebhookDeliveryWorker {
  readonly #store: CoreMailboxStorePort;
  readonly #config: WebhookDeliveryConfig;
  readonly #fetch: typeof fetch;
  #timer: NodeJS.Timeout | null = null;
  #running = false;

  constructor(input: { store: CoreMailboxStorePort; config?: Partial<WebhookDeliveryConfig>; fetch?: typeof fetch }) {
    this.#store = input.store;
    this.#config = { ...DEFAULT_WEBHOOK_DELIVERY_CONFIG, ...input.config };
    this.#fetch = input.fetch ?? fetch;
  }

  start(): void {
    if (!this.#config.enabled || this.#timer) return;
    this.#timer = setInterval(() => {
      void this.drainOnce().catch((error: unknown) => {
        console.error("Run402 Core webhook delivery drain failed", error);
      });
    }, this.#config.intervalMs);
    this.#timer.unref?.();
    void this.drainOnce().catch((error: unknown) => {
      console.error("Run402 Core webhook delivery initial drain failed", error);
    });
  }

  stop(): void {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }

  async drainOnce(now = new Date()): Promise<WebhookDeliveryDrainResult> {
    if (this.#running || !this.#config.enabled) return { claimed: 0, results: [] };
    this.#running = true;
    try {
      return await drainWebhookDeliveries({
        store: this.#store,
        config: this.#config,
        fetch: this.#fetch,
        now,
      });
    } finally {
      this.#running = false;
    }
  }
}

export async function drainWebhookDeliveries(input: {
  store: CoreMailboxStorePort;
  config?: Partial<WebhookDeliveryConfig>;
  fetch?: typeof fetch;
  now?: Date;
}): Promise<WebhookDeliveryDrainResult> {
  const config = { ...DEFAULT_WEBHOOK_DELIVERY_CONFIG, ...input.config };
  if (!config.enabled) return { claimed: 0, results: [] };
  const now = input.now ?? new Date();
  const fetchImpl = input.fetch ?? fetch;
  const deliveries = await input.store.claimDueWebhookDeliveries({
    limit: config.batchSize,
    leaseMs: config.leaseMs,
    now,
  });
  const results: WebhookDeliveryAttemptResult[] = [];
  for (const delivery of deliveries) {
    results.push(await deliverWebhook({ delivery, store: input.store, config, fetch: fetchImpl, now }));
  }
  return { claimed: deliveries.length, results };
}

async function deliverWebhook(input: {
  delivery: CoreWebhookDeliveryRecord;
  store: CoreMailboxStorePort;
  config: WebhookDeliveryConfig;
  fetch: typeof fetch;
  now: Date;
}): Promise<WebhookDeliveryAttemptResult> {
  const idempotencyKey = webhookIdempotencyKey(input.delivery);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.config.timeoutMs);
  try {
    const response = await input.fetch(input.delivery.target_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "run402-core-webhook-delivery/1",
        "X-Run402-Webhook-Delivery-Id": input.delivery.delivery_id,
        "X-Run402-Webhook-Event-Type": input.delivery.event_type,
        "X-Run402-Webhook-Idempotency-Key": idempotencyKey,
        "X-Run402-Webhook-Attempt": String(input.delivery.attempts),
      },
      body: JSON.stringify(input.delivery.payload),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (response.ok) {
      await input.store.markWebhookDeliveryDelivered({
        deliveryId: input.delivery.delivery_id,
        status: response.status,
        now: input.now,
      });
      return {
        delivery_id: input.delivery.delivery_id,
        status: "delivered",
        http_status: response.status,
        error: null,
      };
    }
    return await recordFailure({
      delivery: input.delivery,
      store: input.store,
      config: input.config,
      httpStatus: response.status,
      error: `HTTP ${response.status}`,
      now: input.now,
    });
  } catch (error) {
    clearTimeout(timeout);
    return await recordFailure({
      delivery: input.delivery,
      store: input.store,
      config: input.config,
      httpStatus: null,
      error: webhookErrorMessage(error),
      now: input.now,
    });
  }
}

async function recordFailure(input: {
  delivery: CoreWebhookDeliveryRecord;
  store: CoreMailboxStorePort;
  config: WebhookDeliveryConfig;
  httpStatus: number | null;
  error: string;
  now: Date;
}): Promise<WebhookDeliveryAttemptResult> {
  const retryDelayMs = retryDelayForAttempt(input.delivery.attempts, input.config);
  const updated = await input.store.markWebhookDeliveryFailed({
    deliveryId: input.delivery.delivery_id,
    status: input.httpStatus,
    error: input.error,
    maxAttempts: input.config.maxAttempts,
    retryDelayMs,
    now: input.now,
  });
  return {
    delivery_id: input.delivery.delivery_id,
    status: updated?.status === "failed_permanent" ? "failed_permanent" : "retrying",
    http_status: input.httpStatus,
    error: input.error,
  };
}

function webhookIdempotencyKey(delivery: CoreWebhookDeliveryRecord): string {
  if (isRecord(delivery.payload) && typeof delivery.payload.idempotency_key === "string") {
    return delivery.payload.idempotency_key;
  }
  return delivery.source_event_id;
}

function retryDelayForAttempt(attempts: number, config: WebhookDeliveryConfig): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(config.retryMaxMs, config.retryBaseMs * (2 ** exponent));
}

function webhookErrorMessage(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") return "Delivery timed out";
  if (error instanceof Error && error.message) return error.message;
  return "Delivery failed";
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
