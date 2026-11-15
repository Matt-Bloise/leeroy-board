// Review round 2 of the trust-card truth work. Fictional data only; no network, no AI.
//   F1  a stored value that is off the vocabulary can still be hidden and re-sent; every shipped value is on the vocabulary; the hide switch sends visibility only
//   F2  a junk sheet row or junk field fails closed: public means a field entry that is an object with visible === true
//   F6  a party-document member is matched to its sheets by slug, then name, and unmatched means hidden; same-name sheets are OR-ed
//   F8  /data/{decide,tonight,guided-atlas,client,launch,party} keep no ETag across a flip between the full and the withheld body
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker, { PARTY_CACHE_PATHS, purgeWorkerCache } from "../../infrastructure/worker/index.js";
import { invalidateConfigCache } from "../../infrastructure/worker/config.js";
import { sha256Hex } from "../../infrastructure/worker/crypto.js";
import { PARTY_MEMBERS, sheetMemberFromDoc } from "../../infrastructure/worker/party-source.js";
import { sheetValueProblem } from "../../infrastructure/worker/sheet-values.js";
import { VOCAB_FIELDS } from "../../infrastructure/worker/sheet-vocab.js";
import { projectForAnonymous, projectSheets, anyHidden, sheetsHideAnything, projectDecide, WITHHELD_LINE } from "../../infrastructure/worker/public-party.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";

const ROOT = new URL("../../", import.meta.url);
const ORIGIN = "https://api.test";
const ctx = { waitUntil() {}, passThroughOnException() {} };
const AT = "2026-11-12T00:00:00.000Z";
const KEY = "member-key-round2-0123456789abcdef", KEY_SALT = "key-salt-for-tests-0123456789";
const quiet = async (fn) => { const e = console.error, w = console.warn, l = console.log; console.error = console.warn = console.log = () => {}; try { return await fn(); } finally { console.error = e; console.warn = w; console.log = l; } };

// ---- F1 --------------------------------------------------------------------------------------------------------------------------------
test("F1: every shipped seed value (PARTY_MEMBERS) and every value derived from data/party.json is on the vocabulary", () => {
  for (const m of PARTY_MEMBERS) {
    for (const f of VOCAB_FIELDS) {
      if (m[f] === undefined) continue;
      assert.equal(sheetValueProblem(f, m[f], undefined), null, `${m.slug} ${f}=${JSON.stringify(m[f])}`);
    }
  }
  const doc = JSON.parse(readFileSync(new URL("data/party.json", ROOT), "utf8"));
  assert.ok(doc.members.length >= 5);
  for (const dm of doc.members) {
    const s = sheetMemberFromDoc(dm); // the sheet shape the Worker builds from a document member (the free-text spec is never turned into a spec_path)
    for (const f of ["race", "class", "plan_zone"]) if (s[f] !== undefined) assert.equal(sheetValueProblem(f, s[f], undefined), null, `${dm.name} ${f}=${s[f]}`);
    // professions in the document are free text ("Enchanting or Alchemy" is a real entry): sheetMemberFromDoc never copies them to a sheet, so only the single-word entries are held to the list
    const profs = (dm.professions || []).map((p) => String(p.name || p).toLowerCase()).filter((x) => /^[a-z]+$/.test(x));
    for (const x of profs) assert.equal(sheetValueProblem("professions", [x], undefined), null, `${dm.name} profession ${x}`);
    assert.equal(s.professions, undefined, "the sheet shape built from the document carries no professions");
  }
});

async function makeEnv(fields, extra = {}) {
  invalidateConfigCache();
  const DB = schemaDb();
  DB.raw.prepare("INSERT INTO kv_state (key, json, updated_at) VALUES ('party', ?, ?)").run(JSON.stringify({ members: [{ name: "Red Fox", class_key: "paladin", class: "Paladin", race: "Human", role: "tank" }] }), AT);
  DB.raw.prepare("INSERT INTO kv_state (key, json, updated_at) VALUES ('discord_members', ?, ?)").run(JSON.stringify([{ slug: "red-fox", name: "Red Fox", match: ["red fox"], id: "100000000000000100" }]), AT);
  DB.raw.prepare("INSERT INTO kv_state (key, json, updated_at) VALUES ('party_sheets', ?, ?)").run(JSON.stringify([{ slug: "red-fox", name: "Red Fox", updated: AT, fields }]), AT);
  DB.raw.prepare("INSERT INTO members (slug, key_hash, created_at) VALUES (?, ?, ?)").run("red-fox", await sha256Hex(`${KEY_SALT}:${KEY}`), AT);
  for (const [k, v] of Object.entries(extra)) DB.raw.prepare("INSERT INTO kv_state (key, json, updated_at) VALUES (?, ?, ?)").run(k, JSON.stringify(v), AT);
  const room = { fetch: async () => new Response(JSON.stringify({ ok: true })) };
  return { DB, KEY_SALT, USER_SALT: "user-salt-for-tests-0123456789", ALLOWED_ORIGINS: "", BOARD_ROOM: { idFromName: () => "r", get: () => room } };
}
const post = (env, body) => quiet(() => worker.fetch(new Request(`${ORIGIN}/api/sheet`, { method: "POST", headers: { Authorization: `Board ${KEY}`, "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.9" }, body: JSON.stringify(body) }), env, ctx));
const stored = (env) => JSON.parse(env.DB.raw.prepare("SELECT json FROM kv_state WHERE key = 'party_sheets'").get().json).find((s) => s.slug === "red-fox").fields;
const OFF = { race: "qzrace", class: "qzclass", spec_path: "feral-tank", spec_at_40: "qzspec", professions: ["qzprof"], plan_zone: "qzzone" };

