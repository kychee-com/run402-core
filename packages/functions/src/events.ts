/**
 * `events` namespace — emit into the project's cursored event feed
 * (capability `project-events-client-surface`, gateway change
 * `app-events-emit-lane`).
 *
 * A `project_events` row is the platform's tier-1 fact log: deploys,
 * suspensions, transfers — and, through this namespace, an app's OWN
 * business facts too ("signature completed", "booking created"). Every
 * existing and future feed consumer (CLI `run402 events`, MCP, the operator
 * console) reads app events for free the moment code calls `events.emit`.
 *
 * ```ts
 * import { events } from "@run402/functions";
 *
 * await events.emit("signature_completed", { request_id, signer }, {
 *   idempotencyKey: `sig:${requestId}`,
 * });
 * ```
 *
 * **Vocabulary.** `type` MUST be flat snake_case matching
 * `/^[a-z][a-z0-9_]{2,63}$/` — no dots, no `app_` prefix. Platform-registered
 * type names (`deploy_activated`, `mailbox_suspended`, ...) are RESERVED: an
 * app cannot impersonate a platform fact. The gateway owns this policy —
 * grammar and the reservation list are validated SERVER-SIDE only. This SDK
 * sends `type` verbatim; a bad grammar or a reserved name comes back as a
 * `Run402EventsPlatformError` (400 `INVALID_EVENT_TYPE` /
 * `RESERVED_EVENT_TYPE`) rather than being caught, rewritten, or dropped
 * locally.
 *
 * **Idempotency.** Pass `idempotencyKey` on any code path that might run
 * more than once for the same real-world fact (webhook retries,
 * function-run retries, anything at-least-once). The gateway dedupes on
 * `(project_id, idempotency_key)` FOREVER — this is a durable identity for
 * the fact, not a short-lived retry-window token like an HTTP
 * `Idempotency-Key` header. Reusing a key days or years later still replays
 * the ORIGINAL stored event (`deduplicated: true`) instead of creating a
 * new one.
 *
 * @see openspec/changes/app-events-emit-lane/design.md (Canonical Agent Contract)
 */

import { config } from "./config.js";

export interface EventEmitOptions {
  /**
   * Durable identity for this fact. The gateway dedupes on
   * `(project_id, idempotency_key)` forever — reusing a key later still
   * replays the original event rather than creating a new one. Recommended
   * on every at-least-once code path (webhook handlers, function-run
   * retries, anything that might re-execute for the same occurrence).
   */
  idempotencyKey?: string;
}

/** A `next_actions[]` entry — platform-synthesized drill-down. Shape is
 *  intentionally loose; entries commonly carry `type` plus some subset of
 *  `method` / `path` / `command` / `why`. Never app-supplied — see the
 *  namespace doc comment. */
export type EventNextAction = Record<string, unknown>;

/**
 * The stored event, returned by both a fresh emit (HTTP `201`) and an
 * idempotent replay (HTTP `200`). Matches the shape the feed read routes
 * (`GET /projects/v1/:project_id/events`) render, so `cursor` from this
 * response can be handed straight to a feed consumer's `?cursor=` param.
 */
export interface EventEmitResult {
  /** Opaque feed position (`evc_...`). Pass to a feed read's `?cursor=` to
   *  resume just after this event. Never parse it. */
  cursor: string;
  event_type: string;
  /** Always `"app"` for events emitted through this namespace. */
  class: string;
  /** Always `"app"` for events emitted through this namespace. */
  source: string;
  payload: Record<string, unknown>;
  /** Present (and `true`) only when the payload exceeded the 8 KiB bound
   *  and was truncated at write time; omitted otherwise. */
  payload_truncated?: true;
  occurred_at: string;
  /** `true` when this call replayed a previously-stored event (same
   *  `idempotency_key`) instead of writing a new row. */
  deduplicated: boolean;
  next_actions: EventNextAction[];
  [key: string]: unknown;
}

