# CI secrets: production environment and preview secrets

Why: a workflow file in a pull request runs with the secrets the repository gives it. Production secrets (the Cloudflare deploy token, `BOARD_ADMIN_TOKEN`, salts, AI keys) therefore live only in a GitHub **environment** named `production` that only `master` can use. Pull request workflows use a preview-only admin token and derived salts. The Cloudflare token is the one exception: by decision of the account owner, previews use the production `CLOUDFLARE_API_TOKEN` (see "Previews share the production Cloudflare token"). If a preview secret is missing the preview jobs skip with a notice; the admin token never falls back to a production secret.

## Secret map

| Secret | Where it lives | Used by |
| :--- | :--- | :--- |
| `CLOUDFLARE_API_TOKEN` | **repository level, deliberately** (see "Previews share the production Cloudflare token") | `deploy-cloudflare.yml`, and the preview spin-up, preview teardown and preview-secrets steps of `pr-preview-cloudflare.yml` / `preview-tests.yml` |
| `BOARD_ADMIN_TOKEN` | environment `production` | `deploy-cloudflare.yml` only |
| `USER_SALT`, `KEY_SALT`, `AI_GATEWAY_TOKEN` | **repository level, deliberately** (see below) | `deploy-cloudflare.yml` only (no PR workflow references them) |
| `CLOUDFLARE_AIG_TOKEN`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `GITHUB_MODELS_TOKEN`, `OPENROUTER_API_KEY`, `DISCORD_WEBHOOK_URL`, `DISCORD_PUBLIC_KEY`, `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN` | environment `production` | `deploy-cloudflare.yml` only |
| `CLOUDFLARE_ACCOUNT_ID` | repository secret (an identifier, not a credential; may also be copied into `production`) | deploy and preview |
| ~~`CLOUDFLARE_PREVIEW_API_TOKEN`~~ | **not used.** Delete it if it still exists (the value that was pasted is invalid) | nothing |
| `BOARD_PREVIEW_ADMIN_TOKEN` | repository secret | `pr-preview-cloudflare.yml`, `preview-tests.yml`; the base for the per-preview salts and admin token |

## Previews share the production Cloudflare token (decision of the account owner)

Uncle Jimmy, who owns the Cloudflare account, decided that there is **no second token**: previews use the same Cloudflare token as production, `CLOUDFLARE_API_TOKEN`. There is no `CLOUDFLARE_PREVIEW_API_TOKEN` in the design. The token must exist as a **repository** secret: a copy only in the environment `production` is not read by preview jobs. It is read in exactly four places: the preview spin-up job and the `preview-guard` job of `pr-preview-cloudflare.yml`, its teardown job, and the `preview-secrets` job of `preview-tests.yml` (the unit test counts them). If it, `BOARD_PREVIEW_ADMIN_TOKEN` or `CLOUDFLARE_ACCOUNT_ID` is missing, the preview jobs skip with a notice.

What this does protect:
- The admin token: `BOARD_ADMIN_TOKEN` never falls back. Previews use `BOARD_PREVIEW_ADMIN_TOKEN` and per-preview derived salts, so a preview Worker never holds the production admin token or salts.
- The deploy itself still runs only in the environment `production` (master only), with its own guard step.
- Fork PRs get no secrets from GitHub.

What this does **not** protect:
- Any workflow run from a branch of this repository, including one whose workflow file the PR itself edited, can read the production Cloudflare token and use it to change or delete production Workers, D1 databases (including the live data) and Pages. The environment gate does not apply to repository-level secrets.
- So S1 stays **open** for the Cloudflare token. The only controls are review: the queue script holds PRs that touch `.github/` or `tools/` for an advisor, and `tests/unit/workflow-secrets.test.mjs` fails if a PR-triggered workflow uses the token in any form other than that fallback. Neither is enforced by GitHub itself.
- It closes only with a separate Cloudflare account (or a token scoped to preview resources) for previews. That needs a design change (a new secret name in the workflows, the test and this runbook); it is not a switch that exists today.

**Accepted residual risk.** As configured by the owner, the environment `production` holds `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `BOARD_ADMIN_TOKEN`, `GEMINI_API_KEY`, `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_SECRET` and `DISCORD_PUBLIC_KEY`. `USER_SALT` and `KEY_SALT` (ours, not third-party credentials) and `AI_GATEWAY_TOKEN` (Uncle Jimmy's) stay at repository level on purpose: a job with `environment: production` still reads repository secrets the environment lacks, and the deploy keeps the existing Worker value when a secret is empty. Consequence: a workflow run from any branch could read those three by editing its own workflow file. No PR workflow in this repository references them (the preview derives its salts from `BOARD_PREVIEW_ADMIN_TOKEN`), and the guard test enforces that, but this is a protection by review, not by GitHub. S1 stays partly open for these three until they move into the environment.

`tests/unit/workflow-secrets.test.mjs` fails if a PR-triggered workflow names any secret outside `CLOUDFLARE_API_TOKEN` (only in the four places above), `BOARD_PREVIEW_ADMIN_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and `GITHUB_TOKEN`, or mentions `CLOUDFLARE_PREVIEW_API_TOKEN`.

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

