/**
 * Nostr Wallet Connect (NIP-47) client: one implementation for every Run402
 * component that talks to a Lightning wallet over NWC.
 *
 * The pairing URI carries the client's secret key; nothing here logs it or
 * returns it to a caller that did not supply it.
 */
export { NwcError, NWC_TRANSPORT_ERROR_CODES } from "./errors.js";
export { parseNwcUri, type NwcConnection } from "./uri.js";
export { nip44CalcPaddedLen, nip44ConversationKey, nip44Decrypt, nip44Encrypt } from "./nip44.js";
export { NWC_INFO_KIND, NWC_REQUEST_KIND, NWC_RESPONSE_KIND, signNwcEvent, verifyNwcEvent, type NwcNostrEvent } from "./events.js";
export {
  createNwcRelayPool,
  type NwcRelayPool,
  type NwcRelayPoolOptions,
  type NwcSocket,
  type NwcTransport,
  type NwcWebSocketConstructor,
} from "./relay.js";
export { closeNwcConnections, nwcRequest, type NwcRequestOptions } from "./request.js";
