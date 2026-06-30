# Enable Core Outbound Email On AWS

This guide adds outbound email to a Dockerized Run402 Core gateway running on AWS. It keeps the important boundary intact:

- apps still deploy with `run402 deploy apply --manifest`
- app code still calls the same `/mailboxes/v1` contract and `@run402/functions.email.send`
- the Core operator owns the email provider account, sender domain, DNS, reputation, sandbox status, and delivery operations

This guide covers outbound transactional email and provider delivery operations: SES acceptance, Delivery/Bounce/Complaint forwarding, message-state reconciliation, suppression, delivery log, retry, and redrive. For inbound reply reception on the same Core gateway, follow `docs/deployment/aws-email-inbound/README.md` after outbound send is working. Managed sender-domain automation and Cloud abuse operations stay outside Core.

## What You Need

- A running Run402 Core Docker Compose gateway on AWS, such as `docs/deployment/aws-ec2/README.md`
- An AWS account with Amazon SES access in one region
- A verified SES sender identity or domain
- An EC2 instance role, ECS task role, or other AWS SDK credential source that can call `ses:SendEmail` and `ses:SendRawEmail`
- `curl` and `jq`

Recommended first target:

```bash
export CORE_API_BASE="http://<ec2-public-dns-or-ip>:4020"
export CORE_EMAIL_PROVIDER="ses"
export CORE_EMAIL_FROM_DOMAIN="example.com"
export CORE_EMAIL_SES_REGION="us-east-1"
export CORE_EMAIL_SES_CONFIGURATION_SET="run402-core-events"
export CORE_EMAIL_EVENTS_INGEST_TOKEN="$(openssl rand -hex 32)"
```

Use your verified sender domain for `CORE_EMAIL_FROM_DOMAIN`.

## SES Prerequisites

Verify the sender domain or sender email in SES before starting the Core gateway:

```bash
aws sesv2 create-email-identity \
  --region "$CORE_EMAIL_SES_REGION" \
  --email-identity "$CORE_EMAIL_FROM_DOMAIN"

aws sesv2 get-email-identity \
  --region "$CORE_EMAIL_SES_REGION" \
  --email-identity "$CORE_EMAIL_FROM_DOMAIN"
```

If SES returns DKIM records, add them to DNS and wait for verification:

```bash
aws sesv2 get-email-identity \
  --region "$CORE_EMAIL_SES_REGION" \
  --email-identity "$CORE_EMAIL_FROM_DOMAIN" \
  --query 'DkimAttributes'
```

If the SES account is still in sandbox, you can only send to verified recipients. For a first smoke test, verify your own recipient address too:

```bash
export TEST_RECIPIENT="you@example.com"

aws sesv2 create-email-identity \
  --region "$CORE_EMAIL_SES_REGION" \
  --email-identity "$TEST_RECIPIENT"
```

For production use, request SES production access in the AWS console.

## IAM

Prefer an EC2 instance role over static keys. The Core gateway container can use the instance metadata credential chain automatically.

Minimal policy shape:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["ses:SendEmail", "ses:SendRawEmail"],
      "Resource": "*"
    }
  ]
}
```

For tighter production policy, restrict `Resource` to the verified SES identity after the smoke test.

## SES Delivery Events

Create an SES configuration set. Core adds this configuration set to every SES send when `CORE_EMAIL_SES_CONFIGURATION_SET` is configured.

```bash
aws sesv2 create-configuration-set \
  --region "$CORE_EMAIL_SES_REGION" \
  --configuration-set-name "$CORE_EMAIL_SES_CONFIGURATION_SET" \
  || true
```

Create an SNS topic for SES events:

```bash
export CORE_EMAIL_EVENTS_TOPIC="run402-core-email-events"

aws sns create-topic \
  --region "$CORE_EMAIL_SES_REGION" \
  --name "$CORE_EMAIL_EVENTS_TOPIC" \
  | tee /tmp/run402-core-email-events-topic.json

export CORE_EMAIL_EVENTS_TOPIC_ARN="$(jq -r .TopicArn /tmp/run402-core-email-events-topic.json)"
```

Attach Delivery, Bounce, and Complaint events to the configuration set:

```bash
aws sesv2 create-configuration-set-event-destination \
  --region "$CORE_EMAIL_SES_REGION" \
  --configuration-set-name "$CORE_EMAIL_SES_CONFIGURATION_SET" \
  --event-destination-name run402-core-sns \
  --event-destination "Enabled=true,MatchingEventTypes=[SEND,DELIVERY,BOUNCE,COMPLAINT],SnsDestination={TopicArn=$CORE_EMAIL_EVENTS_TOPIC_ARN}" \
  || aws sesv2 update-configuration-set-event-destination \
    --region "$CORE_EMAIL_SES_REGION" \
    --configuration-set-name "$CORE_EMAIL_SES_CONFIGURATION_SET" \
    --event-destination-name run402-core-sns \
    --event-destination "Enabled=true,MatchingEventTypes=[SEND,DELIVERY,BOUNCE,COMPLAINT],SnsDestination={TopicArn=$CORE_EMAIL_EVENTS_TOPIC_ARN}"
