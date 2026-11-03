-- Who asked, as a salted one-way hash, kept beside ask_turns so an erase or export can find a member's questions without matching on a
-- display name (a Discord nickname can equal another person's name). Additive and idempotent: one new table and index, IF NOT EXISTS,
-- no change to any existing table. It is a table and not a column on ask_turns because ALTER TABLE ADD COLUMN is not idempotent and
-- schema.sql is re-run before migrations on every fresh database (docs/runbooks/schema-source-of-truth.md). Mirrored in schema.sql.
-- Rows are written by the Worker on every new ask that has an identifiable asker (Discord id, or member slug for a board key); a guest on the web has none.
-- asker_hash = sha256(USER_SALT:answer-ux:<discord id>) or sha256(USER_SALT:answer-ux:slug:<slug>). Older ask_turns rows have no row here.
-- Rollback: nothing reads the table when it is empty. If it must go: DROP TABLE IF EXISTS ask_turn_askers;
CREATE TABLE IF NOT EXISTS ask_turn_askers (
  intent_id TEXT PRIMARY KEY CHECK (length(intent_id) > 0),
  asker_hash TEXT NOT NULL CHECK (length(asker_hash) = 64)
);
CREATE INDEX IF NOT EXISTS idx_ask_turn_askers_hash ON ask_turn_askers(asker_hash);
