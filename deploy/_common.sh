# shellcheck shell=bash
# Shared config + the canonical env-var manifest for the BK-Ingest deploy scripts.
# Sourced by write-env-migration.sh and 05-deploy-via-ssm.sh — not executable on its own.

set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$DEPLOY_DIR/.." && pwd)"

# ─── config ──────────────────────────────────────────────────────────
# deploy/deploy.env (gitignored) overrides these; the environment overrides both.
load_deploy_config() {
  local cfg="${DEPLOY_CONFIG:-$DEPLOY_DIR/deploy.env}"
  if [[ -f "$cfg" ]]; then
    # shellcheck disable=SC1090
    source "$cfg"
    CONFIG_SOURCE="$cfg"
  else
    CONFIG_SOURCE="(none — using defaults; copy deploy/deploy.env.example)"
  fi

  AWS_REGION="${AWS_REGION:-eu-west-1}"
  SSM_PREFIX="${SSM_PREFIX:-/bk-poc/prod}"
  TARGET_TAG_KEY="${TARGET_TAG_KEY:-Name}"
  TARGET_TAG_VALUE="${TARGET_TAG_VALUE:-bk-ingest-api}"
  SERVICE_NAME="${SERVICE_NAME:-bk-ingest-api}"
  REMOTE_ENV_FILE="${REMOTE_ENV_FILE:-/etc/bk-ingest/api.env}"
  HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:5000/healthz}"
  SSM_TIMEOUT_SECONDS="${SSM_TIMEOUT_SECONDS:-600}"

  SSM_PREFIX="${SSM_PREFIX%/}" # no trailing slash — parameter names are $SSM_PREFIX/NAME
}

# ─── env-var manifest ────────────────────────────────────────────────
# NAME|SSM type|required — mirrors .env.example and every process.env.* read in server/.
# SecureString for anything credential-bearing; String for the rest (cheaper to read, and
# they show up in plain `aws ssm get-parameters-by-path` output without KMS).
ENV_MANIFEST=(
  "ANTHROPIC_API_KEY|SecureString|required"
  "MONGODB_URI|SecureString|required"
  "CLOUDINARY_CLOUD_NAME|String|optional"
  "CLOUDINARY_API_KEY|SecureString|optional"
  "CLOUDINARY_API_SECRET|SecureString|optional"
  "CLOUDINARY_FOLDER|String|optional"
  "CORS_ORIGINS|String|optional"
  "ADLM_AI_URL|String|optional"
  "ADLM_AI_TOKEN|SecureString|optional"
  "NODE_ENV|String|optional"
  "PORT|String|optional"
)

# ─── output helpers ──────────────────────────────────────────────────
# Nothing here ever prints a value — callers pass names and statuses only.
log()  { printf '%s\n' "$*" >&2; }
warn() { printf 'warn: %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

# POSIX-safe single-quoted literal — bash's %q emits $'...' forms that /bin/sh on the
# instance cannot parse, so remote script headers use this instead.
shquote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

require_cmd() {
  local c
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 || die "'$c' is required but not on PATH"
  done
}
