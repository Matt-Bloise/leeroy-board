-- game_facts: the grounded game-facts store (flag GAME_FACTS_LOAD, POST /api/facts/load; docs/runbooks/game-facts.md). Additive and idempotent: tables, indexes, one FTS5 index and its triggers, IF NOT EXISTS; no change to any existing table. Mirrored in schema.sql.
-- Holds GAME data only (what the Forever client's own tables and the curated truth file say: spell levels, cooldowns, trait ranks, ...). No friend data, no person, no message text: it is not in the member export or the erase.
--   game_fact_loads  one row per load run from the PC (begin ... finish). status open | done | failed. files_json: file name -> {sha256, bytes, rows}. counts_json: counts only (added, changed, unchanged, removed, total).
--   game_facts       one row per fact, upserted by a stable id. A row counts for a lookup only while the load it came from is 'done' and superseded = 0. verdict holds | wrong | unverifiable.
--   game_facts_fts   FTS5 index over (subject, claim), external-content on game_facts, kept in sync by the three triggers below. It is derived: it can be rebuilt with
--                    INSERT INTO game_facts_fts(game_facts_fts) VALUES('rebuild'). D1 cannot EXPORT a database that holds a virtual table (see docs/runbooks/game-facts.md and backup-restore.md).
-- Rows are written with INSERT ... ON CONFLICT DO UPDATE, never INSERT OR REPLACE (a REPLACE would give the row a new rowid and leave the FTS index pointing at the old one).
-- Rollback: nothing else reads these; DROP TABLE IF EXISTS game_facts_fts; DROP TABLE IF EXISTS game_facts; DROP TABLE IF EXISTS game_fact_loads;  (the triggers go with game_facts)
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
CREATE INDEX IF NOT EXISTS idx_game_fact_loads_kind ON game_fact_loads(kind, status, started_at DESC);

CREATE TABLE IF NOT EXISTS game_facts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  subject_norm TEXT NOT NULL DEFAULT '',
  claim TEXT NOT NULL,
  value TEXT NOT NULL DEFAULT '',
  unit TEXT NOT NULL DEFAULT '',
  source_table TEXT NOT NULL DEFAULT '',
  row_id TEXT NOT NULL DEFAULT '',
  build TEXT,
  load_id TEXT,
  verdict TEXT NOT NULL DEFAULT 'holds' CHECK (verdict IN ('holds', 'wrong', 'unverifiable')),
  source_class TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  superseded INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_game_facts_kind_subject ON game_facts(kind, subject_norm);
CREATE INDEX IF NOT EXISTS idx_game_facts_build ON game_facts(build);
CREATE INDEX IF NOT EXISTS idx_game_facts_load ON game_facts(load_id);

CREATE VIRTUAL TABLE IF NOT EXISTS game_facts_fts USING fts5(subject, claim, content = 'game_facts', content_rowid = 'rowid', tokenize = 'porter unicode61');
CREATE TRIGGER IF NOT EXISTS game_facts_ai AFTER INSERT ON game_facts BEGIN
  INSERT INTO game_facts_fts(rowid, subject, claim) VALUES (new.rowid, new.subject, new.claim);
END;
CREATE TRIGGER IF NOT EXISTS game_facts_ad AFTER DELETE ON game_facts BEGIN
  INSERT INTO game_facts_fts(game_facts_fts, rowid, subject, claim) VALUES ('delete', old.rowid, old.subject, old.claim);
END;
CREATE TRIGGER IF NOT EXISTS game_facts_au AFTER UPDATE OF subject, claim ON game_facts BEGIN
  INSERT INTO game_facts_fts(game_facts_fts, rowid, subject, claim) VALUES ('delete', old.rowid, old.subject, old.claim);
  INSERT INTO game_facts_fts(rowid, subject, claim) VALUES (new.rowid, new.subject, new.claim);
END;
