#!/usr/bin/env bash
# Build and deploy the API onto the EC2 box over AWS Systems Manager.
#
#   ./deploy/05-deploy-via-ssm.sh
#
# Use this instead of go-live.sh steps 3-4 when the machine you are running
# from cannot reach the instance over SSH, or cannot build the image locally.
# Both are true of a sandboxed CI/agent environment: outbound port 22 is
# closed, and the Docker Hub / ECR Public layer CDNs are blocked, so
# `docker build` cannot even fetch its base image.
#
# Everything here travels over the AWS API on 443:
#
#   config + secrets ──> SSM Parameter Store ──> instance pulls them down
#   build/deploy cmds ──> SSM Run Command     ──> instance executes them
#
# The instance builds its own image from the public GitHub repo and pushes it
# to ECR, so the documented `./update.sh` redeploy path keeps working after.
#
# Secrets are put in Parameter Store as SecureString (KMS-encrypted) and are
# never passed as Run Command parameters — command invocations are readable in
# the SSM console and CloudTrail for 30 days.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONF="$ROOT/deploy/.env.deploy"
[ -f "$CONF" ] || { echo "ERROR: deploy/.env.deploy not found — run 03-provision-infra.sh first."; exit 1; }
# shellcheck disable=SC1090
set -a; source "$CONF"; set +a

: "${AWS_REGION:?}"; : "${ECR_IMAGE:?}"; : "${API_DOMAIN:?}"; : "${EC2_INSTANCE_ID:?}"
MIG="$ROOT/deploy/.env.migration"
[ -f "$MIG" ] || { echo "ERROR: deploy/.env.migration not found — run deploy/write-env-migration.sh"; exit 1; }

GIT_REPO="${GIT_REPO:-https://github.com/adedola12/Bk-PoC.git}"
GIT_REF="${GIT_REF:-$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)}"
PREFIX=/bk-ingest/deploy

step() { printf '\n\033[1;36m━━━ %s ━━━\033[0m\n' "$1"; }

# ───────────────── 1. instance must be registered with SSM ─────────────────
step "1/4  waiting for SSM agent on $EC2_INSTANCE_ID"
for i in $(seq 1 40); do
  PING="$(aws ssm describe-instance-information --region "$AWS_REGION" \
    --filters "Key=InstanceIds,Values=$EC2_INSTANCE_ID" \
    --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null || echo None)"
  [ "$PING" = "Online" ] && { echo "  SSM agent Online"; break; }
  echo "  not registered yet (${i}/40) — status ${PING}"; sleep 15
done
[ "${PING:-}" = "Online" ] || {
  echo "  SSM never came Online. Check the instance role has AmazonSSMManagedInstanceCore"
  echo "  and that the instance has egress to the internet."; exit 1; }

# ───────────────── 2. stage config + secrets in Parameter Store ─────────────────
# Written every run so the box always converges on what is in this checkout.
step "2/4  staging config in Parameter Store (secrets as SecureString)"
put() {  # put <name> <type> <file>
  aws ssm put-parameter --region "$AWS_REGION" --name "$1" --type "$2" \
    --overwrite --value "file://$3" >/dev/null
  echo "  $1  ($2)"
}
put "$PREFIX/env.migration"    SecureString "$MIG"
put "$PREFIX/env.deploy"       String       "$CONF"
put "$PREFIX/docker-compose"   String       "$ROOT/deploy/docker-compose.yml"
put "$PREFIX/caddyfile"        String       "$ROOT/deploy/Caddyfile"

# The instance needs read access to exactly these parameters.
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
aws iam put-role-policy --role-name bk-ingest-ec2-role --policy-name bk-ingest-ssm-params \
  --policy-document "$(cat <<JSON
{"Version":"2012-10-17","Statement":[{"Effect":"Allow",
  "Action":["ssm:GetParameter","ssm:GetParameters"],
  "Resource":"arn:aws:ssm:${AWS_REGION}:${ACCOUNT_ID}:parameter${PREFIX}/*"}]}
