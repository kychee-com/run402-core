# Enable Core Outbound Email On AWS

This guide adds outbound email to a Dockerized Run402 Core gateway running on AWS. It keeps the important boundary intact:

- apps still deploy with `run402 deploy apply --manifest`
- app code still calls the same `/mailboxes/v1` contract and `@run402/functions.email.send`
- the Core operator owns the email provider account, sender domain, DNS, reputation, sandbox status, and delivery operations

This guide covers outbound transactional email only. Inbound reply-to-sign, bounce/complaint reconciliation, delivery webhooks, managed sender-domain automation, suppression automation, and abuse operations are separate follow-up features.

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

## Restart Core With Email Enabled

On the EC2 host, from the `run402-core` checkout:

```bash
export RUN402_CORE_PUBLIC_HOST="<ec2-public-dns-or-ip>"
export CORE_EMAIL_PROVIDER="ses"
export CORE_EMAIL_FROM_DOMAIN="example.com"
export CORE_EMAIL_SES_REGION="us-east-1"

sudo env \
  RUN402_CORE_PUBLIC_HOST="$RUN402_CORE_PUBLIC_HOST" \
  CORE_GATEWAY_BIND=0.0.0.0 \
  CORE_POSTGREST_BIND=0.0.0.0 \
  CORE_EMAIL_PROVIDER="$CORE_EMAIL_PROVIDER" \
  CORE_EMAIL_FROM_DOMAIN="$CORE_EMAIL_FROM_DOMAIN" \
  CORE_EMAIL_SES_REGION="$CORE_EMAIL_SES_REGION" \
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
      "send_blocked_reason": null
    }
  ],
  "mailbox_settings": {
    "default_outbound_mailbox_id": "mbx_..."
  },
  "provider_readiness": {
    "status": "configured",
    "provider": "ses",
    "from_domain": "example.com"
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

`delivery_state: "accepted"` means SES accepted the message. It is not a final delivery receipt.

List the stored message:

```bash
curl -sS "$CORE_API_BASE/mailboxes/v1/$RUN402_MAILBOX_ID/messages" \
  -H "authorization: Bearer $RUN402_SERVICE_KEY" \
  | jq .
```

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

This proves outbound signing-request-style email and attachment metadata on Core. It does not prove reply-to-sign until the inbound email adapter exists.

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
