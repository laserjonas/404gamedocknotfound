# GameDock Manager

Self-hosted game server management panel (like Pterodactyl/Crafty, but simpler).
Deployed at `192.168.178.106` (Debian VM, systemd service `gamedock`, unprivileged
`gamedock` user, app at `/opt/gamedock`, data at `/var/lib/gamedock`).

Monorepo: pnpm workspaces + TypeScript, Node >= 20.

## Layout

- `apps/api` — Fastify backend. `src/routes/*` (HTTP), `src/services/*` (business
  logic: process management, steamcmd, url installers, backups, jobs, self-update,
  java runtime provisioning), `src/db/repositories/*` (SQLite via better-sqlite3,
  raw SQL, no ORM), `src/db/migrations.ts` (plain numbered SQL migrations, run at
  startup).
- `apps/web` — React + Vite frontend, plain CSS (`src/styles.css`), no component
  library. Pages in `src/pages/`.
- `packages/shared` — DTO/type definitions shared between api and web.
- `packages/game-templates` — one JSON file per supported game
  (`templates/*.json`): install method (steamcmd app id, or generic `url` +
  archive), start/stop commands, variables, ports. Adding a game = adding a
  template JSON, usually no code changes. See `docs/GAME_TEMPLATES.md`.
- `scripts/` — `install.sh` (single-script Debian bootstrap: system deps,
  `gamedock` user/directories, build + rsync to `/opt/gamedock`, optional
  Nginx+TLS reverse proxy with a domain prompt, optional first-admin
  creation — safe to re-run, see below), `install-steamcmd.sh` (also called
  automatically from `install.sh` unless declined), `systemd/gamedock.service`.
- `docs/` — INSTALL_DEBIAN.md, DEPLOYMENT.md, API.md, GAME_TEMPLATES.md,
  SECURITY.md, ROADMAP.md (backlog of larger not-yet-scheduled items). Keep
  these in sync with routes/config/templates when they change.

## Commands

```
pnpm install
pnpm -r build       # required once before dev/test — packages/shared etc. must be built
pnpm dev            # api :8340, vite :5173 (proxies /api)
pnpm test           # vitest, per-package
pnpm typecheck
pnpm lint
```

## Conventions

- No ORM: repositories are hand-written SQL against better-sqlite3.
- Long-running work (installs, updates, backups, restores, self-update) goes
  through the job queue (`JobService`/`JobRepository`), not ad-hoc async calls —
  jobs stream logs over SSE and are visible in the Jobs UI.
- New templates: add JSON to `packages/game-templates/templates/`, add its id to
  the built-in-templates list in `packages/game-templates/src/index.test.ts`.
- Steam-only games that require a non-anonymous Steam account (subscription/
  ownership) are out of scope — GameDock never stores Steam credentials.
- Minecraft Java installs auto-resolve the required JDK major version per
  Mojang version metadata and download it from Adoptium (`javaRuntime.ts`) —
  don't hardcode a Java version.
- Version number lives in root `package.json`; bump it (all 5 package.json files
  currently kept in sync) when shipping a user-visible change, exposed via
  `/api/system/health` and the web header.

## Deployment / update policy

- Every change gets committed and pushed to
  `https://github.com/laserjonas/404gamedocknotfound.git` (branch `main`)
  automatically — no need to ask before pushing.
- GameDock has an in-app self-update (Settings → Application updates, admin
  only): clones the repo, builds, rsyncs into `/opt/gamedock` in place, then
  exits so systemd (`Restart=always`) restarts it on the new build. This runs
  as the unprivileged service user (no SSH/root).
- **Do not SSH-deploy routine changes to the VM.** The user triggers updates
  themselves via the Update button. `scripts/install.sh` / manual SSH is only for
  bootstrapping a fresh host or recovering a broken self-update — treat it as a
  last resort, not the default path, and confirm with the user first.
