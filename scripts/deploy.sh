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

SSH=(ssh)
RSYNC=(rsync -az)
if [ -n "$DEPLOY_SSH_KEY" ]; then
  SSH=(ssh -i "$DEPLOY_SSH_KEY")
  RSYNC=(rsync -az -e "ssh -i $DEPLOY_SSH_KEY")
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
# minutes-past-the-hour they occupy, UTC, as FROM-TO — it may wrap, so 54-01
# means :54 through :01. Empty (the default) disables the check.
if [ -n "$DEPLOY_BLACKOUT" ]; then
  FROM="${DEPLOY_BLACKOUT%%-*}"
  TO="${DEPLOY_BLACKOUT##*-}"
  MIN=$(date -u +%-M)
  if { [ "$FROM" -le "$TO" ] && [ "$MIN" -ge "$FROM" ] && [ "$MIN" -le "$TO" ]; } \
  || { [ "$FROM" -gt "$TO" ] && { [ "$MIN" -ge "$FROM" ] || [ "$MIN" -le "$TO" ]; }; }; then
    if [ "$FORCE_WINDOW" = 0 ]; then
      echo "⛔ It is UTC $(date -u +%H:%M), inside the blackout window XX:${FROM}–XX:${TO}."
      echo "   Wait, or pass --force-window when you know nothing is mid-cycle."
      exit 1
    fi
    echo "⚠️  UTC $(date -u +%H:%M) is inside the blackout window; --force-window given."
  fi
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