test("F1: a member can hide, and show again, every line even when the stored value is off the vocabulary; the stored value is kept", async () => {
  const env = await makeEnv(Object.fromEntries(Object.entries(OFF).map(([k, v]) => [k, { value: v, visible: true, source: "board", at: AT }])));
  for (const f of VOCAB_FIELDS) {
    let r = await post(env, { field: f, visible: false });
    assert.equal(r.status, 200, `${f} hide: ${await r.clone().text()}`);
    assert.equal(stored(env)[f].visible, false, f);
    assert.deepEqual(stored(env)[f].value, OFF[f], `${f}: the stored value stays`);
    r = await post(env, { field: f, visible: true });
    assert.equal(r.status, 200, `${f} show: ${await r.clone().text()}`);
    assert.equal(stored(env)[f].visible, true, f);
    assert.deepEqual(stored(env)[f].value, OFF[f], f);
    r = await post(env, { field: f, value: OFF[f], visible: false }); // an older client that still sends the stored value with the hide
    assert.equal(r.status, 200, `${f} same value: ${await r.clone().text()}`);
    assert.equal(stored(env)[f].visible, false);
    r = await post(env, { field: f, value: f === "professions" ? ["qzother"] : "qzother" }); // a different off-vocabulary value is still refused
    assert.equal(r.status, 400, `${f} a different off-list value`);
    assert.deepEqual(stored(env)[f].value, OFF[f], `${f}: nothing was written`);
  }
  for (const f of ["goals", "launch_state"]) assert.equal((await post(env, { field: f, visible: false })).status, 200, f);
});

