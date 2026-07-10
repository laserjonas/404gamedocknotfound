# Deployment & operations

This document covers running GameDock in production. For the initial host setup
see [INSTALL_DEBIAN.md](INSTALL_DEBIAN.md).

## Architecture

A single Node.js process (`apps/api/dist/index.js`) provides:

- the REST API and server-sent event streams,
- the process manager that supervises game servers as child processes,
- the job runner for installs/updates/backups/restores,
- static serving of the built web UI.

State lives in SQLite (`/var/lib/gamedock/gamedock.sqlite`), game files under
`/var/lib/gamedock/instances/<instance-id>/`, backups under
`/var/lib/gamedock/backups/<instance-id>/`, console logs under
`/var/log/gamedock/instances/`.

Game server uptime is independent of the API process: each instance runs as a
detached child (its own process group, stdout/stderr going straight to files,
console input via a named pipe) that keeps running when the API restarts -
self-update, a crash, or `systemctl restart gamedock` no longer take down
every hosted game server. On the next start, GameDock checks whether each
previously-running instance's process is still alive (matching `/proc/<pid>/exe`
against the expected executable) and reattaches to it instead of restarting it.
This relies on the systemd unit's `KillMode=process` (only the tracked API pid
is signaled, never the whole cgroup) - **do not change it to `mixed` or
`control-group`**, that would kill every running game server on every restart.
Instances flagged _auto-start_ are only started fresh if they weren't already
running.

## Configuration reference

All configuration is via environment variables, loaded from `/opt/gamedock/.env`
by systemd (`EnvironmentFile`).

| Variable                           | Default                       | Description                                                                                                                                      |
| ---------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GAMEDOCK_HOST`                    | `127.0.0.1`                   | Bind address. Keep loopback behind a proxy.                                                                                                      |
| `GAMEDOCK_PORT`                    | `8340`                        | HTTP port.                                                                                                                                       |
| `GAMEDOCK_DATA_DIR`                | `./data`                      | Data directory (DB, user templates, logs).                                                                                                       |
| `GAMEDOCK_INSTANCE_DIR`            | `<data>/instances`            | Game server files.                                                                                                                               |
| `GAMEDOCK_BACKUP_DIR`              | `<data>/backups`              | Backup archives.                                                                                                                                 |
| `GAMEDOCK_DATABASE_URL`            | `sqlite:gamedock.sqlite`      | Only `sqlite:` URLs supported. Relative paths resolve inside the data dir.                                                                       |
| `GAMEDOCK_SESSION_SECRET`          | –                             | Required in production, ≥ 32 chars.                                                                                                              |
| `GAMEDOCK_STEAMCMD_PATH`           | `steamcmd`                    | Path to steamcmd (`/usr/games/steamcmd` on Debian).                                                                                              |
| `GAMEDOCK_NODE_ENV`                | `development`                 | `production` enables strict checks.                                                                                                              |
| `GAMEDOCK_MAX_UPLOAD_MB`           | `512`                         | File manager upload limit.                                                                                                                       |
| `GAMEDOCK_SECURE_COOKIES`          | `false`                       | Set `true` behind TLS (forced on in production).                                                                                                 |
| `GAMEDOCK_APP_DIR`                 | process cwd                   | Directory the "Update" button replaces in place. Set to `/opt/gamedock`.                                                                         |
| `GAMEDOCK_UPDATE_REPO_URL`         | _(empty)_                     | Git repo the "Update" button pulls from. Empty disables self-update.                                                                             |
| `GAMEDOCK_UPDATE_BRANCH`           | `main`                        | Branch to track.                                                                                                                                 |
| `GAMEDOCK_LOG_LEVEL`               | `info` (prod) / `debug` (dev) | Initial log level. Overridden by whatever was last set on the Logs page (persisted in the DB), which takes effect immediately without a restart. |
| `GAMEDOCK_AUDIT_RETENTION_DAYS`    | `180`                         | Audit log entries older than this are pruned once a day. `0` keeps everything forever.                                                           |
| `GAMEDOCK_INSTANCE_USER_ISOLATION` | `false`                       | Run each game server as its own dedicated Linux user (see "Per-instance user isolation" below). Requires one-time manual setup first.            |

## Updating GameDock

The **Update** card on the Settings page (admin only) is the normal way to update:
it clones `GAMEDOCK_UPDATE_REPO_URL` at `GAMEDOCK_UPDATE_BRANCH`, runs `pnpm
install`/`pnpm -r build` in a scratch directory under the data dir, rsyncs the
result into `GAMEDOCK_APP_DIR` (preserving `.env`), then exits so systemd
(`Restart=always`) brings it back up on the new build. It runs as the unprivileged
`gamedock` user - no SSH access or root needed for routine updates, and nothing
is touched in place until the clone+build has already succeeded.

Manual/SSH deploy is still how you bootstrap a fresh host (before the update
button has anything to work from) or recover if self-update itself is broken:

```bash
cd /path/to/checkout
git pull
sudo bash scripts/install.sh    # rebuilds, syncs /opt/gamedock, restarts service
```

`install.sh` is idempotent and safe to re-run: it never overwrites an existing
`/opt/gamedock/.env`, and skips prompts for anything already answered by an
environment variable (see [INSTALL_DEBIAN.md](INSTALL_DEBIAN.md)). Database
migrations run automatically at service start either way.

**One-time root step when updating to v0.16.0 or later** (self-update cannot
change root-owned files): re-run `sudo bash scripts/install.sh` once. It
applies three host-level changes shipped in 0.16.0 - `LimitNOFILE=100000` in
the systemd unit (ARK needs it), the isolation helper moving to
`/usr/local/sbin/gamedock-instance-user` with the sudoers rule following it
(security fix: the old in-app location became gamedock-writable after any
self-update), and the `clusterdir` helper subcommand that shared ARK-style
cluster directories need under user isolation.

## Running in Docker

An alternative to the bare-metal install above: `docker compose up -d` builds
the image from the included `Dockerfile` and starts GameDock with its data
and log directories on named volumes. You still need to set
`GAMEDOCK_SESSION_SECRET` (the container refuses to start in production
without one - see `docker-compose.yml` for exactly what to set and how to
generate it) and create the first admin user via
`docker compose exec gamedock node apps/api/dist/cli/index.js user:create-admin`.

The tradeoff versus bare metal: game server processes run inside the
container's network namespace, so each instance's ports need to be published
through Docker (or the container run with `network_mode: host`) - there's no
code difference, it's purely a networking/port-mapping question per game
you host. Everything else (SteamCMD, backups, the update button, Minecraft's
auto-provisioned JDKs, game servers surviving an update/restart) works the
same either way - the image runs `tini` as PID 1 specifically so detached
game server processes aren't killed by the kernel when the Node process
restarts inside the container.

## Service management

```bash
systemctl status gamedock
journalctl -u gamedock -f          # structured JSON logs
sudo systemctl restart gamedock    # restarts the panel; game servers keep running
```

Existing installs deployed before this behavior was added need one manual,
one-time root step to pick up the `KillMode=process` change (self-update
can't touch the systemd unit itself - it's outside `/opt/gamedock` and owned
by root):

```bash
sudo cp /opt/gamedock/scripts/systemd/gamedock.service /etc/systemd/system/gamedock.service
sudo systemctl daemon-reload
```

The admin-only **Logs** page in the UI mirrors the same structured log stream
live (with a level filter and a runtime-adjustable log level, no restart
needed) - useful when you don't have SSH access handy, but `journalctl` is
still the source of truth for anything that happened before the in-memory
buffer's ~2000-line window.

## Per-instance user isolation (bare metal only, opt-in)

Each game server can run as its own dedicated, unprivileged Linux user
instead of sharing `gamedock` with every other instance - see
`docs/SECURITY.md` "Process isolation" for the full design and the trade-off
it accepts (`NoNewPrivileges=false`, a narrowly-scoped `sudo` rule). Not
available in the Docker deployment.

First update GameDock itself to a version that includes this feature (the
Update button, as usual). Enabling it then needs a one-time manual root step,
since self-update never touches root-owned files (`/etc/sudoers.d/`, the
systemd unit):

```bash
cd /opt/gamedock
sudo bash scripts/install.sh   # installs the sudoers rule + helper script,
                                # and picks up NoNewPrivileges=false
