#!/usr/bin/env bash
#
# GameDock Discord bot - optional, opt-in installer.
#
# Run as root AFTER scripts/install.sh has already deployed the main app:
#   sudo bash scripts/install-discord-bot.sh
#
# apps/discord-bot itself is already built and deployed by install.sh (it's
# just another workspace package, built via `pnpm -r build` and rsynced
# alongside the API/web app) - this script only handles the extra,
# bot-specific host plumbing: its own data directory, its own .env, and its
# own systemd unit.
#
# See docs/DISCORD_BOT.md for the full setup guide (Discord Developer
# Portal steps, what each .env value is, slash command reference).
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "This script must run as root (sudo bash scripts/install-discord-bot.sh)" >&2
  exit 1
fi

GAMEDOCK_USER="${GAMEDOCK_USER:-gamedock}"
APP_DIR="${APP_DIR:-/opt/gamedock}"
BOT_DIR="${APP_DIR}/apps/discord-bot"
BOT_DATA_DIR="${BOT_DATA_DIR:-/var/lib/gamedock-discord-bot}"

if ! id -u "${GAMEDOCK_USER}" >/dev/null 2>&1; then
  echo "User ${GAMEDOCK_USER} does not exist. Run scripts/install.sh first." >&2
  exit 1
fi
if [[ ! -f "${BOT_DIR}/dist/index.js" ]]; then
  echo "${BOT_DIR}/dist/index.js not found. Run scripts/install.sh first (it builds every workspace package, including this one)." >&2
  exit 1
fi

echo "==> Creating data directory ${BOT_DATA_DIR}"
mkdir -p "${BOT_DATA_DIR}"
chown "${GAMEDOCK_USER}:${GAMEDOCK_USER}" "${BOT_DATA_DIR}"

if [[ ! -f "${BOT_DIR}/.env" ]]; then
  echo "==> Creating ${BOT_DIR}/.env from template - edit this before starting the service"
  cp "${BOT_DIR}/.env.example" "${BOT_DIR}/.env"
  sed -i "s|GAMEDOCK_BOT_DATA_DIR=.*|GAMEDOCK_BOT_DATA_DIR=${BOT_DATA_DIR}|" "${BOT_DIR}/.env"
  chown "${GAMEDOCK_USER}:${GAMEDOCK_USER}" "${BOT_DIR}/.env"
  chmod 640 "${BOT_DIR}/.env"
else
  echo "==> ${BOT_DIR}/.env already exists, leaving it untouched."
fi

echo "==> Installing systemd unit"
cp "${APP_DIR}/scripts/systemd/gamedock-discord-bot.service" /etc/systemd/system/gamedock-discord-bot.service
systemctl daemon-reload
systemctl enable gamedock-discord-bot

echo
echo "==> Done. Before starting the service:"
echo "    1. Fill in ${BOT_DIR}/.env - see docs/DISCORD_BOT.md for where each value comes from"
echo "    2. Create a GameDock API token for the bot (an admin user, Settings -> API tokens)"
echo "    3. sudo systemctl start gamedock-discord-bot"
echo "    4. journalctl -u gamedock-discord-bot -f   # watch it log in and register commands"
