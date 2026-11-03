#!/usr/bin/env bash
# Lists the NAMES (never values) of repository-level Actions secrets and flags production secrets that are still there.
# Usage: gh auth login   (once, as a repo admin), then: tools/check-secret-scope.sh [owner/repo]
# Exit 0 only when no production secret remains at repository level. See docs/runbooks/ci-secrets.md.
set -u
REPO="${1:-Matt-Bloise/leeroy-board}"
# MUST be environment-only. USER_SALT, KEY_SALT (not credentials of a third party) and AI_GATEWAY_TOKEN (Uncle Jimmy's) deliberately stay at repository level: a job with
# environment: production still reads repository secrets the environment does not have, and the deploy keeps the existing Worker value when a secret is empty.
ACCEPTED="USER_SALT KEY_SALT AI_GATEWAY_TOKEN"
PROD="CLOUDFLARE_API_TOKEN BOARD_ADMIN_TOKEN CLOUDFLARE_AIG_TOKEN ANTHROPIC_API_KEY GEMINI_API_KEY GROQ_API_KEY CEREBRAS_API_KEY GITHUB_MODELS_TOKEN OPENROUTER_API_KEY DISCORD_WEBHOOK_URL DISCORD_PUBLIC_KEY DISCORD_CLIENT_SECRET DISCORD_BOT_TOKEN"
command -v gh >/dev/null || { echo "gh is not installed" >&2; exit 2; }
if ! REPO_NAMES=$(gh api --paginate "repos/$REPO/actions/secrets" --jq '.secrets[].name'); then echo "Could not list repository secrets (needs admin access)." >&2; exit 2; fi
echo "Repository-level secrets in $REPO:"; echo "${REPO_NAMES:-  (none)}" | sed 's/^/  /'
if ENV_NAMES=$(gh api --paginate "repos/$REPO/environments/production/secrets" --jq '.secrets[].name' 2>/dev/null); then
  echo "Secrets in environment 'production':"; echo "${ENV_NAMES:-  (none)}" | sed 's/^/  /'
else
  echo "Environment 'production' not found or not readable: S1 stays open." >&2
fi
LEFT=""
for N in $PROD; do echo "$REPO_NAMES" | grep -qx "$N" && LEFT="$LEFT $N"; done
for N in $ACCEPTED; do echo "$REPO_NAMES" | grep -qx "$N" && echo "ACCEPTED at repository level (readable by PR workflow runs, not used by them): $N"; done
if [ -n "$LEFT" ]; then echo "STILL AT REPOSITORY LEVEL (delete them after the environment copies exist):$LEFT"; exit 1; fi
echo "OK: no production credential is stored at repository level (except the accepted ones listed above)."
