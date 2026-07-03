# GameDock Manager

[![CI](https://github.com/laserjonas/404gamedocknotfound/actions/workflows/ci.yml/badge.svg)](https://github.com/laserjonas/404gamedocknotfound/actions/workflows/ci.yml)

Self-hosted, open-source game server management panel for Debian. Install, update,
start/stop, monitor and manage multiple dedicated game servers (Steam and non-Steam)
from a clean web interface.

> Inspired by the general concept of web-based game server panels, built from scratch
> with an original design and codebase.

## Features

- **Dashboard** — CPU / RAM / disk / network usage, running servers, recent events
- **Server instances** — create from templates, install/update via SteamCMD or direct
  download, start/stop/restart, kill (with confirmation), live console with command
  input, per-instance CPU/RAM usage
- **Game templates** — JSON-based, add new games without touching backend code.
  Starter templates: Valheim, Project Zomboid, Rust, Counter-Strike 2, Palworld,
  Terraria, Minecraft Java (with a version picker), Minecraft Modded (modpack
  server packs), Factorio, ARK: Survival Evolved, 7 Days to Die, Team Fortress 2,
  Left 4 Dead 2, Garry's Mod, Unturned, Satisfactory, Squad, Barotrauma,
  Insurgency: Sandstorm
- **Logs page** — runtime-adjustable log level (no restart) plus a live,
  filterable view of structured application logs, tagged by subsystem
- **File manager** — browse, edit, upload, delete files; strictly sandboxed to each
  instance directory
- **Backups** — `.tar.gz` archives with optional excludes, restore, delete
- **Jobs** — long-running installs/updates/backups run as tracked jobs with live logs
- **Users & roles** — admin / operator / viewer with role-based access control,
  optional per-user TOTP two-factor authentication and passkey (WebAuthn) login
- **Security** — bcrypt password hashing, session cookies + CSRF tokens, login
  rate limiting, audit log with automatic retention, path traversal protection,
  no shell command construction, never runs as root

## Stack

TypeScript everywhere. Fastify API + SQLite (Node.js 20+), React + Vite frontend,
pnpm monorepo.

```
apps/api                Fastify backend + process manager + CLI
apps/web                React web UI
packages/shared         Shared TypeScript types
packages/game-templates Game template schema + built-in templates
scripts/                Debian install script, systemd unit, nginx example
docs/                   Documentation
```

## Quick start (development)

```bash
pnpm install
pnpm -r build                # build shared packages once
cp .env.example .env
pnpm gamedock user:create-admin   # create your admin account
pnpm dev                     # starts API (:8340) and web dev server (:5173)
```

Open http://localhost:5173 and sign in.

## Production install (Debian 12/13)

```bash
sudo bash scripts/install.sh
```

One script, run once from a checkout of this repo: installs system dependencies
(including SteamCMD, if you want it), creates the `gamedock` user/directories,
builds and deploys the app, optionally sets up Nginx as a TLS reverse proxy
(asks for a domain name, and whether to use Let's Encrypt or a self-signed
certificate), and optionally creates the first admin user — by the time it
exits, the panel is up and running under systemd. Safe to re-run any time
(e.g. to add Nginx after the fact, or as a recovery path). Full guide:
[docs/INSTALL_DEBIAN.md](docs/INSTALL_DEBIAN.md).

## Documentation

- [Installation on Debian](docs/INSTALL_DEBIAN.md)
- [Deployment & operations](docs/DEPLOYMENT.md)
- [Security notes](docs/SECURITY.md)
- [Game templates](docs/GAME_TEMPLATES.md)
- [REST API](docs/API.md)
- [Roadmap](docs/ROADMAP.md)

## CLI

```bash
pnpm gamedock user:create-admin      # create the first admin
pnpm gamedock user:reset-password    # reset a password
pnpm gamedock doctor                 # check dependencies & config
pnpm gamedock instances:list         # list instances
pnpm gamedock repair-permissions     # tighten data dir permissions
```

## Development commands

```bash
pnpm dev          # API + web with hot reload
pnpm build        # build all packages
pnpm typecheck    # TypeScript checks
pnpm lint         # ESLint
pnpm test         # unit tests (path safety, templates, command construction)
pnpm format       # Prettier
```

## Legal note on game servers

GameDock only downloads server files through official distribution channels
(SteamCMD, official vendor download URLs). You are responsible for accepting the
respective licenses/EULAs of each game server you install (e.g. the Minecraft EULA).

## License

MIT
