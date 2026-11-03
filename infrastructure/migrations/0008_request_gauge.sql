-- Request gauge (flag REQUEST_GAUGE, default off): Worker requests per UTC day, written in batches of about 25 (worker/gauge.js). Additive and unused until the flag is on:
-- one new table, IF NOT EXISTS, no change to any existing table. The same statement is mirrored in schema.sql.
-- Counts only: day is the UTC date (YYYY-MM-DD). No IP, no user id, no path.
-- Rollback: set REQUEST_GAUGE off (nothing reads or writes the table then), and if the table must go: DROP TABLE IF EXISTS request_gauge;
CREATE TABLE IF NOT EXISTS request_gauge (
  day TEXT PRIMARY KEY CHECK (length(day) = 10),
  n INTEGER NOT NULL DEFAULT 0 CHECK (n >= 0)
);
