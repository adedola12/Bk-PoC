#!/usr/bin/env bash
# Put the frontend on a custom domain: ACM certificate + CloudFront alias.
#
#   ./deploy/07-frontend-custom-domain.sh
#
# Reads FRONTEND_DOMAIN from deploy/.env.deploy. Idempotent — safe to re-run at
# any point; every step checks for the resource before creating it.
#
# Numbered 07 because 06 is 06-verify-live.sh. Run this before that one: the
# verify script checks the frontend, and this changes where the frontend lives.
#
# Two DNS records are needed:
#
#   1. the ACM validation CNAME
#   2. an alias for <FRONTEND_DOMAIN> pointing at the CloudFront distribution
#
# Both are created automatically when the parent zone is in this account's
# Route 53 (set ROUTE53_ZONE_ID, or let the script find it). When it is not,
# the records are printed for manual creation and the script stops cleanly.
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
# The fixed, global hosted-zone ID for every CloudFront distribution. It is a
# constant published by AWS, not something to look up per distribution.
CF_HOSTED_ZONE_ID=Z2FDTNDATAQYW2

setconf() {
  local k="$1" v="$2"
  if grep -q "^${k}=" "$CONF"; then
    sed -i.bak "s|^${k}=.*|${k}=${v}|" "$CONF" && rm -f "$CONF.bak"
  else
    printf '%s=%s\n' "$k" "$v" >> "$CONF"
  fi
}
say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

# ────────────────────────── Route 53 zone ──────────────────────────
# Resolved once, up front: whether the zone is reachable decides between the
# automated path and the print-and-stop path, and that changes what the rest
# of this script can promise.
ZONE_ID="${ROUTE53_ZONE_ID:-}"
if [ -z "$ZONE_ID" ]; then
  probe="${FRONTEND_DOMAIN#*.}"
  while [ -n "$probe" ] && [ "$probe" != "${probe#*.}" ]; do
    ZONE_ID="$(aws route53 list-hosted-zones-by-name --dns-name "$probe" \
      --query "HostedZones[?Name=='${probe}.'].Id | [0]" --output text 2>/dev/null || echo None)"
    [ "$ZONE_ID" != "None" ] && [ -n "$ZONE_ID" ] && break
    probe="${probe#*.}"
    ZONE_ID=""
  done
fi
ZONE_ID="${ZONE_ID##*/}"
[ "$ZONE_ID" = "None" ] && ZONE_ID=""
if [ -n "$ZONE_ID" ]; then
  echo "Route 53 zone $ZONE_ID — DNS records will be created automatically."
else
  echo "No Route 53 zone for ${FRONTEND_DOMAIN} in this account — records will be printed."
fi

# UPSERT a record into the zone. UPSERT rather than CREATE so a re-run after a
# partial failure corrects the record instead of erroring on a duplicate.
upsert_record() {
  local batch="$1" cid
  cid="$(aws route53 change-resource-record-sets --hosted-zone-id "$ZONE_ID" \
    --change-batch "$batch" --query 'ChangeInfo.Id' --output text)"
  aws route53 wait resource-record-sets-changed --id "$cid" 2>/dev/null || true
}

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

  if [ -z "$ZONE_ID" ]; then
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

  say "Validation CNAME $RR_NAME"
  upsert_record "$(cat <<JSON
{"Comment":"BK-Ingest frontend ACM validation","Changes":[{"Action":"UPSERT","ResourceRecordSet":{
  "Name":"${RR_NAME}","Type":"CNAME","TTL":60,"ResourceRecords":[{"Value":"${RR_VALUE}"}]}}]}
JSON
)"
  echo "    created — waiting for ACM to validate (up to 10 min)…"
  aws acm wait certificate-validated --region "$ACM_REGION" --certificate-arn "$ARN"
  STATUS="$(aws acm describe-certificate --region "$ACM_REGION" --certificate-arn "$ARN" \
    --query 'Certificate.Status' --output text)"
  echo "    status: $STATUS"
  [ "$STATUS" = "ISSUED" ] || { echo "ERROR: certificate did not reach ISSUED."; exit 1; }
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

# Prints CHANGED/UNCHANGED so a no-op re-run skips the 5-15 min redeploy wait.
CHANGED="$(python3 - "$TMP/cur.json" "$TMP/new.json" "$FRONTEND_DOMAIN" "$ARN" <<'PY'
import json, sys
cur, out, domain, arn = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
cfg = json.load(open(cur))["DistributionConfig"]

aliases = cfg.get("Aliases", {"Quantity": 0, "Items": []})
items = list(aliases.get("Items") or [])
before = (sorted(items), json.dumps(cfg.get("ViewerCertificate", {}), sort_keys=True))
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
after = (sorted(items), json.dumps(cfg["ViewerCertificate"], sort_keys=True))
json.dump(cfg, open(out, "w"))
print("UNCHANGED" if before == after else "CHANGED")
PY
)"

if [ "$CHANGED" = "CHANGED" ]; then
  aws cloudfront update-distribution --id "$CLOUDFRONT_DISTRIBUTION_ID" \
    --distribution-config "file://$TMP/new.json" --if-match "$ETAG" \
    --query 'Distribution.Status' --output text
else
  echo "    alias and certificate already attached — no update needed"
fi
setconf FRONTEND_URL "https://${FRONTEND_DOMAIN}"

CF_DOMAIN="$(aws cloudfront get-distribution --id "$CLOUDFRONT_DISTRIBUTION_ID" \
  --query 'Distribution.DomainName' --output text)"

# ────────────────────────── alias record ──────────────────────────
if [ -n "$ZONE_ID" ]; then
  # An alias A record, not a CNAME: alias queries are free, resolve a step
  # faster, and are the only form that would also work at a zone apex.
  say "Alias record $FRONTEND_DOMAIN -> $CF_DOMAIN"
  upsert_record "$(cat <<JSON
{"Comment":"BK-Ingest frontend","Changes":[{"Action":"UPSERT","ResourceRecordSet":{
  "Name":"${FRONTEND_DOMAIN}","Type":"A","AliasTarget":{
    "HostedZoneId":"${CF_HOSTED_ZONE_ID}","DNSName":"${CF_DOMAIN}",
    "EvaluateTargetHealth":false}}}]}
JSON
)"
  echo "    created"
fi

cat <<EOF

────────────────────────────────────────────────────────────
FRONTEND DOMAIN CONFIGURED

  https://${FRONTEND_DOMAIN}  ->  ${CF_DOMAIN}

EOF
if [ -z "$ZONE_ID" ]; then
  cat <<EOF
  Point the domain at the distribution:

      type   CNAME
      name   ${FRONTEND_DOMAIN}
      value  ${CF_DOMAIN}

EOF
fi
cat <<EOF
  CloudFront takes ~5-15 min to redeploy after an alias change. Until then
  https://${FRONTEND_DOMAIN} may not answer.

  CORS_ORIGINS on the API must include https://${FRONTEND_DOMAIN}, or the
  browser will block every call from the new origin. Check it with
  ./deploy/06-verify-live.sh (section 4).
────────────────────────────────────────────────────────────
EOF
