-- Who asked, as salted one-way hashes, kept beside ask_turns so an erase or export can find a member's questions without matching on a
-- display name (a Discord nickname can equal another person's name). Additive and idempotent: new tables and an index, IF NOT EXISTS,
-- no change to any existing table. They are tables and not a column on ask_turns because ALTER TABLE ADD COLUMN is not idempotent and
-- schema.sql is re-run before migrations on every fresh database (docs/runbooks/schema-source-of-truth.md). Mirrored in schema.sql.
--
-- ask_turn_askers: one row per hash. The Worker writes the ask_turns row and these rows in ONE batch (all or nothing). A Discord ask by a
-- roster member carries two hashes (Discord id, member handle) so either credential finds it; a board-key ask carries the handle hash;
-- a Discord ask by someone not on the roster carries the Discord-id hash; a web visitor has none and is stored as "Visitor".
--   asker_hash = sha256(USER_SALT:answer-ux:<discord id>) or sha256(USER_SALT:answer-ux:slug:<slug>)
-- ask_turn_legacy: the ask_turns rows that existed when this migration ran. ONLY these may be matched by name (they cannot have a hash);
-- every later row is found by hash or not at all, so a failed or skipped hash write can never make a new question match a same-name person.
-- Rollback: nothing reads either table when empty. If they must go: DROP TABLE IF EXISTS ask_turn_askers; DROP TABLE IF EXISTS ask_turn_legacy;
CREATE TABLE IF NOT EXISTS ask_turn_askers (
  intent_id TEXT NOT NULL CHECK (length(intent_id) > 0),
  asker_hash TEXT NOT NULL CHECK (length(asker_hash) = 64),
  PRIMARY KEY (intent_id, asker_hash)
);
CREATE INDEX IF NOT EXISTS idx_ask_turn_askers_hash ON ask_turn_askers(asker_hash);
CREATE TABLE IF NOT EXISTS ask_turn_legacy (
  intent_id TEXT PRIMARY KEY CHECK (length(intent_id) > 0)
);
-- d1_migrations runs this file once; the guard keeps a re-run from marking a row that already has a hash.
INSERT OR IGNORE INTO ask_turn_legacy (intent_id) SELECT id FROM ask_turns WHERE id NOT IN (SELECT intent_id FROM ask_turn_askers);
