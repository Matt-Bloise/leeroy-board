# Runbook: preview D1 limit

Scope: the per-PR preview environments built by `.github/workflows/pr-preview-cloudflare.yml` and tested by `.github/workflows/preview-tests.yml`.

## How the cap works

Each PR from a branch of this repo gets its own D1 database, `leeroy-board-db-pr-<N>`, next to its Worker `leeroy-brain-pr-<N>` and Pages branch `pr-<N>`. The database is created on `opened`, `synchronize` and `reopened` (reused if it already exists) and deleted when the PR is closed or merged (`teardown-pr-preview`).

The Cloudflare Free plan allows 10 D1 databases per account. Production (`leeroy-board-db`) uses one, which leaves 9 for previews, the number in CONTRIBUTING.md. Any other D1 database in the account lowers that number. The 10th creation fails with `System limit reached: databases per account (10)`, API code **7406**.

Consequences:
- The cap counts open PRs, drafts included. A draft PR holds a slot like any other PR.
- Closing or merging a PR frees its slot. Nothing else does.
- The failure is on the creating PR only. Existing previews keep working.

## What the workflow does

- **Code PRs**: unchanged. On 7406 the "Provision Ephemeral D1 Database" step posts the comment `Preview limit reached; will retry when a slot frees.` (marker `<!-- cloudflare-pr-preview-limit -->`), then fails the job. Other create errors still fail with the wrangler output and no such comment.
- **Retry**: when any PR is closed or merged and its teardown finishes, job `retry-waiting-previews` looks (oldest PR first) for an open PR whose limit comment names its current head commit, and re-runs the failed jobs of that commit's `PR Ephemeral Preview Environment` and `Preview Tests` runs. One PR is retried per freed slot. If the slot is gone again, the PR gets the same comment again. Pushing a new commit also retries, as before.
- **Success later**: the sticky preview comment step removes the limit comment.
- **Docs-only PRs** (only `docs/**`, root-level `*.md` or `.github/ISSUE_TEMPLATE/**`, decided by `tools/docs-only.mjs`, renames counted on both sides): no D1 database, Worker or Pages deploy. The PR gets a comment marked `<!-- cloudflare-pr-preview-skipped -->`. Preview Tests runs only `unit` and `stamps` and posts `### Preview tests: passed (<sha7>)` with a `passed (docs only)` line, the same heading the merge tooling reads.

## Check and free slots by hand

With `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` set in your shell (never paste their values anywhere), from `infrastructure/`:

```
npx wrangler d1 list
```

Names `leeroy-board-db-pr-<N>` whose PR is closed are leaked previews (a failed teardown). Check that PR is closed, then:

```
npx wrangler d1 delete leeroy-board-db-pr-<N>
npx wrangler delete --name leeroy-brain-pr-<N>
```

Never delete `leeroy-board-db`. After freeing a slot, re-run the failed jobs of the waiting PR from the Actions tab, or push to it.

## Raising the cap

Moving to the Workers Paid plan raises the D1 database limit. Until then, keep PRs few (CONTRIBUTING.md: one open PR per contributor) and close abandoned ones.
