# ADR 0011: Research sources and the hotfix index

Status: DRAFT for review by the owner and the back-end architect. Nothing here is implemented; `tools/source-probe.mjs` is the only code that ships with it and it has not been run against the network.
Date: 2026-11-14
Scope: how Leeroy gets fresh game facts at question time and between questions without storing page text, and how a new post expires answers that are now stale.
Number: the next free number in this branch is 0002; 0011 was assigned by the work plan, so 0002 to 0010 are expected to be taken by sibling work.

Every claim is tagged. **[hand-read: file]** means a person or agent read that file in this branch. **[brief]** means it comes from `REDESIGN-BRIEF-v2.md` sections 4.2, 5.4 and 5.5, whose own live checks were not repeated here. **[inferred]** means reasoned, not observed. Anything that depends on how a real site behaves is in the last section, because the probe has not run.

## Context

- The current sweep runs every 6 hours (`0 */6 * * *`), reads up to 12 `lib_sources` rows, asks Workers AI to propose facts, and stores `body_text` in `lib_source_snapshots` **[hand-read: infrastructure/wrangler.toml:16-18, infrastructure/schema.sql:47-71, infrastructure/worker/scraper.js `runScheduledSourceSweep`]**.
- The repo's compliance rule is link-only for Blizzard and guide sites, with no stored page text **[hand-read: docs/compliance/blizzard-checklist.md rows 3, 5, 6; data/library-sources.json `storedText: "link-only"` for news.blizzard.com, us.forums.blizzard.com, www.wowhead.com, www.icy-veins.com, www.method.gg]**. The snapshot table stores page text, which is in tension with that rule. The brief says the same **[brief, 5.5 last paragraph]**. This ADR does not touch the table; it adds a path that never writes to it.
- The existing fetcher already has the safety shape we want: https only, redirects by hand and only to the same host, 10 s timeout, 256 KB cap **[hand-read: scraper.js `fetchSource`, `sourceHostAllowed`, `readCapped`, constants `SOURCE_FETCH_TIMEOUT_MS` and `MAX_SOURCE_BYTES`]**. The probe copies those limits so its numbers describe the same fetch.
- The brief rejects a provider's bundled "grounded answer" because its terms forbid caching, mixing and analysis, and because owning the fetch lets us check claims against the page **[brief, 4.2]**.
- Cloudflare Workers Free limits used here: 10 ms CPU per request, 50 subrequests per request, 5 cron triggers per account, `waitUntil` about 30 s **[brief, 5.4, "live, limits page"]**. Whether a cron invocation gets the same 10 ms as an HTTP request is **[inferred]**; confirm on the limits page before building.

## Decision

1. **Search-then-fetch, under our control.** A search call returns links only. Leeroy fetches the best links itself, from an allow-list first. No bundled grounded-answer product is used **[brief, 4.2]**.
2. **Allow-list order.** (a) Blizzard news, forums and blue posts: `news.blizzard.com`, `us.forums.blizzard.com`, `eu.forums.blizzard.com`, `worldofwarcraft.blizzard.com`. (b) Wowhead pages for WoW Forever: `www.wowhead.com`. (c) Two or three guide sites: `www.icy-veins.com`, `www.method.gg`, one more chosen after review. (d) Open web, only after the first three are thin, and only for hosts the owner has reviewed. All hosts must exist in `data/library-sources.json` first **[hand-read: data/library-sources.json hosts list; tests/unit/source-probe.test.mjs asserts the probe hosts are in it]**. Which Wowhead path covers WoW Forever is not known.
3. **What is stored.** Per source used: URL, page title, one quote of at most 14 words copied from the page, the page's own date, and own-words bullets written by us. Never a page body, never a snapshot, never a cached HTML. A hash of the extracted main text is kept so the watcher can see a change **[brief, 4.2 steps 6 and "Freshness watcher"]**. The 14-word limit is checked in code at write time (reject, do not truncate).
4. **Fetch at question time is for the asker's answer only.** The fetched text lives in memory for that request, is passed to the compose step, and is dropped. The stored record is the citation row above **[inferred; the brief says page bodies are not stored]**.
5. **A hotfix index in D1** (schema below) is filled by a watcher, not by asks. The ask path reads the index first because it is cheap and already in our words.
6. **A post expires cached answers and golden references** that carry a topic it touches (see Expiry).
7. **One cron trigger** runs the watcher once the launch-moments cron is deleted (see Watcher).

## Freshness windows by volatility

The understand step tags a question with a volatility **[brief, 4.2 step 1]**. The cache key is our own, from the normalised standalone question **[brief, 5.4 Caching]**. Proposed windows, to be tuned from measured trace data, not from guesses:

| Volatility | Examples | Cache window | Also expires on a hotfix topic match |
|---|---|---|---|
| High | drop rates, class tuning, "is X nerfed", availability, prices | 6 h | yes |
| Medium | quest routes, profession recipes, talent picks | 3 days | yes |
| Low | lore, long-standing mechanics, how a system works | 14 days | yes, only if the topic tag is exact |

