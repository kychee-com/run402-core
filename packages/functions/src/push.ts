/**
 * `push` namespace — send a web push notification to the phones and browsers
 * signed up to this project's app.
 *
 * ```ts
 * import { push } from "@run402/functions";
 *
 * await push.send({
 *   title: "Your order shipped",
 *   body: "Arrives Thursday",
 *   url: "/orders/123",
 *   to: { user_id: order.user_id },
 * });
 * ```
 *
 * A browser signs up from the app's own pages through the platform's browser
 * helper (`<script src="/_run402/push.js">`, then `Run402Push.subscribe()`),
 * which records the subscription against the signed-in user. This call only
 * queues the message: the platform encrypts it for each subscribed device,
 * delivers it to each browser's push service, and drops subscriptions the
 * push service says are gone. `url` is a path on the app; the platform
 * resolves it against the origin each phone signed up on.
 *
 * **Policy lives on the gateway.** Field limits (`title` 1–100 characters,
 * `body` ≤ 1000, `tag` ≤ 64) and the organization's daily delivery cap are
 * enforced server-side only; this call sends the known keys as given and a
 * rejection comes back as a {@link Run402PushError} carrying the gateway's
 * `code`, never a locally rewritten or dropped message.
 *
 * **Run402 Cloud only.** On a host without the push routes (Run402 Core) the
 * call throws `Run402PushError` with `code: "PUSH_UNSUPPORTED"` instead of a
 * generic network error or a silent success.
 */

import { config } from "./config.js";

export interface PushSendOptions {
  /** 1–100 characters (checked server-side). */
  title: string;
  /** At most 1000 characters. */
  body?: string;
  /** A path on the app the notification opens; default `"/"`. */
  url?: string;
  /** At most 64 characters. A newer message with the same tag replaces the older one on the phone. */
  tag?: string;
  /** Reach one user's phones. Omit to reach every phone signed up to the project. */
  to?: { user_id: string };
}

/** A `next_actions[]` entry — platform-synthesized, never app-supplied. */
export interface PushNextAction {
  type: string;
  method?: string;
  path?: string;
  why?: string;
  [key: string]: unknown;
}

/**
 * The queued message. `status` is `"no_subscribers"` (HTTP 200, `devices: 0`)
 * when nobody the message addresses has a phone signed up, `"queued"`
 * (HTTP 202) otherwise; `devices` counts the subscriptions it will reach.
 */
export interface PushSendResult {
  message_id: string;
  status: "queued" | "no_subscribers";
  devices: number;
  next_actions?: PushNextAction[];
}

/**
 * Structured error thrown by `push.send()`. A faithful passthrough of the
 * gateway's error envelope, or a local code when no request could be made.
 *
 * Common `code` values:
 *   - `VALIDATION_FAILED` (400) — a field is missing, empty, or too long.
 *   - `QUOTA_EXCEEDED` (403) — the organization's daily delivery cap is
 *     reached; `details` carries
 *     `{ resource: "push_deliveries_per_day", used, limit, resets_at }`.
 *   - `RATE_LIMITED` (429) — the daily delivery cap is reached on the top
 *     tier, where no upgrade raises it; retry after `Retry-After`.
 *   - `AUTH_REQUIRED` (401) / `FORBIDDEN` (403) — the service key is missing
 *     or does not belong to this project.
 *   - `PUSH_UNSUPPORTED` — this host does not serve the push routes (Run402
 *     Core); push notifications need Run402 Cloud.
 *   - `PROJECT_ID_MISSING` — `RUN402_PROJECT_ID` is not set (outside a
 *     deployed function); no request was made, `status` is `null`.
 *
 * Branch on `err.code` / `err.status` / `err.details`, not on `message`.
 */
