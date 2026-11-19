-- game_facts: the grounded game-facts store (flag GAME_FACTS_LOAD, POST /api/facts/load; docs/runbooks/game-facts.md). Additive and idempotent: two tables and two indexes, IF NOT EXISTS; no change to any existing table. Mirrored in schema.sql.
-- Holds GAME data only (what the Forever client's own tables and the curated truth file say: spell levels, cooldowns, trait ranks, ...). No friend data, no person, no message text: it is not in the member export or the erase.
-- NO virtual table and NO trigger: a plain `wrangler d1 export` works (D1 cannot export a database that holds an FTS5 table). Lookups go by normalised name through the index, see worker/game-facts-lookup.js.
--   game_fact_loads  one row per load run from the PC (begin ... finish). status open | done | failed. files_json: file name -> {sha256, bytes, rows}. counts_json: counts only (the kinds declared at begin, then total, added, changed, unchanged, removed). A table of a handful of rows: no index.
--   game_facts       one row per (fact id, load): a load writes its OWN rows and never overwrites another load's, so a load that is open, failed or interrupted leaves every published fact untouched. A row counts for a lookup only while
--                    its load is 'done', superseded = 0 and no newer done load holds the same id. finish (one D1 batch, guarded on the load still being open) supersedes the older rows of the kinds the load declared.
--                    subject_norm is the name folded by worker/game-facts-name.js (case, diacritics, punctuation, apostrophes); subject_base is the same name without a trailing rank or roman-numeral suffix, or '' when there is none.
-- Write cost (D1 Free allows 100,000 rows written per day; an index adds one written row per indexed write): WITHOUT ROWID makes the primary key (id, load_id) the table itself, so a fact costs 1 row for the table plus 1 for idx_game_facts_kind_subject.
--   idx_game_facts_kind_subject  (kind, subject_norm): the lookup's only access path by name (kind IN (...) AND subject_norm IN (...)), and the kind scans of finish.
--   idx_game_facts_kind_base     (kind, subject_base) PARTIAL (only rows that have a base name): the 'Arcane Spirit' question finding 'Arcane Spirit III'; rows without a rank suffix pay nothing for it.
--   No index on load_id or build: finish counts a load with one scan, which costs reads (5,000,000 a day are free), not writes. The id prefix of the primary key serves the per-id checks.
-- Rows are written with INSERT ... ON CONFLICT(id, load_id) DO UPDATE, and only while their load is open.
-- Rollback: nothing else reads these; DROP TABLE IF EXISTS game_facts; DROP TABLE IF EXISTS game_fact_loads;  (the indexes go with the table)
CREATE TABLE IF NOT EXISTS game_fact_loads (
  id TEXT PRIMARY KEY,
  build TEXT,
  manifest_sha256 TEXT,
  files_json TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('client', 'curated')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'failed')),
  counts_json TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS game_facts (
  id TEXT NOT NULL,
  load_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  subject_norm TEXT NOT NULL DEFAULT '',
  subject_base TEXT NOT NULL DEFAULT '',
  claim TEXT NOT NULL,
  value TEXT NOT NULL DEFAULT '',
  unit TEXT NOT NULL DEFAULT '',
  source_table TEXT NOT NULL DEFAULT '',
  row_id TEXT NOT NULL DEFAULT '',
  build TEXT,
  verdict TEXT NOT NULL DEFAULT 'holds' CHECK (verdict IN ('holds', 'wrong', 'unverifiable')),
  source_class TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  superseded INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT,
  PRIMARY KEY (id, load_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_game_facts_kind_subject ON game_facts(kind, subject_norm);
CREATE INDEX IF NOT EXISTS idx_game_facts_kind_base ON game_facts(kind, subject_base) WHERE subject_base <> '';
