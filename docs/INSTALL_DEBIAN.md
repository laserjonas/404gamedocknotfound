# Installing GameDock Manager on Debian

Target: Debian 12 (bookworm) or 13 (trixie), amd64, with root access.
GameDock itself runs as the unprivileged `gamedock` user — root is only used for
the initial system setup.

## 1. Run the install script

From a checkout of this repository:

```bash
sudo bash scripts/install.sh
```

This single script does everything needed to get a running panel:

- System packages: Node.js 22 LTS (NodeSource) + pnpm, `tar`/`unzip`/`xz-utils`
  (backups and non-Steam installers), `lib32gcc-s1`/`lib32stdc++6` (required by
  SteamCMD), OpenJDK 21 or 17 headless (Minecraft Java servers), `openssl`.
- Asks whether to install **SteamCMD** (needed for Steam-based games - Valheim,
  Rust, CS2, ...); answering yes enables the i386 architecture and `non-free`
  component and installs it, same as running `install-steamcmd.sh` directly.
- Creates the `gamedock` system user (nologin shell) and the directory layout:

  ```
  /opt/gamedock                    application
  /var/lib/gamedock                data dir (SQLite DB, user templates)
  /var/lib/gamedock/instances      one folder per game server instance
  /var/lib/gamedock/backups        backup archives
  /var/lib/gamedock/runtimes       auto-downloaded JDKs (shared across instances)
  /var/lib/gamedock/steamcmd-home  writable $HOME for SteamCMD
  /var/log/gamedock                logs (incl. per-instance console logs)
  ```

- Asks whether to set up **Nginx as a TLS reverse proxy**. If yes: asks for the
  domain name GameDock will be reached at, and whether to get a free Let's
  Encrypt certificate (needs that domain's public DNS already pointing here,
  and ports 80/443 reachable from the internet) or generate a self-signed
  certificate instead (for a private/LAN/test network - browsers will warn
  once until you accept it). Either way it writes
  `/etc/nginx/sites-available/gamedock`, sets `GAMEDOCK_PUBLIC_ORIGIN` and
  `GAMEDOCK_SECURE_COOKIES=true` in `.env` to match, and opens 80/443 in `ufw`
  if it's active. If you decline, it asks what hostname/IP you'll reach the
  panel at directly instead (used only to validate logins) and whether to
  bind on all interfaces (`0.0.0.0`) without a proxy.

  **Passkey (WebAuthn) login needs a real hostname - a bare IP address does
  not work, even over HTTPS.** This is a browser/spec limitation, not a
  GameDock restriction (see [SECURITY.md](SECURITY.md)). If you don't have
  real DNS for a private network, pick a name like `gamedock.local` and add
  it to each client's hosts file (the script prints the exact line and IP to
  use if it detects the name isn't publicly resolvable).

- Builds the app (`pnpm install` + `pnpm -r build`), copies it to
  `/opt/gamedock`, installs production dependencies, creates `/opt/gamedock/.env`
  with a random session secret (first run only - an existing `.env` is never
  touched), and installs/starts the `gamedock` systemd service.
- Asks whether to create the first admin user now (prompts for username and
  password, min. 10 characters, hidden input).

Every prompt can be pre-answered with an environment variable for unattended
installs (e.g. `GAMEDOCK_SETUP_NGINX=y GAMEDOCK_DOMAIN=panel.example.com sudo -E
bash scripts/install.sh`) - see the comments at the top of the script for the
full list. **Safe to re-run**: every step is idempotent, so this is also the
recovery path if a manual redeploy is ever needed (existing users, directories,
`.env` and certificates are left alone or refreshed in place, never duplicated).

Check status and logs:

```bash
systemctl status gamedock
journalctl -u gamedock -f
```

If you skipped admin creation, or need another admin later:

```bash
sudo -u gamedock env CI=true pnpm --dir /opt/gamedock gamedock user:create-admin <username>
```

## 2. Firewall notes

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

## 3. Development setup

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
| `steamcmd not found` in install jobs                            | Install it with `sudo bash scripts/install-steamcmd.sh` (or re-run `install.sh` and answer yes) and set `GAMEDOCK_STEAMCMD_PATH=/usr/games/steamcmd` in `.env`, restart the service.                                                                                                                                                                                                      |
| SteamCMD: `Failed to install app 'NNN' (Missing configuration)` | SteamCMD couldn't write its own config to `$HOME` (masked read-only by the systemd unit's `ProtectHome`). Confirm `/var/lib/gamedock/steamcmd-home` exists and is owned by `gamedock` (created by `install.sh`; re-run it if upgrading from an older checkout), then restart the service.                                                                                                  |
| SteamCMD exits with code 8 / disk errors                        | Check free disk space; Rust/CS2 need 30-40 GB. `df -h /var/lib/gamedock`                                                                                                                                                                                                                                                                                                                   |
| Valheim starts then exits immediately                           | Password must be ≥ 5 chars and different from the server name. Check the console tab.                                                                                                                                                                                                                                                                                                      |
| Minecraft exits with EULA message                               | Set the `ACCEPT_EULA` variable to `true` in Server → Settings (this accepts the Minecraft EULA), then start again.                                                                                                                                                                                                                                                                         |
| Minecraft: `UnsupportedClassVersionError`                       | The selected version needs a newer Java than what's running it. This shouldn't happen any more - GameDock now auto-downloads the matching JDK per version (see [GAME_TEMPLATES.md](GAME_TEMPLATES.md#dynamic-version-resolution-urlinstallresolver)); if you still hit this, click **Update files** once to re-resolve, or check `/var/lib/gamedock/runtimes` was created and is writable. |
| `unzip: command not found` (Terraria)                           | `sudo apt install unzip`                                                                                                                                                                                                                                                                                                                                                                   |
| Factorio: "no saves found"                                      | Create a save once: Settings → override startup args to `--create ./factorio/saves/world.zip`, start once, then restore the defaults.                                                                                                                                                                                                                                                      |
| Web UI 404 after manual build                                   | Build the frontend: `pnpm --filter @gamedock/web build`, and re-run `sudo bash scripts/install.sh` so `apps/api/web-dist` exists.                                                                                                                                                                                                                                                          |
| Permission errors under `/var/lib/gamedock`                     | `sudo chown -R gamedock:gamedock /var/lib/gamedock` and `pnpm gamedock repair-permissions`.                                                                                                                                                                                                                                                                                                |
| Update button says "not configured"                             | Set `GAMEDOCK_UPDATE_REPO_URL` (and `GAMEDOCK_UPDATE_BRANCH` if not `main`) in `/opt/gamedock/.env`, then `sudo systemctl restart gamedock`.                                                                                                                                                                                                                                               |
| Update job fails on `git clone` / `pnpm install`                | Check the VM has outbound internet access to the git host and registry; the job log (Settings → Application updates) shows the exact command and its output.                                                                                                                                                                                                                               |
| Service doesn't come back after an update                       | Check `journalctl -u gamedock -n 100`; if the build itself was bad, redeploy a known-good commit manually (see [DEPLOYMENT.md](DEPLOYMENT.md#updating-gamedock)) - self-update never overwrites the running app until its own build succeeds, so this should be rare.                                                                                                                      |
