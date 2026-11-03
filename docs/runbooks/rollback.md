# Runbook: rollback

Scope: production at https://leeroy.party (Pages) and https://api.leeroy.party (Worker `leeroy-brain`, Durable Object `BoardRoom`, D1 `leeroy-board-db`). Names come from `infrastructure/wrangler.toml:1,8-10,19-23,26-28` and `.github/workflows/deploy-cloudflare.yml:19-20`.

Last checked: 2026-11-02. Claims marked (docs) cite Cloudflare documentation read that day; (cli) means `npx wrangler <cmd> --help` on wrangler 3.114.17, the version `infrastructure/package.json:22` (`^3.109.0`) resolves to today; (unverified) means not confirmed.

## What a deploy touches

Every push to `master` runs one job (`deploy-cloudflare.yml:3-6,13`) that, in order: runs `schema.sql`, applies migrations, seeds only if `kv_state` is empty, deploys the Worker, syncs Worker secrets, deploys Pages, attaches domains (`deploy-cloudflare.yml:195-224,226-246,248-268,270-290,292-305`). The layers roll back independently. A Worker rollback does not undo Pages or D1, and a revert commit does not undo a database change.

Requirements for every command below: run from `infrastructure/` after `npm install`, with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` set in the shell (the same names the workflow uses, `deploy-cloudflare.yml:17-18`). Never paste token values into an issue, PR or log.

## Deploy safety (what the deploy refuses to do)

Added after the Nov 3 red-team review. `deploy-cloudflare.yml` now fails closed:

- **No silent database creation.** If the D1 lookup (`wrangler d1 list --json`) fails, or `leeroy-board-db` is not in the account, the job stops with `::error::` and changes nothing. Likely causes: wrong `CLOUDFLARE_ACCOUNT_ID`, a token for another account, or a Cloudflare outage. Fix the cause and re-run. Only for a true first-time setup, start the workflow by hand (Actions, Run workflow, `allow_create_database` ticked); that is the only way a database is ever created, and it seeds from the repository JSON. A push to `master` never creates one.
- **No deploy token in the Worker.** `AI_GATEWAY_TOKEN` comes only from the repository secrets `AI_GATEWAY_TOKEN` or `CLOUDFLARE_AIG_TOKEN`. If neither is set the step prints a `::warning::` and does not run `secret put`; that does not delete a value already stored in the Worker, which is kept. `CLOUDFLARE_API_TOKEN` is never written to the Worker. After rotating the deploy token, check for leftovers from `infrastructure/`: `npx wrangler secret list`. If it lists `CLOUDFLARE_API_TOKEN`, run `npx wrangler secret delete CLOUDFLARE_API_TOKEN`. If it lists `AI_GATEWAY_TOKEN` and its value is (or may be) the old deploy token, either delete it with `npx wrangler secret delete AI_GATEWAY_TOKEN` or let the next deploy overwrite it from the dedicated GitHub secret (see `docs/runbooks/secrets.md`).
- **Post-deploy health check.** The last step calls `https://api.leeroy.party/api/health` up to 5 times, 10 s apart, and needs HTTP 200 JSON with `ok: true` and `db: "ok"` (the Worker runs `SELECT 1` on D1; on failure it answers 503 `db: "error"`). If it fails, the Worker or D1 is unhealthy: use section 2 below to roll the Worker back, or revert the PR that deployed it.
- A manual run only deploys from `master` (job `if`).

## 1. Pages (static site)

Dashboard (docs: https://developers.cloudflare.com/pages/configuration/rollbacks/): Workers & Pages, project `leeroy-board`, Deployments, open the menu on the target production deployment, "Rollback to this deployment", confirm. Only successfully built production deployments are valid targets; previews are not. It takes effect immediately.

List candidates from the shell (cli):

```
npx wrangler pages deployment list --project-name leeroy-board --environment production
```

The Cloudflare rollback page documents only the dashboard method; no `wrangler pages` rollback command was found (cli help lists none for `pages deployment`; the sub-commands were not exhaustively checked). A rollback pins an old build; the next push to `master` deploys a new one on top of it, so fix forward or revert before merging anything else (see section 4).

Note: the deployed `js/brain.js` has the Worker URL stamped in at deploy time (`deploy-cloudflare.yml:280-286`). Production resolves to `https://api.leeroy.party` (`:239-245`), which is stable, so an old Pages build still talks to the current Worker. If the Worker API changed incompatibly, roll back both layers.

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
- A rollback is refused if a Durable Object class lifecycle change (the `[[migrations]]` array) happened between the active version and the target. Today only one tag exists, `v1` (`wrangler.toml:31-33`), so this blocks nothing until a second tag is added.
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

Retention: the docs say Workers Paid plans restore up to 30 days back and Workers Free plans 7 days. Which plan this account is on is unverified (`wrangler.toml:18,25,35` describe free-tier limits but do not prove the plan). Plan on 7 days until the owner confirms the plan in the dashboard.

Before any restore: note the current bookmark, and take an export as a second copy (cli): `npx wrangler d1 export leeroy-board-db --remote --output=../_scratch-backup.sql` (keep it out of the repo; see `backup-restore.md`). A restore also rewinds live edits made through the app since the target time (sign-ups, sheet events, ask history). The Durable Object holds no storage of its own (`infrastructure/README.md:14`).

## 4. Revert through the normal process

1. `git revert -m 1 <merge-sha>` on a branch `revert/<topic>`; open a PR to `master` (`CONTRIBUTING.md:6-8`: one branch, one PR, risk rating, preview tests).
2. A revert that touches only paths rated 0 to 5 merges after green preview tests; a revert touching `infrastructure/`, workflows, or `wrangler.toml` is rated 8 or higher and waits for a manual merge by the owner (`CONTRIBUTING.md:7`, `.github/pull_request_template.md:4`).
3. The merge deploys the full pipeline again (`deploy-cloudflare.yml:3-6`). Allow the preview tests and the deploy to finish; the preview wait alone can take up to 12 minutes (`preview-tests.yml:51,67`).
4. A revert never undoes data. If the bad commit changed D1 (a migration, a seed, a write path), also use section 3.

If the reverted change added a migration file: reverting the file does not drop the table or column it created, and `wrangler d1 migrations apply` records applied names in D1 (unverified detail: the `d1_migrations` table). Write a new forward migration instead (`schema-source-of-truth.md`).

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
