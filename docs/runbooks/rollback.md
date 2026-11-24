# Runbook: rollback

Scope: production at https://leeroy.party (Pages) and https://api.leeroy.party (Worker `leeroy-brain`, Durable Object `BoardRoom`, D1 `leeroy-board-db`). Names come from `infrastructure/wrangler.toml:1,8-10,26-28,33-36` and `.github/workflows/deploy-cloudflare.yml:88-89`.

Last checked: 2026-11-02 (CLI claims below were confirmed on wrangler 3.114.17; the repo now pins 4.148.0, re-check `--help` output when you next use a command). Claims marked (docs) cite Cloudflare documentation read that day; (cli) means `npx wrangler <cmd> --help` on wrangler 3.114.17, the version the repo resolved to when this was checked (`infrastructure/package.json:22` now pins 4.148.0 exactly); (unverified) means not confirmed.

## What a deploy touches

A push to `master` (unless every changed file is ignored, see "When a push deploys") or "Run workflow" on `master` runs the job `deploy-production` (`deploy-cloudflare.yml:3-6,62,77-84`) that, in order: ensures the D1 database exists, records a Time Travel bookmark, runs `schema.sql`, applies migrations, seeds only if `kv_state` is empty, merges the library data, deploys the Worker, creates missing Flagship flags, syncs Worker secrets, deploys Pages, attaches domains, runs the health check and syncs the Discord slash commands (`deploy-cloudflare.yml:274,332,351,363,382,391,411,420,448,474,489,510`). A second job, the production probe (`:524`), only reports and never rolls back. The layers roll back independently. A Worker rollback does not undo Pages or D1, and a revert commit does not undo a database change.

Requirements for every command below: run from `infrastructure/` after `npm install`, with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` set in the shell (the same names the workflow uses, `deploy-cloudflare.yml:86-87`). Never paste token values into an issue, PR or log.

## Deploy safety (what the deploy refuses to do)

Added after the Nov 3 red-team review. `deploy-cloudflare.yml` now fails closed:

- **No silent database creation.** If the D1 lookup (`wrangler d1 list --json`) fails, or `leeroy-board-db` is not in the account, the job stops with `::error::` and changes nothing. Likely causes: wrong `CLOUDFLARE_ACCOUNT_ID`, a token for another account, or a Cloudflare outage. Fix the cause and re-run. Only for a true first-time setup, start the workflow by hand (Actions, Run workflow, `allow_create_database` ticked); that is the only way a database is ever created, and it seeds from the repository JSON. A push to `master` never creates one.
- **No deploy token in the Worker.** `AI_GATEWAY_TOKEN` comes only from the repository secrets `AI_GATEWAY_TOKEN` or `CLOUDFLARE_AIG_TOKEN`. If neither is set the step prints a `::warning::` and does not run `secret put`; that does not delete a value already stored in the Worker, which is kept. `CLOUDFLARE_API_TOKEN` is never written to the Worker. After rotating the deploy token, check for leftovers from `infrastructure/`: `npx wrangler secret list`. If it lists `CLOUDFLARE_API_TOKEN`, run `npx wrangler secret delete CLOUDFLARE_API_TOKEN`. If it lists `AI_GATEWAY_TOKEN` and its value is (or may be) the old deploy token, either delete it with `npx wrangler secret delete AI_GATEWAY_TOKEN` or let the next deploy overwrite it from the dedicated GitHub secret (see `docs/runbooks/secrets.md`).
- **Post-deploy health check.** The last step calls `https://api.leeroy.party/api/health` up to 5 times, 10 s apart, and needs HTTP 200 JSON with `ok: true` and `db: "ok"` (the Worker runs `SELECT 1` on D1; on failure it answers 503 `db: "error"`). If it fails, the Worker or D1 is unhealthy: use section 2 below to roll the Worker back, or revert the PR that deployed it.
- A manual run only deploys from `master` (job `if`).

## When a push deploys (queueing and skipped pushes)

Added 2026-11-19 with the CI-minutes change. Source of truth: `on.push.paths-ignore` and `concurrency` in `.github/workflows/deploy-cloudflare.yml`, pinned by `tests/unit/deploy-trigger.test.mjs`.

**Queueing.** The workflow sits in the concurrency group `cloudflare-production-master` with `cancel-in-progress: false`. A deploy that is running is never cancelled, so `wrangler d1 migrations apply` is never killed mid-run by a newer merge. GitHub allows at most one running and one pending run per group; a newer run replaces an older pending run (the replaced run is cancelled before it starts). Merging several PRs back to back therefore runs the first deploy, skips the ones in between, and runs ONE final deploy. Each run checks out its own pushed sha, so the final deploy contains every earlier merge.

