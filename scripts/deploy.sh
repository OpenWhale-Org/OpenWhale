#!/usr/bin/env bash
#
# Deploy OpenWhale to a server over SSH.
#
#   scripts/deploy.sh                 build, sync, restart, health-check
#   scripts/deploy.sh --skip-build    reuse the build already in the tree
#   scripts/deploy.sh --with-env      push .env too (only when secrets changed)
#   scripts/deploy.sh --force-window  override the blackout window (see below)
#
# Configuration comes from scripts/deploy.env — copy deploy.env.example and
# fill it in. That file is gitignored: it names your host and your key.
#
# What this does NOT do is touch the server's data directory. ~/.openwhale is
# the engine's own state — positions it believes it holds, execution records
# not yet written anywhere else, monitor history accumulated over weeks. Moving
# state between machines is a separate, deliberate job, not a side effect of
# shipping code.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="$REPO_ROOT/scripts/deploy.env"

if [ -f "$CONFIG" ]; then
  # shellcheck disable=SC1090
  . "$CONFIG"
fi

: "${DEPLOY_HOST:?Set DEPLOY_HOST (e.g. user@example.com) in scripts/deploy.env}"
: "${DEPLOY_PATH:=openwhale}"
DEPLOY_SSH_KEY="${DEPLOY_SSH_KEY:-}"
DEPLOY_URL="${DEPLOY_URL:-}"
# Whitespace-separated local plugin directories, each optionally `:remote_parent`
# when it does not belong under DEPLOY_REMOTE_PLUGINS.
DEPLOY_PLUGINS="${DEPLOY_PLUGINS:-}"
DEPLOY_REMOTE_PLUGINS="${DEPLOY_REMOTE_PLUGINS:-plugins}"
DEPLOY_SERVICES="${DEPLOY_SERVICES:-openwhale-gateway openwhale-dashboard}"
DEPLOY_BLACKOUT="${DEPLOY_BLACKOUT:-}"

# Keepalives: the restart step is silent for as long as the slowest service
# takes to stop, and a NAT or proxy on the way cuts a silent connection at
# about a minute — "closed by remote host", with the job still running on the
# server and no health check. Measured 2026-09-11, twice.
SSH_OPTS=(-o ServerAliveInterval=15 -o ServerAliveCountMax=8)
# A connection reset mid-transfer is the network's failure, not the deploy's:
# rsync is idempotent, so each sync is tried up to three times before the run
# gives up. Measured 2026-09-11: three runs lost to a reset in a different
# sync step each time, with the server's sshd logging nothing.
retry() {
  local n=0
  until "$@"; do
    n=$((n + 1))
    [ "$n" -ge 3 ] && return 1
    echo "  ↻ attempt $((n + 1)) after a failed $1" >&2
    sleep 4
  done
}
SSH=(ssh "${SSH_OPTS[@]}")
RSYNC=(retry rsync -az -e "ssh ${SSH_OPTS[*]}")
if [ -n "$DEPLOY_SSH_KEY" ]; then
  SSH=(ssh "${SSH_OPTS[@]}" -i "$DEPLOY_SSH_KEY")
  RSYNC=(retry rsync -az -e "ssh ${SSH_OPTS[*]} -i $DEPLOY_SSH_KEY")
fi

SKIP_BUILD=0; WITH_ENV=0; FORCE_WINDOW=0
for a in "$@"; do case "$a" in
  --skip-build)   SKIP_BUILD=1;;
  --with-env)     WITH_ENV=1;;
  --force-window) FORCE_WINDOW=1;;
  -h|--help)      sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0;;
  *) echo "unknown argument: $a" >&2; exit 1;;
esac; done

step() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }

# ── 0. Optional blackout window ───────────────────────────────────────────────
#
# Restarting the gateway interrupts whatever is mid-execution. If your
# strategies work in cycles around a fixed instant, set DEPLOY_BLACKOUT to the
# minutes-past-the-hour they occupy, UTC, as FROM-TO — it may wrap, so 50-03
# means :50 through :03. Empty (the default) disables the check.
#
# The window guards the RESTART, not the moment you typed the command, and a
# full deploy takes minutes: build, sync, install, then restart. Checking only
# at the start let a deploy started at :51 restart the gateway at :54 — inside
# the very window meant to prevent it (measured 2026-09-10, nine minutes before
# a funding settlement). So the check runs twice: here to fail fast before
# paying for a build, and again immediately before the restart, where it WAITS
# the window out rather than abandoning a finished build.
FROM="${DEPLOY_BLACKOUT%%-*}"
TO="${DEPLOY_BLACKOUT##*-}"

