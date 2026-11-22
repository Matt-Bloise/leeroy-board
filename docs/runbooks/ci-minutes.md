# Runbook: CI minutes (lean by default)

Scope: `.github/workflows/preview-tests.yml`, `pr-preview-cloudflare.yml`, `security.yml`, `nightly-production.yml` (Lighthouse moved there from `lighthouse.yml`, removed). `deploy-cloudflare.yml` skips pushes that change only docs, tests, markdown or tools it never runs (`on.push.paths-ignore`; rules and queueing: `rollback.md`, "When a push deploys"). Cross-engine QA (`cross-engine.yml`) already runs only on a daily schedule and by hand, never per push or PR.

## Cost model

- This repository is public (since 2026-11-19), so standard GitHub-hosted Linux runners are free for it and nothing here is billed. The numbers below were measured when the repository was private and metered (about $0.006 per Linux minute); they are kept as a measure of runner time, not as money. The cost that remains is time: a full run is slow, holds a preview environment (the account has 9 D1 slots) and spends Worker requests (see the end of this page), so the light-by-default rules below still apply.
- **Every job was rounded up to a whole minute when billing applied.** A 10-second job counted 1 minute; a job that is skipped bills 0; a workflow run whose jobs are all skipped bills 0. Many small jobs cost more than one job doing the same work, which is why the former tiny jobs were folded.
- Every push to a PR starts runs. Measured on 2 November 2026 (validated against GitHub's meter within 4 percent): Preview Tests 8.3 min per run, PR Ephemeral Preview 3.2 min per run over 275 runs, Security Scan 6.2, Lighthouse 3.4 (Lighthouse has since moved to the nightly run against production; the total below is the figure measured at the time), about 21 minutes per push in total. Of 97 Preview Tests runs only 42 ended green, 28 were cancelled mid-run and 21 failed, 18 of them in the browser job (timing-sensitive degraded-modes checks such as "API held 12 s" on a slow preview).

## Light by default, heavy on request

Every push runs only `scope`, `unit`, `stamps` and `report` (Preview Tests), plus `visual` when a site file changed. Everything else needs the label **`ci-full`**.

| What | Runs when | Where |
| :--- | :--- | :--- |
| scope, unit, stamps, report | every push, draft or ready, same-repo PRs | `preview-tests.yml` |
| visual (visual baselines, gating) | every push of a same-repo PR where `tools/ci-scope.mjs` says a site file changed, light or full; no preview, no secret, 0 Worker requests (the checkout is served on the runner) | `preview-tests.yml`, `docs/runbooks/visual-baselines.md` |
| preview environment (Worker, D1, Pages) | label `ci-full`, PR not docs-only | `pr-preview-cloudflare.yml` |
| api | label `ci-full`, PR not docs-only | `preview-tests.yml` |
| browser, layout | label `ci-full` AND `tools/ci-scope.mjs` says "full" (site, tools, `.github`, wrangler, `package*.json` change) | `preview-tests.yml` |
| Lighthouse (informational) | nightly and "Run workflow", against production; no longer per PR | `nightly-production.yml` |
| Semgrep | code PRs: at least one changed file outside `docs/`, `tests/`, root `*.md`, `.github/ISSUE_TEMPLATE/`; also weekly on master | `security.yml` |
| ZAP baseline against the preview | PR has BOTH labels `security` and `ci-full` | `security.yml` |
| ZAP baseline against production | nightly | `nightly-production.yml` |
| degraded-modes, all 144 checks, against production | nightly | `nightly-production.yml` |
| Visual drift (the committed baselines against master, two shots per screen) | daily 07:35 UTC and "Run workflow"; report only, opens one issue when a scheduled run fails | `visual-drift.yml`, `docs/runbooks/visual-baselines.md` |
| Visual Baselines (render and commit new baselines, or calibrate) | "Run workflow" on a branch, never master | `visual-baselines.yml` |
| degraded-modes, 3 conditions (API aborted, API 500, JavaScript off) | in the browser job, per PR | `tests/browser/run.mjs` |

Behaviour of the labels:
- Adding `ci-full` (event `labeled`) starts the full run for the current head. A later push re-runs the heavy suite and cancels the previous run, so **label only when the PR is final**.
- Removing `ci-full` (event `unlabeled`) tears the preview down and frees one of the 9 D1 slots (see `preview-d1-limit.md`). The teardown job looks for the D1 database of that PR number; it does not depend on label history and exits after one cheap probe if there is none. Preview Tests ignores the removal, so a pass already earned for the head sha stays valid.
- Any other label (`security`, `visual`, ...) starts runs whose jobs are all skipped (0 minutes). Their concurrency setting is "do not cancel", so a `security` label event can never cancel a running `ci-full` run; it waits behind it.
- Concurrency: one group per workflow and PR, `${{ github.workflow }}-${{ github.event.pull_request.number }}`, cancel-in-progress true for real events.

## How the owner's brain labels PRs

- At most **two** PRs carry `ci-full` at a time (each one holds a preview environment; the account has 9 D1 slots and the heavy suite is where the minutes go).
- Put `ci-full` on a PR only when it is final: reviewed, rebased, no pushes expected. Then wait for the gate comment.
- Remove the label after the merge decision if the PR is not merging yet and you need the slot; the passed comment for that head sha stays.
- Docs-only PRs need no label: they get `### Preview tests: passed (<sha7>)` with a `passed (docs only)` line from the light run.
- Light path (`tools/docs-only.mjs`, output `docs_only`): besides docs, a PR whose every file is under `tests/unit/` or is a tool no workflow, deploy, bundle or browser test runs (`LIGHT_TOOL_FILES`, `LIGHT_TOOL_DIRS`: replay, shadow-ask, cost-model, restore and export helpers, ...) gets no preview and the gate comment `passed (docs only)` from unit and stamps. The unit job covers those files. Any other path forces the full rules. No workflow-level `paths` filter is used on Preview Tests or PR Preview, so the checks always report; only job-level `if` on the scope output skips jobs, and a skipped job counts as passing for required checks.
- `ci-scope` forces the browser and layout jobs for any change under `.github/`, `tools/`, `infrastructure/wrangler*`, any `package*.json`, and the site paths. Renames count on both sides. An empty list or an unknown path shape also forces them. A bug there is a silent gate bypass, so `tests/unit/ci-scope.test.mjs` covers each rule.

## The merge gate (contract for `merge-if-green`)

The gate is a **comment**, not a check. The comment is posted and updated in place by `report` in `preview-tests.yml` (marker `<!-- preview-tests -->`), body built by `tools/ci-report.mjs`.

The merge script must:
1. Read the PR head sha **at merge time** and take its first 7 hex characters as `<sha7>`.
2. Take the comment whose body contains `<!-- preview-tests -->` and whose author is `github-actions[bot]` (anyone can write similar text; ignore other authors).
3. Require that its body matches this regex (JavaScript or PCRE, multiline flag):

```
^### Preview tests: passed \(`?<sha7>`?\)[ \t]*\r?$
```

   Replace `<sha7>` with the literal sha, not a pattern. The sha is emitted in backticks today; both forms match. The reference implementation and its tests are `gateRegex` and `matchesGate` in `tools/ci-report.mjs` and `tests/unit/gate-phrase.test.mjs`.
4. Not use `!= failure`, "not red" or "all checks green" as a substitute. A skipped job satisfies a required status check, so green checks prove nothing here.

What each comment means:

| Heading | Meaning | Gate |
| :--- | :--- | :--- |
| `### Light checks: passed (<sha7>)` | only unit and stamps ran; text says the full suite was not requested and never contains the words "Preview tests" | no |
| `### Light checks: FAILED (<sha7>)` | unit or stamps failed | no |
| `### Preview tests: passed (<sha7>)` with a `Suites run: unit, stamps, api, browser, layout, visual` line | `ci-full`, site-affecting change, and `api`, `browser`, `layout` and `visual` all `success` | yes |
| `### Preview tests: passed (<sha7>)` with `Not run: browser, layout (scope rule ...)` | `ci-full`, scope rule says no site-affecting file changed, `api` success, browser and layout skipped (or success) | yes |
| `### Preview tests: passed (<sha7>)` with `**passed (docs only)**` | docs-only PR, unit and stamps success | yes |
| `### Preview tests: FAILED (<sha7>)` | anything else in a `ci-full` or docs-only run, including a skipped suite that the scope rule does not explain | no |

Facts the gate relies on:
- The `pull_request_target` event is **never** used. These workflows run the PR's own code with secrets only for same-repo branches; a fork PR gets no job in `preview-tests.yml` and `pr-preview-cloudflare.yml` skips every secret-using job for forks, so **a fork PR cannot earn the gate phrase** and cannot be merged by the script.
- Required status checks (if any are configured) count a skipped job as satisfied. Branch protection was not changed by the CI-lean change. Do not add jobs to branch protection expecting them to block light PRs.
- A new push replaces the comment with a Light or new Preview tests heading for the new sha, so a stale pass cannot match.

## Nightly (`nightly-production.yml`)

- Schedule 06:00 UTC plus manual "Run workflow". Jobs: `degraded` (all 144 degraded-modes checks, Chromium, against `https://leeroy.party/`), `zap` (passive baseline against production, high-risk alerts fail the run), `notify`.
- The delays in degraded-modes are **Playwright route interception inside the browser** (`failReq`, `ctx.route`, `page.route` in `tests/browser/degraded-modes.mjs`), not server-side flags, so the suite works against production and changes nothing there. That is why it could move out of the per-PR run; the per-PR browser job keeps 3 conditions via `run.mjs` (`--only api-abort,api-500,no-js`). Set `DEGRADED_FULL=1` to run all of them in a PR locally.
- Issue rule: the first failed night opens nothing and writes nothing; the previous finished run of the workflow is the memory. After two consecutive failed runs, `notify` searches for an open issue labelled `nightly`; it comments there if one exists, otherwise opens exactly one. It never closes the issue. Close it by hand when the nightly is green again.
- GitHub runs scheduled workflows **only on the default branch** and **disables them after 60 days without repository activity**. If the nightly goes quiet, open the Actions tab, select "Nightly Production Checks" and re-enable it, then run it once. A merged PR counts as activity.

## Expected runner minutes (measured under the former metering)

Estimates from the job list with each job rounded up to a whole minute. Durations are assumptions where marked; the measured averages above are the only hard numbers. Compare with the measured baseline of about 21 minutes per push.

| Scenario | Jobs (minutes each) | Total |
| :--- | :--- | ---: |
| Light push, code PR | scope 1, unit 1, stamps 1, report 1, Semgrep about 3 (assumed) | about 7 |
| Light push, docs-only or tests-only PR | scope 1, unit 1, stamps 1, report 1; Semgrep skipped by the path filter | 4 |
| Label event other than `ci-full` | every job skipped | 0 |
| Full run, site files changed | light jobs 4, prep 1, spin-up about 4, preview wait about 4, api about 5, browser about 7, layout about 6, Semgrep about 3 (all assumed; Lighthouse moved to the nightly) | about 34 |
| Full run, no site files changed (Worker or test change) | light jobs 4, prep 1, spin-up about 4, preview wait about 4, api about 5, Semgrep about 3; browser, layout skipped | about 21 |
| `security` label on a `ci-full` PR | ZAP about 6 plus the preview wait | about 8 |
| Teardown, no preview exists | one probe job | 1 |
| Teardown, preview exists | probe, wrangler install, deletes, retry step | about 2 |
| Production deploy per merge | unchanged | 1 |
| Nightly | degraded about 9, ZAP about 7, Lighthouse about 4 (the former per-PR figure, assumed), notify 1 | about 21 (about $0.13 per night, about $4 per month) |
| Visual drift | one job: install about 1, 30 screens twice about 6 (measured 2026-11-22: 160 s for one pass over all 30 screens, 164 s and 144 s on CI) | about 7 (about $0.04 per night, about $1.2 per month) |

Typical PR: five light pushes (about 35), one full run (about 38), one teardown (about 2) is about 75 minutes, about $0.45, against about 127 minutes for six pushes at the measured baseline. The saving comes from fewer heavy runs and from not cancelling or failing them mid-way, not from a cheaper heavy run.

## Budget policy (historical)

While the repository was private there was a $20 hard-stop budget (about 3,333 minutes) with alerts at 75, 90 and 100 percent. That policy no longer applies: the repository is public and standard runners are free. If the repository is made private again, restore it from git history of this file before relying on GitHub Actions.

## What to look at when these workflows first run

They were not run before the pull request that introduced them was opened (actionlint and unit tests only). See the PR body for the list.

## Worker requests (added with batch C)

CI minutes are not the only meter: the Workers Free plan allows 100,000 Worker requests a day for the whole account, and a `ci-full` run used to spend about 1,500 of them locally measured (the layout sweep alone 1,056). Browser suites now answer `/api/` from recorded fixtures (`tests/fixtures/api-snapshot`), so a full run is about 150 Worker requests (the API suite and `deploy-smoke`). The nightly `degraded-modes` run also answers from the fixtures (0 requests). Numbers, rules and the local workflow: `docs/runbooks/cloudflare-requests.md`.

## Browser job in shards (2026-11-20)

The `browser` job used to run 46 suites and the probe self-test one after another on one runner: about 50 minutes, 17 of them in `prod-probe-selftest.mjs` (44 cases, three at a time, each launching browsers and waiting out real settle timeouts; measured from the job log of run 44579852532). It is now one job name with seven matrix legs: the browser suites in 4 shards (`tests/browser/run.mjs --shard i/4`, live-smoke first in shard 0) and the self-test in 3 shards (`prod-probe-selftest.mjs --shard i/3`; shard 0 also owns the redirect and request-budget sections). The report job still reads `needs.browser.result`, the AND of all legs. `tests/unit/browser-shards.test.mjs` pins that the shards hold every suite and case exactly once. The self-test waits are deliberate (they prove the probe waits for slow chips and copy), so they are not shortened; the pool of three is rolling instead of fixed batches. Nightly, `nightly-production.yml` runs the self-test whole.
