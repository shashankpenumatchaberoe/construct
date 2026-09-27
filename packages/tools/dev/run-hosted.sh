#!/usr/bin/env bash
# Run the Cockpit reachable from any IP, with mandatory GitHub login (#278).
# Secrets come from the environment only; nothing is written to disk.
#   PUBLIC_HOST=203.0.113.10 CONSTRUCT_GITHUB_CLIENT_ID=... CONSTRUCT_GITHUB_CLIENT_SECRET=... \
#   CONSTRUCT_ALLOWED_LOGINS=you packages/tools/dev/run-hosted.sh
# Ports: client 3000, server 4000. Set SCHEME=https if a TLS proxy fronts both.
set -euo pipefail
# Optional: CONSTRUCT_ENV_FILE=/path/outside/the/repo (chmod 600) holding the same
# variables as `KEY=value` lines, so no secret ever appears on a command line.
if [ -n "${CONSTRUCT_ENV_FILE:-}" ]; then set -a; . "$CONSTRUCT_ENV_FILE"; set +a; fi
: "${PUBLIC_HOST:?set PUBLIC_HOST (ip or domain)}"
: "${CONSTRUCT_GITHUB_CLIENT_ID:?set CONSTRUCT_GITHUB_CLIENT_ID}"
: "${CONSTRUCT_GITHUB_CLIENT_SECRET:?set CONSTRUCT_GITHUB_CLIENT_SECRET}"
: "${CONSTRUCT_ALLOWED_LOGINS:?set CONSTRUCT_ALLOWED_LOGINS (comma-separated GitHub logins)}"
SCHEME="${SCHEME:-http}"; WS=$([ "$SCHEME" = https ] && echo wss || echo ws)
# BEHIND_PROXY=1: a reverse proxy (packages/tools/dev/Caddyfile.hosted) serves one https origin
# on 443; the browser then talks to that origin only, never to :3000 / :4000 directly.
if [ "${BEHIND_PROXY:-}" = 1 ]; then ORIGIN="$SCHEME://$PUBLIC_HOST"; API="$ORIGIN"; else ORIGIN="$SCHEME://$PUBLIC_HOST:3000"; API="$SCHEME://$PUBLIC_HOST:4000"; fi
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
# #418: do NOT mint a fresh CONSTRUCT_SESSION_SECRET on every launch — that
# was the whole bug (every restart signed everyone out). Leave it unset and
# the server persists one at <stateDir>/session-secret (mode 0600, refused
# if that file is ever group/world-readable), reusing it on every future
# restart from the same state directory. Set CONSTRUCT_SESSION_SECRET here
# (or in CONSTRUCT_ENV_FILE) only if you want to pin your own instead.
export CONSTRUCT_OAUTH_CALLBACK_URL="${CONSTRUCT_OAUTH_CALLBACK_URL:-$API/auth/callback}"
echo "Callback URL to register on the OAuth app: $CONSTRUCT_OAUTH_CALLBACK_URL"
# #365: the server opens projects only from ONE workspace folder and starts with no project open.
export CONSTRUCT_WORKSPACE_ROOT="${CONSTRUCT_WORKSPACE_ROOT:-$HOME/workspace}"
mkdir -p "$CONSTRUCT_WORKSPACE_ROOT"
echo "Workspace (put projects here, e.g. git clone into it): $CONSTRUCT_WORKSPACE_ROOT"
(cd "$ROOT/ui/client" && NEXT_PUBLIC_API_BASE="$API" NEXT_PUBLIC_WS_BASE="$WS://${API#*://}" npm run build)
(cd "$ROOT/ui/client" && npm start) &
trap 'kill 0' EXIT
cd "$ROOT/ui/server" && HOST=0.0.0.0 UI_CLIENT_ORIGIN="$ORIGIN" npm start
