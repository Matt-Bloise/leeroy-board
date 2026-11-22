// Round 5 of PR 333: the Worker serves `client` when kv_state has no row, a rename cannot turn a hidden member visible, malformed documents are withheld, duplicate sheets OR their hides,
// and every sign-up and launch purge uses the key the route caches under. Fictional party only; the target is whichever member the admin token writes as, read from the Worker.
// Run: node --test tests/unit/trust-round5.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import worker, { purgeWorkerCache, PARTY_CACHE_PATHS } from "../../infrastructure/worker/index.js";
import { dataCachePath } from "../../infrastructure/worker/public-docs.js";
import { PARTY_MEMBERS } from "../../infrastructure/worker/party-source.js";
import { projectForAnonymous, projectDecide, projectTonight, projectGuidedAtlas, projectClient, projectLaunch, projectSheets } from "../../infrastructure/worker/public-party.js";
import { invalidateConfigCache } from "../../infrastructure/worker/config.js";
import { invalidatePagesCache } from "../../infrastructure/worker/ai-models.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";

const realFetch = globalThis.fetch;
globalThis.fetch = async () => new Response("blocked in tests", { status: 599 });
test.after(() => { globalThis.fetch = realFetch; });

const ORIGIN = "https://api.test", ADMIN = "admin-token-for-tests-0123456789abcdef", AT = "2026-11-12T00:00:00.000Z";
const admin = { Authorization: `Bearer ${ADMIN}` };
const ctx = { waitUntil() {}, passThroughOnException() {} };
const TARGET = PARTY_MEMBERS[3];
const quiet = async (fn) => { const e = console.error, w = console.warn, l = console.log; console.error = console.warn = console.log = () => {}; try { return await fn(); } finally { console.error = e; console.warn = w; console.log = l; } };
const member = (name, cls, race) => ({ name, class_key: cls, class: cls[0].toUpperCase() + cls.slice(1), race, spec: "Invented", spec_status: "chosen", role: "dps", role_detail: "Invented", color: "#abcdef", start_zone: "Durotar", board_line: "Invented line", professions: ["Mining"] });
const slugOf = (n) => n.toLowerCase().replace(/[^a-z0-9]+/g, "-");
const fl = (v, visible = true) => ({ value: v, visible, source: "board", at: AT });
const sheetOf = (name, slug, cls, race, hidden = []) => ({ slug, name, fields: { race: fl(race, !hidden.includes("race")), class: fl(cls, !hidden.includes("class")), plan_zone: fl("durotar") }, updated: AT });

let ip = 0;
async function makeEnv({ docs = {}, sheets, withClient = false } = {}) {
  invalidatePagesCache(); invalidateConfigCache();
  await purgeWorkerCache(ORIGIN, [...PARTY_CACHE_PATHS, "/api/signups", dataCachePath("signups"), dataCachePath("launch")]);
  const DB = schemaDb();
  const kv = (k, v) => DB.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES (?, ?, ?)").run(k, JSON.stringify(v), AT);
  const cast = [member("Alder Testwright", "mage", "undead"), member(TARGET.name, "druid", "tauren"), member("Cedar Testwright", "rogue", "orc")];
  kv("party", { generated: AT, members: cast, settled: ["Invented"], settled_extra: [], open: ["Invented"], glossary: [] });
  kv("party_sheets", sheets || cast.map((m) => sheetOf(m.name, m.name === TARGET.name ? TARGET.slug : slugOf(m.name), m.class_key, m.race)));
  kv("signups", { generated: AT, present: true, updated: AT, options: { meet: [], when: [] }, entries: [], tallies: {} });
  kv("launch", { rows: [] });
  if (withClient) kv("client", { level: 60, classes: { Druid: {} }, racials: {}, synergy: [], buffs: { list: [], rules: [] } });
  for (const [k, v] of Object.entries(docs)) kv(k, v);
  const room = { fetch: async () => new Response("ok") };
  return { IS_PR_PREVIEW: "1", DB, KEY_SALT: "key-salt-for-tests-0123456789", USER_SALT: "user-salt-for-tests-0123456789", BOARD_ADMIN_TOKEN: ADMIN, ALLOWED_ORIGINS: "", BOARD_ROOM: { idFromName: () => "r", get: () => room }, BOARD_PUBLIC_URL: "https://leeroy.test" };
}
const call = async (env, method, path, { headers = {}, body } = {}) => {
  const init = { method, headers: { "CF-Connecting-IP": `203.0.113.${(ip++ % 200) + 1}`, ...headers } };
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers["Content-Type"] = "application/json"; }
  const res = await quiet(() => worker.fetch(new Request(`${ORIGIN}${path}`, init), env, ctx));
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, text, json, headers: res.headers };
};

