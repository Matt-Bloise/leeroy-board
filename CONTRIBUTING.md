# Contributing

This repo is the home of the Leeroy board: the site (Cloudflare Pages), the Worker and Durable Object (`infrastructure/`), the D1 schema and the tests (`tests/`). Production is https://leeroy.party and https://api.leeroy.party. Every merge to master deploys.

## How a change goes in
1. One branch per change, one pull request per branch. One open PR per contributor at a time (Cloudflare has 9 preview environments in total; see `docs/runbooks/preview-d1-limit.md`).
2. The PR states a risk rating from 0 to 10 (see the PR template). The rating sets the testing effort and who merges: 0 to 5 merges after the gate comment `Preview tests: passed` appears for the head commit; 6 or higher waits for a manual merge by the owner. A rating is computed from the changed paths first and only ever raised.
3. CI is lean by default (this repo is public) because the owner keeps a CI minutes budget (priced as $0.006 per Linux minute, each job rounded up, $20 hard-stop) and the Worker has a daily request limit. Every push runs only `unit`, `stamps` and `scope` and the `report` comment (`### Light checks: ...`, not the merge gate). The preview environment, the back-end suite (API input and output), the front-end suites (browser smoke with a 3-condition degraded-modes subset, layout sweep) run only when the PR carries the label `ci-full`, which the owner's brain adds when the PR is final (at most two at a time; a push after the label re-runs the heavy suite). The browser and layout jobs are skipped when `tools/ci-scope.mjs` finds no site file, `tools/`, `.github/`, `infrastructure/wrangler*` or `package*.json` change. The gate comment `### Preview tests: passed (<sha7>)` comes only from a full run (or from a docs-only PR, which needs no label); a skipped job satisfies required status checks, so the comment, not the checks, is the gate. Fork PRs cannot earn it, and `pull_request_target` is never used. Semgrep runs on code PRs, ZAP nightly against production (or on a PR with the labels `security` and `ci-full`), the full degraded-modes suite nightly against production, and Lighthouse (informational) nightly against production. A PR that changes only `docs/**`, root `*.md` or `.github/ISSUE_TEMPLATE/**` gets no preview and runs only the unit and stamps jobs. New behaviour comes with tests in `tests/`. Cost model, gate contract, nightly rules and the budget policy: `docs/runbooks/ci-minutes.md`.
4. Tests make no AI calls (free Workers AI has a very low rate limit). Discord interactions cannot be tested in a preview and are checked on production after merge.
5. Every PR states how to roll back: Pages previous deployment, `wrangler rollback`, D1 Time Travel, or a revert.
6. Back-end changes (anything under `infrastructure/`) must include a test in `tests/api` (behaviour through the API) or `tests/unit` (pure functions).
   A back-end PR without a test in its diff is not merged.
7. Run `node tools/stamps.mjs --write` before committing any js, scenes or css change. The `?v=` stamps are the first 10 hex characters of the sha256 of the file; CI fails on stale stamps.

We accept a before and after number on a stated device (frame time, long animation frames, bytes, render counts) for performance changes. No secrets in the repo, and no first names or Discord ids in code or copy.

## Contributions

The code and art are copyright Matt Bloise, all rights reserved (see LICENSE.md). By opening a pull request you confirm that you wrote the change, or have the right to submit it, and you grant Matt Bloise a perpetual, worldwide, royalty-free licence to use, modify and relicense it. You are credited in the commit.
