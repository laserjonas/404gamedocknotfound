#!/usr/bin/env bash
#
# GameDock Manager - single-script Debian install.
#
# Run as root from a checkout of this repo:
#   sudo bash scripts/install.sh
#
# Installs system dependencies, creates the "gamedock" service user and
# directory layout, builds the app and deploys it to /opt/gamedock, optionally
# configures Nginx as a TLS reverse proxy (self-signed or Let's Encrypt), and
# optionally creates the first admin user - by the time it exits, the panel
# is up and running under systemd.
#
# Safe to re-run: every step is idempotent (existing users/files/config are
# left alone or refreshed in place, never duplicated). This is also the
# recovery path if a manual redeploy is ever needed - see docs/DEPLOYMENT.md.
#
# Every prompt can be pre-answered via environment variables (for unattended/
# scripted installs) - run with `sudo -E` to preserve them:
#   GAMEDOCK_INSTALL_STEAMCMD=y|n
#   GAMEDOCK_SETUP_NGINX=y|n
#   GAMEDOCK_DOMAIN=panel.example.com
#   GAMEDOCK_USE_LETSENCRYPT=y|n
#   GAMEDOCK_CERTBOT_EMAIL=you@example.com   (blank is fine)
#   GAMEDOCK_PUBLIC_HOST=192.168.1.10        (only asked if nginx is skipped)
#   GAMEDOCK_BIND_ALL=y|n                    (only asked if nginx is skipped)
#   GAMEDOCK_CREATE_ADMIN=y|n
#   GAMEDOCK_ADMIN_USER=admin
#   GAMEDOCK_ADMIN_PASSWORD=...              (min. 10 chars)
# Any variable left unset is prompted for interactively, or falls back to a
# sensible default when stdin isn't a terminal (e.g. run from a CI pipeline).
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "This script must run as root (sudo bash scripts/install.sh)" >&2
  exit 1
fi

GAMEDOCK_USER="${GAMEDOCK_USER:-gamedock}"
APP_DIR="${APP_DIR:-/opt/gamedock}"
DATA_DIR="${DATA_DIR:-/var/lib/gamedock}"
LOG_DIR="${LOG_DIR:-/var/log/gamedock}"
GAMEDOCK_PORT="${GAMEDOCK_PORT:-8340}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

INTERACTIVE=1
[[ -t 0 ]] || INTERACTIVE=0

# ask_yn <prompt> <default: y|n> <var name>
# Skips the prompt entirely if <var name> is already set in the environment
# (lets every question be pre-answered for unattended installs).
ask_yn() {
  local prompt="$1" default="$2" __var="$3"
  if [[ -n "${!__var:-}" ]]; then return; fi
  if [[ "${INTERACTIVE}" -eq 0 ]]; then
    printf -v "${__var}" '%s' "${default}"
    echo "${prompt} -> ${default} (non-interactive, using default)"
    return
  fi
  local suffix="[y/N]" reply
  [[ "${default}" == "y" ]] && suffix="[Y/n]"
  read -r -p "${prompt} ${suffix} " reply || true
  reply="${reply:-${default}}"
  case "${reply}" in
    [Yy]*) printf -v "${__var}" 'y' ;;
    *) printf -v "${__var}" 'n' ;;
  esac
}

# ask_val <prompt> <default> <var name>
ask_val() {
  local prompt="$1" default="$2" __var="$3"
  if [[ -n "${!__var:-}" ]]; then return; fi
  if [[ "${INTERACTIVE}" -eq 0 ]]; then
    printf -v "${__var}" '%s' "${default}"
    return
  fi
  local reply
  read -r -p "${prompt} [${default}]: " reply || true
  printf -v "${__var}" '%s' "${reply:-${default}}"
}

echo "==> Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg git rsync sudo openssl \
  tar unzip xz-utils \
  python3 \
  lib32gcc-s1 lib32stdc++6

