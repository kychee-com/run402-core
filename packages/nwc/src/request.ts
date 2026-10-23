import { NwcError } from "./errors.js";
import { NWC_REQUEST_KIND, signNwcEvent, verifyNwcEvent } from "./events.js";
import { nip44ConversationKey, nip44Decrypt, nip44Encrypt } from "./nip44.js";
import { createNwcRelayPool, type NwcTransport } from "./relay.js";
import type { NwcConnection } from "./uri.js";

const DEFAULT_TIMEOUT_MS = 15_000;

const defaultPool = createNwcRelayPool();

/** Closes every connection the default pool holds (process exit, tests). */
export function closeNwcConnections(): void {
  defaultPool.close();
}

export interface NwcRequestOptions {
  /** How long to wait for the wallet's reply (default 15 000 ms). */
  timeoutMs?: number;
  /** Where the request goes (default: the module's own relay pool). */
  transport?: NwcTransport;
}

/**
 * One NIP-47 call. Resolves with the wallet's `result`; throws `NwcError`
 * with the wallet's error code or a transport code (`NWC_TRANSPORT_ERROR_CODES`).
 */
export async function nwcRequest<T = Record<string, unknown>>(
  connection: NwcConnection,
  method: string,
  params: Record<string, unknown>,
  options: NwcRequestOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const transport = options.transport ?? defaultPool.transport;
  const conversationKey = nip44ConversationKey(connection.secretHex, connection.walletPubkey);
  const content = nip44Encrypt(conversationKey, JSON.stringify({ method, params }));
  const request = signNwcEvent(connection.secretHex, NWC_REQUEST_KIND, [["p", connection.walletPubkey], ["encryption", "nip44_v2"]], content);
  const response = await transport(connection, request, timeoutMs);
  if (response.pubkey !== connection.walletPubkey || !verifyNwcEvent(response)) {
    throw new NwcError("BAD_RESPONSE", "response is not signed by the wallet service");
  }
  let body: { result_type?: string; error?: { code?: string; message?: string } | null; result?: T };
  try {
    body = JSON.parse(nip44Decrypt(conversationKey, response.content)) as typeof body;
  } catch (error) {
    throw error instanceof NwcError ? error : new NwcError("BAD_RESPONSE", "response payload is not JSON");
  }
  if (body.error && typeof body.error === "object") {
    throw new NwcError(typeof body.error.code === "string" ? body.error.code : "OTHER", typeof body.error.message === "string" ? body.error.message : "wallet error");
  }
  if (body.result_type !== undefined && body.result_type !== method) throw new NwcError("BAD_RESPONSE", `unexpected result_type ${String(body.result_type)}`);
  if (body.result === undefined || body.result === null) throw new NwcError("BAD_RESPONSE", "response carries no result");
  return body.result;
}
