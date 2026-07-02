#!/usr/bin/env bash
#
# Installs SteamCMD on Debian via the official steamcmd package
# (non-free component). Run as root:
#   sudo bash scripts/install-steamcmd.sh
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "This script must run as root" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

echo "==> Enabling i386 and non-free repositories"
dpkg --add-architecture i386

# Debian 12+: components live in /etc/apt/sources.list.d/debian.sources (deb822)
# or the classic /etc/apt/sources.list. Either way, the existing component list
# may already include e.g. "non-free-firmware" (default since Debian 12), so we
# add "contrib" / "non-free" next to the "main" token instead of assuming the
# line ends with a bare "main".
if [[ -f /etc/apt/sources.list.d/debian.sources ]]; then
  sed -i -E '/^Components:/ { /\bcontrib\b/! s/\bmain\b/main contrib non-free/ }' \
    /etc/apt/sources.list.d/debian.sources
fi
if [[ -f /etc/apt/sources.list ]]; then
  sed -i -E '/^deb(-src)?[[:space:]]/ { /\bcontrib\b/! s/\bmain\b/main contrib non-free/ }' \
    /etc/apt/sources.list
fi

apt-get update

echo "==> Pre-accepting the Steam license"
echo steam steam/question select "I AGREE" | debconf-set-selections
echo steam steam/license note '' | debconf-set-selections

echo "==> Installing steamcmd"
apt-get install -y steamcmd

STEAMCMD_PATH="$(command -v steamcmd || echo /usr/games/steamcmd)"
echo
echo "==> steamcmd installed at: ${STEAMCMD_PATH}"
echo "    Set in /opt/gamedock/.env:  GAMEDOCK_STEAMCMD_PATH=${STEAMCMD_PATH}"