export class Run402PushError extends Error {
  readonly code: string;
  /** HTTP status, or `null` when no request was made. */
  readonly status: number | null;
  /** `details` from the gateway's error envelope, when present. */
  readonly details: Record<string, unknown> | undefined;
  /** `next_actions` from the gateway's error envelope, when present. */
  readonly next_actions: PushNextAction[] | undefined;
  /** Full response body — parsed object, or the raw string when unparseable. */
  readonly body: unknown;

  constructor(
    code: string,
    message: string,
    fields: {
      status?: number | null;
      details?: Record<string, unknown>;
      next_actions?: PushNextAction[];
      body?: unknown;
    } = {},
  ) {
    super(message);
    this.name = "Run402PushError";
    this.code = code;
    this.status = fields.status ?? null;
    this.details = fields.details;
    this.next_actions = fields.next_actions;
    this.body = fields.body;
  }
}

/**
 * A host without the push routes. Run402 Core answers `404 { error: "not_found" }`
 * with no `code`; a Cloud gateway's catch-all is
 * `404 { code: "RESOURCE_NOT_FOUND", message: "Cannot POST /…" }`.
 */
function looksLikeMissingRoute(status: number, body: unknown): boolean {
  if (status === 405 || status === 501) return true;
  if (status !== 404) return false;
  if (!body || typeof body !== "object") return true;
  const obj = body as Record<string, unknown>;
  if (typeof obj.code !== "string") return true;
  const message = typeof obj.message === "string" ? obj.message : typeof obj.error === "string" ? obj.error : "";
  return /^Cannot (GET|POST|DELETE|PUT|PATCH) \//.test(message);
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function errorFromResponse(status: number, body: unknown): Run402PushError {
  if (looksLikeMissingRoute(status, body)) {
    return new Run402PushError(
      "PUSH_UNSUPPORTED",
      "push.send: push notifications need Run402 Cloud; this host does not serve the push routes",
      { status, body },
    );
  }
  const obj = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const code =
    typeof obj.code === "string" && obj.code !== ""
      ? obj.code
      : typeof obj.error === "string" && obj.error !== ""
        ? obj.error
        : `HTTP_${status}`;
  const message =
    typeof obj.message === "string" && obj.message !== ""
      ? obj.message
      : typeof obj.error === "string" && obj.error !== ""
        ? obj.error
        : typeof body === "string" && body !== ""
          ? body
          : `HTTP ${status}`;
  return new Run402PushError(code, `push.send failed (${status}): ${message}`, {
    status,
    details:
      obj.details && typeof obj.details === "object" && !Array.isArray(obj.details)
        ? (obj.details as Record<string, unknown>)
        : undefined,
    next_actions: Array.isArray(obj.next_actions) ? (obj.next_actions as PushNextAction[]) : undefined,
    body,
  });
}

export const push = {
  /**
   * Queue a notification for this project's subscribed phones — every one, or
   * one user's with `to: { user_id }`.
   *
   * Resolves on HTTP 202 (`status: "queued"`) and 200
   * (`status: "no_subscribers"`); throws {@link Run402PushError} otherwise.
   * Delivery to each phone happens after this returns.
   */
  async send(options: PushSendOptions): Promise<PushSendResult> {
    const projectId = config.PROJECT_ID;
    if (!projectId) {
      throw new Run402PushError(
        "PROJECT_ID_MISSING",
        "push.send: RUN402_PROJECT_ID is not set; this helper runs inside a deployed function (or set it for local runs)",
      );
    }

    // Only the known keys go on the wire.
    const body: Record<string, unknown> = { title: options.title };
    if (options.body !== undefined) body.body = options.body;
    if (options.url !== undefined) body.url = options.url;
    if (options.tag !== undefined) body.tag = options.tag;
    if (options.to !== undefined) body.to = { user_id: options.to.user_id };

    const res = await fetch(`${config.API_BASE}/projects/v1/${encodeURIComponent(projectId)}/push/messages`, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + config.SERVICE_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw errorFromResponse(res.status, await readBody(res));
    return res.json() as Promise<PushSendResult>;
  },
};
