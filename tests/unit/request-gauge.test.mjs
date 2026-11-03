// Request gauge (worker/gauge.js, flag REQUEST_GAUGE): counts, batching, UTC day roll-over, failure, two isolates, flag off, admin only, no personal data.
// Real SQLite built from infrastructure/schema.sql, a fake clock, no network, no AI, made-up values. Run: node --test tests/unit/request-gauge.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../../infrastructure/worker/index.js";
import { createGauge, readGauge, handleGauge, gaugeEnabled, utcDay, GAUGE_LIMIT, FLUSH_EVERY, FLUSH_MS } from "../../infrastructure/worker/gauge.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";

const ADMIN = "admin-token-for-tests-0123456789abcdef";
const T0 = Date.parse("2026-11-03T10:00:00Z");
// A ctx that keeps the promises it is given, so a test can wait for the background writes the way the runtime would.
const mkCtx = () => { const p = []; return { waitUntil: (x) => p.push(x), passThroughOnException() {}, done: () => Promise.all(p) }; };
// A D1 wrapper that counts statements, so "no write on the hot path" is a number, not a claim.
function counted(db) {
  const c = { writes: 0, reads: 0 };
  return { c, raw: db.raw, batch: db.batch, prepare(sql) { if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) c.writes++; else c.reads++; return db.prepare(sql); } };
}
const env = (db, extra = {}) => ({ DB: db, BOARD_ADMIN_TOKEN: ADMIN, REQUEST_GAUGE: "on", ALLOWED_ORIGINS: "", ...extra });
const stored = (db) => db.raw.prepare("SELECT day, n FROM request_gauge ORDER BY day").all().map((r) => ({ day: r.day, n: Number(r.n) }));

test("flag: only the exact word on turns it on; default and look-alikes are off", () => {
  for (const v of [undefined, "", "off", "true", "1", "no"]) assert.equal(gaugeEnabled({ REQUEST_GAUGE: v }), false, String(v));
  assert.equal(gaugeEnabled({ REQUEST_GAUGE: "on" }), true);
  assert.equal(gaugeEnabled({ REQUEST_GAUGE: " ON " }), true);
  assert.match(readFileSync(new URL("../../infrastructure/wrangler.toml", import.meta.url), "utf8"), /^REQUEST_GAUGE = "off"/m, "wrangler.toml must ship the flag off");
});

test("flag off: a request does not touch D1 at all and keeps no state", async () => {
  const db = counted(schemaDb()), g = createGauge(), ctx = mkCtx();
  for (let i = 0; i < 100; i++) g.hit(env(db, { REQUEST_GAUGE: "off" }), ctx, T0 + i);
  await ctx.done();
  assert.deepEqual(db.c, { writes: 0, reads: 0 });
  assert.equal(g._state.pending, 0);
});

test("batching: 60 requests are 2 writes, and the gauge still reads exactly 60", async () => {
  const db = counted(schemaDb()), g = createGauge(), ctx = mkCtx(), e = env(db);
  for (let i = 0; i < 60; i++) g.hit(e, ctx, T0 + i);
  await ctx.done();
  assert.equal(db.c.writes, 2, `expected 2 upserts for 60 requests at ${FLUSH_EVERY} per flush`);
  assert.deepEqual(stored(db), [{ day: "2026-11-03", n: 50 }], "10 are still in memory");
  assert.deepEqual(await readGauge(e, T0 + 100, g), { utcDay: "2026-11-03", count: 60, limit: GAUGE_LIMIT, pct: 0.06 });
});

test("a request itself never awaits D1: hit() is synchronous and returns nothing", () => {
  const db = schemaDb(), g = createGauge();
  assert.equal(g.hit(env(db), mkCtx(), T0), undefined);
});

test("time flush: a quiet isolate writes its small delta once FLUSH_MS has passed", async () => {
  const db = counted(schemaDb()), g = createGauge(), ctx = mkCtx(), e = env(db);
  g.hit(e, ctx, T0); g.hit(e, ctx, T0 + 1000);
  assert.equal(db.c.writes, 0);
  g.hit(e, ctx, T0 + FLUSH_MS + 1);
  await ctx.done();
  assert.deepEqual(stored(db), [{ day: "2026-11-03", n: 3 }]);
});

