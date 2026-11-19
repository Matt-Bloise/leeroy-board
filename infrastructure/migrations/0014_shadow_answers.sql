-- shadow_answers: the SHADOW_ASK recorder (flag SHADOW_ASK, POST /api/shadow/ask; docs/runbooks/shadow-ask.md). Additive and idempotent: one new table, IF NOT EXISTS, no change to any existing table. Mirrored in schema.sql.
-- One row per signed shadow compare: a mirrored question run through the real /ask research compose path, and what it would have answered. It is private storage: no route reads it back (the signed caller gets the answer in the
-- response of the call itself), nothing posts it, and it is never a turn the board or a poll can see (it is not in ask_turns).
--   asker_slug    a roster slug named in the call, or NULL. It is the only link to a person: an erase of that member deletes the rows by it (data-rights.js).
--   model         the model column exactly as an ask_turns row would carry it (provider:model, +research, [reason], +degraded).
--   status        answered | degraded | error | refused.   reason: a fixed short code (claude:timeout@compose-16s, claude:cap, ask:error, ...) or NULL.
--   local_answer  the local bot's answer to the same question, when the caller supplied one, for the comparison.   meta: JSON, counts and flags only, never text.
-- Rollback: nothing else reads it; DROP TABLE IF EXISTS shadow_answers;
CREATE TABLE IF NOT EXISTS shadow_answers (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  asker_slug TEXT,
  question TEXT NOT NULL,
  answer TEXT,
  model TEXT,
  latency_ms INTEGER,
  status TEXT NOT NULL,
  reason TEXT,
  local_answer TEXT,
  meta TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_shadow_answers_created ON shadow_answers(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shadow_answers_asker ON shadow_answers(asker_slug);