// ---- 1. the board does not go blank when `client` has no row -------------------------------------------------------------------------------------------------------------
test("GET /api/data/client with no kv_state row answers 200 with the bundled default, never 404", async () => {
  const env = await makeEnv();
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM kv_state WHERE key = 'client'").get().n, 0, "the fixture has no client row (as production)");
  for (const p of ["/api/data/client", "/api/data/client.json"]) {
    const r = await call(env, "GET", p);
    assert.equal(r.status, 200, p);
    assert.equal(r.headers.get("Cache-Control"), "no-store");
    assert.ok(r.json && r.json.level === 60 && r.json.classes && Object.keys(r.json.classes).length > 3, "the whole bundled document, nothing hidden");
  }
});
test("the bundled client default is projected like a stored row: a hidden class is withheld, with the one plain line", async () => {
  const env = await makeEnv({ sheets: [sheetOf("Alder Testwright", "alder-testwright", "mage", "undead"), sheetOf(TARGET.name, TARGET.slug, "druid", "tauren", ["class"]), sheetOf("Cedar Testwright", "cedar-testwright", "rogue", "orc")] });
  const r = await call(env, "GET", "/api/data/client");
  assert.equal(r.status, 200);
  assert.ok(r.json.withheld && Object.keys(r.json.classes).length === 0 && r.json.synergy.length === 0 && r.json.buffs.list.length === 0, "member-derived sections are empty");
  assert.equal(r.json.level, 60, "what does not depend on the party stays");
});
test("a stored client row wins over the bundled default", async () => {
  const env = await makeEnv({ withClient: true });
  const r = await call(env, "GET", "/api/data/client");
  assert.deepEqual(Object.keys(r.json.classes), ["Druid"]);
});

// ---- 2. a rename cannot turn a member who hid fields back to visible -----------------------------------------------------------------------------------------------------
test("hide, admin rename (non-parenthetical), then any member's sheet write: the renamed member's fields stay hidden, in the stored row and in every anonymous read", async () => {
  const env = await makeEnv();
  for (const field of ["race", "class"]) assert.equal((await call(env, "POST", "/api/sheet", { headers: admin, body: { field, visible: false } })).status, 200);
  const stored = (await call(env, "GET", "/api/data/party?stored=1", { headers: admin })).json;
  const NEW = "Zed Renamed";
  stored.members = stored.members.map((m) => (m.name === TARGET.name ? { ...m, name: NEW } : m));
  assert.equal((await call(env, "PUT", "/api/data/party", { headers: admin, body: stored })).status, 200);
  // another member's sheet write: this is what runs reconcile and persists the row for the new name
  const w = await call(env, "POST", "/api/admin/sheet", { headers: admin, body: { slug: "alder-testwright", field: "level", value: 30 } });
  assert.equal(w.status, 200, w.text);
  const row = JSON.parse(env.DB.raw.prepare("SELECT json FROM kv_state WHERE key = 'party_sheets'").get().json).find((s) => s.slug === slugOf(NEW));
  assert.ok(row, "reconcile persisted a row for the new name");
  assert.equal(row.fields.race.visible, false);
  assert.equal(row.fields.class.visible, false);
  const st = (await call(env, "GET", "/api/state")).json;
  const pub = st.party.find((s) => s.slug === slugOf(NEW));
  assert.ok(pub && !("race" in pub.fields) && !("class" in pub.fields), "the public sheet list shows neither");
  const pd = (await call(env, "GET", "/api/data/party")).json.members.find((m) => m.name === NEW);
  assert.ok(pd && !("race" in pd) && !("class_key" in pd) && !("class" in pd), "nor does the party document");
});
test("a renamed member with no hides stays visible (the fix does not hide everyone)", async () => {
  const env = await makeEnv();
  const stored = (await call(env, "GET", "/api/data/party?stored=1", { headers: admin })).json;
  stored.members = stored.members.map((m) => (m.name === TARGET.name ? { ...m, name: "Zed Renamed" } : m));
  await call(env, "PUT", "/api/data/party", { headers: admin, body: stored });
  assert.equal((await call(env, "POST", "/api/admin/sheet", { headers: admin, body: { slug: "alder-testwright", field: "level", value: 30 } })).status, 200);
  const pd = (await call(env, "GET", "/api/data/party")).json.members.find((m) => m.name === "Zed Renamed");
  assert.ok(pd && pd.race && pd.class_key);
});

