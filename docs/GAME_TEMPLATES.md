# Game templates

A game template is a single JSON file describing how to install, start, stop and
configure a dedicated game server. Templates are data, not code — adding a game
never requires backend changes.

## Locations

| Location                                   | Purpose                                                        |
| ------------------------------------------ | -------------------------------------------------------------- |
| `packages/game-templates/templates/*.json` | Built-in templates shipped with GameDock                       |
| `<GAMEDOCK_DATA_DIR>/templates/*.json`     | Your own templates (production: `/var/lib/gamedock/templates`) |

User templates are loaded after built-ins; a user template with the same `id`
**shadows** the built-in one. Templates are loaded at service start (restart the
service after adding one). `pnpm gamedock doctor` lists load errors.

## Finding new games to support

The "New server" page has a **Browse Steam dedicated servers** section (backed
by `GET /api/steam/catalog`) that lists every Steam app whose name matches
`dedicated server`, i.e. Valve's convention for the free, anonymous-login-only
server tools this project supports — cross-referenced against the templates
above so already-supported games show as installable. It's a discovery aid for
finding the Steam app id of a game you want to add a template for next, not a
generic installer: GameDock still needs a template (start/stop commands,
ports, variables) before an app id becomes actually installable.

## Format

```jsonc
{
  "id": "my-game", // lowercase, digits, dashes; unique
  "name": "My Game Dedicated Server",
  "description": "Short description shown in the create wizard.",

  // How server files are obtained: "steamcmd" | "url" | "manual"
  "installMethod": "steamcmd",
  "steam": {
    // required when installMethod = steamcmd
    "appId": 123456, // dedicated server app id
    "anonymous": true, // only anonymous login is supported
    "extraArgs": ["-beta", "public"], // optional app_update extras
  },
  "urlInstall": {
    // required when installMethod = url - either "url", or "resolver" + "versionVariable"
    "url": "https://example.com/server-{{VERSION}}.zip", // placeholders allowed
    "archive": "zip", // "none" | "zip" | "tar" (tar.gz/xz/bz2)
    "targetFile": "server.jar", // only for archive "none"
    "resolver": "mojang-version-manifest", // optional: resolve the URL dynamically instead of "url"
    "versionVariable": "MC_VERSION", // variable holding the version the resolver looks up
  },

  "os": ["linux"],

  // Documentation for firewall/UI; copied to new instances (editable per instance)
  "ports": [{ "name": "Game", "port": 27015, "protocol": "udp" }],

  // Startup command. NEVER a shell string: executable + argv array.
  "start": {
    "executable": "./server_binary", // or a PATH command like "java"
    "args": ["-port", "{{GAME_PORT}}", "-name", "{{SERVER_NAME}}"],
    "workingDir": ".", // relative to the instance directory
  },

  // Extra environment for the process ({{PLACEHOLDERS}} allowed in values)
  "env": { "LD_LIBRARY_PATH": "./linux64" },

  // Graceful stop behaviour. After timeoutSeconds, SIGKILL is sent.
  "stop": {
    "method": "command", // "command" | "sigint" | "sigterm"
    "command": "quit", // required for method "command"
    "timeoutSeconds": 60,
  },

  "console": { "supportsInput": true }, // enables the console command box

  // Shown as shortcuts on the instance settings page
  "configFiles": [{ "path": "server.cfg", "description": "Main config", "createdByServer": true }],

  // Files written into the instance dir after install (placeholders allowed).
  // Existing files are not overwritten during updates.
  "setupFiles": [{ "path": "eula.txt", "content": "eula={{ACCEPT_EULA}}\n" }],

  // User-facing settings; referenced as {{KEY}} in args/env/urls/setupFiles
  "variables": [
    {
      "key": "GAME_PORT", // UPPER_SNAKE_CASE
      "label": "Game port (UDP)",
      "description": "Optional help text",
      "default": "27015",
      "required": true,
      "secret": false, // true = masked in UI and API responses
      "pattern": "[0-9]{2,5}", // anchored regex the value must match
    },
  ],

  "notes": "Free-text hints shown in the create wizard.",
}
```

