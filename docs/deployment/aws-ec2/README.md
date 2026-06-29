# Run Run402 Core On AWS EC2

This guide is the first generic AWS portability drill for Run402 Core. It shows how to run the open-source Core Gateway Docker Compose stack on a plain EC2 instance and import a portable archive into that self-hosted Core runtime.

Today, this guide is fully executable with the public portable archive fixture in this repo. That proves the Core side of the portability promise: gateway, Postgres, PostgREST/RLS, static/storage bytes, trusted local functions, and narrow Astro SSR can run outside Run402 Cloud.

The final "port a live Run402 Cloud project to AWS" path also needs the managed Cloud export/download CLI/API. That Cloud export surface is specified by the portable project archive contract, but it is not exposed in the current public `run402` CLI yet. Do not present the Cloud export command below as shipped until that feature lands.

## What This Proves Today

This walkthrough proves:

- the open-source Core Gateway can run on generic AWS infrastructure
- Core can import a valid `run402-project-archive.v1` archive into a new local project
- static routes, storage bytes, trusted local functions, narrow Astro SSR, Postgres schema/data, and REST/RLS behavior run outside Run402 Cloud
- the AWS host can serve the imported project through the Core Gateway without calling Run402 Cloud

This walkthrough does not yet prove:

- exporting a live Cloud project from Run402 Cloud
- downloading that Cloud archive through the public CLI
- importing back into managed Run402 Cloud
- production managed operations such as backups, PITR, HA, monitoring, abuse controls, TLS automation, custom domains, compliance, or support

Run402 Cloud should be the easiest place to start. This guide is the AWS-side proof that the supported Core runtime slice can run elsewhere.

## Current Shape

This is an EC2 + Docker Compose Developer Preview path.

```text
EC2
  Docker Compose
    core gateway        :4020
    function worker     internal
    Postgres 16         local Docker volume
    PostgREST v12.2.3   :4300
    content/function volumes
```

Future production distributions can move pieces to ECS, RDS, S3-compatible storage, ALB, TLS, Route53, CloudWatch, and IaC. Those are separate product/distribution features. They are not required for this first portability drill.

## Prerequisites

Local machine:

- AWS CLI configured for an account where you can create EC2 resources
- SSH and `scp`
- Optional: `rsync`, when copying an unpublished local Core checkout to EC2

AWS:

- Region: this guide uses `us-east-1`
- EC2 instance: `t4g.medium` or larger, Ubuntu 24.04 ARM64
- Security group ingress limited to your IP for:
  - `22/tcp` SSH
  - `4020/tcp` Core Gateway
  - `4300/tcp` PostgREST preview endpoint

Do not open `4020` or `4300` to the internet during this Developer Preview unless you understand the risk.

## Step 1: Launch An EC2 Host

From your local machine:

```bash
export AWS_PROFILE=kychee
export AWS_REGION=us-east-1
export RUN402_CORE_NAME="run402-core-aws-preview-$(date +%Y%m%d%H%M%S)"
export MY_IP="$(curl -s https://checkip.amazonaws.com | tr -d '\n')"
```

Find the latest Ubuntu 24.04 ARM64 AMI and default VPC:

```bash
export RUN402_CORE_AMI="$(
  aws ec2 describe-images \
    --owners 099720109477 \
    --filters \
      "Name=name,Values=ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-*" \
      "Name=architecture,Values=arm64" \
      "Name=virtualization-type,Values=hvm" \
    --query 'Images | sort_by(@, &CreationDate)[-1].ImageId' \
    --output text
)"

export RUN402_CORE_VPC_ID="$(
  aws ec2 describe-vpcs \
    --filters Name=isDefault,Values=true \
    --query 'Vpcs[0].VpcId' \
    --output text
)"
```

Create an SSH key and security group:

```bash
aws ec2 create-key-pair \
  --key-name "$RUN402_CORE_NAME" \
  --query KeyMaterial \
  --output text > "$RUN402_CORE_NAME.pem"
chmod 600 "$RUN402_CORE_NAME.pem"

export RUN402_CORE_SG="$(
  aws ec2 create-security-group \
    --vpc-id "$RUN402_CORE_VPC_ID" \
    --group-name "$RUN402_CORE_NAME" \
    --description "Run402 Core AWS preview" \
    --query GroupId \
    --output text
)"

aws ec2 authorize-security-group-ingress \
  --group-id "$RUN402_CORE_SG" \
  --ip-permissions \
    "IpProtocol=tcp,FromPort=22,ToPort=22,IpRanges=[{CidrIp=${MY_IP}/32,Description=ssh}]" \
    "IpProtocol=tcp,FromPort=4020,ToPort=4020,IpRanges=[{CidrIp=${MY_IP}/32,Description=core-gateway}]" \
    "IpProtocol=tcp,FromPort=4300,ToPort=4300,IpRanges=[{CidrIp=${MY_IP}/32,Description=postgrest-preview}]"
```

