# Installing GameDock Manager on Debian

Target: Debian 12 (bookworm) or 13 (trixie), amd64, with root access.
GameDock itself runs as the unprivileged `gamedock` user — root is only used for
the initial system setup.

## 1. System dependencies

From a checkout of this repository:

```bash
sudo bash scripts/install.sh
```

This installs:

- Node.js 22 LTS (NodeSource) and pnpm
- `tar`, `unzip`, `xz-utils` (backups and non-Steam installers)
- `lib32gcc-s1`, `lib32stdc++6` (required by SteamCMD)
- OpenJDK 21 (or 17) headless (Minecraft Java servers)
- Creates the `gamedock` system user (nologin shell)
- Creates the directory layout:

```
/opt/gamedock                 application
/var/lib/gamedock             data dir (SQLite DB, user templates)
/var/lib/gamedock/instances   one folder per game server instance
/var/lib/gamedock/backups     backup archives
/var/lib/gamedock/runtimes    auto-downloaded JDKs (shared across instances)
/var/lib/gamedock/steamcmd-home  writable $HOME for SteamCMD (see step 2)
/var/log/gamedock             logs (incl. per-instance console logs)
```

## 2. SteamCMD (for Steam-based games)

```bash
sudo bash scripts/install-steamcmd.sh
```

This enables the i386 architecture and the `non-free` component, pre-accepts the
Steam license prompt and installs the `steamcmd` package. On Debian, the binary is
at `/usr/games/steamcmd` — the deploy script writes this into `.env` automatically
(`GAMEDOCK_STEAMCMD_PATH`).

Verify: `sudo -u gamedock /usr/games/steamcmd +quit` should download updates and exit.

SteamCMD writes its own config/state under `$HOME`. Because the systemd unit masks
the `gamedock` user's real home directory read-only (`ProtectHome=read-only`),
`install.sh` points `HOME` at `/var/lib/gamedock/steamcmd-home` instead (via the
unit's `Environment=` line) — no action needed, but if you see SteamCMD fail with
`Missing configuration`, check that directory exists and is owned by `gamedock`.

## 3. Deploy the application

```bash
sudo bash scripts/deploy.sh
```

The script:

1. runs `pnpm install` and builds all packages,
2. copies the app to `/opt/gamedock` and installs production dependencies,
3. creates `/opt/gamedock/.env` with a random session secret (first run only),
4. installs and starts the `gamedock` systemd service.

Check status and logs:

```bash
systemctl status gamedock
journalctl -u gamedock -f
```

## 4. Create the first admin user

```bash
sudo -u gamedock bash -c 'cd /opt/gamedock && pnpm gamedock user:create-admin'
```

You will be prompted for a username and password (min. 10 characters, hidden input).

## 5. Reverse proxy with TLS (strongly recommended)

The panel binds to `127.0.0.1:8340` and is **not reachable from outside** by
default — this is intentional. Expose it only through a TLS reverse proxy:

```bash
sudo apt install nginx certbot python3-certbot-nginx
sudo cp /opt/gamedock/scripts/nginx/gamedock.conf.example /etc/nginx/sites-available/gamedock
# edit server_name, then:
sudo ln -s /etc/nginx/sites-available/gamedock /etc/nginx/sites-enabled/
sudo certbot --nginx -d panel.example.com
sudo systemctl reload nginx
```

Then set `GAMEDOCK_SECURE_COOKIES=true` in `/opt/gamedock/.env` and restart:
`sudo systemctl restart gamedock`.

## 6. Firewall notes

With `ufw` (adapt ports to the games you host — each template lists its ports,
and the Server → Settings tab shows them per instance):

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp 443/tcp        # panel via nginx
sudo ufw allow 2456:2457/udp         # example: Valheim
sudo ufw allow 25565/tcp             # example: Minecraft
sudo ufw enable
```

Never open `8340` to the internet directly; keep the panel behind the proxy.

## 7. Development setup

```bash
pnpm install
pnpm -r build          # builds shared packages (required once before dev/test)
cp .env.example .env
pnpm gamedock user:create-admin
pnpm dev               # API on :8340, Vite dev server on :5173 (proxies /api)
```

Windows/macOS note: the panel UI, API and non-Steam features run anywhere Node.js
runs, but the game templates target Linux servers — actual game server installs are
expected to run on the Debian host.

## Troubleshooting

| Symptom                                                         | Fix                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `steamcmd not found` in install jobs                            | Install SteamCMD (step 2) and set `GAMEDOCK_STEAMCMD_PATH=/usr/games/steamcmd` in `.env`, restart the service.                                                                                                                                                                                                                                                                             |
| SteamCMD: `Failed to install app 'NNN' (Missing configuration)` | SteamCMD couldn't write its own config to `$HOME` (masked read-only by the systemd unit's `ProtectHome`). Confirm `/var/lib/gamedock/steamcmd-home` exists and is owned by `gamedock` (created by `install.sh`; re-run it if upgrading from an older checkout), then restart the service.                                                                                                  |
| SteamCMD exits with code 8 / disk errors                        | Check free disk space; Rust/CS2 need 30-40 GB. `df -h /var/lib/gamedock`                                                                                                                                                                                                                                                                                                                   |
| Valheim starts then exits immediately                           | Password must be ≥ 5 chars and different from the server name. Check the console tab.                                                                                                                                                                                                                                                                                                      |
| Minecraft exits with EULA message                               | Set the `ACCEPT_EULA` variable to `true` in Server → Settings (this accepts the Minecraft EULA), then start again.                                                                                                                                                                                                                                                                         |
| Minecraft: `UnsupportedClassVersionError`                       | The selected version needs a newer Java than what's running it. This shouldn't happen any more - GameDock now auto-downloads the matching JDK per version (see [GAME_TEMPLATES.md](GAME_TEMPLATES.md#dynamic-version-resolution-urlinstallresolver)); if you still hit this, click **Update files** once to re-resolve, or check `/var/lib/gamedock/runtimes` was created and is writable. |
| `unzip: command not found` (Terraria)                           | `sudo apt install unzip`                                                                                                                                                                                                                                                                                                                                                                   |
| Factorio: "no saves found"                                      | Create a save once: Settings → override startup args to `--create ./factorio/saves/world.zip`, start once, then restore the defaults.                                                                                                                                                                                                                                                      |
| Web UI 404 after manual build                                   | Build the frontend: `pnpm --filter @gamedock/web build`, and re-run deploy so `apps/api/web-dist` exists.                                                                                                                                                                                                                                                                                  |
| Permission errors under `/var/lib/gamedock`                     | `sudo chown -R gamedock:gamedock /var/lib/gamedock` and `pnpm gamedock repair-permissions`.                                                                                                                                                                                                                                                                                                |