## Built-in variables

These are always available in placeholders, in addition to template variables:

| Placeholder                  | Value                                   |
| ---------------------------- | --------------------------------------- |
| `{{GAMEDOCK_INSTANCE_DIR}}`  | Absolute path of the instance directory |
| `{{GAMEDOCK_INSTANCE_ID}}`   | Instance UUID                           |
| `{{GAMEDOCK_INSTANCE_NAME}}` | Instance display name                   |

## Rules & behavior

- Arguments are passed to the process as separate argv entries — there is no shell,
  no quoting, no injection surface. An argument that resolves to an **empty string
  is dropped** (useful for optional values).
- Variable values are validated: control characters are rejected, `pattern` is
  anchored (`^...$`) and enforced, `required` values must be non-empty.
- `stop.method: "command"` requires `console.supportsInput: true`.
- Each instance stores a **snapshot** of its template at creation time, so editing
  a template file affects only newly created instances.
- Finding Steam app ids: search the game on <https://steamdb.info> and use the
  _dedicated server_ app id (not the game's).

## Dynamic version resolution (`urlInstall.resolver`)

For `installMethod: "url"`, a static `url` template works when the download URL is
predictable from a version string (e.g. `.../server-{{VERSION}}.zip`). Some
distributors (Mojang included) use content-hashed URLs that can't be built from a
version number, so a resolver looks the real URL up dynamically at install time
instead.

Currently supported: `"mojang-version-manifest"` — resolves a Minecraft version
against Mojang's official version manifest and returns that version's official
`server.jar` URL. Set `versionVariable` to the key of the template variable that
holds the user's version choice. That variable accepts an exact version id (e.g.
`"1.21.4"`), or the special values `"latest-release"` / `"latest-snapshot"`. See
[minecraft-java.json](../packages/game-templates/templates/minecraft-java.json) for
the full example. Resolution re-runs on every install/update job, so changing the
version variable and clicking **Update files** fetches the newly selected version.

Different Minecraft versions require different Java major versions to run (newer
releases fail with `UnsupportedClassVersionError` on an older JDK). The
`mojang-version-manifest` resolver also reads the required Java major version from
the resolved version's metadata and auto-downloads a matching Eclipse Temurin JDK
(cached under `<data dir>/runtimes/jdk-<major>`, shared across instances) via the
Adoptium API, then points that instance's startup command at it. This happens
transparently on every install/update — you don't need to install Java versions
manually.

## Worked example: adding a Vintage Story server

Create `/var/lib/gamedock/templates/vintage-story.json`:

```json
{
  "id": "vintage-story",
  "name": "Vintage Story Server",
  "description": "Wilderness survival sandbox (official tarball).",
  "installMethod": "url",
  "urlInstall": {
    "url": "https://cdn.vintagestory.at/gamefiles/stable/vs_server_linux-x64_{{VERSION}}.tar.gz",
    "archive": "tar"
  },
  "os": ["linux"],
  "ports": [{ "name": "Game", "port": 42420, "protocol": "tcp" }],
  "start": {
    "executable": "./VintagestoryServer",
    "args": ["--dataPath", "{{GAMEDOCK_INSTANCE_DIR}}/data"],
    "workingDir": "."
  },
  "env": {},
  "stop": { "method": "command", "command": "/stop", "timeoutSeconds": 60 },
  "console": { "supportsInput": true },
  "configFiles": [
    { "path": "data/serverconfig.json", "description": "Server config", "createdByServer": true }
  ],
  "variables": [
    {
      "key": "VERSION",
      "label": "Server version",
      "default": "1.20.1",
      "required": true,
      "pattern": "[0-9.]+"
    }
  ]
}
```

Restart GameDock (`sudo systemctl restart gamedock`) and the template appears in
the create wizard.
