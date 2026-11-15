// fixture source: the model anchors on these SQL fragments
const a = "SELECT json FROM kv_state WHERE key = ?";
const b = "SELECT slug FROM ev WHERE slug = ? LIMIT 10";
const c = "INSERT INTO ev (slug) VALUES (?)";
const d = "UPDATE kv_state SET json = ? WHERE key = ?";
const e = "INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES (?, ?, ?)";
