-- =============================================================================
-- Dungeons & Drinking Living Board — Cloudflare D1 Schema (SQLite)
-- Complete Unified Baseline Schema (Full parity with wow-mage)
-- Contains: kv_state, lib_pages, lib_blobs, lib_sources, lib_source_snapshots,
--           wiki_proposals, ask_turns, fact_fixes, sheet_events, dispatches,
--           members, accounts, account_keys, sessions, user_state, intents
-- =============================================================================

-- 1. Core Board JSON documents (party, timeline, stats, signups, tonight, launch, decide, marks, links, vocab, party_sheets)
CREATE TABLE IF NOT EXISTS kv_state (
  key TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 2. Library pages (67 indexed pages across 19 categories, facts + optional markdown body)
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
CREATE INDEX IF NOT EXISTS idx_lib_sources_checked ON lib_sources(checked_at ASC);

-- 5. Clean extracted text snapshots of monitored wiki sources
CREATE TABLE IF NOT EXISTS lib_source_snapshots (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  url TEXT NOT NULL,
  sha8 TEXT NOT NULL,
  body_text TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_source_snapshots_src ON lib_source_snapshots(source_id, fetched_at DESC);

-- 6. Automated AI-extracted wiki fact proposals & applied edits
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
  share INTEGER NOT NULL DEFAULT 1,
  latency_ms INTEGER,
  created_at TEXT NOT NULL,
  answered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_ask_turns_created ON ask_turns(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ask_turns_by ON ask_turns(by_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ask_turns_share_created ON ask_turns(share, created_at DESC);

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
CREATE INDEX IF NOT EXISTS idx_fact_fixes_page ON fact_fixes(page_id);
CREATE INDEX IF NOT EXISTS idx_fact_fixes_created ON fact_fixes(created_at DESC);

-- 9. Event-sourced Party Character Sheet log
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
CREATE INDEX IF NOT EXISTS idx_sheet_events_slug_vis ON sheet_events(slug, visible, id DESC);

-- 10. Dispatched Q&A letters ("Bring this to the party" in Leeroy Chamber)
CREATE TABLE IF NOT EXISTS dispatches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  ask_ids_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 11. Members: a slug and the salted sha256 hash of that member's key (no plain keys stored)
CREATE TABLE IF NOT EXISTS members (
  slug TEXT PRIMARY KEY CHECK (slug GLOB '[a-z0-9]*' AND length(slug) BETWEEN 1 AND 32),
  key_hash TEXT NOT NULL UNIQUE CHECK (length(key_hash) = 64),
  created_at TEXT NOT NULL
);

-- 12. Multi-token Account Management
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS account_keys (
  key_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  label TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_account_keys_account ON account_keys(account_id);

-- 13. Discord OAuth2 session store for cross-device user state (sessions & user_state)
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
  user_key TEXT NOT NULL CHECK (length(user_key) = 64),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_key);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- 14. Per-user saved settings documents (journey, prefs, walked, seen, signups-choice)
CREATE TABLE IF NOT EXISTS user_state (
  user_key TEXT NOT NULL CHECK (length(user_key) = 64),
  doc TEXT NOT NULL CHECK (doc IN ('journey', 'prefs', 'walked', 'seen', 'signups-choice')),
  etag TEXT NOT NULL,
  json TEXT NOT NULL CHECK (length(json) <= 16384),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_key, doc)
);

-- 15. Shared Brain Intents Mailbox: Queued board-side changes waiting for the bot or external consumers
CREATE TABLE IF NOT EXISTS intents (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  slug TEXT NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  ver INTEGER
);
CREATE INDEX IF NOT EXISTS idx_intents_slug ON intents(slug);
CREATE INDEX IF NOT EXISTS idx_intents_kind ON intents(kind);

-- 16. Rate limit tracking for public guest questions (2 questions per hour per IP)
CREATE TABLE IF NOT EXISTS guest_rate_limits (
  ip_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_guest_rate_limits_ip_time ON guest_rate_limits(ip_hash, created_at DESC);
