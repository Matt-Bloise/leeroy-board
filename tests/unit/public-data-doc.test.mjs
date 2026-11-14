// Public form of the stored data documents (public-docs.js publicDataDoc): the stats row's `recent` list (shared questions,
// answers, asker names) never leaves through a public read, and `generated` follows the row's last write so the board footer
// does not keep showing the date of the last PC publish. Fictional data only. No network, no AI.
// Run: node --test tests/unit/public-data-doc.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import worker, { purgeWorkerCache } from "../../infrastructure/worker/index.js";
import { publicDataDoc, PUBLIC_STATS_KEYS } from "../../infrastructure/worker/public-docs.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";
import { buildStats } from "../../infrastructure/worker/feed.js";
import { readFileSync } from "node:fs";

const realFetch = globalThis.fetch;
globalThis.fetch = async () => new Response("blocked in tests", { status: 599 });
test.after(() => { globalThis.fetch = realFetch; });

const ORIGIN = "https://api.test";
const ctx = { waitUntil() {}, passThroughOnException() {} };
const OLD = "2026-11-01T22:54:51.758Z";
const NEWER = "2026-11-12T00:36:29.694Z";
const RECENT = [{ id: "a1", by: "Red Fox", q: "Where is the paladin trainer?", a: "In the fictional keep.", cites: [], model: "m", provider: "p", at: NEWER, ms: 900 }];
const STATS = () => ({ generated: OLD, answers: 3, replies: 3, noreply: 0, median_s: 4, p95_s: 9, max_s: 9, miss_threshold_s: 900, misses: 0, last7: [{ closed_utc: NEWER, seconds: 4, kind: "mention", how: "reply" }], wiki_pages: 2, wiki_facts: 10, index_generated: OLD, updated: "2026-11-12", recent: RECENT });
const PARTY = () => ({ generated: OLD, members: [{ name: "Red Fox", class_key: "paladin", class: "Paladin", race: "Human" }] });

test("stats: recent is dropped, every other key the board reads is kept", () => {
  const out = publicDataDoc("stats", STATS(), OLD);
  assert.equal("recent" in out, false);
  const kept = Object.keys(STATS()).filter((k) => k !== "recent").sort();
  assert.deepEqual(Object.keys(out).sort(), kept);
  assert.deepEqual([...PUBLIC_STATS_KEYS].sort(), kept, "the allow list is exactly the stored shape minus recent");
});

test("stats: an unknown key added to the stored row later is not served", () => {
  const out = publicDataDoc("stats", { ...STATS(), askers: ["Red Fox"] }, OLD);
  assert.equal("askers" in out, false);
});

test("generated: a later row write moves it forward, an earlier one never moves it back", () => {
  assert.equal(publicDataDoc("party", PARTY(), NEWER).generated, NEWER);
  assert.equal(publicDataDoc("party", { ...PARTY(), generated: NEWER }, OLD).generated, NEWER);
  assert.equal(publicDataDoc("party", PARTY(), OLD).generated, OLD);
});

test("generated: a non-ISO updated_at (a nonce, a seed marker) or a doc without generated is left alone", () => {
  assert.equal(publicDataDoc("party", PARTY(), "x").generated, OLD);
  assert.equal(publicDataDoc("party", PARTY(), `${NEWER}~k3j2`).generated, OLD, "a compare-and-swap nonce (party_sheets uses them) is not a time");
  assert.equal(publicDataDoc("party", PARTY(), null).generated, OLD);
  const noStamp = { members: [] };
  assert.equal("generated" in publicDataDoc("party", noStamp, NEWER), false);
});

test("the stored document is not changed", () => {
  const doc = PARTY();
  publicDataDoc("party", doc, NEWER);
  assert.equal(doc.generated, OLD);
  const st = STATS();
  publicDataDoc("stats", st, NEWER);
  assert.equal(st.recent.length, 1);
});

test("arrays and non-objects pass through", () => {
  const launch = [{ id: "launch" }];
  assert.equal(publicDataDoc("launch", launch, NEWER), launch);
  assert.equal(publicDataDoc("party", null, NEWER), null);
});

test("the allow list covers every key feed.js builds and every key of the committed data/stats.json, and nothing else but updated", () => {
  const built = Object.keys(buildStats({ wiki_facts: 1, index_generated: OLD }, { totals: {}, window: [], wikiPages: 0 }, NEWER));
  const committed = Object.keys(JSON.parse(readFileSync(new URL("../../data/stats.json", import.meta.url), "utf8")));
  for (const k of [...built, ...committed]) assert.ok(PUBLIC_STATS_KEYS.includes(k), k);
  assert.deepEqual(PUBLIC_STATS_KEYS.filter((k) => !built.includes(k) && !committed.includes(k)), ["updated"]);
});