/**
 * Structured error thrown by `events.emit()` on a non-2xx gateway response.
 * The gateway owns event-type grammar, platform-vocabulary reservation, and
 * the per-organization daily quota — this SDK never re-implements or masks
 * that policy locally; it surfaces exactly what the gateway decided.
 *
 * Common `code` values:
 *   - `INVALID_EVENT_TYPE` (400) — `type` fails `/^[a-z][a-z0-9_]{2,63}$/`.
 *   - `RESERVED_EVENT_TYPE` (400) — `type` names a platform-registered type.
 *   - `QUOTA_EXCEEDED` (403) — the organization's daily app-event quota is
 *     exhausted; `details` carries
 *     `{ resource: "events_per_day", scope, used, limit }`.
 *   - `FORBIDDEN` (403) — the service key does not belong to this project.
 *
 * Branch on `err.code` / `err.status` / `err.details`, not on `message`.
 */
export class Run402EventsPlatformError extends Error {
  readonly code: string;
  readonly status: number;
  /** `details` from the canonical error envelope, when present (e.g. the
   *  `{resource, scope, used, limit}` shape on a `QUOTA_EXCEEDED` denial). */
  readonly details: Record<string, unknown> | undefined;
  /** `next_actions` from the canonical error envelope, when present. */
  readonly next_actions: unknown[] | undefined;
  /** Full response body — parsed object, or the raw string when unparseable. */
  readonly body: unknown;

  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.name = "Run402EventsPlatformError";
    this.status = status;
    this.body = body;
    this.code = platformCode(body);
    this.details = platformDetails(body);
    this.next_actions = platformNextActions(body);
  }
}

function platformCode(body: unknown): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const code = record.code ?? record.error;
    if (typeof code === "string" && code.trim() !== "") return code;
  }
  return "events_platform_error";
}

function platformMessage(body: unknown): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const message = record.message ?? record.error;
    if (typeof message === "string" && message.trim() !== "") return message;
  }
  return "Run402 rejected the event.";
}

function platformDetails(body: unknown): Record<string, unknown> | undefined {
  if (body && typeof body === "object") {
    const details = (body as Record<string, unknown>).details;
    if (details && typeof details === "object" && !Array.isArray(details)) {
      return details as Record<string, unknown>;
    }
  }
  return undefined;
}

function platformNextActions(body: unknown): unknown[] | undefined {
  if (body && typeof body === "object") {
    const actions = (body as Record<string, unknown>).next_actions;
    if (Array.isArray(actions)) return actions;
  }
  return undefined;
}

async function readErrorBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text };
  }
}

export const events = {
  /**
   * Emit a fact into this project's event feed.
   *
   * The gateway owns vocabulary validation (grammar + platform-name
   * reservation), class stamping (`"app"`), namespacing, quota, and
   * `next_actions` synthesis — this call is a dumb pipe. `type` and
   * `payload` are sent exactly as given; a rejection surfaces as a thrown
   * {@link Run402EventsPlatformError}, never a locally-fabricated error or a
   * silently rewritten value.
   *
   * @param type - flat snake_case event type (`/^[a-z][a-z0-9_]{2,63}$/`),
   *   validated and reservation-checked server-side only.
   * @param payload - compact JSON fact (ids + verdict fields, never bodies
   *   or secrets). Bounded to 8 KiB server-side; oversize payloads are
   *   truncated (`payload_truncated: true` on the response) rather than
   *   rejected.
   * @param opts.idempotencyKey - durable dedup identity; see the namespace
   *   doc comment. Strongly recommended on at-least-once code paths.
   */
  async emit(
    type: string,
    payload?: Record<string, unknown>,
    opts?: EventEmitOptions,
  ): Promise<EventEmitResult> {
    const body: Record<string, unknown> = { event_type: type };
    if (payload !== undefined) body.payload = payload;
    if (opts?.idempotencyKey !== undefined) body.idempotency_key = opts.idempotencyKey;

    const res = await fetch(
      `${config.API_BASE}/projects/v1/${config.PROJECT_ID}/events`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + config.SERVICE_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      const errBody = await readErrorBody(res);
      throw new Run402EventsPlatformError(
        res.status,
        errBody,
        `Event emit failed (${res.status}): ${platformMessage(errBody)}`,
      );
    }
    return res.json() as Promise<EventEmitResult>;
  },
};
