# Runbook: prune old Pages deployments and purge stale data from the edge

Prepared 2026-11-15. Nothing in this file has been run. The workflow and the tool were tested only against a stubbed Cloudflare API (`tests/unit/pages-prune.test.mjs`); they have never run against the real one.

## What it does and why

Since the member data files became Worker-only (`member-data-worker-only.md`), the Pages bundle no longer carries `data/party.json` and the other private files (`tools/pages-bundle.mjs` holds the list). Every older Pages deployment (`<hash>.leeroy-board.pages.dev`) still serves them, and the edge may still hold a cached copy at leeroy.party. This workflow removes both.

`.github/workflows/pages-prune.yml` (manual only: `workflow_dispatch`, from master) runs two steps:

1. `node tools/pages-prune.mjs prune`: lists every deployment of the `leeroy-board` Pages project and deletes all but the keep set.
2. `node tools/pages-prune.mjs purge`: purges the private data URLs from the leeroy.party zone cache (skipped when `purge_cache` is unticked). It runs even if step 1 stopped, and it never fails the job.

## Keep set (everything else is deleted)

- the current production deployment: `canonical_deployment` of the Pages project;
- the project's `latest_deployment` when it is also a production deployment (a deploy that is not canonical yet, or a rollback);
- the newest production-environment deployment in the list.

Preview deployments (`pr-<n>` branches) are not kept, including those of open pull requests. Matching previews to open PRs needs the GitHub API and cannot be done reliably from the Cloudflare data alone, and an old preview is exactly what still serves the private files. A pull request gets a new preview on its next push.

## Fail closed

Nothing is deleted, and the step exits 1, when: the production deployment id cannot be read from the project, it is not a production deployment, it is not in the deployment list, the list cannot be read to its last page, pagination does not advance, or more deployments qualify than `max_delete` (default 2000). A single deployment that cannot be deleted is counted and makes the step exit 1 at the end; a 401/403 on delete stops the run.

## How to run it

1. Actions, "Pages Prune (manual)", Run workflow on master. Leave `dry_run` ticked (the default). Leave `max_delete` at 2000 and `purge_cache` ticked unless there is a reason.
2. Read the log. It prints counts only: total, keep, would delete, by environment. Expect keep = 1 to 3 and would delete = everything else. If keep is not what you expect, or the run failed closed, stop and read the line it printed.
3. Run again with `dry_run` unticked. Progress is printed every 25 deletions, then one summary line.
4. Check: open an old `<hash>.leeroy-board.pages.dev/data/party.json`; it should no longer resolve. leeroy.party/data/party.json should answer 404 after the purge.

The log of a public repository is public: the tool prints no deployment id, branch, account id, zone id, token or response body, and a test pins that.

## Rollback

None for deleted deployments. A deleted Pages deployment cannot be restored; the production deployment is kept, so the live site is not affected, and a new deploy rebuilds anything else. That is why the dry run comes first and is the default (any `DRY_RUN` value other than the exact text `false` is a dry run).

## The edge cache, honestly

- leeroy.party is a zone of this account: the purge asks for explicit URLs (`https://leeroy.party/data/<name>.json` for party, decide, tonight, guided-atlas, client, signups, plus `data/atlas/links.json`, whose cached copy is the unreduced one). Wildcard and prefix purges need Enterprise, so they are not used. The list is imported from `tools/pages-bundle.mjs`, not copied.
- `leeroy-board.pages.dev` is not a zone of this account, so the zone API cannot purge it. Those cache entries expire on their own and are cleared for good once the old deployments are deleted. The log says this in one line.
- If the token lacks the permission, the step prints `cache purge skipped: token lacks Cache Purge permission` and exits 0. Any other purge problem is a warning and exits 0.

## Token permissions

`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are the repository secrets the deploy workflows already use (nothing new to add). The token needs:

- Account > Cloudflare Pages > Edit (list and delete deployments);
- Zone > Zone > Read and Zone > Cache Purge > Purge, scoped to leeroy.party (optional: without them the purge step skips).

**Action for the owner (Matt or Josh, not done by any workflow or agent):** the deploy token currently lacks Zone > Cache Purge (reported 2026-11-15), so the purge step cannot work. To enable it, edit the token in the Cloudflare dashboard (My Profile, API Tokens) and add Zone > Cache Purge > Purge plus Zone > Zone > Read for the zone leeroy.party; no repository secret changes. Then run this workflow again with `dry_run` unticked (the prune step finds nothing left to delete; the purge step runs). Be aware that after 2026-11-15 the stale copies were found to sit in a layer a zone purge is not expected to clear (Pages' built-in asset cache; a dashboard "Purge Everything" changed nothing). The answer there is the Pages Function that now serves 404 for those paths (docs/runbooks/member-data-worker-only.md, "The stale copy"); the purge stays useful for `data/atlas/links.json` and as belt and braces.

If the configured account id is not the account that owns the project, the project call fails and the run fails closed (the deploy workflow auto-resolves a single-account token; this tool does not).
