#!/usr/bin/env bash
# Rebuilds the preview Worker host for the CURRENT JOB from the base64 of the account subdomain, and keeps it out of every log.
# The account's workers.dev subdomain carries a personal name, so it is never passed between jobs in clear (a job output that contains a MASKED value is dropped by GitHub; artifacts are downloadable by any signed-in user).
# The preview-secrets job (the only job of Preview Tests that holds the Cloudflare token) reads it from the Cloudflare API, masks it, and hands on only its base64 as a job output; each job that needs the host
# decodes it here, masks the subdomain and the host BEFORE anything else, and writes (to $GITHUB_ENV, this job only)
#   PREVIEW_API=https://leeroy-brain-pr-<N>.<subdomain>.workers.dev   and   PREVIEW_SUBDOMAIN=<subdomain>
# usage: tools/preview-worker-url.sh <pr-number>      env: PREVIEW_SUBDOMAIN_B64 (needs.preview.outputs.sub_b64)
set +x
set -u
PR="${1:-}"
case "$PR" in ''|*[!0-9]*) echo "::error::usage: preview-worker-url.sh <pr-number>"; exit 2;; esac
SUB=$(printf '%s' "${PREVIEW_SUBDOMAIN_B64:-}" | base64 -d 2>/dev/null) || SUB=""
if ! printf '%s' "$SUB" | grep -qE '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'; then
  echo "::error::The account workers.dev subdomain did not arrive from the preview-secrets job (it reads it with the Cloudflare token: the permission Workers Scripts: Read is needed). Nothing was guessed."
  exit 1
fi
echo "::add-mask::$SUB"
HOST="leeroy-brain-pr-${PR}.${SUB}.workers.dev"
echo "::add-mask::$HOST"
echo "::add-mask::https://$HOST"
{ echo "PREVIEW_SUBDOMAIN=$SUB"; echo "PREVIEW_API=https://$HOST"; } >> "$GITHUB_ENV"
echo "Preview Worker host rebuilt for this job (host and subdomain masked)."
