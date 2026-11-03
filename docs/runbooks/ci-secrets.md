# CI secrets: production environment and preview token

Why: a workflow file in a pull request runs with the secrets the repository gives it. Production secrets (the Cloudflare deploy token, `BOARD_ADMIN_TOKEN`, salts, AI keys) therefore live only in a GitHub **environment** named `production` that only `master` can use. Pull request workflows use separate, preview-only secrets. If those are missing the preview jobs skip with a notice; nothing falls back to a production secret.

## Secret map

| Secret | Where it lives | Used by |
| :--- | :--- | :--- |
| `CLOUDFLARE_API_TOKEN` | environment `production` | `deploy-cloudflare.yml` only |
| `BOARD_ADMIN_TOKEN` | environment `production` | `deploy-cloudflare.yml` only |
| `USER_SALT`, `KEY_SALT`, `AI_GATEWAY_TOKEN` (or `CLOUDFLARE_AIG_TOKEN`), `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `GITHUB_MODELS_TOKEN`, `OPENROUTER_API_KEY`, `DISCORD_WEBHOOK_URL`, `DISCORD_PUBLIC_KEY`, `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN` | environment `production` | `deploy-cloudflare.yml` only |
| `CLOUDFLARE_ACCOUNT_ID` | repository secret (an identifier, not a credential; may also be copied into `production`) | deploy and preview |
| `CLOUDFLARE_PREVIEW_API_TOKEN` | repository secret | `pr-preview-cloudflare.yml` (spin-up, teardown) |
| `BOARD_PREVIEW_ADMIN_TOKEN` | repository secret | `pr-preview-cloudflare.yml`, `preview-tests.yml`; the base for the per-preview salts and admin token |

`tests/unit/workflow-secrets.test.mjs` fails if a PR-triggered workflow names any secret outside the preview rows above.

## 1. Create the `production` environment (Matt)

1. Open the repository on GitHub, **Settings**.
2. In the left menu click **Environments**, then **New environment**.
3. Name it exactly `production` and click **Configure environment**.
4. Under **Deployment branches and tags** choose **Selected branches and tags**, click **Add deployment branch or tag rule**, set **Ref type** to *Branch*, name pattern `master`, and **Add rule**. Leave no other rule.
5. Optional: under **Deployment protection rules** tick **Required reviewers** and add yourself, so every deploy waits for one click. Leave **Prevent self-review** off if you are the only reviewer.

## 2. Move the secrets (Matt)

Do this for the two critical secrets first, then the rest of the table's `production` rows.

1. **Settings > Environments > production > Environment secrets > Add environment secret**.
2. Name `CLOUDFLARE_API_TOKEN`, paste the same value that is in the repository secret now, **Add secret**.
3. Repeat for `BOARD_ADMIN_TOKEN` and for each other `production` row (`USER_SALT` and `KEY_SALT` must keep their old values, or existing hashes stop matching: see `rotate-salts.md`).
4. Also add `CLOUDFLARE_ACCOUNT_ID` to the environment (the deploy checks it exists).
5. Only after step 2 to 4 are done, remove the repository-level copies: **Settings > Secrets and variables > Actions > Repository secrets**, click the bin next to each production secret, confirm. Keep `CLOUDFLARE_ACCOUNT_ID` there for the preview.

Do not skip step 5. A repository secret with the same name stays readable by every workflow run, including one started from a branch, so the environment alone protects nothing until the old copy is gone.

Check: the **Actions** tab, **Deploy Site & Serverless Backend to Cloudflare (Production)**, **Run workflow** on `master`. The first step "Require the production environment secrets" must pass and the run must show "production" as its environment. A run from any other branch must be refused at the environment.

## 3. Preview token scope (Matt, with Uncle Jimmy's Cloudflare account)

Create a **separate** API token for previews; never reuse the production one.

1. Cloudflare dashboard, **My Profile > API Tokens > Create Token > Create Custom Token**. Name it `leeroy-board-preview-ci`.
2. Permissions (Account level, account `Uncle Jimmy's`): **Workers Scripts: Edit**, **D1: Edit**, **Cloudflare Pages: Edit**, **Workers AI: Read** (the preview uses the free Workers AI model). Nothing else: no DNS, no Zone, no Workers Routes, no Account Settings, no AI Gateway.
3. Account resources: include only this account. Zone resources: none. Add a client IP filter only if you use fixed runners (GitHub-hosted runners change, so normally leave it off).
4. Set an expiry (90 days is a sensible default) and note the date in your calendar.
5. Scoping to preview resources: Cloudflare cannot limit a token to resources by name pattern, so the token still can touch production resources if it shares the account. To make it truly preview-only, put previews in a separate Cloudflare account (or a second account member) and use that account's `CLOUDFLARE_ACCOUNT_ID` for the preview; this is the follow-up to agree with Uncle Jimmy. Until then, treat this token as account-wide for Workers, D1 and Pages and keep its expiry short.
6. In GitHub: **Settings > Secrets and variables > Actions > New repository secret**: name `CLOUDFLARE_PREVIEW_API_TOKEN`, paste the token.
7. Create `BOARD_PREVIEW_ADMIN_TOKEN` the same way with a new random value (for example `openssl rand -hex 32`). It is not a production value and is never sent to production.

Until both preview secrets exist, labelled (`ci-full`) PRs get **Preview tests: SKIPPED** and a notice in the run; the comment is not the merge gate, so a full pass is impossible without them.

## 4. The Preview tests comment and the gate

The comment keeps its visible header `### Preview tests: passed (<sha7>)`, which `queue/gate.js` matches. A second hidden line carries the full head sha and the run id: `<!-- preview-tests-meta sha=<40 hex> run=<run id> -->`. The report job reads the comment back and fails unless it is written by `github-actions[bot]` and carries this run's id and the PR head sha (`node tools/ci-report.mjs --verify`).

The merge script (`queue/gate.js`, outside this repository) should also, before it trusts a comment: take the newest `github-actions[bot]` comment with the hidden line, require its `sha=` to equal the full head sha of the PR, and look up the run id with the Actions API (workflow `Preview Tests`, head sha equal, conclusion `success`). Until it does, the sha7 header alone remains the trust anchor.

## 5. Reviews of CI changes

`.github/CODEOWNERS` requires `@Matt-Bloise` for `.github/`, `tools/` and `infrastructure/wrangler.toml`. It only has effect once **Settings > Branches > master rule > Require a pull request before merging > Require review from Code Owners** is ticked.

## Failure messages and what they mean

| Message | Meaning |
| :--- | :--- |
| `Production secrets missing: ...` (deploy) | The environment `production` lacks that secret. Nothing was deployed. Add it as in section 2. |
| `Preview skipped` / `Preview tests skipped` notice | A preview secret is absent. Add it as in section 3. |
| `Preview tests comment check failed: ...` | The comment is not from this run and commit. Re-run the workflow; do not merge on that comment. |
