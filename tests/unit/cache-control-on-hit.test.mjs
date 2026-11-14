// A response served from caches.default keeps the route's own Cache-Control. Cloudflare hands a cached copy back with the zone's Browser Cache TTL in place
// of its max-age (production, 2026-11-14: max-age=15 became max-age=14400 on CF-Cache-Status: HIT). The fake cache below does the same; the Worker must
// put its own value back. Fictional data only. No network. Run: node --test tests/unit/cache-control-on-hit.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import worker, { restoreCacheControl, KEPT_CACHE_CONTROL, purgeWorkerCache } from "../../infrastructure/worker/index.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";

const realFetch = globalThis.fetch;
globalThis.fetch = async () => new Response("blocked in tests", { status: 599 });
const realCaches = globalThis.caches;
const realNow = Date.now;
test.after(() => { globalThis.fetch = realFetch; globalThis.caches = realCaches; Date.now = realNow; });

// Like the edge: the stored headers come back, but max-age is replaced by the zone's Browser Cache TTL, and CF-Cache-Status and Age are added.
function edgeLikeCache() {
  const store = new Map();
  return {
    store,
    default: {
      async put(req, resp) { store.set(req.url, { body: await resp.text(), status: resp.status, headers: [...resp.headers] }); },
      async match(req) {
        const s = store.get(req.url);
        if (!s) return undefined;
        const h = new Headers(s.headers);
        const cc = h.get("Cache-Control");
        if (cc) h.set("Cache-Control", cc.replace(/max-age=\d+/, "max-age=14400"));
        h.set("CF-Cache-Status", "HIT"); h.set("Age", "12");
        return new Response(s.body, { status: s.status, headers: h });
      },
      async delete(req) { return store.delete(req.url); },
    },
  };
}

const ORIGIN = "https://api.test";
function makeEnv() {
  const DB = schemaDb();
  DB.raw.prepare("INSERT INTO kv_state (key, json, updated_at) VALUES ('stats', ?, '2026-11-12T00:00:00.000Z')").run(JSON.stringify({ generated: "2026-11-01T00:00:00.000Z", answers: 3 }));
  const room = { fetch: async () => new Response("ok") };
  return { DB, ALLOWED_ORIGINS: "", BOARD_ROOM: { idFromName: () => "r", get: () => room } };
}
async function get(env, path) {
  const waits = [];
  const ctx = { waitUntil: (p) => waits.push(p), passThroughOnException() {} };
  const q = console.error; console.error = () => {};
  try {
    const r = await worker.fetch(new Request(`${ORIGIN}/api${path}`, { headers: { "CF-Connecting-IP": "203.0.113.50" } }), ctx.env || env, ctx);
    await Promise.all(waits);
    return r;
  } finally { console.error = q; }
}

for (const [path, own] of [["/data/stats", "public, max-age=15, s-maxage=60, stale-while-revalidate=300"], ["/bootstrap", "public, max-age=15, s-maxage=60, stale-while-revalidate=300"], ["/state", "public, max-age=10, s-maxage=30, stale-while-revalidate=60"]]) {
  test(`GET /api${path}: a cache hit carries the route's own Cache-Control, not the zone's 4 hours`, async () => {
    const cache = edgeLikeCache();
    globalThis.caches = cache;
    Date.now = realNow;
    const env = makeEnv();
    await purgeWorkerCache(ORIGIN, [`/api${path}`]);
    const first = await get(env, path);
    assert.equal(first.headers.get("Cache-Control"), own, "a miss answers the route's own header");
    assert.ok(cache.store.size > 0, "the response was stored");
    const t0 = realNow();
    Date.now = () => t0 + 61 * 1000; // past the isolate cache, so the next read comes from caches.default
    const hit = await get(env, path);
    Date.now = realNow;
    assert.equal(hit.headers.get("CF-Cache-Status"), "HIT", "the fake edge served it");
    assert.equal(hit.headers.get("Cache-Control"), own);
    assert.equal(hit.headers.get(KEPT_CACHE_CONTROL), null, "the private header never leaves the Worker");
  });
}

test("restoreCacheControl leaves a response without the kept header alone", () => {
  const r = new Response("x", { headers: { "Cache-Control": "no-store" } });
  assert.equal(restoreCacheControl(r), r);
  assert.equal(restoreCacheControl(undefined), undefined);
});
