#!/usr/bin/env node

/**
 * AWS Lambda forwarder for SES Delivery/Bounce/Complaint notifications.
 *
 * Configure SES to publish events to SNS, subscribe this Lambda to the topic,
 * and set:
 *   CORE_API_BASE=http://your-core-gateway:4020
 *   CORE_EMAIL_EVENTS_INGEST_TOKEN=<same token as the Core gateway>
 */

export async function handler(event) {
  const apiBase = requiredEnv("CORE_API_BASE").replace(/\/+$/, "");
  const token = requiredEnv("CORE_EMAIL_EVENTS_INGEST_TOKEN");
  const response = await fetch(`${apiBase}/mailboxes/v1/events/ingestions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${token}`,
    },
    body: JSON.stringify(event),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Run402 Core email event ingestion failed: HTTP ${response.status} ${text}`);
  }
  return JSON.parse(text);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const stdin = await readStdin();
  const result = await handler(stdin ? JSON.parse(stdin) : {});
  console.log(JSON.stringify(result, null, 2));
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").trim();
}
