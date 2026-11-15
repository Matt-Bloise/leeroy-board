// The sheet_events log behind hideFromEvents (infrastructure/worker/index.js): a person who is in the party document with NO stored sheet gets theirs from the document, and what they hid is
// replayed from the log. Three guarantees, each pinned here with a fictional party:
//  1. A WRITE that cannot read the log stores nothing and answers 503 (it does not persist an all-hidden member, which would blank every composite for everyone). A READ still falls back to hidden.
//  2. Reads do not rescan the whole log while nothing changed (memoised per isolate and database, keyed on MAX(id)); one new event is seen by the next read.
//  3. The per-WRITE memo is scoped to one write: the next write reads the log again. A module-global eventsMemo would keep write 1's log for write 2 and miss a hide recorded in between.
import test from "node:test";
import assert from "node:assert/strict";
import worker, { recordSheetEventInD1, SheetLogUnreadableError, purgeWorkerCache, PARTY_CACHE_PATHS } from "../../infrastructure/worker/index.js";
import { PARTY_MEMBERS } from "../../infrastructure/worker/party-source.js";
import { invalidateConfigCache } from "../../infrastructure/worker/config.js";
import { invalidatePagesCache } from "../../infrastructure/worker/ai-models.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";

const realFetch = globalThis.fetch;
globalThis.fetch = async () => new Response("blocked in tests", { status: 599 });
test.after(() => { globalThis.fetch = realFetch; });

const ORIGIN = "https://api.test";
const ctx = { waitUntil() {}, passThroughOnException() {} };
const ADMIN = "admin-token-for-tests-0123456789abcdef";
const AT = "2026-11-12T00:00:00.000Z";
const TARGET = PARTY_MEMBERS[3];
const slugOf = (n) => n.toLowerCase().replace(/[^a-z0-9]+/g, "-");
const quiet = async (fn) => { const e = console.error, w = console.warn, l = console.log; console.error = console.warn = console.log = () => {}; try { return await fn(); } finally { console.error = e; console.warn = w; console.log = l; } };

const DOC = { generated: AT, party: "Invented", members: [
  { name: TARGET.name, class_key: "druid", class: "Druid", race: "Undead", start_zone: "Tirisfal Glades" },
  { name: "Birch Testwright", class_key: "priest", class: "Priest", race: "Human", start_zone: "Elwynn Forest" },
] };
const fl = (v) => ({ value: v, visible: true, source: "board", at: AT });
// stored sheets: the target's only. Birch is in the document and has no stored sheet (the case the log replay exists for).
const STORED = [{ slug: TARGET.slug, name: TARGET.name, fields: { race: fl("undead"), class: fl("druid") }, updated: AT }];
const BIRCH = { slug: slugOf("Birch Testwright"), name: "Birch Testwright" };

async function makeEnv() {
  invalidatePagesCache(); invalidateConfigCache();
  await purgeWorkerCache(ORIGIN, [...PARTY_CACHE_PATHS]);
  const DB = schemaDb();
  const kv = (k, v) => DB.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES (?, ?, ?)").run(k, JSON.stringify(v), AT);
  kv("party", DOC); kv("party_sheets", STORED);
  const ev = (field, visible) => DB.raw.prepare("INSERT INTO sheet_events (slug, name, field, value_json, visible, source, created_at) VALUES (?, ?, ?, NULL, ?, 'board', ?)").run(BIRCH.slug, BIRCH.name, field, visible ? 1 : 0, AT);
  const stats = { scans: 0, maxReads: 0, failLog: false };
  const real = DB.prepare.bind(DB);
  DB.prepare = (sql) => {
    if (stats.failLog && /sheet_events/.test(sql) && /^\s*SELECT/i.test(sql)) throw new Error("D1_ERROR: sheet_events unreadable");
    if (/FROM sheet_events ORDER BY id ASC/.test(sql)) stats.scans++;
    if (/SELECT MAX\(id\)/.test(sql)) stats.maxReads++;
    return real(sql);
  };
  return { DB, kv, ev, stats, KEY_SALT: "key-salt-for-tests-0123456789", USER_SALT: "user-salt-for-tests-0123456789", BOARD_ADMIN_TOKEN: ADMIN, ALLOWED_ORIGINS: "", BOARD_PUBLIC_URL: "https://leeroy.test" };
}
let ipN = 0;
const get = (env, path, headers = {}) => quiet(() => worker.fetch(new Request(`${ORIGIN}${path}`, { headers: { "CF-Connecting-IP": `203.0.113.${(ipN++ % 200) + 1}`, ...headers } }), env, ctx));
const post = (env, path, body) => quiet(() => worker.fetch(new Request(`${ORIGIN}${path}`, { method: "POST", headers: { "CF-Connecting-IP": `203.0.113.${(ipN++ % 200) + 1}`, "Content-Type": "application/json", Authorization: `Bearer ${ADMIN}` }, body: JSON.stringify(body) }), env, ctx));
const stored = (env, key) => { const r = env.DB.raw.prepare("SELECT json FROM kv_state WHERE key = ?").get(key); return r ? r.json : null; };
const eventCount = (env) => env.DB.raw.prepare("SELECT COUNT(*) AS n FROM sheet_events").get().n;
const birchFields = (env) => JSON.parse(stored(env, "party_sheets")).find((s) => s.slug === BIRCH.slug).fields;

