-- 0004 ask_turns share column & index
-- Supports private coach questions without leaking to global GET /api/ask

ALTER TABLE ask_turns ADD COLUMN share INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_ask_turns_by ON ask_turns(by_name, created_at DESC);