```

Package the forwarder Lambda:

```bash
mkdir -p /tmp/run402-core-ses-events-forwarder
cp scripts/core-ses-events-forwarder.mjs /tmp/run402-core-ses-events-forwarder/index.mjs
cd /tmp/run402-core-ses-events-forwarder
zip -q /tmp/run402-core-ses-events-forwarder.zip index.mjs
cd -
```

Create or update the Lambda. Its role only needs normal Lambda logging permissions; it does not need database or SES permissions.

```bash
export CORE_EMAIL_EVENTS_FORWARDER_FUNCTION="run402-core-ses-events-forwarder"
export CORE_EMAIL_EVENTS_FORWARDER_ROLE_ARN="<lambda-execution-role-arn>"

aws lambda create-function \
  --region "$CORE_EMAIL_SES_REGION" \
  --function-name "$CORE_EMAIL_EVENTS_FORWARDER_FUNCTION" \
  --runtime nodejs22.x \
  --handler index.handler \
  --role "$CORE_EMAIL_EVENTS_FORWARDER_ROLE_ARN" \
  --zip-file fileb:///tmp/run402-core-ses-events-forwarder.zip \
  --environment "Variables={CORE_API_BASE=$CORE_API_BASE,CORE_EMAIL_EVENTS_INGEST_TOKEN=$CORE_EMAIL_EVENTS_INGEST_TOKEN}" \
  || aws lambda update-function-code \
    --region "$CORE_EMAIL_SES_REGION" \
    --function-name "$CORE_EMAIL_EVENTS_FORWARDER_FUNCTION" \
    --zip-file fileb:///tmp/run402-core-ses-events-forwarder.zip

aws lambda update-function-configuration \
  --region "$CORE_EMAIL_SES_REGION" \
  --function-name "$CORE_EMAIL_EVENTS_FORWARDER_FUNCTION" \
  --environment "Variables={CORE_API_BASE=$CORE_API_BASE,CORE_EMAIL_EVENTS_INGEST_TOKEN=$CORE_EMAIL_EVENTS_INGEST_TOKEN}"

export CORE_EMAIL_EVENTS_FORWARDER_LAMBDA_ARN="$(aws lambda get-function \
  --region "$CORE_EMAIL_SES_REGION" \
  --function-name "$CORE_EMAIL_EVENTS_FORWARDER_FUNCTION" \
  --query 'Configuration.FunctionArn' \
  --output text)"
```

Subscribe the Lambda to the SNS topic and allow invocation:

```bash
aws lambda add-permission \
  --region "$CORE_EMAIL_SES_REGION" \
  --function-name "$CORE_EMAIL_EVENTS_FORWARDER_FUNCTION" \
  --statement-id run402-core-ses-events \
  --action lambda:InvokeFunction \
  --principal sns.amazonaws.com \
  --source-arn "$CORE_EMAIL_EVENTS_TOPIC_ARN" \
  || true

aws sns subscribe \
  --region "$CORE_EMAIL_SES_REGION" \
  --topic-arn "$CORE_EMAIL_EVENTS_TOPIC_ARN" \
  --protocol lambda \
  --notification-endpoint "$CORE_EMAIL_EVENTS_FORWARDER_LAMBDA_ARN" \
  || true
```

## Restart Core With Email Enabled

On the EC2 host, from the `run402-core` checkout:

```bash
export RUN402_CORE_PUBLIC_HOST="<ec2-public-dns-or-ip>"
export CORE_EMAIL_PROVIDER="ses"
export CORE_EMAIL_FROM_DOMAIN="example.com"
export CORE_EMAIL_SES_REGION="us-east-1"
export CORE_EMAIL_SES_CONFIGURATION_SET="run402-core-events"
export CORE_EMAIL_EVENTS_INGEST_TOKEN="<the token you generated above>"

