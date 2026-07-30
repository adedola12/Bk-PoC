#!/usr/bin/env bash
# Provision the AWS infrastructure: ECR, EC2 (+ security group, Elastic IP,
# instance role), S3 and CloudFront.
#
#   ./deploy/03-provision-infra.sh
#
# Idempotent: every resource is looked up first and only created if absent, so
# re-running after a partial failure resumes rather than duplicating. Resource
# IDs are appended to deploy/.env.deploy as they are created.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONF="$ROOT/deploy/.env.deploy"
[ -f "$CONF" ] || { echo "ERROR: deploy/.env.deploy not found."; exit 1; }
# shellcheck disable=SC1090
set -a; source "$CONF"; set +a

: "${AWS_REGION:?}"; : "${ECR_REPO:?}"; : "${FRONTEND_BUCKET:?}"; : "${API_DOMAIN:?}"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
say()  { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
# Append a key to .env.deploy, replacing any existing line for that key.
setconf() {
  local k="$1" v="$2"
  if grep -q "^${k}=" "$CONF"; then
    sed -i.bak "s|^${k}=.*|${k}=${v}|" "$CONF" && rm -f "$CONF.bak"
  else
    printf '%s=%s\n' "$k" "$v" >> "$CONF"
  fi
  echo "    $k=$v"
}

# ─────────────────────────── ECR ───────────────────────────
say "ECR repository"
aws ecr describe-repositories --repository-names "$ECR_REPO" --region "$AWS_REGION" >/dev/null 2>&1 \
  || aws ecr create-repository --repository-name "$ECR_REPO" --region "$AWS_REGION" \
       --image-scanning-configuration scanOnPush=true >/dev/null
REGISTRY="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
setconf ECR_IMAGE "${REGISTRY}/${ECR_REPO}:latest"

# Keep only the 5 most recent images so ECR storage cannot creep.
aws ecr put-lifecycle-policy --repository-name "$ECR_REPO" --region "$AWS_REGION" \
  --lifecycle-policy-text '{"rules":[{"rulePriority":1,"description":"keep last 5","selection":{"tagStatus":"any","countType":"imageCountMoreThan","countNumber":5},"action":{"type":"expire"}}]}' \
  >/dev/null 2>&1 || true

# ───────────────────── IAM instance role ─────────────────────
# Two managed policies:
#   ECR read-only          — pull the API image
#   SSMManagedInstanceCore — administer the box over the AWS API instead of SSH.
# The latter is what lets a deploy run from an environment with no outbound
# port 22 (see 05-deploy-via-ssm.sh); it also means the security group never
# needs an SSH rule.
say "EC2 instance role (ECR pull + SSM management)"
ROLE=bk-ingest-ec2-role
if ! aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE" --assume-role-policy-document \
    '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
  aws iam create-instance-profile --instance-profile-name "$ROLE" >/dev/null
  aws iam add-role-to-instance-profile --instance-profile-name "$ROLE" --role-name "$ROLE" >/dev/null
  echo "    created $ROLE (waiting 10s for IAM propagation)"; sleep 10
else
  echo "    $ROLE already exists"
fi
# Attaching is idempotent, so this also repairs a role created before SSM was
# required, rather than only applying to brand-new roles.
for POL in AmazonEC2ContainerRegistryReadOnly AmazonSSMManagedInstanceCore; do
  aws iam attach-role-policy --role-name "$ROLE" \
    --policy-arn "arn:aws:iam::aws:policy/${POL}" >/dev/null
  echo "    policy attached: $POL"
done

# Push rights on this ONE repository, so the image can be built on the instance
# when the operator's machine cannot (no Docker, or a network that blocks the
# registry CDNs). Scoped to the single repo ARN rather than using the blanket
# PowerUser policy: a compromised instance still cannot touch other registries.
aws iam put-role-policy --role-name "$ROLE" --policy-name bk-ingest-ecr-push \
  --policy-document "$(cat <<JSON
{"Version":"2012-10-17","Statement":[
  {"Effect":"Allow","Action":"ecr:GetAuthorizationToken","Resource":"*"},
  {"Effect":"Allow","Resource":"arn:aws:ecr:${AWS_REGION}:${ACCOUNT_ID}:repository/${ECR_REPO}",
   "Action":["ecr:BatchCheckLayerAvailability","ecr:CompleteLayerUpload",
             "ecr:InitiateLayerUpload","ecr:PutImage","ecr:UploadLayerPart"]}
]}
JSON
)" >/dev/null
echo "    inline policy: bk-ingest-ecr-push (scoped to $ECR_REPO)"

