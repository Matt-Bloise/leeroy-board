-- The listener (flag LISTENER, only with ASK_RESEARCH on; docs/runbooks/listener.md). Additive and idempotent: two new tables, IF NOT EXISTS, no change to any existing table. Mirrored in schema.sql.
--   listen_events  one row per forwarded Discord message from a roster member, keyed by the message id (a repeated delivery is a no-op). It holds no message text and no author:
--                  channel, kind, the decision taken, and ask_id, the id of the ask_turns row that holds the question and Leeroy's answer (a PRIVATE turn in a dry run, so what he
--                  would have said is read from ask_turns, where the asker's own export and erase already reach it).
--   listen_quiet   channels where a friend ran /quiet on (a channel id and a time, no person): Leeroy neither reads nor comments there (he still answers when tagged or replied to).
-- Rollback: nothing else reads these tables; DROP TABLE IF EXISTS listen_events; DROP TABLE IF EXISTS listen_quiet;
CREATE TABLE IF NOT EXISTS listen_events (
  msg_id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  channel TEXT NOT NULL,
  kind TEXT NOT NULL,
  decision TEXT NOT NULL,
  ask_id TEXT,
  posted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_listen_events_at ON listen_events(at);
CREATE TABLE IF NOT EXISTS listen_quiet (
  channel TEXT PRIMARY KEY,
  at TEXT NOT NULL
);