echo "==> Installing a fallback host Java (for modpack run.sh scripts - vanilla Minecraft"
echo "    Java servers auto-download their own matching JDK per version, see GAME_TEMPLATES.md)"
apt-get install -y --no-install-recommends openjdk-21-jre-headless \
  || apt-get install -y --no-install-recommends openjdk-17-jre-headless \
  || echo "WARNING: no OpenJDK package found; install Java manually for modded Minecraft servers"

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

echo
ask_yn "Install SteamCMD (needed for Steam-based game servers: Valheim, Rust, CS2, ...)?" y GAMEDOCK_INSTALL_STEAMCMD
if [[ "${GAMEDOCK_INSTALL_STEAMCMD}" == y ]]; then
  bash "${REPO_DIR}/scripts/install-steamcmd.sh"
else
  echo "Skipping SteamCMD. Install later any time with: sudo bash scripts/install-steamcmd.sh"
fi

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
chmod 750 "${DATA_DIR}/backups" "${LOG_DIR}"
# ${DATA_DIR} and its instances/ dir need "other" execute (traverse-only, no
# read/list) so a per-instance dedicated Linux user (see
# gamedock-instance-user, opt-in isolation feature) can reach its own
# instance directory - it's not a member of the gamedock group. This does
# NOT grant listing or reading; each instance dir's own permissions (owned
# <user>:gamedock, mode 2770) are what actually restricts access.
chmod 751 "${DATA_DIR}" "${DATA_DIR}/instances"

echo
echo "==> Reverse proxy (Nginx)"
ask_yn "Set up Nginx as a TLS reverse proxy now?" y GAMEDOCK_SETUP_NGINX
if [[ "${GAMEDOCK_SETUP_NGINX}" == y ]]; then
  DEFAULT_DOMAIN="$(hostname -f 2>/dev/null || hostname)"
  ask_val "Domain name GameDock will be reached at (a real DNS name, or a private name resolved via each client's hosts file - WebAuthn/passkey login needs a real hostname, a bare IP address will not work)" "${DEFAULT_DOMAIN}" GAMEDOCK_DOMAIN
  ask_yn "Obtain a free Let's Encrypt certificate for ${GAMEDOCK_DOMAIN}? Requires this domain's public DNS to already point here and ports 80/443 reachable from the internet. Answer no on a private/LAN/test network - a self-signed certificate will be generated instead." n GAMEDOCK_USE_LETSENCRYPT
  if [[ "${GAMEDOCK_USE_LETSENCRYPT}" == y ]]; then
    ask_val "Email address for Let's Encrypt renewal notices (blank to skip)" "" GAMEDOCK_CERTBOT_EMAIL
  fi
  GAMEDOCK_PUBLIC_ORIGIN_VALUE="https://${GAMEDOCK_DOMAIN}"
else
  DEFAULT_HOST="$(hostname -I 2>/dev/null | awk '{print $1}')"
  ask_val "Hostname or IP GameDock will be reached at directly (used only to validate logins - passkey/WebAuthn sign-in will not work over a bare IP, a spec limitation, not a bug)" "${DEFAULT_HOST:-127.0.0.1}" GAMEDOCK_PUBLIC_HOST
  ask_yn "Bind on all network interfaces (0.0.0.0) so the panel is reachable directly, without a proxy? No TLS this way - fine for a trusted LAN, not for the open internet." n GAMEDOCK_BIND_ALL
  GAMEDOCK_PUBLIC_ORIGIN_VALUE="http://${GAMEDOCK_PUBLIC_HOST}:${GAMEDOCK_PORT}"
fi