# ─────────────────────── security group ───────────────────────
say "Security group"
VPC_ID="$(aws ec2 describe-vpcs --region "$AWS_REGION" --filters Name=isDefault,Values=true \
          --query 'Vpcs[0].VpcId' --output text)"
SG_NAME=bk-ingest-sg
SG_ID="$(aws ec2 describe-security-groups --region "$AWS_REGION" \
         --filters Name=group-name,Values=$SG_NAME Name=vpc-id,Values=$VPC_ID \
         --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || echo None)"
if [ "$SG_ID" = "None" ] || [ -z "$SG_ID" ]; then
  SG_ID="$(aws ec2 create-security-group --region "$AWS_REGION" --group-name "$SG_NAME" \
           --description "BK-Ingest API" --vpc-id "$VPC_ID" --query GroupId --output text)"
  # 80 is required for the ACME HTTP-01 challenge, not just redirects.
  aws ec2 authorize-security-group-ingress --region "$AWS_REGION" --group-id "$SG_ID" \
    --ip-permissions \
      'IpProtocol=tcp,FromPort=80,ToPort=80,IpRanges=[{CidrIp=0.0.0.0/0,Description="ACME + redirect"}]' \
      'IpProtocol=tcp,FromPort=443,ToPort=443,IpRanges=[{CidrIp=0.0.0.0/0,Description="API"}]' >/dev/null
fi
# No SSH rule by default. Shell access comes from SSM Session Manager, which
# dials out from the instance over HTTPS, so port 22 stays shut to the internet:
#     aws ssm start-session --target "$EC2_INSTANCE_ID" --region "$AWS_REGION"
# Set ALLOW_SSH_FROM to a CIDR in .env.deploy if you want conventional SSH too.
# Deliberately not derived from an auto-detected egress IP: on a shared or
# proxied network that opens the box to every other tenant behind that address.
if [ -n "${ALLOW_SSH_FROM:-}" ]; then
  aws ec2 authorize-security-group-ingress --region "$AWS_REGION" --group-id "$SG_ID" \
    --ip-permissions "IpProtocol=tcp,FromPort=22,ToPort=22,IpRanges=[{CidrIp=${ALLOW_SSH_FROM},Description=\"admin ssh\"}]" \
    >/dev/null 2>&1 || true
  echo "    ssh allowed from ${ALLOW_SSH_FROM}"
else
  echo "    port 22 closed — use: aws ssm start-session --target <instance-id>"
fi
setconf SECURITY_GROUP_ID "$SG_ID"

# ────────────────────────── EC2 ──────────────────────────
say "EC2 instance"
INSTANCE_ID="$(aws ec2 describe-instances --region "$AWS_REGION" \
  --filters Name=tag:Name,Values=bk-ingest-api Name=instance-state-name,Values=running,pending \
  --query 'Reservations[0].Instances[0].InstanceId' --output text 2>/dev/null || echo None)"

if [ "$INSTANCE_ID" = "None" ] || [ -z "$INSTANCE_ID" ]; then
  : "${SSH_KEY_NAME:?set SSH_KEY_NAME in deploy/.env.deploy to an existing EC2 key pair}"
  AMI="$(aws ssm get-parameters --region "$AWS_REGION" \
    --names /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 \
    --query 'Parameters[0].Value' --output text)"
  # t3.small (2GB): t3.micro's 1GB OOMs when pdfjs rasterizes the 104-page handbook.
  INSTANCE_ID="$(aws ec2 run-instances --region "$AWS_REGION" \
    --image-id "$AMI" --instance-type "${EC2_INSTANCE_TYPE:-t3.small}" \
    --key-name "$SSH_KEY_NAME" --security-group-ids "$SG_ID" \
    --iam-instance-profile Name=bk-ingest-ec2-role \
    --block-device-mappings 'DeviceName=/dev/xvda,Ebs={VolumeSize=20,VolumeType=gp3,DeleteOnTermination=true}' \
    --user-data "file://$ROOT/deploy/ec2-user-data.sh" \
    --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=bk-ingest-api},{Key=Project,Value=BK-Ingest}]' \
    --metadata-options 'HttpTokens=required' \
    --query 'Instances[0].InstanceId' --output text)"
  echo "    launched $INSTANCE_ID (AMI $AMI) — waiting for running state"
  aws ec2 wait instance-running --region "$AWS_REGION" --instance-ids "$INSTANCE_ID"
