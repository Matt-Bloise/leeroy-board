// D1 feed (flag D1_FEED): pure builders plus the cached loader, with a stubbed D1. No network, no AI.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SQL, FEED_TTL_MS, buildStats, buildTimeline, buildTonight, serveFeedDoc, feedEnabled, isFeedDoc, cacheKey, resetFeedWarnings,
} from "../../infrastructure/worker/feed.js";
import { isPrivateKvKey } from "../../infrastructure/worker/config.js";
import { isPublicDataDoc } from "../../infrastructure/worker/public-docs.js";

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "data");
const fx = (n) => JSON.parse(fs.readFileSync(path.join(DATA, `${n}.json`), "utf8"));

// Same keys, same types, recursively (arrays compare their first element).
const shape = (v) => (Array.isArray(v) ? [v.length ? shape(v[0]) : null] : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, shape(v[k])])) : v === null ? "null" : typeof v);

const NOW = Date.parse("2026-11-02T12:00:00.000Z");
const turns = (secs) => secs.map((s, i) => ({ latency_ms: s * 1000, answered_at: `2026-11-01T10:${String(i).padStart(2, "0")}:00.000Z` })).reverse(); // newest first
const SECS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 1000]; // 10 answered turns, one slower than 900 s

function stubDb({ base = fx("stats"), cached = null, failOn = null } = {}) {
  const log = [];
  const prepare = (sql) => {
    let args = [];
    const hit = () => {
      log.push({ sql, args });
      if (failOn && sql.includes(failOn)) throw new Error("D1 down");
    };
    const stmt = {
      bind: (...a) => ((args = a), stmt),
      first: async () => {
        hit();
        if (sql === SQL.kv) return args[0] === cacheKey("stats") ? cached : { json: JSON.stringify(base), updated_at: "2026-11-01T22:54:51.000Z" };
        if (sql === SQL.totals) return { replies: 10, noreply: 2, misses: 1, max_ms: 1000000 };
        if (sql === SQL.wiki) return { n: 70 };
        return null;
      },
      all: async () => (hit(), { results: sql === SQL.window ? turns(SECS) : [] }),
      run: async () => (hit(), { success: true }),
    };
    return stmt;
  };
  return { prepare, log };
}

test("stats: keys and types equal the static fixture", () => {
  const out = buildStats(fx("stats"), { totals: { replies: 10, noreply: 2, misses: 1, max_ms: 1000000 }, window: turns(SECS), wikiPages: 70 }, "2026-11-02T12:00:00.000Z");
  assert.deepEqual(shape(out), shape(fx("stats")));
});

test("stats: counts and timings equal the stub rows; static-only fields stay static", () => {
  const base = fx("stats");
  const out = buildStats(base, { totals: { replies: 10, noreply: 2, misses: 1, max_ms: 1000000 }, window: turns(SECS), wikiPages: 70 }, "2026-11-02T12:00:00.000Z");
  assert.equal(out.answers, 12);
  assert.equal(out.replies, 10);
  assert.equal(out.noreply, 2);
  assert.equal(out.misses, 1);
  assert.equal(out.median_s, 50);
  assert.equal(out.p95_s, 1000);
  assert.equal(out.max_s, 1000);
  assert.equal(out.wiki_pages, 70);
  assert.equal(out.last7.length, 7);
  assert.deepEqual(out.last7.map((x) => x.seconds), [40, 50, 60, 70, 80, 90, 1000]); // oldest to newest, like the static doc
  assert.equal(out.miss_threshold_s, base.miss_threshold_s);
  assert.equal(out.wiki_facts, base.wiki_facts);
  assert.equal(out.index_generated, base.index_generated);
  assert.equal(out.generated, "2026-11-02T12:00:00.000Z");
});

test("stats: empty tables give zeros, not NaN", () => {
  const out = buildStats(fx("stats"), { totals: { replies: 0, noreply: 0, misses: 0, max_ms: null }, window: [], wikiPages: 0 }, "x");
  assert.deepEqual([out.answers, out.median_s, out.p95_s, out.max_s, out.last7.length], [0, 0, 0, 0, 0]);
});