sudo env \
  RUN402_CORE_PUBLIC_HOST="$RUN402_CORE_PUBLIC_HOST" \
  CORE_GATEWAY_BIND=0.0.0.0 \
  CORE_POSTGREST_BIND=0.0.0.0 \
  CORE_EMAIL_PROVIDER="$CORE_EMAIL_PROVIDER" \
  CORE_EMAIL_FROM_DOMAIN="$CORE_EMAIL_FROM_DOMAIN" \
  CORE_EMAIL_SES_REGION="$CORE_EMAIL_SES_REGION" \
  CORE_EMAIL_SES_CONFIGURATION_SET="$CORE_EMAIL_SES_CONFIGURATION_SET" \
  CORE_EMAIL_EVENTS_INGEST_TOKEN="$CORE_EMAIL_EVENTS_INGEST_TOKEN" \
  docker compose \
    -f docker-compose.yml \
    -f docker-compose.aws-ec2.yml \
    up -d --build core
```

Verify the gateway is healthy:

```bash
curl -s "$CORE_API_BASE/health" | jq .
```

## Create A Project And Mailbox

From any machine that can reach the gateway:

```bash
export CORE_API_BASE="http://<ec2-public-dns-or-ip>:4020"

curl -sS -X POST "$CORE_API_BASE/projects/v1" \
  -H 'content-type: application/json' \
  -d '{"name":"core-email-smoke"}' \
  | tee /tmp/run402-core-email-project.json

export RUN402_PROJECT_ID="$(jq -r .project_id /tmp/run402-core-email-project.json)"
export RUN402_SERVICE_KEY="$(jq -r .service_key /tmp/run402-core-email-project.json)"
```

Create the mailbox:

```bash
curl -sS -X POST "$CORE_API_BASE/mailboxes/v1" \
  -H "authorization: Bearer $RUN402_SERVICE_KEY" \
  -H 'content-type: application/json' \
  -d '{"slug":"signing"}' \
  | tee /tmp/run402-core-email-mailbox.json

export RUN402_MAILBOX_ID="$(jq -r .mailbox_id /tmp/run402-core-email-mailbox.json)"
```

The first active mailbox becomes the default outbound mailbox. Confirm:

```bash
curl -sS "$CORE_API_BASE/mailboxes/v1" \
  -H "authorization: Bearer $RUN402_SERVICE_KEY" \
  | jq .
```

Expected shape:

```json
{
  "mailboxes": [
    {
      "mailbox_id": "mbx_...",
      "address": "signing@example.com",
      "can_send": true,
      "send_blocked_reason": null,
      "can_receive": false,
      "receive_blocked_reason": "provider_not_configured"
    }
  ],
  "mailbox_settings": {
    "default_outbound_mailbox_id": "mbx_..."
  },
  "provider_readiness": {
    "status": "configured",
    "provider": "ses",
    "from_domain": "example.com"
  },
  "inbound_provider_readiness": {
    "status": "not_configured",
    "provider": "disabled"
  }
}
```

If the mailbox is not the default, set it explicitly:

```bash
curl -sS -X PATCH "$CORE_API_BASE/mailboxes/v1/settings" \
  -H "authorization: Bearer $RUN402_SERVICE_KEY" \
  -H 'content-type: application/json' \
  -d "{\"default_outbound_mailbox_id\":\"$RUN402_MAILBOX_ID\"}" \
  | jq .
```

## Send A Raw Test Email

```bash
export TEST_RECIPIENT="you@example.com"

curl -sS -X POST "$CORE_API_BASE/mailboxes/v1/$RUN402_MAILBOX_ID/messages" \
  -H "authorization: Bearer $RUN402_SERVICE_KEY" \
  -H 'content-type: application/json' \
  -d "$(jq -n --arg to "$TEST_RECIPIENT" '{
    to: $to,
    subject: "Run402 Core email smoke",
    html: "<p>Hello from Run402 Core on AWS.</p>",
    text: "Hello from Run402 Core on AWS.",
    from_name: "Run402 Core"
  }')" \
  | tee /tmp/run402-core-email-send.json
```

Expected:

```json
{
  "message_id": "msg_...",
  "mailbox_id": "mbx_...",
  "from_address": "signing@example.com",
  "to": "you@example.com",
  "status": "sent",
  "delivery_state": "accepted",
  "provider": "ses"
}
```

`delivery_state: "accepted"` means SES accepted the message. It is not a final delivery receipt. After SES forwards a Delivery, Bounce, or Complaint event, the same message can later show `delivery_state: "delivered"`, `"bounced"`, or `"complained"`.

List the stored message:

```bash
curl -sS "$CORE_API_BASE/mailboxes/v1/$RUN402_MAILBOX_ID/messages" \
  -H "authorization: Bearer $RUN402_SERVICE_KEY" \
  | jq .
