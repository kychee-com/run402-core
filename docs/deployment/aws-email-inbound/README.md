# Enable Core Inbound Email On AWS

This guide adds inbound reply reception to a Dockerized Run402 Core gateway running on AWS.

The boundary stays simple:

- apps still deploy with the normal Run402 apply path
- app code still uses `/mailboxes/v1`
- SES receives SMTP and stores raw RFC-822 messages
- a small forwarder calls the Core ingestion endpoint
- Core resolves the mailbox, enforces reply-first policy, stores the inbound message, preserves raw bytes, and enqueues `reply_received`

This guide assumes outbound email is already working from `docs/deployment/aws-email/README.md`.

## What You Need

- A reachable Core gateway on AWS
- SES receiving available in one region
- A domain or subdomain you can route to SES receiving
- An object-storage bucket for raw inbound messages
- A Lambda execution role for `scripts/core-ses-inbound-forwarder.mjs`
- `aws`, `curl`, `jq`, `zip`, and `docker compose`

Set the operator variables:

```bash
export CORE_API_BASE="http://<ec2-public-dns-or-ip>:4020"
export CORE_EMAIL_INBOUND_PROVIDER="ses"
export CORE_EMAIL_INBOUND_DOMAINS="example.com"
export CORE_EMAIL_INBOUND_SES_REGION="us-east-1"
export CORE_EMAIL_INBOUND_RAW_BUCKET="run402-core-inbound-$(date +%s)"
export CORE_EMAIL_INBOUND_RAW_PREFIX="inbound-email/"
export CORE_EMAIL_INBOUND_INGEST_TOKEN="$(openssl rand -hex 32)"
```

Use the same domain as outbound if that is safe for your test, or use a dedicated subdomain for the first proof.

## Create Raw Message Storage

```bash
aws s3api create-bucket \
  --region "$CORE_EMAIL_INBOUND_SES_REGION" \
  --bucket "$CORE_EMAIL_INBOUND_RAW_BUCKET"

aws s3api put-public-access-block \
  --bucket "$CORE_EMAIL_INBOUND_RAW_BUCKET" \
  --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
```

Expected: both commands return successfully. The bucket is private and operator-owned.

## Deploy The Forwarder

Create a role for the Lambda in the AWS console or your infra tool. It needs normal Lambda logging permissions. It does not need database access and does not need to read raw message objects.

Package the forwarder:

```bash
mkdir -p /tmp/run402-core-ses-forwarder
cp scripts/core-ses-inbound-forwarder.mjs /tmp/run402-core-ses-forwarder/index.mjs
cd /tmp/run402-core-ses-forwarder
zip -q /tmp/run402-core-ses-forwarder.zip index.mjs
cd -
```

Create or update the Lambda:

```bash
export CORE_EMAIL_FORWARDER_FUNCTION="run402-core-ses-forwarder"
export CORE_EMAIL_FORWARDER_ROLE_ARN="<lambda-execution-role-arn>"

aws lambda create-function \
  --region "$CORE_EMAIL_INBOUND_SES_REGION" \
  --function-name "$CORE_EMAIL_FORWARDER_FUNCTION" \
  --runtime nodejs22.x \
  --handler index.handler \
  --role "$CORE_EMAIL_FORWARDER_ROLE_ARN" \
  --zip-file fileb:///tmp/run402-core-ses-forwarder.zip \
  --environment "Variables={CORE_API_BASE=$CORE_API_BASE,CORE_EMAIL_INBOUND_INGEST_TOKEN=$CORE_EMAIL_INBOUND_INGEST_TOKEN,CORE_EMAIL_INBOUND_RAW_BUCKET=$CORE_EMAIL_INBOUND_RAW_BUCKET,CORE_EMAIL_INBOUND_RAW_PREFIX=$CORE_EMAIL_INBOUND_RAW_PREFIX}" \
  || aws lambda update-function-code \
    --region "$CORE_EMAIL_INBOUND_SES_REGION" \
    --function-name "$CORE_EMAIL_FORWARDER_FUNCTION" \
    --zip-file fileb:///tmp/run402-core-ses-forwarder.zip

aws lambda update-function-configuration \
  --region "$CORE_EMAIL_INBOUND_SES_REGION" \
  --function-name "$CORE_EMAIL_FORWARDER_FUNCTION" \
  --environment "Variables={CORE_API_BASE=$CORE_API_BASE,CORE_EMAIL_INBOUND_INGEST_TOKEN=$CORE_EMAIL_INBOUND_INGEST_TOKEN,CORE_EMAIL_INBOUND_RAW_BUCKET=$CORE_EMAIL_INBOUND_RAW_BUCKET,CORE_EMAIL_INBOUND_RAW_PREFIX=$CORE_EMAIL_INBOUND_RAW_PREFIX}"
```

