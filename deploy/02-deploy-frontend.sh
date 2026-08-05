#!/usr/bin/env bash
# Build the React client and publish it to S3 behind CloudFront.
#
#   ./deploy/02-deploy-frontend.sh
#
# Prerequisites: deploy/.env.deploy filled in, and the bucket + distribution
# created (see deploy/README.md "First-time frontend setup").
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONF="$ROOT/deploy/.env.deploy"
[ -f "$CONF" ] || { echo "ERROR: $CONF not found."; exit 1; }
# shellcheck disable=SC1090
set -a; source "$CONF"; set +a

: "${AWS_REGION:?}"; : "${FRONTEND_BUCKET:?}"; : "${API_DOMAIN:?}"

# VITE_* vars are inlined at BUILD time, not read at runtime. Changing the API
# URL therefore requires a rebuild, not just a redeploy.
export VITE_API_BASE="https://${API_DOMAIN}"
echo "==> building client with VITE_API_BASE=$VITE_API_BASE"

cd "$ROOT/client"
npm ci
npm run build     # vite build -> client/dist

echo "==> syncing to s3://$FRONTEND_BUCKET"
# Hashed assets are immutable and can cache forever.
aws s3 sync dist/ "s3://$FRONTEND_BUCKET/" \
  --region "$AWS_REGION" --delete \
  --exclude "index.html" \
  --cache-control "public,max-age=31536000,immutable"

# index.html must NEVER be cached, or users keep loading an old bundle that
# references deleted asset hashes after a deploy.
aws s3 cp dist/index.html "s3://$FRONTEND_BUCKET/index.html" \
  --region "$AWS_REGION" \
  --cache-control "no-cache,no-store,must-revalidate" \
  --content-type "text/html"

if [ -n "${CLOUDFRONT_DISTRIBUTION_ID:-}" ]; then
  echo "==> invalidating CloudFront"
  aws cloudfront create-invalidation \
    --distribution-id "$CLOUDFRONT_DISTRIBUTION_ID" \
    --paths "/*" --query 'Invalidation.Id' --output text
else
  echo "!! CLOUDFRONT_DISTRIBUTION_ID unset — skipped invalidation; users may see a stale bundle"
fi

echo "==> frontend deployed"
