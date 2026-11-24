#!/usr/bin/env bash
# Runs the live deploy smoke against production and PROVES the browser checks ran: exit 0 only when the smoke exited 0 AND its log holds the Chromium and the WebKit "first screen renders" PASS lines
# and a "0 failed" total. A smoke that exits 0 without those lines (an engine skipped, a changed script) fails here with exit 3, so a missing browser can never read as a pass.
# Used by the post-deploy-smoke job in deploy-cloudflare.yml and by production-smoke.yml. Run from the repository root after `npm ci` in tests/. Needs bash, node, tee, grep.
# Usage: tools/production-smoke.sh <site origin>      Env: RUNNER_TEMP (log folder), GITHUB_STEP_SUMMARY (optional), SMOKE_REQUIRE_ENGINES, PREVIEW_API (read by the smoke).
set -o pipefail
URL="${1:?usage: tools/production-smoke.sh <site origin>}"
LOG="${RUNNER_TEMP:-/tmp}/deploy-smoke.log"
SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/null}"
RC=0
(cd tests && node browser/deploy-smoke.mjs --url "$URL") 2>&1 | tee "$LOG" || RC=$?

MISSING=""
for want in "PASS chromium: the first screen renders with the live API" "PASS webkit: the first screen renders with the live API" "deploy-smoke: [0-9]* passed, 0 failed"; do
  grep -qE "^$want" "$LOG" || MISSING="$MISSING; $want"
done
if [ "$RC" -eq 0 ] && [ -n "$MISSING" ]; then
  RC=3
  echo "::error title=Post-deploy smoke did not prove the browsers ran::The smoke exited 0 but its log lacks:${MISSING#;}"
fi

if [ "$RC" -ne 0 ]; then
  # B62: the post-deploy job is non-blocking (continue-on-error), so keep the failure visible: annotation + step summary listing the failed checks.
  echo "::error title=Post-deploy smoke failed (non-blocking)::Smoke exited $RC; the deploy is not affected. See the job summary and the deploy-smoke-log artifact."
  {
    echo "## Smoke failed (exit $RC)"
    echo
    echo "The deploy and its health check are not affected."
    echo
    echo '```'
    grep -E '^(FAIL|WARN)' "$LOG" | head -40 || true
    echo '```'
  } >> "$SUMMARY"
else
  {
    echo "## Smoke passed, browsers ran"
    echo
    echo '```'
    grep -E '^(PASS|deploy-smoke:)' "$LOG" | head -40 || true
    echo '```'
  } >> "$SUMMARY"
fi
exit "$RC"