Capture the function identifier for the SES rule:

```bash
export CORE_EMAIL_FORWARDER_LAMBDA_ARN="$(aws lambda get-function \
  --region "$CORE_EMAIL_INBOUND_SES_REGION" \
  --function-name "$CORE_EMAIL_FORWARDER_FUNCTION" \
  --query 'Configuration.FunctionArn' \
  --output text)"
```

Allow SES to invoke it:

```bash
aws lambda add-permission \
  --region "$CORE_EMAIL_INBOUND_SES_REGION" \
  --function-name "$CORE_EMAIL_FORWARDER_FUNCTION" \
  --statement-id run402-core-ses-receive \
  --action lambda:InvokeFunction \
  --principal "$(printf 'ses.%s.%s' 'amazonaws' 'com')" \
  || true
```

## Configure SES Receiving

Verify the inbound identity if it is not already verified:

```bash
aws sesv2 create-email-identity \
  --region "$CORE_EMAIL_INBOUND_SES_REGION" \
  --email-identity "$CORE_EMAIL_INBOUND_DOMAINS" \
  || true

aws sesv2 get-email-identity \
  --region "$CORE_EMAIL_INBOUND_SES_REGION" \
  --email-identity "$CORE_EMAIL_INBOUND_DOMAINS"
```

Add the DNS records SES shows for verification. Then add the MX record SES shows for inbound receiving. Use the exact MX target shown in the SES console for your region.

Make sure you add the MX record at the authoritative DNS provider for the domain. A Route53 hosted zone can exist without being authoritative if the registrar delegates the domain to another provider.

```bash
dig +short NS "$CORE_EMAIL_INBOUND_DOMAINS"
dig +short MX "$CORE_EMAIL_INBOUND_DOMAINS"
```

Expected:

```text
10 inbound-smtp.<region>.<provider-domain>.
```

Create a receipt rule set and rule:

```bash
export CORE_EMAIL_RULE_SET="run402-core-inbound"
export CORE_EMAIL_RULE="run402-core-store-and-forward"

aws ses create-receipt-rule-set \
  --region "$CORE_EMAIL_INBOUND_SES_REGION" \
  --rule-set-name "$CORE_EMAIL_RULE_SET" \
  || true

aws ses set-active-receipt-rule-set \
  --region "$CORE_EMAIL_INBOUND_SES_REGION" \
  --rule-set-name "$CORE_EMAIL_RULE_SET"

jq -n \
  --arg name "$CORE_EMAIL_RULE" \
  --arg domain "$CORE_EMAIL_INBOUND_DOMAINS" \
  --arg bucket "$CORE_EMAIL_INBOUND_RAW_BUCKET" \
  --arg prefix "$CORE_EMAIL_INBOUND_RAW_PREFIX" \
  --arg function "$CORE_EMAIL_FORWARDER_LAMBDA_ARN" \
  '{
    Name: $name,
    Enabled: true,
    Recipients: [$domain],
    Actions: [
      { S3Action: { BucketName: $bucket, ObjectKeyPrefix: $prefix } },
      { LambdaAction: { FunctionArn: $function, InvocationType: "Event" } }
    ],
    ScanEnabled: true
  }' \
  > /tmp/run402-core-ses-rule.json

aws ses create-receipt-rule \
  --region "$CORE_EMAIL_INBOUND_SES_REGION" \
  --rule-set-name "$CORE_EMAIL_RULE_SET" \
  --rule file:///tmp/run402-core-ses-rule.json \
  || aws ses update-receipt-rule \
    --region "$CORE_EMAIL_INBOUND_SES_REGION" \
    --rule-set-name "$CORE_EMAIL_RULE_SET" \
    --rule file:///tmp/run402-core-ses-rule.json
```