else
  echo "    reusing $INSTANCE_ID"
fi
setconf EC2_INSTANCE_ID "$INSTANCE_ID"

say "Elastic IP"
EIP="$(aws ec2 describe-addresses --region "$AWS_REGION" \
  --filters Name=tag:Name,Values=bk-ingest-api --query 'Addresses[0].PublicIp' --output text 2>/dev/null || echo None)"
if [ "$EIP" = "None" ] || [ -z "$EIP" ]; then
  ALLOC="$(aws ec2 allocate-address --region "$AWS_REGION" --domain vpc \
    --tag-specifications 'ResourceType=elastic-ip,Tags=[{Key=Name,Value=bk-ingest-api}]' \
    --query AllocationId --output text)"
  EIP="$(aws ec2 describe-addresses --region "$AWS_REGION" --allocation-ids "$ALLOC" --query 'Addresses[0].PublicIp' --output text)"
else
  ALLOC="$(aws ec2 describe-addresses --region "$AWS_REGION" --public-ips "$EIP" --query 'Addresses[0].AllocationId' --output text)"
fi
aws ec2 associate-address --region "$AWS_REGION" --instance-id "$INSTANCE_ID" --allocation-id "$ALLOC" >/dev/null
setconf ELASTIC_IP "$EIP"

# ───────────────── DNS (Route 53, if the zone lives there) ─────────────────
# If API_DOMAIN's parent zone is hosted in this account's Route 53, create the
# A record automatically. Otherwise print what to add at whichever DNS provider
# holds the zone. TTL 60 keeps rollback fast.
say "DNS A record for $API_DOMAIN"
DNS_DONE=no
ZONE_ID=""
# Walk up the labels: api-bk.adlm.com -> adlm.com -> com, first match wins.
probe="$API_DOMAIN"
while [ "$(echo "$probe" | tr -cd '.' | wc -c)" -ge 1 ]; do
  ZONE_ID="$(aws route53 list-hosted-zones-by-name --dns-name "$probe" \
    --query "HostedZones[?Name=='${probe}.'].Id | [0]" --output text 2>/dev/null || echo None)"
  [ "$ZONE_ID" != "None" ] && [ -n "$ZONE_ID" ] && break
  probe="${probe#*.}"
  ZONE_ID=""
done

if [ -n "$ZONE_ID" ] && [ "$ZONE_ID" != "None" ]; then
  ZONE_ID="${ZONE_ID##*/}"
  CHANGE_ID="$(aws route53 change-resource-record-sets --hosted-zone-id "$ZONE_ID" \
    --change-batch "$(cat <<JSON
{"Comment":"BK-Ingest PoC API","Changes":[{"Action":"UPSERT","ResourceRecordSet":{
  "Name":"${API_DOMAIN}","Type":"A","TTL":60,"ResourceRecords":[{"Value":"${EIP}"}]}}]}
JSON
)" --query 'ChangeInfo.Id' --output text)"
  echo "    Route 53 zone $ZONE_ID — A record UPSERTed to $EIP (TTL 60)"
  echo "    waiting for the change to propagate…"
  aws route53 wait resource-record-sets-changed --id "$CHANGE_ID" 2>/dev/null || true
  DNS_DONE=yes
else
  echo "    $API_DOMAIN is not in this account's Route 53 — create the record manually:"
  echo "        type A   name ${API_DOMAIN}   value ${EIP}   TTL 60"
fi
setconf DNS_AUTOMANAGED "$DNS_DONE"

# ────────────────────────── S3 ──────────────────────────
say "S3 bucket (private; CloudFront reaches it via OAC)"
if ! aws s3api head-bucket --bucket "$FRONTEND_BUCKET" 2>/dev/null; then
  if [ "$AWS_REGION" = "us-east-1" ]; then
    aws s3api create-bucket --bucket "$FRONTEND_BUCKET" --region us-east-1 >/dev/null
  else
    aws s3api create-bucket --bucket "$FRONTEND_BUCKET" --region "$AWS_REGION" \
      --create-bucket-configuration "LocationConstraint=$AWS_REGION" >/dev/null
  fi
fi
aws s3api put-public-access-block --bucket "$FRONTEND_BUCKET" \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true >/dev/null
echo "    $FRONTEND_BUCKET private, public access blocked"

