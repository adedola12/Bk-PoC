#!/usr/bin/env bash
# Pre-flight: verify everything a deployment needs BEFORE touching AWS.
#
#   ./deploy/00-preflight.sh
#
# Every check is read-only. Nothing here creates, modifies or bills anything.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAIL=0
ok()   { printf '  \033[32mOK\033[0m    %s\n' "$1"; }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=1; }
warn() { printf '  \033[33mWARN\033[0m  %s\n' "$1"; }

echo "== local tooling =="
command -v docker >/dev/null && ok "docker present" || bad "docker not installed"
docker info >/dev/null 2>&1 && ok "docker daemon running" || bad "docker daemon not running"
command -v aws >/dev/null && ok "aws cli present ($(aws --version 2>&1 | cut -d' ' -f1))" || bad "aws cli not installed"
command -v npm >/dev/null && ok "npm present" || bad "npm not installed"

echo
echo "== deployment configuration =="
CONF="$ROOT/deploy/.env.deploy"
if [ -f "$CONF" ]; then
  ok "deploy/.env.deploy present"
  # shellcheck disable=SC1090
  set -a; source "$CONF"; set +a
  for v in AWS_REGION ECR_REPO API_DOMAIN FRONTEND_BUCKET; do
    [ -n "${!v:-}" ] && ok "$v = ${!v}" || bad "$v is empty in deploy/.env.deploy"
  done
else
  bad "deploy/.env.deploy missing — copy deploy/env.deploy.example and fill it in"
fi

echo
echo "== application secrets =="
MIG="$ROOT/deploy/.env.migration"
if [ -f "$MIG" ]; then
  ok "deploy/.env.migration present"
  for v in MONGODB_URI ANTHROPIC_API_KEY; do
    grep -qE "^${v}=.+" "$MIG" && ok "$v is set" || bad "$v missing or empty in .env.migration"
  done
  for v in CLOUDINARY_CLOUD_NAME CLOUDINARY_API_KEY CLOUDINARY_API_SECRET; do
    grep -qE "^${v}=.+" "$MIG" && ok "$v is set" || warn "$v not set — Stage 7 media pairing will be skipped"
  done
  grep -qE "^CLOUDINARY_FOLDER=.+" "$MIG" \
    && ok "CLOUDINARY_FOLDER is set" \
    || warn "CLOUDINARY_FOLDER unset — code reads it (services/cloudinary.js:26); defaults to bk/products"
  # A secret file must never be tracked.
  git -C "$ROOT" check-ignore -q deploy/.env.migration \
    && ok ".env.migration is gitignored" || bad ".env.migration is NOT gitignored — stop and fix"
else
  bad "deploy/.env.migration missing — Phase 2 capture from Render not done"
fi

echo
echo "== aws access =="
if [ "${AWS_ACCESS_KEY_ID:-}" = "proxy-injected" ]; then
  bad "AWS credentials are the sandbox placeholder 'proxy-injected' — no real access"
else
  IDENT="$(aws sts get-caller-identity --output json 2>&1)"
  if echo "$IDENT" | grep -q '"Account"'; then
    ACCT=$(echo "$IDENT" | python3 -c 'import sys,json;print(json.load(sys.stdin)["Account"])')
    ARN=$(echo "$IDENT"  | python3 -c 'import sys,json;print(json.load(sys.stdin)["Arn"])')
    ok "authenticated as $ARN"
    ok "account $ACCT"
    ORG="$(aws organizations describe-organization --output json 2>&1)"
    if echo "$ORG" | grep -q '"MasterAccountId"'; then
      MGMT=$(echo "$ORG" | python3 -c 'import sys,json;print(json.load(sys.stdin)["Organization"]["MasterAccountId"])')
      warn "account is in an AWS Organization (management account $MGMT) — SCPs may apply"
    else
      ok "not in an Organization, or no permission to read it (no SCP risk detected)"
    fi
  else
    bad "sts get-caller-identity failed: $(echo "$IDENT" | head -1)"
  fi
fi

echo
echo "== dns =="
if [ -n "${API_DOMAIN:-}" ]; then
  IP="$(getent hosts "$API_DOMAIN" 2>/dev/null | awk '{print $1}' | head -1)"
  if [ -n "$IP" ]; then
    ok "$API_DOMAIN resolves to $IP"
    warn "confirm that is your EC2 Elastic IP before issuing a certificate"
  else
    bad "$API_DOMAIN does not resolve — Caddy cannot get a Let's Encrypt cert without it"
  fi
fi

echo
if [ "$FAIL" -eq 0 ]; then
  echo "PRE-FLIGHT PASSED — safe to run ./deploy/go-live.sh"
else
  echo "PRE-FLIGHT FAILED — resolve the FAIL lines above before deploying"
fi
exit "$FAIL"
