#!/usr/bin/env bash
#
# 05-deploy-via-ssm.sh — restage the API config from SSM and restart the service.
#
# Finds the API instances by tag, then runs one SSM command on each that:
#   1. reads every parameter under $SSM_PREFIX (decrypted),
#   2. renders them atomically to $REMOTE_ENV_FILE (0600 root:root),
#   3. restarts the systemd unit and waits for /healthz.
#
#   ./deploy/05-deploy-via-ssm.sh [--dry-run] [--prefix /bk-poc/prod]
#                                 [--region eu-west-1] [--tag Key=Value]
#
# Config only — this does not ship code. Run it after write-env-migration.sh, or
# any time the parameters change. Remote output lists variable names, never values.

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"
load_deploy_config

DRY_RUN=0

usage() { awk 'NR>1 && /^#/ { sub(/^#[[:space:]]?/, ""); print; next } NR>1 { exit }' "${BASH_SOURCE[0]}" >&2; exit "${1:-0}"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --prefix)  SSM_PREFIX="${2:?--prefix needs a value}"; SSM_PREFIX="${SSM_PREFIX%/}"; shift 2 ;;
    --region)  AWS_REGION="${2:?--region needs a value}"; shift 2 ;;
    --tag)     TARGET_TAG_KEY="${2%%=*}"; TARGET_TAG_VALUE="${2#*=}"; shift 2 ;;
    -h|--help) usage 0 ;;
    *)         log "unknown argument: $1"; usage 1 ;;
  esac
done

require_cmd aws jq

umask 077
TMPDIR_SECURE="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_SECURE"' EXIT

# ─── the script that runs on each instance ───────────────────────────
# POSIX sh only: SSM's AWS-RunShellScript document does not guarantee bash.
REMOTE_SCRIPT="$TMPDIR_SECURE/remote.sh"
{
  printf 'set -eu\n'
  printf 'SSM_PREFIX=%s\n'  "$(shquote "$SSM_PREFIX")"
  printf 'AWS_REGION=%s\n'  "$(shquote "$AWS_REGION")"
  printf 'ENV_FILE=%s\n'    "$(shquote "$REMOTE_ENV_FILE")"
  printf 'SERVICE=%s\n'     "$(shquote "$SERVICE_NAME")"
  printf 'HEALTH_URL=%s\n'  "$(shquote "$HEALTH_URL")"
  cat <<'REMOTE_BODY'

umask 077
command -v jq >/dev/null 2>&1 || { echo "jq is not installed on this instance"; exit 1; }

echo "== reading $SSM_PREFIX =="
PARAMS=$(aws ssm get-parameters-by-path --path "$SSM_PREFIX" --recursive \
           --with-decryption --region "$AWS_REGION" --output json)
COUNT=$(printf '%s' "$PARAMS" | jq '.Parameters | length')
if [ "$COUNT" -eq 0 ]; then
  echo "no parameters under $SSM_PREFIX — refusing to overwrite $ENV_FILE with an empty file"
  exit 1
fi

# A newline in a value cannot survive a line-oriented env file — name it and stop
# rather than write a file that silently truncates.
BAD=$(printf '%s' "$PARAMS" \
  | jq -r '[.Parameters[] | select(.Value | test("\n")) | .Name] | join(" ")')
if [ -n "$BAD" ]; then
  echo "parameter(s) contain a newline and cannot be written to an env file: $BAD"
  exit 1
fi

TMP=$(mktemp)
{
  echo "# rendered by deploy/05-deploy-via-ssm.sh from $SSM_PREFIX — do not edit by hand"
  # Double quotes with \ " $ ` escaped: the one form systemd's EnvironmentFile parser
  # and POSIX sh read identically. (Single quotes would differ — systemd honours
  # backslash escapes inside them, sh does not, so a value with a \ would diverge.)
  printf '%s' "$PARAMS" | jq -r '
    def esc:
      split("\\") | join("\\\\")
      | split("\"") | join("\\\"")
      | split("$")  | join("\\$")
      | split("`")  | join("\\`");
    .Parameters[] | "\(.Name | split("/") | last)=\"\(.Value | esc)\""
  ' | sort
} >"$TMP"

echo "staged $COUNT variable(s) into $ENV_FILE:"
grep -v '^#' "$TMP" | cut -d= -f1 | sed 's/^/  /'

install -d -m 0750 "$(dirname "$ENV_FILE")"
install -m 0600 -o root -g root "$TMP" "$ENV_FILE"
rm -f "$TMP"

echo "== restarting $SERVICE =="
systemctl restart "$SERVICE"

i=0
while [ "$i" -lt 10 ]; do
  systemctl is-active --quiet "$SERVICE" && break
  i=$((i + 1))
  sleep 1
done
if ! systemctl is-active --quiet "$SERVICE"; then
  echo "$SERVICE is not active after restart"
  journalctl -u "$SERVICE" -n 40 --no-pager || true
  exit 1
fi

echo "== health check $HEALTH_URL =="
i=0
while [ "$i" -lt 15 ]; do
  if curl -fsS -o /dev/null --max-time 5 "$HEALTH_URL"; then
    echo "healthy — deploy complete"
    exit 0
  fi
  i=$((i + 1))
  sleep 2
done

echo "health check failed after ~30s"
journalctl -u "$SERVICE" -n 40 --no-pager || true
exit 1
REMOTE_BODY
} >"$REMOTE_SCRIPT"

