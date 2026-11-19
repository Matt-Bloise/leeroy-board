-- The dead-man check (flag DEADMAN; docs/runbooks/deadman.md). Additive and idempotent: one new table and two indexes, no change to any existing table. Mirrored in schema.sql.
--   incidents  one row per silence of an expected PC-side source ('pc-bot', 'pc-session'): opened by the one-minute cron when no signed heartbeat has arrived for DEADMAN_STALE_SECONDS,
--              closed (closed_at set) by the next heartbeat from that source. detail is a fixed sentence with numbers only: no friend data, no message text.
--   idx_incidents_open  at most ONE open incident per source, enforced by the database, so repeated cron runs cannot stack rows.
-- Nothing reads this table except the signed status route and an owner's D1 console query. It holds no person: it is not in the member export or the erase.
-- Numbered 0015: 0014 (shadow_answers) is on an open branch; this number is taken regardless so the two cannot collide.
-- Rollback: nothing else reads it; DROP TABLE IF EXISTS incidents;
CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  last_seen_at TEXT,
  closed_at TEXT,
  detail TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_incidents_open ON incidents(source) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_incidents_opened ON incidents(opened_at DESC);
