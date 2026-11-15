# Worker cost model on the Cloudflare free plan

Audit of 2026-11-15. Code read: `master` at 714cbf0 (after PR 344). Open PR 333 (`git fetch origin pull/333/head`, head 1372901) is priced separately in section 6.
Reproduce every number here with `node tools/cost-model.mjs` (zero dependencies, no network, reads the checkout only). The gating test `tests/unit/cost-model.test.mjs` runs it against a fixture whose totals were worked out by hand and against pinned copies of `schema.sql` and `wrangler.toml` (`tests/fixtures/cost-model-pinned`). Whether the live code still contains each anchor is a separate non-gating check, `npm --prefix tests run cost-model:check`, to be run when the model is refreshed (it fails when a statement the model is built from has left the code).

## 1. Answer first

| Question | Answer |
| --- | --- |
| What is the first limit hit by a normal day? | None. Five members cost about 2,600 Worker requests a day (2.6% of 100,000); nothing else passes 1%. |
| Which limit is hit first, and by what? | **Worker requests (100,000/day)**, by open tabs. A tab whose WebSocket has failed polls 7,920 times a day, so **12 such tabs left open for 24 h use the whole quota** (299 tab-hours; 10 tabs: 80.8%). A tab with the socket up and the Tonight or Decide panel showing makes 1,440 requests a day (`/api/votes` every 60 s), so it takes 69 of them. |
| Next? | **Workers AI neurons**, by asks on Workers AI: one answer reserves about 105 neurons, so the 8,000 soft cap lasts **76 asks** and the 10,000 hard limit 95. Visitors always use Workers AI and need no account, so about 76 visitor asks from different addresses (2 an hour each) spend the day's allowance for every member who is on Workers AI. Members on Claude spend no neurons. |
| Then? | **D1 rows written (100,000/day)**, by Discord. Every signed interaction writes its replay row: 8 rows over its life (4 on insert, 4 when the ledger is purged). 12,488 static commands a day, or about 10,500 interactions of the mixed storm in section 5, reach the cap. |
| D1 rows read (5M/day)? | Not reached by anything on master. The Ten-tabs polling day reads 324,000 rows (6.5%). **PR 333 can reach it** (section 6): with one member who has no stored sheet, every uncached read scans the `sheet_events` log, and 2.8 polling tabs are enough at 300 log rows. |
| Durable Object (100,000 requests/day) | Never first. 10 polling tabs make 7,272 requests (WebSocket retries every 120 s plus broadcasts). |
| CPU 10 ms per request | Not a daily total but a per-request edge. The ask is the heaviest invocation, because the answer runs in `waitUntil` inside the request that started it: **about 8.1 ms for a web ask and 9.9 ms for a Discord /ask** (the answer is 6.9 ms of it: 5 ms a guess for ranking and clean-up, 1.9 ms measured JSON parse of 625 KB of library pages). That leaves 1.2x and 1.01x of headroom, so a slower isolate than this container fails them. Every other request is under 3.2 ms. |

The model's calibration: ten tabs open all day with the socket up come to **15,894** Worker requests a day (scenario "Ten tabs, socket up, 24 h"), against the **about 15,600** the runbook measured on 2 November (`docs/runbooks/cloudflare-requests.md`). That agreement is the only external check the model has; it is evidence of the right order, not proof, because the production figure also holds visitors, bots and probes the model does not list.

## 2. How the model works

* `tools/cost-model.mjs` holds a hand-read table (`MODEL`): for every route, every Discord interaction type and every cron path, the D1 statements it issues, the table and rows each reads, the Durable Object requests, the outside calls, the neurons and the CPU.
* Each statement carries an **anchor**, a fragment of its SQL that must still be in the named source file. 191 anchors are checked on master (243 on the PR 333 tree). A run fails when one is gone.
* **Rows written are not typed in.** They come from `infrastructure/schema.sql`: one row for the table, one per index, and one for the automatic index of a TEXT or composite primary key (an INTEGER primary key adds none). `kv_state` (TEXT key) costs 2 rows to insert and 1 to update; `ask_turns` costs 5; `sheet_events` 3; `intents` 3; `discord_events` 4.
* **Rows read are the author's estimate** of what D1 scans given the index the WHERE can use (primary key or unique lookup: 1 row; `COUNT(*)`: every row; a leading-`%` LIKE: the whole table).
* Caches: a cached GET pays its D1 cost once per `ttl` per data centre (the model assumes 2) plus once per purge (every write purges), and the rest are hits that cost only the request. Browser `max-age` lowers the request count of pollers whose interval is shorter than it.
* Limits come from the repo's own text (anchored): `wrangler.toml` for D1, neurons and Durable Objects, `docs/runbooks/cloudflare-requests.md` for requests, `docs/roadmap/research/notes-R2-discord-platform.md` for the 50-subrequest and 10 ms limits.
* Parameters (rows of the `members` table, `sheet_events`, votes, lib pages, cap, and so on) are in `MODEL.params`; a scenario can override them.

Commands:

```bash
node tools/cost-model.mjs                 # the tables below
node tools/cost-model.mjs --json          # the same totals as JSON
node tools/cost-model.mjs --check         # only verify the anchors
node tools/cost-model.mjs --diff          # master against PR 333
node tools/cost-model.mjs --root <worktree of pull/333/head>   # price the real PR tree
node tools/cost-model.mjs --bench         # time JSON.parse and stringify of the seeded documents (node, not workerd)
node --test tests/unit/cost-model.test.mjs
npm --prefix tests run cost-model:check     # non-gating: are all anchors still in the live code
```

## 3. What one open tab does

From `js/brain.js` (`POLL_MS` 15 s, `PING_MS` 45 s, `WS_RETRY_MS` 120 s), `js/votes.js` and `js/board.js`. One socket per tab.