in_blackout() {
  [ -n "$DEPLOY_BLACKOUT" ] || return 1
  local min; min=$(date -u +%-M)
  { [ "$FROM" -le "$TO" ] && [ "$min" -ge "$FROM" ] && [ "$min" -le "$TO" ]; } \
  || { [ "$FROM" -gt "$TO" ] && { [ "$min" -ge "$FROM" ] || [ "$min" -le "$TO" ]; }; }
}

if in_blackout; then
  if [ "$FORCE_WINDOW" = 0 ]; then
    echo "⛔ It is UTC $(date -u +%H:%M), inside the blackout window XX:${FROM}–XX:${TO}."
    echo "   Wait, or pass --force-window when you know nothing is mid-cycle."
    exit 1
  fi
  echo "⚠️  UTC $(date -u +%H:%M) is inside the blackout window; --force-window given."
fi

# ── 1. Build locally ──────────────────────────────────────────────────────────
#
# Not on the server: a Next build is the heaviest thing in the repo, the box is
# sized to run an engine rather than a compiler, and the engine is running
# while you deploy — an OOM killer arriving mid-build does not stop at the
# build. NEXT_DIST_DIR keeps the production output away from .next, which a
# local `next dev` overwrites in place.
if [ "$SKIP_BUILD" = 0 ]; then
  step "Build: packages, dashboard${DEPLOY_PLUGINS:+, plugins}"
  (cd "$REPO_ROOT" && pnpm -r --filter '!@openwhaleorg/dashboard' build)
  (cd "$REPO_ROOT/packages/apps/dashboard" && NEXT_DIST_DIR=.next-deploy npx next build)
  for entry in $DEPLOY_PLUGINS; do
    dir="${entry%%:*}"
    [ -d "$dir" ] || { echo "plugin path not found: $dir" >&2; exit 1; }
    (cd "$dir" && pnpm build)
  done
fi

# ── 2. Sync ───────────────────────────────────────────────────────────────────
step "Sync repository"
"${RSYNC[@]}" --delete \
  --exclude node_modules --exclude .git --exclude '.next' --exclude '.next-deploy' \
  --exclude .env --exclude 'scripts/deploy.env' \
  "$REPO_ROOT/" "$DEPLOY_HOST:$DEPLOY_PATH/"

step "Sync dashboard build"
"${RSYNC[@]}" --delete --exclude cache \
  "$REPO_ROOT/packages/apps/dashboard/.next-deploy/" \
  "$DEPLOY_HOST:$DEPLOY_PATH/packages/apps/dashboard/.next/"

if [ -n "$DEPLOY_PLUGINS" ]; then
  step "Sync plugins"
  for entry in $DEPLOY_PLUGINS; do
    dir="${entry%%:*}"
    remote="$DEPLOY_REMOTE_PLUGINS"
    [ "$entry" != "$dir" ] && remote="${entry#*:}"
    "${SSH[@]}" "$DEPLOY_HOST" "mkdir -p '$remote'"
    "${RSYNC[@]}" --delete --exclude node_modules --exclude .git \
      "$dir" "$DEPLOY_HOST:$remote/"
  done
fi

if [ "$WITH_ENV" = 1 ]; then
  step "Push .env"
  "${RSYNC[@]}" "$REPO_ROOT/.env" "$DEPLOY_HOST:$DEPLOY_PATH/.env"
fi

# ── 3. Install and restart ────────────────────────────────────────────────────
#
# Each plugin's own dependencies too: they are separate packages that the
# repo's lockfile knows nothing about.
REMOTE_PLUGIN_DIRS=""
for entry in $DEPLOY_PLUGINS; do
  dir="${entry%%:*}"
  remote="$DEPLOY_REMOTE_PLUGINS"
  [ "$entry" != "$dir" ] && remote="${entry#*:}"
  REMOTE_PLUGIN_DIRS="$REMOTE_PLUGIN_DIRS $remote/$(basename "$dir")"
done