const ADMIN = "admin-token-for-tests-0123456789abcdef";
function makeEnv() {
  const DB = schemaDb();
  const put = (k, v, at) => DB.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES (?, ?, ?)").run(k, JSON.stringify(v), at);
  put("stats", STATS(), NEWER);
  put("party", PARTY(), NEWER);
  put("signups", { generated: OLD, rows: [] }, OLD);
  const sent = [];
  const room = { fetch: async (_u, init) => { if (init && init.body) sent.push(init.body); return new Response("ok"); } };
  return { DB, sent, BOARD_ADMIN_TOKEN: ADMIN, BOARD_ROOM: { idFromName: () => "r", get: () => room }, ALLOWED_ORIGINS: "" };
}
const quiet = async (fn) => { const e = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = e; } };
const get = async (env, path) => {
  await purgeWorkerCache(ORIGIN, [`/api${path}`]);
  return quiet(async () => (await worker.fetch(new Request(`${ORIGIN}/api${path}`, { headers: { "CF-Connecting-IP": "203.0.113.21" } }), env, ctx)).json());
};

test("GET /api/data/stats: no recent, generated is the row's last write", async () => {
  const env = makeEnv();
  const body = await get(env, "/data/stats");
  assert.equal("recent" in body, false);
  assert.equal(body.answers, 3);
  assert.equal(body.generated, NEWER);
  const stored = JSON.parse(env.DB.raw.prepare("SELECT json FROM kv_state WHERE key = 'stats'").get().json);
  assert.equal(stored.recent.length, 1, "the stored row keeps recent for the owner's own tools");
  assert.equal(stored.generated, OLD);
});

test("GET /api/data/party and /api/data/signups: generated follows the row", async () => {
  const env = makeEnv();
  assert.equal((await get(env, "/data/party")).generated, NEWER);
  assert.equal((await get(env, "/data/signups")).generated, OLD);
});

test("GET /api/state: stats without recent, partyDoc stamped, sheets still built from the stored party", async () => {
  const env = makeEnv();
  const body = await get(env, "/state");
  assert.equal("recent" in body.stats, false);
  assert.equal(body.stats.generated, NEWER);
  assert.equal(body.partyDoc.generated, NEWER);
  assert.ok(body.party.some((p) => p.slug === "red-fox"), JSON.stringify(body.party));
  assert.equal(JSON.stringify(body).includes("paladin trainer"), false, "no question text anywhere in the body");
});

test("GET /api/bootstrap: stats without recent, no question text anywhere", async () => {
  const env = makeEnv();
  const body = await get(env, "/bootstrap");
  assert.equal("recent" in body.stats, false);
  assert.equal(body.stats.generated, NEWER);
  assert.equal(body.party.generated, NEWER);
  assert.equal(JSON.stringify(body).includes("paladin trainer"), false);
});

test("GET /api/data/stats: an unparsable stored row is not served (it cannot be filtered)", async () => {
  const env = makeEnv();
  env.DB.raw.prepare("UPDATE kv_state SET json = ? WHERE key = 'stats'").run(JSON.stringify(STATS()).slice(0, -3));
  await purgeWorkerCache(ORIGIN, ["/api/data/stats"]);
  const res = await quiet(() => worker.fetch(new Request(`${ORIGIN}/api/data/stats`, { headers: { "CF-Connecting-IP": "203.0.113.22" } }), env, ctx));
  assert.equal(res.status, 500);
  assert.equal((await res.text()).includes("paladin trainer"), false);
});

test("admin PUT /api/data/stats stores the body as sent but broadcasts only its public form", async () => {
  const env = makeEnv();
  const res = await quiet(() => worker.fetch(new Request(`${ORIGIN}/api/data/stats`, { method: "PUT", headers: { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.23" }, body: JSON.stringify(STATS()) }), env, ctx));
  assert.equal(res.status, 200, await res.clone().text());
  const stored = JSON.parse(env.DB.raw.prepare("SELECT json FROM kv_state WHERE key = 'stats'").get().json);
  assert.equal(stored.recent.length, 1);
  assert.ok(env.sent.length >= 1, "one broadcast");
  for (const b of env.sent) assert.equal(b.includes("paladin trainer"), false, b);
});
