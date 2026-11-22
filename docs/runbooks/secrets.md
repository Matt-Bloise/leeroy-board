# Runbook: secrets and variables

> Where each secret lives (GitHub environment `production` vs repository) and how to move them: [ci-secrets.md](ci-secrets.md).

Names only. Never put a value in the repository, an issue, a PR, a log or a chat. Last checked: 2026-11-02. Citations are `file:line`, or marked (unverified). "Owner" means the repository and Cloudflare account owner; who actually holds those admin rights is unverified.

## Inventory

### Set in GitHub Actions secrets, used by workflows

| Name | Used at | Purpose |
| :--- | :--- | :--- |
| `CLOUDFLARE_API_TOKEN` | `deploy-cloudflare.yml:86`; `pr-preview-cloudflare.yml:110,136,505`; `preview-tests.yml:136`; `roster-upsert.yml:38`; `pages-prune.yml:49,59` | Wrangler and API calls for Worker, D1, Pages, domains. Scopes the workflow checks: D1 Edit, Pages Edit (the check prints it as a hint), Zone Read for the production zone (`deploy-cloudflare.yml:216-233,235-271`) |
| `CLOUDFLARE_ACCOUNT_ID` | `deploy-cloudflare.yml:87`; `pr-preview-cloudflare.yml:112,137,506`; `preview-tests.yml:138`; `roster-upsert.yml:39`; `pages-prune.yml:50` | Account selector |
| `BOARD_PREVIEW_ADMIN_TOKEN` | `pr-preview-cloudflare.yml:111,396`; `preview-tests.yml:137,303` and the other preview jobs there | Preview-only base value. Each preview Worker's `BOARD_ADMIN_TOKEN`, `USER_SALT` and `KEY_SALT` are derived from it, and the API tests derive the admin token the same way. Never a production value |
| `BOARD_ADMIN_TOKEN` | `deploy-cloudflare.yml:98,431` | Production admin token. Lives in the GitHub environment `production` (`ci-secrets.md`); not used by previews or the preview tests |
| `github.token` (automatic) | `preview-tests.yml:58,186`; `pr-preview-cloudflare.yml:73` | PR comments; not a stored secret |

### GitHub secrets copied to Worker secrets on every production deploy

Loop at `deploy-cloudflare.yml:439`, each skipped when empty (`:441`), set with `wrangler secret put` (`:442`):