echo
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
  sed -i "s|GAMEDOCK_PORT=.*|GAMEDOCK_PORT=${GAMEDOCK_PORT}|" "${APP_DIR}/.env"
  sed -i "s|^GAMEDOCK_PUBLIC_ORIGIN=.*|GAMEDOCK_PUBLIC_ORIGIN=${GAMEDOCK_PUBLIC_ORIGIN_VALUE}|" "${APP_DIR}/.env"
  if [[ "${GAMEDOCK_SETUP_NGINX}" == y ]]; then
    sed -i "s|GAMEDOCK_SECURE_COOKIES=.*|GAMEDOCK_SECURE_COOKIES=true|" "${APP_DIR}/.env"
    sed -i "s|GAMEDOCK_HOST=.*|GAMEDOCK_HOST=127.0.0.1|" "${APP_DIR}/.env"
  else
    sed -i "s|GAMEDOCK_HOST=.*|GAMEDOCK_HOST=$( [[ "${GAMEDOCK_BIND_ALL}" == y ]] && echo 0.0.0.0 || echo 127.0.0.1 )|" "${APP_DIR}/.env"
  fi
  if command -v steamcmd >/dev/null 2>&1; then
    sed -i "s|GAMEDOCK_STEAMCMD_PATH=.*|GAMEDOCK_STEAMCMD_PATH=$(command -v steamcmd)|" "${APP_DIR}/.env"
  elif [[ -x /usr/games/steamcmd ]]; then
    sed -i "s|GAMEDOCK_STEAMCMD_PATH=.*|GAMEDOCK_STEAMCMD_PATH=/usr/games/steamcmd|" "${APP_DIR}/.env"
  fi
  chmod 640 "${APP_DIR}/.env"
else
  echo "==> ${APP_DIR}/.env already exists, leaving it untouched."
  echo "    If you changed reverse-proxy settings, double-check GAMEDOCK_PUBLIC_ORIGIN,"
  echo "    GAMEDOCK_SECURE_COOKIES and GAMEDOCK_HOST still match."
fi

chown -R "${GAMEDOCK_USER}:${GAMEDOCK_USER}" "${APP_DIR}"

echo "==> Installing systemd unit"
cp "${APP_DIR}/scripts/systemd/gamedock.service" /etc/systemd/system/gamedock.service
systemctl daemon-reload
systemctl enable gamedock

echo "==> Installing per-instance user isolation helper (optional, opt-in feature)"
groupadd --system gamedock-instances 2>/dev/null || true
# The sudo-as-root helper must live OUTSIDE ${APP_DIR}: the in-app self-update
# rsyncs ${APP_DIR} as the unprivileged gamedock user, which would replace a
# root-owned helper there with a gamedock-writable copy - a privilege
# escalation, since sudoers allows executing that path as root. A root-owned
# copy under /usr/local/sbin is out of the self-update's reach; it only
# changes when install.sh (run as root) is re-run.
install -m 0750 -o root -g root "${APP_DIR}/scripts/gamedock-instance-user" /usr/local/sbin/gamedock-instance-user
# Companion wrapper for per-instance resource limits (systemd-run cgroup
# scopes) - same security model, same reason to live outside APP_DIR.
install -m 0750 -o root -g root "${APP_DIR}/scripts/gamedock-instance-run" /usr/local/sbin/gamedock-instance-run
# DATA_DIR and its instances/ dir need "other" execute (traverse-only, no
# read/list) so a per-instance dedicated user can reach its own instance
# dir - it isn't a member of the gamedock group. Idempotent/self-healing:
# re-applies this even on hosts whose install.sh predates this fix.
if [[ -d "${DATA_DIR}" ]]; then
  chmod 751 "${DATA_DIR}" "${DATA_DIR}/instances"
fi
SUDOERS_TMP="$(mktemp)"
cat >"${SUDOERS_TMP}" <<SUDOEOF
# Managed by GameDock (scripts/install.sh) - do not edit by hand.
# Restricts ${GAMEDOCK_USER} to running processes only as members of the
# gamedock-instances group (never root, never any other real account), plus
# one fixed root-owned provisioning script. See docs/SECURITY.md.
Runas_Alias GAMEDOCK_INSTANCE_USERS = %gamedock-instances
${GAMEDOCK_USER} ALL=(GAMEDOCK_INSTANCE_USERS) NOPASSWD: ALL
${GAMEDOCK_USER} ALL=(root) NOPASSWD: /usr/local/sbin/gamedock-instance-user
${GAMEDOCK_USER} ALL=(root) NOPASSWD: /usr/local/sbin/gamedock-instance-run
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

