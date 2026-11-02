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

-- =============================================================================
-- Identity and tenancy tables below mirror migrations/0002_identity_tenancy.sql (unused by the Worker so far).
-- =============================================================================

-- 17. Root identity: one row per Discord user.
CREATE TABLE IF NOT EXISTS users (
  discord_user_id TEXT PRIMARY KEY CHECK (length(discord_user_id) BETWEEN 17 AND 20 AND discord_user_id NOT GLOB '*[^0-9]*'),
  display_name TEXT,
  created_at TEXT NOT NULL
);

-- 18. Other providers, attach-only: always hangs off an existing user, never Discord itself.
CREATE TABLE IF NOT EXISTS identities (
  provider TEXT NOT NULL CHECK (provider IN ('battlenet', 'twitch', 'google', 'github')),
  provider_user_id TEXT NOT NULL CHECK (length(provider_user_id) > 0),
  discord_user_id TEXT NOT NULL REFERENCES users(discord_user_id) ON DELETE CASCADE,
  attached_at TEXT NOT NULL,
  PRIMARY KEY (provider, provider_user_id),
  UNIQUE (discord_user_id, provider)
);
CREATE INDEX IF NOT EXISTS idx_identities_user ON identities(discord_user_id);

-- 19. A human: one real person who may own several Discord accounts.
CREATE TABLE IF NOT EXISTS humans (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  created_at TEXT NOT NULL
);

-- 20. Which Discord users belong to which human. A user belongs to at most one human.
CREATE TABLE IF NOT EXISTS human_members (
  human_id TEXT NOT NULL REFERENCES humans(id) ON DELETE CASCADE,
  discord_user_id TEXT NOT NULL UNIQUE REFERENCES users(discord_user_id) ON DELETE CASCADE,
  added_at TEXT NOT NULL,
  PRIMARY KEY (human_id, discord_user_id)
);

-- 21. Web sessions (the existing sessions table is untouched). Only the SHA-256 hex of the cookie value is stored.
CREATE TABLE IF NOT EXISTS sessions_v2 (
  token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  discord_user_id TEXT NOT NULL REFERENCES users(discord_user_id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT,
  CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS idx_sessions_v2_user ON sessions_v2(discord_user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_v2_expiry ON sessions_v2(expires_at);

-- 22. OAuth tokens, encrypted by the Worker before insert (ciphertext only, never plaintext).
CREATE TABLE IF NOT EXISTS provider_tokens (
  discord_user_id TEXT NOT NULL REFERENCES users(discord_user_id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('discord', 'battlenet', 'twitch', 'google', 'github')),
  access_token_enc TEXT NOT NULL CHECK (length(access_token_enc) > 0),
  refresh_token_enc TEXT,
  scope TEXT,
  expires_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (discord_user_id, provider)
);

-- 23. A tenant is one Discord guild running the board.
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  discord_guild_id TEXT NOT NULL UNIQUE CHECK (length(discord_guild_id) BETWEEN 17 AND 20 AND discord_guild_id NOT GLOB '*[^0-9]*'),
  name TEXT NOT NULL CHECK (length(name) > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active', 'suspended')),
  created_at TEXT NOT NULL
);

-- 24. Per-tenant settings as JSON values.
CREATE TABLE IF NOT EXISTS tenant_config (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key TEXT NOT NULL CHECK (length(key) > 0),
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, key)
);

-- 25. Who belongs to which tenant, and with what role.
CREATE TABLE IF NOT EXISTS memberships (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  discord_user_id TEXT NOT NULL REFERENCES users(discord_user_id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member', 'guest')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('invited', 'active', 'removed')),
  joined_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, discord_user_id)
);
CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(discord_user_id);

-- 26. Characters a member entered by hand. No Blizzard API data: name, realm, region, class and spec as typed.
CREATE TABLE IF NOT EXISTS characters (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  discord_user_id TEXT NOT NULL REFERENCES users(discord_user_id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE CHECK (length(name) > 0),
  realm TEXT NOT NULL COLLATE NOCASE CHECK (length(realm) > 0),
  region TEXT NOT NULL CHECK (region IN ('us', 'eu', 'kr', 'tw', 'cn')),
  class TEXT,
  spec TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, region, realm, name)
);
CREATE INDEX IF NOT EXISTS idx_characters_owner ON characters(tenant_id, discord_user_id);

-- 27. Builds for a character. A confirmed build carries a confirmation time; a draft does not.
CREATE TABLE IF NOT EXISTS builds (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('modal', 'import', 'web')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed')),
  title TEXT,
  data_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data_json)),
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  CHECK ((status = 'confirmed') = (confirmed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_builds_character ON builds(character_id, status);

-- 28. Last message seen per Discord thread, so a reader can resume.
CREATE TABLE IF NOT EXISTS thread_cursors (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL CHECK (length(thread_id) BETWEEN 17 AND 20 AND thread_id NOT GLOB '*[^0-9]*'),
  last_message_id TEXT CHECK (last_message_id IS NULL OR (length(last_message_id) BETWEEN 17 AND 20 AND last_message_id NOT GLOB '*[^0-9]*')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, thread_id)
);

-- 29. Append-only record of who did what. Actor and tenant may be empty for system events.
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT REFERENCES tenants(id) ON DELETE SET NULL,
  actor_discord_user_id TEXT REFERENCES users(discord_user_id) ON DELETE SET NULL,
  action TEXT NOT NULL CHECK (length(action) > 0),
  target TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail_json)),
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_log_tenant_at ON audit_log(tenant_id, at DESC);

-- 30. A planned group: a raid, a dungeon run or a social gathering. Size is 1 to 40.
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) > 0),
  kind TEXT NOT NULL CHECK (kind IN ('raid', 'dungeon', 'social')),
  size INTEGER NOT NULL CHECK (size BETWEEN 1 AND 40),
  ruleset TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_groups_tenant ON groups(tenant_id, created_at);

