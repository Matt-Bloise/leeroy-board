-- =============================================================================
-- Dungeons & Drinking Living Board — Cloudflare D1 Schema (SQLite)
-- =============================================================================

-- 1. Core Board JSON documents (party, timeline, stats, signups, tonight, launch, decide, marks, links)
CREATE TABLE IF NOT EXISTS kv_state (
  key TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 2. Library pages (59 pages across 11 categories, ~1,134 facts)
CREATE TABLE IF NOT EXISTS lib_pages (
  id TEXT PRIMARY KEY,             -- e.g. 'classes/paladin-holy'
  category TEXT NOT NULL,          -- e.g. 'classes'
  title TEXT NOT NULL,
  confidence TEXT NOT NULL DEFAULT 'confirmed',
  status TEXT NOT NULL DEFAULT 'current',
  as_of TEXT,
  checked TEXT,
  recheck_days INTEGER DEFAULT 7,
  blurb TEXT,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  facts_json TEXT NOT NULL DEFAULT '[]',
  open_json TEXT NOT NULL DEFAULT '[]',
  related_json TEXT NOT NULL DEFAULT '[]',
  history_json TEXT NOT NULL DEFAULT '[]',
  snapshots_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lib_pages_cat ON lib_pages(category);

-- 3. Pre-serialized Library JSON blobs for 1-row Edge Cache reads
-- Keys: 'index.json', 'classes.json', ..., 'refresh.json', 'news.json', 'open.json', 'search.json', 'tooltips.json', 'glossary.json', 'diff.json'
CREATE TABLE IF NOT EXISTS lib_blobs (
  name TEXT PRIMARY KEY,
  stamp TEXT NOT NULL,
  json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 4. External source URLs monitored by the 15-minute Cloudflare Cron Trigger
CREATE TABLE IF NOT EXISTS lib_sources (
  id TEXT PRIMARY KEY,             -- e.g. 'S14'
  url TEXT NOT NULL,
  host TEXT NOT NULL,
  label TEXT NOT NULL,
  tier INTEGER NOT NULL DEFAULT 2,
  etag TEXT,
  last_modified TEXT,
  sha8 TEXT,
  checked_at TEXT,
  status TEXT NOT NULL DEFAULT 'ok',
  changed_count INTEGER NOT NULL DEFAULT 0
);

-- 5. Leeroy AI Q&A history (powered directly by Claude API in Worker)
CREATE TABLE IF NOT EXISTS ask_turns (
  id TEXT PRIMARY KEY,
  by_name TEXT NOT NULL,
  question TEXT NOT NULL,
  answer TEXT,
  cites_json TEXT NOT NULL DEFAULT '[]',
  model TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  latency_ms INTEGER,
  created_at TEXT NOT NULL,
  answered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_ask_turns_created ON ask_turns(created_at DESC);

-- 6. Audit log of inline fact fixes & automated cron diffs
CREATE TABLE IF NOT EXISTS fact_fixes (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL,
  fact_key TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT NOT NULL,
  note TEXT,
  by_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
