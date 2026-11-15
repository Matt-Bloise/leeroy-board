# Runbook: secrets and variables

> Where each secret lives (GitHub environment `production` vs repository) and how to move them: [ci-secrets.md](ci-secrets.md).

Names only. Never put a value in the repository, an issue, a PR, a log or a chat. Last checked: 2026-11-02. Citations are `file:line`, or marked (unverified). "Owner" means the repository and Cloudflare account owner; who actually holds those admin rights is unverified.

## Inventory

### Set in GitHub Actions repository secrets, used by workflows

| Name | Used at | Purpose |
| :--- | :--- | :--- |
| `CLOUDFLARE_API_TOKEN` | `deploy-cloudflare.yml:31`; `pr-preview-cloudflare.yml:130,482`; `preview-tests.yml:133` | Wrangler and API calls for Worker, D1, Pages, domains. Scopes the workflow checks: D1 Edit, Pages Edit (the check prints it as a hint), Zone Read for the production zone (`deploy-cloudflare.yml:161-178,180-216`) |
| `CLOUDFLARE_ACCOUNT_ID` | `deploy-cloudflare.yml:32`; `pr-preview-cloudflare.yml:131,483`; `preview-tests.yml:135` | Account selector |
| `BOARD_PREVIEW_ADMIN_TOKEN` | `pr-preview-cloudflare.yml:105,372`; `preview-tests.yml:134,229` | Preview-only base value. Each preview Worker's `BOARD_ADMIN_TOKEN`, `USER_SALT` and `KEY_SALT` are derived from it, and the API tests derive the admin token the same way. Never a production value |
| `BOARD_ADMIN_TOKEN` | `deploy-cloudflare.yml:43,359` | Production admin token. Lives in the GitHub environment `production` (`ci-secrets.md`), not used by previews or the preview tests |
| `github.token` (automatic) | `preview-tests.yml:57,162`; `pr-preview-cloudflare.yml:69` | PR comments; not a stored secret |

### GitHub secrets copied to Worker secrets on every production deploy

Loop at `deploy-cloudflare.yml:367`, each skipped when empty (`:369`), set with `wrangler secret put` (`:370`):

