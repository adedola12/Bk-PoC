#!/usr/bin/env bash
# EC2 user-data: bootstrap an Amazon Linux 2023 box to run BK-Ingest.
#
# Paste this into "User data" when launching the instance. It installs Docker,
# the compose plugin, and lays out /opt/bk. It deliberately does NOT start the
# app: you still have to copy .env.migration onto the box and set API_DOMAIN,
# because secrets must never travel in user-data (it is readable from the
# instance metadata service by anything running on the box).
set -euxo pipefail

dnf update -y
dnf install -y docker git
systemctl enable --now docker
usermod -aG docker ec2-user

# Compose v2 as a docker CLI plugin
mkdir -p /usr/libexec/docker/cli-plugins
curl -fsSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64" \
  -o /usr/libexec/docker/cli-plugins/docker-compose
chmod +x /usr/libexec/docker/cli-plugins/docker-compose

mkdir -p /opt/bk
chown ec2-user:ec2-user /opt/bk

# Redeploy helper: pulls the newest image from ECR and restarts.
cat > /opt/bk/update.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cd /opt/bk
[ -f .env.deploy ] || { echo "missing /opt/bk/.env.deploy"; exit 1; }
set -a; source .env.deploy; set +a
: "${AWS_REGION:?}"; : "${ECR_IMAGE:?}"; : "${API_DOMAIN:?}"
REGISTRY="${ECR_IMAGE%%/*}"
aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$REGISTRY"
docker compose pull
docker compose up -d
docker image prune -f
echo "deployed. logs: docker compose logs -f api"
EOF
chmod +x /opt/bk/update.sh
chown ec2-user:ec2-user /opt/bk/update.sh

# awscli v2 for the ECR login above
dnf install -y awscli-2 || dnf install -y awscli

echo "BOOTSTRAP COMPLETE — next: copy docker-compose.yml, Caddyfile, .env.deploy and .env.migration into /opt/bk, then run ./update.sh"
