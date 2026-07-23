import { Buffer } from "node:buffer";

import {
  getRoutedPaymentContext,
  type RoutedHttpFulfillmentDirectiveV1,
  type RoutedHttpResponseV1,
} from "./routed-http.js";
import {
  requireActiveContext,
  taintCacheBypass,
} from "./runtime-context.js";

export const MERCHANT_FULFILLMENT_DIRECTIVE_HEADER =
  "x-run402-merchant-fulfillment";
export const MERCHANT_RECEIPT_MODE_HEADER =
  "x-run402-payment-receipt-mode";

export type Run402PaymentFulfillmentErrorCode =
  | "R402_PAYMENT_FULFILLMENT_OUTSIDE_ROUTED_REQUEST"
  | "R402_PAYMENT_FULFILLMENT_RECEIPT_NOT_ENABLED"
  | "R402_PAYMENT_FULFILLMENT_UNSETTLED"
  | "R402_PAYMENT_FULFILLMENT_CONTEXT_EXPIRED"
  | "R402_PAYMENT_FULFILLMENT_DIRECTIVE_INVALID";

export class Run402PaymentFulfillmentError extends Error {
  readonly docs =
    "https://run402.com/errors/#payment-fulfillment-context";

  constructor(readonly code: Run402PaymentFulfillmentErrorCode, message: string) {
    super(message);
    this.name = "Run402PaymentFulfillmentError";
  }
}

function header(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const entry = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  )?.[1];
  return Array.isArray(entry) ? entry[0] ?? null : entry ?? null;
}

function fulfilled(response: Response): Response {
  const context = requireActiveContext("payment.fulfilled");
  taintCacheBypass();
  if (context.invocationKind !== "routed_http") {
    throw new Run402PaymentFulfillmentError(
      "R402_PAYMENT_FULFILLMENT_OUTSIDE_ROUTED_REQUEST",
      "payment.fulfilled() is only valid in a routed HTTP function.",
    );
  }
  if (
    header(context.request.headers, MERCHANT_RECEIPT_MODE_HEADER) !==
    "on_fulfillment"
  ) {
    throw new Run402PaymentFulfillmentError(
      "R402_PAYMENT_FULFILLMENT_RECEIPT_NOT_ENABLED",
      "This route did not opt into pricing.receipt: \"on_fulfillment\".",
    );
  }
  const paymentContext = getRoutedPaymentContext(context.request.headers);
  if (!paymentContext) {
    throw new Run402PaymentFulfillmentError(
      "R402_PAYMENT_FULFILLMENT_UNSETTLED",
      "No confirmed x402 settlement context is available.",
    );
  }
  const expiresAt = Date.parse(paymentContext.contextExpiresAt ?? "");
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new Run402PaymentFulfillmentError(
      "R402_PAYMENT_FULFILLMENT_CONTEXT_EXPIRED",
      "The confirmed payment context has expired.",
    );
  }
  if (!(response instanceof Response)) {
    throw new TypeError("payment.fulfilled(response) requires a Web Response.");
  }

  const directive: RoutedHttpFulfillmentDirectiveV1 = {
    version: "run402.merchant_fulfillment.v1",
    claim: "service_delivered",
    payment: paymentContext,
  };
  const headers = new Headers(response.headers);
  headers.set(
    MERCHANT_FULFILLMENT_DIRECTIVE_HEADER,
    Buffer.from(JSON.stringify(directive), "utf8").toString("base64url"),
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function decodeMerchantFulfillmentDirective(
  encoded: string,
): RoutedHttpFulfillmentDirectiveV1 | null {
  if (Buffer.byteLength(encoded, "utf8") > 8 * 1024) return null;
  try {
    const value = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as Partial<RoutedHttpFulfillmentDirectiveV1>;
    if (
      value.version !== "run402.merchant_fulfillment.v1" ||
      value.claim !== "service_delivered" ||
      getRoutedPaymentContext({
        context: { payment: value.payment },
        version: "run402.routed_http.v1",
      } as never) === null
    ) {
      return null;
    }
    return value as RoutedHttpFulfillmentDirectiveV1;
  } catch {
    return null;
  }
}

export function consumeMerchantFulfillmentDirective(
  response: RoutedHttpResponseV1,
): RoutedHttpResponseV1 {
  if (response.fulfillment !== undefined) {
    throw new Run402PaymentFulfillmentError(
      "R402_PAYMENT_FULFILLMENT_DIRECTIVE_INVALID",
      "Function responses may carry fulfillment only through payment.fulfilled().",
    );
  }
  const matches = (response.headers ?? []).filter(
    ([name]) =>
      name.toLowerCase() === MERCHANT_FULFILLMENT_DIRECTIVE_HEADER,
  );
  const headers = (response.headers ?? []).filter(
    ([name]) =>
      name.toLowerCase() !== MERCHANT_FULFILLMENT_DIRECTIVE_HEADER,
  );
  if (matches.length === 0) {
    return { ...response, headers };
  }
  if (matches.length !== 1) {
    throw new Run402PaymentFulfillmentError(
      "R402_PAYMENT_FULFILLMENT_DIRECTIVE_INVALID",
      "Function response contained duplicate merchant-fulfillment directives.",
    );
  }
  const fulfillment = decodeMerchantFulfillmentDirective(matches[0]![1]);
  if (!fulfillment) {
    throw new Run402PaymentFulfillmentError(
      "R402_PAYMENT_FULFILLMENT_DIRECTIVE_INVALID",
      "Function response contained an invalid merchant-fulfillment directive.",
    );
  }
  return { ...response, headers, fulfillment };
}

export const payment = { fulfilled };
