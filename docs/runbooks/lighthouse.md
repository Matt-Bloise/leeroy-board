# Lighthouse performance budget

`.github/workflows/lighthouse.yml` runs Lighthouse (`@lhci/cli@0.14.0`, which bundles Lighthouse 12) against each PR preview and posts one comment, marked `<!-- lighthouse -->`, updated in place. It is **informational**: it can never fail or block a PR. Every assertion is level `warn`, the job is `continue-on-error`, the lhci step ends in `exit 0`, and the Preview Tests report does not depend on it.

## What it does

1. Trigger: `pull_request` (opened, synchronize, reopened, ready_for_review), same-repository branches only. Not `workflow_run`.
2. Docs-only PRs (`tools/docs-only.mjs`) have no preview, so the job posts a note and stops.
3. It waits up to 12 minutes for the `<!-- cloudflare-pr-preview -->` comment that names the head sha (same pattern as `preview-tests.yml`), then until the preview answers 200.
4. It audits `<preview>/` and `<preview>/landing/`, three runs each, mobile emulation at 390x844 (deviceScaleFactor 2), performance category only.
5. The comment shows the median run (by LCP): score, LCP, CLS, total bytes, JavaScript bytes, image bytes, each against its budget. Reports are in the `lighthouse` artifact (14 days).

Permissions: `contents: read`, `pull-requests: write`. No secrets.

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

Delete `.github/workflows/lighthouse.yml`, `lighthouserc.json` and this file. Nothing else depends on them.
