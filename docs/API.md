# REST API

Base URL: `/api`. All responses are JSON. Authentication uses a session cookie
(`gamedock_session`) obtained via login; every **mutating** request (POST, PUT,
PATCH, DELETE) must additionally send the session's CSRF token in the
`x-csrf-token` header (returned by login and `/api/auth/me`).

Errors have the shape:

```json
{ "error": "conflict", "message": "Server is already running", "statusCode": 409 }
```

Roles: `viewer` < `operator` < `admin`. The role column shows the minimum role.

## Auth

| Method | Path           | Role   | Description                                                |
| ------ | -------------- | ------ | ---------------------------------------------------------- |
| POST   | `/auth/login`  | –      | Body `{username, password}` → `{user, csrfToken}` + cookie |
| POST   | `/auth/logout` | –      | Clears the session                                         |
| GET    | `/auth/me`     | viewer | Current user + CSRF token                                  |

## Users (admin)

| Method | Path         | Description                                                              |
| ------ | ------------ | ------------------------------------------------------------------------ |
| GET    | `/users`     | List users                                                               |
| POST   | `/users`     | Body `{username, password, role}`                                        |
| PATCH  | `/users/:id` | Body `{password?, role?, disabled?}` (safeguards protect the last admin) |
| DELETE | `/users/:id` | Delete user (not yourself)                                               |

## Templates

| Method | Path             | Role   | Description                |
| ------ | ---------------- | ------ | -------------------------- |
| GET    | `/templates`     | viewer | List loaded game templates |
| GET    | `/templates/:id` | viewer | Template detail            |

## Instances

| Method | Path             | Role     | Description                                                                                                                                        |
| ------ | ---------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/instances`     | viewer   | List instances (live status, ports, env)                                                                                                           |
| POST   | `/instances`     | admin    | Body `{name, templateId, variables?, ports?}`                                                                                                      |
| GET    | `/instances/:id` | viewer   | Detail incl. CPU/RAM usage while running                                                                                                           |
| PATCH  | `/instances/:id` | operator | Body `{name?, autoStart?, crashRestart?, backupIntervalHours?, backupRetentionCount?, startExecutable?, startArgs?, envVars?, variables?, ports?}` |
| DELETE | `/instances/:id` | admin    | Deletes files + backups; returns `{job}`                                                                                                           |

### Actions

| Method | Path                     | Role     | Description                                                               |
| ------ | ------------------------ | -------- | ------------------------------------------------------------------------- |
| POST   | `/instances/:id/install` | operator | Install server files → `{job}`                                            |
| POST   | `/instances/:id/update`  | operator | Update server files → `{job}`                                             |
| POST   | `/instances/:id/start`   | operator | Start the server process                                                  |
| POST   | `/instances/:id/stop`    | operator | Graceful stop (console command or signal, SIGKILL after template timeout) |
| POST   | `/instances/:id/restart` | operator | Stop (graceful) then start                                                |
| POST   | `/instances/:id/kill`    | operator | Immediate SIGKILL                                                         |
| POST   | `/instances/:id/command` | operator | Body `{command}` — write to server stdin (if supported)                   |

### Logs

| Method | Path                         | Role   | Description                                         |
| ------ | ---------------------------- | ------ | --------------------------------------------------- |
| GET    | `/instances/:id/logs`        | viewer | Recent console lines (live buffer or log file tail) |
| GET    | `/instances/:id/logs/stream` | viewer | **SSE** live console stream                         |

### Files (sandboxed to the instance directory)

| Method | Path                                 | Role     | Description                          |
| ------ | ------------------------------------ | -------- | ------------------------------------ |
| GET    | `/instances/:id/files?path=`         | viewer   | List directory                       |
| GET    | `/instances/:id/files/content?path=` | viewer   | Read text file (≤ 2 MiB, non-binary) |
| PUT    | `/instances/:id/files/content`       | operator | Body `{path, content}`               |
| POST   | `/instances/:id/files/mkdir`         | operator | Body `{path}`                        |
| POST   | `/instances/:id/files/upload`        | operator | multipart: `path` (dir) + `file`     |
| DELETE | `/instances/:id/files?path=`         | operator | Delete file/directory                |

### Backups

| Method | Path                                       | Role     | Description                             |
| ------ | ------------------------------------------ | -------- | --------------------------------------- |
| GET    | `/instances/:id/backups`                   | viewer   | List backups                            |
| POST   | `/instances/:id/backups`                   | operator | Body `{note?, excludePaths?}` → `{job}` |
| POST   | `/instances/:id/backups/:backupId/restore` | operator | Wipe instance dir + extract → `{job}`   |
| DELETE | `/instances/:id/backups/:backupId`         | operator | Delete archive                          |

## Jobs

| Method | Path                       | Role   | Description                                                     |
| ------ | -------------------------- | ------ | --------------------------------------------------------------- |
| GET    | `/jobs?instanceId=&limit=` | viewer | Recent jobs                                                     |
| GET    | `/jobs/:id`                | viewer | Job incl. captured log                                          |
| GET    | `/jobs/:id/stream`         | viewer | **SSE**: `message` events `{text}` (log), `job` events (status) |

## System

| Method | Path                   | Role   | Description                                                       |
| ------ | ---------------------- | ------ | ----------------------------------------------------------------- |
| GET    | `/system/health`       | –      | Liveness probe                                                    |
| GET    | `/system/stats`        | viewer | CPU, memory, disk, network, instance counts                       |
| GET    | `/system/dependencies` | viewer | steamcmd/java/tar/unzip detection                                 |
| GET    | `/system/events`       | viewer | Recent instance/backup events (dashboard)                         |
| GET    | `/system/audit?limit=` | admin  | Audit log                                                         |
| GET    | `/system/update`       | admin  | Check for updates on the configured git branch                    |
| POST   | `/system/update`       | admin  | Clone + build + swap in the latest commit → `{job}`, then restart |

## Events

| Method | Path             | Role   | Description                                                                        |
| ------ | ---------------- | ------ | ---------------------------------------------------------------------------------- |
| GET    | `/events/stream` | viewer | **SSE** global stream: `{kind: "instance_status" \| "job_update" \| "audit", ...}` |

SSE endpoints authenticate via the session cookie (EventSource sends it
automatically on same-origin requests).
