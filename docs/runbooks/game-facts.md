# Game facts: a D1 store of the Forever client's own numbers, loaded from the PC

The replay harness (`docs/runbooks/replay-harness.md`) measures how often `/ask` states a game fact correctly. Its truth set is built from the Forever client's own data tables, and the honest baseline is that the Worker answers those questions from the model and the static library, with no `game_facts` table behind it. This store is that table. PR 1 of 2 (this one) builds the store, the signed loader, the loader tool and a lookup function. All flags are off and **nothing in the ask path reads the store yet**.

## What is in the repo and what is not

Code, synthetic test fixtures and this document. Nothing from the client's tables, from `traits.json`, or from the curated `facts.jsonl` / `client-facts.jsonl` is in the repository, in a PR body, or in a test: the tests build fictional tables at run time. The tool reads the real files from where they live (outside the repo, `C:\projects\leeroy-ops\notes\private\truth\` on the owner's machine) and sends rows only inside the signed request body. It prints counts, never a row's text. The store itself holds game data only: no friend data, no person, no message text (DATA_MAP: `game_fact_loads` and `game_facts` are "no personal data", not in the member export or the erase).

## Pieces

| piece | file |
|---|---|
| two plain tables, two indexes (no virtual table, no trigger) | `infrastructure/migrations/0016_game_facts.sql`, mirrored in `infrastructure/schema.sql` |
| signed loader route `POST /api/facts/load` | `infrastructure/worker/game-facts.js` |
| key `leeroy-facts-load-v1` | `infrastructure/worker/listener-config.js` (`factsLoadKey`, `factsLoadKeyFor`) |
| name normaliser (loader and lookup share it) | `infrastructure/worker/game-facts-name.js` |
| lookup (not wired) | `infrastructure/worker/game-facts-lookup.js` (`lookupGameFacts`) |
| PC side | `tools/facts-load.mjs` (imports `buildCandidates` from `tools/replay/truth-gen.mjs`; `tools/replay/common.mjs` verifies the manifest) |
| tests | `tests/unit/game-facts.test.mjs`, `tests/unit/d1-facts-smoke.test.mjs` |
| real-D1 proof in the PR preview run | `tools/d1-facts-smoke.mjs` (lookups, rows written, plain export) |

## Tables

- `game_fact_loads`: one row per load run. `kind` is `client` (derived from the DB2 export and `traits.json`) or `curated` (`facts.jsonl`, `client-facts.jsonl`). `status` is `open`, `done` or `failed`. `files_json` is file name to `{sha256, bytes, rows}`; `manifest_sha256` is the hash of `MANIFEST.json`; `counts_json` holds counts only (`kinds` declared at begin with a row count each, then `total`, `added`, `changed`, `unchanged`, `removed`, `prev_load_id`, `prev_build`). A handful of rows, so no index.
- `game_facts`: one row per **(fact id, load)**, `PRIMARY KEY (id, load_id)`, `WITHOUT ROWID`. A load writes only its own rows and never overwrites another load's, so a load that is open, failed or interrupted leaves every published fact untouched. `id` is stable across builds (`spelllevels:<csv row id>`, `trait_max_ranks:<tree>-<node>`, `curated:<cid>`). `kind` is one of `spell_level`, `item_level_req`, `spell_cooldown`, `spell_cast_time`, `spell_mana_cost`, `trait_max_ranks`, `trait_points_required`, `trait_prereq`, `curated`. `claim` is one plain sentence; `value` and `unit` carry the number; `source_table` and `row_id` point at the source row; `verdict` is `holds`, `wrong` or `unverifiable`; `superseded` is 1 once a newer finished load replaced or dropped the fact. Rows are **never deleted**.
- `subject_norm` and `subject_base` are computed by the Worker from `subject` with `game-facts-name.js`: case-folded, diacritics stripped, apostrophes removed (`Light's Vigil` is `lights vigil`), every other punctuation run one space (`Polymorph: Chicken` is `polymorph chicken`, `Engrave Pants - Envenom` is `engrave pants envenom`), spaces collapsed. `subject_base` is the same name without a trailing rank suffix (`rank 4`, `rank iv`, or a trailing roman numeral on a name with more words, `arcane spirit iii` gives `arcane spirit`), or empty. The full name always keeps the numeral, because it can be part of the name.

### Indexes and what a write costs (D1 Free: 100,000 rows written a day; an index adds one written row per indexed write)

