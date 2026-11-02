-- Identity and tenancy (Q09). Additive and unused: nothing in the Worker reads or writes these tables yet.
-- Only new tables and indexes, all IF NOT EXISTS, so it is safe on top of schema.sql (see
-- docs/runbooks/schema-source-of-truth.md rule 1). The same statements are mirrored in schema.sql.
-- Rules: the Discord user id is the root identity; other providers attach to it and never create it.
-- No Blizzard API data is stored here: characters and builds hold only what a member typed or imported
-- themselves. Discord ids are 17 to 20 digit snowflakes kept as TEXT.

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
  name TEXT NOT NULL CHECK (length(name) > 0),
  realm TEXT NOT NULL CHECK (length(realm) > 0),
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