| Tab state | Worker requests | Per day, visible 24 h |
| --- | --- | --- |
| Page load | `/bootstrap`, `/state`, `/library/index.json`, `/votes` (Tonight is the default panel), the socket upgrade. Signed in: `/me`, `/sheet`, `/ask`. | 5 (8 signed in) |
| Socket up, Tonight or Decide showing | `/votes` every 60 s; pings are answered by the Durable Object itself and not billed | **1,440** |
| Socket up, another panel | nothing | 0 |
| Socket failed (polling fallback) | `/state` every 15 s, `/votes` every 60 s, a socket retry every 120 s | **7,920** (5,760 + 1,440 + 720) |
| Library opened | 13 files (index, 11 categories, search); cached 120 s and 4 h at the edge | 13 once |
| An /ask pending | `/ask?id=` 3 s after the post, then every 4 s (first 2 min), 10 s, 20 s, or 15 s on a socket, for at most 10 min | about 40 (socket) to 63 |

Two things make the tab the largest lever. `/votes` is polled every 60 s but cached 10 s, so **every poll is a miss**: V+2 D1 queries each (5 with 3 votes, 52 with 50), 19 rows read, 14,400 misses a day for ten tabs. And the socket retry has no backoff, no jitter and no hidden-tab check.

## 4. Per route and per path

Appendix A has the full table (every route, every Discord interaction type, every cron path); these are the ones that matter, one request each:

| Path | D1 queries | Rows read | Rows written | Other | Source of the cost |
| --- | ---: | ---: | ---: | --- | --- |
| `GET /api/bootstrap` miss | 2 | 9 | 0 | cached 60 s | `kv_state` IN (8 keys) + `party_sheets` |
| `GET /api/state` miss | 2 | 8 | 0 | cached 30 s | IN (7 keys) + `party_sheets` |
| `GET /api/votes` miss | 5 (V+2) | 19 | 0 | cached 10 s, polled 60 s | one read per vote document, then one for ballots |
| `GET /api/sheet` | 2 | 2 | 0 | not cached | `party_sheets`, `party` |
| `POST /api/sheet` (write) | 7 | 14 | 8 | 1 DO, 4 cache purges | members re-read (non-GET), CAS read, 3-statement batch, intent row |
| `POST /api/signups` | 4 | 6 | 4 | 1 DO | |
| Web /ask, member on Claude (whole flow) | 21 | 152 | 17 | 3 DO, 1 outside call, 3 requests | 15 D1 statements in the answer alone |
| Web /ask, visitor (Workers AI) | 28 | 101 | 23 | 105 neurons, 2 DO | rate-limit rows (guest_rate_limits: insert + index), private answer |
| Discord, static command | 1.1 | 3 | 8 | none | replay row (4) + its purge (4) |
| Discord, `/tooltip` autocomplete | 2.1 | 74 | 8 | none | `LIKE '%q%'` over `lib_pages`: a full scan on every keystroke |
| Discord, vote button | 6.1 | 15 | 10 | 1 outside call | `loadVote` runs twice; no member check, no per-voter cap |
| Discord, `/ask` (inline part) | 8.1 | 6 | 22 | 2 outside calls | plus the answer |
| Discord, Fix this fact | 3.1 | 3 | 15 | none | any user; `fact_fixes` insert (5 rows) + intent |
| `GET /api/intents` (PC bot poll) | 2 | 100 (up to limit + pending) | 0 | | `COUNT(*)` scans every pending row |
| 6-hour sweep, nothing changed | 17 | 13 | 25 | 12 outside calls, 1 DO, about 30 subrequests (more with cache purges) | one `UPDATE lib_sources` per source (2 rows: table + `checked_at` index) |
| Every minute | 0 | 0 | 0 | | `runMoments` returns before reading D1 while `MOMENTS_*` are off (verified: `moments.js` line 430) |

Notes on paths the table cannot show.

* **The ask answer repays its cost on every ask.** After each answer `purgeWorkerCache` calls `invalidatePagesCache()` (`index.js`), so the 15-minute library cache in `ai-models.js` is dropped and the next ask re-reads `lib_pages` (71 rows, 625 KB of JSON in three columns) and parses it. A member's reuse check (`findRecentSameAnswer`) joins `ask_turn_askers` twice and reads 1 + 2N rows for N lifetime asks, unbounded; the model uses N = 30.
* **A refused ask still pays for the read.** The retrieval and ranking run before the budget check (`buildAnswerInputs` before `checkAskBudget`): a budget-refused ask costs 10 queries and 142 rows read.
* **`recordAttributed` costs 4 statements per answer** (two reads, two `INSERT OR REPLACE`), even for guests and even on Claude.
* **Subrequests.** If D1 queries and Durable Object fetches count against the 50 per invocation (the repo says so in `kv-cas.js`; not verified against Cloudflare), a member's ask is about 23, a guest's about 27, a Discord /ask about 28 to 31, a 6-hour sweep with nothing changed about 30, and `GET /api/votes` with 50 votes would issue 52 queries. Each source that changes in a sweep adds an AI call, a 71-row `lib_pages` scan, a snapshot write and up to 10 proposal statements, so about three changed sources in one sweep pass 50 and the rest fail silently (`scraper.js` catches per source).
* **Snapshots are never pruned** (`lib_source_snapshots`, up to 24,000 characters a changed source); `wiki_proposals` duplicate checks scan the table (only a `created_at` index exists), so each sweep gets slower as proposals accumulate.
* **The mailbox grows without bound unless the PC bot acknowledges.** Every ask, sign-up, sheet write and fix adds an `intents` row; only `POST /api/ack` (or an erase) deletes. The bot lives in another repository: its poll rate is unknown, so the model prices one poll (100 rows read at a pending count of 50, more as the table grows).
* **Cache busting does not work, public 404s do cost.** The cache key ignores the query string, so `?cb=` does not bypass `/api/bootstrap`; but `GET /api/library/<random>` is a D1 query per guess because a 404 is not cached.
* **Durable Object.** One global instance, hibernatable, no storage, no alarms. A request is billed for each socket upgrade and each broadcast (2 to 3 per ask, 1 per write). Ping text frames are auto-answered and cost nothing. Messages sent to sockets are not requests. The 13,000 GB-s duration limit and the 20:1 incoming-message billing are not in the repo and are not modelled.
* **Cron.** With `MOMENTS_*`, `CARDS_*`, `INTEREST_NUDGES` all off (their defaults) the 1,440 minute ticks read 0 rows. With moments on and idle they read 1,440 to 2,880 rows (0.06%); a live countdown adds about 300 reads and 120 writes an hour. Whether the 1,444 cron invocations count toward the 100,000 requests is unverified (`docs/runbooks/cloudflare-requests.md` says so); the model counts them, the conservative choice. The 6-hour sweep uses 0 neurons while `AI_PROVIDER` is `claude`; on Workers AI it would use about 155 a changed source, and the 6,500 cron cap would apply.