// ---- 5. malformed documents are withheld, never returned whole ----------------------------------------------------------------------------------------------------------
test("a party document whose members is not a list, and a document that is not an object, are withheld", () => {
  const sheets = [];
  for (const bad of [{ members: "nope", settled: ["Invented"] }, { members: null }, null, "text", 5, []]) {
    const out = projectForAnonymous(bad, sheets);
    assert.ok(out && out.withheld && Array.isArray(out.members) && out.members.length === 0, JSON.stringify(bad));
    assert.ok(!JSON.stringify(out).includes("Invented"));
  }
  for (const [fn, key] of [[projectDecide, "people"], [projectTonight, "people"], [projectGuidedAtlas, "classes"], [projectClient, "classes"]]) {
    for (const bad of [null, "text", 5, [], undefined]) { const out = fn(bad, { members: [] }, []); assert.ok(out && out.withheld && key in out, `${fn.name}(${JSON.stringify(bad)})`); }
  }
});
test("a member row that is not an object is dropped from the party document and counts as hiding everything", () => {
  const doc = { members: [member("Alder Testwright", "mage", "undead"), "a stray string", null, 7], settled: ["Invented"], open: [], settled_extra: [], glossary: [] };
  const sheets = [sheetOf("Alder Testwright", "alder-testwright", "mage", "undead")];
  const out = projectForAnonymous(doc, sheets);
  assert.equal(out.members.length, 1);
  assert.ok(out.withheld, "a row nobody can match is a hide: the composites are withheld");
});

// ---- 6. duplicate sheets: the hides are ORed ---------------------------------------------------------------------------------------------------------------------------
test("projectLaunch: two sheets of one person, only the second hides launch_state: the state is withheld", () => {
  const visible = { slug: "dup", name: "Dup", fields: { launch_state: fl("in") } }, hidden = { slug: "dup", name: "Dup", fields: { launch_state: fl("in", false) } };
  const doc = [{ slug: "dup", name: "Dup", state: "in" }, { slug: "other", name: "Other", state: "queue" }];
  const other = { slug: "other", name: "Other", fields: { launch_state: fl("queue") } };
  for (const order of [[visible, hidden, other], [hidden, visible, other]]) {
    const out = projectLaunch(doc, order);
    assert.ok(!("state" in out[0]), "hidden in either order");
    assert.equal(out[1].state, "queue", "a person who hides nothing keeps theirs");
  }
  const byName = projectLaunch([{ name: "Dup", state: "in" }], [{ name: "dup", fields: { launch_state: fl("x") } }, { name: "Dup", fields: { launch_state: fl("x", false) } }]);
  assert.ok(!("state" in byName[0]), "matched by name: the same rule");
});
test("projectSheets hides every field a duplicate sheet hides, whichever comes first", () => {
  for (const order of [[0, 1], [1, 0]]) {
    const two = [sheetOf("Dup", "dup", "mage", "orc", []), sheetOf("Dup", "dup", "mage", "orc", ["race"])];
    const out = projectSheets(order.map((i) => two[i]));
    assert.ok(out.every((s) => !("race" in s.fields) || s.fields.race.visible === true), "no row that says hidden is shown");
    assert.ok(out.some((s) => !("race" in s.fields)), "the hiding row loses the field");
  }
});

// ---- 7. every purge uses the key the route caches under ----------------------------------------------------------------------------------------------------------------
test("dataCachePath is the key GET /api/data/<name> caches under; a sign-up write is visible on the very next read", async () => {
  assert.equal(dataCachePath("signups"), "/api/data/signups");
  const env = await makeEnv();
  const first = (await call(env, "GET", "/api/data/signups")).json;
  assert.equal(first.entries.length, 0);
  const w = await call(env, "POST", "/api/signups", { headers: admin, body: { rsvp: "in" } });
  assert.equal(w.status, 200, w.text);
  const after = (await call(env, "GET", "/api/data/signups")).json;
  assert.ok(after.entries.length > 0, "the cached copy under /api/data/signups was purged by the write");
});
test("a launch write is visible on the very next read of /api/data/launch", async () => {
  const env = await makeEnv();
  assert.deepEqual((await call(env, "GET", "/api/data/launch")).json.rows || [], []);
  const w = await call(env, "POST", "/api/intent", { headers: admin, body: { kind: "launch", patch: { state: "in" } } });
  assert.equal(w.status, 200, w.text);
  const after = (await call(env, "GET", "/api/data/launch")).json;
  assert.ok(JSON.stringify(after).includes('"in"'), "the cached copy was purged");
});