test("UTC day roll-over: yesterday's delta lands on yesterday's row, today starts at 1", async () => {
  const db = schemaDb(), g = createGauge(), ctx = mkCtx(), e = env(db);
  for (let i = 0; i < 7; i++) g.hit(e, ctx, Date.parse("2026-11-03T23:59:59Z"));
  g.hit(e, ctx, Date.parse("2026-11-04T00:00:00Z"));
  await ctx.done();
  assert.deepEqual(stored(db), [{ day: "2026-11-03", n: 7 }]);
  assert.deepEqual(await readGauge(e, Date.parse("2026-11-04T00:00:01Z"), g), { utcDay: "2026-11-04", count: 1, limit: GAUGE_LIMIT, pct: 0 });
  assert.equal(utcDay(Date.parse("2026-11-03T23:59:59.999Z")), "2026-11-03");
  assert.equal(utcDay(Date.parse("2026-11-04T00:00:00.000Z")), "2026-11-04");
});

test("two isolates add up: each flush adds its delta, none overwrites the other", async () => {
  const db = schemaDb(), a = createGauge(), b = createGauge(), ctx = mkCtx(), e = env(db);
  for (let i = 0; i < 50; i++) { a.hit(e, ctx, T0 + i); b.hit(e, ctx, T0 + i); }
  await ctx.done();
  assert.deepEqual(stored(db), [{ day: "2026-11-03", n: 100 }]);
});

test("a failed flush keeps its count for the next one and never throws into the request", async () => {
  const real = schemaDb(); let fail = true;
  const db = { raw: real.raw, batch: real.batch, prepare(sql) { const s = real.prepare(sql); if (fail && /^INSERT INTO request_gauge/.test(sql)) return { bind: () => ({ run: () => Promise.reject(new Error("d1 down")) }) }; return s; } };
  const g = createGauge({ flushEvery: 5 }), ctx = mkCtx(), e = env(db);
  for (let i = 0; i < 5; i++) g.hit(e, ctx, T0 + i);
  await ctx.done();
  assert.deepEqual(stored(real), []);
  assert.equal(g._state.pending, 5, "the 5 are kept");
  fail = false;
  for (let i = 0; i < 5; i++) g.hit(e, ctx, T0 + 10 + i);
  await ctx.done();
  assert.deepEqual(stored(real), [{ day: "2026-11-03", n: 6 }], "the kept 5 and the next request go out together");
  assert.equal((await readGauge(e, T0 + 20, g)).count, 10, "6 stored + 4 still in memory: nothing lost");
});

test("pct is count over 100000 with two decimals, and can pass 100", async () => {
  const db = schemaDb(), e = env(db);
  db.raw.prepare("INSERT INTO request_gauge (day, n) VALUES ('2026-11-03', 15600)").run();
  assert.equal((await readGauge(e, T0, createGauge())).pct, 15.6);
  db.raw.prepare("UPDATE request_gauge SET n = 100424").run();
  const r = await readGauge(e, T0, createGauge());
  assert.deepEqual([r.count, r.pct, r.limit], [100424, 100.42, 100000]);
});

// ---- the route, through the real Worker -------------------------------------------------------------------------------------
const get = (e, headers = {}) => worker.fetch(new Request("https://api.test/api/admin/requests", { headers }), e, mkCtx());
const bearer = { Authorization: `Bearer ${ADMIN}` };

test("GET /api/admin/requests: 401 without the token (flag on or off), 503 without a configured token, 404 for the admin while off", async () => {
  const db = schemaDb();
  for (const flag of ["on", "off"]) {
    assert.equal((await get(env(db, { REQUEST_GAUGE: flag }))).status, 401, `anonymous, flag ${flag}`);
    assert.equal((await get(env(db, { REQUEST_GAUGE: flag }), { Authorization: "Bearer wrong-token-wrong-token-wrong-0000" })).status, 401);
  }
  assert.equal((await get(env(db, { BOARD_ADMIN_TOKEN: undefined }))).status, 503);
  assert.equal((await get(env(db, { REQUEST_GAUGE: "off" }), bearer)).status, 404);
});