if [[ "${GAMEDOCK_SETUP_NGINX}" == y ]]; then
  echo
  echo "==> Installing and configuring Nginx"
  apt-get install -y --no-install-recommends nginx

  NGINX_CONF="/etc/nginx/sites-available/gamedock"
  [[ -f "${NGINX_CONF}" ]] && cp "${NGINX_CONF}" "${NGINX_CONF}.bak.$(date +%s)"

  if [[ "${GAMEDOCK_USE_LETSENCRYPT}" == y ]]; then
    apt-get install -y --no-install-recommends certbot python3-certbot-nginx
    # Minimal HTTP-only server block first - certbot's Nginx plugin edits
    # this in place to add the TLS server block + redirect once the
    # HTTP-01 challenge succeeds.
    cat >"${NGINX_CONF}" <<'NGINXEOF'
server {
    listen 80;
    server_name __DOMAIN__;

    client_max_body_size 512m;

    location / {
        proxy_pass http://127.0.0.1:__PORT__;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
    }
}
NGINXEOF
    sed -i "s|__DOMAIN__|${GAMEDOCK_DOMAIN}|g; s|__PORT__|${GAMEDOCK_PORT}|g" "${NGINX_CONF}"
    ln -sf "${NGINX_CONF}" /etc/nginx/sites-enabled/gamedock
    rm -f /etc/nginx/sites-enabled/default
    nginx -t && systemctl reload nginx

    CERTBOT_ARGS=(--nginx -d "${GAMEDOCK_DOMAIN}" --agree-tos --redirect --non-interactive)
    if [[ -n "${GAMEDOCK_CERTBOT_EMAIL:-}" ]]; then
      CERTBOT_ARGS+=(--email "${GAMEDOCK_CERTBOT_EMAIL}")
    else
      CERTBOT_ARGS+=(--register-unsafely-without-email)
    fi
    if ! certbot "${CERTBOT_ARGS[@]}"; then
      echo "WARNING: certbot failed - check that ${GAMEDOCK_DOMAIN} already resolves here and ports 80/443 are reachable from the internet. Nginx is still serving GameDock over plain HTTP on port 80 in the meantime." >&2
    fi
  else
    SSL_DIR="/etc/nginx/ssl"
    mkdir -p "${SSL_DIR}"
    CRT="${SSL_DIR}/gamedock-selfsigned.crt"
    KEY="${SSL_DIR}/gamedock-selfsigned.key"
    DETECTED_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
    if [[ ! -f "${CRT}" || ! -f "${KEY}" ]]; then
      echo "==> Generating a self-signed certificate for ${GAMEDOCK_DOMAIN}"
      OPENSSL_CNF="$(mktemp)"
      cat >"${OPENSSL_CNF}" <<CNFEOF
[req]
distinguished_name = req_distinguished_name
x509_extensions = v3_req
prompt = no
[req_distinguished_name]
CN = ${GAMEDOCK_DOMAIN}
[v3_req]
subjectAltName = @alt_names
[alt_names]
DNS.1 = ${GAMEDOCK_DOMAIN}
IP.1 = ${DETECTED_IP:-127.0.0.1}
CNFEOF
      openssl req -x509 -nodes -days 825 -newkey rsa:2048 \
        -keyout "${KEY}" -out "${CRT}" -config "${OPENSSL_CNF}"
      rm -f "${OPENSSL_CNF}"
      chmod 600 "${KEY}"
    fi
    cat >"${NGINX_CONF}" <<'NGINXEOF'
