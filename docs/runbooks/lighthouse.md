# Lighthouse performance budget

The `lighthouse` job in `.github/workflows/nightly-production.yml` runs Lighthouse (`@lhci/cli@0.14.0`, which bundles Lighthouse 12) **once a night against production** (`https://leeroy.party/` and `/landing/`). It does not run on pull requests and is not part of a `ci-full` run (the former `lighthouse.yml` workflow is deleted; `lighthouserc.json` and `tools/lighthouse-summary.mjs` are still used by the nightly job and stay), which cost GitHub minutes and Worker requests on every push for numbers that barely move. It is **informational**: it can never fail the night or block anything. Every assertion is level `warn`, the job is `continue-on-error`, the lhci step ends in `exit 0`, and the `notify` job does not wait for it.

## What it does

1. Trigger: the nightly `schedule` (06:00 UTC) or "Run workflow" (`workflow_dispatch`) on `nightly-production.yml`. Scheduled workflows run only from `master`.
2. It audits `https://leeroy.party/` and `https://leeroy.party/landing/`, three runs each, mobile emulation at 390x844 (deviceScaleFactor 2), performance category only.
3. `tools/lighthouse-summary.mjs` writes the job summary: per URL the median run (by LCP): score, LCP, CLS, total bytes, JavaScript bytes, image bytes, each against its budget, and **how many Worker `/api/` requests the page loads made** (counted from Lighthouse's own request list). Reports are in the `nightly-lighthouse` artifact (14 days).
4. A pull request is not measured by CI. To measure one by hand, run it locally against the PR preview URL (this spends Worker requests on that preview, about 21 for a whole run), `npx @lhci/cli@0.14.0 autorun --config=lighthouserc.json --collect.url=<url>` and `node tools/lighthouse-summary.mjs`.

Permissions: `contents: read`. No secrets.

## Budgets

Defined in `lighthouserc.json` (`assertMatrix`, one block per URL pattern).

Starting values come from one local run against production on 2026-11-02 (Lighthouse 12.2.1, desktop Chrome, mobile 390x844, simulated throttling). **Speculative**: single run, local machine, not CI. Budgets are the measured value plus roughly 10% so a regression shows; they are not targets.

| Metric | `/` measured | `/` budget | `/landing/` measured | `/landing/` budget |
| :--- | ---: | ---: | ---: | ---: |
| LCP | 21.6 s | 25 s | 1.6 s | 2.5 s |
| CLS | 0 | 0.1 | 0 | 0.1 |
| Total byte weight | 7.44 MB | 8.2 MB | 35 kB | 60 kB |
| JavaScript (transfer) | 322 kB | 355 kB | 21 kB | 40 kB |
| Images (transfer) | 6.73 MB | 7.4 MB | 0 | 100 kB |

The board's image weight and LCP are far above normal web budgets. The root budget records the current state; tightening it is a separate decision.

## Changing a budget

Edit `lighthouserc.json` in a PR. After a few CI runs, replace the starting values with the CI medians.

## Promoting to a gate

Not planned. It would need: `warn` changed to `error`, `exit 0` and `continue-on-error` removed, and the job added as a required check. Collect many CI runs first; shared runners vary a lot.

## Rollback

Revert the PR that added it, or delete the `lighthouse` job in `.github/workflows/nightly-production.yml`, `tools/lighthouse-summary.mjs`, `lighthouserc.json` and this file. Nothing else depends on them.
