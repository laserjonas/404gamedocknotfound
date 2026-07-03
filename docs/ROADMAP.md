# Roadmap

Backlog of larger items not yet scheduled. Each needs its own short design
pass (or its own planning session for the bigger ones) when picked up -
these are one-paragraph pointers, not implementation plans.

## Shipped so far

For context: Phase 0 (query batching, hot-path trimming, frontend
code-splitting, circular log buffer), Phase 1 (file manager rename/move/
download, instance clone, 2FA recovery codes, console command history) and
Phase 2 (API tokens for automation, scheduled restarts, lightweight
in-memory metrics history) are all shipped as of v0.13.0.

## Up next — larger, higher-value items

- **Resource limit enforcement (cgroups CPU/RAM/IO caps per instance).**
  The natural next step after per-instance user isolation. Confirmed
  feasible: nothing today enforces limits (`processManager.ts` only spawns
  via `sudo -n -u <user> -- <executable>` when isolation is on —
  `apps/api/src/services/processManager.ts:284-302` — monitoring is
  read-only via `pidusage`, not enforcement). The systemd unit's
  `ProtectControlGroups=true` blocks GameDock from writing cgroupfs
  directly, so the path is **`systemd-run --uid=<gd-user> --scope -p
MemoryMax=... -p CPUQuota=...`** invoked through the same sudo mechanism
  already used for isolated spawns — composes naturally with the existing
  pid-resolution/signal-relay machinery built for that case. Important
  constraint carried over from the isolation feature: this only works
  cleanly for **already-isolated instances** (`GAMEDOCK_INSTANCE_USER_ISOLATION`,
  off by default, not available in Docker) — shared-user instances have no
  per-instance uid/session to scope a systemd scope to, so this would
  either require isolation as a prerequisite or need a materially different
  approach for the default/Docker case. Needs its own planning session,
  live VM verification (same pattern as isolation/passkeys work), and a
  product decision on the isolation-prerequisite question.
- **Job queue surviving a daemon restart.** Documented gap in
  `docs/SECURITY.md`. Medium-large, a real reliability improvement
  (currently an in-progress install/backup job is lost if the API restarts
  mid-job).
- **Full metrics time-series storage** (as opposed to the lightweight
  in-memory version already shipped) — only worth it if the lightweight
  version proves insufficient; larger lift (schema, retention/pruning like
  the audit log already has).

## Explicitly out of scope / deferred

- **Discord/webhook notifications** — deprioritized.
- **SQLite → Postgres migration** — deprioritized; no observed pain point,
  and only becomes relevant if multi-node is pursued.
- **Multi-node support** — raised as a bigger alternative direction, not
  chosen; would also revive the Postgres question (shared DB across
  hosts).
- **Mod/plugin management** — large lift, real scope-creep risk; "add a
  game = add a template JSON" is confirmed accurate today, but per-instance
  mod installation is a much bigger, separate feature.
- **Encrypted secret store for authenticated Steam logins** — large lift;
  CLAUDE.md already positions non-anonymous Steam accounts as out of scope
  regardless.

## Verification approach (applies per item)

vitest unit tests where logic is testable in isolation (fake repositories,
following `auth/service.test.ts`'s style), and live verification on the
test VM for anything touching systemd/sudo/cgroups/process-spawn behavior
before considering an item done.
