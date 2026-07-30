#!/usr/bin/env bash
# Full deployment, end to end.
#
#   ./deploy/go-live.sh
#
# Runs: pre-flight -> provision -> build/push image -> start API on EC2 ->
# build/publish frontend -> verify. Safe to re-run; every stage is idempotent.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
step() { printf '\n\033[1;36m━━━ %s ━━━\033[0m\n' "$1"; }

step "1/6  pre-flight"
"$ROOT/deploy/00-preflight.sh"

step "2/6  provision infrastructure"
"$ROOT/deploy/03-provision-infra.sh"

# Re-source: provisioning writes ELASTIC_IP, ECR_IMAGE, distribution id back.
# shellcheck disable=SC1091
set -a; source "$ROOT/deploy/.env.deploy"; set +a
: "${ELASTIC_IP:?provisioning did not record an Elastic IP}"

# Refuse to continue if DNS does not yet point at the box — Caddy would burn a
# Let's Encrypt rate-limit attempt and leave the API on a broken certificate.
RESOLVED="$(getent hosts "$API_DOMAIN" 2>/dev/null | awk '{print $1}' | head -1 || true)"
if [ "$RESOLVED" != "$ELASTIC_IP" ]; then
  cat <<EOF

STOPPING: DNS is not ready.
  $API_DOMAIN resolves to '${RESOLVED:-nothing}'
  it must resolve to      '$ELASTIC_IP'

Create that A record, wait for it to propagate, then re-run this script.
EOF
  exit 1
fi
echo "  DNS OK: $API_DOMAIN -> $ELASTIC_IP"

step "3/6  build and push API image"
"$ROOT/deploy/01-build-and-push.sh"

step "4/6  deploy API to EC2"
SSH="ssh -o StrictHostKeyChecking=accept-new ec2-user@${ELASTIC_IP}"
# Wait for cloud-init: user-data installs docker and may still be running.
for i in $(seq 1 30); do
  $SSH 'test -x /opt/bk/update.sh' 2>/dev/null && break
  echo "  waiting for instance bootstrap… (${i}/30)"; sleep 10
done
scp -o StrictHostKeyChecking=accept-new \
  "$ROOT/deploy/docker-compose.yml" "$ROOT/deploy/Caddyfile" \
  "$ROOT/deploy/.env.deploy" "$ROOT/deploy/.env.migration" \
  "ec2-user@${ELASTIC_IP}:/opt/bk/"
$SSH 'cd /opt/bk && ./update.sh'

step "5/6  build and publish frontend"
"$ROOT/deploy/02-deploy-frontend.sh"

step "6/6  verify"
FAILED=0
echo "  waiting for TLS certificate issuance…"
for i in $(seq 1 30); do
  curl -fsS "https://${API_DOMAIN}/healthz" >/dev/null 2>&1 && break
  sleep 10
done
HEALTH="$(curl -fsS "https://${API_DOMAIN}/healthz" 2>&1 || echo FAILED)"
echo "  GET /healthz          -> $HEALTH"
echo "$HEALTH" | grep -q '"db":true' || { echo "  !! database not connected"; FAILED=1; }

for p in /api/triage /api/pipeline/iprs /api/reports/latest /api/review /api/todos; do
  code="$(curl -s -o /dev/null -w '%{http_code}' "https://${API_DOMAIN}${p}")"
  printf '  GET %-22s -> %s\n' "$p" "$code"
  [ "$code" = "200" ] || FAILED=1
done

FE="$(curl -s -o /dev/null -w '%{http_code}' "https://${CLOUDFRONT_DOMAIN}/")"
DEEP="$(curl -s -o /dev/null -w '%{http_code}' "https://${CLOUDFRONT_DOMAIN}/products")"
echo "  frontend /            -> $FE"
echo "  frontend /products    -> $DEEP   (200 proves SPA fallback works)"
[ "$FE" = "200" ] && [ "$DEEP" = "200" ] || FAILED=1

echo
if [ "$FAILED" -eq 0 ]; then
  cat <<EOF
\033[32mLIVE\033[0m
  API       https://${API_DOMAIN}
  Frontend  https://${CLOUDFRONT_DOMAIN}

Remaining, one-off:
  ./deploy/04-billing-alarm.sh you@example.com     # \$10 CloudWatch alarm
EOF
else
  echo "DEPLOY COMPLETED WITH FAILURES — see the non-200s above."
  echo "Logs: ssh ec2-user@${ELASTIC_IP} 'cd /opt/bk && docker compose logs --tail=50 api'"
  exit 1
fi
