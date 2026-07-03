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
- The systemd unit applies hardening (`ProtectSystem=full`, `PrivateTmp`,
  restricted write paths, and more - see below for the one exception).
- Game servers run detached from the API process (own process group, stdout/
  stderr to files, console input via a per-instance named pipe under
  `/var/lib/gamedock`) so they keep running across an API restart or
  self-update.
- **Per-instance user isolation** (opt-in, `GAMEDOCK_INSTANCE_USER_ISOLATION=true`):
  each game server runs as its own dedicated, unprivileged Linux user instead
  of sharing `gamedock` with every other instance, so a compromised server
  (bad mod/plugin) cannot read or write another instance's files, backups, or
  logs. Instance directories are owned `<dedicated-user>:gamedock` mode
  `2770` (setgid) - the dedicated user gets full access to only its own
  directory, `gamedock` keeps group access for installs/backups/the file
  manager, and no other instance's user has any access at all.
  - This requires `gamedock` to run processes as those dedicated users via
    `sudo`, scoped by a `Runas_Alias` in `/etc/sudoers.d/gamedock-instances`
    to a fixed, non-root group (`gamedock-instances`) - `gamedock` can never
    become root or any other real account through this rule. One additional
    root-owned, fixed-path script (`scripts/gamedock-instance-user`) is the
    only thing that can create/remove those dedicated users, also invoked
    through a narrowly-scoped sudoers rule.
  - **Trade-off, stated plainly**: this requires `NoNewPrivileges=false` in
    the systemd unit (sudo's whole mechanism is gaining privileges at exec
    time, which `NoNewPrivileges=true` blocks entirely). That narrows one
    hardening axis - `sudo`/PAM itself becomes new attack surface reachable
    from the `gamedock` process, and any future bug controlling the arguments
    to that `sudo -u` invocation is capped by the `Runas_Alias` group
    restriction, but a `sudo`/PAM vulnerability would be a new escalation
    path that didn't exist before. This was a deliberate choice to close a
    more concrete, higher-likelihood gap (cross-instance file access)
    at the cost of a narrower, tightly-scoped one.
  - We explicitly rejected the alternative of granting the Node process
    itself `CAP_SETUID`/`CAP_SETGID` (e.g. via `setcap` on the node binary):
    that would let any code path in the process - a bug, a compromised
    dependency - escalate to _any_ uid, including root, which is a strictly
    worse attack surface than a sudoers rule scoped to a fixed non-root group.
  - Not available in the Docker deployment (see `docs/DEPLOYMENT.md`); all
    instances in a container share the container's `gamedock` user.
  - Off by default. Existing installs need a one-time manual root step to
    enable it (see `docs/DEPLOYMENT.md`).

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

- Per-instance user isolation (see above) is opt-in and bare-metal/systemd only;
  with it disabled (the default) or in Docker, game servers all run as the same
  `gamedock` user and a compromised game server can read other instances' files.
- Authenticated Steam logins (for games without anonymous server downloads) are not
  supported; this avoids storing Steam credentials until an encrypted secret store
  is implemented.
- The job queue does not survive daemon restarts (in-flight installs/updates/backups
  are marked failed and must be re-run); game server processes themselves do survive,
  see "Process isolation" above.
- SQLite is the only supported database in this version (the data layer is
  abstracted so PostgreSQL can be added).

## Reporting

If you find a vulnerability, please open a private security advisory rather than a
public issue.
