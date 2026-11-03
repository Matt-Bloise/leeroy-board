# Runbook: secrets and variables

Names only. Never put a value in the repository, an issue, a PR, a log or a chat. Last checked: 2026-11-02. Citations are `file:line`, or marked (unverified). "Owner" means the repository and Cloudflare account owner; who actually holds those admin rights is unverified.

## Inventory

### Set in GitHub Actions repository secrets, used by workflows

| Name | Used at | Purpose |
| :--- | :--- | :--- |
| `CLOUDFLARE_API_TOKEN` | `deploy-cloudflare.yml:17`; `pr-preview-cloudflare.yml:44,338` | Wrangler and API calls for Worker, D1, Pages, domains. Scopes the workflow checks: D1 Edit, Pages Edit, Zone Read for the production zone (`deploy-cloudflare.yml:120-123,152-157`) |
| `CLOUDFLARE_ACCOUNT_ID` | `deploy-cloudflare.yml:18`; `pr-preview-cloudflare.yml:45,339` | Account selector |
| `BOARD_ADMIN_TOKEN` | `preview-tests.yml:97`; also below | Lets the API tests call admin routes on a preview |
| `github.token` (automatic) | `preview-tests.yml:22`; `pr-preview-cloudflare.yml:15-18` | PR comments; not a stored secret |

### GitHub secrets copied to Worker secrets on every production deploy

Loop at `deploy-cloudflare.yml:263`, each skipped when empty (`:265`), set with `wrangler secret put` (`:266`):

