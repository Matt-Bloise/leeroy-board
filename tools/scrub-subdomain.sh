#!/usr/bin/env bash
# Replaces any <name>.<subdomain>.workers.dev host in text files that are about to be uploaded as artifacts (logs written by tee carry what the test process printed, not what the runner masked).
# Pattern-based, so a job that does not know the subdomain (the ZAP job holds no Cloudflare token) can scrub too. Also replaces the exact subdomain when PREVIEW_SUBDOMAIN is set.
# usage: tools/scrub-subdomain.sh <file-or-dir>...      Binary files are left alone; the proof is a grep over the run's artifacts.
set +x
SUB="${PREVIEW_SUBDOMAIN:-}"
if [ -n "$SUB" ] && ! printf '%s' "$SUB" | grep -qE '^[a-z0-9-]+$'; then echo "::error::refusing an odd PREVIEW_SUBDOMAIN"; exit 1; fi
N=0
for target in "$@"; do
  [ -e "$target" ] || continue
  while IFS= read -r f; do
    sed -i -E 's#\.[a-z0-9-]+\.workers\.dev#.<account-subdomain>.workers.dev#g' "$f"
    [ -z "$SUB" ] || sed -i "s/$SUB/<account-subdomain>/g" "$f"
    N=$((N + 1))
  done < <(grep -rIlE '\.[a-z0-9-]+\.workers\.dev' "$target" 2>/dev/null; [ -z "$SUB" ] || grep -rIl -F -- "$SUB" "$target" 2>/dev/null)
done
echo "Scrubbed $N file(s) before upload."