JSON
)" >/dev/null
echo "  instance role granted read on ${PREFIX}/*"

# ───────────────── 3. build on the instance and start the stack ─────────────────
step "3/4  build + deploy on the instance (this takes ~4-6 min)"

# Heredoc is quoted: expand only the handful of values we substitute by hand,
# so nothing in the script body is mangled by the local shell.
REMOTE=$(cat <<'REMOTE_EOF'
set -euxo pipefail
export HOME=/root
REGION="__REGION__"; IMAGE="__IMAGE__"; REPO="__REPO__"; REF="__REF__"; PREFIX="__PREFIX__"

# cloud-init may still be installing docker on a freshly launched box. Wait for
# it, but fall back to installing directly rather than hanging if user-data
# failed for any reason.
for i in $(seq 1 30); do command -v docker >/dev/null && break; sleep 10; done
command -v docker >/dev/null || dnf install -y docker
command -v git   >/dev/null || dnf install -y git
command -v aws   >/dev/null || dnf install -y awscli-2 || dnf install -y awscli
systemctl enable --now docker

# The compose CLI plugin is installed by user-data; install it here too so this
# script is self-sufficient on a box that was bootstrapped some other way.
if ! docker compose version >/dev/null 2>&1; then
  mkdir -p /usr/libexec/docker/cli-plugins
  curl -fsSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64" \
    -o /usr/libexec/docker/cli-plugins/docker-compose
  chmod +x /usr/libexec/docker/cli-plugins/docker-compose
fi

# ─── source ───
mkdir -p /opt/bk
if [ -d /opt/bk/src/.git ]; then
  git -C /opt/bk/src fetch --depth 1 origin "$REF"
  git -C /opt/bk/src checkout -f FETCH_HEAD
else
  rm -rf /opt/bk/src
  git clone --depth 1 --branch "$REF" "$REPO" /opt/bk/src
fi

# ─── build + push ───
# Context is the repo root, not src/server: routes/emit.js reads fixtures/,
# which is a sibling of server/. Building from server/ leaves the BK template
# out of the image and every emission 500s. Same reason as 01-build-and-push.sh.
docker build --platform linux/amd64 \
  -f /opt/bk/src/server/Dockerfile \
  -t "$IMAGE" /opt/bk/src
aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "${IMAGE%%/*}"
docker push "$IMAGE"

# ─── config (fetched here, never passed through Run Command) ───
umask 077
aws ssm get-parameter --region "$REGION" --name "$PREFIX/docker-compose" \
  --query Parameter.Value --output text > /opt/bk/docker-compose.yml
aws ssm get-parameter --region "$REGION" --name "$PREFIX/caddyfile" \
  --query Parameter.Value --output text > /opt/bk/Caddyfile
aws ssm get-parameter --region "$REGION" --name "$PREFIX/env.deploy" \
  --query Parameter.Value --output text > /opt/bk/.env.deploy
aws ssm get-parameter --region "$REGION" --name "$PREFIX/env.migration" --with-decryption \
  --query Parameter.Value --output text > /opt/bk/.env.migration
chmod 600 /opt/bk/.env.migration

# docker-compose.yml interpolates ${ECR_IMAGE} and ${API_DOMAIN}. Compose reads
# those from ./.env automatically, but not from .env.deploy, so a bare
# `docker compose logs` typed while debugging resolves both to empty strings and
# dies with "service api has neither an image nor a build context". Give compose
# the .env it looks for. Contains resource IDs only — no secrets.
cp /opt/bk/.env.deploy /opt/bk/.env

# ─── run ───
cd /opt/bk
set -a; . ./.env.deploy; set +a
docker compose up -d --remove-orphans
docker image prune -f
sleep 12
docker compose ps
# Prove the API answers on the container network before Caddy/TLS is in play.
docker compose exec -T api node -e \
  "fetch('http://127.0.0.1:8080/healthz').then(r=>r.text()).then(t=>console.log('healthz:',t))"
REMOTE_EOF
)
REMOTE="${REMOTE//__REGION__/$AWS_REGION}"
REMOTE="${REMOTE//__IMAGE__/$ECR_IMAGE}"
REMOTE="${REMOTE//__REPO__/$GIT_REPO}"
REMOTE="${REMOTE//__REF__/$GIT_REF}"
REMOTE="${REMOTE//__PREFIX__/$PREFIX}"

