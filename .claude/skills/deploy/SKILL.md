---
name: deploy
description: Deploy ctrl-free to production on Railway (project ctrl-free, service app, https://app-production-3648.up.railway.app). Use when the user says deploy, ship, release, push to Railway or production, redeploy, or roll back the hosted app. Deploys a clean export of a pushed git commit (default origin/main), never the working tree, then verifies health and that the new frontend is live.
---

# Deploy ctrl-free to Railway

Railway does **not** deploy on git push. Deploys are uploaded from this machine with the Railway CLI, which is already logged in and linked in the repo root (`railway status` → project `ctrl-free`, environment `production`, service `app`).

One Docker image (`Dockerfile`, `railway.json`): the React build is served by FastAPI on `$PORT`. Health check: `GET /api/health` (open). Everything else is behind HTTP basic auth with the `APP_PASSWORD` variable (any user name). The frontend is built with `VITE_TODAY=2026-09-10`, so Oberglatt shows "12 days left".

## Before you start

- Deploying is outward-facing. Do it only when the user asked for it in this conversation.
- Never print secrets. Read `APP_PASSWORD` into a shell variable, never echo it.
- Don't change Railway variables, volumes or domains unless asked.

## 1. Pick the commit

Default: `origin/main`. Run `git fetch origin` first. If the user names a branch or SHA, use that, but it must exist on origin (`git branch -r --contains <sha>`), so what runs in production is on GitHub. If local work isn't pushed, say so and stop. Pushing is the user's call.

Record `SHA=$(git rev-parse --short <ref>)`.

## 2. Preflight (≈3 min, skip only if the user says so)

In a clean export of that commit (step 3), or in the repo if it's checked out at that commit with no relevant changes:

```bash
cd frontend && pnpm install --frozen-lockfile && pnpm -s build && pnpm -s lint   # lint: warnings ok, errors not
cd backend && uv run pytest -q                                                    # ~2 min, no paid LLM calls
```

If anything fails, stop and report. Don't deploy a red build.

## 3. Export a clean copy

The working tree usually holds untracked files (`demo/`, `research/simap/`, `backend/data/llm_cache/*.json`). `railway up` from the repo would upload them, so deploy a `git archive` of the commit instead:

```bash
D="$SCRATCHPAD/deploy-$SHA"   # session scratchpad, or $(mktemp -d)
mkdir -p "$D" && git archive "$SHA" | tar -x -C "$D"
```

## 4. Note what is live now

```bash
URL=https://app-production-3648.up.railway.app
P=$(railway variables --kv | sed -n 's/^APP_PASSWORD=//p')
curl -s -u "x:$P" "$URL/" | grep -o 'assets/index-[^"]*\.js'   # BEFORE bundle
railway deployment list | head -3                              # BEFORE deployment id
```

## 5. Deploy

Run from the **repo root**, because the Railway link is stored per directory:

```bash
railway up "$D" --path-as-root --ci
```

`--ci` streams build logs and then exits. It often prints `Failed to stream build logs` and exits 1 even though the upload worked. That is not a failed deploy. Take the deployment id from the "Build Logs" URL (`?id=…`) or from `railway deployment list`, then wait for a terminal state. Use a background Bash `until` loop polling every 15 s; don't sleep in the foreground:

```bash
until s=$(railway deployment list | grep <id> | awk -F'|' '{print $2}' | tr -d ' '); \
  [ -n "$s" ] && ! echo "$s" | grep -qE "BUILDING|DEPLOYING|INITIALIZING|QUEUED|WAITING"; do sleep 15; done; echo "$s"
```

A build takes about 3–6 minutes. `SUCCESS` means live. On `FAILED` or `CRASHED`, read `railway logs --build <id> --lines 200` (build) or `railway logs --deployment <id> --lines 200` (runtime) and report the error. Always pass `--lines`: without it `railway logs` streams and never exits. The previous deployment stays live when a build fails.

## 6. Verify

```bash
curl -s "$URL/api/health"                                      # {"ok": true, "modules": {...}}; all modules true
curl -s -o /dev/null -w "%{http_code}\n" "$URL/"               # 401 without password (auth still on)
curl -s -u "x:$P" "$URL/" | grep -o 'assets/index-[^"]*\.js'   # AFTER bundle: differs from BEFORE if frontend changed
curl -s -u "x:$P" "$URL/api/tenders" | head -c 300             # API answers, tenders on the volume are still there
```

If the change is visible in the UI, grep the new bundle for a string the release added (`curl -s -u "x:$P" "$URL/<bundle>" | grep -c "<new string>"`).

## 7. Report

Report the commit SHA and subject, the deployment id, the URL, health, the bundle before → after, and anything skipped. Remove the export dir.

## Data on the volume (read before deploying data changes)

Runtime data lives on a Railway volume at `DATA_DIR=/data`. On start, `deploy/entrypoint.sh` copies `backend/data/` into the volume with `cp --update=none`: it **never overwrites**. So:
- Tenders, price lists, learned matches and reference data edited in the app survive redeploys.
- Changed reference files in the repo (catalogue, install rules, parameters) do **not** reach production if the volume already has them. Tell the user. Updating them means importing them in the app (Reference data → Import new version) or deliberately replacing the file on the volume. Ask before doing either.

## Roll back

`railway redeploy` only rebuilds the **latest** deployment, so it is no rollback. To roll back, repeat steps 3–6 with the previous good commit (`git log --oneline origin/main`), or use Rollback on the earlier deployment in the Railway dashboard (the "Build Logs" URL from step 5 opens the service). Code rolls back; the volume data does not.