**Step 5 is mandatory, and it is the control that matters.** If the environment `production` is missing, GitHub creates it empty on the first reference and a secret of the same name falls back to the repository-level copy, so the deploy guard cannot tell the environment is missing. A repository secret stays readable by every workflow run, including one started from a branch. Delete the repository-level copies of `BOARD_ADMIN_TOKEN`, the AI keys (`GEMINI_API_KEY` and any other) and all Discord secrets once the environment copies exist. `USER_SALT`, `KEY_SALT`, `AI_GATEWAY_TOKEN` and `CLOUDFLARE_API_TOKEN` are the accepted exceptions (see the secret map and the decision above): **do not delete the repository-level `CLOUDFLARE_API_TOKEN`**, previews need it. **Until the others are deleted, finding S1 (PR workflows can reach production secrets) stays open.**

Confirm with `gh` (as a repo admin; prints names only, never values):

```bash
tools/check-secret-scope.sh Matt-Bloise/leeroy-board
```

It exits 0 only when no production credential other than the four accepted ones (`USER_SALT`, `KEY_SALT`, `AI_GATEWAY_TOKEN`, `CLOUDFLARE_API_TOKEN`) is left at repository level.

Check: the **Actions** tab, **Deploy Site & Serverless Backend to Cloudflare (Production)**, **Run workflow** on `master`. The first step "Require the production environment secrets" must pass and the run must show "production" as its environment. A run from any other branch must be refused at the environment.

## 3. Preview admin token (Matt)

There is no separate Cloudflare token for previews (see the decision above). Only `BOARD_PREVIEW_ADMIN_TOKEN` is new:

1. **Settings > Secrets and variables > Actions > New repository secret**: name `BOARD_PREVIEW_ADMIN_TOKEN`, value a new random string (for example `openssl rand -hex 32`). It is not a production value and is never sent to production. It is the base for each preview's derived admin token and salts.
2. If a repository secret `CLOUDFLARE_PREVIEW_API_TOKEN` still exists, delete it (unused).
3. Keep the repository-level `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`; if the token is invalid, previews fail at the pre-flight check with Cloudflare error 1000. Replace it with a working one.

Until `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and `BOARD_PREVIEW_ADMIN_TOKEN` all exist, labelled (`ci-full`) PRs get **Preview tests: SKIPPED** and a notice in the run; the comment is not the merge gate, so a full pass is impossible without them.

## 4. The Preview tests comment and the gate

The comment keeps its visible header `### Preview tests: passed (<sha7>)`, which `queue/gate.js` matches. A hidden line directly after the header (so the header stays on line index 1 of the body, which is the only line `queue/gate.js` reads) carries the full head sha and the run id: `<!-- preview-tests-meta sha=<40 hex> run=<run id> -->`. The report job reads the comment back and fails unless it is written by `github-actions[bot]` and carries this run's id and the PR head sha (`node tools/ci-report.mjs --verify`).

The merge script (`queue/gate.js`, outside this repository) should also, before it trusts a comment: take the newest `github-actions[bot]` comment with the hidden line, require its `sha=` to equal the full head sha of the PR, and look up the run id with the Actions API (workflow `Preview Tests`, head sha equal, conclusion `success`). Until it does, the sha7 header alone remains the trust anchor.

## 5. Reviews of CI changes

There is no CODEOWNERS file: it would enforce nothing without a ruleset rule requiring code-owner review, and it would deadlock PRs opened under the owner's own account. The control for `.github/` and `tools/` is the queue script, which holds such PRs until a Claude advisor has reviewed them and the `advisor-ok` label is set.

## Failure messages and what they mean

| Message | Meaning |
| :--- | :--- |
| `Production secrets missing: ...` (deploy) | The environment `production` lacks that secret. Nothing was deployed. Add it as in section 2. |
| `Preview skipped` / `Preview tests skipped` notice | A preview secret is absent. Add it as in section 3. |
| `Preview tests comment check failed: ...` | The comment is not from this run and commit. Re-run the workflow; do not merge on that comment. |
