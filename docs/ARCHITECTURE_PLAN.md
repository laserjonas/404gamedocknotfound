# Architecture overhaul plan

GameDock today is deliberately simple: one Node.js process, SQLite on disk,
game servers as direct child processes of that same process, deployed by hand
(or via the in-app self-update) onto a single Debian VM. That's the right
design for "self-host this on your one box" - and it's honestly not far off
from how Pterodactyl and Crafty ship by default too.

"Publishing the app" changes the bar. It stops being "the thing I run on my
VM" and starts being "the thing strangers run on VMs I've never seen,"
possibly at higher scale, possibly as a hosted multi-tenant product later.
That shift is what actually breaks SQLite's assumptions (single writer, one
file, no network access to the DB) - not SQLite being a bad piece of
technology. The plan below treats SQLite as step 1 of a bigger picture rather
than the whole story, because the other four gaps (deployment portability,
process/API coupling, hardening, and release engineering) will bite just as
hard once this is public, regardless of which database is underneath.

Each step is independently shippable and reversible - this is a roadmap, not
a rewrite. Nothing here is committed to yet; it's for discussion.

## Step 1 - Database: keep SQLite as the zero-config default, add PostgreSQL as the production path

**Problem:** `better-sqlite3` is synchronous and single-writer. That's fine at
today's scale (one admin, a handful of instances, occasional writes), but it
means no read replicas, no separate DB server to back up/monitor
independently, and a hard ceiling if job logs / audit / SSE fan-out ever get
busy. It also means the DB and the app are physically inseparable, which
blocks any future "run the API in a container, the DB elsewhere" story.

**Approach:** Not a rip-and-replace - a second implementation behind the
existing seam. `DatabaseClient` (`apps/api/src/db/database.ts`) is already a
thin wrapper the repositories call through; extend it so
`GAMEDOCK_DATABASE_URL` accepts `postgres://...` in addition to `sqlite:...`,
with a `pg`-backed implementation of the same interface. Repositories stay
hand-written SQL (no ORM, matches the project's existing conventions) - the
two backends differ mainly in placeholder syntax (`?` vs `$1`) and a couple
of type mappings (booleans, timestamps), which is a small, mechanical
translation layer, not a redesign of every query.

**Migrations:** `migrations.ts`'s plain numbered-SQL approach stays, just
gains a second SQL variant per migration where the dialects diverge (most
won't need one - it's mostly `CREATE TABLE`/`ALTER TABLE`, which is close to
identical between SQLite and Postgres already).

**Outcome:** SQLite remains the friction-free default for `curl | bash`-style
single-VM installs (matches today's docs exactly). Postgres becomes the
documented, recommended engine once you're exposing this publicly or running
it as more than a personal panel - same as how Gitea, Grafana, and plenty of
other self-hosted tools handle this exact tradeoff.

## Step 2 - Containerization & reproducible deployment

**Problem:** Today's install path is a Debian-specific shell script
(`scripts/install.sh`) that assumes a particular OS, installs system
packages, and hand-configures a systemd unit. That's a real barrier for
anyone not on Debian/Ubuntu, and it means "publishing" the app today really
means publishing a shell script, not an artifact people can just run.

**Approach:** An official multi-stage Dockerfile (build stage compiles
TS/bundles the web UI; runtime stage is a slim Node image with `steamcmd`,
Java runtime deps, and `tar`/`unzip` preinstalled) plus a `docker-compose.yml`
that wires up the API container, a Postgres container (see step 1), and a
volume for instance data/backups. The existing bare-metal `install.sh`/
`deploy.sh` path doesn't go away - it's still the right answer for someone
who wants game servers running directly on the host's network stack without
container networking overhead - but it stops being the *only* answer.

**Outcome:** `docker compose up` becomes a real alternative on-ramp, and the
project can publish versioned images to a registry (ties into step 5)
instead of only "clone the repo and run a script."

## Step 3 - Decouple the control plane from the process-supervision plane

**Problem:** `ProcessManager` runs every game server as a direct child of the
same Node process that serves the API. `DEPLOYMENT.md` already calls this out
explicitly: "stopping the service stops the game servers." That's an
acceptable tradeoff for one admin on one VM; it's a much bigger deal once
GameDock is a thing other people rely on, because it means every API
deploy/crash/self-update takes every hosted game server down with it, and it
hard-caps you at one API instance forever.

**Approach:** `ProcessManager` is already written behind an interface for
exactly this reason (see the comment in `context.ts`/`DEPLOYMENT.md`: "The
design keeps a clean seam to move to per-instance systemd units later"). Cash
that in: move process supervision into per-instance systemd units (or a small
long-lived agent process) that the API controls via `systemctl`/a local
socket instead of holding the child process handle itself. The API can then
restart, redeploy, or even run zero-downtime rolling updates without
touching running game servers.

**Outcome:** API updates and game server uptime become independent failure
domains - a prerequisite for calling this "production-grade," not just a
nice-to-have.

## Step 4 - Harden auth/security for exposure beyond a trusted LAN

**Problem:** The current security model (bcrypt, session+CSRF, audit log,
path-traversal protection, never-runs-as-root) is genuinely solid for a
single-admin, mostly-trusted-network deployment. Publishing the app means
some installs will end up reachable from the wider internet with less
careful operators - the threat model needs to assume that.

**Approach:**
- Rate limiting / lockout on `/api/auth/login` (currently unlimited attempts).
- Optional TOTP-based 2FA for admin accounts.
- Session secret rotation support (currently a single long-lived secret).
- Audit log export + retention policy (today it grows forever - fine at
  small scale, worth capping/archiving once this is more widely deployed).
- A documented, minimal "public exposure" checklist in `SECURITY.md` (most of
  this already exists there - extend it rather than replace it).

**Outcome:** Closes the gap between "secure enough for my homelab" and
"secure enough to recommend to someone I've never met."

## Step 5 - Observability and real release engineering

**Problem:** There's no CI today - `pnpm build/test/typecheck/lint` only run
when a human (or Claude) runs them locally before pushing. Releases are "bump
the version in 5 package.json files and push to main." That works for a
single maintainer but doesn't scale to outside contributors or give users any
confidence a given commit is actually good.

**Approach:**
- GitHub Actions workflow: build + test + typecheck + lint on every PR and
  push to main (this is the most impactful, lowest-risk item in this entire
  plan - it directly protects against exactly the kind of regression the
  pino-pretty production outage was).
- A `/api/system/metrics` (Prometheus-format) endpoint alongside the existing
  `/api/system/stats`, so hosted instances can be monitored the same way
  everything else in a real deployment is.
- Automated versioning (the 5-file manual bump is exactly the kind of thing
  that gets forgotten under time pressure) plus a generated changelog and
  tagged GitHub Releases, and - once step 2 lands - automatic image publish
  on release.

**Outcome:** Turns "push to main and hope" into an actual release process,
and gives anyone deploying GameDock a way to know a given version is sound
before they run it.

## Suggested order

Step 5 (CI) first - it's cheap, has no architectural risk, and immediately
protects every other step from regressing. Step 1 (database) and step 2
(containers) can happen in parallel after that; step 3 (process decoupling)
is the largest and riskiest change and is best done once the other three are
stable. Step 4 (hardening) can be threaded through the others incrementally
rather than done as one big-bang change.