Expected:

```bash
aws ses describe-active-receipt-rule-set \
  --region "$CORE_EMAIL_INBOUND_SES_REGION" \
  | jq '.Rules[] | {Name, Enabled, Recipients, Actions}'
```

## Restart Core With Inbound Enabled

On the EC2 host, from the `run402-core` checkout:

```bash
export RUN402_CORE_PUBLIC_HOST="<ec2-public-dns-or-ip>"

sudo env \
  RUN402_CORE_PUBLIC_HOST="$RUN402_CORE_PUBLIC_HOST" \
  CORE_GATEWAY_BIND=0.0.0.0 \
  CORE_POSTGREST_BIND=0.0.0.0 \
  CORE_EMAIL_PROVIDER="$CORE_EMAIL_PROVIDER" \
  CORE_EMAIL_FROM_DOMAIN="$CORE_EMAIL_FROM_DOMAIN" \
  CORE_EMAIL_SES_REGION="$CORE_EMAIL_SES_REGION" \
  CORE_EMAIL_INBOUND_PROVIDER="$CORE_EMAIL_INBOUND_PROVIDER" \
  CORE_EMAIL_INBOUND_DOMAINS="$CORE_EMAIL_INBOUND_DOMAINS" \
  CORE_EMAIL_INBOUND_INGEST_TOKEN="$CORE_EMAIL_INBOUND_INGEST_TOKEN" \
  CORE_EMAIL_INBOUND_SES_REGION="$CORE_EMAIL_INBOUND_SES_REGION" \
  CORE_EMAIL_INBOUND_RAW_BUCKET="$CORE_EMAIL_INBOUND_RAW_BUCKET" \
  CORE_EMAIL_INBOUND_RAW_PREFIX="$CORE_EMAIL_INBOUND_RAW_PREFIX" \
  docker compose \
    -f docker-compose.yml \
    -f docker-compose.aws-ec2.yml \
    up -d --build core
```

Check receive readiness:

```bash
curl -sS "$CORE_API_BASE/mailboxes/v1" \
  -H "authorization: Bearer $RUN402_SERVICE_KEY" \
  | jq '.inbound_provider_readiness, .mailboxes[] | {address, can_send, can_receive, send_blocked_reason, receive_blocked_reason}'
```

Expected mailbox shape:

```json
{
  "address": "signing@example.com",
  "can_send": true,
  "can_receive": true,
  "send_blocked_reason": null,
  "receive_blocked_reason": null
}
```

## Register A Reply Webhook

This is optional because message polling is always a backstop.

```bash
export REPLY_WEBHOOK_URL="https://example.com/run402-email-events"

curl -sS -X POST "$CORE_API_BASE/mailboxes/v1/$RUN402_MAILBOX_ID/webhooks" \
  -H "authorization: Bearer $RUN402_SERVICE_KEY" \
  -H 'content-type: application/json' \
  -d "$(jq -n --arg url "$REPLY_WEBHOOK_URL" '{url: $url, events: ["reply_received"]}')" \
  | jq .
```

## Prove Inbound Reply Reception

First send a message through the outbound guide. Then reply from the recipient inbox to the mailbox address, for example `signing@example.com`.

Poll for inbound messages:

