/**
 * The standing relay connection: one WebSocket per (relay, client key) shared
 * by every request, replies matched by `e` tag, a handshake refusal (HTTP
 * 429, as relay.getalby.com answers a client that reconnects per request)
 * surfacing as RELAY_UNREACHABLE and holding further connects briefly, a
 * timeout that names the side that went quiet, a dropped connection failing
 * in-flight requests then reconnecting, and an idle connection closing itself.
 * The fake relay below also plays the wallet: it decrypts requests and answers
 * under the wallet key.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
  NWC_RESPONSE_KIND,
  NwcError,
  createNwcRelayPool,
  nip44ConversationKey,
  nip44Decrypt,
  nip44Encrypt,
  nwcRequest,
  parseNwcUri,
  signNwcEvent,
  type NwcNostrEvent,
  type NwcRelayPool,
  type NwcWebSocketConstructor,
} from "./index.js";

const walletSecret = "0000000000000000000000000000000000000000000000000000000000000002";
const walletPub = Buffer.from(schnorr.getPublicKey(Buffer.from(walletSecret, "hex"))).toString("hex");
const clientSecret = "0000000000000000000000000000000000000000000000000000000000000001";

interface FakeRelay {
  url: string;
  connections: number;
  events: number;
  sockets: Set<WebSocket>;
  refuse: boolean;
  /** `wallet_silent`: the relay acknowledges and the wallet never answers; `relay_silent`: nothing comes back at all. */
  silence: "none" | "wallet_silent" | "relay_silent";
  close(): Promise<void>;
}

