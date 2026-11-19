# Game facts: a D1 store of the Forever client's own numbers, loaded from the PC

The replay harness (`docs/runbooks/replay-harness.md`) measures how often `/ask` states a game fact correctly. Its truth set is built from the Forever client's own data tables, and the honest baseline is that the Worker answers those questions from the model and the static library, with no `game_facts` table behind it. This store is that table. PR 1 of 2 (this one) builds the store, the signed loader, the loader tool and a lookup function. All flags are off and **nothing in the ask path reads the store yet**.

## What is in the repo and what is not

Code, synthetic test fixtures and this document. Nothing from the client's tables, from `traits.json`, or from the curated `facts.jsonl` / `client-facts.jsonl` is in the repository, in a PR body, or in a test: the tests build fictional tables at run time. The tool reads the real files from where they live (outside the repo, `C:\projects\leeroy-ops\notes\private\truth\` on the owner's machine) and sends rows only inside the signed request body. It prints counts, never a row's text. The store itself holds game data only: no friend data, no person, no message text (DATA_MAP: `game_fact_loads` and `game_facts` are "no personal data", not in the member export or the erase).

## Pieces

| piece | file |
|---|---|
| tables, FTS5 index, triggers | `infrastructure/migrations/0016_game_facts.sql`, mirrored in `infrastructure/schema.sql` |
| signed loader route `POST /api/facts/load` | `infrastructure/worker/game-facts.js` |
| key `leeroy-facts-load-v1` | `infrastructure/worker/listener-config.js` (`factsLoadKey`, `factsLoadKeyFor`) |
| lookup (not wired) | `infrastructure/worker/game-facts-lookup.js` (`lookupGameFacts`) |
| PC side | `tools/facts-load.mjs` (imports `buildCandidates` from `tools/replay/truth-gen.mjs`; `tools/replay/common.mjs` verifies the manifest) |
| tests | `tests/unit/game-facts.test.mjs` |

## Tables

- `game_fact_loads`: one row per load run. `kind` is `client` (derived from the DB2 export and `traits.json`) or `curated` (`facts.jsonl`, `client-facts.jsonl`). `status` is `open`, `done` or `failed`. `files_json` is file name to `{sha256, bytes, rows}`; `manifest_sha256` is the hash of `MANIFEST.json`; `counts_json` holds counts only (`expected`, `total`, `added`, `changed`, `unchanged`, `removed`, `prev_load_id`, `prev_build`).
- `game_facts`: one row per fact, upserted by a stable `id` (`spelllevels:<csv row id>`, `trait_max_ranks:<tree>-<node>`, `curated:<cid>`). `kind` is one of `spell_level`, `item_level_req`, `spell_cooldown`, `spell_cast_time`, `spell_mana_cost`, `trait_max_ranks`, `trait_points_required`, `trait_prereq`, `curated`. `claim` is one plain sentence; `value` and `unit` carry the number; `source_table` and `row_id` point at the client row; `verdict` is `holds`, `wrong` or `unverifiable`; `superseded` is 1 once a newer load no longer has the fact. Rows are **never deleted**.
- `game_facts_fts`: FTS5 index over `(subject, claim)`, external content on `game_facts` (`content_rowid = 'rowid'`, tokenizer `porter unicode61`), kept in sync by three triggers (insert, delete, update of subject or claim, each using the FTS5 `'delete'` command with the OLD values). Rows are written with `INSERT ... ON CONFLICT(id) DO UPDATE`, never `INSERT OR REPLACE`: a REPLACE would assign a new rowid and leave the index pointing at the old one. The index is derived and can be rebuilt: `INSERT INTO game_facts_fts(game_facts_fts) VALUES('rebuild')`. Check it with `INSERT INTO game_facts_fts(game_facts_fts) VALUES('integrity-check')`.

### D1 and FTS5 (what the Cloudflare docs say)

