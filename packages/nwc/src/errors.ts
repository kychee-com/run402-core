/**
 * Every failure is an `NwcError` whose `code` is either the wallet's own
 * NIP-47 error code (`NOT_FOUND`, `RESTRICTED`, `UNAUTHORIZED`,
 * `QUOTA_EXCEEDED`, …) or one this client raises itself.
 */
export class NwcError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "NwcError";
  }
}

/**
 * The codes this client raises when no wallet answer was read: the request
 * may or may not have reached the wallet.
 *
 * - `TIMEOUT`: the relay acknowledged the request with `OK`; the wallet never answered.
 * - `RELAY_TIMEOUT`: the relay never acknowledged the request.
 * - `RELAY_UNREACHABLE`: no connection to the relay (refused, DNS, HTTP 429, handshake timeout).
 * - `RELAY_REJECTED`: the relay answered `OK false`.
 * - `RELAY_CLOSED`: the connection dropped while the request was in flight.
 * - `BAD_RESPONSE`: a reply arrived that is not a valid answer from this wallet.
 */
export const NWC_TRANSPORT_ERROR_CODES: ReadonlySet<string> = new Set([
  "TIMEOUT",
  "RELAY_TIMEOUT",
  "RELAY_UNREACHABLE",
  "RELAY_REJECTED",
  "RELAY_CLOSED",
  "BAD_RESPONSE",
]);
