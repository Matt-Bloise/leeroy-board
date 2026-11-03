#!/usr/bin/env bash
# Run everything CI runs for a Worker change, on this machine, with no Cloudflare account, no secrets and no AI calls.
#   1. unit tests            node --test tests/unit/*.test.mjs
#   2. local D1              migrations + seed into a throwaway local database (.wrangler/ state, git-ignored)
#   3. the Worker            npx wrangler dev --local on 127.0.0.1:8787 with a throwaway .dev.vars
#   4. the API suite         tests/ npm run test:api against that Worker
#   5. stop wrangler by PID, and remove the throwaway .dev.vars
# The two "Pages:" header checks fetch https://leeroy.party over the internet; offline they fail with ENOTFOUND (nothing to do with the Worker).
# Needs Node 22+, npm access once (wrangler and the tests' devDependencies), about a minute. SKIP_API=1 stops after step 1.
# The tokens below are random per run and exist only for this run. Nothing here reads or sets a real secret.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-8787}"
cd "$ROOT"

echo "== 1/4 unit tests"
node --test tests/unit/*.test.mjs
[ "${SKIP_API:-}" = "1" ] && { echo "SKIP_API=1: done after unit tests"; exit 0; }

cd "$ROOT/infrastructure"
[ -d node_modules ] || npm install --no-audit --no-fund
[ -f .dev.vars ] && { echo "refusing to overwrite an existing infrastructure/.dev.vars; move it away first"; exit 1; }
rand() { node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"; }
TOKEN="$(rand)"
printf 'BOARD_ADMIN_TOKEN=%s\nKEY_SALT=%s\nUSER_SALT=%s\nIS_PR_PREVIEW=true\n' "$TOKEN" "$(rand)" "$(rand)" > .dev.vars
LOG="$ROOT/infrastructure/.wrangler/dev.log"; mkdir -p "$(dirname "$LOG")"
WRANGLER_PID=""
cleanup() {
  [ -n "$WRANGLER_PID" ] && kill "$WRANGLER_PID" 2>/dev/null || true
  [ -n "$WRANGLER_PID" ] && wait "$WRANGLER_PID" 2>/dev/null || true
  rm -f "$ROOT/infrastructure/.dev.vars"
}
trap cleanup EXIT

echo "== 2/4 local D1: migrations and seed"
npx wrangler d1 execute leeroy-board-db --local --file=./schema.sql >/dev/null
npx wrangler d1 migrations apply leeroy-board-db --local
node ./scripts/seed-d1.mjs --local

echo "== 3/4 wrangler dev --local on port $PORT"
# Started without the npx wrapper so $! is wrangler itself: killing a wrapper would leave wrangler and workerd running.
./node_modules/.bin/wrangler dev --local --port "$PORT" > "$LOG" 2>&1 &
WRANGLER_PID=$!
for _ in $(seq 1 60); do
  curl -fs "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break
  kill -0 "$WRANGLER_PID" 2>/dev/null || { echo "wrangler exited early:"; tail -30 "$LOG"; exit 1; }
  sleep 1
done
curl -fs "http://127.0.0.1:$PORT/api/health" >/dev/null || { echo "Worker did not answer in 60 s:"; tail -30 "$LOG"; exit 1; }

echo "== 4/4 API suite"
cd "$ROOT/tests"
[ -d node_modules ] || npm install --no-audit --no-fund
PREVIEW_API="http://127.0.0.1:$PORT" PREVIEW_PAGES="https://leeroy.party" BOARD_ADMIN_TOKEN="$TOKEN" npm run test:api
echo "local check passed"
