/**
 * The standing relay connection: one WebSocket per (relay, client key),
 * shared by every request and kept open while there is traffic. The Alby
 * relay answers HTTP 429 to a client that opens a fresh connection per
 * request (about 16 in 30 s), so a request is one message on a standing
 * connection, never a handshake. One subscription (`#p` = our pubkey, kind
 * 23195) covers every reply; replies are matched to their request by `e` tag.
 * A dropped connection fails the in-flight requests with `RELAY_CLOSED` and
 * the next request reconnects; a connect failure (429, DNS, refused, handshake
 * timeout) is remembered for a short hold so a poll loop cannot hammer a relay
 * that just refused us. Idle connections close themselves.
 *
 * A timeout says which side went quiet. The relay acknowledges every EVENT
 * with `OK` (NIP-01), so a request the relay accepted and the wallet never
 * answered is `TIMEOUT` (the relay is up; the wallet service or its node is
 * not), and a request the relay never acknowledged is `RELAY_TIMEOUT`.
 *
 * The socket is any WHATWG-shaped WebSocket: Node 22's global one by default,
 * or one the creator passes (the `ws` package keeps the HTTP status of a
 * refused handshake in its error message).
 */
import { randomBytes } from "node:crypto";

import { NwcError } from "./errors.js";
import { NWC_RESPONSE_KIND, type NwcNostrEvent } from "./events.js";
import type { NwcConnection } from "./uri.js";

const SOCKET_OPEN = 1;

/** The part of the WHATWG WebSocket this client uses. */
export interface NwcSocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "message" | "error" | "close", listener: (event: unknown) => void): void;
}

export type NwcWebSocketConstructor = new (url: string) => NwcSocket;

/** Publishes one request event and resolves with the first kind-23195 reply that references it. */
export type NwcTransport = (connection: NwcConnection, request: NwcNostrEvent, timeoutMs: number) => Promise<NwcNostrEvent>;

export interface NwcRelayPoolOptions {
  /** Close a connection this long after its last reply (default 1 500 ms, so a one-shot process exits promptly). */
  idleCloseMs?: number;
  /** After a failed connect, refuse new connects to that relay for this long (default 5 000 ms). */
  connectHoldMs?: number;
  /** Give up on a handshake after this long, capped by the request's own timeout (default 10 000 ms). */
  handshakeTimeoutMs?: number;
  /** The WebSocket constructor (default: the global `WebSocket`). */
  WebSocket?: NwcWebSocketConstructor;
}

export interface NwcRelayPool {
  readonly transport: NwcTransport;
  /** Closes every connection; in-flight requests fail `RELAY_CLOSED`. The pool stays usable. */
  close(): void;
}

interface PendingReply {
  resolve: (event: NwcNostrEvent) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  relayAccepted: boolean;
}

interface ResolvedOptions {
  idleCloseMs: number;
  connectHoldMs: number;
  handshakeTimeoutMs: number;
  WebSocket: NwcWebSocketConstructor | undefined;
}

function socketErrorMessage(event: unknown): string {
  const e = event as { message?: unknown; error?: { message?: unknown } } | null;
  if (typeof e?.message === "string" && e.message) return e.message;
  if (typeof e?.error?.message === "string" && e.error.message) return e.error.message;
  return "relay connection failed";
}

class RelayConnection {
  private socket: NwcSocket | null = null;
  private opening: Promise<NwcSocket> | null = null;
  private readonly pending = new Map<string, PendingReply>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastConnectFailureAt = 0;
  private readonly subId = randomBytes(8).toString("hex");

  constructor(private readonly relayUrl: string, private readonly clientPubkey: string, private readonly options: ResolvedOptions) {}

