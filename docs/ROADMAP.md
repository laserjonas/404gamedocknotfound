# Roadmap

Backlog of larger items not yet scheduled. Each needs its own short design
pass (or its own planning session for the bigger ones) when picked up -
these are one-paragraph pointers, not implementation plans.

## Shipped so far

For context: Phase 0 (query batching, hot-path trimming, frontend
code-splitting, circular log buffer), Phase 1 (file manager rename/move/
download, instance clone, 2FA recovery codes, console command history) and
Phase 2 (API tokens for automation, scheduled restarts, lightweight
in-memory metrics history) are all shipped as of v0.13.0. Per-instance
resource limits (cgroup memory/CPU caps via a fixed root `systemd-run
--scope` wrapper, isolated instances only) shipped in v0.17.0.

## Up next — larger, higher-value items

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
