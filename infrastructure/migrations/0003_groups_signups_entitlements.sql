-- Groups, sign-ups, entitlements and Discord event replay guard (Q29). Additive and unused: nothing in the Worker
-- reads or writes these tables yet. Only new tables and indexes, all IF NOT EXISTS, so it is safe on top of schema.sql
-- (docs/runbooks/schema-source-of-truth.md rule 1). The same statements are mirrored in schema.sql.
-- ON DELETE choices, deliberate:
--   group_slots, signups_v2: CASCADE from groups (they have no meaning without the group); signups_v2 also CASCADEs from users.
--   groups, entitlements, discord_events -> tenants: RESTRICT. Deleting a tenant must fail while it still owns groups,
--     billing history or event records, so a tenant is closed (status 'suspended') and purged by an explicit job, never by accident.
--   group_slots/signups_v2 -> characters: SET NULL (deleting a character frees the seat, it does not delete the group's plan).
-- No Blizzard API data is stored here. Discord ids are 17 to 20 digit snowflakes kept as TEXT.

-- 30. A planned group: a raid, a dungeon run or a social gathering. Size is 1 to 40.
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (length(name) > 0),
  kind TEXT NOT NULL CHECK (kind IN ('raid', 'dungeon', 'social')),
  size INTEGER NOT NULL CHECK (size BETWEEN 1 AND 40),
  ruleset TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_groups_tenant ON groups(tenant_id, created_at);

-- 31. Seats in a group. A seat marked open holds no character; slot_index must be below the group's size (enforced by the Worker, not SQL).
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

-- 33. What a tenant has paid or been granted. One row per grant period; history is kept.
CREATE TABLE IF NOT EXISTS entitlements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  plan TEXT NOT NULL CHECK (length(plan) > 0),
  status TEXT NOT NULL CHECK (status IN ('trialing', 'active', 'past_due', 'canceled')),
  source TEXT NOT NULL CHECK (source IN ('processor', 'manual')),
  current_period_end TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entitlements_tenant ON entitlements(tenant_id, created_at);

-- 34. Inbound Discord event ids already handled, so a replayed webhook is detected (PRIMARY KEY on id). Hash only, never the payload.
CREATE TABLE IF NOT EXISTS discord_events (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (length(kind) > 0),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_discord_events_tenant ON discord_events(tenant_id, created_at);