```

**Stop every running instance first.** Migrating a currently-running
instance breaks it: reattachment for an isolated instance matches by uid, so
on the next restart GameDock would see the still-running (old,
`gamedock`-owned) process, conclude it doesn't match the newly-expected
dedicated user, mark the instance "stopped" despite the real process being
alive, and then spawn a second, duplicate process the next time you hit
Start - two processes fighting over the same port and save files. The
migration command refuses (skips, with a warning) any instance whose status
isn't stopped, but stop them via the UI first regardless.

Then enable it and provision existing (stopped) instances:

```bash
echo 'GAMEDOCK_INSTANCE_USER_ISOLATION=true' | sudo tee -a /opt/gamedock/.env
sudo systemctl restart gamedock
sudo -u gamedock bash -c 'cd /opt/gamedock && pnpm gamedock instances:migrate-user-isolation --dry-run'
sudo -u gamedock bash -c 'cd /opt/gamedock && pnpm gamedock instances:migrate-user-isolation'
```

The migration command is idempotent and safe to re-run - it only touches
stopped instances that don't have a dedicated user yet. Start each migrated
instance from the UI afterward to pick up its new user. New instances
created after `GAMEDOCK_INSTANCE_USER_ISOLATION=true` is set get one
automatically.

## Backups of GameDock itself

Back up these paths off-host (instance backups made in the UI live in the backup
dir too):

```
/opt/gamedock/.env
/var/lib/gamedock/gamedock.sqlite
/var/lib/gamedock/instances/
/var/lib/gamedock/backups/
```

SQLite uses WAL mode; for a consistent DB copy stop the service or use
`sqlite3 gamedock.sqlite ".backup /tmp/gamedock.sqlite"`.

## Resource planning

| Game             | Disk   | RAM (typical)                     |
| ---------------- | ------ | --------------------------------- |
| Valheim          | ~2 GB  | 2–4 GB                            |
| Project Zomboid  | ~5 GB  | 4–8 GB                            |
| Rust             | ~30 GB | 8–16 GB                           |
| Counter-Strike 2 | ~35 GB | 2–4 GB                            |
| Palworld         | ~10 GB | 8–16 GB                           |
| Terraria         | ~1 GB  | 1–2 GB                            |
| Minecraft Java   | ~1 GB  | 2–8 GB (heap via MIN_RAM/MAX_RAM) |
| Factorio         | ~2 GB  | 2–4 GB                            |

The job queue runs at most 2 jobs concurrently to avoid saturating disk/network
with parallel Steam downloads.

## Reverse proxy notes

- SSE endpoints (`/api/events/stream`, `.../logs/stream`, `/api/jobs/:id/stream`)
  need buffering disabled and long read timeouts — the shipped nginx example does
  both.
- Set `client_max_body_size` to match `GAMEDOCK_MAX_UPLOAD_MB`.
- Caddy works out of the box: `reverse_proxy 127.0.0.1:8340` with `flush_interval -1`.
