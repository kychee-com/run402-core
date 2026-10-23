import { createHash } from "node:crypto";

import { schnorr } from "@noble/curves/secp256k1.js";

export const NWC_INFO_KIND = 13194;
export const NWC_REQUEST_KIND = 23194;
export const NWC_RESPONSE_KIND = 23195;

/** A Nostr event; `created_at` is unix seconds (the protocol's own field). */
export interface NwcNostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

function eventId(pubkey: string, createdAt: number, kind: number, tags: string[][], content: string): string {
  return createHash("sha256").update(JSON.stringify([0, pubkey, createdAt, kind, tags, content]), "utf8").digest("hex");
}

export function signNwcEvent(secretHex: string, kind: number, tags: string[][], content: string, createdAt = Math.floor(Date.now() / 1000)): NwcNostrEvent {
  const secret = Buffer.from(secretHex, "hex");
  const pubkey = Buffer.from(schnorr.getPublicKey(secret)).toString("hex");
  const id = eventId(pubkey, createdAt, kind, tags, content);
  const sig = Buffer.from(schnorr.sign(Buffer.from(id, "hex"), secret)).toString("hex");
  return { id, pubkey, created_at: createdAt, kind, tags, content, sig };
}

export function verifyNwcEvent(event: NwcNostrEvent): boolean {
  try {
    if (event.id !== eventId(event.pubkey, event.created_at, event.kind, event.tags, event.content)) return false;
    return schnorr.verify(Buffer.from(event.sig, "hex"), Buffer.from(event.id, "hex"), Buffer.from(event.pubkey, "hex"));
  } catch {
    return false;
  }
}