## 5. Realistic and worst-case days

Five members, 10 polling tabs, an /ask burst and a Discord interaction storm, each on top of the standing cron load. The tables in Appendix A hold every limit for every scenario; this is the reading.

| Scenario | Worker requests | D1 rows read | D1 rows written | Neurons | First limit and the load that reaches it |
| --- | ---: | ---: | ---: | ---: | --- |
| **Realistic day** (5 tabs of 3 h with the socket up and Tonight showing, 10 page loads, 8 sheet edits, 5 sign-ups, 15 asks on Claude, 2 visitor asks, 40 Discord interactions) | 2,569 (2.6%) | 22,392 (0.45%) | 903 (0.9%) | 210 (2.1%) | Worker requests, by tabs: 1,639 tab-hours of Tonight polling |
| **Ten polling tabs** (10 tabs x 24 h with the socket failed, plus the realistic writes) | 80,839 (**80.8%**) | 323,767 (6.5%) | 583 | 0 | Worker requests: **299 tab-hours** (12 tabs) |
| **Ten tabs, socket up, 24 h** (the calibration day) | 15,894 (15.9%) | 274,982 (5.5%) | 100 | 0 | Worker requests: 68 such tabs |
| **Ask burst** (every member spends the 40-ask cap on Workers AI, 100 visitors ask once, 100 more are refused with 429) | 3,394 (3.4%) | 59,582 (1.2%) | 6,200 (6.2%) | 31,500 demanded (**315%**) | Neurons: **63 member asks + 32 visitor asks** reach 10,000; the soft cap 8,000 stops asks after about 76 and refuses the rest with a message |
| **Discord storm** (5,000 signed interactions: 2,000 autocomplete keystrokes, 1,000 vote presses, 1,000 static, 600 /sheet views, 200 /sheet writes, 200 /ask) | 7,394 (7.4%) | 220,082 (4.4%) | 47,700 (**47.7%**) | 0 | D1 rows written: the storm scaled to about **10,500 interactions** (the replay ledger writes 8 rows each) |
| **Everything at once** (10 polling tabs + ask burst + Discord storm + 10,000 hostile GETs + a refresh every 15 min + 48 changed sources) | 96,790 (**96.8%**) | 619,796 (12.4%) | 54,760 (54.8%) | 31,500 demanded | Neurons first (the cap makes asks fail closed); requests are 3,200 away from the limit |

What the scenarios say.

* **Requests are the limit the group controls least.** A tab's cost is set by its state, not its owner: the same page costs 0, 1,440 or 7,920 requests a day. The runbook's 100,424 on 2 November (CI included) shows how little room there is.
* **An ask burst is a neuron problem, not a D1 problem.** A member on Claude spends no neurons (the global cap is skipped for non-Workers-AI providers), but the 40-a-day member cap is the only bound there, so 200 Claude asks cost about 30,000 rows read and 3,400 rows written and go to the provider's own limits. Visitors cannot choose: they always use Workers AI, are limited to 2 an hour per address, and are not limited in number of addresses. 32 of them take as many neurons as 63 members.
* **The Discord interaction storm is a write problem.** Reads stay at 4% because the heavy statements are PK lookups, but every signed interaction writes its replay row and later its purge. Refusals after verification still keep the row. Two Discord paths have no per-user bound at all: the vote button (re-casts forever, no member check) and **Fix this fact** (any user, 15 rows a click). A request that fails the signature check costs 0 D1 and about 1 ms.
* **Hostile reads cost requests, not rows.** `GET /api/bootstrap` flooded 10,000 times is 10,000 requests and a few hundred rows read (the edge cache absorbs all but one miss a minute per data centre); `GET /api/library/<random>` is 1 D1 query and 0 rows each, uncached. The quota falls to anyone who can send 100,000 requests a day (about 1.2 a second); no rate limit or firewall rule exists in the repo (a dashboard rule would not show up here).

## 6. Open PR 333: what reading the member documents from D1 costs

Priced from the code of the PR (`git fetch origin pull/333/head`, head 1372901, 83 files; `node tools/cost-model.mjs --root <worktree>` reads the PR tree itself and finds all 243 anchors, and its totals equal `--assume-pr333` on master).

**What changes**

