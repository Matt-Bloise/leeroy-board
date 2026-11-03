-- Noise ledger for free-standing Discord posts (cards and board lines work, flag CARDS_ENABLED, default off). Additive and unused until the flag is on:
-- one new table, IF NOT EXISTS, no change to any existing table. The same statement is mirrored in schema.sql.
-- Counts only: day is the America/New_York calendar date, channel is a channel id (or a "shadow:..." label while CARDS_SHADOW is on). No message text, no names.
-- Rollback: set CARDS_ENABLED off (nothing reads the table then), and if the table must go: DROP TABLE IF EXISTS noise_ledger;
-- Nothing else depends on it.
CREATE TABLE IF NOT EXISTS noise_ledger (
  day TEXT NOT NULL,
  channel TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0 CHECK (n >= 0),
  PRIMARY KEY (day, channel)
);
