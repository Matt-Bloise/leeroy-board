# Preview tests

Automated checks that run against a pull request's preview environment (Cloudflare Pages + Worker). They make no AI calls at all (free Workers AI has a very low rate limit) and use no AI keys.

- `api/api.test.mjs`: 8 checks with `node:test` and global `fetch` (health, bootstrap, state, CORS, auth refusal, Discord signature refusal, library index, WebSocket).
- `api/contract.test.mjs`: validates live responses of `/api/health`, `/api/bootstrap`, `/api/signups`, `/api/state`, `/api/me`, `/api/data/{name}` and `/api/atlas/{name}` against `docs/openapi.yaml` (read-only, a small JSON Schema validator, YAML parsed with the `yaml` devDependency).
- `browser/live-smoke.mjs`: 74 browser checks in Chromium and WebKit at 390x844 (touch) and 1366x768. Firefox is not used unless asked: `--engine chromium|webkit|firefox` runs one engine alone.
- `browser/votes-card.mjs`: 44 checks (Chromium, 390x844 and 1366x768) on the Votes card with `GET /api/votes` stubbed by route interception: render, inert text, empty and failing states, 60-second polling only while visible.
- `browser/six-members.mjs`: 400+ checks (Chromium) on party.n and the party size. The board is loaded with a six- and a seven-member fixture (`fixtures/six-members`, made-up names), and for each count at 390 and 1366 wide, for a first visit, "Just take a look" and a picked name (three journeys), every scene and the tab bar are searched for the word "five" and for "four" as the count of the others; library prose and game rules that really are about five are the only exceptions (`NOT_PARTY` in the file). Also: layout of the name chips at five widths, flag off and five members keep the old wording word for word, and the words follow a party that changes while the page is open. `--out <dir>` writes a text dump and a screenshot of the Next card, The party scene and the Library page. `tests/unit/party-copy-source.test.mjs` is the source-level twin: it fails when a count word is typed into party copy instead of coming from `K.pn` in `js/board.js`.
- `browser/hardening.mjs`: 54 checks (Chromium, 1366x768) on the front-end hardening: the board key never leaves for a non-allowlisted origin (`?brain=`, `?api=`, `board-api`), unsafe `href`/`src` from data are dropped, Forget clears `board-`/`bd:` keys. Every API origin is answered by route interception (snapshot or the test), so it needs no live Worker and no 127.0.0.1:8787, and gives the same result against a local server and the deployed PR preview. `HARDENING_REHEARSE_FROM=http://127.0.0.1:8080 tools/local-browser.sh hardening --url https://pr-N.leeroy-board.pages.dev/` rehearses the CI mode locally.
- `browser/axe.mjs`: axe-core (`@axe-core/playwright`, WCAG 2 A and AA tags) on the first screen and the sheet (Next steps) in Chromium at 390x844 and 1366x768. Fails on serious or critical violations; minor and moderate ones print as WARN. Exclusions live in `EXCLUDE` at the top of the file, each with a reason.
- `browser/deploy-smoke.mjs`: the live smoke (15 Worker requests): health, bootstrap, state, then one page per engine with the real API. Every other browser suite answers `/api/` from `fixtures/api-snapshot`.
- `browser/smoke-retry.mjs`: the retry decision. A check that fails once and passes on a second visit is a warning, not a failure.
- `browser/layout-sweep.mjs`: layout invariants engine. 26 viewport sizes x 3 visitor states (first visit, looking, member) x 12 scenes; judges DOM rules (close button inside the viewport and uncovered, no overlap in the header, title not cut from 960 wide, 44 px touch height, scrollable sheet body, no sideways scroll, no same-origin 4xx/5xx, no console errors). `--engine chromium|webkit|firefox`, `--out report.json`, `--sizes`, `--states`, `--scenes` for a subset, `--live-api` to use the real API (default: recorded fixtures, zero Worker requests), `--clock 2026-11-04T10:00:00Z` to load every page with its clock set to that instant (also on `live-smoke.mjs`; used to check the launch hero, which shows from 24 h before launch to 24 h after). CI sweeps the first-visit gate (`--states gate`) at three faked clocks (2026-11-03T22:10:00Z, 2026-11-04T10:00:00Z, 2026-11-05T14:00:00Z) in the PR `layout` job and in the daily cross-engine run. Runs in the `layout` CI job (Chromium); `LAYOUT_SWEEP_SKIP=1` skips it inside `run.mjs`.