Launch the instance:

```bash
export RUN402_CORE_INSTANCE_ID="$(
  aws ec2 run-instances \
    --image-id "$RUN402_CORE_AMI" \
    --instance-type t4g.medium \
    --key-name "$RUN402_CORE_NAME" \
    --security-group-ids "$RUN402_CORE_SG" \
    --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=24,VolumeType=gp3,DeleteOnTermination=true}' \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=${RUN402_CORE_NAME}}]" \
    --query 'Instances[0].InstanceId' \
    --output text
)"

aws ec2 wait instance-running --instance-ids "$RUN402_CORE_INSTANCE_ID"

export RUN402_CORE_PUBLIC_HOST="$(
  aws ec2 describe-instances \
    --instance-ids "$RUN402_CORE_INSTANCE_ID" \
    --query 'Reservations[0].Instances[0].PublicDnsName' \
    --output text
)"

echo "$RUN402_CORE_PUBLIC_HOST"
```

## Step 2: Install Docker And Get Core

SSH into the instance:

```bash
ssh -i "$RUN402_CORE_NAME.pem" "ubuntu@$RUN402_CORE_PUBLIC_HOST"
```

On the EC2 host:

```bash
sudo apt-get update
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
  ca-certificates \
  curl \
  docker.io \
  docker-compose-v2 \
  git \
  jq \
  rsync
sudo usermod -aG docker ubuntu
sudo docker --version
sudo docker compose version
```

Clone Core:

```bash
git clone https://github.com/kychee-com/run402-core.git
cd run402-core
```

If you are testing unpublished local changes, copy your local checkout instead of cloning. From your local machine, in the Core checkout:

```bash
rsync -az --delete \
  --exclude .git \
  --exclude node_modules \
  --exclude imports \
  --exclude .run402-core \
  ./ "ubuntu@$RUN402_CORE_PUBLIC_HOST:/home/ubuntu/run402-core/"
```

The commands below use `sudo docker` so the walkthrough works immediately. You can log out and back in later if you want the `docker` group membership to take effect and drop `sudo`.

## Step 3: Start Core On EC2

On the EC2 host:

```bash
export RUN402_CORE_PUBLIC_HOST="<your-ec2-public-dns-or-ip>"

mkdir -p imports

sudo env \
  RUN402_CORE_PUBLIC_HOST="$RUN402_CORE_PUBLIC_HOST" \
  CORE_GATEWAY_BIND=0.0.0.0 \
  CORE_POSTGREST_BIND=0.0.0.0 \
  docker compose \
    -f docker-compose.yml \
    -f docker-compose.aws-ec2.yml \
    up -d --build core
```

Verify:

```bash
curl -s "http://$RUN402_CORE_PUBLIC_HOST:4020/health" | jq .

sudo env RUN402_CORE_PUBLIC_HOST="$RUN402_CORE_PUBLIC_HOST" \
  docker compose -f docker-compose.yml -f docker-compose.aws-ec2.yml ps
```

Expected health:

```json
{
  "status": "ok",
  "mode": "core"
}
```

## Step 4: Import The Known-Good Fixture

Before using a live Cloud export, verify the AWS host with the public fixture that ships in this repo.

On the EC2 host:

```bash
export FIXTURE_IMPORT_NAME="aws-fixture-$(date +%s)"

cat > fixture-import-request.json <<EOF
{
  "archive_path": "/app/fixtures/portable-project-archive-core/archive",
  "name": "$FIXTURE_IMPORT_NAME",
  "require_runnable": true,
  "secret_values": {
    "OPENAI_API_KEY": "present"
  }
}
EOF

curl -sS \
  -X POST "http://$RUN402_CORE_PUBLIC_HOST:4020/archives/v1/import" \
  -H 'content-type: application/json' \
  --data-binary @fixture-import-request.json | tee fixture-import-result.json | jq .

export FIXTURE_PROJECT_ID="$(jq -r '.project_id' fixture-import-result.json)"
```

Verify the runtime surface:

```bash
curl -fsS "http://$RUN402_CORE_PUBLIC_HOST:4020/projects/v1/$FIXTURE_PROJECT_ID/static/index.html" \
  | grep "Portable archive fixture"

curl -fsS "http://$RUN402_CORE_PUBLIC_HOST:4020/projects/v1/$FIXTURE_PROJECT_ID/storage/public/objects/public.txt" \
  | grep "public object from archive fixture"

curl -fsS "http://$RUN402_CORE_PUBLIC_HOST:4020/projects/v1/$FIXTURE_PROJECT_ID/static/api" \
  | grep "hello from portable archive function"

curl -fsS "http://$RUN402_CORE_PUBLIC_HOST:4020/projects/v1/$FIXTURE_PROJECT_ID/static/some-ssr-path" \
  | grep "astro ssr fixture"
```