test("GET /api/admin/requests: { utcDay, count, limit, pct } and nothing else; counts the Worker's own requests including the ones it refused", async () => {
  const db = schemaDb(), e = env(db);
  const before = await (await get(e, bearer)).json();
  assert.deepEqual(Object.keys(before).sort(), ["count", "limit", "pct", "utcDay"]);
  assert.equal(before.limit, 100000);
  assert.match(before.utcDay, /^\d{4}-\d\d-\d\d$/);
  const ctx = mkCtx();
  for (let i = 0; i < 9; i++) await worker.fetch(new Request("https://api.test/api/probe", { method: "POST" }), e, ctx);
  await worker.fetch(new Request("https://api.test/api/admin/requests"), e, ctx); // a 401 is a Worker request too
  const after = await (await get(e, bearer)).json();
  assert.equal(after.count - before.count, 11, "9 probes + 1 refused + the gauge request itself");
  assert.equal(after.pct, Math.round((after.count / 100000) * 10000) / 100);
});

test("no personal data: only day and n are stored, and no address, key or user id from a request reaches the table", async () => {
  const db = schemaDb(), e = env(db, { REQUEST_GAUGE: "on" });
  assert.deepEqual(db.raw.prepare("PRAGMA table_info(request_gauge)").all().map((c) => c.name), ["day", "n"]);
  const ctx = mkCtx();
  for (let i = 0; i < 30; i++) {
    await worker.fetch(new Request("https://api.test/api/probe", { method: "POST", headers: { "CF-Connecting-IP": "203.0.113.77", "X-Forwarded-For": "198.51.100.5", Authorization: "Board secretkey1234567890123456", "User-Agent": "gauge-test-agent" } }), e, ctx);
  }
  await ctx.done();
  const dump = JSON.stringify(db.raw.prepare("SELECT * FROM request_gauge").all());
  for (const s of ["203.0.113.77", "198.51.100.5", "secretkey", "gauge-test-agent", "probe"]) assert.ok(!dump.includes(s), `table holds ${s}`);
  assert.deepEqual(stored(db).map((r) => Object.keys(r)), stored(db).map(() => ["day", "n"]));
});

test("flag off through the Worker: 30 requests write nothing to request_gauge", async () => {
  const db = schemaDb(), e = env(db, { REQUEST_GAUGE: "off" }), ctx = mkCtx();
  for (let i = 0; i < 30; i++) await worker.fetch(new Request("https://api.test/api/probe", { method: "POST" }), e, ctx);
  await ctx.done();
  assert.deepEqual(stored(db), []);
});

test("schema.sql and migration 0007 define the same table", () => {
  const norm = (t) => /CREATE TABLE IF NOT EXISTS request_gauge \([^;]*\);/.exec(t)[0].replace(/\s+/g, " ");
  const schema = readFileSync(new URL("../../infrastructure/schema.sql", import.meta.url), "utf8");
  const mig = readFileSync(new URL("../../infrastructure/migrations/0007_request_gauge.sql", import.meta.url), "utf8");
  assert.equal(norm(schema), norm(mig));
});

test("handleGauge reads the clock it is given (UTC day, not local)", async () => {
  const db = schemaDb(), e = env(db);
  db.raw.prepare("INSERT INTO request_gauge (day, n) VALUES ('2026-11-03', 5), ('2026-11-04', 9)").run();
  const res = await handleGauge(new Request("https://api.test/api/admin/requests", { headers: bearer }), e, {}, Date.parse("2026-11-03T23:30:00-05:00"), createGauge());
  assert.equal((await res.json()).count, 9, "23:30 at UTC-5 is already 2026-11-04 in UTC");
});
