# GROUP_MEMORY: what Leeroy keeps from the group, where, and who can read it

This page covers the `GROUP_MEMORY` flag: what is stored, where it lives, who can read it, how to inspect, export and erase it, how to turn it on, and how to roll it back.

Owner decision (Matt, 2026-11-15): Leeroy's memory keeps everything from the group (full conversations, every turn, running bits, who said what, personal context) with no exclusion list and no consent gate, so Leeroy can use the friends' names and history naturally. Three lines stay because they protect the friends: the data lives in private storage only, it goes only to the paid Claude API, and it is read only for roster members.

## What is stored

Two D1 tables, created by migration `0011_group_memory.sql` and mirrored in `schema.sql`.

- `group_log`: one row per thing said (`id`, `at`, `channel`, `author_slug`, `kind` of `ask`, `answer` or `message`, `text`, `reply_to`, `source`). Today the writer files a roster member's answered `/ask` as an `ask` row and, when Claude wrote the answer, an `answer` row (both under the asker's slug, `reply_to` is the ask id). A later listener (step f) appends `message` rows through `appendGroupLog` in `worker/research/group-memory.js`. A row whose text holds a secret-shaped string (a key typed into chat) is not stored.
- `group_wiki`: running notes (`page_key`, `title`, `body_md`, `updated_at`, `rev`, `note`). The refresher writes `person-<slug>` pages, a `group` page for running bits and `topic-<word>` pages. `note` reads `rebuild:erase` while a page waits for a rewrite after an erase.

A private (ephemeral) ask is filed with `source = 'ask-private'`: it is shown only to a later private ask of the same person, never to a public ask (the asker's own included) and never to another friend, and the refresher never summarises it. The right-click "Ask Leeroy" files the target message as a `message` row under the real author's slug (`unknown` when the author is not on the roster), never as the invoker's ask. Degraded lines, library-only answers and code-written abstains are not filed as Leeroy's answers.

## Who can read it

Only a roster member's own research prompt reads these tables (the slug must be on the party sheets or in the roster; a board-key holder who is on neither gets and leaves nothing; the admin token maps to the owner's slug and keeps working), and only when `RESEARCH_NAMES` is `real` (tokenised mode omits the block and skips the refresher). A web visitor, a guest or a non-member never gets a friend's history: the reader returns an empty string without touching the database. The text goes to Anthropic's paid API only (the prompt and the refresher call), never to Workers AI or any free-tier model. No route, static file or public document reads the tables; `tests/unit/group-memory.test.mjs` checks the source tree and sweeps the public GET routes for a canary.

In the prompt the block is one fenced `GROUP_MEMORY` section after the asker's own turns: up to 4 wiki pages (the asker's, then any member named in the question, then `group`), each capped at 560 characters, plus the last 12 rows of the same channel, the whole block capped at 3,500 characters. Stored text is neutralised on the way out (links, mentions, footer lines, role-looking labels and fence tokens removed, after the full text is considered) and the system prompt carries a static rule that the block is data.

## Export and erase

Both routes (`GET /api/me/export`, `POST /api/me/erase`, behind `DATA_RIGHTS`) cover the tables whether or not `GROUP_MEMORY` is on. Approach: one existence read (`SELECT (SELECT 1 FROM group_log LIMIT 1), (SELECT 1 FROM group_wiki LIMIT 1)`). When both tables are empty or missing, nothing else is read and the answer is byte for byte the answer from before the feature (no new keys, no new note); once any group row or page exists the full path runs, flag on or off. A member who has no group data of their own gets the new keys and notes only if they have some.

- Export: the member's `group_log` rows, the pages keyed to them in full, and the pages that mention them by key and title only (their text holds other people's words).
- Erase: the member's `group_log` rows and their own pages are deleted. A page that mentions their slug or name (case-insensitive, whole words, with a space, hyphen, underscore or nothing between the parts: `Red Fox`, `red-fox`, `RedFox`; never inside a longer word) keeps its other content with those spellings replaced by "a former member" and is flagged `rebuild:erase`; only pages that match are touched. The refresher rewrites flagged pages on its next run. What other friends wrote that mentions the person stays in `group_log`; a nickname is caught only when a page is rewritten. The erase response says so.

## Inspect in the D1 console

```sql
SELECT id, at, channel, author_slug, kind, source, substr(text, 1, 80) FROM group_log ORDER BY id DESC LIMIT 20;
SELECT page_key, title, rev, note, updated_at, length(body_md) FROM group_wiki ORDER BY updated_at DESC;
SELECT json FROM kv_state WHERE key = 'group_wiki_state';   -- watermark: last_id, last_run, bad
```

## Flip and rollback

Flip: set `GROUP_MEMORY = "on"` in `infrastructure/wrangler.toml` `[vars]` and deploy. Migration 0011 must be applied first (the deploy applies pending migrations). It has no effect unless `ASK_RESEARCH` is also on, and never in a PR preview.

Rollback: set `GROUP_MEMORY = "off"` and deploy. Nothing reads or writes the tables while it is off and the ask path is byte for byte the old one. The stored rows stay; to drop them, run `DROP TABLE IF EXISTS group_log; DROP TABLE IF EXISTS group_wiki;` and delete the `group_wiki_state` kv_state row.

## Token cost and the refresher

The 6-hour cron runs the refresher when both flags are on and `RESEARCH_NAMES` is `real`. It is due when 10 or more new rows exist, or 24 hours have passed since the last run and something new exists, or a page waits for a rebuild. One Haiku-class call, at most 60 rows, at most 2 runs per UTC day, one lock row so concurrent runs make one call, and no second try the same day after a failure. A missing key, a spent cap or sub-cap, or a prompt that lost a section to the secret screen skips the run without a call. The model may update only the pages it was shown (up to 6, chosen by relevance); an unshown existing page is never overwritten, a rewrite may not shrink a page below half its length unless the page waits for a rebuild, and every body is cleaned at write time. Junk or truncated output writes nothing and does not move the watermark; after three junk days in a row the rows are skipped.

The monthly cap is 5,000,000 tokens (`RESEARCH_CLAUDE_MONTHLY_TOKENS` in `wrangler.toml`), shared with `/ask`. The refresher has its own sub-cap of 10% of it (500,000 tokens a month, counter `claude_tokens_group_YYYYMM`), so asks always have room. Prices read at source on 2026-11-15 (https://platform.claude.com/docs/en/about-claude/pricing, prompts up to 100,000 tokens): Sonnet 5.5 costs $2 per million input tokens and $10 per million output tokens; Haiku 5.5 costs $0.10 per million input tokens and $0.50 per million output tokens. Worst case if all 5,000,000 tokens of the monthly cap were Sonnet output: about $50 (all input: about $10). Haiku at most about $2.50. All of it sits inside the owner's $200 monthly credit. The model ids (`claude-sonnet-5-5`, `claude-haiku-5-5`) are still unverified with a live key. Arithmetic per run is in `flags.md`.

## Limits

The code is tested with stubs only: no live Claude call has run, and the quality of the refresher's summaries on real conversation is untested. Until the listener exists, memory holds only `/ask` traffic.
