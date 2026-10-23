/**
 * NIP-44 v2, the only encryption this client speaks (NIP-04 is deprecated by
 * NIP-47 and not implemented: a wallet that speaks only it fails `NIP44` or
 * `UNSUPPORTED_ENCRYPTION`).
 */
import { createCipheriv, randomBytes, timingSafeEqual } from "node:crypto";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { expand, extract } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";

import { NwcError } from "./errors.js";

const HEX_64 = /^[0-9a-f]{64}$/;
const NIP44_VERSION = 2;
const MIN_PLAINTEXT = 1;
const MAX_PLAINTEXT = 65_535;

export function nip44CalcPaddedLen(unpaddedLen: number): number {
  if (!Number.isInteger(unpaddedLen) || unpaddedLen < 1) throw new NwcError("NIP44", "invalid plaintext length");
  if (unpaddedLen <= 32) return 32;
  const nextPower = 1 << (Math.floor(Math.log2(unpaddedLen - 1)) + 1);
  const chunk = nextPower <= 256 ? 32 : nextPower / 8;
  return chunk * (Math.floor((unpaddedLen - 1) / chunk) + 1);
}

/** ECDH x-coordinate → HKDF-extract(sha256, ikm = x, salt = "nip44-v2"). */
export function nip44ConversationKey(secretHex: string, peerPubkeyHex: string): Uint8Array {
  if (!HEX_64.test(secretHex) || !HEX_64.test(peerPubkeyHex.toLowerCase())) throw new NwcError("NIP44", "keys must be 32-byte hex");
  const shared = secp256k1.getSharedSecret(Buffer.from(secretHex, "hex"), Buffer.from("02" + peerPubkeyHex.toLowerCase(), "hex"), true);
  return extract(sha256, shared.subarray(1, 33), Buffer.from("nip44-v2", "utf8"));
}

function messageKeys(conversationKey: Uint8Array, nonce: Uint8Array): { chachaKey: Buffer; chachaNonce: Buffer; hmacKey: Buffer } {
  const keys = Buffer.from(expand(sha256, conversationKey, nonce, 76));
  return { chachaKey: keys.subarray(0, 32), chachaNonce: keys.subarray(32, 44), hmacKey: keys.subarray(44, 76) };
}

/** Raw ChaCha20 (IETF, counter 0) via OpenSSL's `chacha20`: iv = 4-byte LE counter || 12-byte nonce. */
function chacha20(key: Buffer, nonce12: Buffer, data: Buffer): Buffer {
  const iv = Buffer.concat([Buffer.alloc(4, 0), nonce12]);
  const cipher = createCipheriv("chacha20", key, iv);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

function pad(plaintext: string): Buffer {
  const bytes = Buffer.from(plaintext, "utf8");
  if (bytes.length < MIN_PLAINTEXT || bytes.length > MAX_PLAINTEXT) throw new NwcError("NIP44", "invalid plaintext length");
  const prefix = Buffer.alloc(2);
  prefix.writeUInt16BE(bytes.length, 0);
  const padded = Buffer.alloc(nip44CalcPaddedLen(bytes.length) - bytes.length, 0);
  return Buffer.concat([prefix, bytes, padded]);
}

function unpad(padded: Buffer): string {
  if (padded.length < 2) throw new NwcError("NIP44", "invalid padding");
  const unpaddedLen = padded.readUInt16BE(0);
  const unpadded = padded.subarray(2, 2 + unpaddedLen);
  if (unpaddedLen < MIN_PLAINTEXT || unpadded.length !== unpaddedLen || padded.length !== 2 + nip44CalcPaddedLen(unpaddedLen)) {
    throw new NwcError("NIP44", "invalid padding");
  }
  return unpadded.toString("utf8");
}

export function nip44Encrypt(conversationKey: Uint8Array, plaintext: string, nonce: Uint8Array = randomBytes(32)): string {
  if (nonce.length !== 32) throw new NwcError("NIP44", "nonce must be 32 bytes");
  const { chachaKey, chachaNonce, hmacKey } = messageKeys(conversationKey, nonce);
  const ciphertext = chacha20(chachaKey, chachaNonce, pad(plaintext));
  const mac = Buffer.from(hmac(sha256, hmacKey, Buffer.concat([Buffer.from(nonce), ciphertext])));
  return Buffer.concat([Buffer.from([NIP44_VERSION]), Buffer.from(nonce), ciphertext, mac]).toString("base64");
}

export function nip44Decrypt(conversationKey: Uint8Array, payload: string): string {
  if (payload.length < 132 || payload.length > 87_472) throw new NwcError("NIP44", "invalid payload length");
  if (payload.startsWith("#")) throw new NwcError("UNSUPPORTED_ENCRYPTION", "unknown encryption version");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) throw new NwcError("NIP44", "invalid base64");
  const data = Buffer.from(payload, "base64");
  if (data.length < 99 || data.length > 65_603) throw new NwcError("NIP44", "invalid data length");
  if (data[0] !== NIP44_VERSION) throw new NwcError("UNSUPPORTED_ENCRYPTION", `unknown encryption version ${String(data[0])}`);
  const nonce = data.subarray(1, 33);
  const ciphertext = data.subarray(33, data.length - 32);
  const mac = data.subarray(data.length - 32);
  const { chachaKey, chachaNonce, hmacKey } = messageKeys(conversationKey, nonce);
  const expected = Buffer.from(hmac(sha256, hmacKey, Buffer.concat([nonce, ciphertext])));
  if (expected.length !== mac.length || !timingSafeEqual(expected, mac)) throw new NwcError("NIP44", "invalid MAC");
  return unpad(chacha20(chachaKey, chachaNonce, ciphertext));
}
