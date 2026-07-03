# syntax=docker/dockerfile:1

# GameDock Manager container image.
#
# The bare-metal install (scripts/install.sh) is still the right choice if you
# want game servers running directly on the host's network stack; this image
# is the alternative on-ramp for anyone who'd rather run GameDock (and
# optionally its game server instances - see docs/DEPLOYMENT.md for the
# tradeoffs) inside a container.

ARG NODE_VERSION=22

# ---------------------------------------------------------------------------
# Build stage: compiles TypeScript, bundles the web UI, then prunes back to
# production-only dependencies. Mirrors scripts/install.sh's build steps
# exactly, including the CI=true fix for pnpm's non-interactive purge guard.
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm AS build
RUN corepack enable
WORKDIR /app

COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm -r build
RUN CI=true pnpm install --frozen-lockfile --prod
RUN rm -rf apps/api/web-dist && cp -r apps/web/dist apps/api/web-dist

# ---------------------------------------------------------------------------
# Runtime stage: slim base + the system packages game server installs need
# (steamcmd, 32-bit compat libs, archive tools). Java is deliberately not
# baked in - Minecraft installs auto-download the exact JDK version they need
# at install time (see apps/api/src/services/javaRuntime.ts).
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime

RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates tar unzip xz-utils python3 tini \
      lib32gcc-s1 lib32stdc++6 \
    && rm -rf /var/lib/apt/lists/*

# Reuse the exact, already-proven install-steamcmd.sh (handles both the
# deb822 and classic apt sources formats) instead of re-deriving its logic.
COPY scripts/install-steamcmd.sh /tmp/install-steamcmd.sh
RUN bash /tmp/install-steamcmd.sh && rm -f /tmp/install-steamcmd.sh && rm -rf /var/lib/apt/lists/*

RUN useradd --system --create-home --home-dir /home/gamedock --shell /usr/sbin/nologin gamedock \
    && mkdir -p /var/lib/gamedock/instances /var/lib/gamedock/backups /var/lib/gamedock/templates \
       /var/lib/gamedock/runtimes /var/lib/gamedock/steamcmd-home /var/log/gamedock \
    && chown -R gamedock:gamedock /var/lib/gamedock /var/log/gamedock

WORKDIR /opt/gamedock
COPY --from=build --chown=gamedock:gamedock /app /opt/gamedock

ENV GAMEDOCK_HOST=0.0.0.0 \
    GAMEDOCK_PORT=8340 \
    GAMEDOCK_NODE_ENV=production \
    GAMEDOCK_DATA_DIR=/var/lib/gamedock \
    GAMEDOCK_STEAMCMD_PATH=/usr/games/steamcmd \
    HOME=/var/lib/gamedock/steamcmd-home

USER gamedock
EXPOSE 8340
VOLUME ["/var/lib/gamedock", "/var/log/gamedock"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "fetch('http://127.0.0.1:8340/api/system/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tini as PID 1: when the Node process exits (self-update, crash), Linux
# kills every other process in the container's pid namespace unless a real
# init process stays alive as PID 1 - detached game server processes (see
# processManager.ts) would otherwise never survive an update inside Docker.
ENTRYPOINT ["/usr/bin/tini", "--", "node", "apps/api/dist/index.js"]
