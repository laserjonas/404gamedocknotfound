# Discord bot: self-service server requests

An optional, opt-in companion service (`apps/discord-bot`) that lets members
of your Discord server request a GameDock game server for themselves,
limited by their Discord role - how many servers, and which games, is
configured per role. It's a separate process from the main GameDock panel,
talking to it purely through the REST API with one admin-level API token.

**Scope, by design**: this is request-only. `/request-server` creates and
installs a server; managing it afterwards (start/stop/delete/settings)
still happens in the GameDock web UI by an admin or operator. There's no
`/my-servers`, `/stop`, or self-service `/delete`.

## How it works

- A member runs `/request-server`, picks a game from an autocomplete list
  (filtered to what their Discord role allows).
- The bot checks their role against configured quotas, checks how many
  active requests they already have, and - if within limits - creates the
  instance in GameDock and kicks off the install, reporting progress back
  in Discord as it runs.
- Quotas are configured per Discord role by anyone with the **Manage
  Server** permission, using `/gamedock-config` - no restart needed.
- The bot keeps its own small SQLite database (which Discord user requested
  which instance, and the configured role quotas) - GameDock itself has no
  concept of instance ownership, so this tracking exists entirely on the
  bot's side. Every 15 minutes (configurable) the bot checks GameDock's real
  instance list and frees up a user's quota slot if an admin deleted their
  instance directly in the web UI instead of through the bot.
- GameDock's self-update (Settings -> Application updates) rebuilds and
  redeploys every workspace package, including this bot - but it only
  restarts the main API process, since it has no way of knowing a separate
  `gamedock-discord-bot` systemd unit exists. Every 5 minutes (configurable)
  the bot checks GameDock's reported commit and restarts itself once it
  notices a change, so it picks up the freshly-deployed code too (its own
  systemd unit's `Restart=always` brings it back up). This only works for
  installs that actually deploy via self-update or `install.sh`'s rsync -
  see `RECONCILE_INTERVAL_MINUTES`'s sibling setting,
  `UPDATE_CHECK_INTERVAL_MINUTES`, in `.env.example`.

## Setup

### 1. Create a Discord application and bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
   and create a **New Application**.
2. Under **Bot**, click **Reset Token** to get your bot token (this is
   `DISCORD_BOT_TOKEN` - treat it as a secret).
3. Under **Bot**, make sure **Public Bot** is off unless you actually want
   strangers adding it to their own servers.

### 2. Invite the bot to your server

Under **OAuth2 -> URL Generator**, select scopes `bot` and
`applications.commands`, and under bot permissions select at least **Send
Messages** and **Use Slash Commands**. Open the generated URL and add the
bot to your server.

### 3. Gather IDs

Enable Discord's Developer Mode (User Settings -> Advanced), then
right-click your server's icon -> **Copy Server ID**. That's
`DISCORD_GUILD_ID`.

### 4. Create a GameDock API token for the bot

Sign in to GameDock as an **admin**, go to **Settings -> API tokens ->
Create a token**, and copy the token shown (it's only shown once). This is
`GAMEDOCK_API_TOKEN`.

**This token is admin-equivalent** - it can create, install, and manage any
instance on your panel, the same as the admin account that created it.
Treat it like a root credential (see `docs/SECURITY.md`).

### 5. Install and configure

On the GameDock host, after `scripts/install.sh` has already been run once:

```bash
sudo bash scripts/install-discord-bot.sh
```

This creates the bot's data directory and systemd unit, and copies
`apps/discord-bot/.env.example` to `apps/discord-bot/.env` if it doesn't
already exist. Edit that `.env` and fill in the values gathered above:

```
DISCORD_BOT_TOKEN=...
DISCORD_GUILD_ID=...
GAMEDOCK_API_URL=https://your-gamedock-url
GAMEDOCK_API_TOKEN=...
```

### 6. Start it

```bash
sudo systemctl start gamedock-discord-bot
journalctl -u gamedock-discord-bot -f
```

You should see "Logged in as ..." followed by "Slash commands registered."
Commands can take a minute to show up in Discord's UI the first time.

## Commands

| Command                                                                          | Who                           | What it does                                               |
| -------------------------------------------------------------------------------- | ----------------------------- | ---------------------------------------------------------- |
| `/request-server game:<autocomplete>`                                            | Anyone with a configured role | Creates + installs a server, subject to their role's quota |
| `/gamedock-config set-role-limit role:<role> max-servers:<n> games:<comma-list>` | Manage Server permission      | Sets (or updates) a role's quota                           |
| `/gamedock-config remove-role-limit role:<role>`                                 | Manage Server permission      | Removes a role's quota entirely                            |
| `/gamedock-config list`                                                          | Manage Server permission      | Lists all configured role quotas                           |

`games` is a comma-separated list of GameDock template ids (e.g.
`valheim,minecraft-java,rust`) - these match the `id` field from `GET
/api/templates` (see `docs/API.md`), which is also what the template
listing page in the GameDock UI is built from. Pass **`all`** instead of a
list to allow every game, including ones added to GameDock later.

### How multi-role quotas combine

If a member has more than one Discord role with a configured quota, the bot
uses the **single highest `max-servers`** value (not the sum - stacking
would let someone combine several roles into an unbounded limit) and the
**union** of allowed games across every matching role - if any matching
role is set to `all`, the member can request any game regardless of what
their other roles list.

## Troubleshooting

| Symptom                                                         | Fix                                                                                                                                                                                                            |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slash commands don't show up in Discord                         | Wait a minute (guild command registration isn't always instant), then check `journalctl -u gamedock-discord-bot` for a registration error. Confirm the bot was invited with the `applications.commands` scope. |
| `/request-server` says "you don't have a role set up"           | An admin needs to run `/gamedock-config set-role-limit` for that member's role first.                                                                                                                          |
| A request is stuck "Installing..." for a long time              | Some games (Steam-based, especially Rust/CS2) can take many minutes to download - check the job's real status in the GameDock web UI (Jobs page) if it's been longer than expected.                            |
| Someone's quota looks full even though their old server is gone | Reconciliation runs every `RECONCILE_INTERVAL_MINUTES` (default 15) - wait for the next pass, or restart the bot to run one immediately.                                                                       |
| `dist/index.js not found` when running `install-discord-bot.sh` | Run `scripts/install.sh` first (or re-run it) - it builds every workspace package, including this one.                                                                                                         |

## Security notes

See `docs/SECURITY.md`'s "Discord bot" section for the full picture: the
bot's GameDock API token is admin-equivalent, its own `.env` and systemd
unit are kept separate from the main app's, and it never receives sudo or
any host-level privilege (`NoNewPrivileges=true` in its systemd unit,
stricter than the main `gamedock.service`).
