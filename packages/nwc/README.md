# @run402/nwc

A Nostr Wallet Connect ([NIP-47](https://github.com/nostr-protocol/nips/blob/master/47.md)) client for Node 22+: pairing URIs, NIP-44 v2 encryption, signed request events, and a standing relay connection. Run402 uses it everywhere it talks to a Lightning wallet: the platform minting invoices on an organization's node, and an agent's wallet paying them.

```ts
import { nwcRequest, parseNwcUri } from "@run402/nwc";

const wallet = parseNwcUri(process.env.NWC_URI!);
const info = await nwcRequest(wallet, "get_info", {});
const invoice = await nwcRequest(wallet, "make_invoice", { amount: 10_000, expiry: 600 });
```

The pairing URI carries the client's secret key. Nothing in this package logs it or returns it to a caller that did not supply it.

## Errors

Every failure is an `NwcError`. Its `code` is the wallet's own NIP-47 code (`NOT_FOUND`, `RESTRICTED`, `UNAUTHORIZED`, `QUOTA_EXCEEDED`, …) or one this client raises:

| Code | Meaning |
| --- | --- |
| `TIMEOUT` | The relay acknowledged the request with `OK`; the wallet never answered. The relay is up; the wallet service or its node is not. |
| `RELAY_TIMEOUT` | The relay never acknowledged the request. |
| `RELAY_UNREACHABLE` | No connection to the relay: refused, DNS, an HTTP 429, a handshake timeout, or a hold after one of those. |
| `RELAY_REJECTED` | The relay answered `OK false`. |
| `RELAY_CLOSED` | The connection dropped while the request was in flight. |
| `BAD_RESPONSE` | A reply arrived that is not a valid answer from this wallet. |
| `INVALID_URI` | The pairing URI cannot be read. |
| `NIP44`, `UNSUPPORTED_ENCRYPTION` | A payload could not be encrypted or decrypted. NIP-04 is not supported. |

`NWC_TRANSPORT_ERROR_CODES` holds the first six: no wallet answer was read, so the request may or may not have reached the wallet. Treat a payment that failed with one of them as unknown until you look it up.

## Relay connections

`nwcRequest` sends through a module-wide pool by default. A pool keeps one WebSocket per (relay, client key), matches replies by `e` tag, and closes idle connections. After a failed connect it holds further connects to that relay briefly, because public relays rate-limit clients that reconnect per request. Create your own pool to set its lifetime or its WebSocket:

```ts
import WebSocket from "ws";
import { createNwcRelayPool, nwcRequest } from "@run402/nwc";

// A long-lived server keeps the socket warm; `ws` keeps a refused handshake's HTTP status in the error.
const pool = createNwcRelayPool({ idleCloseMs: 120_000, WebSocket });
await nwcRequest(wallet, "lookup_invoice", { payment_hash }, { transport: pool.transport, timeoutMs: 15_000 });
pool.close();
```

| Option | Default |
| --- | --- |
| `idleCloseMs` | 1 500 ms, so a one-shot process exits promptly |
| `connectHoldMs` | 5 000 ms |
| `handshakeTimeoutMs` | 10 000 ms, capped by the request's timeout |
| `WebSocket` | the global `WebSocket` |

`closeNwcConnections()` closes the default pool's connections.

## License

Apache-2.0
