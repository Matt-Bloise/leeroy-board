-- Fixture schema for tests/unit/cost-model.test.mjs: two tables, the numbers in expected.json are worked out by hand from it.
CREATE TABLE IF NOT EXISTS kv_state (
  key TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ev (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ev_slug ON ev(slug);
CREATE INDEX IF NOT EXISTS idx_ev_slug_id ON ev(slug, id DESC);