```

Register a delivery-operation webhook if your app wants live events:

```bash
export EMAIL_EVENTS_WEBHOOK_URL="https://example.com/run402-email-events"

curl -sS -X POST "$CORE_API_BASE/mailboxes/v1/$RUN402_MAILBOX_ID/webhooks" \
  -H "authorization: Bearer $RUN402_SERVICE_KEY" \
  -H 'content-type: application/json' \
  -d "$(jq -n --arg url "$EMAIL_EVENTS_WEBHOOK_URL" '{url: $url, events: ["delivery", "bounced", "complained"]}')" \
  | jq .
```

The webhook body is the stable Core envelope:

```json
{
  "id": "whd_...",
  "type": "bounced",
  "schema_version": "1",
  "idempotency_key": "wh_...:bounced:<provider-message-id>",
  "payload": {
    "mailbox_id": "mbx_...",
    "message_id": "msg_...",
    "to_address": "bad@example.com",
    "provider": "ses",
    "provider_message_id": "<ses-message-id>",
    "bounce_type": "Permanent"
  }
}
```

List the durable delivery log:

```bash
curl -sS "$CORE_API_BASE/mailboxes/v1/$RUN402_MAILBOX_ID/webhooks/deliveries" \
  -H "authorization: Bearer $RUN402_SERVICE_KEY" \
  | jq '.deliveries[] | {delivery_id, event_type, status, attempts, last_status, last_error}'
```

Redrive a terminal failed delivery:

```bash
export WEBHOOK_DELIVERY_ID="whd_..."

curl -sS -X POST "$CORE_API_BASE/mailboxes/v1/$RUN402_MAILBOX_ID/webhooks/deliveries/$WEBHOOK_DELIVERY_ID/redrive" \
  -H "authorization: Bearer $RUN402_SERVICE_KEY" \
  | jq .
```

For a local simulator smoke, post a synthetic Bounce notification to Core. This does not require waiting for SES, but it does require a real `provider_message_id` from a prior send:

```bash
export PROVIDER_MESSAGE_ID="$(jq -r .provider_message_id /tmp/run402-core-email-send.json)"

curl -sS -X POST "$CORE_API_BASE/mailboxes/v1/events/ingestions" \
  -H "authorization: Bearer $CORE_EMAIL_EVENTS_INGEST_TOKEN" \
  -H 'content-type: application/json' \
  -d "$(jq -n --arg id "$PROVIDER_MESSAGE_ID" --arg to "$TEST_RECIPIENT" '{
    eventType: "Bounce",
    mail: { messageId: $id, destination: [$to] },
    bounce: { bounceType: "Permanent", bouncedRecipients: [{ emailAddress: $to }] }
  }')" \
  | jq .
```

After a permanent bounce, Core adds a project-scoped suppression for that recipient. The same project will receive `recipient_suppressed` before any future provider call to that address. A Complaint event creates a gateway-global suppression and suspends the mailbox.

## Attachment Smoke Test

```bash
printf '%s\n' '%PDF-1.7 core email smoke' > /tmp/run402-core-smoke.pdf

curl -sS -X POST "$CORE_API_BASE/mailboxes/v1/$RUN402_MAILBOX_ID/messages" \
  -H "authorization: Bearer $RUN402_SERVICE_KEY" \
  -H 'content-type: application/json' \
  -d "$(jq -n \
    --arg to "$TEST_RECIPIENT" \
    --arg pdf "$(base64 < /tmp/run402-core-smoke.pdf | tr -d '\n')" \
    '{
      to: $to,
      subject: "Run402 Core attachment smoke",
      html: "<p>The PDF is attached.</p>",
      text: "The PDF is attached.",
      attachments: [{
        filename: "run402-core-smoke.pdf",
        content_type: "application/pdf",
        content_base64: $pdf
      }]
    }')" \
  | jq .
```

Core stores attachment metadata only. Verify the message list contains `attachments_meta` and does not contain the base64 payload:

```bash
curl -sS "$CORE_API_BASE/mailboxes/v1/$RUN402_MAILBOX_ID/messages" \
  -H "authorization: Bearer $RUN402_SERVICE_KEY" \
  | jq '.messages[] | {message_id, attachments_meta}'
```

## KeySigned-Oriented Proof

After deploying KeySigned to this Core project with the normal apply path, the app should use the same project service key and default mailbox. From the KeySigned repo, run:

```bash
export RUN402_API_BASE="$CORE_API_BASE"
export RUN402_PROJECT_ID="$RUN402_PROJECT_ID"
export RUN402_SERVICE_KEY="$RUN402_SERVICE_KEY"
export RUN402_ANON_KEY="<project-anon-key>"
export KYSIGNED_CORE_EMAIL_TO="$TEST_RECIPIENT"