# ─────────────────────── CloudFront ───────────────────────
say "CloudFront distribution"
DIST_ID="${CLOUDFRONT_DISTRIBUTION_ID:-}"
if [ -z "$DIST_ID" ]; then
  OAC_NAME="bk-ingest-oac"
  OAC_ID="$(aws cloudfront list-origin-access-controls \
    --query "OriginAccessControlList.Items[?Name=='$OAC_NAME'].Id | [0]" --output text 2>/dev/null || echo None)"
  if [ "$OAC_ID" = "None" ] || [ -z "$OAC_ID" ]; then
    OAC_ID="$(aws cloudfront create-origin-access-control --origin-access-control-config \
      "{\"Name\":\"$OAC_NAME\",\"Description\":\"BK-Ingest frontend\",\"SigningProtocol\":\"sigv4\",\"SigningBehavior\":\"always\",\"OriginAccessControlOriginType\":\"s3\"}" \
      --query 'OriginAccessControl.Id' --output text)"
  fi

  # CustomErrorResponses are the SPA fallback: S3 has no rewrite engine, so a
  # refresh on /products 403s. Mapping 403/404 -> /index.html with status 200
  # is what makes client-side routing survive a hard refresh.
  cat > /tmp/bk-cf.json <<JSON
{
  "CallerReference": "bk-ingest-$(date +%s)",
  "Comment": "BK-Ingest frontend",
  "Enabled": true,
  "DefaultRootObject": "index.html",
  "Origins": {"Quantity": 1, "Items": [{
    "Id": "s3-${FRONTEND_BUCKET}",
    "DomainName": "${FRONTEND_BUCKET}.s3.${AWS_REGION}.amazonaws.com",
    "OriginAccessControlId": "${OAC_ID}",
    "S3OriginConfig": {"OriginAccessIdentity": ""}
  }]},
  "DefaultCacheBehavior": {
    "TargetOriginId": "s3-${FRONTEND_BUCKET}",
    "ViewerProtocolPolicy": "redirect-to-https",
    "Compress": true,
    "AllowedMethods": {"Quantity": 2, "Items": ["GET","HEAD"],
      "CachedMethods": {"Quantity": 2, "Items": ["GET","HEAD"]}},
    "CachePolicyId": "658327ea-f89d-4fab-a63d-7e88639e58f6"
  },
  "CustomErrorResponses": {"Quantity": 2, "Items": [
    {"ErrorCode": 403, "ResponsePagePath": "/index.html", "ResponseCode": "200", "ErrorCachingMinTTL": 0},
    {"ErrorCode": 404, "ResponsePagePath": "/index.html", "ResponseCode": "200", "ErrorCachingMinTTL": 0}
  ]},
  "PriceClass": "PriceClass_All"
}
JSON
  DIST_ID="$(aws cloudfront create-distribution --distribution-config file:///tmp/bk-cf.json \
    --query 'Distribution.Id' --output text)"
  rm -f /tmp/bk-cf.json
fi
DIST_DOMAIN="$(aws cloudfront get-distribution --id "$DIST_ID" --query 'Distribution.DomainName' --output text)"
setconf CLOUDFRONT_DISTRIBUTION_ID "$DIST_ID"
setconf CLOUDFRONT_DOMAIN "$DIST_DOMAIN"

# Bucket policy: only this distribution may read the bucket.
aws s3api put-bucket-policy --bucket "$FRONTEND_BUCKET" --policy "$(cat <<JSON
{"Version":"2012-10-17","Statement":[{
  "Sid":"AllowCloudFrontServicePrincipal","Effect":"Allow",
  "Principal":{"Service":"cloudfront.amazonaws.com"},
  "Action":"s3:GetObject","Resource":"arn:aws:s3:::${FRONTEND_BUCKET}/*",
  "Condition":{"StringEquals":{"AWS:SourceArn":"arn:aws:cloudfront::${ACCOUNT_ID}:distribution/${DIST_ID}"}}
}]}
JSON
)" >/dev/null

cat <<EOF

────────────────────────────────────────────────────────────
INFRASTRUCTURE READY

  API instance     $INSTANCE_ID
  Elastic IP       $EIP
  Frontend         https://$DIST_DOMAIN

NEXT — you must do this by hand, it is the one step AWS cannot infer:

  Create a DNS A record:   $API_DOMAIN  ->  $EIP

  Caddy cannot obtain a Let's Encrypt certificate until that record
  resolves. Then run:  ./deploy/go-live.sh

CloudFront takes ~5-15 minutes to finish deploying worldwide.
────────────────────────────────────────────────────────────
EOF