## Run locally, against a local Worker (the default way to work)

Cloudflare Workers Free allows **100,000 requests a day for the whole account**, all Workers together, and every `ci-full` run of a pull request used to spend thousands of them. Iterate on your own machine and use the preview only as a smoke test of the finished bundle. One command starts everything, runs the suite, counts the Worker requests and stops what it started:

```
cd infrastructure && npm install && cd ..           # once
cd tests && npm ci && npx playwright install chromium && cd ..   # once
tools/local-browser.sh layout-sweep --sizes 1366x768,390x844   # one suite, a subset of the sweep
tools/local-browser.sh header-fit,axe,roster                     # several suites on one local stack
tools/local-browser.sh all                                       # every browser suite
tools/local-browser.sh api                                       # the API suite against the local Worker
tools/local-browser.sh nightly                                   # degraded-modes, every condition
tools/local-browser.sh mutation                                  # the layout sweep must FAIL on injected layout bugs
```

`tools/local-browser.sh` serves the repo root on `127.0.0.1:8080` (`tools/static-server.mjs`, which also applies `_headers`), starts `wrangler dev --local` on `127.0.0.1:8787` with a throwaway D1 in a temp folder (schema, migrations and seed applied), throwaway secrets generated per run, `IS_PR_PREVIEW=true` and `ALLOWED_ORIGINS` from `wrangler.toml` plus the local page. It stops both by PID at the end and refuses to start when a port is busy (`PAGES_PORT` / `API_PORT` change them). The default page URL is `http://127.0.0.1:8080/?preview=1&brain=http://127.0.0.1:8787`: `?preview=1` skips the Discord gate that a local host would otherwise show, and `?brain=<origin>` points the page at any API origin. Every browser suite accepts a `--url` / `PREVIEW_PAGES` value that already has a query string (they build their URLs with `helpers/page-url.mjs`, never by string concatenation).

After each suite it prints the **Worker requests it made, grouped by path** (counted from the `wrangler dev` request lines), and a table when you run several. Those numbers are the measured raw material in `docs/runbooks/cloudflare-requests.md`.

### Which suites need the live API

