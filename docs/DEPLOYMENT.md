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

Because the process manager runs in the daemon, **stopping the service stops the
game servers** (gracefully; systemd waits up to 90 s). Instances flagged
_auto-start_ are started again when the service comes back up. The design keeps a
clean seam (`ProcessManager` interface) to move to per-instance systemd units later.

## Configuration reference

All configuration is via environment variables, loaded from `/opt/gamedock/.env`
by systemd (`EnvironmentFile`).

| Variable                  | Default                  | Description                                                                |
| ------------------------- | ------------------------ | -------------------------------------------------------------------------- |
| `GAMEDOCK_HOST`           | `127.0.0.1`              | Bind address. Keep loopback behind a proxy.                                |
| `GAMEDOCK_PORT`           | `8340`                   | HTTP port.                                                                 |
| `GAMEDOCK_DATA_DIR`       | `./data`                 | Data directory (DB, user templates, logs).                                 |
| `GAMEDOCK_INSTANCE_DIR`   | `<data>/instances`       | Game server files.                                                         |
| `GAMEDOCK_BACKUP_DIR`     | `<data>/backups`         | Backup archives.                                                           |
| `GAMEDOCK_DATABASE_URL`   | `sqlite:gamedock.sqlite` | Only `sqlite:` URLs supported. Relative paths resolve inside the data dir. |
| `GAMEDOCK_SESSION_SECRET` | –                        | Required in production, ≥ 32 chars.                                        |
| `GAMEDOCK_STEAMCMD_PATH`  | `steamcmd`               | Path to steamcmd (`/usr/games/steamcmd` on Debian).                        |
| `GAMEDOCK_NODE_ENV`       | `development`            | `production` enables strict checks.                                        |
| `GAMEDOCK_MAX_UPLOAD_MB`  | `512`                    | File manager upload limit.                                                 |
| `GAMEDOCK_SECURE_COOKIES` | `false`                  | Set `true` behind TLS (forced on in production).                           |

## Updating GameDock

```bash
cd /path/to/checkout
git pull
sudo bash scripts/deploy.sh     # rebuilds, syncs /opt/gamedock, restarts service
```

`deploy.sh` never overwrites an existing `/opt/gamedock/.env`. Database migrations
run automatically at service start.

## Service management

```bash
systemctl status gamedock
journalctl -u gamedock -f          # structured JSON logs
sudo systemctl restart gamedock    # stops game servers gracefully, restarts them
```

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