`AI_GATEWAY_TOKEN` (from the secret `AI_GATEWAY_TOKEN` or `CLOUDFLARE_AIG_TOKEN`, `:424`; see the last section), `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `GITHUB_MODELS_TOKEN`, `OPENROUTER_API_KEY`, `BOARD_ADMIN_TOKEN`, `DISCORD_WEBHOOK_URL`, `DISCORD_PUBLIC_KEY`, `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN`, `USER_SALT`, `KEY_SALT`.

The production deploy stops before replacing the Worker when the `USER_SALT` or `KEY_SALT` repository secret is empty. Previews get their own salts: `pr-preview-cloudflare.yml:393-412` sets `USER_SALT`, `KEY_SALT` and `BOARD_ADMIN_TOKEN` with `wrangler secret put`, each derived as HMAC-SHA256 of `preview:<NAME>:<preview Worker name>` keyed by the repository secret `BOARD_PREVIEW_ADMIN_TOKEN` (distinct per preview and from production; no production secret is read or copied). A missing salt makes the Worker answer 503 `salt_not_configured` on guest asks, votes and account routes, and refuse member keys; it does not crash. Admin `GET /api/health` lists `saltsMissing` (names only).

Consumers in the Worker: AI keys `infrastructure/worker/ai-models.js:207-231` (the Anthropic key through `ai-keys.js:273,318`); AI Gateway token `ai-models.js:421`, `ai-keys.js:259`; admin token `index.js:92,101-105`; webhook `index.js:961-962`, `ai-models.js:1738-1740`; public key `discord.js:755,765`; client secret `account.js:88,100`, `index.js:1256`, `web-auth.js:90,96`; bot token `index.js:717,739`.

### Plain variables (public, committed) in `infrastructure/wrangler.toml` `[vars]` (lines 60-108)

`AI_PROVIDER`, `AI_GATEWAY_ID`, `AI_GATEWAY_CACHE_TTL`, `CLOUDFLARE_ACCOUNT_ID` (empty), `CLAUDE_MODEL_FAST`, `CLAUDE_MODEL_DEEP`, `RESEARCH_CLAUDE_MODEL_FAST`, `RESEARCH_CLAUDE_MODEL_DEEP`, `RESEARCH_CLAUDE_FALLBACK_FAST`, `RESEARCH_CLAUDE_FALLBACK_DEEP`, `RESEARCH_CLAUDE_MONTHLY_TOKENS`, `RESEARCH_NAMES`, `GEMINI_MODEL_FAST`, `GEMINI_MODEL_DEEP`, `WORKERS_AI_MODEL`, `GROQ_MODEL_FAST`, `GROQ_MODEL_DEEP`, `CEREBRAS_MODEL`, `GITHUB_MODEL_FAST`, `GITHUB_MODEL_DEEP`, `OPENROUTER_MODEL`, `API_ORIGIN`, `BOARD_PUBLIC_URL`, `ALLOWED_ORIGINS`, plus the flags declared there (`D1_FEED`, `CHARS_V1`, `ASK_OPENER`, `ASK_RESEARCH`, `GROUP_MEMORY`, `LISTENER`, `SHADOW_ASK`, `GAME_FACTS_LOAD`, `GAME_FACTS_READ`, `PROMPT_PREFIX_ORDER`, `GAME_FACTS_COMPOSE`, `INTEREST_NUDGES`, `REQUEST_GAUGE`). `ANTHROPIC_BYOK` is not declared there (absent means off; only exact `"on"` or `"off"` is read; `flags.md`, Optional flags).

Added to previews only by the workflow: `IS_PR_PREVIEW`, `WORKER_NAME` (`pr-preview-cloudflare.yml:305-307`). The preview `BOARD_ADMIN_TOKEN` is a Worker secret, not a var (`:363,406-410`).

### Read by the code but not set in the repository

| Name | Read at | Note |
| :--- | :--- | :--- |
| `DISCORD_CLIENT_ID` | `account.js:87`; `index.js:1255`; `web-auth.js:68,90` | Not in `wrangler.toml` or any workflow. `account.js:87` and `index.js:1255` fall back to the public Discord app id when it is unset (`account.js` no longer returns 500), so `POST /auth/discord` and `POST /token` work without it. The web login routes have no fallback: without it they answer 503 (`web-auth.js:68,90`). |
| `AI_DAILY_NEURON_CAP` | `budget.js:45` | Optional budget override |
| `DATA_RIGHTS` | `data-rights.js` (`dataRightsOn`) | Not declared in `wrangler.toml` (absent means off; `flags.md`, Optional flags). Q59: `"on"` enables `GET /api/me/export` and `POST /api/me/erase` for a member key or a web session cookie. While off both answer 404. Needs `USER_SALT`. Roll back by setting it to `"off"`. |
| `CHARS_V1` | `characters-api.js` (`charsOn`) | Plain var in `wrangler.toml`, default `"off"`. Character switcher: `"on"` adds `characters` and `selected` to `GET /api/me` for a web session and enables `POST /api/me/characters` (add, rename, select). While off the route answers 404 and `/api/me` is unchanged. Needs `WEB_LOGIN` on and migration 0005. The board also needs the client flag `chars.v1` in `data/client.json`. Roll back by setting it to `"off"`; the rows stay. |
| `REQUEST_GAUGE` | `gauge.js` | Plain var in `wrangler.toml`, default `"off"`. `"on"` makes the Worker count its own requests per UTC day (in memory, written to D1 table `request_gauge` about every 25 requests) and enables `GET /api/admin/requests` (admin token; 404 while off). While off, a request costs one string comparison and no D1 access. Needs migration 0008. An approximation: the Cloudflare dashboard stays the source of truth (`cloudflare-requests.md`). Roll back by setting it to `"off"`; the rows stay. |
| `WEB_LOGIN` | `web-auth.js` (`webLoginOn`) | Not declared in `wrangler.toml` (absent means off; `flags.md`, Optional flags). Q18 web Discord login: `"on"` enables `GET /api/auth/discord/start`, `GET /api/auth/discord/callback`, `POST /api/auth/logout` and cookie sessions on `GET /api/me`. While off, those routes answer 404 and cookies are ignored. |

### Where the Anthropic (Claude) credential comes from

One resolver, `infrastructure/worker/ai-keys.js` (`anthropicAuth`), picks the route in this order. Owner's rule: the key is stored safely in Cloudflare and fetched from a variable; it is never pasted plainly into the repo, `wrangler.toml`, a log or a chat.

| Order | Route | How | Where the key lives |
| :--- | :--- | :--- | :--- |
| 1 (preferred) | AI Gateway BYOK | `ANTHROPIC_BYOK = "on"` in `wrangler.toml` `[vars]` (default `"off"`). The owner adds the key in the Cloudflare dashboard (AI Gateway, Provider Keys; the exact path is unverified). | Inside the gateway, so it need not be in the Worker. That holds only once the Worker secret is gone: see the cleanup step below. Requests carry `cf-aig-authorization` and no `x-api-key`, with `redirect: "manual"`; the gateway must be authenticated. The direct `api.anthropic.com` fallback is disabled for this route (it would be unauthenticated); a gateway failure falls back to Workers AI. Plan availability of BYOK is unverified. |
| 2 | Secrets Store | Uncomment the `[[secrets_store_secrets]]` block in `wrangler.toml` (binding `ANTHROPIC_KEY_STORE`, your `store_id`, `secret_name`). Cloudflare describes Secrets Store as open beta (not verified by this repo); production only. Read with `await env.ANTHROPIC_KEY_STORE.get()`. | In the Cloudflare Secrets Store. An empty, invalid, failing or slow read falls through to route 3. |
| 3 (legacy) | Worker secret | `ANTHROPIC_API_KEY`, copied from the GitHub secret on deploy (above). | In the Worker secret store. Leading and trailing whitespace (a trailing newline from `printf`, a pasted space) is trimmed and the trimmed value is sent, as the header layer did before; interior whitespace or control characters, or over 512 characters, mean not configured. |

**Exact flag.** Only the exact strings `"on"` and `"off"` are read. Any other non-empty value (`"ON"`, `" on"`, `"true"`, `"1"`) logs one warning per isolate and is treated as off. BYOK also needs `CLOUDFLARE_ACCOUNT_ID`, `AI_GATEWAY_ID` and `AI_GATEWAY_TOKEN` present with no whitespace; otherwise Claude counts as unavailable and a forced call throws before any request.

**Store reads.** `get()` is raced against a 1.5 second timeout and shared by concurrent callers (one read per binding at a time). A good key is cached 5 minutes; a failure, timeout or empty value is cached 30 seconds, so a broken store does not cost every ask a read. A key with whitespace or control characters counts as not configured. Rotation lag is up to 5 minutes per isolate; a 401 or 403 from Anthropic clears the cached store key so the next ask re-reads it.

**Presence check.** Provider selection uses `anthropicAvailable`, which never reads the store: BYOK on with its prerequisites, or a store binding that is not known bad, or a valid legacy secret.

**Cleanup after BYOK is proven.** `.github/workflows/deploy-cloudflare.yml` (the env block and the secret loop, about lines 420 to 446) puts `ANTHROPIC_API_KEY` as a Worker secret on a deploy only when the GitHub secret is non-empty; an empty or missing GitHub secret is skipped, and the loop never deletes a Worker secret that is already there. BYOK with that GitHub secret still set therefore leaves the key in the Worker, and deleting the GitHub secret does not remove the existing Worker copy (`wrangler secret delete` does). After one real `/ask` reports provider `claude` through BYOK: delete the GitHub secret (`gh secret delete ANTHROPIC_API_KEY --repo <owner>/leeroy-board`), remove `ANTHROPIC_API_KEY` from the env block and the secret loop in that workflow, and run `npx wrangler secret delete ANTHROPIC_API_KEY --name leeroy-brain`.

**Scrub limits.** The key is not logged, and is not put in an error string, trace row, response, cache key or metadata header by this code. Claude errors carry the HTTP status only (no provider body); `eval.js` `RATE_LIMIT_RE` depends only on the status text `429` in that message, which is still present. A defensive scrub runs on Claude errors (message, name, stack, code, cause chain), the gateway warning and the 200 answer. No regex is built from the key, text is capped at 20,000 characters (the rest is cut, not passed through) and the work is linear. For the key the Worker actually sent it removes: the exact value, the last 8 characters, the `sk-ant-` pattern (8 or more following characters, word boundary), and any text containing a 12-character window of the key in canonical form. Canonical form folds fullwidth letters, ignores case and drops everything but letters and digits, so separators of any kind (spaces, NULs, zero-width characters, commas, backslashes, quotes, markdown escapes, dashes, dots) do not hide a window. The windows come from the key, its reverse, rot13, base64 and base32 at every byte alignment (also of the UTF-16 bytes), hex and character-code forms (plain, `x`, `0x`, `%25`, unicode-escape and decimal prefixes), escaped-dash variants, and the reverse of each. A hit redacts the window plus 11 characters on each side. Values over 512 characters are treated as not configured.

What it does not cover: a key the Worker never sent (under BYOK only the `sk-ant-` pattern applies); fragments under 12 characters (the last 8 characters are caught only as the exact tail); transformations that are not listed (encryption, XOR, a custom alphabet, a key split into non-adjacent pieces that are each under 12 characters, text deliberately reordered); encodings of the escaped-dash variants other than the four listed; 8 to 11 character fragments of the middle of the key; text past the 20,000-character cap is removed rather than checked. Other providers' errors are reduced to a status by `shortProviderError`, but their own thrown messages are not scrubbed for their own keys.

VAREN checks only that the route exists, never the value: `ANTHROPIC_BYOK` is `"on"` in `wrangler.toml`, or the binding `ANTHROPIC_KEY_STORE` is declared, or `wrangler secret list --name leeroy-brain` shows the name `ANTHROPIC_API_KEY`. Whether the gateway or store really holds a working key is verified only by one real `/ask` that reports provider `claude`.

### Cloudflare-side state with no repository record

Worker secrets live in Cloudflare; list names (not values) with `cd infrastructure && npx wrangler secret list --name leeroy-brain`. D1 private rows (`persona`, `name_map`, `discord_members`, `discord_roster`, `vocab`) are data, not secrets, but are equally private (`backup-restore.md`). Member keys are never stored, only `sha256(KEY_SALT:key)` (`auth.js:15-17`); sessions are stored hashed (`account.js`, `schema.sql:167-173`).

## Who may rotate, and how

All rotations are the owner's, because they need Cloudflare or GitHub admin rights and the third-party provider accounts. The partner contributes through PRs and has no need for secret access.

General order: create the new value at the provider, update the GitHub Actions secret (Settings, Secrets and variables, Actions, or `gh secret set NAME --repo <owner>/leeroy-board`, value from stdin), then trigger a deploy so the Worker copy updates, then revoke the old value.

| Secret | Rotation steps | Side effects |
| :--- | :--- | :--- |
| `CLOUDFLARE_API_TOKEN` | Create a new token in the Cloudflare dashboard with the scopes above; set the GitHub secret; re-run any workflow to see the pre-flight check pass (`deploy-cloudflare.yml:140-272`); delete the old token. | Not stored in the Worker. Replace immediately if exposed: it can alter or delete production. |
| `CLOUDFLARE_ACCOUNT_ID` | Not secret in effect; change only if the account changes. | |
| `BOARD_ADMIN_TOKEN` | Generate a long random value; update the GitHub secret; deploy (production gets it via `wrangler secret put`). Previews are unaffected: they derive their own admin token from `BOARD_PREVIEW_ADMIN_TOKEN`. Update the owner's password manager and any operator tools. | Old token stops working at once on production admin routes. |
| `ANTHROPIC_API_KEY` (legacy route) | New key at Anthropic; GitHub secret; deploy; revoke old key. Secrets Store route: update the store secret; each isolate picks it up within 5 minutes (sooner after a 401 or 403). BYOK: replace the key in the gateway dashboard; no deploy. | See "Where the Anthropic (Claude) credential comes from". |
| `GEMINI_API_KEY`, `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `GITHUB_MODELS_TOKEN`, `OPENROUTER_API_KEY` | New key at the provider; GitHub secret; deploy; revoke old key. | A provider with no key is skipped by selection logic (`ai-models.js:207-255`); confirm with admin `GET /api/health`. |
| `DISCORD_BOT_TOKEN` also signs the listener | There is no separate listener secret. The listener's request-signing key is derived from `DISCORD_BOT_TOKEN` (`HMAC-SHA256(token, "leeroy-listener-v1")`, `listener.md`), so the PC forwarder derives the same key from the bot token it already holds. | Rotating the bot token changes the key: update the Worker secret and the forwarder together, or every event is a 401 until they match; with `LISTENER` off nothing is affected |
| `DISCORD_WEBHOOK_URL` | Recreate the webhook in Discord; update secret; deploy; delete the old webhook. | Posts use the new URL after the deploy |
| `DISCORD_PUBLIC_KEY` | Comes from the Discord developer portal; changes only if the application changes. | Interactions fail signature checks until it matches (`discord.js:755,765`) |
| `DISCORD_CLIENT_SECRET` | Reset in the developer portal; update secret; deploy. | Login and Activity code exchange fail until deployed |
| `DISCORD_BOT_TOKEN` | Reset in the developer portal; update secret; deploy. | `POST /announce` fails until deployed (`index.js:717,739`) |
| `KEY_SALT`, `USER_SALT` | Do not rotate casually. Set the new value as the GitHub repository secret and deploy; previews are not affected (their salts derive from `BOARD_PREVIEW_ADMIN_TOKEN`). For the full procedure see `rotate-salts.md`. Changing `KEY_SALT` changes every member key hash (`auth.js:16`), so every member key stops working until it is re-issued: for each member run `KEY_SALT=<new> node infrastructure/scripts/hash-key.mjs <slug>` (key on stdin) and apply the INSERT it prints with `wrangler d1 execute`. Changing `USER_SALT` changes every derived per-user key (`account.js:41`), orphaning saved user state, and invalidates vote ballot hashes and guest rate-limit rows. Both must stay at least 16 characters or the Worker refuses the dependent routes. Never use the old public values (they were in git history). | Plan it as a SEV2 change window. Members are locked out until their hashes are replaced. |