test("F1: the hide switch (scenes/sheet.js toggle) sends visibility only, never the value", () => {
  const src = readFileSync(new URL("scenes/sheet.js", ROOT), "utf8");
  const m = /function toggle\(m, f\) \{([^\n]*)\}/.exec(src);
  assert.ok(m, "toggle is there");
  assert.match(m[1], /return write\(m, f, undefined, /, "write(m, f, undefined, visible)");
  assert.ok(!/x\.value/.test(m[1]), "toggle does not read the value");
});

// ---- F2 --------------------------------------------------------------------------------------------------------------------------------
const doc = () => ({ members: [{ name: "Ada", role: "tank", class: "Mage", class_key: "mage", race: "Gnome", spec: "Frost", start_zone: "Dun Morogh" }, { name: "Bo", role: "healer", class: "Priest", class_key: "priest", race: "Orc" }] });
const fld = (v) => ({ value: v, visible: true, source: "board", at: AT });
const rowOf = (slug, name, fields) => ({ slug, name, updated: AT, fields });
const shown = () => ({ race: fld("gnome"), class: fld("mage"), spec_path: fld("frost"), plan_zone: fld("dun-morogh") });
const JUNK_FIELDS = [null, undefined, "x", 5, true, [], [shown()]];
const JUNK_ENTRIES = [null, "gnome", 7, true, [], { value: "gnome" }, { value: "gnome", visible: "true" }, { value: "gnome", visible: 1 }, { value: "gnome", visible: null }, { value: "gnome", visible: false }];

test("F2: a row whose fields is not an object hides everything of that member, withholds the composites, and serves no fields", () => {
  for (const bad of JUNK_FIELDS) {
    const rows = [rowOf("ada", "Ada", bad), rowOf("bo", "Bo", { race: fld("orc"), class: fld("priest") })];
    const out = projectForAnonymous(doc(), rows);
    assert.deepEqual(Object.keys(out.members[0]).sort(), ["name", "role"], `fields=${JSON.stringify(bad)}`);
    assert.equal(out.withheld, WITHHELD_LINE, "the composites are withheld");
    assert.equal(anyHidden(doc(), rows), true);
    assert.equal(sheetsHideAnything(rows), true);
    assert.equal(projectDecide({ people: [{ n: 1 }], party: { x: 1 } }, doc(), rows).withheld, WITHHELD_LINE);
    assert.deepEqual(projectSheets(rows)[0].fields, {}, "no field of a junk row is public");
  }
});

test("F2: a field entry that is not an object, or whose visible is not the boolean true, is hidden (with what the cascade ties to it)", () => {
  for (const bad of JUNK_ENTRIES) {
    const rows = [rowOf("ada", "Ada", { ...shown(), race: bad }), rowOf("bo", "Bo", { race: fld("orc"), class: fld("priest") })];
    const out = projectForAnonymous(doc(), rows);
    assert.equal(out.members[0].race, undefined, `race=${JSON.stringify(bad)}`);
    assert.equal(out.withheld, WITHHELD_LINE, `race=${JSON.stringify(bad)}`);
    const sheet = projectSheets(rows)[0].fields;
    assert.equal(sheet.race, undefined);
    assert.ok(sheet.class && sheet.spec_path, "the other shown lines stay");
  }
  const unknown = projectSheets([rowOf("ada", "Ada", { ...shown(), mystery: 5, other: { value: 1 } })])[0].fields;
  assert.deepEqual(Object.keys(unknown).sort(), ["class", "plan_zone", "race", "spec_path"], "a field this code has not heard of is public only with visible:true");
  assert.equal(anyHidden(doc(), [rowOf("ada", "Ada", shown()), rowOf("bo", "Bo", { race: fld("orc") })]), false, "boolean true everywhere: nothing hidden, as in production");
});

test("F2: the normal write path always stores a boolean visible", async () => {
  const env = await makeEnv({});
  for (const body of [{ field: "race", value: "human" }, { field: "race", value: "human", visible: false }, { field: "class", visible: true }, { field: "level", value: 5 }, { field: "goals", value: "x" }, { field: "launch_state", visible: false }]) {
    assert.equal((await post(env, body)).status, 200, JSON.stringify(body));
  }
  for (const [k, v] of Object.entries(stored(env))) assert.equal(typeof v.visible, "boolean", k);
});

// ---- F6 --------------------------------------------------------------------------------------------------------------------------------
test("F6: a document member with no sheet by slug or name gets everything hidden, not nothing", () => {
  const rows = [rowOf("bo", "Bo", { race: fld("orc"), class: fld("priest") })]; // Ada has no sheet
  const out = projectForAnonymous(doc(), rows);
  assert.deepEqual(Object.keys(out.members[0]).sort(), ["name", "role"]);
  assert.ok(out.members[1].race, "Bo, who has a sheet and hides nothing, keeps their build");
  assert.equal(out.withheld, WITHHELD_LINE);
  assert.equal(anyHidden(doc(), rows), true);
});

test("F6: the slug wins over the name; same-name sheets are OR-ed, so neither can unhide the other", () => {
  // a sheet with Ada's slug but another name beats a sheet that only shares the name
  const bySlug = [rowOf("ada", "Ada L.", { race: fld("gnome"), class: fld("mage") }), rowOf("ada-2", "Ada", { race: { value: "gnome", visible: false }, class: fld("mage") }), rowOf("bo", "Bo", { race: fld("orc"), class: fld("priest") })];
  assert.ok(projectForAnonymous(doc(), bySlug).members[0].race, "the slug match decides, and it shows race");
  // two sheets with one slug: a hide on either hides
  const dup = [rowOf("ada", "Ada", { race: fld("gnome"), class: fld("mage") }), rowOf("ada", "Ada", { race: { value: "gnome", visible: false }, class: fld("mage") }), rowOf("bo", "Bo", { race: fld("orc"), class: fld("priest") })];
  assert.equal(projectForAnonymous(doc(), dup).members[0].race, undefined);
  // two sheets with one name and other slugs
  const same = [rowOf("a1", "Ada", { race: fld("gnome"), class: fld("mage") }), rowOf("a2", "ada", { class: { value: "mage", visible: false } }), rowOf("bo", "Bo", { race: fld("orc"), class: fld("priest") })];
  const out = projectForAnonymous(doc(), same);
  assert.equal(out.members[0].class, undefined, "the second sheet's hide applies");
  assert.equal(out.members[0].class_key, undefined, "and the cascade with it");
});

// ---- F8 --------------------------------------------------------------------------------------------------------------------------------
test("F8: the ETag of a member document changes when its body flips between full and withheld", async () => {
  const docs = {
    decide: { people: [{ class_key: "mage" }], party: { brackets: [], role_lines: [], buffs: [], nobody: { classes: [], professions: [], secondaries: [], buffs: [] }, lines: [] } },
    tonight: { people: [{ member: "Ada" }], week_one: { trainers: { mage: 1 } } },
    "guided-atlas": { classes: { mage: { zone: "x" } }, meet: { name: "somewhere" } },
    client: { classes: { mage: {} }, racials: {}, synergy: [], buffs: { list: [], rules: [] }, level: 60 },
    launch: [{ slug: "red-fox", name: "Red Fox", state: "in", at: AT }],
    party: { members: [{ name: "Red Fox", class_key: "paladin", class: "Paladin", race: "Human", role: "tank" }] },
  };
  const open = { race: fld("human"), class: fld("paladin") };
  const { party, ...others } = docs;
  const env = await makeEnv(open, others);
  env.DB.raw.prepare("UPDATE kv_state SET json = ? WHERE key = 'party'").run(JSON.stringify(party));
  const etags = {};
  for (const name of Object.keys(docs)) {
    const a = await quiet(() => worker.fetch(new Request(`${ORIGIN}/api/data/${name}`, { headers: { "CF-Connecting-IP": "203.0.113.20" } }), env, ctx));
    assert.equal(a.status, 200, name);
    etags[name] = a.headers.get("ETag");
  }
  assert.equal((await post(env, { field: "race", visible: false })).status, 200); // a real hide: the stored documents are untouched and their updated_at does not move
  for (const name of Object.keys(docs)) {
    const b = await quiet(() => worker.fetch(new Request(`${ORIGIN}/api/data/${name}`, { headers: { "CF-Connecting-IP": "203.0.113.21" } }), env, ctx));
    assert.equal(b.status, 200, name);
    if (name === "launch") continue; // launch only changes when launch_state is the hidden line
    assert.notEqual(b.headers.get("ETag"), etags[name], `${name}: the same ETag for the full and the changed body`);
  }
  const again = await quiet(() => worker.fetch(new Request(`${ORIGIN}/api/data/tonight`, { headers: { "CF-Connecting-IP": "203.0.113.22" } }), env, ctx));
  const twice = await quiet(() => worker.fetch(new Request(`${ORIGIN}/api/data/tonight`, { headers: { "CF-Connecting-IP": "203.0.113.23" } }), env, ctx));
  assert.equal(again.headers.get("ETag"), twice.headers.get("ETag"), "an unchanged projection keeps its ETag");
  assert.match(await again.text(), new RegExp(WITHHELD_LINE.slice(0, 20)));
});

// ---- F3 (option b): js/board.js apiFetch never reads the static file of a member document in the API's place ------------------------------
import vm from "node:vm";
function boardApiFetch(answer) {
  const src = readFileSync(new URL("js/board.js", ROOT), "utf8");
  const re = src.split("\n").find((l) => l.startsWith("const MEMBER_DOC_RE")), fn = src.split("\n").find((l) => l.startsWith("const apiFetch"));
  assert.ok(re && fn, "MEMBER_DOC_RE and apiFetch are in board.js");
  const calls = [];
  const fetch = (u) => { calls.push(String(u)); return answer(String(u)); };
  const box = vm.runInNewContext(`${re}\nconst API = "https://api.example";\n${fn}\n({ apiFetch, MEMBER_DOC_RE })`, { fetch, Promise });
  return { ...box, calls };
}
test("F3: with the API set and answering non-OK (or failing), the five member documents are never read from data/<name>.json", async () => {
  for (const name of ["party", "decide", "tonight", "client", "guided-atlas"]) {
    for (const answer of [(u) => Promise.resolve({ ok: u.startsWith("https://api.example") ? false : true, status: 500 }), (u) => (u.startsWith("https://api.example") ? Promise.reject(new Error("offline")) : Promise.resolve({ ok: true, status: 200 }))]) {
      const b = boardApiFetch(answer);
      let r = null, err = null;
      try { r = await b.apiFetch(`data/${name}.json`, { cache: "no-cache" }); } catch (e) { err = e; }
      assert.deepEqual(b.calls, [`https://api.example/api/data/${name}`], `${name}: only the API was asked`);
      assert.ok(err || (r && r.ok === false), `${name}: the caller gets the failure`);
    }
  }
});
test("F3: documents that carry no member data keep the static fallback; a 200 answer is used as is", async () => {
  const bad = boardApiFetch((u) => Promise.resolve({ ok: !u.startsWith("https://api.example"), status: 500 }));
  for (const f of ["data/timeline.json", "data/stats.json", "data/library/index.json"]) { bad.calls.length = 0; const r = await bad.apiFetch(f); assert.equal(r.ok, true, f); assert.equal(bad.calls.length, 2, `${f}: API then the file`); }
  const good = boardApiFetch(() => Promise.resolve({ ok: true, status: 200 }));
  await good.apiFetch("data/party.json");
  assert.equal(good.calls.length, 1);
  const none = readFileSync(new URL("js/board.js", ROOT), "utf8");
  assert.ok(none.includes("This part of the board could not load. Try again in a moment."), "the plain line is in board.js");
  assert.ok(readFileSync(new URL("scenes/decide.js", ROOT), "utf8").includes("This part of the board could not load. Try again in a moment."));
});
