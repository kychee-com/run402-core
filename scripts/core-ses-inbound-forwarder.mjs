/**
 * AWS SES receiving forwarder for Run402 Core.
 *
 * SES receipt rule:
 *   SMTP receive -> store raw message in object storage -> invoke this Lambda.
 *
 * This forwarder intentionally does not parse MIME or resolve projects. It
 * forwards provider facts to the Core gateway, which owns mailbox resolution,
 * reply-first policy, raw readback, and webhook enqueue.
 */

const DEFAULT_RAW_PREFIX = "inbound-email/";

export async function handler(event) {
  const apiBase = requiredEnv("CORE_API_BASE").replace(/\/+$/, "");
  const ingestToken = requiredEnv("CORE_EMAIL_INBOUND_INGEST_TOKEN");
  const rawBucket = requiredEnv("CORE_EMAIL_INBOUND_RAW_BUCKET");
  const rawPrefix = process.env.CORE_EMAIL_INBOUND_RAW_PREFIX || DEFAULT_RAW_PREFIX;
  const results = [];

  for (const record of event.Records ?? []) {
    const ses = record.ses;
    if (!ses?.mail?.messageId) {
      results.push({ status: "skipped", reason: "missing_ses_message" });
      continue;
    }
    const messageId = ses.mail.messageId;
    const payload = {
      provider: "ses",
      ses_message_id: messageId,
      recipients: ses.receipt?.recipients ?? ses.mail.destination ?? [],
      source: ses.mail.source ?? null,
      common_headers: {
        from: ses.mail.commonHeaders?.from ?? [],
      },
      receipt_timestamp: ses.mail.timestamp ?? new Date().toISOString(),
      bucket: rawBucket,
      key: `${rawPrefix}${messageId}`,
      mail: {
        messageId,
        source: ses.mail.source ?? null,
        commonHeaders: ses.mail.commonHeaders ?? {},
        destination: ses.mail.destination ?? [],
        timestamp: ses.mail.timestamp ?? null,
      },
      receipt: {
        recipients: ses.receipt?.recipients ?? [],
      },
    };

    const response = await fetch(`${apiBase}/mailboxes/v1/inbound/ingestions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ingestToken}`,
      },
      body: JSON.stringify(payload),
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`Core inbound ingestion failed for ${messageId}: ${response.status} ${body}`);
    }
    results.push({ status: "forwarded", message_id: messageId, response: JSON.parse(body) });
  }

  return { ok: true, results };
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