`AI_GATEWAY_TOKEN` (from the repository secret `AI_GATEWAY_TOKEN` or `CLOUDFLARE_AIG_TOKEN`, `:352`; see the last section), `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `GITHUB_MODELS_TOKEN`, `OPENROUTER_API_KEY`, `BOARD_ADMIN_TOKEN`, `DISCORD_WEBHOOK_URL`, `DISCORD_PUBLIC_KEY`, `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN`, `USER_SALT`, `KEY_SALT`.

The production deploy stops before replacing the Worker when the `USER_SALT` or `KEY_SALT` repository secret is empty. Previews get their own salts: `pr-preview-cloudflare.yml:371-388` sets `USER_SALT`, `KEY_SALT` and `BOARD_ADMIN_TOKEN` with `wrangler secret put`, each derived as HMAC-SHA256 of `preview:<NAME>:<preview Worker name>` keyed by the repository secret `BOARD_PREVIEW_ADMIN_TOKEN` (distinct per preview and from production; no production secret is read or copied). A missing salt makes the Worker answer 503 `salt_not_configured` on guest asks, votes and account routes, and refuse member keys; it does not crash. Admin `GET /api/health` lists `saltsMissing` (names only).

Consumers in the Worker: AI keys `infrastructure/worker/ai-models.js:191-203`; AI Gateway token `ai-models.js:384`; admin token `index.js:78,87-91`; webhook `index.js:753`, `ai-models.js:1392`; public key `discord.js:654,664`; client secret `account.js:83,95`, `index.js:1053`; bot token `index.js:531,553`.

### Plain variables (public, committed) in `infrastructure/wrangler.toml` `[vars]` (from line 53)

`AI_PROVIDER`, `AI_GATEWAY_ID`, `AI_GATEWAY_CACHE_TTL`, `CLOUDFLARE_ACCOUNT_ID` (empty), `CLAUDE_MODEL_FAST`, `CLAUDE_MODEL_DEEP`, `GEMINI_MODEL_FAST`, `GEMINI_MODEL_DEEP`, `WORKERS_AI_MODEL`, `GROQ_MODEL_FAST`, `GROQ_MODEL_DEEP`, `CEREBRAS_MODEL`, `GITHUB_MODEL_FAST`, `GITHUB_MODEL_DEEP`, `OPENROUTER_MODEL`, `API_ORIGIN`, `BOARD_PUBLIC_URL`, `ALLOWED_ORIGINS`, plus the feature flags declared there (`WEB_LOGIN`, `DATA_RIGHTS`, `EVENTS_ENABLED`, `MOMENTS_*`, `CHARS_V1`, `REQUEST_GAUGE` and others; see the file).

Added to previews only by the workflow: `IS_PR_PREVIEW`, `WORKER_NAME` (`pr-preview-cloudflare.yml:299-300`). The preview `BOARD_ADMIN_TOKEN` is a Worker secret, not a var (`:351,382`).

### Read by the code but not set in the repository

| Name | Read at | Note |
| :--- | :--- | :--- |
| `DISCORD_CLIENT_ID` | `account.js:83,95`; `index.js:1052`; `web-auth.js:68,90` | Not in `wrangler.toml` or any workflow. `account.js:83` returns 500 "worker not configured" when it is unset, while `index.js:1052` has a built-in fallback. Whether it is set in the dashboard is unverified; if not, Discord login (`POST /auth/discord`) cannot work. |
| `AI_DAILY_NEURON_CAP` | `budget.js:45` | Optional budget override |
| `DATA_RIGHTS` | `data-rights.js` (`dataRightsOn`) | Plain var in `wrangler.toml`, default `"off"`. Q59: `"on"` enables `GET /api/me/export` and `POST /api/me/erase` for a member key or a web session cookie. While off both answer 404. Needs `USER_SALT`. Roll back by setting it to `"off"`. |
| `CHARS_V1` | `characters-api.js` (`charsOn`) | Plain var in `wrangler.toml`, default `"off"`. Character switcher: `"on"` adds `characters` and `selected` to `GET /api/me` for a web session and enables `POST /api/me/characters` (add, rename, select). While off the route answers 404 and `/api/me` is unchanged. Needs `WEB_LOGIN` on and migration 0005. The board also needs the client flag `chars.v1` in `data/client.json`. Roll back by setting it to `"off"`; the rows stay. |
| `REQUEST_GAUGE` | `gauge.js` | Plain var in `wrangler.toml`, default `"off"`. `"on"` makes the Worker count its own requests per UTC day (in memory, written to D1 table `request_gauge` about every 25 requests) and enables `GET /api/admin/requests` (admin token; 404 while off). While off, a request costs one string comparison and no D1 access. Needs migration 0008. An approximation: the Cloudflare dashboard stays the source of truth (`cloudflare-requests.md`). Roll back by setting it to `"off"`; the rows stay. |
| `WEB_LOGIN` | `web-auth.js` (`webLoginOn`) | Plain var in `wrangler.toml`, default `"off"`. Q18 web Discord login: `"on"` enables `GET /api/auth/discord/start`, `GET /api/auth/discord/callback`, `POST /api/auth/logout` and cookie sessions on `GET /api/me`. While off, those routes answer 404 and cookies are ignored. |

### Cloudflare-side state with no repository record

Worker secrets live in Cloudflare; list names (not values) with `cd infrastructure && npx wrangler secret list --name leeroy-brain`. D1 private rows (`persona`, `name_map`, `discord_members`, `discord_roster`, `vocab`) are data, not secrets, but are equally private (`backup-restore.md`). Member keys are never stored, only `sha256(KEY_SALT:key)` (`auth.js:15-17`); sessions are stored hashed (`account.js`, `schema.sql:167-173`).

## Who may rotate, and how

All rotations are the owner's, because they need Cloudflare or GitHub admin rights and the third-party provider accounts. The partner contributes through PRs and has no need for secret access.

General order: create the new value at the provider, update the GitHub Actions secret (Settings, Secrets and variables, Actions, or `gh secret set NAME --repo <owner>/leeroy-board`, value from stdin), then trigger a deploy so the Worker copy updates, then revoke the old value.

| Secret | Rotation steps | Side effects |
| :--- | :--- | :--- |
| `CLOUDFLARE_API_TOKEN` | Create a new token in the Cloudflare dashboard with the scopes above; set the GitHub secret; re-run any workflow to see the pre-flight check pass (`deploy-cloudflare.yml:40-54,85-216`); delete the old token. | Not stored in the Worker. Replace immediately if exposed: it can alter or delete production. |
| `CLOUDFLARE_ACCOUNT_ID` | Not secret in effect; change only if the account changes. | |
| `BOARD_ADMIN_TOKEN` | Generate a long random value; update the GitHub secret; deploy (production gets it via `wrangler secret put`). Previews are unaffected: they derive their own admin token from `BOARD_PREVIEW_ADMIN_TOKEN`. Update the owner's password manager and any operator tools. | Old token stops working at once on production admin routes. |
| `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `GITHUB_MODELS_TOKEN`, `OPENROUTER_API_KEY` | New key at the provider; GitHub secret; deploy; revoke old key. | A provider with no key is skipped by selection logic (`ai-models.js:136-153`); confirm with admin `GET /api/health`. |
| `DISCORD_WEBHOOK_URL` | Recreate the webhook in Discord; update secret; deploy; delete the old webhook. | Posts use the new URL after the deploy |
| `DISCORD_PUBLIC_KEY` | Comes from the Discord developer portal; changes only if the application changes. | Interactions fail signature checks until it matches (`discord.js:654,664`) |
| `DISCORD_CLIENT_SECRET` | Reset in the developer portal; update secret; deploy. | Login and Activity code exchange fail until deployed |
| `DISCORD_BOT_TOKEN` | Reset in the developer portal; update secret; deploy. | `POST /announce` fails until deployed (`index.js:531,553`) |
| `KEY_SALT`, `USER_SALT` | Do not rotate casually. Set the new value as the GitHub repository secret and deploy; previews are not affected (their salts derive from `BOARD_PREVIEW_ADMIN_TOKEN`). For the full procedure see `rotate-salts.md`. Changing `KEY_SALT` changes every member key hash (`auth.js:16`), so every member key stops working until it is re-issued: for each member run `KEY_SALT=<new> node infrastructure/scripts/hash-key.mjs <slug>` (key on stdin) and apply the INSERT it prints with `wrangler d1 execute`. Changing `USER_SALT` changes every derived per-user key (`account.js:40`), orphaning saved user state, and invalidates vote ballot hashes and guest rate-limit rows. Both must stay at least 16 characters or the Worker refuses the dependent routes. Never use the old public values (they were in git history). | Plan it as a SEV2 change window. Members are locked out until their hashes are replaced. |

