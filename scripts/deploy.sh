#!/usr/bin/env bash
#
# GameDock Manager - production deployment script for Debian.
# Builds the monorepo and installs it to /opt/gamedock, sets up the
# systemd service and starts it. Run as root from a checkout of the repo:
#   sudo bash scripts/deploy.sh
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "This script must run as root (sudo bash scripts/deploy.sh)" >&2
  exit 1
fi

GAMEDOCK_USER="${GAMEDOCK_USER:-gamedock}"
APP_DIR="${APP_DIR:-/opt/gamedock}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! id -u "${GAMEDOCK_USER}" >/dev/null 2>&1; then
  echo "User ${GAMEDOCK_USER} does not exist. Run scripts/install.sh first." >&2
  exit 1
fi

echo "==> Building (${REPO_DIR})"
cd "${REPO_DIR}"
pnpm install --frozen-lockfile
pnpm -r build

echo "==> Installing to ${APP_DIR}"
mkdir -p "${APP_DIR}"

# Copy the workspace (sources + dist) excluding dev clutter, then install
# production node_modules in place.
rsync -a --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'data' \
  --exclude '.env' \
  "${REPO_DIR}/" "${APP_DIR}/"

cd "${APP_DIR}"
# CI=true: pnpm refuses to purge devDependencies from an existing node_modules
# without a TTY confirmation prompt otherwise, which this script never has.
CI=true pnpm install --frozen-lockfile --prod

# The API serves the web UI from apps/api/web-dist.
rm -rf "${APP_DIR}/apps/api/web-dist"
cp -r "${APP_DIR}/apps/web/dist" "${APP_DIR}/apps/api/web-dist"

if [[ ! -f "${APP_DIR}/.env" ]]; then
  echo "==> Creating ${APP_DIR}/.env from template"
  cp "${APP_DIR}/.env.example" "${APP_DIR}/.env"
  SECRET="$(openssl rand -hex 32)"
  sed -i "s|GAMEDOCK_SESSION_SECRET=.*|GAMEDOCK_SESSION_SECRET=${SECRET}|" "${APP_DIR}/.env"
  sed -i "s|GAMEDOCK_NODE_ENV=.*|GAMEDOCK_NODE_ENV=production|" "${APP_DIR}/.env"
  sed -i "s|GAMEDOCK_DATA_DIR=.*|GAMEDOCK_DATA_DIR=/var/lib/gamedock|" "${APP_DIR}/.env"
  sed -i "s|GAMEDOCK_INSTANCE_DIR=.*|GAMEDOCK_INSTANCE_DIR=/var/lib/gamedock/instances|" "${APP_DIR}/.env"
  sed -i "s|GAMEDOCK_BACKUP_DIR=.*|GAMEDOCK_BACKUP_DIR=/var/lib/gamedock/backups|" "${APP_DIR}/.env"
  if command -v steamcmd >/dev/null 2>&1; then
    sed -i "s|GAMEDOCK_STEAMCMD_PATH=.*|GAMEDOCK_STEAMCMD_PATH=$(command -v steamcmd)|" "${APP_DIR}/.env"
  elif [[ -x /usr/games/steamcmd ]]; then
    sed -i "s|GAMEDOCK_STEAMCMD_PATH=.*|GAMEDOCK_STEAMCMD_PATH=/usr/games/steamcmd|" "${APP_DIR}/.env"
  fi
  chmod 640 "${APP_DIR}/.env"
fi

chown -R "${GAMEDOCK_USER}:${GAMEDOCK_USER}" "${APP_DIR}"

echo "==> Installing systemd unit"
cp "${APP_DIR}/scripts/systemd/gamedock.service" /etc/systemd/system/gamedock.service
systemctl daemon-reload
systemctl enable gamedock

echo "==> Installing per-instance user isolation helper (optional, opt-in feature)"
groupadd --system gamedock-instances 2>/dev/null || true
install -m 0750 -o root -g root "${APP_DIR}/scripts/gamedock-instance-user" \
  /opt/gamedock/scripts/gamedock-instance-user
SUDOERS_TMP="$(mktemp)"
cat >"${SUDOERS_TMP}" <<SUDOEOF
# Managed by GameDock (scripts/deploy.sh) - do not edit by hand.
# Restricts ${GAMEDOCK_USER} to running processes only as members of the
# gamedock-instances group (never root, never any other real account), plus
# one fixed root-owned provisioning script. See docs/SECURITY.md.
Runas_Alias GAMEDOCK_INSTANCE_USERS = %gamedock-instances
${GAMEDOCK_USER} ALL=(GAMEDOCK_INSTANCE_USERS) NOPASSWD: ALL
${GAMEDOCK_USER} ALL=(root) NOPASSWD: ${APP_DIR}/scripts/gamedock-instance-user
SUDOEOF
if visudo -cf "${SUDOERS_TMP}" >/dev/null 2>&1; then
  install -m 0440 -o root -g root "${SUDOERS_TMP}" /etc/sudoers.d/gamedock-instances
else
  echo "WARNING: generated sudoers file failed validation, not installed. Per-instance user isolation (GAMEDOCK_INSTANCE_USER_ISOLATION=true) will not work until this is fixed." >&2
fi
rm -f "${SUDOERS_TMP}"

systemctl restart gamedock

sleep 2
systemctl --no-pager status gamedock || true

echo
echo "==> Deployed. Create the first admin user with:"
echo "    sudo -u ${GAMEDOCK_USER} bash -c 'cd ${APP_DIR} && pnpm gamedock user:create-admin'"
echo "    UI: http://127.0.0.1:8340 (put nginx/caddy in front for TLS, see scripts/nginx/)"