Limits of the guarantee:
- The pending replacement is GitHub behaviour, not something this repo implements (https://docs.github.com/en/actions/using-jobs/using-concurrency: "At most one job or workflow run can be `pending`"; an existing pending run in the group is cancelled when a newer one queues). Re-read that page if the behaviour is ever in doubt.
- The guarantee covers the job running inside the group. A person who cancels a run by hand, a runner failure, or the 6 hour job limit can still stop a migration partway; `schema.sql` uses IF NOT EXISTS broadly (not verified for every statement) and `d1 migrations apply` records applied names, so a re-run resumes. Time Travel bookmark: section 3.
- The post-deploy smoke job (`post-deploy-smoke`, about 15 Worker requests; the full production probe runs once a day in `prod-probe-daily.yml`) is in the same run and in the `production-probe` concurrency group, so it holds the group until it finishes; a queued deploy waits for it. To run the browser smoke again for what is deployed, without deploying, start `production-smoke.yml` by hand on `master` (it also says which commit production serves, by comparing `?v=` stamps); do not use `workflow_dispatch` of this workflow for that, it deploys.

**Skipped pushes.** A push to `master` does not start the deploy when every changed file matches `paths-ignore`: `docs/**`, the test folders the deploy does not read (`tests/unit/`, `tests/api/`, `tests/contract/`, `tests/csp/`, `tests/fixtures/`, `tests/load/`, `tests/local/`, `tests/visual/`; NOT `tests/browser/`, `tests/helpers/` or `tests/package*.json`, which the production probe job reads), `**/*.md`, `.github/ISSUE_TEMPLATE/**`, `.claude/**`, and the tools the deploy and the Pages bundle never run (explicit file list). GitHub evaluates the filter per push against that push's own diff (https://docs.github.com/en/actions/writing-workflows/workflow-syntax-for-github-actions: when all changed paths match, the workflow does not run). Nothing is lost by skipping: the next push that does deploy checks out its own sha, which includes the skipped commits. Anything under `infrastructure/`, `data/`, `pages-worker/`, `js/`, `css/`, `scenes/`, `index.html`, `wrangler.toml`, `schema.sql`, migrations, and the four deploy tools (`pages-bundle`, `d1-row-count`, `flagship-ensure-flags`, `sync-discord-commands`) always deploys. A new file under `tools/` deploys until it is added to the ignore list (fail safe).
- `workflow_dispatch` is unchanged and ignores path filters: "Run workflow" on `master` deploys the current HEAD whatever it contains. Use it when a docs-only merge must be reflected or a failed deploy must be retried.
- A deploy that failed is not retried by a later skipped push. Re-run it by hand.
- Branch protection: unknown for this repo. `docs/roadmap/PRODUCT-REVIEW.md` (2026-11-02) recorded no branch protection and no rulesets, and `docs/runbooks/ci-minutes.md` says required checks "if any are configured" are not changed by CI-lean work. Required status checks apply to the pull request head, not to push runs on `master`, so skipping the push deploy cannot block a merge either way. Confirm with `gh api repos/Matt-Bloise/leeroy-board/branches/master/protection` before relying on this.

## 1. Pages (static site)

Dashboard (docs: https://developers.cloudflare.com/pages/configuration/rollbacks/): Workers & Pages, project `leeroy-board`, Deployments, open the menu on the target production deployment, "Rollback to this deployment", confirm. Only successfully built production deployments are valid targets; previews are not. It takes effect immediately.

List candidates from the shell (cli):

```
npx wrangler pages deployment list --project-name leeroy-board --environment production
```

The Cloudflare rollback page documents only the dashboard method; no `wrangler pages` rollback command was found (cli help lists none for `pages deployment`; the sub-commands were not exhaustively checked). A rollback pins an old build; the next push to `master` deploys a new one on top of it, so fix forward or revert before merging anything else (see section 4).

Note: the deployed `js/brain.js` has the Worker URL stamped in at deploy time (`deploy-cloudflare.yml:462-468`). Production resolves to `https://api.leeroy.party` (`:407-409`), which is stable, so an old Pages build still talks to the current Worker. If the Worker API changed incompatibly, roll back both layers.

Pages and Worker are a pair for the member documents: the board reads `client`, `party`, `decide`, `tonight` and `guided-atlas` from the Worker only (`/api/data/<name>`, no static fallback). A newer Pages build with an older Worker gives `/api/data/client` a 404 (the older Worker has no bundled client document), so the board shows the could-not-load line. Roll back the Worker and Pages together (sections 1 and 2), never one of them alone across that change.

## 2. Worker and Durable Object

```
npx wrangler deployments list --name leeroy-brain      # 10 most recent (cli)
npx wrangler versions list --name leeroy-brain         # 10 most recent versions (cli)
npx wrangler rollback <version-id> --name leeroy-brain -m "reason"   # omit id to pick interactively (cli)
```

Dashboard (docs: https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/): Workers & Pages, `leeroy-brain`, Deployments, menu on the target version, Rollback.

Limits (docs, same page):
- Only the 100 most recent versions can be targeted.
- Bindings and resources are not reverted. Old code that expects an older D1 shape may fail.
- A rollback is refused if a Durable Object class lifecycle change (the `[[migrations]]` array) happened between the active version and the target. Today only one tag exists, `v1` (`wrangler.toml:38-40`), so this blocks nothing until a second tag is added.
- Secrets: the page does not say how they are handled (unverified). Check `npx wrangler secret list --name leeroy-brain` after a rollback.
- A rollback leaves the next push to `master` free to redeploy the broken code. Pause deploys first if the bad code is still on `master` (`incident.md`, "Pause merges").

## 3. D1 database

Time Travel is in-place and destructive but reversible (docs: https://developers.cloudflare.com/d1/reference/time-travel/). Read the Retention note first.

```
npx wrangler d1 time-travel info leeroy-board-db                                   # current bookmark (save it)
npx wrangler d1 time-travel info leeroy-board-db --timestamp="2026-11-02T14:00:00Z"   # bookmark at a past time
npx wrangler d1 time-travel restore leeroy-board-db --timestamp=<unix-or-rfc3339>
npx wrangler d1 time-travel restore leeroy-board-db --bookmark=<bookmark>
```
Flags confirmed with `--help` (cli). Behavior (docs): in-flight queries are cancelled and clients get errors; the restore prints the previous bookmark, and restoring to that bookmark undoes the restore; bookmarks older than the retention window are invalid.

Retention: the docs say Workers Paid plans restore up to 30 days back and Workers Free plans 7 days. Which plan this account is on is unverified (`wrangler.toml:13,16,20,21,32,42` describe free-tier limits but do not prove the plan). Plan on 7 days until the owner confirms the plan in the dashboard.

The production deploy job now records the current bookmark automatically before migrations apply: open the run's job summary, heading "D1 Time Travel bookmark before migrations" (read-only, never blocks the deploy; PR previews are not covered). Before any restore: note the current bookmark (the summary of the deploy being undone has it), and take an export as a second copy (cli): `npx wrangler d1 export leeroy-board-db --remote --output=../_scratch-backup.sql` (keep it out of the repo; see `backup-restore.md`). A restore also rewinds live edits made through the app since the target time (sign-ups, sheet events, ask history). The Durable Object holds no storage of its own (`infrastructure/README.md:14`).

## 4. Revert through the normal process

1. `git revert -m 1 <merge-sha>` on a branch `revert/<topic>`; open a PR to `master` (`CONTRIBUTING.md:6-8`: one branch, one PR, risk rating, preview tests).
2. A revert that touches only paths rated 0 to 5 merges after green preview tests; a revert touching `infrastructure/`, workflows, or `wrangler.toml` is rated 8 or higher and waits for a manual merge by the owner (`CONTRIBUTING.md:7`, `.github/pull_request_template.md:4`).
3. The merge deploys the full pipeline again (`deploy-cloudflare.yml:3-6`). Allow the preview tests and the deploy to finish; the preview wait alone can take up to 12 minutes (`preview-tests.yml:202,214`: 48 tries, 15 s apart).
4. A revert never undoes data. If the bad commit changed D1 (a migration, a seed, a write path), also use section 3.

If the reverted change added a migration file: reverting the file does not drop the table or column it created, and `wrangler d1 migrations apply` records applied names in D1 (unverified detail: the `d1_migrations` table). Write a new forward migration instead (`schema-source-of-truth.md`).

## Feature flags (Flagship)

A flag that lives in Cloudflare Flagship is rolled back by **flipping it off in the dashboard**: no deploy, no revert. Details, the `[[flagship]]` binding and the fallback to `wrangler.toml` `[vars]` when the binding is missing: docs/runbooks/flags.md. A code rollback (sections 1 to 4) does not change a flag's state; the flag stays as set in the dashboard.

## Decision table by symptom

| Symptom | First action | Then |
| :--- | :--- | :--- |
| Site renders wrong or blank, API healthy (`GET https://api.leeroy.party/api/health` is 200) | Pages rollback (section 1) | Revert PR |
| API 5xx or wrong responses right after a deploy, data intact | `wrangler rollback` (section 2) | Revert PR; pause deploys until it lands |
| Data wrong, missing or corrupted after a deploy or migration | Note bookmark, then D1 Time Travel to just before the deploy (section 3) | Roll back the Worker too if the code caused it; see `backup-restore.md` |
| Deploy workflow itself fails midway | Read the failing step in the Actions run; the previous Worker and Pages versions stay live | Fix forward or revert PR; do not hand-edit production |
| Rollback refused (Durable Object migration or missing binding) | Revert PR (section 4) | Fix forward |
| Both layers broken, cause unknown | Pause the deploy workflow, roll back Pages then Worker to the last good pair | Postmortem in `incident.md` |
| Secret leaked or wrong | Not a rollback: rotate (`secrets.md`) | |
