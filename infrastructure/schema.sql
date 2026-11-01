-- =============================================================================
-- Dungeons & Drinking Living Board — Cloudflare D1 Schema (SQLite)
-- Full parity with wow-mage: kv_state, lib_pages, lib_blobs, lib_sources,
-- lib_source_snapshots, wiki_proposals, ask_turns, fact_fixes, sheet_events, dispatches
-- =============================================================================

-- 1. Core Board JSON documents (party, timeline, stats, signups, tonight, launch, decide, marks, links, vocab)
CREATE TABLE IF NOT EXISTS kv_state (
  key TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 2. Library pages (61 pages across 11 categories, ~1,134 facts + optional markdown body)
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

-- 4. External source URLs monitored by the 6-hour Cloudflare Cron Trigger
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

-- 5. Clean extracted text snapshots of monitored wiki sources (replaces wow-mage/wiki/sources/*.txt)
CREATE TABLE IF NOT EXISTS lib_source_snapshots (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  url TEXT NOT NULL,
  sha8 TEXT NOT NULL,
  body_text TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_source_snapshots_src ON lib_source_snapshots(source_id, fetched_at DESC);

-- 6. Automated AI-extracted wiki fact proposals & applied edits (replaces wow-mage/wiki/proposals/ & wiki-learn.mjs)
CREATE TABLE IF NOT EXISTS wiki_proposals (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  fact_key TEXT NOT NULL,
  old_value TEXT,
  proposed_value TEXT NOT NULL,
  confidence TEXT NOT NULL DEFAULT 'confirmed',
  status TEXT NOT NULL DEFAULT 'applied',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wiki_proposals_created ON wiki_proposals(created_at DESC);

-- 7. Leeroy AI Q&A history (Multi-Provider: Claude, Gemini, Workers AI, Groq, Cerebras, GitHub Models, OpenRouter)
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

-- 8. Audit log of inline fact fixes & automated cron diffs
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

-- 9. Event-sourced Party Character Sheet log (replaces wow-mage/cloudflare/worker/src/brain.js sheet_events)
CREATE TABLE IF NOT EXISTS sheet_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  field TEXT NOT NULL,
  value_json TEXT,
  visible INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'board',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sheet_events_slug_field ON sheet_events(slug, field, id DESC);

-- 10. Dispatched Q&A letters ("Bring this to the party" in Leeroy Chamber)
CREATE TABLE IF NOT EXISTS dispatches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  ask_ids_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