1. The Worker treats `party`, `decide`, `tonight`, `guided-atlas`, `client` and `launch` (`MEMBER_DOCS` in `public-party.js`: six, where the front end's `MEMBER_NAMES` lists five), `/state` and `/bootstrap` as member documents. They are never read from or written to the isolate cache or `caches.default` (`memberPath` in `index.js`) and are sent `Cache-Control: no-store`, so the browser's `max-age` is gone too. The reason is in the PR: a purge clears only the data centre that handled the write, so a hidden value could be served for up to the TTL elsewhere.
2. Every read is a fresh projection: the document row, then `loadPublicInputs` reads the party row and the sheets (`party_sheets`), and when a party member has no stored sheet it also reads the `sheet_events` log (`SELECT MAX(id), COUNT(*)` every time, the log itself only when that changed).
3. The page reads those five documents from the Worker only, on `leeroy.party`, previews, the Activity and `?brain=` (`js/board.js`: `MEMBER_NAMES`, `memberUrl`). `client` is always fetched on its own, so **a page load gains one Worker request (`GET /api/data/client`, 221 KB) that was a free static file before**; the decide and guided-atlas scenes read theirs from the Worker too. The other documents already arrive inside `/bootstrap`.

**Cost of one read** (`node tools/cost-model.mjs --diff`; CPU is the model's estimate: parse and stringify bytes measured, the projection part a guess)

| Route | Cache before | Cache after | D1 queries before / after | Rows read before / after | CPU est. ms before / after |
| --- | --- | --- | ---: | ---: | ---: |
| GET /api/bootstrap | 60 s edge, 15 s browser | none (no-store) | 2 / 2 | 9 / 9 | 1.75 / 2.75 |
| GET /api/state | 30 s edge, 10 s browser | none (no-store) | 2 / 2 | 8 / 8 | 1.47 / 2.27 |
| GET /api/data/party | 60 s edge, 15 s browser | none (no-store) | 1 / 2 | 1 / 2 | 0.35 / 0.85 |
| GET /api/data/decide | 60 s edge, 15 s browser | none (no-store) | 1 / 3 | 1 / 3 | 1 / 2.23 |
| GET /api/data/client | 60 s edge, 15 s browser | none (no-store) | 1 / 3 | 1 / 3 | 1.34 / 2.87 |
| GET /api/data/guided-atlas | 60 s edge, 15 s browser | none (no-store) | 1 / 3 | 1 / 3 | 0.32 / 0.85 |
| POST /api/intent launch | none | none | 9 / 11 | 15 / 17 | 1.64 / 2.64 |
| PUT /api/data/<doc> (admin) | none | none | 1 / 3 | 0 / 2 | 1.73 / 2.98 |

The per-read cost (2 to 3 queries, 2 to 9 rows) is small. The change is how often it is paid: **before, `/api/state` cost D1 at most once per 30 s per data centre; now every request pays**, and every page load pays for `/bootstrap`, `/state` and `client`.

**A day each** (same scenarios as section 5)

| Scenario | Requests | D1 queries | Rows read | First limit (master → PR 333) |
| --- | ---: | ---: | ---: | --- |
| Realistic day | 2,569 → 2,589 | 5,534 → 5,594 | 22,392 → 22,433 | Worker requests 2.6% → 2.6% |
| Ten polling tabs | 80,839 → 80,859 | 84,412 → **188,116** | 323,767 → **738,388** | Worker requests 80.8% → 80.9% (D1 reads 14.8%) |
| Ten tabs, socket up, 24 h | 15,894 → 15,914 | 72,360 → 72,420 | 274,982 → 275,042 | Worker requests 15.9% → 15.9% |
| Ten polling tabs, **one member with no stored sheet** | 80,694 → 80,714 | 83,860 → 245,260 | 320,982 → **18,027,842** | Worker requests 80.7% → **D1 rows read 361%** |

So on its own the PR adds 20 requests a day and about 2.2 times the D1 queries of the polling case, which is nowhere near a limit. The risk is the **`sheet_events` key read**: `SELECT MAX(id), COUNT(*) FROM sheet_events` runs on every uncached read whenever a party-document member has no stored sheet (a newly added person, until their first write) and `COUNT(*)` reads every row of the table (the model assumes D1 bills that as one row read per log row; unverified). The memo in the PR avoids re-reading the log, but not this key.

| `sheet_events` rows | Rows read a day, 10 polling tabs | Share of 5M |
| ---: | ---: | ---: |
| 50 | 3.6M | 72% |
| 80 | 5.3M | 107% |
| 300 | 18.0M | 361% |
| 1,000 | 58.4M | 1,168% |

At 300 rows the limit is reached by **2.8 polling tabs** (67 tab-hours) instead of 12 on the request limit; one polling tab alone reaches it at about 850 rows. The real row count is not in the repository (every show, hide and edit adds one). With no sheetless member the case does not arise. A hide on a *stored* sheet costs nothing extra.

Smaller effects: the ask path reads one row fewer (the party row moves to the sheets read, `ai-models.js`); a sheet write and the `launch` write pay 1 to 4 more statements when a member is sheetless; every broadcast of a member document (`launch`, admin `PUT`) now reads party and sheets to project it before sending; CPU rises about 0.8 to 1.5 ms on the member-document reads (projection walks the whole document: 151 KB `decide`, 221 KB `client`), still under 3 ms.

Also noted while pricing: the **front end waits on D1 for the member documents** and has no static fallback on those hosts, so a D1 failure shows the "could not load" line where the party was (the PR's intent, a privacy rule). Under the free plan that also means a request-limit day removes the party view, which the static files kept up.

## 7. What could not be verified

* **Cloudflare's billing rules.** Whether D1 bills a `COUNT(*)` as one row read per row, an automatic TEXT-key index as a written row, or an `INSERT OR REPLACE` as one or two rows; whether a D1 query counts toward the 50 subrequests of a free invocation (the repo asserts it); whether Cache API calls and Flagship binding calls count; whether cron invocations count as Worker requests; Durable Object duration (13,000 GB-s) and 20:1 message billing (neither is in the repo). The limits themselves are quoted from the repo's own comments, not from Cloudflare's current pages (no network).
* **Production data sizes.** `sheet_events`, `intents`, `wiki_proposals`, `ask_turns`, `lib_sources` and the votes index are production tables the code cannot size. The model uses 300, 50, 100, 30 asks per member, 12 sources and 3 votes (parameters in `MODEL.params`).
* **CPU.** Parse and stringify rates were timed in node 22 on the build container (`--bench`); the ranking, clean-up and projection parts are guesses. A Cloudflare isolate may be slower or faster. The result for the ask path (8 to 10 ms against 10) is the number to measure first: a `wrangler tail` or the Workers dashboard CPU time on production would settle it.
* **Who calls what.** The PC bot's poll rate of `GET /api/intents` (another repository), the real mix of Discord commands, the number of data centres that cache the site (2 assumed), the number of open tabs and what state their sockets are in. Whether `ANTHROPIC` keys are configured (it decides whether members spend neurons) is a secret, not in the repo.
* **Dashboard-side protection.** Any Cloudflare rate-limit or WAF rule on `api.leeroy.party` is invisible to the code.
* **PR 333 itself** was priced from its diff and by running the model on its tree; it was not deployed or measured.
* **Workers Logs.** `head_sampling_rate = 1` logs every request; the 200,000-events-a-day free allowance is not modelled (no log line counts in the code).

## 8. The cheapest levers (suggestions, nothing here is changed)

1. **Poll `/api/votes` no faster than its cache.** It is polled every 60 s and cached 10 s, so every poll misses and runs V+2 queries. Cache it for 60 s or push it over the socket; also cap the index below 50 so one read cannot pass 50 queries.
2. **Back off the socket retry** (flat 120 s, no jitter, runs while hidden) and stop the 15 s `/state` loop when the socket is merely flapping. This is the 7,920-a-day tab.
3. **Do not drop the library cache on every answer** (`purgeWorkerCache` → `invalidatePagesCache`): each ask re-reads and parses 71 pages (625 KB). Invalidate on library writes only.
4. **Give visitors their own neuron cap.** Today they share the 8,000 soft cap with members on Workers AI and are unbounded in number of addresses.
5. **For PR 333:** read the `sheet_events` key from a counter row or `MAX(id)` alone, not `COUNT(*)`, and, if the cost matters more than an instant hide, a short edge TTL on `/state` and `/bootstrap`; that gives up the immediate-hide guarantee the PR is built on, so it is the owner's call.
6. **Add per-user bounds to the Discord vote button and Fix this fact**, and a prefix index or fixed list for the `/tooltip` autocomplete (a full scan per keystroke).

## Appendix A. Full script output (master, `node tools/cost-model.mjs`)

Tree: `.` · mode: master as read · anchors checked: 191, missing: 0

wrangler.toml crons: `0 */6 * * *`, `* * * * *`. Every flag the model prices as off is off in wrangler.toml.

##### Limits used

| Limit | Value | Source in the repo |
| --- | ---: | --- |
| Worker requests (100,000/day) | 100,000 | `docs/runbooks/cloudflare-requests.md`: "100,000 requests per UTC day" |
| D1 rows read (5M/day) | 5,000,000 | `infrastructure/wrangler.toml`: "5M reads/day, 100k writes/day" |
| D1 rows written (100k/day) | 100,000 | `infrastructure/wrangler.toml`: "5M reads/day, 100k writes/day" |
| Workers AI neurons (10,000/day; soft cap 8,000) | 10,000 | `infrastructure/wrangler.toml`: "10,000 Neurons/day" |
| Durable Object requests (100k/day) | 100,000 | `infrastructure/wrangler.toml`: "100k req/day" |
| CPU per request (10 ms) | 10 | `infrastructure/worker/ai-models.js`: "Free plan: 10 ms CPU" |
| Subrequests per invocation (50) | 50 | `docs/roadmap/research/notes-R2-discord-platform.md`: "50 subrequests per invocation" |

#### Cost of one request, per route (a cache miss, or an uncached route)

| Route | D1 queries | Rows read | Rows written | DO requests | Outside calls | Neurons | CPU est. (ms) | Slowdown that reaches 10 ms | Subrequests | Edge cache (browser) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| GET /api/bootstrap | 2 | 9 | 0 | 0 | 0 | 0 | 1.75 | 5.71x | 2 | 60 s (15 s) |
| GET /api/state | 2 | 8 | 0 | 0 | 0 | 0 | 1.47 | 6.78x | 2 | 30 s (10 s) |
| GET /api/data/party | 1 | 1 | 0 | 0 | 0 | 0 | 0.35 | 28.9x | 1 | 60 s (15 s) |
| GET /api/data/decide | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 10x | 1 | 60 s (15 s) |
| GET /api/data/client | 1 | 1 | 0 | 0 | 0 | 0 | 1.34 | 7.46x | 1 | 60 s (15 s) |
| GET /api/data/guided-atlas | 1 | 1 | 0 | 0 | 0 | 0 | 0.32 | 31.4x | 1 | 60 s (15 s) |
| GET /api/signups | 1 | 1 | 0 | 0 | 0 | 0 | 0.31 | 32.3x | 1 | 15 s (15 s) |
| GET /api/votes | 5 | 19 | 0 | 0 | 0 | 0 | 0.4 | 25x | 5 | 10 s (10 s) |
| GET /api/library/index.json | 1 | 1 | 0 | 0 | 0 | 0 | 0.3 | 33.3x | 1 | 120 s (30 s) |
| GET /api/library/<other blob> | 1 | 1 | 0 | 0 | 0 | 0 | 0.3 | 33.3x | 1 | 14400 s (3600 s) |
| GET /api/me | 0 | 0 | 0 | 0 | 0 | 0 | 0.4 | 25x | 0 | none |
| GET /api/sheet | 2 | 2 | 0 | 0 | 0 | 0 | 0.59 | 16.9x | 2 | none |
| GET /api/ask?id= (member poll) | 1 | 1 | 0 | 0 | 0 | 0 | 0.4 | 25x | 1 | none |
| GET /api/ask?id= (guest poll) | 2 | 3 | 0 | 0 | 0 | 0 | 0.6 | 16.7x | 2 | none |
| GET /api/live (WebSocket upgrade) | 0 | 0 | 0 | 1 | 0 | 0 | 0.5 | 20x | 1 | none |
| GET /api/health | 1 | 0 | 0 | 0 | 0 | 0 | 0.2 | 50x | 1 | none |
| POST /api/sheet (write) | 7 | 14 | 8 | 1 | 0 | 0 | 1.34 | 7.47x | 8 | none |
| POST /api/signups (write) | 4 | 6 | 4 | 1 | 0 | 0 | 0.82 | 12.2x | 5 | none |
| POST /api/intent launch | 9 | 15 | 10 | 2 | 0 | 0 | 1.64 | 6.11x | 11 | none |
| POST /api/intent journey | 4 | 6 | 4 | 0 | 0 | 0 | 0.62 | 16.2x | 4 | none |
| POST /api/intent ask (member) | 4 | 5 | 11 | 1 | 0 | 0 | 1.2 | 8.33x | 5 | none |
| POST /api/intent ask (guest) | 7 | 7 | 15 | 1 | 0 | 0 | 1.4 | 7.14x | 8 | none |
| POST /api/intent ask (guest, refused 429) | 1 | 2 | 0 | 0 | 0 | 0 | 0.8 | 12.5x | 1 | none |
| answer: member on Claude (shared) *(inside another request)* | 15 | 145 | 6 | 2 | 1 | 0 | 6.88 | 1.45x | 18 | none |
| answer: member on Workers AI (shared) *(inside another request)* | 18 | 147 | 8 | 2 | 0 | 105 | 6.88 | 1.45x | 21 | none |
| answer: guest on Workers AI (private) *(inside another request)* | 17 | 88 | 8 | 1 | 0 | 105 | 6.88 | 1.45x | 19 | none |
| answer: abstain from the library (no model) *(inside another request)* | 9 | 141 | 2 | 2 | 0 | 0 | 4.88 | 2.05x | 11 | none |
| answer: refused by the budget *(inside another request)* | 10 | 143 | 1 | 1 | 0 | 0 | 4.88 | 2.05x | 11 | none |
| POST /api/intent refresh (accepted) | 3 | 6 | 4 | 1 | 0 | 0 | 0.8 | 12.5x | 4 | none |
| POST /api/intent refresh (cooldown 429) | 3 | 7 | 0 | 0 | 0 | 0 | 0.6 | 16.7x | 3 | none |
| PUT /api/data/<doc> (admin) | 1 | 0 | 2 | 1 | 0 | 0 | 1.73 | 5.78x | 2 | none |
| GET /api/intents (the PC bot's poll, admin) | 2 | 100 | 0 | 0 | 0 | 0 | 0.53 | 18.9x | 2 | none |
| POST /api/discord (bad signature or stale) | 0 | 0 | 0 | 0 | 0 | 0 | 0.8 | 12.5x | 0 | none |
| POST /api/discord PING | 0 | 0 | 0 | 0 | 0 | 0 | 1.2 | 8.33x | 0 | none |
| POST /api/discord static command | 1.1 | 3 | 8 | 0 | 0 | 0 | 1.6 | 6.25x | 1.1 | none |
| POST /api/discord autocomplete /tooltip | 2.1 | 74 | 8 | 0 | 0 | 0 | 2.5 | 4x | 2.1 | none |
| POST /api/discord /page or /tooltip | 2.1 | 74 | 8 | 0 | 0 | 0 | 2.5 | 4x | 2.1 | none |
| POST /api/discord /sheet view | 3.1 | 5 | 8 | 0 | 0 | 0 | 2.07 | 4.84x | 3.1 | none |
| POST /api/discord /sheet write | 7.1 | 12 | 16 | 1 | 0 | 0 | 3.14 | 3.19x | 8.1 | none |
| POST /api/discord /signup write | 4.1 | 4 | 12 | 1 | 0 | 0 | 2.22 | 4.51x | 5.1 | none |
| POST /api/discord vote button | 6.1 | 15 | 10 | 0 | 1 | 0 | 2.5 | 4x | 7.1 | none |
| POST /api/discord Fix this fact (any user) | 3.1 | 3 | 15 | 0 | 0 | 0 | 1.8 | 5.56x | 3.1 | none |
| POST /api/discord /ask (inline part) | 8.1 | 6 | 22 | 0 | 2 | 0 | 3 | 3.33x | 10.1 | none |
| POST /api/discord /intents | 3.1 | 103 | 8 | 0 | 0 | 0 | 2.2 | 4.55x | 3.1 | none |
| GET /api/library/<unknown name> (404) | 1 | 0 | 0 | 0 | 0 | 0 | 0.3 | 33.3x | 1 | none |
| GET /api/<anything else> (404, no D1) | 0 | 0 | 0 | 0 | 0 | 0 | 0.1 | 100x | 0 | none |
| cron: every minute (flags off) | 0 | 0 | 0 | 0 | 0 | 0 | 0.1 | 100x | 0 | none |

#### Heaviest single invocations (a request plus the answer it hands to waitUntil)

| Flow | CPU est. (ms) | Slowdown that reaches 10 ms | Subrequests (of 50) |
| --- | ---: | ---: | ---: |
| ask_member_claude (web /ask by a member, default provider Claude) | 8.07 | 1.24x | 23 |
| ask_member_wai (web /ask by a member on Workers AI) | 8.07 | 1.24x | 26 |
| ask_guest (web /ask by a visitor (always Workers AI)) | 8.28 | 1.21x | 27 |
| ask_budget_refused (member /ask after the day's cap) | 6.08 | 1.65x | 16 |
| discord_ask_claude (/ask in Discord (Claude)) | 9.88 | 1.01x | 28.1 |
| discord_ask_wai (/ask in Discord (Workers AI)) | 9.88 | 1.01x | 31.1 |

#### Standing load (cron, per day)

Worker requests 1,444 (the two crons, if cron invocations count as requests: unverified), D1 queries 260, rows read 1,012, rows written 100, outside calls 48, Durable Object requests 4.

#### Scenarios (a day each)

#### Realistic day

5 members, one tab each open 3 h with the socket up and the Tonight panel showing, 2 page loads each, a handful of writes, 15 asks, 40 Discord interactions

| Limit | Used | Limit | Share |
| --- | ---: | ---: | ---: |
| Worker requests (100,000/day) | 2,569 | 100,000 | 2.6% |
| D1 rows read (5M/day) | 22,392 | 5,000,000 | 0.45% |
| D1 rows written (100k/day) | 903 | 100,000 | 0.90% |
| Workers AI neurons (10,000/day; soft cap 8,000) | 210 | 10,000 | 2.1% |
| Durable Object requests (100k/day) | 87 | 100,000 | 0.09% |

First limit: **Worker requests (100,000/day)** at 2.6%. Heaviest request CPU est.: 9.88 ms (discord_ask_claude (request + answer in one invocation)); most subrequests in one invocation: 28.1 (discord_ask_claude (request + answer in one invocation)). D1 queries 5,534, outside calls 72.
Lever (tab-hours with the socket up and the votes panel showing): the first limit, Worker requests (100,000/day), is reached at 1,639 tab_hour_ws.


#### Ten polling tabs

the realistic day, but 10 tabs sit visible for 24 h with the socket failed (15 s /state polling, 60 s /votes)

| Limit | Used | Limit | Share |
| --- | ---: | ---: | ---: |
| Worker requests (100,000/day) | 80,839 | 100,000 | 80.8% |
| D1 rows read (5M/day) | 323,767 | 5,000,000 | 6.5% |
| D1 rows written (100k/day) | 583 | 100,000 | 0.58% |
| Workers AI neurons (10,000/day; soft cap 8,000) | 0 | 10,000 | 0.00% |
| Durable Object requests (100k/day) | 7,272 | 100,000 | 7.3% |

First limit: **Worker requests (100,000/day)** at 80.8%. Heaviest request CPU est.: 8.07 ms (ask_member_claude (request + answer in one invocation)); most subrequests in one invocation: 23 (ask_member_claude (request + answer in one invocation)). D1 queries 84,412, outside calls 63.
Lever (tab-hours of polling; 24 = one tab for a day): the first limit, Worker requests (100,000/day), is reached at 298 tab_hour_poll.


#### Ask burst

every member spends the daily cap of 40 on Workers AI (200), 100 visitors from distinct addresses ask once, on top of the realistic day

| Limit | Used | Limit | Share |
| --- | ---: | ---: | ---: |
| Worker requests (100,000/day) | 3,394 | 100,000 | 3.4% |
| D1 rows read (5M/day) | 59,582 | 5,000,000 | 1.2% |
| D1 rows written (100k/day) | 6,200 | 100,000 | 6.2% |
| Workers AI neurons (10,000/day; soft cap 8,000) | 31,500 | 10,000 | 315% |
| Durable Object requests (100k/day) | 814 | 100,000 | 0.81% |

First limit: **Workers AI neurons (10,000/day; soft cap 8,000)** at 315%. Heaviest request CPU est.: 8.28 ms (ask_guest (request + answer in one invocation)); most subrequests in one invocation: 27 (ask_guest (request + answer in one invocation)). D1 queries 12,560, outside calls 48.
Lever (asks that reach Workers AI): the first limit, Workers AI neurons (10,000/day; soft cap 8,000), is reached at 63.5 ask_member_wai + 31.7 ask_guest (the scenario is already past it).


#### Discord interaction storm

5,000 valid signed interactions in one day on top of the realistic day: 2,000 autocomplete keystrokes, 1,000 vote presses, 1,000 static commands, 600 /sheet views, 200 /sheet writes, 200 /ask

| Limit | Used | Limit | Share |
| --- | ---: | ---: | ---: |
| Worker requests (100,000/day) | 7,394 | 100,000 | 7.4% |
| D1 rows read (5M/day) | 220,082 | 5,000,000 | 4.4% |
| D1 rows written (100k/day) | 47,700 | 100,000 | 47.7% |
| Workers AI neurons (10,000/day; soft cap 8,000) | 0 | 10,000 | 0.00% |
| Durable Object requests (100k/day) | 614 | 100,000 | 0.61% |

First limit: **D1 rows written (100k/day)** at 47.7%. Heaviest request CPU est.: 9.88 ms (discord_ask_claude (request + answer in one invocation)); most subrequests in one invocation: 28.1 (discord_ask_claude (request + answer in one invocation)). D1 queries 24,160, outside calls 1,648.
Lever (the storm scaled as a whole): the first limit, D1 rows written (100k/day), is reached at 4,197 discord_autocomplete + 2,099 discord_vote_click + 2,099 discord_static + 1,259 discord_sheet_view + 420 discord_sheet_write + 420 discord_ask_claude.


#### Everything at once

ten polling tabs, the ask burst, the Discord storm, a hostile 10,000-request flood of GET /api/bootstrap, a refresh every 15 minutes

| Limit | Used | Limit | Share |
| --- | ---: | ---: | ---: |
| Worker requests (100,000/day) | 96,790 | 100,000 | 96.8% |
| D1 rows read (5M/day) | 619,796 | 5,000,000 | 12.4% |
| D1 rows written (100k/day) | 54,760 | 100,000 | 54.8% |
| Workers AI neurons (10,000/day; soft cap 8,000) | 31,500 | 10,000 | 315% |
| Durable Object requests (100k/day) | 8,806 | 100,000 | 8.8% |

First limit: **Workers AI neurons (10,000/day; soft cap 8,000)** at 315%. Heaviest request CPU est.: 9.88 ms (discord_ask_claude (request + answer in one invocation)); most subrequests in one invocation: 28.1 (discord_ask_claude (request + answer in one invocation)). D1 queries 120,072, outside calls 2,848.
Lever (hostile requests): the first limit, Workers AI neurons (10,000/day; soft cap 8,000), is reached at 0 anon_bootstrap (the scenario is already past it).


#### Ten tabs, socket up, 24 h

calibration: ten tabs left open all day with the Tonight panel showing and the socket connected (the runbook measured about 15,600 production requests on 2 November)

| Limit | Used | Limit | Share |
| --- | ---: | ---: | ---: |
| Worker requests (100,000/day) | 15,894 | 100,000 | 15.9% |
| D1 rows read (5M/day) | 274,982 | 5,000,000 | 5.5% |
| D1 rows written (100k/day) | 100 | 100,000 | 0.10% |
| Workers AI neurons (10,000/day; soft cap 8,000) | 0 | 10,000 | 0.00% |
| Durable Object requests (100k/day) | 14 | 100,000 | 0.01% |

First limit: **Worker requests (100,000/day)** at 15.9%. Heaviest request CPU est.: 1.75 ms (GET /api/bootstrap); most subrequests in one invocation: 5 (GET /api/votes). D1 queries 72,360, outside calls 48.
Lever (tab-hours with the socket up and the votes panel showing): the first limit, Worker requests (100,000/day), is reached at 1,642 tab_hour_ws.


#### Ten polling tabs, one member without a stored sheet

as Ten polling tabs, with one party member who has no stored sheet row yet (a newly added person): only PR 333 reads the sheet_events log for them on every uncached read

| Limit | Used | Limit | Share |
| --- | ---: | ---: | ---: |
| Worker requests (100,000/day) | 80,694 | 100,000 | 80.7% |
| D1 rows read (5M/day) | 320,982 | 5,000,000 | 6.4% |
| D1 rows written (100k/day) | 100 | 100,000 | 0.10% |
| Workers AI neurons (10,000/day; soft cap 8,000) | 0 | 10,000 | 0.00% |
| Durable Object requests (100k/day) | 7,214 | 100,000 | 7.2% |

First limit: **Worker requests (100,000/day)** at 80.7%. Heaviest request CPU est.: 1.75 ms (GET /api/bootstrap); most subrequests in one invocation: 5 (GET /api/votes). D1 queries 83,860, outside calls 48.
Lever (tab-hours of polling): the first limit, Worker requests (100,000/day), is reached at 299 tab_hour_poll.


#### What alone exhausts each limit (units a day, on the standing load)

| Driver (unit) | Worker requests | D1 rows read | D1 rows written | Workers AI neurons | Durable Object requests | Per-unit req / rows read / rows written / neurons |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| tab_load (page load) | 19,712 | never | never | never | 99,996 | 5 / 37 / 0 / 0 |
| member_tab_load (signed-in extras on a page load) | 32,852 | 1,666,330 | never | never | never | 3 / 3 / 0 / 0 |
| tab_hour_ws (tab-hour, socket up, Tonight or Decide panel showing) | 1,643 | never | never | never | never | 60 / 1,140 / 0 / 0 |
| tab_hour_poll (tab-hour, socket failed (polling fallback)) | 299 | never | never | never | 3,334 | 330 / 3,060 / 0 / 0 |
| library_open (Library opened (13 files)) | 7,582 | never | never | never | never | 13 / 13 / 0 / 0 |
| sheet_write (web sheet edit) | 98,556 | 357,071 | 12,488 | never | 99,996 | 1 / 14 / 8 / 0 |
| signup_write (web sign-up change) | 98,556 | 833,165 | 24,975 | never | 99,996 | 1 / 6 / 4 / 0 |
| launch_write (web launch-state change) | 98,556 | 333,266 | 9,990 | never | 49,998 | 1 / 15 / 10 / 0 |
| journey_write (journey choice) | 98,556 | 833,165 | 24,975 | never | never | 1 / 6 / 4 / 0 |
| ask_member_claude (web /ask by a member, default provider Claude) | 32,852 | 32,889 | 5,877 | never | 33,332 | 3 / 152 / 17 / 0 |
| ask_member_wai (web /ask by a member on Workers AI) | 32,852 | 32,461 | 5,258 | 96 | 33,332 | 3 / 154 / 19 / 105 |
| ask_guest (web /ask by a visitor (always Workers AI)) | 32,852 | 49,495 | 4,344 | 96 | 49,998 | 3 / 101 / 23 / 105 |
| ask_guest_refused (visitor over 2 an hour (429)) | 98,556 | 2,499,494 | never | never | never | 1 / 2 / 0 / 0 |
| ask_budget_refused (member /ask after the day's cap) | 49,278 | 33,551 | 8,325 | never | 49,998 | 2 / 149 / 12 / 0 |
| refresh_accepted (manual refresh (one per 15 min at most)) | 98,556 | 833,165 | 24,975 | never | 49,998 | 1 / 6 / 4 / 0 |
| refresh_cooldown (refresh inside the cooldown (429)) | 98,556 | 714,142 | never | never | never | 1 / 7 / 0 / 0 |
| admin_put_doc (admin PUT of a document) | 98,556 | never | 49,950 | never | 99,996 | 1 / 0 / 2 / 0 |
| bot_intents_poll (PC-bot poll of the mailbox) | 98,556 | 49,990 | never | never | never | 1 / 100 / 0 / 0 |
| sweep_changed_source (source that changed in a sweep) | never | 13,475 | 8,325 | never | never | 0 / 371 / 12 / 0 |
| discord_ping (PING) | 98,556 | never | never | never | never | 1 / 0 / 0 / 0 |
| discord_bad_signature (unsigned or stale POST) | 98,556 | never | never | never | never | 1 / 0 / 0 / 0 |
| discord_static (static command) | 98,556 | 1,666,330 | 12,488 | never | never | 1 / 3 / 8 / 0 |
| discord_autocomplete (/tooltip autocomplete keystroke) | 98,556 | 67,554 | 12,488 | never | never | 1 / 74 / 8 / 0 |
| discord_page (/page or /tooltip) | 98,556 | 67,554 | 12,488 | never | never | 1 / 74 / 8 / 0 |
| discord_sheet_view (/sheet view) | 98,556 | 999,798 | 12,488 | never | never | 1 / 5 / 8 / 0 |
| discord_sheet_write (/sheet write) | 98,556 | 416,583 | 6,244 | never | 99,996 | 1 / 12 / 16 / 0 |
| discord_signup (/signup change) | 98,556 | 1,249,747 | 8,325 | never | 99,996 | 1 / 4 / 12 / 0 |
| discord_vote_click (vote button press) | 98,556 | 333,266 | 9,990 | never | never | 1 / 15 / 10 / 0 |
| discord_fix_click (Fix this fact press) | 98,556 | 1,666,330 | 6,660 | never | never | 1 / 3 / 15 / 0 |
| discord_intents (/intents) | 98,556 | 48,534 | 12,488 | never | never | 1 / 103 / 8 / 0 |
| discord_ask_claude (/ask in Discord (Claude)) | 98,556 | 33,106 | 3,568 | never | 49,998 | 1 / 151 / 28 / 0 |
| discord_ask_wai (/ask in Discord (Workers AI)) | 98,556 | 32,674 | 3,330 | 96 | 49,998 | 1 / 153 / 30 / 105 |
| anon_bootstrap (anonymous GET /api/bootstrap) | 98,556 | never | never | never | never | 1 / 9 / 0 / 0 |
| anon_library_guess (anonymous GET /api/library/<random>) | 98,556 | never | never | never | never | 1 / 0 / 0 / 0 |
| anon_404 (anonymous GET of an unknown path) | 98,556 | never | never | never | never | 1 / 0 / 0 / 0 |

