-- Answer detail text for the "More" and "Sources" buttons, and the Helpful/Off feedback votes. Additive: two new tables and
-- indexes, all IF NOT EXISTS, no change to existing tables. Mirrored in schema.sql. Nothing reads or writes them unless ANSWER_UX=on.
-- Personal data: asker_hash and user_hash are salted SHA-256 hashes (USER_SALT), never Discord ids. asker_hash is set only for
-- private (ephemeral) answers so that only the asker can open their detail. The text in `more` and `sources` is model output
-- and may echo the question.
-- Retention (the existing 6-hourly cron deletes): answer_details 30 days, answer_feedback 90 days.
-- Rollback: set ANSWER_UX off (the Worker stops reading and writing both tables). To remove them entirely:
--   DROP TABLE IF EXISTS answer_feedback; DROP TABLE IF EXISTS answer_details;
-- (nothing else references them). D1 Time Travel also covers a bad write.

-- 40. Extra text split off an answer. One row per answer (intent_id is the ask_turns id).
CREATE TABLE IF NOT EXISTS answer_details (
  intent_id TEXT PRIMARY KEY CHECK (length(intent_id) > 0),
  more TEXT,
  sources TEXT,
  asker_hash TEXT,
  message_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_answer_details_created ON answer_details(created_at);

-- 41. One Helpful/Off vote per user per answer. vote is 1 (Helpful) or -1 (Off); a second click replaces it.
CREATE TABLE IF NOT EXISTS answer_feedback (
  intent_id TEXT NOT NULL CHECK (length(intent_id) > 0),
  user_hash TEXT NOT NULL CHECK (length(user_hash) > 0),
  vote INTEGER NOT NULL CHECK (vote IN (-1, 1)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (intent_id, user_hash)
);
CREATE INDEX IF NOT EXISTS idx_answer_feedback_created ON answer_feedback(created_at);
