import assert from "node:assert/strict";
import test from "node:test";

import {
  authenticateEmailDeliveryEventToken,
  emailDeliveryEventConfigFromEnv,
  emailDeliveryEventReadiness,
  normalizeSesDeliveryEvents,
} from "./email-events.js";

test("SES delivery events normalize direct provider payloads", () => {
  const batch = normalizeSesDeliveryEvents({
    eventType: "Delivery",
    mail: {
      messageId: "ses_msg_1",
      destination: ["user@example.com"],
      timestamp: "2026-06-30T10:00:00.000Z",
    },
    delivery: {
      timestamp: "2026-06-30T10:01:00.000Z",
      recipients: ["user@example.com"],
    },
  });

  assert.equal(batch.events.length, 1);
  assert.equal(batch.ignored.length, 0);
  assert.deepEqual(batch.events[0], {
    provider: "ses",
    event_type: "delivery",
    provider_message_id: "ses_msg_1",
    recipient: "user@example.com",
    bounce_type: null,
    occurred_at: "2026-06-30T10:01:00.000Z",
    raw_event_type: "Delivery",
  });
});

test("SES bounce and complaint events normalize from SNS wrappers", () => {
  const batch = normalizeSesDeliveryEvents({
    Records: [
      {
        Sns: {
          Message: JSON.stringify({
            notificationType: "Bounce",
            mail: { messageId: "ses_msg_2", destination: ["fallback@example.com"] },
            bounce: {
              bounceType: "Permanent",
              bouncedRecipients: [{ emailAddress: "bad@example.com" }],
            },
          }),
        },
      },
      {
        Sns: {
          Message: JSON.stringify({
            eventType: "Complaint",
            mail: { messageId: "ses_msg_3" },
            complaint: {
              complainedRecipients: [{ emailAddress: "complainer@example.com" }],
            },
          }),
        },
      },
    ],
  });

  assert.equal(batch.events.length, 2);
  assert.equal(batch.events[0]?.event_type, "bounced");
  assert.equal(batch.events[0]?.provider_message_id, "ses_msg_2");
  assert.equal(batch.events[0]?.recipient, "bad@example.com");
  assert.equal(batch.events[0]?.bounce_type, "Permanent");
  assert.equal(batch.events[1]?.event_type, "complained");
  assert.equal(batch.events[1]?.provider_message_id, "ses_msg_3");
  assert.equal(batch.events[1]?.recipient, "complainer@example.com");
});

test("SES normalizer treats unsupported and malformed notifications as ignored diagnostics", () => {
  const batch = normalizeSesDeliveryEvents({
    Records: [
      { Sns: { Message: JSON.stringify({ eventType: "Open", mail: { messageId: "ses_open" } }) } },
      { Sns: { Message: JSON.stringify({ eventType: "Delivery", mail: {} }) } },
      { Sns: { Message: "{not-json" } },
    ],
  });

  assert.equal(batch.events.length, 0);
  assert.deepEqual(batch.ignored.map((entry) => entry.reason), [
    "event_type_unsupported",
    "provider_message_id_missing",
    "event_type_unsupported",
  ]);
});

test("email delivery event config is token-gated and timing-safe", () => {
  assert.deepEqual(emailDeliveryEventConfigFromEnv({}), {
    provider: "disabled",
    ingestToken: undefined,
  });

  const config = emailDeliveryEventConfigFromEnv({
    CORE_EMAIL_EVENTS_INGEST_TOKEN: "secret",
  });
  assert.deepEqual(config, { provider: "ses", ingestToken: "secret" });
  assert.equal(emailDeliveryEventReadiness(config).status, "configured");
  assert.equal(authenticateEmailDeliveryEventToken("secret", config), true);
  assert.equal(authenticateEmailDeliveryEventToken("wrong", config), false);
  assert.equal(authenticateEmailDeliveryEventToken(null, config), false);
});
