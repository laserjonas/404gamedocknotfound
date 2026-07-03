#!/usr/bin/env bash
#
# GameDock Manager - Debian dependency installer.
# Run as root ONCE on a fresh Debian (12/13) host:
#   sudo bash scripts/install.sh
#
# Installs system dependencies, creates the "gamedock" service user and the
# directory layout. It does NOT deploy the app itself - see deploy.sh.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "This script must run as root (sudo bash scripts/install.sh)" >&2
  exit 1
fi

GAMEDOCK_USER="${GAMEDOCK_USER:-gamedock}"
APP_DIR="${APP_DIR:-/opt/gamedock}"
DATA_DIR="${DATA_DIR:-/var/lib/gamedock}"
LOG_DIR="${LOG_DIR:-/var/log/gamedock}"

echo "==> Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg git rsync sudo \
  tar unzip xz-utils \
  python3 \
  lib32gcc-s1 lib32stdc++6

echo "==> Installing Java (for Minecraft servers)"
apt-get install -y --no-install-recommends openjdk-21-jre-headless \
  || apt-get install -y --no-install-recommends openjdk-17-jre-headless \
  || echo "WARNING: no OpenJDK package found; install Java manually for Minecraft servers"

echo "==> Installing Node.js 22 LTS (NodeSource)"
if ! command -v node >/dev/null 2>&1 || [[ "$(node --version | cut -c2-3)" -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node --version

echo "==> Installing pnpm"
if ! command -v pnpm >/dev/null 2>&1; then
  npm install -g pnpm
fi
pnpm --version

echo "==> Creating service user '${GAMEDOCK_USER}'"
if ! id -u "${GAMEDOCK_USER}" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "/home/${GAMEDOCK_USER}" \
    --shell /usr/sbin/nologin "${GAMEDOCK_USER}"
fi

echo "==> Creating 'gamedock-instances' group (for optional per-instance user isolation)"
groupadd --system gamedock-instances 2>/dev/null || true

echo "==> Creating directory layout"
mkdir -p "${APP_DIR}"
mkdir -p "${DATA_DIR}/instances" "${DATA_DIR}/backups" "${DATA_DIR}/templates" "${DATA_DIR}/runtimes"
# steamcmd and auto-downloaded Java runtimes need a writable $HOME; the real
# home directory of ${GAMEDOCK_USER} is masked read-only by the systemd unit.
mkdir -p "${DATA_DIR}/steamcmd-home"
mkdir -p "${LOG_DIR}"
chown -R "${GAMEDOCK_USER}:${GAMEDOCK_USER}" "${DATA_DIR}" "${LOG_DIR}"
chmod 750 "${DATA_DIR}" "${DATA_DIR}/instances" "${DATA_DIR}/backups" "${LOG_DIR}"

echo "==> Optional: SteamCMD"
echo "    SteamCMD is needed for Steam-based game servers (Valheim, Rust, CS2, ...)."
echo "    Install it with: sudo bash scripts/install-steamcmd.sh"
echo
echo "==> Done. Next steps:"
echo "    1. Deploy the app:      sudo bash scripts/deploy.sh"
echo "    2. Create an admin:     see docs/INSTALL_DEBIAN.md"