server {
    listen 80;
    server_name __DOMAIN__;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name __DOMAIN__;

    ssl_certificate     __CRT__;
    ssl_certificate_key __KEY__;

    client_max_body_size 512m;

    location / {
        proxy_pass http://127.0.0.1:__PORT__;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
    }
}
NGINXEOF
    sed -i "s|__DOMAIN__|${GAMEDOCK_DOMAIN}|g; s|__PORT__|${GAMEDOCK_PORT}|g; s|__CRT__|${CRT}|g; s|__KEY__|${KEY}|g" "${NGINX_CONF}"
    ln -sf "${NGINX_CONF}" /etc/nginx/sites-enabled/gamedock
    rm -f /etc/nginx/sites-enabled/default
    nginx -t && systemctl reload nginx
    echo "Self-signed certificate - browsers will warn once until you accept it."
    if [[ "${GAMEDOCK_DOMAIN}" != "${DETECTED_IP:-}" ]] \
      && { ! command -v host >/dev/null 2>&1 || ! host "${GAMEDOCK_DOMAIN}" >/dev/null 2>&1; }; then
      echo "NOTE: '${GAMEDOCK_DOMAIN}' doesn't look publicly resolvable - add it to each client's"
      echo "      hosts file (e.g. 'C:\\Windows\\System32\\drivers\\etc\\hosts' on Windows,"
      echo "      /etc/hosts on Linux/macOS): ${DETECTED_IP:-<this host IP>} ${GAMEDOCK_DOMAIN}"
    fi
  fi

  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    ufw allow 80/tcp
    ufw allow 443/tcp
  fi
fi

echo
ask_yn "Create the first admin user now?" y GAMEDOCK_CREATE_ADMIN
if [[ "${GAMEDOCK_CREATE_ADMIN}" == y ]]; then
  ask_val "Admin username" "admin" GAMEDOCK_ADMIN_USER
  if [[ -z "${GAMEDOCK_ADMIN_PASSWORD:-}" ]]; then
    if [[ "${INTERACTIVE}" -eq 1 ]]; then
      while true; do
        read -r -s -p "Admin password (min. 10 chars): " GAMEDOCK_ADMIN_PASSWORD; echo
        read -r -s -p "Confirm password: " GAMEDOCK_ADMIN_PASSWORD_CONFIRM; echo
        if [[ "${GAMEDOCK_ADMIN_PASSWORD}" == "${GAMEDOCK_ADMIN_PASSWORD_CONFIRM}" && "${#GAMEDOCK_ADMIN_PASSWORD}" -ge 10 ]]; then
          break
        fi
        echo "Passwords didn't match or were shorter than 10 characters - try again." >&2
      done
    else
      echo "No GAMEDOCK_ADMIN_PASSWORD set and running non-interactively - skipping admin creation." >&2
      GAMEDOCK_CREATE_ADMIN=n
    fi
  fi
  if [[ "${GAMEDOCK_CREATE_ADMIN}" == y ]]; then
    if sudo -u "${GAMEDOCK_USER}" env CI=true pnpm --dir "${APP_DIR}" gamedock user:create-admin "${GAMEDOCK_ADMIN_USER}" <<EOF2
${GAMEDOCK_ADMIN_PASSWORD}
${GAMEDOCK_ADMIN_PASSWORD}
EOF2
    then
      echo "Admin user '${GAMEDOCK_ADMIN_USER}' created."
    else
      echo "WARNING: admin user creation failed - create one manually, see below." >&2
    fi
  fi
fi

echo
echo "==> Done."
if [[ "${GAMEDOCK_SETUP_NGINX}" == y ]]; then
  echo "    URL: https://${GAMEDOCK_DOMAIN}"
else
  echo "    URL: http://${GAMEDOCK_PUBLIC_HOST}:${GAMEDOCK_PORT}$( [[ "${GAMEDOCK_BIND_ALL}" != y ]] && echo ' (only reachable from this host - re-run and opt into binding 0.0.0.0, or put a proxy in front)' )"
fi
if [[ "${GAMEDOCK_CREATE_ADMIN}" != y ]]; then
  echo "    Create an admin user: sudo -u ${GAMEDOCK_USER} env CI=true pnpm --dir ${APP_DIR} gamedock user:create-admin <username>"
fi
echo "    Logs: journalctl -u gamedock -f"
echo "    Optional: a Discord bot for self-service server requests - sudo bash scripts/install-discord-bot.sh (see docs/DISCORD_BOT.md)"
