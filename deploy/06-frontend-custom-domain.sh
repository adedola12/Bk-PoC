#!/usr/bin/env bash
# Put the frontend on a custom domain: ACM certificate + CloudFront alias.
#
#   ./deploy/06-frontend-custom-domain.sh
#
# Reads FRONTEND_DOMAIN from deploy/.env.deploy. Idempotent — re-run it after
# the DNS records below exist and it picks up where it stopped.
#
# Two DNS records are needed, and neither can be created from here unless the
# zone happens to live in this account's Route 53:
#
#   1. the ACM validation CNAME  (printed by this script)
#   2. CNAME  <FRONTEND_DOMAIN>  ->  <CloudFront domain>
#
# The certificate MUST live in us-east-1. That is not a regional preference:
# CloudFront only reads certificates from us-east-1 no matter where the
# distribution or its origin bucket are.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONF="$ROOT/deploy/.env.deploy"
[ -f "$CONF" ] || { echo "ERROR: deploy/.env.deploy not found."; exit 1; }
# shellcheck disable=SC1090
set -a; source "$CONF"; set +a

: "${CLOUDFRONT_DISTRIBUTION_ID:?run 03-provision-infra.sh first}"
: "${FRONTEND_DOMAIN:?set FRONTEND_DOMAIN in deploy/.env.deploy}"
ACM_REGION=us-east-1

setconf() {
  local k="$1" v="$2"
  if grep -q "^${k}=" "$CONF"; then
    sed -i.bak "s|^${k}=.*|${k}=${v}|" "$CONF" && rm -f "$CONF.bak"
  else
    printf '%s=%s\n' "$k" "$v" >> "$CONF"
  fi
}
say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

# ────────────────────────── certificate ──────────────────────────
say "ACM certificate for $FRONTEND_DOMAIN (us-east-1)"
ARN="$(aws acm list-certificates --region "$ACM_REGION" \
  --query "CertificateSummaryList[?DomainName=='${FRONTEND_DOMAIN}'].CertificateArn | [0]" \
  --output text 2>/dev/null || echo None)"
if [ "$ARN" = "None" ] || [ -z "$ARN" ]; then
  ARN="$(aws acm request-certificate --region "$ACM_REGION" \
    --domain-name "$FRONTEND_DOMAIN" --validation-method DNS \
    --tags Key=Project,Value=BK-Ingest \
    --query CertificateArn --output text)"
  echo "    requested $ARN"
  sleep 8   # the validation record is not populated the instant the cert exists
else
  echo "    reusing $ARN"
fi
setconf ACM_CERT_ARN "$ARN"

STATUS="$(aws acm describe-certificate --region "$ACM_REGION" --certificate-arn "$ARN" \
  --query 'Certificate.Status' --output text)"
echo "    status: $STATUS"

if [ "$STATUS" != "ISSUED" ]; then
  read -r RR_NAME RR_VALUE <<<"$(aws acm describe-certificate --region "$ACM_REGION" \
    --certificate-arn "$ARN" \
    --query 'Certificate.DomainValidationOptions[0].ResourceRecord.[Name,Value]' --output text)"
  cat <<EOF

  Certificate is not issued yet. Create this CNAME at the DNS provider that
  hosts ${FRONTEND_DOMAIN#*.}:

      type   CNAME
      name   ${RR_NAME}
      value  ${RR_VALUE}

  ACM validates within a few minutes of that record resolving. Then re-run
  this script — it will attach the certificate and the alias.

EOF
  exit 0
fi

# ─────────────────────── attach alias + cert ───────────────────────
# Read-modify-write of the whole distribution config: the CloudFront API has no
# partial update, and the If-Match ETag makes a concurrent edit fail loudly
# rather than silently clobber.
say "Attaching alias to distribution $CLOUDFRONT_DISTRIBUTION_ID"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
aws cloudfront get-distribution-config --id "$CLOUDFRONT_DISTRIBUTION_ID" \
  --output json > "$TMP/cur.json"
ETAG="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["ETag"])' "$TMP/cur.json")"

python3 - "$TMP/cur.json" "$TMP/new.json" "$FRONTEND_DOMAIN" "$ARN" <<'PY'
import json, sys
cur, out, domain, arn = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
cfg = json.load(open(cur))["DistributionConfig"]

aliases = cfg.get("Aliases", {"Quantity": 0, "Items": []})
items = aliases.get("Items", [])
if domain not in items:
    items.append(domain)
cfg["Aliases"] = {"Quantity": len(items), "Items": items}

# Replacing the default *.cloudfront.net certificate. SNI-only is correct here:
# the alternative (dedicated IP) bills $600/month and buys nothing any browser
# from the last decade needs. TLSv1.2_2021 is the current AWS-recommended floor.
cfg["ViewerCertificate"] = {
    "ACMCertificateArn": arn,
    "SSLSupportMethod": "sni-only",
    "MinimumProtocolVersion": "TLSv1.2_2021",
    "Certificate": arn,
    "CertificateSource": "acm",
}
json.dump(cfg, open(out, "w"))
PY

aws cloudfront update-distribution --id "$CLOUDFRONT_DISTRIBUTION_ID" \
  --distribution-config "file://$TMP/new.json" --if-match "$ETAG" \
  --query 'Distribution.Status' --output text
setconf FRONTEND_URL "https://${FRONTEND_DOMAIN}"

CF_DOMAIN="$(aws cloudfront get-distribution --id "$CLOUDFRONT_DISTRIBUTION_ID" \
  --query 'Distribution.DomainName' --output text)"
cat <<EOF

────────────────────────────────────────────────────────────
ALIAS ATTACHED

  Point the domain at the distribution:

      type   CNAME
      name   ${FRONTEND_DOMAIN}
      value  ${CF_DOMAIN}

  CloudFront takes ~5-15 min to redeploy. Until the CNAME resolves,
  https://${FRONTEND_DOMAIN} will not answer.

  Then add https://${FRONTEND_DOMAIN} to CORS_ORIGINS on the API and
  restart it, or the browser will block every call from the new origin.
────────────────────────────────────────────────────────────
EOF
