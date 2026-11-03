// Health D1 outcomes through the real Worker module, in process (no network, no AI, no keys).
// The live-Worker check (db "ok") is in api.test.mjs; a failing D1 cannot be provoked on a live Worker, so the 503 path is driven here.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../../infrastructure/worker/index.js";

const ctx = { waitUntil() {}, passThroughOnException() {} };
const mk = (first) => ({ prepare: () => { const o = { bind: () => o, first, all: async () => ({ results: [] }), run: async () => ({ meta: {} }) }; return o; } });
const call = (DB) => worker.fetch(new Request("https://api.test/api/health"), { DB, ALLOWED_ORIGINS: "" }, ctx);

test("GET /api/health with a working D1: 200 and db ok", async () => {
  const r = await call(mk(async () => ({ 1: 1 })));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).db, "ok");
});

test("GET /api/health with a failing D1: 503, db error, no detail", async () => {
  const r = await call(mk(async () => { throw new Error("boom: database xyz"); }));
  assert.equal(r.status, 503);
  const text = await r.text();
  assert.equal(JSON.parse(text).db, "error");
  assert.ok(!/boom|xyz/.test(text));
});
