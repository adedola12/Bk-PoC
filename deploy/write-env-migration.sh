#!/usr/bin/env bash
#
# write-env-migration.sh — migrate the BK-Ingest API env into SSM Parameter Store.
#
# Reads the local .env (or the current environment with --from-env) and writes each
# variable in the manifest to $SSM_PREFIX/<NAME>. Output is names + set/skipped only:
# no value is ever printed, logged, or passed on a command line where `ps` could see it.
#
#   ./deploy/write-env-migration.sh [--env-file PATH | --from-env] [--dry-run]
#                                   [--prefix /bk-poc/prod] [--region eu-west-1]
#
# Exits non-zero if a required variable had no value to migrate.

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"
load_deploy_config

ENV_FILE="$REPO_ROOT/.env"
FROM_ENV=0
DRY_RUN=0

usage() { awk 'NR>1 && /^#/ { sub(/^#[[:space:]]?/, ""); print; next } NR>1 { exit }' "${BASH_SOURCE[0]}" >&2; exit "${1:-0}"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file) ENV_FILE="${2:?--env-file needs a path}"; shift 2 ;;
    --from-env) FROM_ENV=1; shift ;;
    --dry-run)  DRY_RUN=1; shift ;;
    --prefix)   SSM_PREFIX="${2:?--prefix needs a value}"; SSM_PREFIX="${SSM_PREFIX%/}"; shift 2 ;;
    --region)   AWS_REGION="${2:?--region needs a value}"; shift 2 ;;
    -h|--help)  usage 0 ;;
    *)          log "unknown argument: $1"; usage 1 ;;
  esac
done

require_cmd aws jq
[[ $FROM_ENV -eq 1 || -f "$ENV_FILE" ]] || die "no env file at $ENV_FILE (use --env-file or --from-env)"

# Scratch dir for the JSON payloads — values reach the AWS CLI through a 0600 file,
# never through argv.
umask 077
TMPDIR_SECURE="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_SECURE"' EXIT

# Pull one value out of a dotenv file without sourcing it (sourcing would execute it).
# Takes the last assignment wins, strips `export `, CR, and one layer of matching quotes.
read_env_file_value() {
  local name="$1" file="$2" line val
  line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?${name}=" "$file" | tail -n 1 || true)"
  [[ -n "$line" ]] || return 0
  val="${line#*=}"
  val="${val%$'\r'}"
  if [[ "$val" == \"*\" && ${#val} -ge 2 ]]; then
    val="${val:1:${#val}-2}"
  elif [[ "$val" == \'*\' && ${#val} -ge 2 ]]; then
    val="${val:1:${#val}-2}"
  else
    val="${val%"${val##*[![:space:]]}"}" # trim trailing whitespace on unquoted values
  fi
  printf '%s' "$val"
}

current_ssm_value() {
  aws ssm get-parameter --name "$1" --with-decryption \
      --region "$AWS_REGION" --query 'Parameter.Value' --output json 2>/dev/null \
    | jq -r 'select(. != null)' || true
}

put_ssm_value() {
  local name="$1" type="$2" value="$3"
  local vfile="$TMPDIR_SECURE/value" jfile="$TMPDIR_SECURE/put.json"
  printf '%s' "$value" >"$vfile"
  jq -n --arg n "$name" --arg t "$type" --rawfile v "$vfile" \
     '{Name:$n, Value:$v, Type:$t, Overwrite:true}' >"$jfile"
  aws ssm put-parameter --cli-input-json "file://$jfile" --region "$AWS_REGION" >/dev/null
  rm -f "$vfile" "$jfile"
}

log "source:  $([[ $FROM_ENV -eq 1 ]] && echo '(process environment)' || echo "$ENV_FILE")"
log "target:  $SSM_PREFIX/* in $AWS_REGION"
log "config:  $CONFIG_SOURCE"
[[ $DRY_RUN -eq 1 ]] && log "mode:    dry run — nothing will be written"
log ""

missing_required=""   # space-separated: portable to bash 3.2 under `set -u`
count_written=0

for entry in "${ENV_MANIFEST[@]}"; do
  IFS='|' read -r name type requirement <<<"$entry"
  param="$SSM_PREFIX/$name"

  if [[ $FROM_ENV -eq 1 ]]; then
    value="${!name:-}"
  else
    value="$(read_env_file_value "$name" "$ENV_FILE")"
  fi

  if [[ -z "$value" ]]; then
    printf '  %-24s %-12s skipped (no value in source)\n' "$name" "$type" >&2
    [[ "$requirement" == "required" ]] && missing_required="$missing_required $name"
    continue
  fi

  if [[ $DRY_RUN -eq 1 ]]; then
    printf '  %-24s %-12s would set\n' "$name" "$type" >&2
    count_written=$((count_written + 1))
    continue
  fi

  existing="$(current_ssm_value "$param")"
  if [[ -n "$existing" && "$existing" == "$value" ]]; then
    printf '  %-24s %-12s unchanged\n' "$name" "$type" >&2
    continue
  fi

  put_ssm_value "$param" "$type" "$value"
  if [[ -n "$existing" ]]; then
    printf '  %-24s %-12s set (updated)\n' "$name" "$type" >&2
  else
    printf '  %-24s %-12s set (created)\n' "$name" "$type" >&2
  fi
  count_written=$((count_written + 1))
done

log ""
if [[ $DRY_RUN -eq 1 ]]; then
  log "$count_written parameter(s) would be written to $SSM_PREFIX"
else
  log "$count_written parameter(s) written to $SSM_PREFIX"
fi

if [[ -n "${missing_required// /}" ]]; then
  die "required variable(s) had no value:$missing_required"
fi

[[ $DRY_RUN -eq 1 ]] || log "next: ./deploy/05-deploy-via-ssm.sh"
