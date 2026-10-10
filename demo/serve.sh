#!/usr/bin/env bash
# A throwaway copy of ctrl-free for filming: backend :8100 on demo/.data (offline, LLM cache only), frontend :5273.
# It runs from a frozen worktree (demo/.app) so edits in progress don't end up on camera. To film newer code:
#   git -C demo/.app checkout --detach <commit> && (cd demo/.app/frontend && pnpm install)
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="${APP_DIR:-$ROOT/demo/.app}"
export DATA_DIR="$ROOT/demo/.data" LLM_OFFLINE=1
(cd "$APP/backend" && uv run uvicorn app.main:app --port 8100) &
BACK=$!
(cd "$APP/frontend" && API_PORT=8100 pnpm exec vite --port 5273 --strictPort) &
FRONT=$!
trap 'kill $BACK $FRONT 2>/dev/null' INT TERM EXIT
wait
