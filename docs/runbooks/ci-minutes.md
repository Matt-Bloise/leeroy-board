# Runbook: CI minutes (lean by default)

Scope: `.github/workflows/preview-tests.yml`, `pr-preview-cloudflare.yml`, `security.yml`, `lighthouse.yml`, `nightly-production.yml`. `deploy-cloudflare.yml` is unchanged (about 1 minute per merge).

## Cost model

- This repo is private, so GitHub Actions is metered: **$0.006 per Linux minute**. The owner set a **$20 hard-stop budget**, which is about 3,300 minutes. Any free minutes included in the plan are used first and are not counted on here.
- **Every job is rounded up to a whole minute.** A 10-second job bills 1 minute; a job that is skipped bills 0; a workflow run whose jobs are all skipped bills 0. Many small jobs cost more than one job doing the same work, which is why the former tiny jobs were folded.
- Every push to a PR starts runs. Measured on 2 November 2026 (validated against GitHub's meter within 4 percent): Preview Tests 8.3 min per run, PR Ephemeral Preview 3.2 min per run over 275 runs, Security Scan 6.2, Lighthouse 3.4, about 21 minutes per push in total. Of 97 Preview Tests runs only 42 ended green, 28 were cancelled mid-run and 21 failed, 18 of them in the browser job (timing-sensitive degraded-modes checks such as "API held 12 s" on a slow preview).

## Light by default, heavy on request

Every push runs only `scope`, `unit`, `stamps` and `report` (Preview Tests). Everything else needs the label **`ci-full`**.

| What | Runs when | Where |
| :--- | :--- | :--- |
| scope, unit, stamps, report | every push, draft or ready, same-repo PRs | `preview-tests.yml` |
| preview environment (Worker, D1, Pages) | label `ci-full`, PR not docs-only | `pr-preview-cloudflare.yml` |
| api | label `ci-full`, PR not docs-only | `preview-tests.yml` |
| browser, layout | label `ci-full` AND `tools/ci-scope.mjs` says "full" (site, tools, `.github`, wrangler, `package*.json` change) | `preview-tests.yml` |
| Lighthouse | label `ci-full` AND the same scope rule | `lighthouse.yml` |
| Semgrep | code PRs: at least one changed file outside `docs/`, `tests/`, root `*.md`, `.github/ISSUE_TEMPLATE/`; also weekly on master | `security.yml` |
| ZAP baseline against the preview | PR has BOTH labels `security` and `ci-full` | `security.yml` |
| ZAP baseline against production | nightly | `nightly-production.yml` |
| degraded-modes, all 144 checks, against production | nightly | `nightly-production.yml` |
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
| `### Preview tests: passed (<sha7>)` with a `Suites run: unit, stamps, api, browser, layout` line | `ci-full`, site-affecting change, and `api`, `browser` and `layout` all `success` | yes |
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

## Expected billable minutes

Estimates from the job list with each job rounded up to a whole minute. Durations are assumptions where marked; the measured averages above are the only hard numbers. Compare with the measured baseline of about 21 minutes per push.

| Scenario | Jobs (minutes each) | Total |
| :--- | :--- | ---: |
| Light push, code PR | scope 1, unit 1, stamps 1, report 1, Semgrep about 3 (assumed) | about 7 |
| Light push, docs-only or tests-only PR | scope 1, unit 1, stamps 1, report 1; Semgrep skipped by the path filter | 4 |
| Label event other than `ci-full` | every job skipped | 0 |
| Full run, site files changed | light jobs 4, prep 1, spin-up about 4, preview wait about 4, api about 5, browser about 7, layout about 6, Lighthouse about 4, Semgrep about 3 (all assumed) | about 38 |
| Full run, no site files changed (Worker or test change) | light jobs 4, prep 1, spin-up about 4, preview wait about 4, api about 5, Semgrep about 3; browser, layout, Lighthouse skipped | about 21 |
| `security` label on a `ci-full` PR | ZAP about 6 plus the preview wait | about 8 |
| Teardown, no preview exists | one probe job | 1 |
| Teardown, preview exists | probe, wrangler install, deletes, retry step | about 2 |
| Production deploy per merge | unchanged | 1 |
| Nightly | degraded about 9, ZAP about 7, notify 1 (assumed) | about 17 (about $0.10 per night, about $3 per month) |

Typical PR: five light pushes (about 35), one full run (about 38), one teardown (about 2) is about 75 minutes, about $0.45, against about 127 minutes for six pushes at the measured baseline. The saving comes from fewer heavy runs and from not cancelling or failing them mid-way, not from a cheaper heavy run.

## Budget policy

The $20 budget is about 3,333 minutes. Alerts at 75, 90 and 100 percent:

| Spend | Minutes (about) | Action |
| :--- | ---: | :--- |
| 75 percent ($15) | 2,500 | Freeze heavy CI: no new `ci-full` labels except for a fix to production, disable the nightly in the Actions tab. Light checks and deploys continue. |
| 90 percent ($18) | 3,000 | Deploys only: merge only what must ship, and the owner checks such a PR by hand against the CONTRIBUTING.md list; disable PR workflows from the Actions tab if needed. `deploy-cloudflare.yml` keeps running (1 minute per merge). |
| 100 percent ($20) | 3,333 | GitHub stops all runs, deploys included. Deploy by hand from the owner's machine with the same `wrangler` commands as `deploy-cloudflare.yml` (rollback commands: `rollback.md`) until the budget is raised or the month resets. |

## What to look at when these workflows first run

They were not run before the pull request that introduced them was opened (actionlint and unit tests only). See the PR body for the list.

## Worker requests (added with batch C)

CI minutes are not the only meter: the Workers Free plan allows 100,000 Worker requests a day for the whole account, and a `ci-full` run used to spend about 1,500 of them locally measured (the layout sweep alone 1,056). Browser suites now answer `/api/` from recorded fixtures (`tests/fixtures/api-snapshot`), so a full run is about 150 Worker requests (the API suite and `deploy-smoke`). The nightly `degraded-modes` run also answers from the fixtures (0 requests). Numbers, rules and the local workflow: `docs/runbooks/cloudflare-requests.md`.