Verify REST/RLS:

```bash
curl -sS "http://$RUN402_CORE_PUBLIC_HOST:4020/projects/v1/$FIXTURE_PROJECT_ID" \
  | tee fixture-project.json | jq .

export FIXTURE_SCHEMA_SLOT="$(jq -r '.schema_slot' fixture-project.json)"

curl -sS \
  -X POST "http://$RUN402_CORE_PUBLIC_HOST:4020/auth/v1/dev-tokens" \
  -H 'content-type: application/json' \
  --data-binary '{"project_id":"'"$FIXTURE_PROJECT_ID"'","role":"authenticated","sub":"auth_subject_alice"}' \
  | tee fixture-alice-token.json | jq .

export ALICE_AUTH="$(jq -r '.authorization' fixture-alice-token.json)"

curl -fsS \
  "http://$RUN402_CORE_PUBLIC_HOST:4300/todos?select=id,owner_id,title&id=eq.1" \
  -H "accept-profile: $FIXTURE_SCHEMA_SLOT" \
  -H "authorization: $ALICE_AUTH" \
  | tee fixture-alice-todos.json | jq .
```

The todo query should return Alice's imported row and hide it from anonymous/Bob requests. The full local smoke script also verifies service-role access, sequence restore, triggers, indexes, and rollback cases.

This fixture imports a tiny todo-style project and exercises:

- static HTML
- public storage object
- routed function
- Astro SSR route
- Postgres schema/data
- RLS behavior
- sequence restore
- trigger restore
- unsupported/unsafe archive rollback

## Planned Cloud-To-Core Flow

This is the target user experience for porting a live project from Run402 Cloud to the EC2 Core stack. It depends on the Cloud archive export/download CLI/API landing first.

From your development machine, export a Cloud project:

```bash
run402 archives export prj_... \
  --scope portable-runtime-v1 \
  --auth stubs \
  --wait \
  --output ./project.r402ar \
  --json
```

Inspect and verify it locally:

```bash
run402 archives inspect ./project.r402ar --json
run402 archives verify ./project.r402ar --json
```

Create an env file for required secrets. The archive never contains secret values.

```bash
cat > required.env <<'EOF'
OPENAI_API_KEY=replace-me-if-your-archive-requires-it
EOF
```

Copy the archive to EC2:

```bash
scp -i "$RUN402_CORE_NAME.pem" ./project.r402ar ./required.env "ubuntu@$RUN402_CORE_PUBLIC_HOST:/home/ubuntu/"
```

On the EC2 host:

```bash
mkdir -p /home/ubuntu/run402-core/imports
cp /home/ubuntu/project.r402ar /home/ubuntu/run402-core/imports/project.r402ar
```

Core archive import is path-based in the current Developer Preview: the Core Gateway reads an archive path from the Core container filesystem. The AWS compose override mounts `./imports` from the EC2 checkout into the Core container at `/imports`.

Create an import request. Fill `secret_values` with every secret listed by `run402 archives inspect`; use `{}` if the archive has no required secrets.

```bash
cat > import-request.json <<'EOF'
{
  "archive_path": "/imports/project.r402ar",
  "name": "imported-cloud-project",
  "require_runnable": true,
  "secret_values": {
    "OPENAI_API_KEY": "replace-me-if-required"
  }
}
EOF

curl -sS \
  -X POST "http://$RUN402_CORE_PUBLIC_HOST:4020/archives/v1/import" \
  -H 'content-type: application/json' \
  --data-binary @import-request.json | tee import-result.json | jq .
```

The result includes the imported Core project id and endpoints:

```bash
export PROJECT_ID="$(jq -r '.project_id' import-result.json)"
echo "$PROJECT_ID"
```

Then verify the imported app through the same Core URLs shown in the fixture drill.

## Cleanup

When the preview is done:

```bash
aws ec2 terminate-instances --instance-ids "$RUN402_CORE_INSTANCE_ID"
aws ec2 wait instance-terminated --instance-ids "$RUN402_CORE_INSTANCE_ID"
aws ec2 delete-security-group --group-id "$RUN402_CORE_SG"
aws ec2 delete-key-pair --key-name "$RUN402_CORE_NAME"
rm -f "$RUN402_CORE_NAME.pem"
```

## Friction To Remove Later

The current path is intentionally explicit. Good follow-up features would make it smoother:

- ship the Cloud archive export/download CLI/API and Cloud-to-Core conformance
- publish signed Core Gateway container images so EC2 does not need to build from source
- add an upload-stream archive import endpoint, so the archive does not need to live on the Core host filesystem
- provide Terraform/CDK for EC2/ECS/RDS/S3 targets
- add TLS/custom-domain automation
- add managed backup/monitoring recipes for self-hosted Core
