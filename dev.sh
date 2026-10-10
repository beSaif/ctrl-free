#!/usr/bin/env bash
# Start backend (FastAPI :8000) and frontend (Vite :5173). Ctrl-C stops both.
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
(cd "$ROOT/backend" && uv sync -q && uv run uvicorn app.main:app --port 8000 --reload) &
BACK=$!
(cd "$ROOT/frontend" && pnpm install --silent && pnpm dev --port 5173) &
FRONT=$!
trap 'kill $BACK $FRONT 2>/dev/null' INT TERM EXIT
echo "ctrl-free: open http://localhost:5173"
wait
