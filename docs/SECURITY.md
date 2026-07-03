# Security notes

GameDock manages processes and files on your server, so its security posture
matters. This document describes what the app does to protect itself, and what you
must do as an operator.

## What GameDock does

### Authentication & sessions

- Passwords are hashed with **bcrypt (cost 12)**; plaintext is never stored or logged.
- Sessions are random 256-bit tokens stored **hashed (SHA-256)** in the database;
  the cookie is `HttpOnly`, `SameSite=Strict` and `Secure` in production.
- Every session carries a **CSRF token** that must be sent in the `x-csrf-token`
  header for all mutating requests (defense in depth on top of SameSite).
- Login attempts are throttled (5 failures / 15 min per IP+username) and use a
  constant-work dummy hash for unknown users to blunt user enumeration.
- Password changes and user disabling revoke all sessions of the affected user.

### Authorization (RBAC)

| Role       | Capabilities                                                                             |
| ---------- | ---------------------------------------------------------------------------------------- |
| `viewer`   | Read-only: dashboards, status, logs, files (read), backups (list)                        |
| `operator` | + start/stop/restart/kill, install/update, console commands, edit configs/files, backups |
| `admin`    | + create/delete instances, user management, audit log                                    |

The API enforces roles on every route; the UI merely hides what you cannot do.
The last active admin cannot be demoted, disabled or deleted.

### Command execution

- Game servers, SteamCMD and archive tools are always spawned with
  **argument arrays and `shell: false`** — user input can never be interpreted by
  a shell.
- Template variables are validated (length, control characters, optional anchored
  regex) before they are substituted into argument lists.
- Console commands are length-limited and control-character-filtered, and only
  reach servers whose template declares `console.supportsInput`.
- The web UI has **no arbitrary command execution** feature by design; startup
  "arguments" are stored as a list and never concatenated into a shell string.

### File access

- All file-manager paths are resolved with a traversal guard
  (`resolveSafePath`) that rejects `..` escapes, absolute paths, null bytes and
  backslash tricks, and confines access to the instance's own directory.
- Symbolic links are skipped in directory listings so links cannot lead outside
  the sandbox.
- The text editor refuses binary files and enforces a 2 MiB size limit; uploads are
  size-capped (`GAMEDOCK_MAX_UPLOAD_MB`).

### Process isolation

- The daemon refuses to start as root.
- Game processes receive a **minimal environment** (PATH, HOME, locale) plus the
  template/instance variables — GameDock secrets such as the session secret are
  never passed to game servers.
- The systemd unit applies hardening (`NoNewPrivileges`, `ProtectSystem=full`,
  `PrivateTmp`, restricted write paths).

### Secrets

- Template variables marked `secret: true` are write-only through the API
  (masked in responses) and rendered as password fields.
- Steam credentials are **not stored at all**: only anonymous SteamCMD login is
  implemented. Games that require an authenticated Steam account are out of scope
  until a proper secret store exists (see limitations).
- Structured logs redact password/token/cookie fields.

### Auditing

Logins, user management, instance lifecycle actions, console commands, file
writes/uploads/deletes and backup operations are written to the `audit_logs` table
(Settings → Audit log, admin only). Entries older than `GAMEDOCK_AUDIT_RETENTION_DAYS`
(default 180) are pruned automatically once a day; set it to `0` to keep the
log forever.

### Login rate limiting

Failed logins are throttled per IP+username (5 attempts per 15 minutes,
in-memory) - repeated failures return the same generic "invalid username or
password" error as a first attempt, so this isn't visible to an attacker
beyond the added delay.

### Two-factor authentication (TOTP)

Any user can enable TOTP (Google Authenticator, Authy, 1Password, etc.) from
Settings → Two-factor authentication: scan the QR code, confirm one code, and
every future login needs a fresh code after the password. Verification codes
are throttled the same way as password attempts. Secrets are stored
server-side only; there's no recovery-codes flow yet, so a lost device means
an **admin** has to reset that account's 2FA (Users page → Reset 2FA, or
`PATCH /api/users/:id {"resetTotp": true}`) before the owner can sign back in.

## What you must do

1. **Never expose port 8340 directly.** Bind to `127.0.0.1` (default) and put
   Nginx/Caddy with TLS in front. All authentication is cookie-based; without TLS,
   cookies can be intercepted.
2. **Set a strong `GAMEDOCK_SESSION_SECRET`** (32+ random bytes; the deploy script
   generates one). The server refuses to start in production with a weak secret.
3. **Set `GAMEDOCK_SECURE_COOKIES=true`** once TLS is in place.
4. **Keep the host updated** (`unattended-upgrades` recommended) — game servers are
   internet-facing native binaries; run them under the dedicated `gamedock` user
   only, never as root.
5. **Open only the game ports you need** in the firewall.
6. **Back up `/var/lib/gamedock`** (database + instances) off-host.
7. Treat all game server mods/plugins as untrusted code — they run with the
   `gamedock` user's permissions.

## Known limitations

- Game servers all run as the same `gamedock` user; a compromised game server can
  read other instances' files. Per-instance system users / systemd units are a
  planned improvement.
- No two-factor authentication yet.
- Authenticated Steam logins (for games without anonymous server downloads) are not
  supported; this avoids storing Steam credentials until an encrypted secret store
  is implemented.
- The in-process job queue and process supervision do not survive daemon restarts;
  running servers are stopped gracefully when the service stops (systemd
  `TimeoutStopSec` allows 90 s).
- SQLite is the only supported database in this version (the data layer is
  abstracted so PostgreSQL can be added).

## Reporting

If you find a vulnerability, please open a private security advisory rather than a
public issue.
