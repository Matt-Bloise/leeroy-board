#!/usr/bin/env bash
# Runs a browser suite (or the API suite) against a LOCAL site and a LOCAL Worker, so a pull request does not spend Cloudflare Workers Free
# requests (100,000 a day for the whole account) while it is being worked on. Prints how many Worker requests the suite made.
#
#   tools/local-browser.sh <suite> [suite args...]
#     <suite>  one or more (comma separated) of: a file in tests/browser without .mjs (layout-sweep, live-smoke, roster, ...), or
#              api      the API suite (npm run test:api), the only suite that needs the real Worker
#              all      every browser suite, one after the other (degraded-modes with 3 conditions as in CI; DEGRADED_FULL=1 for all)
#              nightly  degraded-modes with all conditions, as nightly-production.yml runs it
#              visual   the visual audit (tests/visual/audit.mjs), stubbed; AUDIT_BUDGET_MIN (default 10) bounds it, the report goes to a temp folder
#              mutation        proves the layout sweep still fails on injected layout bugs (tests/helpers/layout-sweep-mutation.mjs)
#              record-fixtures re-records tests/fixtures/api-snapshot from the local Worker
#     Your own --url <pages url> replaces the default http://127.0.0.1:8080/?preview=1&brain=http://127.0.0.1:8787
#
# What it starts, and stops again BY PID (it never kills by name or port):
#   - a static server for the repo root on 127.0.0.1:$PAGES_PORT (default 8080)   tools/static-server.mjs
#   - `wrangler dev --local` on 127.0.0.1:$API_PORT (default 8787) with a throwaway database in a temp folder
#     (schema.sql, migrations and seed applied there, never the developer's .wrangler state), throwaway secrets generated per run,
#     IS_PR_PREVIEW=true and ALLOWED_ORIGINS including http://127.0.0.1:$PAGES_PORT
# It refuses to start when either port is already in use. Nothing is sent to Cloudflare, Discord or any AI service.
# Environment: PAGES_PORT, API_PORT, LOCAL_BROWSER_SUMMARY=<file> (appends "suite<TAB>requests<TAB>seconds<TAB>exit"), CHROMIUM_PATH, PLAYWRIGHT_BROWSERS_PATH.
# First time: (cd infrastructure && npm install) and (cd tests && npm ci && npx playwright install chromium).
set -u
SUITE="${1:-}"; [ $# -gt 0 ] && shift
[ -n "$SUITE" ] || { sed -n "2,22p" "$0" | sed 's/^# \{0,1\}//'; exit 2; }
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PAGES_PORT="${PAGES_PORT:-8080}"; API_PORT="${API_PORT:-8787}"
PAGES="http://127.0.0.1:$PAGES_PORT"; API="http://127.0.0.1:$API_PORT"
[ -d "$ROOT/infrastructure/node_modules/wrangler" ] || { echo "local-browser: run 'npm install' in infrastructure/ first" >&2; exit 2; }
[ -d "$ROOT/tests/node_modules/playwright" ] || { echo "local-browser: run 'npm ci' in tests/ first" >&2; exit 2; }
# Windows (Git Bash) has no setsid and no process groups: run the command directly (exec keeps the PID) and stop it with its children by Windows PID.
if ! command -v setsid >/dev/null 2>&1; then
  setsid() { exec "$@"; }
  WINKILL="$(cd "$(dirname "$0")" && pwd)/win-kill-tree.ps1"
  winkill() { local w; w="$(cat "/proc/$1/winpid" 2>/dev/null)"; [ -n "$w" ] && powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(cygpath -w "$WINKILL")" "$w" >/dev/null 2>&1; }
fi
inuse() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
for p in "$PAGES_PORT" "$API_PORT"; do inuse "$p" && { echo "local-browser: port $p is already in use; stop that process or set PAGES_PORT / API_PORT" >&2; exit 2; }; done

TMP="$(mktemp -d)"; PIDS=()
stop() { if type winkill >/dev/null 2>&1; then for p in "${PIDS[@]}"; do winkill "$p"; done; fi; for p in "${PIDS[@]}"; do kill -- "-$p" 2>/dev/null || kill "$p" 2>/dev/null; done; sleep 1; for p in "${PIDS[@]}"; do kill -9 -- "-$p" 2>/dev/null; done; rm -rf "$TMP"; }
trap stop EXIT; trap 'exit 130' INT TERM

# the real allow list from wrangler.toml (the API tests check that leeroy.party is allowed and localhost is not) plus the local page origin
ALLOWED="$(sed -n 's/^ALLOWED_ORIGINS = "\(.*\)"/\1/p' "$ROOT/infrastructure/wrangler.toml" | head -1),$PAGES"
TOKEN="$(node -e 'console.log(require("crypto").randomBytes(16).toString("hex"))')"
STATE="$TMP/state"; LOG="$TMP/worker.log"
cd "$ROOT/infrastructure" || exit 2
quiet() { "$@" >"$TMP/step.log" 2>&1 || { echo "local-browser: step failed: $*" >&2; tail -15 "$TMP/step.log" >&2; exit 1; }; }
echo "local-browser: preparing local D1 (schema, migrations, seed) ..."
quiet node node_modules/wrangler/bin/wrangler.js d1 execute leeroy-board-db --local --persist-to "$STATE" --file=./schema.sql
quiet node node_modules/wrangler/bin/wrangler.js d1 migrations apply leeroy-board-db --local --persist-to "$STATE"
D1_PERSIST_TO="$STATE" quiet node scripts/seed-d1.mjs --local

setsid node "$ROOT/tools/static-server.mjs" "$PAGES_PORT" "$ROOT" >"$TMP/static.log" 2>&1 & PIDS+=("$!")
setsid node node_modules/wrangler/bin/wrangler.js dev --local --ip 127.0.0.1 --port "$API_PORT" --persist-to "$STATE" \
  --var "BOARD_ADMIN_TOKEN:$TOKEN" "KEY_SALT:local-key-$TOKEN" "USER_SALT:local-user-$TOKEN" "IS_PR_PREVIEW:true" "ALLOWED_ORIGINS:$ALLOWED" >"$LOG" 2>&1 & PIDS+=("$!")
for i in $(seq 1 90); do
  curl -fs "$API/api/health" >/dev/null 2>&1 && curl -fs "$PAGES/index.html" -o /dev/null 2>&1 && break
  sleep 1; [ "$i" = 90 ] && { echo "local-browser: Worker did not come up; log tail:" >&2; tail -20 "$LOG" >&2; exit 1; }
done

cd "$ROOT/tests" || exit 2
export PREVIEW_API="$API" BOARD_ADMIN_TOKEN="$TOKEN"
# ?preview=1: on a local host the page shows the Discord gate unless it is set (the public hosts skip the gate, so CI does not need it)
URL="$PAGES/?preview=1&brain=$API"
# one suite = one row in the table; several suites (a,b,c or "all") share one local stack
ALLBROWSER="live-smoke"; for f in browser/*.mjs; do n="$(basename "$f" .mjs)"; case "$n" in run|smoke-retry|live-smoke) ;; *) ALLBROWSER="$ALLBROWSER $n";; esac; done
LIST="${SUITE//,/ }"; LIST="${LIST//all/$ALLBROWSER}"
ROWS=(); WORST=0
run_one() {
  local s="$1"; shift; local before secs rc t0 n; before="$(wc -l <"$LOG")"; t0=$(date +%s)
  case "$s" in
    api)     PREVIEW_PAGES="$PAGES" node --test --test-reporter=spec api/api.test.mjs api/contract.test.mjs "$@"; rc=$? ;;
    nightly) PREVIEW_PAGES="$URL" node browser/degraded-modes.mjs --url "$URL" "$@"; rc=$? ;;
    visual)  PREVIEW_PAGES="$URL" AUDIT_OUT="$TMP/visual-audit" node visual/audit.mjs "$URL" "$@"; rc=$? ;;
    mutation) node helpers/layout-sweep-mutation.mjs --url "$URL" "$@"; rc=$? ;;
    record-fixtures) node helpers/record-api-snapshot.mjs --url "$URL" "$@"; rc=$? ;;
    *)       [ -f "browser/$s.mjs" ] || { echo "local-browser: no suite tests/browser/$s.mjs" >&2; return 2; }
             local extra=(); [ "$s" = degraded-modes ] && [ "${DEGRADED_FULL:-0}" != 1 ] && [ "$SUITE" != degraded-modes ] && extra=(--only api-abort,api-500,no-js)
             local a=("$@" "${extra[@]}"); case " $* " in *" --url "*) ;; *) a+=(--url "$URL");; esac
             PREVIEW_PAGES="$URL" node "browser/$s.mjs" "${a[@]}"; rc=$? ;;
  esac
  secs=$(( $(date +%s) - t0 )); sleep 1
  node "$ROOT/tools/local-requests.mjs" "$LOG" "$before" >"$TMP/req.txt"
  n="$(sed -n 's/^Worker requests: //p' "$TMP/req.txt")"
  echo; echo "== $s: exit $rc, ${secs}s =="; cat "$TMP/req.txt"
  ROWS+=("$(printf '%-18s %9s %8s  %s' "$s" "$n" "$secs" "$rc")")
  [ -n "${LOCAL_BROWSER_SUMMARY:-}" ] && printf '%s\t%s\t%s\t%s\n' "$s" "$n" "$secs" "$rc" >>"$LOCAL_BROWSER_SUMMARY"
  [ "$rc" -gt "$WORST" ] && WORST="$rc"
}
for s in $LIST; do run_one "$s" "$@"; done
if [ "${#ROWS[@]}" -gt 1 ]; then echo; echo "== local-browser summary =="; printf '%-18s %9s %8s  %s\n' suite requests seconds exit; printf '%s\n' "${ROWS[@]}"; fi
exit "$WORST"