- SQL statements page (https://developers.cloudflare.com/d1/sql-api/sql-statements/): D1 supports a subset of SQLite extensions, including the FTS5 module for full-text search (and `fts5vocab`). Read 2026-11-19.
- Import and export page (https://developers.cloudflare.com/d1/best-practices/import-export-data/): "Export is not supported for virtual tables, including databases with virtual tables"; the documented workaround is to drop the virtual tables, export, and recreate them. Read 2026-11-19.

Consequences, handled in this PR:
1. `npx wrangler d1 export` (used in `docs/runbooks/backup-restore.md`) will fail while `game_facts_fts` exists. To make a raw SQL export: `DROP TABLE game_facts_fts;`, export, then re-run migration 0016 (it is idempotent: it recreates the virtual table and the triggers) followed by `INSERT INTO game_facts_fts(game_facts_fts) VALUES('rebuild')`. D1 Time Travel is unaffected. The rows are reloadable from the PC at any time.
2. The owned backup `GET /api/admin/export` and the restore drill must not list the index or its shadow tables (`game_facts_fts_data`, `_idx`, `_docsize`, `_config`). `export.js` and `tools/restore-drill.mjs` now treat the name prefix `game_facts_fts` like a system table. Restoring `game_facts` by plain INSERT re-fires the triggers, so the index comes back by itself; the drill fixtures carry two fact rows to prove it.
3. Not verified against a real D1 database in this PR: triggers inside a migration file and `CREATE VIRTUAL TABLE` through `wrangler d1 migrations apply` (the tests run the same SQL on SQLite 3.51 with FTS5). First apply it to a PR preview database, which CI does for every PR.

## The loader route

`POST /api/facts/load`, flag `GAME_FACTS_LOAD` (a `[vars]` flag, shipped `"off"`; only the exact value `on`, any case, trimmed, opens it). Gate, in order:

1. Flag not `on`, a PR preview, or no usable bot token: 404, nothing read or written.
2. Body over 256 KB: 413.
3. HMAC with the facts-load key, headers `X-Listen-Timestamp` / `X-Listen-Signature`, 120 s window: 401. The key is `HMAC-SHA256(key = bot token, message = "leeroy-facts-load-v1")`, 32 raw bytes. The listener, self-test, shadow, heartbeat and heartbeat-status keys never verify here, and the facts key opens none of their routes.
4. Body shape: `{purpose: "facts-load", op: "begin" | "rows" | "finish", ...}`, exact key sets, and for `rows` every field of every row (below): 400 `invalid_row` for the whole batch if any row is bad. Nothing is recorded for a refused body.
5. Replay and rate: `kv_state` row `facts_load_state` holds the last accepted signed second; a second that is not strictly newer is 409 `replay` (so the tool waits at least one second between calls). 120 accepted calls in a rolling hour; the 121st is 429 with `Retry-After`.

Ops:

- `begin {build, manifest_sha256, files, kind, expected}`: opens a load and returns `load_id`. `expected` (a safety addition: the number of fact rows the load will send) lets `finish` refuse a half load. 409 `conflict` if another load of the same kind is open and younger than 30 minutes; an older open load is marked `failed` first.
- `rows {load_id, rows[<=200]}`: validates every row, then upserts the batch in one D1 batch (all or nothing). A client load carries one build (`build` of every row equals the load's); a curated load accepts rows of their own builds. A repeated batch is idempotent and is not counted twice.
- `finish {load_id}`: refuses (409 `incomplete`, load stays open) unless the rows owned by this load equal `expected`. Otherwise it supersedes every row of the same load kind that this load did not re-see (client: every non-curated row; curated: every curated row), computes the diff against the previous done load of that kind, stores it in `counts_json`, marks the load `done`.

Row fields (strict; any other key, any non-string text, any control, format or line-separator character refuses the batch): `id` `^[a-z_]+:[A-Za-z0-9_.-]{1,40}$` (`curated:` prefix exactly for kind `curated`), `kind` (fixed list), `subject` 1 to 120 characters (0 for curated), `claim` 1 to 400, `value` up to 80, `unit` (`""`, `level`, `seconds`, `mana`, `ranks`, `points`), `source_table` `^[a-z0-9_]{0,40}$`, `row_id` `^[A-Za-z0-9_.:-]{0,40}$`, `build` `^[0-9.]{3,32}$`, `verdict` (`holds`, `wrong`, `unverifiable`), `source_class` (`client-db2`, `client-addon-data`, `client-data-site`, `blizzard`, `tavern-or-forever-guide`, `wiki`, `third-party-named`, `none`), `note` up to 300. `subject_norm` is computed by the Worker (lowercase, diacritics and punctuation folded).

Responses carry fixed fields only: `ok`, `load_id`, `accepted`, `total`, `counts` (numbers), `reason` (a class such as `invalid_row`, `replay`, `rate_limited`, `conflict`, `incomplete`, `load_closed`, `no_load`, `unavailable`). No row text and no database error text leave the Worker.

### Visibility

A fact counts only while the load it came from is `done` and `superseded = 0`. Rows are upserted in place, so while a re-load is **open** the rows it has already touched are not served from the old load either (their `load_id` now points at the open load): they simply drop out of lookups until the load finishes. A failed load leaves the rows it touched hidden until the next successful load re-sends them. That fails toward "no fact" and never toward a wrong or half-loaded one; the whole load takes about two minutes. The old value of a touched row is not kept, so a failed load is repaired by loading again, not by rolling back.

## The lookup (not wired in this PR)

`lookupGameFacts(env, question, { limit = 5 })` in `game-facts-lookup.js` returns `{ rows, doNotSay, via }`. Rows have exactly `id, claim, value, source_table, row_id, build`.

- The question is never put into SQL. Tokens are cut out of it (letters and digits only, lowercased, diacritics folded, at most 12), FTS5 operator words (`and`, `or`, `not`, `near`) and stop words are dropped, each token is double-quoted and the whole MATCH text is a bound parameter. Quotes, `*`, `^`, `NEAR(...)`, `col:` filters, parentheses and `-` or `+` can therefore only become plain words.
- Words that name the kind of fact (`level`, `cooldown`, `cast`, `mana`, `ranks`, ...) narrow the match when a name token is present (`(name tokens) AND (kind tokens)`); if that finds no `holds` row the name tokens alone are used.
- Joined to `game_fact_loads` with `status = 'done'`, `superseded = 0`; `holds` rows are returned, `wrong` rows come back separately as `doNotSay`, `unverifiable` rows are not returned. Per (kind, subject) the newest build wins (dotted numeric compare); order is the FTS rank (`bm25`, subject weighted 4:1).
- If the FTS5 query throws (no FTS5, no index) the same tokens run as a `LIKE` query over `subject_norm` and `claim` (`via: "like"`); on any further database error the answer is empty. It never throws.

## How it fits "ask grounded by construction"

Reader PR (next, not in this PR): in the research path, before the Claude hop, run `lookupGameFacts` on the question, pass the top 5 `holds` rows with their ids to the model as a fenced `GAME_FACTS` block, require the answer to cite the ids it uses, and treat `doNotSay` rows as statements the answer must not make. The replay harness's bar (`exact_rate >= 0.90` on the truth kinds) must pass after that PR; this PR alone is expected to change no answer.

## Load procedure (owner's machine)

```
# 1. dry run (the default; sends nothing; counts only)
node tools/facts-load.mjs --tables C:\projects\leeroy-ops\notes\private\truth\db2-1.60.1.70959 --traits C:\projects\leeroy-ops\notes\private\truth\traits.json --facts C:\projects\leeroy-ops\notes\private\truth\facts.jsonl --client-facts C:\projects\leeroy-ops\notes\private\truth\client-facts.jsonl
# 2. with GAME_FACTS_LOAD = "on" deployed and the migration applied
node tools/facts-load.mjs <token-file> --tables ... --traits ... --facts ... --client-facts ... --apply [--base https://api.leeroy.party]
```

- `--tables` is verified against `MANIFEST.json` (sha256, bytes and rows of every table used; a mismatch refuses the run). The five fact kinds from the tables use the same joins and uniqueness rules as `truth-gen.mjs`; the trait kinds use the same eligibility rules as the replay harness's trait kinds (`deriveTraitRows`; once the harness's trait PR is merged the two should share one function). `traits.json` must carry the same build as the manifest.
- Curated rows: `cid` becomes `curated:<cid>`; a free-text build such as "web notes as of 2026-11-19" becomes `2026.11.19`, anything else takes the load's build; an unknown `source_class` becomes `none`; a value over 80 characters moves into the claim (a line that still does not fit is skipped, never cut); `next_step` becomes the note. Skips are counted by reason.
- Base URL: https only (http for localhost, 127.0.0.1 and `[::1]`), no credentials, only `api.leeroy.party` or a local host unless `--allow-host <host>` names it; redirects are refused. The token file is read, used to derive the key and never printed. Dry run needs no token file.
- A full run is about 100 calls (`begin`, one `rows` per 200 facts, `finish`, for each of the two loads), one second apart. The Worker allows 120 an hour; the tool stops after `--max-calls` (default 100, at most 118) with a message. State (`load_id` and batches sent) is kept outside the repo (`--state`, default the OS temp folder). Run the same command again to resume: it skips `begin` and continues with the next batch.
- Output: counts per kind, skip reasons, the load's build and manifest hash, per-load `added / changed / unchanged / removed`. No row text.

### A new game build

Run the tool with the new export. It opens a new load with the new build; `finish` diffs against the previous done load (added, changed value, removed), marks every fact the new load did not re-send as `superseded = 1`, and keeps all old rows. Superseded rows never reach a lookup.

## Privacy

Game data only. No friend names, no asker, no member slug, no message text in any column or response; the loader refuses rows with any key outside the list above. `game_facts` and `game_fact_loads` are in `DATA_MAP` as "no personal data" and are not in the member export or the erase (the admin backup carries them; the FTS index is not exported).

## Rollback

Set `GAME_FACTS_LOAD` back to `"off"`: the route answers 404. Rows are inert (nothing reads them in this PR). To remove the data: `DROP TABLE IF EXISTS game_facts_fts; DROP TABLE IF EXISTS game_facts; DROP TABLE IF EXISTS game_fact_loads;`.