echo "  repo $GIT_REPO @ $GIT_REF"
# get-command-invocation truncates to 2500 characters, which on a failed
# `docker build` is all apt output and none of the actual error. Name the log
# group explicitly — leaving CloudWatchOutputEnabled on its own did not create
# one — so the full transcript is always recoverable:
#   aws logs tail /aws/ssm/bk-ingest-deploy --region <region>
LOG_GROUP=/aws/ssm/bk-ingest-deploy
aws logs create-log-group --region "$AWS_REGION" --log-group-name "$LOG_GROUP" 2>/dev/null || true
aws logs put-retention-policy --region "$AWS_REGION" --log-group-name "$LOG_GROUP" \
  --retention-in-days 14 2>/dev/null || true
CMD_ID="$(aws ssm send-command --region "$AWS_REGION" \
  --instance-ids "$EC2_INSTANCE_ID" \
  --document-name AWS-RunShellScript \
  --comment "BK-Ingest build+deploy" \
  --timeout-seconds 3600 \
  --cloud-watch-output-config "CloudWatchOutputEnabled=true,CloudWatchLogGroupName=$LOG_GROUP" \
  --parameters "$(python3 -c 'import json,sys;print(json.dumps({"commands":[sys.stdin.read()],"executionTimeout":["3600"]}))' <<<"$REMOTE")" \
  --query 'Command.CommandId' --output text)"
echo "  command $CMD_ID"

# Poll. Run Command has no blocking wait for long-running invocations.
STATUS=Pending
for i in $(seq 1 120); do
  STATUS="$(aws ssm get-command-invocation --region "$AWS_REGION" \
    --command-id "$CMD_ID" --instance-id "$EC2_INSTANCE_ID" \
    --query Status --output text 2>/dev/null || echo Pending)"
  case "$STATUS" in
    Success|Failed|Cancelled|TimedOut) break ;;
  esac
  printf '  %s… (%d)\r' "$STATUS" "$i"; sleep 15
done
echo

aws ssm get-command-invocation --region "$AWS_REGION" \
  --command-id "$CMD_ID" --instance-id "$EC2_INSTANCE_ID" --output json \
| python3 -c '
import json,sys
d = json.load(sys.stdin)
for label, key in (("stdout","StandardOutputContent"), ("stderr","StandardErrorContent")):
    body = (d.get(key) or "").strip()
    if body:
        print("─── %s (tail) ───" % label)
        print("\n".join(body.splitlines()[-25:]))
' || true

[ "$STATUS" = "Success" ] || { echo "REMOTE DEPLOY FAILED (status $STATUS)"; exit 1; }

# ───────────────── 4. verify from outside ─────────────────
step "4/4  verify"
RESOLVED="$(getent hosts "$API_DOMAIN" 2>/dev/null | awk '{print $1}' | head -1 || true)"
if [ "$RESOLVED" != "${ELASTIC_IP:-}" ]; then
  cat <<EOF
  The stack is running, but ${API_DOMAIN} resolves to '${RESOLVED:-nothing}'
  and must resolve to '${ELASTIC_IP:-<elastic ip>}'.

  Create that A record. Caddy retries ACME on its own, so the certificate is
  issued within a minute or two of DNS propagating — no redeploy needed.
EOF
  exit 0
fi
echo "  DNS OK: $API_DOMAIN -> $RESOLVED"
for i in $(seq 1 30); do
  curl -fsS "https://${API_DOMAIN}/healthz" >/dev/null 2>&1 && break
  sleep 10
done
echo "  GET /healthz -> $(curl -fsS "https://${API_DOMAIN}/healthz" 2>&1 || echo FAILED)"
