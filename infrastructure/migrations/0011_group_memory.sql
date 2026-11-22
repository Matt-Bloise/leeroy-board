-- Group memory for the research path (flag GROUP_MEMORY, only with ASK_RESEARCH on; docs/runbooks/group-memory.md). Additive and idempotent: two new tables, IF NOT EXISTS,
-- no change to any existing table. Mirrored in schema.sql. Private storage only: no route reads these tables, and the Worker reads them only for a roster member's own prompt.
--   group_log   one row per thing said: a member's ask, Leeroy's answer to it, or (a later listener) an ordinary channel message. author_slug is the member's roster slug.
--               source: 'ask' | 'ask-private' (an ephemeral ask: shown only to its own asker, never summarised) | 'listener'.
--   group_wiki  running notes the refresher writes from NEW group_log rows (one page per person, the group's running bits, topics). rev counts rewrites. note holds 'rebuild:erase'
--               while a page awaits a rewrite after a member's erase.
-- Rollback: nothing else reads these tables; DROP TABLE IF EXISTS group_log; DROP TABLE IF EXISTS group_wiki; loses only what the flag collected.
CREATE TABLE IF NOT EXISTS group_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'web',
  author_slug TEXT NOT NULL CHECK (length(author_slug) > 0),
  kind TEXT NOT NULL CHECK (kind IN ('ask', 'answer', 'message')),
  text TEXT NOT NULL,
  reply_to TEXT,
  source TEXT
);
CREATE INDEX IF NOT EXISTS idx_group_log_channel_at ON group_log(channel, at DESC);
CREATE INDEX IF NOT EXISTS idx_group_log_author ON group_log(author_slug, at);
CREATE TABLE IF NOT EXISTS group_wiki (
  page_key TEXT PRIMARY KEY CHECK (length(page_key) BETWEEN 1 AND 40),
  title TEXT NOT NULL,
  body_md TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 1,
  note TEXT
);
