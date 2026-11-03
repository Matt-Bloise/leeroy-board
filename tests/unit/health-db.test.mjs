// /api/health runs one trivial D1 query: db "ok" with 200, or 503 with db "error" and no detail. No network, no real D1, no AI.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../../infrastructure/worker/index.js";

const ctx = { waitUntil() {}, passThroughOnException() {} };
const get = (env, path = "/api/health", headers = {}) => worker.fetch(new Request(`https://api.test${path}`, { headers }), env, ctx);
const dbWith = (first) => ({ prepare: (sql) => { const o = { sql, bind: () => o, first, all: async () => ({ results: [] }), run: async () => ({ meta: {} }) }; return o; } });

test("health: D1 answers SELECT 1 -> 200, ok true, db ok", async () => {
  const seen = [];
  const env = { DB: { prepare: (sql) => { seen.push(sql); return dbWith(async () => ({ 1: 1 })).prepare(sql); } }, ALLOWED_ORIGINS: "" };
  const res = await get(env);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /application\/json/);
  const b = await res.json();
  assert.equal(b.ok, true);
  assert.equal(b.db, "ok");
  assert.equal(b.service, "leeroy-brain");
  assert.ok(seen.includes("SELECT 1"), "the trivial query ran");
});

test("health: D1 throws -> 503, db error, no detail leaked", async () => {
  const env = { DB: dbWith(async () => { throw new Error("D1_ERROR: no such table secret_table at /internal/path"); }), ALLOWED_ORIGINS: "" };
  const silence = console.error; console.error = () => {};
  try {
    for (const path of ["/api/health", "/health", "/"]) {
      const res = await get(env, path);
      assert.equal(res.status, 503, path);
      const text = await res.text();
      const b = JSON.parse(text);
      assert.equal(b.ok, false);
      assert.equal(b.db, "error");
      assert.deepEqual(Object.keys(b).sort(), ["at", "db", "ok", "service"]);
      assert.ok(!/secret_table|internal|D1_ERROR/.test(text), "error detail must not leak");
    }
  } finally { console.error = silence; }
});

test("health: a missing DB binding is also a 503, and the admin token does not unlock detail on failure", async () => {
  const env = { ALLOWED_ORIGINS: "", BOARD_ADMIN_TOKEN: "admin-token-for-tests-0123456789abcdef" };
  const res = await get(env, "/api/health", { Authorization: `Bearer ${env.BOARD_ADMIN_TOKEN}` });
  assert.equal(res.status, 503);
  const b = await res.json();
  assert.equal(b.db, "error");
  assert.ok(!("providers" in b) && !("aiBudget" in b));
});
