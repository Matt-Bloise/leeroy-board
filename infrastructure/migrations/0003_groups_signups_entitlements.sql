-- Groups, sign-ups, entitlements and Discord event replay guard (Q29). Additive and unused: nothing in the Worker
-- reads or writes these tables yet. Only new tables, indexes and one trigger, all IF NOT EXISTS (no column or constraint changes to existing tables), so it is safe
-- on top of schema.sql (docs/runbooks/schema-source-of-truth.md rule 1). The same statements are mirrored in schema.sql.
-- ON DELETE choices, deliberate:
--   groups, discord_events -> tenants: CASCADE (same as the 0002 operational children: memberships, characters, builds).
--   group_slots, signups_v2: CASCADE from groups; signups_v2 also CASCADEs from users.
--   entitlements -> tenants: SET NULL (tenant_id is nullable). Billing history survives a tenant purge.
--   group_slots/signups_v2 -> characters: SET NULL (deleting a character frees the seat, it does not delete the group's plan).
-- Erase order for a tenant: 1) export what must be kept, 2) DELETE FROM tenants WHERE id = ?, which cascades to
--   groups, group_slots, signups_v2, discord_events, memberships, characters and builds; entitlements rows remain with tenant_id NULL.
-- No Blizzard API data is stored here. Discord ids are 17 to 20 digit snowflakes kept as TEXT.

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
