-- 0002 accounts: the same statements as the end of schema.sql. Idempotent; run on an existing database:
--   npx wrangler@4.150.0 d1 execute leeroy-board-api-pilot --remote --file=migrations/0002_accounts.sql

-- Login and per-user persistence (src/account.js). The Discord id is never stored: user_key is a salted sha256 of it. The
-- session token is never stored: token_hash is a sha256 of it. No Discord token, email or name has a column.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
  user_key TEXT NOT NULL CHECK (length(user_key) = 64),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_key);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- One row per person and document (journey, prefs, walked, seen, signups-choice), at most 16 KB each, etag = first 16 hex of sha256(json).
CREATE TABLE IF NOT EXISTS user_state (
  user_key TEXT NOT NULL CHECK (length(user_key) = 64),
  doc TEXT NOT NULL CHECK (doc IN ('journey', 'prefs', 'walked', 'seen', 'signups-choice')),
  etag TEXT NOT NULL,
  json TEXT NOT NULL CHECK (length(json) <= 16384),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_key, doc)
);