Never cached: a dead end, an error, or an answer voted Off **[brief, 5.4]**. An answer that rests on model knowledge only is worded as a Classic value and is not given a window longer than Medium **[inferred from brief 4.2 step 4]**. Window numbers are **[inferred]**.

## Hotfix index schema (D1)

Sketch for review, not a migration. Times are ISO-8601 UTC text, matching `lib_sources.checked_at` **[hand-read: schema.sql:47-60]**.

```sql
CREATE TABLE IF NOT EXISTS hotfix_entries (
  id          TEXT PRIMARY KEY,           -- sha8 of url + posted_at, or the source's post id when it has one
  url         TEXT NOT NULL UNIQUE,       -- the link people click; the only copy of the post
  source_host TEXT NOT NULL,              -- must be in data/library-sources.json
  title       TEXT NOT NULL,              -- the post title, short
  posted_at   TEXT,                       -- the post's own date; NULL when the page gave none
  seen_at     TEXT NOT NULL,              -- when the watcher first saw it
  topics      TEXT NOT NULL,              -- JSON array of normalised topic tags, e.g. ["class:mage","dungeon:example"]
  quote       TEXT,                       -- under 15 words, verbatim, checked in code; NULL if none fits
  bullets_json TEXT NOT NULL,             -- JSON array of own-words bullets, each under 200 chars
  hash        TEXT NOT NULL,              -- sha256 hex (truncated to 16) of the extracted main text; the text is not kept
  status      TEXT NOT NULL DEFAULT 'live' CHECK (status IN ('live','retracted','superseded'))
);
CREATE INDEX IF NOT EXISTS idx_hotfix_posted ON hotfix_entries(posted_at DESC);

CREATE TABLE IF NOT EXISTS answer_expiry (
  entry_id    TEXT NOT NULL REFERENCES hotfix_entries(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('cache','golden','open_question')),
  target_key  TEXT NOT NULL,              -- cache key, golden-case id or open-question id
  expired_at  TEXT NOT NULL,
  PRIMARY KEY (entry_id, kind, target_key)
);
```

The `topics` array is a JSON text column, so topic lookup is a `LIKE` or a join table. A join table `hotfix_topics(entry_id, topic)` is cleaner for expiry and is an open choice **[inferred]**. The answer cache and golden set need a `topics` column of their own, which they do not have today **[inferred; not checked in this task]**.

## The watcher

**Cron budget.** `wrangler.toml` lists two triggers, the 6-hourly sweep and the every-minute launch-moments tick, and says "the second of five" **[hand-read: infrastructure/wrangler.toml:16-18]**. Deleting the launch-moments trigger frees one. The watcher uses exactly one trigger, e.g. `*/30 * * * *`, and the 6-hourly sweep is retired or reduced to the same handler. Adding a third trigger is not needed.

**One run, in order, with a budget** (numbers are **[inferred]** until the probe and a real cron run give measurements):

1. Read the next 3 watched index pages from `lib_sources` ordered by `checked_at` (1 D1 read), conditional GET with `If-None-Match` and `If-Modified-Since` **[hand-read: scraper.js sends both headers]**.
2. For each 200 response: read at most 256 KB, run the naive text pass, hash the main text. Unchanged hash: write `checked_at` and stop for that source.
3. Changed hash: extract link, title and date of new posts with a bounded pattern pass on the anchors. No model call inside the Worker's 10 ms CPU window.
4. New posts are queued; a second invocation path (Durable Object alarm or `waitUntil`) fetches each post page, produces bullets with Workers AI and writes the entry. This keeps CPU of the cron handler small **[brief, 4.2 Speed: alarms get 15 minutes of wall time]**.
5. Each new entry runs the expiry step in one D1 `batch`.