-- 31. Seats in a group. A seat marked open holds no character; slot_index must be below the group's size (enforced by the Worker, not SQL).
-- The CHECK is one-way on purpose: a two-way CHECK ((status = 'open') = (character_id IS NULL)) was tested and blocks the ON DELETE SET NULL
-- cascade on character_id (SQLite checks the CHECK before any trigger can run), so deleting a character would fail. The trigger below
-- re-opens a seat whenever character_id is set to NULL by an UPDATE or by that cascade. Filled/bench with NULL can only come from a raw INSERT (Worker must not).
CREATE TABLE IF NOT EXISTS group_slots (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  slot_index INTEGER NOT NULL CHECK (slot_index BETWEEN 0 AND 39),
  role TEXT NOT NULL CHECK (role IN ('tank', 'healer', 'dps', 'flex')),
  character_id TEXT REFERENCES characters(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('filled', 'open', 'bench')),
  PRIMARY KEY (group_id, slot_index),
  CHECK (status <> 'open' OR character_id IS NULL)
);
CREATE INDEX IF NOT EXISTS idx_group_slots_character ON group_slots(character_id);
CREATE TRIGGER IF NOT EXISTS trg_group_slots_free AFTER UPDATE OF character_id ON group_slots
WHEN NEW.character_id IS NULL AND NEW.status <> 'open'
BEGIN
  UPDATE group_slots SET status = 'open' WHERE group_id = NEW.group_id AND slot_index = NEW.slot_index;
END;

-- 32. RSVP per user per group (the existing signups table is untouched).
CREATE TABLE IF NOT EXISTS signups_v2 (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(discord_user_id) ON DELETE CASCADE,
  character_id TEXT REFERENCES characters(id) ON DELETE SET NULL,
  rsvp TEXT NOT NULL CHECK (rsvp IN ('yes', 'no', 'maybe')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_signups_v2_user ON signups_v2(user_id);

-- 33. What a tenant has paid or been granted. One row per grant period; history is kept, also after the tenant is purged
-- (tenant_id becomes NULL). Processor rows carry the processor's event id (unique, so a replayed webhook cannot double-insert); manual rows leave it NULL.
CREATE TABLE IF NOT EXISTS entitlements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT REFERENCES tenants(id) ON DELETE SET NULL,
  plan TEXT NOT NULL CHECK (length(plan) > 0),
  status TEXT NOT NULL CHECK (status IN ('trialing', 'active', 'past_due', 'canceled')),
  source TEXT NOT NULL CHECK (source IN ('processor', 'manual')),
  processor_event_id TEXT UNIQUE,
  current_period_end TEXT,
  created_at TEXT NOT NULL,
  CHECK (source <> 'processor' OR processor_event_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_entitlements_tenant ON entitlements(tenant_id, created_at);

-- 34. Inbound Discord event ids already handled, so a replayed webhook is detected (PRIMARY KEY on id). Hash only, never the payload.
-- id is a 17 to 20 digit snowflake (same shape check as users.discord_user_id). created_at is indexed for purging old rows.
CREATE TABLE IF NOT EXISTS discord_events (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 17 AND 20 AND id NOT GLOB '*[^0-9]*'),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (length(kind) > 0),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_discord_events_tenant ON discord_events(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_discord_events_created ON discord_events(created_at);

-- Answer buttons (migration 0004): detail text for More/Sources, one Helpful/Off vote per user per answer. Retention 30 and 90 days.
-- 40. Extra text split off an answer. One row per answer (intent_id is the ask_turns id).
CREATE TABLE IF NOT EXISTS answer_details (
  intent_id TEXT PRIMARY KEY CHECK (length(intent_id) > 0),
  more TEXT,
  sources TEXT,
  asker_hash TEXT,
  message_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_answer_details_created ON answer_details(created_at);

-- 41. One Helpful/Off vote per user per answer. vote is 1 (Helpful) or -1 (Off); a second click replaces it.
CREATE TABLE IF NOT EXISTS answer_feedback (
  intent_id TEXT NOT NULL CHECK (length(intent_id) > 0),
  user_hash TEXT NOT NULL CHECK (length(user_hash) > 0),
  vote INTEGER NOT NULL CHECK (vote IN (-1, 1)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (intent_id, user_hash)
);
CREATE INDEX IF NOT EXISTS idx_answer_feedback_created ON answer_feedback(created_at);