Caveat that matters for every row: syncing never deletes. If a GitHub secret is emptied or removed, the loop skips it (`deploy-cloudflare.yml:369`) and the old Worker secret stays. Remove it with `npx wrangler secret delete <NAME> --name leeroy-brain`.

After any rotation: check `gh run list`, `GET /api/health`, and one call that uses the rotated value. Record the date (not the value) in the owner's private notes.

## Known weaknesses today

Each row was verified against the file and line shown, or the live repository setting, on 2026-11-02; rows marked "Fixed" and the line numbers were re-checked against the code on 2026-11-15 (live repository settings were not re-checked).

| # | Weakness | Evidence | Impact | Suggested fix |
| :-- | :--- | :--- | :--- | :--- |
| 1 | `KEY_SALT` and `USER_SALT` were public plain variables (fixed in Q01) | They are now Worker secrets set by both deploy workflows. The previous values remain in git history and are public | Hashes made under the old values can be attacked offline with a known salt | Rotate both to fresh private values with the plan above when the owner chooses, which re-issues member keys |
| 2 | Fixed: the preview workflow used to pass the production `BOARD_ADMIN_TOKEN` as a plain `--var` | Now each preview gets a derived admin token from the preview-only `BOARD_PREVIEW_ADMIN_TOKEN`, delivered with `wrangler secret put` (`pr-preview-cloudflare.yml:351,371-388`) | None left for previews. The production value may still exist as a var on preview Workers deployed before the fix, until they are torn down | Nothing further |
| 3 | Same-repository PR workflows can read the shared Cloudflare token | Trigger `pull_request` (`pr-preview-cloudflare.yml:9-15`); job `if` allows same-repo heads (`:96,129`); env uses `CLOUDFLARE_API_TOKEN` (`:130-131`); PR code runs `npm ci`, `seed-d1.mjs`, `wrangler.toml` from the branch (`:149,343`). The production admin token and salts are no longer readable by PR runs (they are in the `production` environment, `deploy-cloudflare.yml:29-30`). `pull_request_target` is not used (searched `.github`). | Anyone who can push a branch to this repository can change workflow or script files in a PR and exfiltrate the Cloudflare token or the preview admin base. Fork PRs do not receive secrets by GitHub default, which is the intended boundary | Restrict who has write access; use environments with required reviewers for production secrets; use a preview-only Cloudflare token scoped to preview resources |
| 4 | No branch protection on `master` | `gh api repos/<owner>/leeroy-board/branches/master/protection` returned 404 "Branch not protected" | Anyone with write access can push to `master` and trigger a production deploy without review or tests. The "rated 6 or higher waits for the owner" rule in `CONTRIBUTING.md:7` is process only | Enable branch protection or a ruleset: required PR, required `Preview Tests` check, owner approval, no force-push |
| 5 | One broad Cloudflare token serves production deploy, previews and teardown | `deploy-cloudflare.yml:31`, `pr-preview-cloudflare.yml:130,482`; teardown deletes Workers and D1 databases by name (`:541,548`) | A bug in the name derivation could delete production resources | Separate tokens per environment; add a guard that the target name starts with `leeroy-brain-pr-` |
| 6 | Fixed: the production workflow had no `permissions:` block | `deploy-cloudflare.yml:14-15` now declares `contents: read`; the other workflows declare their own (grep `permissions` in `.github/workflows`). The repository default workflow permission was `write` on 2026-11-02 and was not re-checked | None for the deploy job | Set the repo default to read |
| 7 | Fixed: actions were pinned by tag, not commit sha | Now pinned to full shas with the version in a comment (`deploy-cloudflare.yml:38`, `pr-preview-cloudflare.yml:78`) | None left | Keep pins current in their own PR |
| 8 | Secret list drift | Workflow syncs 14 names including `AI_GATEWAY_TOKEN` and `DISCORD_BOT_TOKEN` (`deploy-cloudflare.yml:367`); `infrastructure/README.md:115` lists the same 14 | None | Fixed in the README and this runbook |
| 9 | `DISCORD_CLIENT_ID` has no source of truth | See "Read by the code but not set"; `account.js:83` vs `index.js:1052` | Login may fail with a generic 500 | Set it explicitly in `wrangler.toml` (it is not secret) and remove the divergent fallback |
| 10 | Secrets removed from GitHub stay in the Worker | `deploy-cloudflare.yml:369` | Revoked credentials may remain live | Delete with `wrangler secret delete` during rotation |