async function startRelay(): Promise<FakeRelay> {
  const relay: FakeRelay = { url: "", connections: 0, events: 0, sockets: new Set(), refuse: false, silence: "none", close: async () => undefined };
  const server: Server = createServer((_req, res) => { res.statusCode = 404; res.end(); });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (relay.refuse) {
      socket.write("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      relay.connections += 1;
      relay.sockets.add(ws);
      let subId: string | null = null;
      ws.on("close", () => relay.sockets.delete(ws));
      ws.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as unknown[];
        if (message[0] === "REQ") { subId = String(message[1]); ws.send(JSON.stringify(["EOSE", subId])); return; }
        if (message[0] !== "EVENT") return;
        relay.events += 1;
        const request = message[1] as NwcNostrEvent;
        if (relay.silence === "relay_silent") return;
        ws.send(JSON.stringify(["OK", request.id, true, ""]));
        if (relay.silence === "wallet_silent") return;
        const key = nip44ConversationKey(walletSecret, request.pubkey);
        const body = JSON.parse(nip44Decrypt(key, request.content)) as { method: string; params: Record<string, unknown> };
        const reply = body.method === "lookup_invoice"
          ? { result_type: body.method, result: { payment_hash: body.params["payment_hash"], state: "settled", settled_at: 1_789_373_981 } }
          : { result_type: body.method, result: { alias: "fake", methods: ["lookup_invoice"] } };
        const content = nip44Encrypt(key, JSON.stringify(reply));
        const event = signNwcEvent(walletSecret, NWC_RESPONSE_KIND, [["p", request.pubkey], ["e", request.id]], content);
        setTimeout(() => { if (subId) ws.send(JSON.stringify(["EVENT", subId, event])); }, 5);
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  relay.url = `ws://127.0.0.1:${port}`;
  relay.close = async () => {
    for (const ws of relay.sockets) ws.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return relay;
}

// The `ws` client keeps the refused handshake's HTTP status in its error message.
const wsPool = (): NwcRelayPool => createNwcRelayPool({ WebSocket: WebSocket as unknown as NwcWebSocketConstructor, idleCloseMs: 120_000 });

describe("standing relay connection", () => {
  const pools: NwcRelayPool[] = [];
  const pool = (p: NwcRelayPool = wsPool()): NwcRelayPool => { pools.push(p); return p; };
  after(() => { for (const p of pools) p.close(); });

  it("shares one socket across many requests and matches replies by e tag", async () => {
    const relay = await startRelay();
    const p = pool();
    try {
      const connection = parseNwcUri(`nostr+walletconnect://${walletPub}?relay=${relay.url}&secret=${clientSecret}`);
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, i) => nwcRequest<Record<string, unknown>>(connection, "lookup_invoice", { payment_hash: `${String(i).padStart(2, "0")}`.repeat(32) }, { timeoutMs: 5_000, transport: p.transport })),
      );
      results.forEach((r, i) => assert.equal(r["payment_hash"], `${String(i).padStart(2, "0")}`.repeat(32)));
      for (let i = 0; i < 8; i++) {
        const r = await nwcRequest<Record<string, unknown>>(connection, "get_info", {}, { timeoutMs: 5_000, transport: p.transport });
        assert.equal(r["alias"], "fake");
      }
      assert.equal(relay.connections, 1, "one handshake for 20 requests");
      assert.equal(relay.events, 20);
    } finally {
      p.close();
      await relay.close();
    }
  });

  it("surfaces a 429 handshake as RELAY_UNREACHABLE and holds the next connect", async () => {
    const relay = await startRelay();
    const p = pool();
    try {
      relay.refuse = true;
      const connection = parseNwcUri(`nostr+walletconnect://${walletPub}?relay=${relay.url}&secret=${clientSecret}`);
      await assert.rejects(nwcRequest(connection, "get_info", {}, { timeoutMs: 3_000, transport: p.transport }), (e: unknown) => e instanceof NwcError && e.code === "RELAY_UNREACHABLE" && /429/.test(e.message));
      relay.refuse = false;
      // Inside the hold window the client does not even try the relay.
      await assert.rejects(nwcRequest(connection, "get_info", {}, { timeoutMs: 3_000, transport: p.transport }), (e: unknown) => e instanceof NwcError && e.code === "RELAY_UNREACHABLE" && /holding/.test(e.message));
      assert.equal(relay.connections, 0);
    } finally {
      p.close();
      await relay.close();
    }
  });

  it("tells a wallet that never answered (TIMEOUT) from a relay that never acknowledged (RELAY_TIMEOUT)", async () => {
    const relay = await startRelay();
    const p = pool();
    try {
      const connection = parseNwcUri(`nostr+walletconnect://${walletPub}?relay=${relay.url}&secret=${clientSecret}`);
      relay.silence = "wallet_silent";
      await assert.rejects(nwcRequest(connection, "make_invoice", { amount: 1_000 }, { timeoutMs: 300, transport: p.transport }), (e: unknown) => e instanceof NwcError && e.code === "TIMEOUT" && /relay accepted/.test(e.message));
      relay.silence = "relay_silent";
      await assert.rejects(nwcRequest(connection, "make_invoice", { amount: 1_000 }, { timeoutMs: 300, transport: p.transport }), (e: unknown) => e instanceof NwcError && e.code === "RELAY_TIMEOUT");
      relay.silence = "none";
      const r = await nwcRequest<Record<string, unknown>>(connection, "get_info", {}, { timeoutMs: 5_000, transport: p.transport });
      assert.equal(r["alias"], "fake", "the same socket still serves once both sides answer");
      assert.equal(relay.connections, 1);
    } finally {
      p.close();
      await relay.close();
    }
  });

  it("fails in-flight requests when the relay drops the socket, then reconnects", async () => {
    const relay = await startRelay();
    const p = pool();
    try {
      const connection = parseNwcUri(`nostr+walletconnect://${walletPub}?relay=${relay.url}&secret=${clientSecret}`);
      const first = await nwcRequest<Record<string, unknown>>(connection, "get_info", {}, { timeoutMs: 5_000, transport: p.transport });
      assert.equal(first["alias"], "fake");
      for (const ws of relay.sockets) ws.terminate();
      await new Promise((r) => setTimeout(r, 50));
      const second = await nwcRequest<Record<string, unknown>>(connection, "get_info", {}, { timeoutMs: 5_000, transport: p.transport });
      assert.equal(second["alias"], "fake");
      assert.equal(relay.connections, 2, "reconnected once after the drop");
    } finally {
      p.close();
      await relay.close();
    }
  });
  it("works through Node's global WebSocket when no constructor is passed", async () => {
    const relay = await startRelay();
    const p = pool(createNwcRelayPool());
    try {
      const connection = parseNwcUri(`nostr+walletconnect://${walletPub}?relay=${relay.url}&secret=${clientSecret}`);
      const r = await nwcRequest<Record<string, unknown>>(connection, "get_info", {}, { timeoutMs: 5_000, transport: p.transport });
      assert.equal(r["alias"], "fake");
    } finally {
      p.close();
      await relay.close();
    }
  });

  it("closes an idle connection and reconnects on the next request", async () => {
    const relay = await startRelay();
    const p = pool(createNwcRelayPool({ WebSocket: WebSocket as unknown as NwcWebSocketConstructor, idleCloseMs: 50 }));
    try {
      const connection = parseNwcUri(`nostr+walletconnect://${walletPub}?relay=${relay.url}&secret=${clientSecret}`);
      await nwcRequest(connection, "get_info", {}, { timeoutMs: 5_000, transport: p.transport });
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(relay.sockets.size, 0, "the idle connection closed itself");
      await nwcRequest(connection, "get_info", {}, { timeoutMs: 5_000, transport: p.transport });
      assert.equal(relay.connections, 2);
    } finally {
      p.close();
      await relay.close();
    }
  });
});