test("a write that cannot read the sheet log answers 503 and stores nothing; a read still falls back to hidden", async () => {
  const env = await makeEnv();
  env.ev("race", false);
  const before = { sheets: stored(env, "party_sheets"), party: stored(env, "party"), events: eventCount(env) };
  env.stats.failLog = true;
  const res = await post(env, "/api/sheet", { field: "goals", value: "an invented goal" });
  assert.equal(res.status, 503, await res.text());
  assert.deepEqual({ sheets: stored(env, "party_sheets"), party: stored(env, "party"), events: eventCount(env) }, before, "nothing was persisted");
  // the library call reports the typed error
  await assert.rejects(quiet(() => recordSheetEventInD1(env, ORIGIN, { slug: TARGET.slug, name: TARGET.name, field: "goals", value: "x" })), SheetLogUnreadableError);
  assert.equal(stored(env, "party_sheets"), before.sheets);
  // a read does not throw: the member without a stored sheet is all hidden
  const read = await get(env, "/api/state");
  assert.equal(read.status, 200);
  // and once the log is readable again the same write goes through, with the member's real (partial) visibility
  env.stats.failLog = false;
  assert.equal((await post(env, "/api/sheet", { field: "goals", value: "an invented goal" })).status, 200);
  assert.equal(birchFields(env).race.visible, false);
  assert.equal(birchFields(env).class.visible, true, "only what the log says is hidden is hidden");
});

test("reads do not rescan the log while nothing changed; one new event is seen by the next read", async () => {
  const env = await makeEnv();
  env.ev("race", false);
  const birchRow = async () => (await (await get(env, "/api/state")).json()).party.find((s) => s.slug === BIRCH.slug);
  assert.ok(!(await birchRow()).fields.race, "the first read replays the log: race is hidden");
  assert.equal(env.stats.scans, 1);
  for (let i = 0; i < 4; i++) await birchRow();
  assert.equal(env.stats.scans, 1, "four more reads: no rescan");
  assert.ok(env.stats.maxReads >= 5, "each read asks one cheap question (MAX(id))");
  env.ev("class", false);
  const row = await birchRow();
  assert.equal(env.stats.scans, 2, "a new event: one rescan");
  assert.ok(!row.fields.race && !row.fields.class, "and the new hide is seen");
  await birchRow(); await birchRow();
  assert.equal(env.stats.scans, 2);
});

test("the memo belongs to one database: another database with the same newest id is not served the first one's log", async () => {
  const a = await makeEnv(); a.ev("race", false);
  const b = await makeEnv(); b.ev("class", false);
  const rowOf = async (env) => (await (await get(env, "/api/state")).json()).party.find((s) => s.slug === BIRCH.slug).fields;
  const fa = await rowOf(a), fb = await rowOf(b);
  assert.ok(!fa.race && fa.class, "A hid race");
  assert.ok(fb.race && !fb.class, "B hid class");
});

test("the per-write memo is scoped to ONE write: a hide recorded between two writes is seen by the second", async () => {
  const env = await makeEnv();
  env.ev("race", false);
  const write = () => quiet(() => recordSheetEventInD1(env, ORIGIN, { slug: TARGET.slug, name: TARGET.name, field: "goals", value: "an invented goal" }));
  await write();
  assert.equal(birchFields(env).race.visible, false, "write 1 replayed the log");
  assert.equal(birchFields(env).plan_zone && birchFields(env).plan_zone.visible, true);
  // Birch loses the stored sheet again (an admin rename of the document would do that) and hides another line in between
  env.kv("party_sheets", STORED);
  env.ev("plan_zone", false);
  await write();
  const f = birchFields(env);
  assert.equal(f.race.visible, false);
  assert.equal(f.plan_zone.visible, false, "write 2 read the log again and saw the new hide (a module-global memo would still hold write 1's log)");
});

test("an erasure of a row that is not the newest leaves MAX(id) alone but not the memo: a fresh read and the memoised read agree", async () => {
  const env = await makeEnv();
  const add = (slug, field, visible) => env.DB.raw.prepare("INSERT INTO sheet_events (slug, name, field, value_json, visible, source, created_at) VALUES (?, ?, ?, NULL, ?, 'board', ?)").run(slug, BIRCH.name, field, visible ? 1 : 0, AT);
  // Birch (no stored sheet) reads events by slug OR by the same normalised name: A = Birch's own slug hid race; B = another slug with the same name showed race afterwards; A then showed class (newest id)
  add(BIRCH.slug, "race", false); add("birch-testwright-b", "race", true); add(BIRCH.slug, "class", true);
  const fieldsOf = async () => (await (await get(env, "/api/state")).json()).party.find((s) => s.slug === BIRCH.slug).fields;
  assert.ok((await fieldsOf()).race, "memoised: the later 'shown' wins, race is shown");
  const maxBefore = env.DB.raw.prepare("SELECT MAX(id) AS m FROM sheet_events").get().m;
  env.DB.raw.prepare("DELETE FROM sheet_events WHERE slug = ?").run("birch-testwright-b"); // the data-rights erase of B
  assert.equal(env.DB.raw.prepare("SELECT MAX(id) AS m FROM sheet_events").get().m, maxBefore, "the newest id did not move");
  const memoised = await fieldsOf();
  assert.ok(!memoised.race, "the read after the erasure rescans: race is hidden, as a fresh isolate would say");
  assert.equal(env.stats.scans, 2);
});
