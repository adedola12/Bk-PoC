#!/usr/bin/env bash
# Verify the LIVE deployment, end to end, without changing anything.
#
#   ./deploy/06-verify-live.sh
#
# go-live.sh verifies as its last step, but only as part of a full deploy that
# needs SSH and rebuilds the image. This is the standalone read-only version:
# safe to run before a demo, from any machine with network access, as often as
# you like. It creates nothing and calls no AWS API.
#
# It covers two things the go-live checks cannot:
#
#   CORS         curl sends no Origin header, so every existing check passes
#                even when CORS_ORIGINS is wrong — and then every page in the
#                browser fails. This sends a real preflight from the CloudFront
#                origin, and confirms an unknown origin is still refused.
#   bundle drift VITE_API_BASE is inlined at BUILD time. Change API_DOMAIN and
#                redeploy without rebuilding the client and every check here
#                goes green while the app calls a host that no longer exists.
#                This reads the API base back out of the published bundle.
set -uo pipefail        # deliberately not -e: report every failure, not the first

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONF="$ROOT/deploy/.env.deploy"
[ -f "$CONF" ] || { echo "ERROR: $CONF not found. Copy deploy/env.deploy.example first."; exit 1; }
# shellcheck disable=SC1090
set -a; source "$CONF"; set +a

: "${API_DOMAIN:?not set in .env.deploy}"
: "${CLOUDFRONT_DOMAIN:?not set in .env.deploy — run 03-provision-infra.sh}"

FAILED=0
pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; FAILED=1; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
step() { printf '\n\033[1;36m━━━ %s ━━━\033[0m\n' "$1"; }

API="https://${API_DOMAIN}"
FE="https://${CLOUDFRONT_DOMAIN}"

# ───────────────────────────── 1. DNS ─────────────────────────────
# Checked first and explicitly: NXDOMAIN here is the single failure that also
# blocks certificate issuance, so a bare "connection failed" further down would
# send you looking in the wrong place.
step "1/6  DNS"
RESOLVED="$(getent hosts "$API_DOMAIN" 2>/dev/null | awk '{print $1}' | head -1)"
if [ -z "$RESOLVED" ]; then
  fail "$API_DOMAIN does not resolve (NXDOMAIN)"
  cat <<EOF

      Create this record at whatever DNS host serves ${API_DOMAIN#*.}:

          type  A
          name  ${API_DOMAIN%%.*}
          value ${ELASTIC_IP:-<the Elastic IP>}
          TTL   60

      Until it exists Let's Encrypt cannot validate the domain, so the API
      has no trusted certificate and the HTTPS frontend cannot call it.
      Caddy retries automatically for 30 days — no redeploy needed once the
      record is live.
EOF
elif [ -n "${ELASTIC_IP:-}" ] && [ "$RESOLVED" != "$ELASTIC_IP" ]; then
  fail "$API_DOMAIN -> $RESOLVED, expected $ELASTIC_IP"
else
  pass "$API_DOMAIN -> $RESOLVED"
fi

# ───────────────────────────── 2. TLS ─────────────────────────────
# No -k anywhere in this script: the whole point is that the certificate is
# trusted by a default trust store, because the browser will insist on it.
step "2/6  TLS certificate"
if curl -fsS --max-time 20 "$API/healthz" >/dev/null 2>&1; then
  pass "certificate is valid and trusted"
  if command -v openssl >/dev/null 2>&1; then
    CERT="$(echo | openssl s_client -servername "$API_DOMAIN" -connect "${API_DOMAIN}:443" 2>/dev/null \
            | openssl x509 -noout -issuer -enddate 2>/dev/null)"
    [ -n "$CERT" ] && echo "$CERT" | sed 's/^/      /'
  fi
else
  fail "no trusted TLS connection to $API"
  warn "if DNS was only just fixed, Caddy retries ACME every ~2 min — wait and re-run"
fi

# ──────────────────────────── 3. API ─────────────────────────────
step "3/6  API"
HEALTH="$(curl -fsS --max-time 20 "$API/healthz" 2>/dev/null)"
if [ -z "$HEALTH" ]; then
  fail "GET /healthz unreachable"
else
  echo "$HEALTH" | grep -q '"ok":true' && pass "GET /healthz ok"   || fail "GET /healthz did not report ok:true — $HEALTH"
  echo "$HEALTH" | grep -q '"db":true' && pass "MongoDB connected" || fail "MongoDB NOT connected — $HEALTH"
fi

for p in /api/triage /api/pipeline/iprs /api/reports/latest /api/review /api/todos; do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "${API}${p}")"
  [ "$code" = "200" ] && pass "GET $p -> 200" || fail "GET $p -> $code"
