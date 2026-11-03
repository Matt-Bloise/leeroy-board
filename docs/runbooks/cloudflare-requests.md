# Runbook: Cloudflare Worker requests (Workers Free quota)

## The limit

- Workers Free allows **100,000 requests per UTC day for the whole account**, all Workers together (production `leeroy-brain`, every per-PR preview Worker, even ones deleted afterwards). The counter resets at **00:00 UTC**. When it is reached, every Worker answers with an error until the reset, production included.
- On 2 November 2026 the account reached 100,424 by 23:11 UTC. Production itself is about 15,600 a day; the rest was CI.
- **Law (owner, back-end architect):** all CI together stays **under 2,000 Worker requests a day**. Budget per full (`ci-full`) run: **about 250 or fewer**, at most about 6 full runs a day.

## Where requests come from

A request is counted when it reaches a Worker: every `/api/...` call of a page, every WebSocket upgrade (`/api/live`), every API test. Static Pages files (`/js`, `/css`, `/img`, `/data/...` on the Pages origin) are not Worker requests. The preview Worker is deleted after the run but its requests still count.

## How CI spends them now

| Part of a full run | Worker requests |
| :--- | :--- |
| `api` job: `api.test.mjs` + `contract.test.mjs`, the real API | about 117 to 124 |
| `browser` job: `deploy-smoke.mjs` (live: health, bootstrap, state, one page per engine) | about 15 (9 measured with Chromium; WebKit adds about 6, not measurable here) |
| `browser` job: every other suite, and the `layout` job (layout sweep) | 0 (answered from `tests/fixtures/api-snapshot`) |
| `preview` job waiting for the preview (`/api/health` poll, usually 1 to 3) | about 3 |
| **Total per full run** | **about 140 to 150** |

At 6 full runs a day that is about 900 a day, under the 2,000 law. Each extra run costs about 150. Nightly production checks: `degraded-modes` (all 144 checks) now answers from the fixtures, 0 Worker requests (it was 181 measured locally); the ZAP baseline crawls Pages HTML only and was not measured (cannot be measured locally).

Not measured, so not in the total: Lighthouse (`lighthouse.yml`, loads preview pages in a real browser) and ZAP against a preview (labels `security` + `ci-full`). Both load pages whose API calls reach the preview Worker. Treat them as the first suspects if the daily count is still high.

## Measured raw material (local `wrangler dev`, seeded D1, 3 November 2026)

Produced by `tools/local-browser.sh` (see `tests/README.md`), which counts the `[wrangler:inf] GET|POST ...` lines of the Worker log around each suite. "Before" is the same suite with the live API (previous behaviour); "after" is the default now. Seconds are wall-clock on a small cloud container, one suite at a time, Chromium only (WebKit is not installed there).

| Suite | Before (live API) | After (default) | Seconds (after) | Exit (after) |
| :--- | ---: | ---: | ---: | :---: |
| api (`api` + `contract`) | 117 | 117 (live, kept) | 11 | 0 |
| deploy-smoke (new, live) | n/a | 9 | 3 | 0 |
| layout-sweep (18 x 3 x 12) | 1,056 | 0 | 145 | 0 |
| is-this-you | 58 | 0 | 34 | 0 |
| nextstep | 57 | 0 | 28 | see note |
| header-fit | 42 | 0 | 30 | 0 |
| six-members | 35 | 0 | 16 | 0 |
| firstrun | 24 | 0 | 7 | 0 |
| nav-collapse | 18 | 0 | 7 | 0 |
| portrait-column | 18 | 0 | 10 | 0 |
| sample-sheet | 15 | 0 | 4 | 0 |
| char-switcher | 13 | 0 | 44 | 0 |
| votes-card | 12 | 0 | 192 | 0 |
| axe | 6 | 0 | 35 | 0 |
| first-load-weight | 6 | 0 | 5 | 0 |
| roster | 4 | 0 | 26 | 0 |
| trust-card | 2 | 0 | 10 | 0 |
| live-smoke | 8 (run incomplete) | 0 | 29 | see note |
| degraded-modes (3 conditions, per PR) | 0 | 0 | 4 | 0 |
| entry-points, landing, rate, visual-baseline | 0 | 0 | 1 to 9 | 0 |
| nightly: degraded-modes, all 144 checks | 181 | 0 | 53 | see note |
| layout-sweep mutation test (4 injected bugs) | n/a | 0 | 19 | 0 |

Before, a full run of the API suite plus all browser suites made about **1,490 Worker requests locally**. This is lower than the 8 to 10 thousand estimated on 2 November: the estimate was not reproduced by this measurement. Likely reasons for the gap (not measured): WebKit passes of `live-smoke`, retries and re-runs of the preview, a slower preview that makes pages poll more, Lighthouse and ZAP, and `ci-full` being re-run on every push.

Notes on exit codes (all are local-environment or known flakes, not request counts):
- `live-smoke` fails locally only on `webkit launches` (WebKit is not installed in this container); its Chromium checks pass. CI installs WebKit.
- `nightly` fails 2 of 144 checks (`API held for 12 s ... repeat visit ... usable screen`), the same timing-sensitive family as before this change (2 of 144 failed with the live API too, `docs/runbooks/ci-minutes.md`).
- `nextstep` passed standalone (32 of 32) and crashed once inside the long run on `window.__next` being undefined; see the pull request for the rerun result.

## Working locally (the rule)

1. Iterate and test locally: `tools/local-browser.sh <suite>` (starts a static server and `wrangler dev --local` with a throwaway D1, counts Worker requests, stops both by PID).
2. Bundle 5 to 10 related tasks per pull request.
3. Add `ci-full` only when the PR is final: one full run is about 150 Worker requests; every push after it re-runs everything.
4. Use the preview only as a smoke test of the integrated result.

## When the quota is hit

Production answers errors until 00:00 UTC. Do not push or relabel PRs until the reset. Check the Cloudflare dashboard (Workers & Pages, Overview) for the per-Worker split and find the Worker that is not `leeroy-brain`.

## Re-recording the fixtures

`tools/local-browser.sh record-fixtures` rewrites `tests/fixtures/api-snapshot/snapshot.json` from the local Worker and seeded D1 (bootstrap, state, votes; the `data`, `library` and `atlas` documents are served from the repo's `data/` folder, byte for byte what the Worker serves). Do it when a response shape changes. A stubbed suite prints a WARN, and the layout sweep fails with `stub-miss`, for any API path the snapshot lacks. `--live-api` on a suite uses the real API instead (spends requests).
