#!/usr/bin/env bash
# Build the API image and push it to ECR.
#
# Run this from the repo root on a machine with Docker and real AWS credentials:
#   ./deploy/01-build-and-push.sh
#
# Reads configuration from deploy/.env.deploy (gitignored). Copy
# deploy/env.deploy.example to deploy/.env.deploy and fill it in first.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONF="$ROOT/deploy/.env.deploy"

[ -f "$CONF" ] || { echo "ERROR: $CONF not found. Copy deploy/env.deploy.example and fill it in."; exit 1; }
# shellcheck disable=SC1090
set -a; source "$CONF"; set +a

: "${AWS_REGION:?set AWS_REGION in deploy/.env.deploy}"
: "${ECR_REPO:?set ECR_REPO in deploy/.env.deploy}"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
REGISTRY="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
TAG="$(git -C "$ROOT" rev-parse --short HEAD)"

echo "==> account   : $ACCOUNT_ID"
echo "==> registry  : $REGISTRY"
echo "==> repo:tag  : $ECR_REPO:$TAG"

# Create the repository once; ignore the error if it already exists.
aws ecr describe-repositories --repository-names "$ECR_REPO" --region "$AWS_REGION" >/dev/null 2>&1 \
  || aws ecr create-repository --repository-name "$ECR_REPO" --region "$AWS_REGION" \
       --image-scanning-configuration scanOnPush=true >/dev/null

aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "$REGISTRY"

# --platform is not optional: EC2 x86 instances cannot run an arm64 image built
# on an Apple Silicon Mac, and the failure mode is an opaque "exec format error".
docker build --platform linux/amd64 \
  -t "$REGISTRY/$ECR_REPO:$TAG" \
  -t "$REGISTRY/$ECR_REPO:latest" \
  "$ROOT/server"

docker push "$REGISTRY/$ECR_REPO:$TAG"
docker push "$REGISTRY/$ECR_REPO:latest"

echo
echo "==> pushed $REGISTRY/$ECR_REPO:$TAG"
echo "==> on the EC2 box, deploy it with:  cd /opt/bk && ./update.sh"