`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `GITHUB_MODELS_TOKEN`, `OPENROUTER_API_KEY`, `BOARD_ADMIN_TOKEN`, `DISCORD_WEBHOOK_URL`, `DISCORD_PUBLIC_KEY`, `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN`, `USER_SALT`, `KEY_SALT`.

The production deploy stops before replacing the Worker when the `USER_SALT` or `KEY_SALT` repository secret is empty. Previews get their own salts: `pr-preview-cloudflare.yml` sets each with `wrangler secret put`, derived as HMAC-SHA256 of the preview Worker name keyed by the repository secret (distinct per preview and from production; the repository secret itself is never copied). A missing salt makes the Worker answer 503 `salt_not_configured` on guest asks, votes and account routes, and refuse member keys; it does not crash. Admin `GET /api/health` lists `saltsMissing` (names only).

Consumers in the Worker: AI keys `infrastructure/worker/ai-models.js:141-153`; admin token `index.js:61,70`; webhook `index.js:587`; public key `discord.js:475`; client secret `account.js:81`, `index.js:864`; bot token `index.js:432`.

### Plain variables (public, committed) in `infrastructure/wrangler.toml` `[vars]` (lines 39-59)

`AI_PROVIDER`, `AI_GATEWAY_ID`, `AI_GATEWAY_CACHE_TTL`, `CLOUDFLARE_ACCOUNT_ID` (empty), `CLAUDE_MODEL_FAST`, `CLAUDE_MODEL_DEEP`, `GEMINI_MODEL_FAST`, `GEMINI_MODEL_DEEP`, `WORKERS_AI_MODEL`, `GROQ_MODEL_FAST`, `GROQ_MODEL_DEEP`, `CEREBRAS_MODEL`, `GITHUB_MODEL_FAST`, `GITHUB_MODEL_DEEP`, `OPENROUTER_MODEL`, `API_ORIGIN`, `BOARD_PUBLIC_URL`, `ALLOWED_ORIGINS`.

Added to previews only by the workflow: `IS_PR_PREVIEW`, `WORKER_NAME` (`pr-preview-cloudflare.yml:198-200`), and `BOARD_ADMIN_TOKEN` as a deploy-time `--var` (`:236-237`).

### Read by the code but not set in the repository

| Name | Read at | Note |
| :--- | :--- | :--- |
| `DISCORD_CLIENT_ID` | `account.js:81,93`; `index.js:863` | Not in `wrangler.toml` or any workflow. `account.js:81` returns 500 "worker not configured" when it is unset, while `index.js:863` has a built-in fallback. Whether it is set in the dashboard is unverified; if not, Discord login (`POST /auth/discord`) cannot work. |
| `AI_DAILY_NEURON_CAP` | `budget.js:39` | Optional budget override |
| `DATA_RIGHTS` | `data-rights.js` (`dataRightsOn`) | Plain var in `wrangler.toml`, default `"off"`. Q59: `"on"` enables `GET /api/me/export` and `POST /api/me/erase` for a member key or a web session cookie. While off both answer 404. Needs `USER_SALT`. Roll back by setting it to `"off"`. |
| `CHARS_V1` | `characters-api.js` (`charsOn`) | Plain var in `wrangler.toml`, default `"off"`. Character switcher: `"on"` adds `characters` and `selected` to `GET /api/me` for a web session and enables `POST /api/me/characters` (add, rename, select). While off the route answers 404 and `/api/me` is unchanged. Needs `WEB_LOGIN` on and migration 0005. The board also needs the client flag `chars.v1` in `data/client.json`. Roll back by setting it to `"off"`; the rows stay. |
| `WEB_LOGIN` | `web-auth.js` (`webLoginOn`) | Plain var in `wrangler.toml`, default `"off"`. Q18 web Discord login: `"on"` enables `GET /api/auth/discord/start`, `GET /api/auth/discord/callback`, `POST /api/auth/logout` and cookie sessions on `GET /api/me`. While off, those routes answer 404 and cookies are ignored. |

### Cloudflare-side state with no repository record

Worker secrets live in Cloudflare; list names (not values) with `cd infrastructure && npx wrangler secret list --name leeroy-brain`. D1 private rows (`persona`, `name_map`, `discord_members`, `discord_roster`, `vocab`) are data, not secrets, but are equally private (`backup-restore.md`). Member keys are never stored, only `sha256(KEY_SALT:key)` (`auth.js:14-16`); sessions are stored hashed (`account.js`, `schema.sql:167-173`).

## Who may rotate, and how

All rotations are the owner's, because they need Cloudflare or GitHub admin rights and the third-party provider accounts. The partner contributes through PRs and has no need for secret access.

General order: create the new value at the provider, update the GitHub Actions secret (Settings, Secrets and variables, Actions, or `gh secret set NAME --repo <owner>/leeroy-board`, value from stdin), then trigger a deploy so the Worker copy updates, then revoke the old value.

| Secret | Rotation steps | Side effects |
| :--- | :--- | :--- |
| `CLOUDFLARE_API_TOKEN` | Create a new token in the Cloudflare dashboard with the scopes above; set the GitHub secret; re-run any workflow to see the pre-flight check pass (`deploy-cloudflare.yml:55-64`); delete the old token. | Not stored in the Worker. Replace immediately if exposed: it can alter or delete production. |
| `CLOUDFLARE_ACCOUNT_ID` | Not secret in effect; change only if the account changes. | |
| `BOARD_ADMIN_TOKEN` | Generate a long random value; update the GitHub secret; deploy (production gets it via `wrangler secret put`); open or update a PR so previews pick it up. Update the owner's password manager and any operator tools. | Old token stops working at once on admin routes. Open PR previews keep the old value as a plain var until they redeploy. |
| `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `GITHUB_MODELS_TOKEN`, `OPENROUTER_API_KEY` | New key at the provider; GitHub secret; deploy; revoke old key. | A provider with no key is skipped by selection logic (`ai-models.js:136-153`); confirm with admin `GET /api/health`. |
| `DISCORD_WEBHOOK_URL` | Recreate the webhook in Discord; update secret; deploy; delete the old webhook. | Posts use the new URL after the deploy |
| `DISCORD_PUBLIC_KEY` | Comes from the Discord developer portal; changes only if the application changes. | Interactions fail signature checks until it matches (`discord.js:475,485`) |
| `DISCORD_CLIENT_SECRET` | Reset in the developer portal; update secret; deploy. | Login and Activity code exchange fail until deployed |
| `DISCORD_BOT_TOKEN` | Reset in the developer portal; update secret; deploy. | `POST /announce` fails until deployed (`index.js:432`) |
| `KEY_SALT`, `USER_SALT` | Do not rotate casually. Set the new value as the GitHub repository secret and deploy; previews pick up a re-derived value on their next push. Changing `KEY_SALT` changes every member key hash (`auth.js:15`), so every member key stops working until it is re-issued: for each member run `KEY_SALT=<new> node infrastructure/scripts/hash-key.mjs <slug>` (key on stdin) and apply the INSERT it prints with `wrangler d1 execute`. Changing `USER_SALT` changes every derived per-user key (`account.js:38-39`), orphaning saved user state, and invalidates vote ballot hashes and guest rate-limit rows. Both must stay at least 16 characters or the Worker refuses the dependent routes. Never use the old public values (they were in git history). | Plan it as a SEV2 change window. Members are locked out until their hashes are replaced. |

Caveat that matters for every row: syncing never deletes. If a GitHub secret is emptied or removed, the loop skips it (`deploy-cloudflare.yml:265`) and the old Worker secret stays. Remove it with `npx wrangler secret delete <NAME> --name leeroy-brain`.

After any rotation: check `gh run list`, `GET /api/health`, and one call that uses the rotated value. Record the date (not the value) in the owner's private notes.

## Known weaknesses today

Each row was verified against the file and line shown, or the live repository setting, on 2026-11-02.