done

# ──────────────────────────── 4. CORS ────────────────────────────
# The gap this script exists to close. server/index.js:38-42 allows an origin
# only if it is in CORS_ORIGINS (normalised) or matches the Vercel preview
# pattern; anything else is refused with 403 by the error tail at :72-75.
step "4/6  CORS (browser path)"
# Both assertions below read a header that is ABSENT on refusal, so an
# unreachable API would satisfy the negative check by accident. Confirm the
# server answered at all before drawing any conclusion from a missing header.
preflight() {  # $1 = Origin; echoes "<http_code> <allow-origin>"
  curl -s -o /dev/null -D - --max-time 20 \
    -X OPTIONS "$API/api/triage" \
    -H "Origin: $1" \
    -H "Access-Control-Request-Method: GET" \
    -w 'x-http-code: %{http_code}\n' 2>/dev/null \
  | tr -d '\r' \
  | awk -F': ' '
      tolower($1)=="access-control-allow-origin" { acao=$2 }
      tolower($1)=="x-http-code"                 { code=$2 }
      END { print code " " acao }'
}

read -r GOOD_CODE GOOD_ACAO <<<"$(preflight "$FE")"
if [ "${GOOD_CODE:-000}" = "000" ]; then
  warn "CORS not checked — the API did not respond (fix DNS/TLS above first)"
  FAILED=1
else
  if [ "$(printf '%s' "$GOOD_ACAO" | tr 'A-Z' 'a-z')" = "$(printf '%s' "$FE" | tr 'A-Z' 'a-z')" ]; then
    pass "preflight from $FE allowed"
  else
    fail "preflight from $FE returned allow-origin '${GOOD_ACAO:-<none>}'"
    warn "set CORS_ORIGINS on the instance to include $FE, then: cd /opt/bk && docker compose up -d"
  fi

  # The allowlist must be a list, not a wildcard. A config that echoes back any
  # origin passes the check above while silently exposing the API to every site.
  read -r EVIL_CODE EVIL_ACAO <<<"$(preflight "https://not-allowed.example")"
  if [ "${EVIL_CODE:-000}" = "000" ]; then
    warn "wildcard check inconclusive — no response for the rejected-origin probe"
  elif [ -z "$EVIL_ACAO" ]; then
    pass "unknown origin refused (HTTP $EVIL_CODE)"
  else
    fail "unknown origin was allowed ('$EVIL_ACAO') — allowlist is behaving as a wildcard"
  fi
fi

# ────────────────────────── 5. Frontend ──────────────────────────
step "5/6  Frontend"
for p in / /products /review; do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "${FE}${p}")"
  [ "$code" = "200" ] && pass "GET $p -> 200" || fail "GET $p -> $code"
done
# S3 has no rewrite engine; a nested route only returns 200 because CloudFront
# maps 403/404 to /index.html. A route that cannot exist proves the mapping is
# what is answering, rather than a real object happening to sit at that key.
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$FE/route-that-does-not-exist")"
[ "$code" = "200" ] && pass "SPA fallback serves unknown routes (hard refresh survives)" \
                    || fail "SPA fallback broken: unknown route -> $code"

# ─────────────────────── 6. Bundle freshness ─────────────────────
step "6/6  Published bundle"
ENTRY="$(curl -fsS --max-time 20 "$FE/index.html" 2>/dev/null \
         | grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' | head -1)"
if [ -z "$ENTRY" ]; then
  fail "could not find the entry bundle in index.html"
else
  BAKED="$(curl -fsS --max-time 60 "${FE}${ENTRY}" 2>/dev/null | grep -oE 'https://[a-zA-Z0-9.-]+\.[a-z]{2,}' | grep -F "$API_DOMAIN" | head -1)"
  if [ -n "$BAKED" ]; then
    pass "bundle $ENTRY calls $API_DOMAIN"
  else
    fail "bundle $ENTRY does NOT reference $API_DOMAIN"
    warn "VITE_API_BASE is inlined at build time — run ./deploy/02-deploy-frontend.sh to rebuild"
  fi
fi

# ───────────────────────────── verdict ───────────────────────────
echo
if [ "$FAILED" -eq 0 ]; then
  printf '\033[32mLIVE\033[0m — API %s · Frontend %s\n' "$API" "$FE"
else
  printf '\033[31mNOT FULLY LIVE\033[0m — see the ✗ lines above.\n'
  echo "Logs: aws ssm start-session --target ${EC2_INSTANCE_ID:-<instance-id>} then: cd /opt/bk && docker compose logs --tail=50"
fi
exit "$FAILED"
