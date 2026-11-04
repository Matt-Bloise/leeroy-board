-- One row per ballot, so two people voting at the same moment cannot lose each other's vote. Until now every ballot lived inside one
-- kv_state vote:<id> JSON document that the Worker read, changed and wrote back whole (a lost update when two casts overlapped).
-- Additive and idempotent: a new table, IF NOT EXISTS, no change to any existing table. Mirrored in schema.sql.
--   voter_hash = sha256(USER_SALT:vote:<vote id>:<discord id>) (never the raw id); choice = zero-based index into the vote's choices.
-- A cast is one upsert on (vote_id, voter_hash). Ballots already inside an old vote:<id> document are still read (the table row wins).
-- Rollback: nothing else reads this table; DROP TABLE IF EXISTS vote_ballots; loses only ballots cast after this migration.
CREATE TABLE IF NOT EXISTS vote_ballots (
  vote_id TEXT NOT NULL CHECK (length(vote_id) = 8),
  voter_hash TEXT NOT NULL CHECK (length(voter_hash) = 64),
  choice INTEGER NOT NULL CHECK (choice >= 0 AND choice <= 4),
  cast_at TEXT NOT NULL,
  PRIMARY KEY (vote_id, voter_hash)
);