```bash
curl -sS "$CORE_API_BASE/mailboxes/v1/$RUN402_MAILBOX_ID/messages?direction=inbound" \
  -H "authorization: Bearer $RUN402_SERVICE_KEY" \
  | tee /tmp/run402-core-inbound-messages.json \
  | jq .
```

Expected:

```json
{
  "messages": [
    {
      "message_id": "msg_...",
      "direction": "inbound",
      "from_address": "sender@example.net",
      "to": "signing@example.com",
      "status": "received",
      "delivery_state": "received",
      "provider": "ses",
      "provider_message_id": "..."
    }
  ]
}
```

Fetch raw MIME for zk-email or DKIM inspection:

```bash
export RUN402_INBOUND_MESSAGE_ID="$(jq -r '.messages[0].message_id' /tmp/run402-core-inbound-messages.json)"

curl -sS "$CORE_API_BASE/mailboxes/v1/$RUN402_MAILBOX_ID/messages/$RUN402_INBOUND_MESSAGE_ID/raw" \
  -H "authorization: Bearer $RUN402_SERVICE_KEY" \
  -o /tmp/run402-core-inbound.eml

file /tmp/run402-core-inbound.eml
```

Check the webhook delivery queue:

```bash
curl -sS "$CORE_API_BASE/mailboxes/v1/$RUN402_MAILBOX_ID/webhooks/deliveries?status=pending" \
  -H "authorization: Bearer $RUN402_SERVICE_KEY" \
  | jq .
```

## KeySigned Reply-To-Sign Proof

For the first portability proof:

1. Deploy KeySigned to the same Core project using the normal apply path.
2. Configure the app to use `RUN402_API_BASE=$CORE_API_BASE`.
3. Send a signing-request-style email through Core outbound SES.
4. Reply to the Core mailbox address.
5. Confirm the reply appears through `messages?direction=inbound`.
6. Confirm any registered `reply_received` delivery references the same inbound `message_id`.

No Run402 Cloud mailbox, managed sender domain, fleet routing, billing, or Cloud email Lambda is part of this proof.

## Troubleshooting

### `provider_not_configured`

Core did not receive inbound provider env vars. Check:

```bash
docker compose -f docker-compose.yml -f docker-compose.aws-ec2.yml exec core env \
  | grep '^CORE_EMAIL_INBOUND_'
```

### `provider_misconfigured`

One of these is missing:

```text
CORE_EMAIL_INBOUND_PROVIDER=ses
CORE_EMAIL_INBOUND_DOMAINS=example.com
CORE_EMAIL_INBOUND_INGEST_TOKEN=<secret>
CORE_EMAIL_INBOUND_SES_REGION=us-east-1
CORE_EMAIL_INBOUND_RAW_BUCKET=<bucket>
```

### Ingestion token mismatch

The forwarder and Core must use the same `CORE_EMAIL_INBOUND_INGEST_TOKEN`. Update the Lambda environment and restart Core with the same value.

### No inbound message appears

Check in this order:

```bash
aws ses describe-active-receipt-rule-set \
  --region "$CORE_EMAIL_INBOUND_SES_REGION"

aws lambda get-function \
  --region "$CORE_EMAIL_INBOUND_SES_REGION" \
  --function-name "$CORE_EMAIL_FORWARDER_FUNCTION"

aws s3api list-objects-v2 \
  --bucket "$CORE_EMAIL_INBOUND_RAW_BUCKET" \
  --prefix "$CORE_EMAIL_INBOUND_RAW_PREFIX" \
  --max-items 5
```

If objects exist but Core has no inbound messages, inspect the Lambda logs. Common causes are a wrong `CORE_API_BASE`, a closed EC2 security group, or an ingestion-token mismatch.

If no objects exist, check that the MX record is visible from public DNS and that the nameservers returned by `dig NS "$CORE_EMAIL_INBOUND_DOMAINS"` are the same provider where you created the MX record.

### Reply is dropped as unsolicited

Core's first inbound slice is reply-first. The sender must reply to a message that the Core mailbox previously sent to that sender. Compose-new email to the mailbox is intentionally dropped.