log "target:  tag:$TARGET_TAG_KEY=$TARGET_TAG_VALUE in $AWS_REGION"
log "params:  $SSM_PREFIX/*"
log "service: $SERVICE_NAME  ->  $REMOTE_ENV_FILE"
log "config:  $CONFIG_SOURCE"
log ""

if [[ $DRY_RUN -eq 1 ]]; then
  log "dry run — the command below would be sent to each matching instance:"
  log ""
  cat "$REMOTE_SCRIPT" >&2
  exit 0
fi

# ─── resolve instances ───────────────────────────────────────────────
# Plain read loop rather than mapfile: bash 3.2 (stock macOS) has no mapfile, and a
# counter avoids expanding a possibly-empty array under `set -u`.
INSTANCES=()
INSTANCE_COUNT=0
while IFS= read -r instance_id; do
  [[ -n "$instance_id" ]] || continue
  INSTANCES+=("$instance_id")
  INSTANCE_COUNT=$((INSTANCE_COUNT + 1))
done < <(
  aws ssm describe-instance-information --region "$AWS_REGION" \
    --filters "Key=tag:$TARGET_TAG_KEY,Values=$TARGET_TAG_VALUE" \
    --query 'InstanceInformationList[?PingStatus==`Online`].InstanceId' \
    --output text | tr '\t' '\n'
)
[[ $INSTANCE_COUNT -gt 0 ]] \
  || die "no SSM-managed instance is Online with tag:$TARGET_TAG_KEY=$TARGET_TAG_VALUE"
log "instances: ${INSTANCES[*]}"

# ─── send ────────────────────────────────────────────────────────────
PAYLOAD="$TMPDIR_SECURE/send.json"
jq -n \
  --rawfile script "$REMOTE_SCRIPT" \
  --argjson ids "$(printf '%s\n' "${INSTANCES[@]}" | jq -R . | jq -s .)" \
  --arg timeout "$SSM_TIMEOUT_SECONDS" \
  '{
     DocumentName: "AWS-RunShellScript",
     InstanceIds: $ids,
     Comment: "bk-ingest: restage env from SSM + restart API",
     TimeoutSeconds: ($timeout | tonumber),
     Parameters: { commands: [$script], executionTimeout: [$timeout] }
   }' >"$PAYLOAD"

COMMAND_ID="$(aws ssm send-command --cli-input-json "file://$PAYLOAD" \
                --region "$AWS_REGION" --query 'Command.CommandId' --output text)"
log "command: $COMMAND_ID"
log ""

# ─── wait ────────────────────────────────────────────────────────────
while :; do
  RESULT="$(aws ssm list-command-invocations --command-id "$COMMAND_ID" --details \
              --region "$AWS_REGION" --output json)"
  TOTAL="$(printf '%s' "$RESULT" | jq '.CommandInvocations | length')"
  PENDING="$(printf '%s' "$RESULT" \
    | jq '[.CommandInvocations[] | select(.Status | test("Pending|InProgress|Delayed"))] | length')"
  [[ "$TOTAL" -eq $INSTANCE_COUNT && "$PENDING" -eq 0 ]] && break
  sleep 3
done

printf '%s' "$RESULT" | jq -r '
  .CommandInvocations[]
  | "── \(.InstanceId)  [\(.Status)]\n"
    + ([.CommandPlugins[]? | .Output // ""] | join("\n") | rtrimstr("\n"))
' >&2

FAILED="$(printf '%s' "$RESULT" \
  | jq -r '[.CommandInvocations[] | select(.Status != "Success") | .InstanceId] | join(" ")')"
log ""
if [[ -n "$FAILED" ]]; then
  die "deploy failed on: $FAILED (aws ssm get-command-invocation --command-id $COMMAND_ID --instance-id <id>)"
fi
log "deploy succeeded on $INSTANCE_COUNT instance(s)"
