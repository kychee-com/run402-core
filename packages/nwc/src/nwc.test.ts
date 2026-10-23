/**
 * NIP-44 v2 against the published vectors, and a NIP-47 round trip through a
 * fake relay that plays the wallet service (decrypts the request with the
 * wallet key, answers under it).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
  NWC_REQUEST_KIND,
  NWC_RESPONSE_KIND,
  NwcError,
  nip44CalcPaddedLen,
  nip44ConversationKey,
  nip44Decrypt,
  nip44Encrypt,
  nwcRequest,
  parseNwcUri,
  signNwcEvent,
  verifyNwcEvent,
  type NwcNostrEvent,
  type NwcTransport,
} from "./index.js";

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

describe("nip44 v2 vectors", () => {
  it("derives the conversation key", () => {
    assert.equal(hex(nip44ConversationKey("315e59ff51cb9209768cf7da80791ddcaae56ac9775eb25b6dee1234bc5d2268", "c2f9d9948dc8c7c38321e4b85c8558872eafa0641cd269db76848a6073e69133")), "3dfef0ce2a4d80a25e7a328accf73448ef67096f65f79588e358d9a0eb9013f1");
    assert.equal(hex(nip44ConversationKey("a1e37752c9fdc1273be53f68c5f74be7c8905728e8de75800b94262f9497c86e", "03bb7947065dde12ba991ea045132581d0954f042c84e06d8c00066e23c1a800")), "4d14f36e81b8452128da64fe6f1eae873baae2f444b02c950b90e43553f2178b");
  });

  it("encrypts and decrypts the published payloads", () => {
    const pub = (sec: string) => hex(schnorr.getPublicKey(Buffer.from(sec, "hex")));
    const vectors = [
      { sec1: "0000000000000000000000000000000000000000000000000000000000000001", sec2: "0000000000000000000000000000000000000000000000000000000000000002", conversationKey: "c41c775356fd92eadc63ff5a0dc1da211b268cbea22316767095b2871ea1412d", nonce: "0000000000000000000000000000000000000000000000000000000000000001", plaintext: "a", payload: "AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABee0G5VSK0/9YypIObAtDKfYEAjD35uVkHyB0F4DwrcNaCXlCWZKaArsGrY6M9wnuTMxWfp1RTN9Xga8no+kF5Vsb" },
      { sec1: "0000000000000000000000000000000000000000000000000000000000000002", sec2: "0000000000000000000000000000000000000000000000000000000000000001", conversationKey: "c41c775356fd92eadc63ff5a0dc1da211b268cbea22316767095b2871ea1412d", nonce: "f00000000000000000000000000000f00000000000000000000000000000000f", plaintext: "🍕🫃", payload: "AvAAAAAAAAAAAAAAAAAAAPAAAAAAAAAAAAAAAAAAAAAPSKSK6is9ngkX2+cSq85Th16oRTISAOfhStnixqZziKMDvB0QQzgFZdjLTPicCJaV8nDITO+QfaQ61+KbWQIOO2Yj" },
    ];
    for (const v of vectors) {
      const key = nip44ConversationKey(v.sec1, pub(v.sec2));
      assert.equal(hex(key), v.conversationKey);
      assert.equal(nip44Encrypt(key, v.plaintext, Buffer.from(v.nonce, "hex")), v.payload);
      assert.equal(nip44Decrypt(key, v.payload), v.plaintext);
      // Symmetric: the peer derives the same key.
      assert.equal(hex(nip44ConversationKey(v.sec2, pub(v.sec1))), v.conversationKey);
    }
  });

  it("pads to the published bucket sizes", () => {
    const table: Array<[number, number]> = [[16, 32], [32, 32], [33, 64], [37, 64], [45, 64], [49, 64], [64, 64], [65, 96], [100, 128], [111, 128], [200, 224], [250, 256], [320, 320], [383, 384], [384, 384], [400, 448], [500, 512], [512, 512], [515, 640], [700, 768], [800, 896], [900, 1024], [1020, 1024], [65536, 65536]];
    for (const [unpadded, padded] of table) assert.equal(nip44CalcPaddedLen(unpadded), padded, `len ${unpadded}`);
  });

  it("refuses unknown versions, bad base64, and a tampered MAC", () => {
    const key = Buffer.from("c41c775356fd92eadc63ff5a0dc1da211b268cbea22316767095b2871ea1412d", "hex");
    const good = nip44Encrypt(key, "hello");
    assert.throws(() => nip44Decrypt(key, "#" + good.slice(1)), (e: unknown) => e instanceof NwcError && e.code === "UNSUPPORTED_ENCRYPTION");
    assert.throws(() => nip44Decrypt(key, "A" + "ф".repeat(140)), (e: unknown) => e instanceof NwcError && e.code === "NIP44");
    const bytes = Buffer.from(good, "base64");
    bytes[bytes.length - 1] ^= 0x01;
    assert.throws(() => nip44Decrypt(key, bytes.toString("base64")), (e: unknown) => e instanceof NwcError && e.message === "invalid MAC");
    const other = Buffer.from("4d14f36e81b8452128da64fe6f1eae873baae2f444b02c950b90e43553f2178b", "hex");
    assert.throws(() => nip44Decrypt(other, good), (e: unknown) => e instanceof NwcError && e.message === "invalid MAC");
  });

  it("round-trips lengths across every padding bucket edge", () => {
    const key = Buffer.from("c41c775356fd92eadc63ff5a0dc1da211b268cbea22316767095b2871ea1412d", "hex");
    for (const n of [1, 31, 32, 33, 64, 65, 255, 256, 257, 1023, 1024, 1025, 4000]) {
      const text = "x".repeat(n);
      assert.equal(nip44Decrypt(key, nip44Encrypt(key, text)), text);
    }
  });
});

describe("pairing uri", () => {
  const pub = "f7914d8f701d8788fd1d74b53141ecad6e0a69ab38730677da094ee5a824b5a0";
  const sec = "0000000000000000000000000000000000000000000000000000000000000002";
  it("parses wallet pubkey, relay, secret, lud16", () => {
    const c = parseNwcUri(`nostr+walletconnect://${pub.toUpperCase()}?relay=wss%3A%2F%2Frelay.getalby.com%2Fv1&secret=${sec}&lud16=demo%40getalby.com`);
    assert.deepEqual(c, { walletPubkey: pub, relayUrl: "wss://relay.getalby.com/v1", secretHex: sec, clientPubkey: "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5", lud16: "demo@getalby.com" });
  });
  it("accepts an upper-case scheme", () => {
    assert.equal(parseNwcUri(`NOSTR+WALLETCONNECT://${pub}?relay=wss://r&secret=${sec}`).walletPubkey, pub);
  });
  it("refuses a URI without relay or secret", () => {
    assert.throws(() => parseNwcUri(`nostr+walletconnect://${pub}?secret=${sec}`), (e: unknown) => e instanceof NwcError && e.code === "INVALID_URI");
    assert.throws(() => parseNwcUri(`nostr+walletconnect://${pub}?relay=wss://r`), (e: unknown) => e instanceof NwcError && e.code === "INVALID_URI");
    assert.throws(() => parseNwcUri("https://example.com"), (e: unknown) => e instanceof NwcError && e.code === "INVALID_URI");
  });
});

describe("nwc request round trip", () => {
  const walletSecret = "0000000000000000000000000000000000000000000000000000000000000002";
  const walletPub = hex(schnorr.getPublicKey(Buffer.from(walletSecret, "hex")));
  const clientSecret = "0000000000000000000000000000000000000000000000000000000000000001";
  const connection = parseNwcUri(`nostr+walletconnect://${walletPub}?relay=wss://relay.test&secret=${clientSecret}`);

  /** A fake relay+wallet: decrypts the request under the wallet key and answers as the wallet. */
  function walletTransport(answer: (method: string, params: Record<string, unknown>) => Record<string, unknown>, signer = walletSecret): NwcTransport {
    return async (_connection, request) => {
      assert.equal(request.kind, NWC_REQUEST_KIND);
      assert.ok(verifyNwcEvent(request));
      assert.deepEqual(request.tags, [["p", walletPub], ["encryption", "nip44_v2"]]);
      const key = nip44ConversationKey(walletSecret, request.pubkey);
      const body = JSON.parse(nip44Decrypt(key, request.content)) as { method: string; params: Record<string, unknown> };
      const reply = answer(body.method, body.params);
      const content = nip44Encrypt(nip44ConversationKey(signer, request.pubkey), JSON.stringify(reply));
      return signNwcEvent(signer, NWC_RESPONSE_KIND, [["p", request.pubkey], ["e", request.id]], content);
    };
  }

  it("encrypts the request, verifies and decrypts the reply, returns result", async () => {
    let seen: { method: string; params: Record<string, unknown> } | null = null;
    const transport = walletTransport((method, params) => {
      seen = { method, params };
      return { result_type: method, result: { invoice: "lnbc1...", payment_hash: "ab".repeat(32), expires_at: 1_800_000_000 } };
    });
    const result = await nwcRequest(connection, "make_invoice", { amount: 100_000, description: "run402 top-up", expiry: 600 }, { transport });
    assert.deepEqual(seen, { method: "make_invoice", params: { amount: 100_000, description: "run402 top-up", expiry: 600 } });
    assert.equal(result["payment_hash"], "ab".repeat(32));
  });

  it("surfaces the wallet's error code", async () => {
    const transport = walletTransport((method) => ({ result_type: method, error: { code: "NOT_FOUND", message: "no such invoice" }, result: null }));
    await assert.rejects(nwcRequest(connection, "lookup_invoice", { payment_hash: "cd".repeat(32) }, { transport }), (e: unknown) => e instanceof NwcError && e.code === "NOT_FOUND" && e.message === "no such invoice");
  });

  it("refuses a reply not signed by the wallet service", async () => {
    const impostor = "0000000000000000000000000000000000000000000000000000000000000003";
    const transport = walletTransport((method) => ({ result_type: method, result: { ok: true } }), impostor);
    await assert.rejects(nwcRequest(connection, "get_info", {}, { transport }), (e: unknown) => e instanceof NwcError && e.code === "BAD_RESPONSE");
  });

  it("refuses a reply whose result_type names another method", async () => {
    const transport = walletTransport(() => ({ result_type: "pay_invoice", result: { preimage: "00" } }));
    await assert.rejects(nwcRequest(connection, "get_info", {}, { transport }), (e: unknown) => e instanceof NwcError && e.code === "BAD_RESPONSE");
  });

  it("maps a transport failure to its code", async () => {
    const transport: NwcTransport = async () => { throw new NwcError("TIMEOUT", "no wallet response within the timeout"); };
    await assert.rejects(nwcRequest(connection, "get_info", {}, { transport }), (e: unknown) => e instanceof NwcError && e.code === "TIMEOUT");
  });

  it("signs verifiable events", () => {
    const event: NwcNostrEvent = signNwcEvent(clientSecret, 1, [["t", "x"]], "hi", 1_700_000_000);
    assert.ok(verifyNwcEvent(event));
    assert.ok(!verifyNwcEvent({ ...event, content: "tampered" }));
  });
});
