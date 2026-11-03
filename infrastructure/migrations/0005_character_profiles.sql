-- Character switcher (flag CHARS_V1, client flag chars.v1). Additive: one new table and one index, IF NOT EXISTS, no change to
-- existing tables (so no ALTER TABLE ADD COLUMN, which is not idempotent: see docs/runbooks/schema-source-of-truth.md). Mirrored in schema.sql.
-- Why a side table: the client's character has race, faction, ruleset and a region label ("Americas", "ANZ", ...) that the 0002
-- `characters` table has no column for. The owner row stays in `characters`; this table holds the rest, one row per character.
-- `selected` is 1 for at most one character per user (the Worker clears the others in the same batch).
-- Personal data: only what the member typed. No Discord id here: it is reached through characters.discord_user_id, so the
-- existing erase (DELETE FROM users, cascade) removes these rows too. Nothing reads or writes the table unless CHARS_V1 is on.
-- Rollback: set CHARS_V1 off. To remove the table: DROP TABLE IF EXISTS character_profiles;
CREATE TABLE IF NOT EXISTS character_profiles (
  character_id TEXT PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
  race TEXT,
  faction TEXT CHECK (faction IS NULL OR faction IN ('Alliance', 'Horde')),
  ruleset TEXT,
  region_label TEXT CHECK (region_label IS NULL OR region_label IN ('Americas', 'EU', 'KR', 'TW', 'ANZ')),
  selected INTEGER NOT NULL DEFAULT 0 CHECK (selected IN (0, 1))
);
CREATE INDEX IF NOT EXISTS idx_character_profiles_selected ON character_profiles(selected);
