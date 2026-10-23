import { schnorr } from "@noble/curves/secp256k1.js";

import { NwcError } from "./errors.js";

const HEX_64 = /^[0-9a-f]{64}$/;

/**
 * A parsed pairing. `secretHex` is the client's Nostr key: never log it or
 * hand it back to a caller that did not supply it.
 */
export interface NwcConnection {
  walletPubkey: string;
  relayUrl: string;
  secretHex: string;
  clientPubkey: string;
  lud16: string | null;
}

/** `nostr+walletconnect://<wallet pubkey>?relay=<wss url>&secret=<hex>[&lud16=…]`. */
export function parseNwcUri(uri: string): NwcConnection {
  const match = /^nostr\+walletconnect:\/\/([0-9a-fA-F]{64})\?(.*)$/i.exec(uri.trim());
  if (!match) throw new NwcError("INVALID_URI", "not a nostr+walletconnect:// pairing URI");
  const params = new URLSearchParams(match[2] ?? "");
  const relayUrl = params.get("relay") ?? "";
  const secretHex = (params.get("secret") ?? "").toLowerCase();
  if (!/^wss?:\/\//.test(relayUrl)) throw new NwcError("INVALID_URI", "pairing URI has no relay");
  if (!HEX_64.test(secretHex)) throw new NwcError("INVALID_URI", "pairing URI has no 32-byte secret");
  const clientPubkey = Buffer.from(schnorr.getPublicKey(Buffer.from(secretHex, "hex"))).toString("hex");
  return { walletPubkey: (match[1] ?? "").toLowerCase(), relayUrl, secretHex, clientPubkey, lud16: params.get("lud16") };
}