Caveat that matters for every row: syncing never deletes. If a GitHub secret is emptied or removed, the loop skips it (`deploy-cloudflare.yml:441`) and the old Worker secret stays. Remove it with `npx wrangler secret delete <NAME> --name leeroy-brain`.

After any rotation: check `gh run list`, `GET /api/health`, and one call that uses the rotated value. Record the date (not the value) in the owner's private notes.

## Known weaknesses today

Re-checked 2026-11-19 against the repository, `gh api` and `git log`; the 2026-11-02 list is replaced by this one.

| # | Weakness | State now | Owner |
| :-- | :--- | :--- | :--- |
| 1 | `KEY_SALT` and `USER_SALT` were public plain variables | Fixed for the variables: Worker secrets since #73 (merged 2026-11-02), absent from `wrangler.toml`. Open: the old values remain in git history, so the salts are not yet rotated (`rotate-salts.md`) | the account admin |
| 2 | Preview passed the production `BOARD_ADMIN_TOKEN` as a `--var` | Fixed in #140 and #147: previews use `BOARD_PREVIEW_ADMIN_TOKEN` and derived values (`pr-preview-cloudflare.yml` comment at line 363) | none |
| 3 | Same-repository PR workflows read production secrets | Partly fixed (#147): production credentials moved to environment `production`. Open: `CLOUDFLARE_API_TOKEN`, `USER_SALT`, `KEY_SALT`, `AI_GATEWAY_TOKEN` stay at repository level by decision (`ci-secrets.md`) | the owner, the account admin |
| 4 | No branch protection on `master` | Fixed by a setting, not a PR: ruleset `master-required-checks` is active (required PR, status checks `unit`, `scope`, `stamps`, `report`, no deletion or force-push). Open: required approvals are 0, so no human review is enforced; the classic protection API still returns 404 | the owner |
| 5 | One Cloudflare token for deploy, previews and teardown | Open by decision (`ci-secrets.md`, "Previews share the production Cloudflare token"); teardown derives names from `leeroy-brain-pr-<number>` but has no explicit prefix guard (unverified beyond reading the step) | the account admin |
| 6 | Production workflow has no `permissions:` block | Fixed: `deploy-cloudflare.yml` declares `contents: read` (#140); the repository default workflow permission is `read` (`gh api repos/Matt-Bloise/leeroy-board/actions/permissions/workflow`) | none |
| 7 | Actions pinned by tag | Fixed: every `uses:` in `.github/workflows` is a 40-character sha (`grep -n "uses:" .github/workflows/*.yml` shows no tag), introduced with #140 | none |
| 8 | Secret list drift | Fixed in the docs: `ci-secrets.md` has the secret map and `infrastructure/README.md` names `DISCORD_BOT_TOKEN`; the count is unverified (`grep -c` the README list against the deploy loop) | none |
| 9 | `DISCORD_CLIENT_ID` has no single source | Open: `account.js:81` and `index.js:1255` still hold the same literal fallback, nothing in `wrangler.toml` | the owner |
| 10 | Secrets removed from GitHub stay in the Worker | Open: `deploy-cloudflare.yml` only runs `wrangler secret put`; no `secret delete` anywhere in `.github/workflows` | the account admin |

## Owner steps to turn on web login (Q18)

Nothing here is done by the PR; merging changes nothing live while `WEB_LOGIN = "off"`.

1. Make sure `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET` are set on the Worker (the secret is synced from the GitHub secret of the same name on deploy). The web routes read both from the environment and have no built-in fallback: without either they answer 503 (`web-auth.js:68,90`).
2. In the Discord developer portal, OAuth2, Redirects: add `<API_ORIGIN>/api/auth/discord/callback` exactly (production: the `API_ORIGIN` value in `wrangler.toml` plus that path).
3. Apply `infrastructure/migrations/0002_identity_tenancy.sql` to production D1 (adds `users` and `sessions_v2`). Without it the callback answers 503 and logs one warning; `/api/me` keeps working for board keys.
4. Set `WEB_LOGIN = "on"` in `wrangler.toml` and deploy. Roll back by setting it back to `"off"`: all sessions stop being honoured at once; rows remain in `sessions_v2`.
5. The cookie `__Host-sess` is scoped to the host that serves the API. A page on a different origin must call `/api/me` with `credentials: "include"`; the Worker then answers with `Access-Control-Allow-Credentials: true` for allow-listed origins only.

## Deploy token never reaches the Worker
`deploy-cloudflare.yml` syncs `AI_GATEWAY_TOKEN` only from the repository secret `AI_GATEWAY_TOKEN` or `CLOUDFLARE_AIG_TOKEN`; the `CLOUDFLARE_API_TOKEN` fallback was removed, and `ai-models.js` no longer reads `env.CLOUDFLARE_API_TOKEN`. With neither dedicated secret set, the deploy warns and does not run `secret put`; a value already in the Worker is kept, not deleted. Check for a leftover Worker secret named `CLOUDFLARE_API_TOKEN` or `AI_GATEWAY_TOKEN` with `npx wrangler secret list` and remove it with `npx wrangler secret delete <name>` after rotating the deploy token. See `rollback.md`, Deploy safety.