The browser suites judge layout and client behaviour, not the API. By default every `/api/` call is **answered by Playwright from `tests/fixtures/api-snapshot/snapshot.json`** (plus the repo's `data/` files for `/api/data|library|atlas/*`, which are the same bytes), so a suite sends **zero requests to the Worker**. Add `--live-api` (or `LIVE_API=1`) to a suite to use the real API instead. Scenario routes that a suite registers itself (`route.fulfill`, `route.abort`, and `route.fetch()` on an API URL) win over the stub.

| Suite | API | Why |
| :--- | :--- | :--- |
| `deploy-smoke.mjs` | **live** | the one smoke job that proves a preview is wired: `GET /api/health`, `/api/bootstrap`, `/api/state`, then one page load per engine (Chromium, WebKit); 15 requests (3 + 2 x 6; 9 measured with Chromium alone) |
| `api/api.test.mjs`, `api/contract.test.mjs` | **live** | the API is what is under test (117 to 124 requests) |
| `layout-sweep`, `header-fit`, `nav-collapse`, `portrait-column`, `firstrun`, `sample-sheet`, `trust-card`, `roster`, `axe`, `first-load-weight`, `visual-baseline`, `live-smoke` | fixtures | layout, contrast, weight and rendering of data the page already has |
| `char-switcher`, `is-this-you`, `nextstep`, `six-members`, `votes-card` | fixtures plus their own scenario routes | they already stub the endpoint under test (`/api/me`, `/api/votes`, sign-ups); the rest comes from the snapshot |
| `degraded-modes` | fixtures plus its own failure routes | the API being slow, aborted or 500 is injected by route interception in the browser; the healthy case needs no live server |
| `entry-points`, `landing`, `rate` | none | static pages, no API call |

Re-record the snapshot after the API shape changes: `tools/local-browser.sh record-fixtures` (local Worker and seeded D1 only; the recorder refuses any URL that is not 127.0.0.1 or localhost). A stubbed run prints `N API reads answered from tests/fixtures/api-snapshot ... 0 sent to the Worker` and **fails the suite** on any API path the snapshot lacks (`API_STUB_ALLOW_MISS=1` turns that into a WARN for one run). `tests/unit/api-snapshot-contract.test.mjs` checks the snapshot against `docs/openapi.yaml`, so a drifted fixture fails in the unit job. The visual audit (`tests/visual/audit.mjs`, label `visual`) is stubbed the same way (`tools/local-browser.sh visual`).

## Run against a preview (smoke test, spends Worker requests)


Needs Node 22 or newer.

```
cd tests
npm install
npx playwright install chromium webkit
```

Set three environment variables. Use the preview URLs from the `cloudflare-pr-preview` comment on the pull request.

| Variable | Meaning |
| :--- | :--- |
| `PREVIEW_API` | Worker origin, for example `https://leeroy-brain-pr-13.<account>.workers.dev` |
| `PREVIEW_PAGES` | Pages origin, for example `https://pr-13.leeroy-board.pages.dev` |
| `BOARD_ADMIN_TOKEN` | The admin token of the preview Worker: the per-PR derived value, hex HMAC-SHA256 of `preview:BOARD_ADMIN_TOKEN:leeroy-brain-pr-<PR number>` keyed by the production token (CI computes it in the `api` job). It is never the production token itself. Never commit it or paste it into a file. |

Then:

```
npm run test:api
npm run test:browser -- --url "$PREVIEW_PAGES/"
```

The browser run takes about a minute. Exit code 0 means every check passed.

## Run everything on one machine: `tools/local-check.sh`

No Cloudflare account, no secrets, no AI calls. From the repository root:

```
bash tools/local-check.sh
```

It runs the unit tests, builds a throwaway local D1 (schema, migrations, seed), starts `npx wrangler dev --local --port 8787` with a throwaway `infrastructure/.dev.vars` (random `BOARD_ADMIN_TOKEN`, `KEY_SALT`, `USER_SALT`, `IS_PR_PREVIEW=true`), runs `npm run test:api` against it with `PREVIEW_API=http://127.0.0.1:8787` and `PREVIEW_PAGES=https://leeroy.party`, then stops wrangler by PID and deletes the `.dev.vars`. About a minute on master. `SKIP_API=1 bash tools/local-check.sh` stops after the unit tests. The browser suite is not part of it.

## CI

`.github/workflows/preview-tests.yml` runs on every pull request from a branch of this repository (not forks), drafts included, as jobs `unit`, `stamps`, `api` and `browser` (plus `scope`, `preview`, `report`). Docs-only PRs get no preview and run only `unit` and `stamps`; the comment then says `passed (docs only)`. It waits for the preview comment, waits for the preview to answer, derives the per-PR preview admin token from the `BOARD_ADMIN_TOKEN` repository secret and runs the tests with it, uploads logs, and posts a summary comment marked `<!-- preview-tests -->`.

## Cross-engine QA (scheduled)

`.github/workflows/cross-engine.yml` runs `live-smoke.mjs` and `layout-sweep.mjs` against the live site (default `https://leeroy.party/`) in Chromium, WebKit and Firefox every day at 07:15 UTC, read only, and keeps the JSON reports as artifacts for 30 days. To run it by hand, open Actions > Cross-engine QA > Run workflow and optionally give another `url`; a manual run never touches issues. When a scheduled run fails it opens, or comments on, the one open issue titled "Cross-engine QA failing on production", naming the failing engines and linking the run; the issue is never closed automatically, so close it once a later run is green. On WebKit the sweep corrects for CSS `zoom` with a zoom-aware coordinate helper (`node browser/layout-sweep.mjs --zoom-selftest --engine <engine>` checks it).