| # | Weakness | Evidence | Impact | Suggested fix |
| :-- | :--- | :--- | :--- | :--- |
| 1 | `KEY_SALT` and `USER_SALT` were public plain variables (fixed in Q01) | They are now Worker secrets set by both deploy workflows. The previous values remain in git history and are public | Hashes made under the old values can be attacked offline with a known salt | Rotate both to fresh private values with the plan above when the owner chooses, which re-issues member keys |
| 2 | Preview workflow passes `BOARD_ADMIN_TOKEN` as a plain `--var` | `pr-preview-cloudflare.yml:236-237` | The production admin value becomes a plaintext variable on every preview Worker (visibility in the dashboard is by Cloudflare behavior, unverified here), and wrangler may print binding values in the deploy log (unverified) | Use a distinct preview-only admin token, delivered with `wrangler secret put` |
| 3 | Same-repository PR workflows can read production secrets | Trigger `pull_request` (`pr-preview-cloudflare.yml:3-9`); job `if` allows same-repo heads (`:41`); env uses `CLOUDFLARE_API_TOKEN` (`:44-45`); `preview-tests.yml:97` uses `BOARD_ADMIN_TOKEN`; PR code runs `npm install`, `seed-d1.mjs`, `wrangler.toml` from the branch (`:53-63,204-226`). `pull_request_target` is not used (searched `.github`). | Anyone who can push a branch to this repository can change workflow or script files in a PR and exfiltrate the Cloudflare token or admin token. Fork PRs do not receive secrets by GitHub default, which is the intended boundary | Restrict who has write access; use environments with required reviewers for production secrets; use a preview-only Cloudflare token scoped to preview resources |
| 4 | No branch protection on `master` | `gh api repos/<owner>/leeroy-board/branches/master/protection` returned 404 "Branch not protected" | Anyone with write access can push to `master` and trigger a production deploy without review or tests. The "rated 6 or higher waits for the owner" rule in `CONTRIBUTING.md:7` is process only | Enable branch protection or a ruleset: required PR, required `Preview Tests` check, owner approval, no force-push |
| 5 | One broad Cloudflare token serves production deploy, previews and teardown | `deploy-cloudflare.yml:17`, `pr-preview-cloudflare.yml:44,338`; teardown deletes Workers and D1 databases by name (`:363,369`) | A bug in the name derivation could delete production resources | Separate tokens per environment; add a guard that the target name starts with `leeroy-brain-pr-` |
| 6 | Production workflow has no `permissions:` block | Only `pr-preview-cloudflare.yml:15` and `preview-tests.yml:11` declare one (grep); repository default workflow permission is `write` (GitHub API, 2026-11-02) | The deploy job's `GITHUB_TOKEN` is broader than needed | Add `permissions: contents: read` to `deploy-cloudflare.yml`; set the repo default to read |
| 7 | Actions pinned by tag, not commit sha | `actions/checkout@v4` (`deploy-cloudflare.yml:24`), `actions/github-script@v7` (`pr-preview-cloudflare.yml:287`) | A moved tag runs new code with secrets in scope | Pin to full commit shas |
| 8 | Secret list drift | Workflow syncs 11 names including `DISCORD_BOT_TOKEN` (`deploy-cloudflare.yml:261,263`); `infrastructure/README.md:102` lists 10 | Rotation inventories miss one | Fixed in this runbook; update the README |
| 9 | `DISCORD_CLIENT_ID` has no source of truth | See "Read by the code but not set"; `account.js:81` vs `index.js:863` | Login may fail with a generic 500 | Set it explicitly in `wrangler.toml` (it is not secret) and remove the divergent fallback |
| 10 | Secrets removed from GitHub stay in the Worker | `deploy-cloudflare.yml:265` | Revoked credentials may remain live | Delete with `wrangler secret delete` during rotation |

Items 2, 3 and 4 combine: a branch push opens a PR, the PR workflow runs with production credentials, and nothing blocks a direct push to `master`. Treat 3 and 4 as the first fixes before onboarding any additional contributor with write access.

## Owner steps to turn on web login (Q18)

Nothing here is done by the PR; merging changes nothing live while `WEB_LOGIN = "off"`.

1. Make sure `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET` are set on the Worker (the secret is synced from the GitHub secret of the same name on deploy; the web routes read both from the environment and have no built-in fallback).
2. In the Discord developer portal, OAuth2, Redirects: add `<API_ORIGIN>/api/auth/discord/callback` exactly (production: the `API_ORIGIN` value in `wrangler.toml` plus that path).
3. Apply `infrastructure/migrations/0002_identity_tenancy.sql` to production D1 (adds `users` and `sessions_v2`). Without it the callback answers 503 and logs one warning; `/api/me` keeps working for board keys.
4. Set `WEB_LOGIN = "on"` in `wrangler.toml` and deploy. Roll back by setting it back to `"off"`: all sessions stop being honoured at once; rows remain in `sessions_v2`.
5. The cookie `__Host-sess` is scoped to the host that serves the API. A page on a different origin must call `/api/me` with `credentials: "include"`; the Worker then answers with `Access-Control-Allow-Credentials: true` for allow-listed origins only.

## Deploy token never reaches the Worker
`deploy-cloudflare.yml` syncs `AI_GATEWAY_TOKEN` only from the repository secret `AI_GATEWAY_TOKEN` or `CLOUDFLARE_AIG_TOKEN`; the `CLOUDFLARE_API_TOKEN` fallback was removed, and `ai-models.js` no longer reads `env.CLOUDFLARE_API_TOKEN`. With neither dedicated secret set, the deploy warns and does not run `secret put`; a value already in the Worker is kept, not deleted. Check for a leftover Worker secret named `CLOUDFLARE_API_TOKEN` or `AI_GATEWAY_TOKEN` with `npx wrangler secret list` and remove it with `npx wrangler secret delete <name>` after rotating the deploy token. See `rollback.md`, Deploy safety.
