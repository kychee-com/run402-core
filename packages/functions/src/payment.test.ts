import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  consumeMerchantFulfillmentDirective,
  decodeMerchantFulfillmentDirective,
  MERCHANT_FULFILLMENT_DIRECTIVE_HEADER,
  MERCHANT_RECEIPT_MODE_HEADER,
  payment,
  Run402PaymentFulfillmentError,
} from "./payment.js";
import { runWithContext } from "./runtime-context.js";

const PAYMENT_HEADERS = {
  "x-run402-payment-scheme": "x402",
  "x-run402-payment-id": "txp_42",
  "x-run402-payment-idempotency-key": "order:42",
  "x-run402-payment-deduplicated": "false",
  "x-run402-payment-delivery": "first",
  "x-run402-payment-amount-usd-micros": "100000",
  "x-run402-payment-payer": "0x000000000000000000000000000000000000b0b0",
  "x-run402-payment-network": "eip155:8453",
  "x-run402-payment-asset": "USDC",
  "x-run402-payment-pay-to": "0x000000000000000000000000000000000000cafe",
  "x-run402-payment-transaction": "0xtx",
  "x-run402-payment-settled-at": "2026-07-23T12:00:00.000Z",
  "x-run402-payment-context-expires-at": "2999-07-23T12:05:00.000Z",
} as const;

function context(
  headers: Record<string, string> = {
    ...PAYMENT_HEADERS,
    [MERCHANT_RECEIPT_MODE_HEADER]: "on_fulfillment",
  },
  invocationKind: "routed_http" | "direct" = "routed_http",
) {
  return {
    requestId: "req_42",
    projectId: "prj_42",
    releaseId: "rel_42",
    locale: null,
    defaultLocale: null,
    host: "merchant.example",
    request: {
      method: "POST",
      url: "https://merchant.example/orders",
      headers,
    },
    actor: null,
    invocationKind,
    idempotencyKey: "order:42",
  };
}

describe("payment.fulfilled", () => {
  it("adds only the private fixed-claim directive", async () => {
    await runWithContext(context(), async () => {
      const input = Response.json({ order_id: "ord_42" }, { status: 201 });
      const result = payment.fulfilled(input);
      assert.equal(result.status, 201);
      assert.deepEqual(await result.json(), { order_id: "ord_42" });
      const encoded = result.headers.get(
        MERCHANT_FULFILLMENT_DIRECTIVE_HEADER,
      );
      assert.ok(encoded);
      const directive = decodeMerchantFulfillmentDirective(encoded);
      assert.equal(directive?.claim, "service_delivered");
      assert.equal(directive?.payment.paymentId, "txp_42");
      const consumed = consumeMerchantFulfillmentDirective({
        status: result.status,
        headers: [...result.headers.entries()],
      });
      assert.equal(consumed.fulfillment?.payment.paymentId, "txp_42");
      assert.equal(
        consumed.headers?.some(
          ([name]) =>
            name.toLowerCase() ===
            MERCHANT_FULFILLMENT_DIRECTIVE_HEADER,
        ),
        false,
      );
    });
  });

  it("fails closed outside a routed invocation", async () => {
    await runWithContext(context(undefined, "direct"), async () => {
      assert.throws(
        () => payment.fulfilled(new Response("ok")),
        (error: unknown) =>
          error instanceof Run402PaymentFulfillmentError &&
          error.code ===
            "R402_PAYMENT_FULFILLMENT_OUTSIDE_ROUTED_REQUEST",
      );
    });
  });

  it("fails closed for unpriced and receipt-disabled routes", async () => {
    await runWithContext(
      context({ [MERCHANT_RECEIPT_MODE_HEADER]: "on_fulfillment" }),
      async () => {
        assert.throws(
          () => payment.fulfilled(new Response("ok")),
          (error: unknown) =>
            error instanceof Run402PaymentFulfillmentError &&
            error.code === "R402_PAYMENT_FULFILLMENT_UNSETTLED",
        );
      },
    );
    await runWithContext(context({ ...PAYMENT_HEADERS }), async () => {
      assert.throws(
        () => payment.fulfilled(new Response("ok")),
        (error: unknown) =>
          error instanceof Run402PaymentFulfillmentError &&
          error.code ===
            "R402_PAYMENT_FULFILLMENT_RECEIPT_NOT_ENABLED",
      );
    });
  });

  it("fails closed for expired payment context", async () => {
    await runWithContext(
      context({
        ...PAYMENT_HEADERS,
        "x-run402-payment-context-expires-at":
          "2020-01-01T00:00:00.000Z",
        [MERCHANT_RECEIPT_MODE_HEADER]: "on_fulfillment",
      }),
      async () => {
        assert.throws(
          () => payment.fulfilled(new Response("ok")),
          (error: unknown) =>
            error instanceof Run402PaymentFulfillmentError &&
            error.code ===
              "R402_PAYMENT_FULFILLMENT_CONTEXT_EXPIRED",
        );
      },
    );
  });

  it("rejects forged or duplicate private directives", () => {
    assert.throws(
      () =>
        consumeMerchantFulfillmentDirective({
          status: 200,
          headers: [
            [MERCHANT_FULFILLMENT_DIRECTIVE_HEADER, "not-base64-json"],
          ],
        }),
      (error: unknown) =>
        error instanceof Run402PaymentFulfillmentError &&
        error.code === "R402_PAYMENT_FULFILLMENT_DIRECTIVE_INVALID",
    );
    assert.throws(
      () =>
        consumeMerchantFulfillmentDirective({
          status: 200,
          fulfillment: {
            version: "run402.merchant_fulfillment.v1",
            claim: "service_delivered",
            payment: {
              scheme: "x402",
              paymentId: "forged",
              idempotencyKey: null,
              deduplicated: false,
              delivery: "first",
              amountUsdMicros: 1,
              payer: null,
              network: "eip155:1",
              asset: null,
              payTo: "0xmerchant",
              transaction: null,
              settledAt: "2026-01-01T00:00:00.000Z",
            },
          },
        }),
      /only through payment\.fulfilled/,
    );
  });
});