# The build and the sync are done; only the restart is dangerous. If the clock
# has walked into the window while they ran, hold here — the artefacts are
# already on the server, so waiting costs nothing and restarting mid-cycle
# costs an execution.
if [ "$FORCE_WINDOW" = 0 ] && in_blackout; then
  echo "⏸  UTC $(date -u +%H:%M) is inside the blackout window XX:${FROM}–XX:${TO} — holding the restart."
  while in_blackout; do sleep 20; done
  echo "▶️  UTC $(date -u +%H:%M) — window clear, restarting."
fi

# ── 2b. Refresh the staged copies ─────────────────────────────────────────────
#
# The engine does NOT load a plugin from where it was installed. Node's ESM
# registry is keyed by resolved URL and can never be evicted, so a reinstall at
# the same path would change the bytes on disk and change nothing about what
# runs; the installer therefore copies each package to a fresh directory under
# ~/.openwhale/plugins/staged/ and records THAT as the entry point.
#
# Which means rsync + restart is not a deploy. It puts the new code on the
# server, next to the old code that keeps running — silently, which is the
# worst way for a trading engine to be wrong about what it is executing.
# Measured 2026-09-10: one plugin had been frozen at a day-old staged copy while
# three deploys reported success.
#
# So: refresh each staged copy in place from what we just synced. The recorded
# entryPath stays valid, and the restart below picks the new bytes up.
# `node_modules` is excluded — the copy holds a symlink back to the install's
# own tree, and overwriting it would break resolution.
step "Refresh staged plugin copies"
# Quoted heredoc: the remote script is sent verbatim, so nothing here needs a
# second layer of escaping.
"${SSH[@]}" "$DEPLOY_HOST" bash -s <<'REMOTE_RESTAGE'
set -e
node -e '
  const fs = require("fs"), path = require("path");
  const file = path.join(process.env.HOME, ".openwhale/plugins/plugins.json");
  let list = []; try { list = JSON.parse(fs.readFileSync(file, "utf8")) } catch { process.exit(0) }
  for (const p of list) {
    const entry = p.entryPath || "";
    if (!entry.includes("/staged/")) continue;            // loaded live — nothing to refresh
    if (!p.source || p.source.kind !== "local" || !p.source.path) continue;
    const cut = entry.indexOf("/dist/");
    if (cut < 0) continue;
    const root = entry.slice(0, cut);
    if (fs.existsSync(root) && fs.existsSync(p.source.path)) console.log(p.source.path + "\t" + root);
  }
' | while IFS=$'\t' read -r src dst; do
  [ -n "$src" ] || continue
  rsync -a --delete --exclude node_modules --exclude .git "$src/" "$dst/"
  echo "  restaged ${dst##*/}"
done
REMOTE_RESTAGE

step "Install dependencies and restart"
"${SSH[@]}" "$DEPLOY_HOST" "
set -e
cd '$DEPLOY_PATH' && nice -n 10 pnpm install --frozen-lockfile 2>&1 | tail -1
for p in $REMOTE_PLUGIN_DIRS; do
  cd \"\$HOME/\$p\" && pnpm install 2>&1 | tail -1
done
sudo systemctl restart $DEPLOY_SERVICES
"

# ── 4. Health check ───────────────────────────────────────────────────────────
step "Health check"
"${SSH[@]}" "$DEPLOY_HOST" "systemctl is-active $DEPLOY_SERVICES" | paste -sd' ' - | sed 's/^/  services: /'

if [ -z "$DEPLOY_URL" ]; then
  echo "  DEPLOY_URL not set — skipping the HTTP check"
  echo "  ✅ Deployed"
  exit 0
fi

code=000
for _ in $(seq 1 18); do
  sleep 5
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 15 "$DEPLOY_URL/login" || true)
  [ "$code" = 200 ] && break
done
auth=$(curl -s -o /dev/null -w '%{http_code}' -m 20 "$DEPLOY_URL/api/auth/status" || true)
echo "  $DEPLOY_URL/login → $code"
echo "  $DEPLOY_URL/api/auth/status → $auth"

# Two separate checks on purpose: /login is served by the dashboard alone,
# /api/auth/status travels through it to the gateway. The first passing while
# the second fails is the frontend up and the engine down.
if [ "$code" = 200 ] && [ "$auth" = 200 ]; then
  echo "  ✅ Deployed"
else
  echo "  ❌ Something is wrong — check: journalctl -u openwhale-gateway -n 50"
  exit 1
fi
