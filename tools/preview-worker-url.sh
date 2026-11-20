#!/usr/bin/env bash
# Rebuilds the preview Worker host for the CURRENT JOB from the ENCRYPTED account subdomain, and keeps it out of every log.
# The account's workers.dev subdomain carries a personal name, so it is never passed between jobs in clear (a job output that contains a MASKED value is dropped by GitHub; artifacts are downloadable by any signed-in user).
# The preview-secrets job (the only job of Preview Tests that holds the Cloudflare token) reads it from the Cloudflare API, masks it, and hands on only its AES-256 encryption (key: the preview-only secret BOARD_PREVIEW_ADMIN_TOKEN) as a job output; base64 and hex do not work: the runner masks base64 and drops the output, and hex shows in clear in the env block of every step; each job that needs the host
# decodes it here, masks the subdomain and the host BEFORE anything else, and writes (to $GITHUB_ENV, this job only)
#   PREVIEW_API=https://leeroy-brain-pr-<N>.<subdomain>.workers.dev   and   PREVIEW_SUBDOMAIN=<subdomain>
# usage: tools/preview-worker-url.sh <pr-number>      env: PREVIEW_SUBDOMAIN_ENC (needs.preview.outputs.sub_enc), PREVIEW_KEY (secrets.BOARD_PREVIEW_ADMIN_TOKEN)
set +x
set -u
PR="${1:-}"
case "$PR" in ''|*[!0-9]*) echo "::error::usage: preview-worker-url.sh <pr-number>"; exit 2;; esac
# The key is NOT the raw secret: PASS = HMAC-SHA256(key = BOARD_PREVIEW_ADMIN_TOKEN, message = a fixed label), so the ciphertext is not a direct verifier of the token; pbkdf2 with at least 200,000 iterations and a random salt per run.
# The scheme is only as strong as the secret: it fails closed when the secret is missing (a fork PR has no secrets) or shorter than 32 characters. Nothing here prints the secret, the passphrase, the host or the subdomain.
if [ "${#PREVIEW_KEY}" -lt 32 ]; then
  echo "::error::The preview secret needed to unlock the Worker host is missing or too short (a fork PR has no secrets; the secret must be a random value of at least 32 characters). Nothing was guessed."
  exit 1
fi
PASS=$(printf '%s' 'leeroy-preview-subdomain-v1' | openssl dgst -sha256 -hmac "$PREVIEW_KEY" -r | cut -d' ' -f1)
SUB=$(printf '%s' "${PREVIEW_SUBDOMAIN_ENC:-}" | PASS="$PASS" openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -a -A -pass env:PASS 2>/dev/null) || SUB=""
PASS=""
if ! printf '%s' "$SUB" | grep -qE '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'; then
  echo "::error::The account workers.dev subdomain did not arrive from the preview-secrets job (it reads it with the Cloudflare token: the permission Workers Scripts: Read is needed; it hands it on encrypted with BOARD_PREVIEW_ADMIN_TOKEN). Nothing was guessed."
  exit 1
fi
echo "::add-mask::$SUB"
HOST="leeroy-brain-pr-${PR}.${SUB}.workers.dev"
echo "::add-mask::$HOST"
echo "::add-mask::https://$HOST"
{ echo "PREVIEW_SUBDOMAIN=$SUB"; echo "PREVIEW_API=https://$HOST"; } >> "$GITHUB_ENV"
echo "Preview Worker host rebuilt for this job (host and subdomain masked)."