  async send(request: NwcNostrEvent, timeoutMs: number): Promise<NwcNostrEvent> {
    const socket = await this.connected(timeoutMs);
    return new Promise<NwcNostrEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        const accepted = this.pending.get(request.id)?.relayAccepted ?? false;
        this.pending.delete(request.id);
        this.armIdle();
        reject(accepted
          ? new NwcError("TIMEOUT", "the relay accepted the request; no wallet response within the timeout")
          : new NwcError("RELAY_TIMEOUT", "the relay did not acknowledge the request within the timeout"));
      }, timeoutMs);
      this.pending.set(request.id, { resolve, reject, timer, relayAccepted: false });
      this.disarmIdle();
      try {
        socket.send(JSON.stringify(["EVENT", request]));
      } catch (error) {
        this.settle(request.id, new NwcError("RELAY_CLOSED", error instanceof Error ? error.message : "send failed"));
      }
    });
  }

  close(): void {
    this.disarmIdle();
    const socket = this.socket;
    this.socket = null;
    this.opening = null;
    if (socket) { try { socket.close(); } catch { /* already closed */ } }
    this.failAll(new NwcError("RELAY_CLOSED", "relay connection closed"));
  }

  private settle(requestId: string, error: Error | null, event?: NwcNostrEvent): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    this.pending.delete(requestId);
    clearTimeout(entry.timer);
    if (error) entry.reject(error); else entry.resolve(event as NwcNostrEvent);
    if (this.pending.size === 0) this.armIdle();
  }

  private failAll(error: Error): void {
    for (const id of [...this.pending.keys()]) this.settle(id, error);
  }

  private armIdle(): void {
    this.disarmIdle();
    this.idleTimer = setTimeout(() => this.close(), this.options.idleCloseMs);
    this.idleTimer.unref?.();
  }

  private disarmIdle(): void {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
  }

  private connected(timeoutMs: number): Promise<NwcSocket> {
    if (this.socket && this.socket.readyState === SOCKET_OPEN) return Promise.resolve(this.socket);
    if (this.opening) return this.opening;
    if (Date.now() - this.lastConnectFailureAt < this.options.connectHoldMs) {
      return Promise.reject(new NwcError("RELAY_UNREACHABLE", "relay refused a connection moments ago; holding"));
    }
    const Socket = this.options.WebSocket;
    if (!Socket) return Promise.reject(new NwcError("RELAY_UNREACHABLE", "no WebSocket implementation is available"));
    this.opening = new Promise<NwcSocket>((resolve, reject) => {
      let opened = false;
      let failed = false;
      const fail = (message: string): void => {
        if (opened || failed) return;
        failed = true;
        clearTimeout(handshake);
        this.lastConnectFailureAt = Date.now();
        this.opening = null;
        reject(new NwcError("RELAY_UNREACHABLE", message));
      };
      let socket: NwcSocket;
      try {
        socket = new Socket(this.relayUrl);
      } catch (error) {
        this.lastConnectFailureAt = Date.now();
        this.opening = null;
        reject(new NwcError("RELAY_UNREACHABLE", error instanceof Error ? error.message : "cannot open relay"));
        return;
      }
      const handshake = setTimeout(() => {
        fail("relay handshake timed out");
        try { socket.close(); } catch { /* never opened */ }
      }, Math.min(timeoutMs, this.options.handshakeTimeoutMs));
      socket.addEventListener("open", () => {
        if (failed) return;
        opened = true;
        clearTimeout(handshake);
        this.socket = socket;
        this.opening = null;
        socket.send(JSON.stringify(["REQ", this.subId, { kinds: [NWC_RESPONSE_KIND], "#p": [this.clientPubkey], since: Math.floor(Date.now() / 1000) - 60 }]));
        resolve(socket);
      });
      socket.addEventListener("message", (event) => this.onMessage(String((event as { data?: unknown }).data)));
      socket.addEventListener("error", (event) => fail(socketErrorMessage(event)));
      socket.addEventListener("close", () => {
        if (this.socket === socket) this.socket = null;
        fail("relay closed during handshake");
        if (opened) this.failAll(new NwcError("RELAY_CLOSED", "relay closed the connection"));
      });
    });
    return this.opening;
  }

  private onMessage(raw: string): void {
    let message: unknown;
    try { message = JSON.parse(raw); } catch { return; }
    if (!Array.isArray(message)) return;
    if (message[0] === "EVENT" && message[1] === this.subId && message[2] && typeof message[2] === "object") {
      const event = message[2] as NwcNostrEvent;
      if (event.kind !== NWC_RESPONSE_KIND || !Array.isArray(event.tags)) return;
      const ref = event.tags.find((t) => t[0] === "e" && typeof t[1] === "string");
      if (ref && ref[1] !== undefined) this.settle(ref[1], null, event);
      return;
    }
    if (message[0] === "OK") {
      this.onOk(message);
      return;
    }
    if (message[0] === "CLOSED" && message[1] === this.subId) {
      this.failAll(new NwcError("RELAY_CLOSED", typeof message[2] === "string" ? message[2] : "relay closed the subscription"));
      this.close();
    }
  }

  /** The relay's acknowledgement of one EVENT: `false` refuses it, `true` marks it delivered to the relay. */
  private onOk(message: unknown[]): void {
    if (typeof message[1] !== "string") return;
    if (message[2] === false) {
      this.settle(message[1], new NwcError("RELAY_REJECTED", typeof message[3] === "string" ? message[3] : "relay rejected the request"));
      return;
    }
    const entry = message[2] === true ? this.pending.get(message[1]) : undefined;
    if (entry) entry.relayAccepted = true;
  }
}

export function createNwcRelayPool(options: NwcRelayPoolOptions = {}): NwcRelayPool {
  const resolved: ResolvedOptions = {
    idleCloseMs: options.idleCloseMs ?? 1_500,
    connectHoldMs: options.connectHoldMs ?? 5_000,
    handshakeTimeoutMs: options.handshakeTimeoutMs ?? 10_000,
    WebSocket: options.WebSocket ?? (globalThis as { WebSocket?: NwcWebSocketConstructor }).WebSocket,
  };
  const connections = new Map<string, RelayConnection>();
  const transport: NwcTransport = (connection, request, timeoutMs) => {
    const key = `${connection.relayUrl}|${request.pubkey}`;
    let relay = connections.get(key);
    if (!relay) {
      relay = new RelayConnection(connection.relayUrl, request.pubkey, resolved);
      connections.set(key, relay);
    }
    return relay.send(request, timeoutMs);
  };
  return {
    transport,
    close(): void {
      for (const relay of connections.values()) relay.close();
      connections.clear();
    },
  };
}