Items 3 and 4 combine: a branch push opens a PR, the PR workflow runs with the shared Cloudflare token, and nothing blocks a direct push to `master`. Treat 3 and 4 as the first fixes before onboarding any additional contributor with write access.

## Owner steps to turn on web login (Q18)

Nothing here is done by the PR; merging changes nothing live while `WEB_LOGIN = "off"`.

1. Make sure `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET` are set on the Worker (the secret is synced from the GitHub secret of the same name on deploy; the web routes read both from the environment and have no built-in fallback (`web-auth.js:68,90`)).
2. In the Discord developer portal, OAuth2, Redirects: add `<API_ORIGIN>/api/auth/discord/callback` exactly (production: the `API_ORIGIN` value in `wrangler.toml` plus that path).
3. Apply `infrastructure/migrations/0002_identity_tenancy.sql` to production D1 (adds `users` and `sessions_v2`). Without it the callback answers 503 and logs one warning; `/api/me` keeps working for board keys.
4. Set `WEB_LOGIN = "on"` in `wrangler.toml` and deploy. Roll back by setting it back to `"off"`: all sessions stop being honoured at once; rows remain in `sessions_v2`.
5. The cookie `__Host-sess` is scoped to the host that serves the API. A page on a different origin must call `/api/me` with `credentials: "include"`; the Worker then answers with `Access-Control-Allow-Credentials: true` for allow-listed origins only.

## Deploy token never reaches the Worker
`deploy-cloudflare.yml` syncs `AI_GATEWAY_TOKEN` only from the repository secret `AI_GATEWAY_TOKEN` or `CLOUDFLARE_AIG_TOKEN`; the `CLOUDFLARE_API_TOKEN` fallback was removed, and `ai-models.js` no longer reads `env.CLOUDFLARE_API_TOKEN`. With neither dedicated secret set, the deploy warns and does not run `secret put`; a value already in the Worker is kept, not deleted. Check for a leftover Worker secret named `CLOUDFLARE_API_TOKEN` or `AI_GATEWAY_TOKEN` with `npx wrangler secret list` and remove it with `npx wrangler secret delete <name>` after rotating the deploy token. See `rollback.md`, Deploy safety.