**What the numbers allow.** Subrequests per invocation: 50 on Free **[brief, 5.4]**. D1 statements may count toward that cap on the free plan **[inferred; unverified]**. A run of 3 sources costs about 3 page fetches, up to 3 `robots.txt` fetches (cached per run), and a handful of D1 calls: well under 50 even if D1 counts. CPU: the probe measures one naive pass over each page, in Node. If a pass is a few milliseconds the 10 ms cap leaves room for 1 or 2 pages per invocation, not 3 **[inferred]**; this is the first number the probe replaces. If it is over budget the answer is a smaller page cap (read the first 64 KB), a more frequent cron over fewer pages, or the paid plan (about $5 a month on the owner's account, which needs the account holder) **[brief, 5.4]**.

**Politeness.** One watcher request per source per run, conditional, with the same User-Agent the sweep already uses, `LeeroyBoard-CloudflareWorker/1.0` **[hand-read: scraper.js]**. `robots.txt` is read and honoured, and a Disallow for the path means the source is dropped from the watcher and reported, not worked around. The probe implements this rule and records it.

## Expiry

On a new entry with topics T:

- Cache: for each cached answer whose topic tags intersect T and whose volatility is High or Medium, or Low with an exact tag match, mark it expired (delete the row or set `expires_at` to now). Write an `answer_expiry` row of kind `cache` for audit.
- Golden references: a reference answer that touches T is marked `stale` and excluded from the pass-rate gate until a person re-confirms it. It is not edited automatically. Kind `golden`.
- Open questions: a pending open-question row on T is re-checked now, then continues its daily re-check for a week **[brief, 4.2 Open questions]**. Kind `open_question`.
- A retracted or superseded post (`status`) expires what it expired before, once more, so an answer built on it does not survive.

The expiry step carries only topic tags and keys. No question text, asker or friend data enters it.

## Failure modes

| Failure | Handling | Status |
|---|---|---|
| Source down, 5xx, timeout | Record on `lib_sources.status`, keep the last index as is, back off for that source, say "could not check Blizzard's posts since {time}" if an answer depends on freshness | [inferred] |
| Blocked user agent (403, challenge page) | Count as blocked, do not rotate agents or evade; drop the source from the watcher and report it; fall back to search links the person can open | [inferred]; probe records status and content-type |
| JS-only page (empty shell) | The probe flags it. The Worker does not render pages. Use the site's server-rendered or feed URL if one exists, else the source is link-only in answers and not watched | [inferred]; probe heuristic untested on real pages |
| `robots.txt` unreachable | Treated as deny for that run (RFC 9309 says unavailable means no restriction for 4xx and complete restriction for server errors); the probe implements the 4xx allow and 5xx deny reading | [inferred] |
| Redirect to another host | Not followed, recorded **[hand-read: scraper.js `fetchSource` blocks it; the probe records it]** | |
| Page grows past the cap | Read first 256 KB, flag truncated; if the news list is past the cap the watcher misses entries | [inferred] |
| Duplicate or edited post | `url` is unique; a changed hash on a known URL updates bullets and re-runs expiry | [inferred] |
| Model writes a bullet that copies the page | Reject a bullet sharing a run of 15 or more words with the source text; this check needs the fetched text, so it runs before the text is dropped | [inferred] |

## Privacy

- A question is de-identified before it leaves for any search or outside model: names replaced by stable aliases, then an outbound check against the roster, handles, ids, character and guild names and a planted canary **[brief, 5.5 Data classes A and B]**. The tokeniser and guard live in `infrastructure/worker/privacy/` on master (`tokenise.js`, `outbound-guard.js`, which exports `scrubSearchQuery`, `roster-config.js`, `skeleton.js`). This ADR does not depend on their interface **[checked on master 2026-11-15: the files exist; the interface was not reviewed for this ADR]**.
- The watcher sends no friend data anywhere: it fetches public pages and writes game facts.
- Search queries are class A only. The index, the cache keys and the expiry table hold no asker identity.
- Fetching from our own Worker means the target sites see our User-Agent and the Worker's egress address, not any friend's address **[inferred]**.

## Alternatives considered

- Bundled grounded answers from a model provider: rejected on terms (no caching, no mixing, no analysis) **[brief, 4.2]**.
- Keep storing snapshots and quote from them: rejected on the link-only rule **[hand-read: blizzard-checklist.md rows 5 and 6]**.
- Fetch every post on every ask: rejected on the 50 subrequest and 10 ms CPU limits and on politeness **[brief, 5.4]**.
- Third-party RSS or a hosted scraper: no account is created or paid for in this ADR; revisit only with the owner **[inferred]**.

## What we do not know until the probe runs

Run `node tools/source-probe.mjs --out <dir>` from a machine the owner picks; it reads `tools/source-probe.sources.json`. None of the following is known today.

1. Whether the listed paths exist and return 200 to a Worker-like User-Agent, or return 403, a challenge or a redirect. The paths in the config are guesses.
2. Where Blizzard's hotfix and blue-post pages actually live for WoW Forever, and whether Wowhead has a Forever section with its own path.
3. What each host's `robots.txt` says about our agent and about those paths.
4. Page sizes: whether index pages fit in 256 KB, so the cap does not cut off new posts.
5. Whether the pages are server-rendered or need JavaScript, and whether the heuristic in the probe is right about it.
6. Parse CPU of the naive text pass on real pages, and how that Node number maps to workerd. The probe cannot answer the second half; only a deployed test Worker or `wrangler dev` timing can.
7. Whether a cron invocation on Free gets the same 10 ms CPU and 50 subrequests as an HTTP request, and whether D1 calls count against the 50.
8. Whether sites expose a date, a stable post id or a feed that makes hotfix extraction a link-and-title pass instead of a model call.
9. Time to first byte and total fetch time from Cloudflare's network (the probe measures from wherever it runs).
10. Whether each site's terms allow our use (link, title, short quote, own-words summary). The checklist says link-only for all of them and treats the terms of several as not reviewed **[hand-read: data/library-sources.json `reviewed` fields]**. The probe reads no terms.
11. The per-run budget of AI neurons for bullets, against the existing allowance **[brief, 5.4]**.

## Consequences

- A new D1 migration (two tables, topic tags on cache and golden rows), a watcher handler, and a change to one cron line, in later work items.
- The `lib_source_snapshots` table and its writer stay untouched here; retiring them is a separate decision for the owner.
- The probe gives the first measured numbers; this ADR is revised with them before any Worker code is written.
