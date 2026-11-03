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

Lighthouse is no longer part of a full run: it runs once a night against production (`lighthouse` job in `nightly-production.yml`). Measured locally (3 November 2026, `@lhci/cli@0.14.0`, 3 runs on `/` and 3 on `/landing/`): 21 Worker requests in the Worker log for the whole run (Lighthouse's own request list counts 15 `/api/` requests: 5 per load of `/`, 0 for `/landing/`; the rest are lhci's health check). Before this change that was spent on every `ci-full` push against the preview Worker; now it is about 21 a night against production. The job summary prints the count every night (`tools/lighthouse-summary.mjs`).

ZAP (nightly against production, and on a PR with labels `security` + `ci-full`) cannot be measured locally (no Docker daemon in the measuring container). The nightly job summary now prints ZAP's own crawl size ("Total of N URLs") and how many alert instances sit on Worker `/api/` paths, so the real number appears after the first night. Until then ZAP against a preview stays the first suspect if the daily count is high.

The visual audit (`visual-audit` job, label `visual`) now answers `/api/` from the fixtures like the browser suites: 172 Worker requests locally with the live API (6 contexts, 3-minute budget) before, 0 now.

## Measured raw material (local `wrangler dev`, seeded D1, 3 November 2026)

Produced by `tools/local-browser.sh` (see `tests/README.md`), which counts the `[wrangler:inf] GET|POST ...` lines of the Worker log around each suite. "Before" is the same suite with the live API (previous behaviour); "after" is the default now. Seconds are wall-clock on a small cloud container, one suite at a time, Chromium only (WebKit is not installed there).

| Suite | Before (live API) | After (default) | Seconds (after) | Exit (after) |
| :--- | ---: | ---: | ---: | :---: |
| api (`api` + `contract`) | 117 | 117 (live, kept) | 11 | 0 |
| deploy-smoke (new, live) | n/a | 9 (Chromium alone; 15 with WebKit in CI: 3 + 2 x 6) | 3 | 0 |
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
| layout-sweep mutation test (4 injected bugs) | n/a | 0 | 19 | 0 (now also a gating step in the `layout` job) |
| visual audit (`visual`, 3-minute budget) | 172 | 0 | 180 | 0 |

Before, a full run of the API suite plus all browser suites made about **1,490 Worker requests locally**. This is lower than the 8 to 10 thousand estimated on 2 November: the estimate was not reproduced by this measurement. Likely reasons for the gap (not measured): WebKit passes of `live-smoke`, retries and re-runs of the preview, a slower preview that makes pages poll more, Lighthouse and ZAP, and `ci-full` being re-run on every push.

Notes on exit codes (all are local-environment or known flakes, not request counts):
- `live-smoke` fails locally only on `webkit launches` (WebKit is not installed in this container); its Chromium checks pass. CI installs WebKit.
- `nightly` fails 2 of 144 checks (`API held for 12 s ... repeat visit ... usable screen`), the same timing-sensitive family as before this change (2 of 144 failed with the live API too, `docs/runbooks/ci-minutes.md`).
- `nextstep` passed standalone (32 of 32) and crashed once inside the long run on `window.__next` being undefined; see the pull request for the rerun result.

## Request gauge (flag `REQUEST_GAUGE`, default off)

Free plan has no usage alert, so the Worker can count itself. **Cloudflare's dashboard "Requests today" (Workers & Pages, Overview) is the source of truth. The gauge is an approximation and under-counts.**

- Turn on: set `REQUEST_GAUGE = "on"` in `infrastructure/wrangler.toml` (migration 0007 creates the table `request_gauge`; `schema.sql` has it too). Off by default; while off a request does one string comparison and no D1 access, and `GET /api/admin/requests` is a 404 for the admin token (401 for everyone else, flag on or off).
- Read it (admin token): `GET /api/admin/requests` returns `{"utcDay":"2026-11-03","count":4210,"limit":100000,"pct":4.21}`.
- How it counts: every Worker `fetch` (including OPTIONS, refused origins and 401s) adds 1 to a counter in memory. About every 25 requests, or after 60 seconds, one upsert adds the delta to the row of the UTC day, inside the same request through `ctx.waitUntil`: no extra Worker request, about 1 D1 row written per 25 requests (4 %; D1 Free allows 100,000 row writes a day). The instance that answers the gauge adds its own unflushed count, so it is exact about itself.
- Stored: `day` and `n`. No IP address, user id, path, header or key is read into it (unit test `tests/unit/request-gauge.test.mjs` sends requests with an address, a key and a user agent and searches the table).
- **What it misses (all under-count):** (1) the unflushed delta of an instance that is evicted: at most 24 requests per eviction; (2) cron triggers (1,444 a day with the two crons; whether Cloudflare counts them toward the 100,000 is unverified); (3) every other Worker on the account: the per-PR preview Workers have their own database and are not in this number, and on 2 November they were most of the overage; (4) a flush that fails and is not retried before the instance dies.
- So: if the gauge says 15 % and the dashboard says 100 %, believe the dashboard and look for the other Worker (see "When the quota is hit"). The gauge is useful for the production Worker's own trend, not as a guard for the account.

Measured locally (`node tests/local/gauge-measure.mjs`, `wrangler dev --local`, 3 November 2026):

| Case | Sent | Gauge counted | Error |
| :--- | ---: | ---: | ---: |
| One instance that lives the whole run (1,000 probes + 1 gauge read) | 1,001 | 1,001 (the wrangler log also shows 1,001) | 0 (0.00 %) |
| 37 probes, then `SIGKILL` of the Worker (an eviction with no chance to flush), restart on the same database, 1 gauge read | 38 | 23 | -15 requests (15 of the 38 in that burst; the cap is 24) |

The first row is the best case. The second is the worst case a single eviction can produce (up to 24 lost). How often production Workers are evicted is not measurable locally, so the production error is **unknown**; compare the gauge with the dashboard once on the first day it is on and write the difference here.

## Working locally (the rule)

1. Iterate and test locally: `tools/local-browser.sh <suite>` (starts a static server and `wrangler dev --local` with a throwaway D1, counts Worker requests, stops both by PID).
2. Bundle 5 to 10 related tasks per pull request.
3. Add `ci-full` only when the PR is final: one full run is about 150 Worker requests; every push after it re-runs everything.
4. Use the preview only as a smoke test of the integrated result.

## When the quota is hit

Production answers errors until 00:00 UTC. Do not push or relabel PRs until the reset. Check the Cloudflare dashboard (Workers & Pages, Overview) for the per-Worker split and find the Worker that is not `leeroy-brain`.

## Re-recording the fixtures

`tools/local-browser.sh record-fixtures` rewrites `tests/fixtures/api-snapshot/snapshot.json` from the local Worker and seeded D1 (bootstrap, state, votes; the `data`, `library` and `atlas` documents are served from the repo's `data/` folder, byte for byte what the Worker serves). Do it when a response shape changes. A stubbed suite FAILS (exit 1, `FAIL not in the snapshot`) for any API path the snapshot lacks; `API_STUB_ALLOW_MISS=1` makes it a WARN for one run. `tests/unit/api-snapshot-contract.test.mjs` ties the snapshot to `docs/openapi.yaml`. `--live-api` on a suite uses the real API instead (spends requests).