npm run smoke:run402-core-email -- \
  --mailbox-slug signing \
  --out /tmp/kysigned-core-email-evidence.json
```

Expected output includes:

```json
{
  "ok": true,
  "target": "run402-core",
  "mailbox_slug": "signing",
  "send": {
    "status": "sent",
    "delivery_state": "accepted"
  },
  "attachment_metadata_only": true
}
```

The script creates or reuses the mailbox, sets it as the default outbound mailbox, sends a signing-request-style email with a PDF attachment, then reads Core's message row to prove only attachment metadata was persisted.

To prove the Core delivery-event path reaches the deployed KeySigned webhook, register the app webhook and simulate a permanent bounce:

```bash
export KYSIGNED_WEBHOOK_URL="$CORE_API_BASE/projects/v1/$RUN402_PROJECT_ID/static/v1/webhooks/inbound"
export CORE_EMAIL_EVENTS_INGEST_TOKEN="<the Core host token>"

npm run smoke:run402-core-email -- \
  --mailbox-slug signing \
  --webhook-url "$KYSIGNED_WEBHOOK_URL" \
  --simulate-bounce \
  --wait-for-webhook 60 \
  --out /tmp/kysigned-core-email-bounce-evidence.json
```

On an HTTPS Core gateway, use the public HTTPS KeySigned URL for `KYSIGNED_WEBHOOK_URL`. On a single-host HTTP development gateway, use `http://127.0.0.1:4020/...` from inside the Core host so the URL passes Core's localhost development policy.

A direct curl equivalent is:

```bash
curl -sS -X POST "$CORE_API_BASE/mailboxes/v1/$RUN402_MAILBOX_ID/messages" \
  -H "authorization: Bearer $RUN402_SERVICE_KEY" \
  -H 'content-type: application/json' \
  -d "$(jq -n \
    --arg to "$TEST_RECIPIENT" \
    --arg pdf "$(base64 < /tmp/run402-core-smoke.pdf | tr -d '\n')" \
    '{
      to: $to,
      subject: "Signature requested: Core portability proof",
      html: "<p>Please review the attached document. To sign, forward this email to the configured signing mailbox.</p>",
      text: "Please review the attached document. To sign, forward this email to the configured signing mailbox.",
      from_name: "KeySigned Core",
      attachments: [{
        filename: "approval-page.pdf",
        content_type: "application/pdf",
        content_base64: $pdf
      }]
    }')" \
  | jq .
```

This proves outbound signing-request-style email and attachment metadata on Core. To prove reply-to-sign, continue with `docs/deployment/aws-email-inbound/README.md` and reply to the Core mailbox.

## Troubleshooting

### `provider_not_configured`

The gateway did not receive email provider env vars.

Check:

```bash
sudo env RUN402_CORE_PUBLIC_HOST="$RUN402_CORE_PUBLIC_HOST" \
  docker compose -f docker-compose.yml -f docker-compose.aws-ec2.yml exec core env \
  | grep '^CORE_EMAIL_'
```

Expected:

```text
CORE_EMAIL_PROVIDER=ses
CORE_EMAIL_FROM_DOMAIN=example.com
CORE_EMAIL_SES_REGION=us-east-1
```

Restart the `core` service with the env vars from this guide.

### `provider_sender_or_recipient_not_verified`

SES rejected the send because the sender domain or recipient is not verified, or the account is still in sandbox.

Check:

```bash
aws sesv2 get-email-identity \
  --region "$CORE_EMAIL_SES_REGION" \
  --email-identity "$CORE_EMAIL_FROM_DOMAIN"

aws sesv2 get-account \
  --region "$CORE_EMAIL_SES_REGION"
```

Verify the recipient too if the account is in sandbox.

### `provider_access_denied`

The gateway's AWS credential source lacks `ses:SendEmail` or `ses:SendRawEmail`.

Check the instance role:

```bash
aws sts get-caller-identity
```

Then attach a policy that allows `ses:SendEmail` and `ses:SendRawEmail` for the SES identity. Core uses SES raw MIME when a message has attachments.

### Attachment Rejected Before Provider Call

Core validates attachments before calling SES. Common causes:

- more than 5 attachments
- decoded total over 15 MB
- invalid base64
- unsafe filename with control characters
- executable content type

Fix the request and retry. A validation failure does not call the provider and does not create a message row.

## Cleanup

If this was a disposable EC2 drill, follow the cleanup steps in `docs/deployment/aws-ec2/README.md`.