- `WITHOUT ROWID`: the primary key `(id, load_id)` is the table itself, so a fact costs one table row, not a row plus an autoindex row. Its id prefix serves the per-id checks (the newest-load guard of the lookup, the counters of a batch).
- `idx_game_facts_kind_subject (kind, subject_norm)`: the lookup's only access path by name (`kind IN (...) AND subject_norm IN (...)`) and the kind scans of finish. One written row per fact.
- `idx_game_facts_kind_base (kind, subject_base) WHERE subject_base <> ''` (partial): lets "Arcane Spirit" find "Arcane Spirit III". Only rank-suffixed names pay for it (754 of 18,752 client facts in the real-table dry run).
- No index on `load_id` or `build`: finish counts a load with one scan, which costs rows READ (5,000,000 a day are free), not written.
- `tools/d1-facts-smoke.mjs` measures all of this on the PR preview D1 (the numbers are in that run's job summary, section "Game facts on the real preview D1") and fails the step if a measurement exceeds the constants `tools/facts-load.mjs` counts with (`WRITES_PER_FACT`, `WRITES_PER_SUFFIXED_FACT`, `WRITES_PER_CALL`, `WRITES_PER_RETIRED_FACT`). Measured on the PR 403 preview D1 (run 44578506584, rows written from D1 `meta.rows_written`): **2 rows per fact** (table row plus `idx_game_facts_kind_subject`; 60 plain facts wrote 120), **+1 for a rank-suffixed name** (30 suffixed facts of a 300-fact load wrote 630 in all against 600 for plain names), **2 per signed call** (the `kv_state` rate row 1, the load counters 1; the tool counts 3), 2 for `begin`, **1 for a finish with nothing to retire and 1 per retired fact** (finish retiring 300 rows wrote 301; it also READ 1,247 rows). Projection from those numbers against 100,000 a day: the client load (18,752 facts, 754 of them rank-suffixed, 96 calls) is about 38,450 rows (38.5%), the curated load (142 rows, 3 calls) 291 (0.3%), both together about 38,740 (38.7%); a rebuild for a new build (every new row written, every old row retired) is about 57,200 (57.2%). One run therefore fits the default 60,000 budget and one day; two rebuilds in one day do not.

### Why there is no full-text index (option C)

A first version used an FTS5 virtual table with three sync triggers. D1 supports FTS5 (SQL statements page, https://developers.cloudflare.com/d1/sql-api/sql-statements/), but on the real preview D1 a plain `wrangler d1 export` of a database that holds one fails with "D1 Export error: cannot export databases with virtual tables (like FTS5)" (read from the preview run log, 2026-11-19; the 2026-11-12 changelog describes a `--compatibility sqlite3_cli_only` export that cannot be imported back into D1, and the installed wrangler 4.148 has no such flag). Every index also costs written rows. The store is therefore two plain tables, and the lookup works on names: the facts are names with numbers (a spell, an item, a talent), and the question is cut into word windows that are looked up through the index. `docs/runbooks/backup-restore.md`: a plain `wrangler d1 export` works because the database holds no virtual table.


## The loader route

`POST /api/facts/load`, flag `GAME_FACTS_LOAD` (a `[vars]` flag, shipped `"off"`; only the exact value `on`, any case, trimmed, opens it). Gate, in order:

1. Flag not `on`, a PR preview, or no usable bot token: 404, nothing read or written.
2. Body over 256 KB: 413.
3. HMAC with the facts-load key, headers `X-Listen-Timestamp` / `X-Listen-Signature`, 120 s window: 401. The key is `HMAC-SHA256(key = bot token, message = "leeroy-facts-load-v1")`, 32 raw bytes. The listener, self-test, shadow, heartbeat and heartbeat-status keys never verify here, and the facts key opens none of their routes.
4. Body shape: `{purpose: "facts-load", op: "begin" | "rows" | "finish", ...}`, exact key sets, and for `rows` every field of every row (below): 400 `invalid_row` for the whole batch if any row is bad. Nothing is recorded for a refused body.
5. Replay and rate: `kv_state` row `facts_load_state` holds the last accepted signed second; a second that is not strictly newer is 409 `replay` (so the tool waits at least one second between calls). 120 accepted calls in a rolling hour; the 121st is 429 with `Retry-After`.

Ops:

- `begin {build, manifest_sha256, files, kind, kinds}`: opens a load and returns `load_id`. `kinds` declares the fact kinds the load will send with a row count for each (`client` loads: the non-curated kinds; `curated` loads: only `curated`). 409 `older_build` if a done load of the same kind has a newer build (the same build may be loaded again); 409 `conflict` if another load of the same kind is open and younger than 30 minutes (an older open load is marked `failed` first, and the published facts were never touched).
- `rows {load_id, rows[<=200]}`: validates every row, refuses a kind that begin did not declare, then writes the batch in one D1 batch under the load's own `(id, load_id)` keys. Each insert carries a guard in the statement itself (`WHERE EXISTS (SELECT 1 FROM game_fact_loads WHERE id = ? AND status = 'open')`), so a late batch for a load that is no longer open writes nothing even if the Worker read the load as open a moment earlier; the answer is 409 `load_closed`. A client load carries one build (`build` of every row equals the load's); a curated load accepts rows of their own builds. A repeated batch is idempotent and is not counted twice.
- `finish {load_id}`: refuses (409 `incomplete`, load stays open) unless every declared kind has exactly its declared row count and nothing else is in the load. Then one D1 batch: the status change (`UPDATE ... WHERE status = 'open'` and the per-kind counts re-checked in the statement), and, conditioned on that change having happened, `superseded = 1` on every older row of the declared kinds (re-seen ids are replaced by the new load's row, ids the load did not send are retired). A delayed or duplicate finish whose own update matches nothing supersedes nothing. Finish on a `done` load returns the same `ok` and counts again, so a lost response can be retried.

Row fields (strict; any other key, any non-string text, any control, format or line-separator character refuses the batch): `id` `^[a-z_]+:[A-Za-z0-9_.-]{1,40}$` (`curated:` prefix exactly for kind `curated`), `kind` (fixed list), `subject` 1 to 120 characters that fold to at least one word, `claim` 1 to 400, `value` up to 80, `unit` (`""`, `level`, `seconds`, `mana`, `ranks`, `points`), `source_table` `^[a-z0-9_]{0,40}$`, `row_id` `^[A-Za-z0-9_.:-]{0,40}$`, `build` `^[0-9.]{3,32}$`, `verdict` (`holds`, `wrong`, `unverifiable`), `source_class` (`client-db2`, `client-addon-data`, `client-data-site`, `blizzard`, `tavern-or-forever-guide`, `wiki`, `third-party-named`, `none`), `note` up to 300. `subject_norm` and `subject_base` are computed by the Worker (see Tables).

Responses carry fixed fields only: `ok`, `load_id`, `accepted`, `counts` (numbers), `reason` (a class such as `invalid_row`, `replay`, `rate_limited`, `conflict`, `incomplete`, `load_closed`, `no_load`, `unavailable`). No row text and no database error text leave the Worker.

### Visibility

A fact counts only while the load it came from is `done`, `superseded = 0`, and no newer done load holds the same id. Because each load keeps its own rows, an **open reload, a failed one or an interrupted one never hides a published fact**: the old rows stay fully visible until a finish publishes the new set in one transaction. Rows of a failed or open load are inert and never served. A load that did not declare a kind never retires that kind: a client load without `--traits` leaves the trait facts published, and a curated load never touches client rows.


## The lookup (not wired in this PR)

`lookupGameFacts(env, question, { limit = 5 })` in `game-facts-lookup.js` returns `{ rows, doNotSay, ambiguous, via }`. A row is `{ id, kind, subject, claim, value, unit, source_table, row_id, build }`.

- The question is folded with the same normaliser the loader used and cut into word windows of 1 to 6 words (at most 24 words, 600 characters; a one-word stop-word window is never a name). Windows go to the index longest first: `kind IN (...) AND subject_norm IN (...)` with every window and every window minus its rank suffix ("Frostbolt Rank 4" asks for "frostbolt"), and `subject_base IN (...)` with the plain windows ("Arcane Spirit" finds "Arcane Spirit III"). A base window counts only when no rank follows it in the question: "Arcane Spirit II" never returns the rank III row on its own. At most 90 keys per statement (D1 allows 100 bound values); every value is a bound parameter, nothing from the question is in the SQL text.
- Names are chosen longest first without overlap ("Fire Blast" hides "Fire", a second name elsewhere in the question still matches). **Every row that shares a chosen name comes back with its id.** `ambiguous` is true when a name has several rows of the same kind (a spell name with three rows, ranks of one talent); nothing is picked silently. Different kinds of one spell (level, cooldown, cast time) are not ambiguity. The limit never cuts a name's rows.
- Visible rows only: the load is `done`, `superseded = 0`, and no newer done load holds the same id (checked in the query, before any limit). `holds` rows come back as `rows`, `wrong` rows as `doNotSay`, `unverifiable` rows are not returned.
- Curated facts are sentences without a name key: they are matched on the question's specific words (stop words and words like "level" or "cooldown" do not count; two matching words when the question has two or more) over the few hundred curated rows.
- A database error answers empty (`via: "none"`); it never throws.
- The loader's uniqueness rules (from `truth-gen.mjs`) already keep a name out of the store when the client has several rows for it, so the real client kinds are almost free of ambiguity; the dry run prints per kind how many names are unique and how many are shared (counts only).

## How it fits "ask grounded by construction"

Reader PR (next, not in this PR): in the research path, before the Claude hop, run `lookupGameFacts` on the question, pass the top 5 `holds` rows with their ids to the model as a fenced `GAME_FACTS` block, require the answer to cite the ids it uses, and treat `doNotSay` rows as statements the answer must not make. The replay harness's bar (`exact_rate >= 0.90` on the truth kinds) must pass after that PR; this PR alone is expected to change no answer.

## Load procedure (owner's machine)

```
# 1. dry run (the default; sends nothing; counts only)
node tools/facts-load.mjs --tables C:\projects\leeroy-ops\notes\private\truth\db2-1.60.1.70959 --traits C:\projects\leeroy-ops\notes\private\truth\traits.json --facts C:\projects\leeroy-ops\notes\private\truth\facts.jsonl --client-facts C:\projects\leeroy-ops\notes\private\truth\client-facts.jsonl
# 2. with GAME_FACTS_LOAD = "on" deployed and the migration applied
node tools/facts-load.mjs <token-file> --tables ... --traits ... --facts ... --client-facts ... --apply [--base https://api.leeroy.party]
```

- `--tables` is verified against `MANIFEST.json` (sha256, bytes and rows of every table used; a mismatch refuses the run). The five fact kinds from the tables use the same joins and uniqueness rules as `truth-gen.mjs`; the trait kinds use the same eligibility rules as the replay harness's trait kinds (`deriveTraitRows` calls `buildTraitCandidates` from `truth-gen.mjs`, so the two cannot drift). `traits.json` must carry the same build as the manifest.
- Curated rows: `cid` becomes `curated:<cid>`; a free-text build such as "web notes as of 2026-11-19" becomes `2026.11.19`, anything else takes the load's build; an unknown `source_class` becomes `none`; a value over 80 characters moves into the claim (a line that still does not fit is skipped, never cut); `next_step` becomes the note. Skips are counted by reason.
- Base URL: https only (http for localhost, 127.0.0.1 and `[::1]`), no credentials, only `api.leeroy.party` or a local host unless `--allow-host <host>` names it; redirects are refused. The token file is read, used to derive the key and never printed. Dry run needs no token file.
- A curated load replaces ALL curated rows, so the tool needs both `--facts` and `--client-facts` for it (or `--scope client`); curated rows take their subject from the head of the claim, and `source_table`/`row_id` from the file (`facts` and the cid for `facts.jsonl`). The tool declares exactly the kinds it generated: a client run without `--traits` declares only the table kinds and retires no trait fact.
- Order and chunks: the curated load goes first; inside the client load the trait kinds, then the spell kinds, and `item_level_req` LAST (13,673 of the 18,752 client facts, the part that can be spread over days). `--kinds a,b` loads only those kinds (and declares only those, so finish retires only those). `--max-rows-per-run N` (default 60,000, 100 to 90,000) is a budget of D1 ROWS WRITTEN: the tool counts its own writes from the accepted counts with the measured constants (`WRITES_PER_FACT` 2 per fact, 1 more per rank-suffixed name, 3 per call, 1 per retired row) and stops cleanly before a batch that would pass the budget. The load stays open and the published facts stay visible; run the same command after 00:00 UTC (the D1 daily limit resets then) and it resumes.
- Calls: a full run is about 100 calls (`begin`, one `rows` per 200 facts, `finish`, for each load), one second apart. The Worker allows 120 an hour; the tool stops after `--max-calls` (default 100, at most 118) with a message. One state file for the run (`--state`, default the OS temp folder, never inside the repo) records, per plan (the same `--kinds` and inputs), the load id, the batches sent and whether it is finished; it is removed only when every planned scope is finished. Run the same command again to resume: finished scopes are skipped, an unfinished one skips `begin` and continues with the next batch, and a `finish` whose answer was lost is simply repeated (the Worker answers it again).
- Output: counts per kind with unique and shared names, skip reasons, the estimated rows written, the load's build and manifest hash, per-load `added / changed / unchanged / removed`. No row text.

### A new game build

Run the tool with the new export. `begin` refuses a build older than the newest done load. The new load writes its own rows; `finish` diffs against the live facts (added, changed value, removed), retires every older row of the declared kinds in the same transaction, and keeps all old rows. Superseded rows never reach a lookup.

## Privacy

Game data only. No friend names, no asker, no member slug, no message text in any column or response; the loader refuses rows with any key outside the list above. `game_facts` and `game_fact_loads` are in `DATA_MAP` as "no personal data" and are not in the member export or the erase (the owned backup `GET /api/admin/export` does not carry them either: they are derived from files on the owner's PC and reloadable, so `export.js` lists them as never exported; a plain `wrangler d1 export` and Time Travel carry them).

## Rollback

Set `GAME_FACTS_LOAD` back to `"off"`: the route answers 404. Rows are inert (nothing reads them in this PR). To remove the data: `DROP TABLE IF EXISTS game_facts; DROP TABLE IF EXISTS game_fact_loads;` (the indexes go with the table), then `DELETE FROM d1_migrations WHERE name = '0016_game_facts.sql';`, or restore from the Time Travel bookmark the deploy run records before migrations (`wrangler d1 time-travel restore leeroy-board-db --bookmark=<id>`; it rolls back every write since).
