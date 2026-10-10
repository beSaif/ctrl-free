#!/bin/sh
# Seed $DATA_DIR (the volume) with the repo's reference data, demo files and LLM cache.
# Never overwrites: reference data edited in the app and all tender state survive redeploys.
set -e
if [ "$DATA_DIR" != /app/backend/data ]; then
  mkdir -p "$DATA_DIR"
  cp -R --update=none /app/backend/data/. "$DATA_DIR"/
fi
# One worker: tender writes are locked in-process (app/store.py).
exec /app/backend/.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8000}" --proxy-headers --forwarded-allow-ips='*'