test("stats: only static keys are copied, so stored question text never leaks", () => {
  const base = { ...fx("stats"), recent: [{ by: "Someone", q: "SECRET QUESTION", a: "SECRET ANSWER" }], updated: "2026-11-01" };
  const out = buildStats(base, { totals: {}, window: turns(SECS), wikiPages: 1 }, "x");
  assert.deepEqual(Object.keys(out).sort(), Object.keys(fx("stats")).sort());
  const text = JSON.stringify(out);
  assert.ok(!text.includes("SECRET") && !text.includes("Someone"));
});

test("stats: no static document to build on is an error", () => {
  assert.throws(() => buildStats(null, { totals: {}, window: [] }, "x"));
});

test("timeline and tonight: no D1 source, shape and content equal the static fixtures", () => {
  assert.deepEqual(buildTimeline(fx("timeline")), fx("timeline"));
  assert.deepEqual(buildTonight(fx("tonight")), fx("tonight"));
});

test("loader: computes stats, writes the cache row, serves it for 5 minutes, recomputes after", async () => {
  const db = stubDb();
  const first = await serveFeedDoc({ DB: db }, "stats", NOW);
  assert.equal(JSON.parse(first.json).replies, 10);
  const writes = db.log.filter((l) => l.sql === SQL.put);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].args[0], "feed_cache:stats");
  const reads = db.log.length;
  assert.ok(reads <= 7, `bounded D1 calls, saw ${reads}`);

  const cachedDb = stubDb({ cached: { json: first.json, updated_at: first.updated_at } });
  const hit = await serveFeedDoc({ DB: cachedDb }, "stats", NOW + FEED_TTL_MS - 1000);
  assert.equal(hit.json, first.json);
  assert.deepEqual(cachedDb.log.map((l) => l.sql), [SQL.kv]); // one cheap read, nothing recomputed
  const stale = await serveFeedDoc({ DB: cachedDb }, "stats", NOW + FEED_TTL_MS + 1000);
  assert.equal(JSON.parse(stale.json).generated, new Date(NOW + FEED_TTL_MS + 1000).toISOString());
});

test("loader: any error returns null (route serves the stored doc) and logs once", async () => {
  resetFeedWarnings();
  const seen = [];
  const orig = console.error;
  console.error = (...a) => seen.push(a.join(" "));
  try {
    assert.equal(await serveFeedDoc({ DB: stubDb({ failOn: "FROM ask_turns" }) }, "stats", NOW), null);
    assert.equal(await serveFeedDoc({ DB: stubDb({ failOn: "FROM ask_turns" }) }, "stats", NOW), null);
    assert.equal(await serveFeedDoc({ DB: stubDb({ base: null }) }, "stats", NOW), null); // no static row to build on
  } finally {
    console.error = orig;
  }
  assert.equal(seen.length, 1);
});

test("loader: timeline and tonight are never computed or cached", async () => {
  for (const name of ["timeline", "tonight", "party", "launch"]) {
    const db = stubDb();
    assert.equal(await serveFeedDoc({ DB: db }, name, NOW), null);
    assert.equal(db.log.length, 0);
  }
});

test("flag: off unless exactly on; cache key is private and not a public doc", () => {
  for (const v of [undefined, "", "off", "0", "no", "true"]) assert.equal(feedEnabled({ D1_FEED: v }), false);
  assert.equal(feedEnabled({ D1_FEED: "on" }), true);
  assert.equal(feedEnabled({ D1_FEED: " ON " }), true);
  assert.ok(isFeedDoc("stats") && isFeedDoc("timeline") && isFeedDoc("tonight") && !isFeedDoc("party"));
  assert.ok(isPrivateKvKey(cacheKey("stats")));
  assert.ok(!isPublicDataDoc(cacheKey("stats")));
});

test("wrangler.toml ships D1_FEED off; the route calls the feed only behind the flag", () => {
  const toml = fs.readFileSync(path.join(DATA, "..", "infrastructure", "wrangler.toml"), "utf8");
  assert.match(toml, /^D1_FEED = "off"/m);
  const src = fs.readFileSync(path.join(DATA, "..", "infrastructure", "worker", "index.js"), "utf8");
  assert.match(src, /path\.startsWith\("\/data\/"\) && feedEnabled\(env\) \? await serveFeedDoc\(env, raw\) : null/);
});
