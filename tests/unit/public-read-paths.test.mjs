// Every ANONYMOUS read path that can show another member's build, one table, one fixture. What a member hides on their sheet, and what is derived from it,
// must be absent from all of them, while the STORED rows hold the whole documents (the projection is on the read side only: public-party.js).
//
//   1. The table of read paths (READS) is checked against the code: every route in ROUTES is classified; every route that carries member data is covered by a read
//      here; every public document that carries member data (a class_key anywhere in the repo's copy) is one the projection knows; every literal broadcast key and every
//      Discord command is classified. A route, document, broadcast or command added without a projection fails here until it is classified and covered.
//   2. The fixture STORES unprojected rows (every hidden value is in kv_state party, decide and tonight), and 8 fictional members hide 0, 1 or every field.
//      Every read path is then run and each hidden canary, and each canary derived from it (the cascade table below, written by hand), must be absent; role and
//      the visible fields must still be there (so an empty read cannot pass).
//   3. Round trip, junk rows, unreadable sheets, the admin PUT that races a hide, the cascade, and the composites: while ANY member hides ANY field, every member-derived
//      section of decide, client, guided-atlas, tonight and the party document's lines is withheld whole (WITHHELD_LINE), not scrubbed.
// Fictional data only. No network, no AI.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import worker, { ROUTES, PARTY_CACHE_PATHS, purgeWorkerCache, broadcastToRoom } from "../../infrastructure/worker/index.js";
import { projectForAnonymous, projectSheets, projectDataDoc, projectDecide, projectTonight, projectGuidedAtlas, projectClient, projectLaunch, projectBroadcast, loadPublicInputs, MEMBER_DOCS, CASCADE, WITHHELD_LINE, SHEET_FIELD_NAMES, anyHidden } from "../../infrastructure/worker/public-party.js";
import { PUBLIC_DATA_DOCS } from "../../infrastructure/worker/public-docs.js";
import { loadCardState, renderBoardCard, renderSignupCard } from "../../infrastructure/worker/cards.js";
import { buildAnswerInputs, invalidatePagesCache } from "../../infrastructure/worker/ai-models.js";
import { handleDiscordInteraction } from "../../infrastructure/worker/discord.js";
import { invalidateConfigCache } from "../../infrastructure/worker/config.js";
import { slugify } from "../../infrastructure/worker/member-model.js";
import { LAUNCH_EPOCH } from "../../infrastructure/worker/tonight-copy.js";
import { sha256Hex } from "../../infrastructure/worker/crypto.js";
import { createDiscordSigner } from "../helpers/discord-sign.mjs";
import { schemaDb } from "../helpers/sqlite-d1.mjs";

const realFetch = globalThis.fetch;
globalThis.fetch = async () => new Response("blocked in tests", { status: 599 });
test.after(() => { globalThis.fetch = realFetch; });

const ROOT = new URL("../../", import.meta.url);
const ORIGIN = "https://api.test";
const ctx = { waitUntil() {}, passThroughOnException() {} };
const ADMIN = "admin-token-for-tests-0123456789abcdef", KEY_SALT = "key-salt-for-tests-0123456789", USER_SALT = "user-salt-for-tests-0123456789";
const ASKER_KEY = "member-key-asker-0123456789abcdef";
const AT = "2026-11-12T00:00:00.000Z";
const quiet = async (fn) => { const e = console.error, w = console.warn, l = console.log; console.error = console.warn = console.log = () => {}; try { return await fn(); } finally { console.error = e; console.warn = w; console.log = l; } };
const readSrc = (rel) => readFileSync(new URL(rel, ROOT), "utf8");

// ---- 1. the table is checked against the code -----------------------------------------------------------------------------------------
// Every route of ROUTES. "member": its answer (or its broadcast) can carry another member's build; it must be covered by an entry of READS below.
const ROUTE_CLASS = {
  "POST /discord": "member", "GET /discord/commands": "none", "GET /votes": "none", "GET /me": "none", "POST /probe": "none", "ANY /sheet": "member",
  "POST /announce": "none", "PUT /vocab": "none", "PUT /config/:key": "none", "POST /admin/members": "none", "POST /admin/sheet": "none", "POST /admin/cards/post": "none",
  "GET /admin/feedback": "none", "GET /admin/export": "none", "GET /admin/requests": "none", "PUT /persona": "none", "POST /dispatch": "none", "POST /admin/events/sync": "none",
  "GET /admin/moments": "none", "POST /admin/eval": "none", "GET /intents": "none", "POST /ack": "none", "POST /answer": "none", "GET /signups": "none", "POST /signups": "none",
  "ANY /live": "member", "GET /state": "member", "POST /token": "none", "POST /auth/discord": "none", "GET /auth/discord/start": "none", "GET /auth/discord/callback": "none",
  "POST /auth/logout": "none", "ANY /me": "none", "GET /me/export": "none", "POST /me/erase": "none", "POST /me/characters": "none", "ANY /state/:doc": "none", "GET /ask": "none",
  "GET /wiki/snapshots": "none", "GET /wiki/proposals": "none", "GET /wiki/proposals/:id": "none", "POST /wiki/proposals/:id/approve": "none", "POST /wiki/proposals/:id/reject": "none",
  "PUT /wiki/page": "none", "GET /bootstrap": "member", "GET /library/*": "none", "GET /data/*": "member", "PUT /data/*": "member", "GET /atlas/*": "none", "PUT /atlas/*": "none",
  "POST /intent": "member", "POST /refresh": "none", "GET /": "none", "GET /health": "none",
};
// The Discord commands. tonight lists the party, sheet shows another member's sheet, signup redraws the cards, ask builds a prompt with the party's builds.
const DISCORD_CLASS = { ack: "none", answer: "none", ask: "member", build: "none", countdown: "none", dates: "none", didyouknow: "none", help: "none", intents: "none", journey: "none", launch: "none", leeroy: "none", library: "none", map: "none", page: "none", quiz: "none", sheet: "member", signup: "member", start: "none", tonight: "member", tooltip: "none", vote: "none" };
// Public documents whose repo copy carries no member data. Every other public document must be one the projection knows (MEMBER_DOCS).
const NON_MEMBER_DOCS = ["timeline", "stats", "signups"];
// Literal keys the Worker broadcasts as {type:"data", key}. Member documents go through the one choke point (broadcastToRoom -> projectBroadcast).
const NON_MEMBER_BROADCAST_KEYS = ["signups", "launch", "stats"];

test("every route of ROUTES is classified here; a new route fails until it is", () => {
  assert.deepEqual(Object.keys(ROUTE_CLASS).sort(), [...ROUTES].sort());
});

// A member-derived shape in a document: a key that is a class or race (a class-keyed or race-keyed map: guided-atlas.classes, client.classes, client.racials), a list made of
// class keys only (synergy.to), a {class} token in a line, or a field that is itself a build field (class_key, race, start_zone, class, spec, professions). The vocabulary comes
// from the repo's own party document and the game's classes and races, so a new class-keyed map in a new document is found without anyone listing it.
const BUILD_VOCAB = (() => {
  const party = JSON.parse(readSrc("data/party.json"));
  const keys = new Set("warrior paladin hunter rogue priest shaman mage warlock druid".split(" ")), races = new Set("orc troll tauren undead human dwarf gnome night-elf".split(" "));
  for (const m of party.members) { if (m.class_key) keys.add(String(m.class_key).toLowerCase()); if (m.class) keys.add(String(m.class).toLowerCase()); if (m.race) races.add(String(m.race).toLowerCase()); }
  return { keys, races };
})();
const BUILD_FIELDS = new Set(["class_key", "race", "start_zone", "class", "spec", "spec_status", "professions", "board_line", "role_detail"]);
function memberShapes(node, path = "$", out = []) {
  if (Array.isArray(node)) {
    if (node.length && node.every((x) => typeof x === "string" && BUILD_VOCAB.keys.has(x.toLowerCase()))) out.push(`${path}: a list of class keys`);
    node.forEach((x, i) => memberShapes(x, `${path}[${i}]`, out));
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      const lk = k.toLowerCase();
      if (BUILD_VOCAB.keys.has(lk) || BUILD_VOCAB.races.has(lk)) out.push(`${path}.${k}: keyed by a class or race`);
      if (BUILD_FIELDS.has(lk)) out.push(`${path}.${k}: a build field`);
      if (lk === "from" && typeof v === "string" && BUILD_VOCAB.keys.has(v.toLowerCase())) out.push(`${path}.from: a class key`);
      memberShapes(v, `${path}.${k}`, out);
    }
  } else if (typeof node === "string" && /[{]([a-z_-]+)[}]/.test(node) && [...node.matchAll(/[{]([a-z_-]+)[}]/g)].some((m) => BUILD_VOCAB.keys.has(m[1]))) out.push(`${path}: a {class} token`);
  return out;
}
export const SHAPES_FOUND = {};
test("every public document is either known to the projection or free of every member-derived shape (class-keyed and race-keyed maps, class lists, {class} tokens, build fields)", () => {
  assert.deepEqual([...PUBLIC_DATA_DOCS].sort(), [...MEMBER_DOCS, ...NON_MEMBER_DOCS].sort(), "a new public document must be classified");
  for (const name of PUBLIC_DATA_DOCS) {
    let doc = null;
    try { doc = JSON.parse(readSrc(`data/${name}.json`)); } catch { continue; }
    const found = memberShapes(doc);
    SHAPES_FOUND[name] = found.length;
    if (!MEMBER_DOCS.includes(name)) assert.deepEqual(found.slice(0, 3), [], `${name} is classified as carrying no member data but has: ${found.slice(0, 3).join("; ")}`);
  }
  for (const n of ["party", "decide", "tonight", "guided-atlas", "client"]) assert.ok(SHAPES_FOUND[n] > 0, `the scan finds the member shapes of ${n} (so it can fail)`);
  // the same scan over the other allow-listed documents (the atlas pair and the library blobs the site fetches)
  for (const n of ["marks", "links"]) { try { assert.deepEqual(memberShapes(JSON.parse(readSrc(`data/atlas/${n}.json`))).slice(0, 3), [], `atlas/${n}`); } catch (e) { if (e && e.code === "ENOENT") continue; throw e; } }
});

test("every literal broadcast key and every Discord command is classified", () => {
  const dir = new URL("infrastructure/worker/", ROOT);
  const keys = new Set();
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".js"))) {
    const src = readFileSync(new URL(f, dir), "utf8");
    for (const m of src.matchAll(/broadcastToRoom\(env,\s*\{\s*type:\s*"data",\s*key:\s*"([a-z_-]+)"/g)) keys.add(m[1]);
    for (const m of src.matchAll(/type:\s*"data",\s*key:\s*raw\b/g)) keys.add("<dynamic raw>");
  }
  for (const k of keys) if (k !== "<dynamic raw>") assert.ok(MEMBER_DOCS.includes(k) || NON_MEMBER_BROADCAST_KEYS.includes(k), `broadcast key ${k} is not classified`);
  assert.ok(keys.has("party") && keys.has("<dynamic raw>"), "the scan found the party broadcast and the PUT /data broadcast");
  const cmds = new Set([...readSrc("infrastructure/worker/discord.js").matchAll(/cmd === "([a-z_-]+)"/g)].map((m) => m[1]));
  assert.deepEqual([...cmds].sort(), Object.keys(DISCORD_CLASS).sort(), "a new Discord command must be classified");
});

// The projection is applied in ONE place per kind: the module that holds it. No route file keeps its own copy of the cascade.
test("no other module re-implements the cascade", () => {
  const dir = new URL("infrastructure/worker/", ROOT);
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".js") && n !== "public-party.js")) {
    const src = readFileSync(new URL(f, dir), "utf8");
    assert.ok(!/delete\s+\w+\.(class_key|board_line|spec_status|role_detail)\b/.test(src), `${f} deletes a derived key by hand`);
    assert.ok(!/DERIVED_FROM_SHEET|restoreDerived|projectPublicParty|projectWithStoredSheets/.test(src), `${f} uses a removed projection`);
  }
});

// ---- 2. the fixture ------------------------------------------------------------------------------------------------------------------------
const NAMES = ["Aldra Voss", "Bren Tolliver", "Cato Marsh", "Delphi Roan", "Edda Quill", "Fenn Harrow", "Gale Ostrander", "Hale Brinn"];
const SLUG = NAMES.map((n) => slugify(n));
const HIDES = [["race"], ["class"], ["spec_path"], ["spec_at_40"], ["professions"], ["plan_zone"], [], ["race", "class", "spec_path", "spec_at_40", "professions", "plan_zone", "level", "launch_state", "goals"]];
const CONTROL = 6, ALLHID = 7;
// What each hidden sheet field removes, written by hand from the approved cascade table (not taken from the module).
const DOC_GONE = {
  race: ["race", "board_line", "start_zone"],
  class: ["class", "class_key", "color", "board_line", "spec", "spec_status", "role_detail"],
  spec_path: ["spec", "spec_status", "role_detail", "board_line"],
  spec_at_40: ["spec", "spec_status", "role_detail", "board_line"],
  professions: ["professions"],
  plan_zone: ["start_zone"],
  level: [], launch_state: [], goals: [],
};
const SHEET_GONE = {
  race: ["race", "plan_zone"], class: ["class", "spec_path", "spec_at_40"], spec_path: ["spec_path"], spec_at_40: ["spec_at_40"], professions: ["professions"], plan_zone: ["plan_zone"],
  level: ["level"], launch_state: ["launch_state"], goals: ["goals"],
};
const SHEET_FIELDS = Object.keys(SHEET_GONE);
const uniq = (a) => [...new Set(a)];
const docGone = (i) => uniq(HIDES[i].flatMap((f) => DOC_GONE[f]));
const sheetGone = (i) => uniq(HIDES[i].flatMap((f) => SHEET_GONE[f]));
const DOC_KEYS = ["race", "class_key", "class", "spec", "spec_status", "role", "role_detail", "color", "start_zone", "board_line", "professions"];
const canon = (k) => k.replace(/_/g, "");
const cDoc = (i, k) => `zq${canon(k)}${i}x`;          // a party-document value
const cSheet = (i, f) => `zqs${canon(f)}${i}x`;        // a sheet value (level is a number: checked by its key)
const cDecide = (i, k) => (k === "classkey" ? cDoc(i, "class_key") : `zqd${k}${i}x`), cTonight = (i, k) => (k === "classkey" ? cDoc(i, "class_key") : `zqt${k}${i}x`); // the people entries pair with members by class_key, so it is the same string
const docValue = (i, k) => (k === "spec_status" ? { status: cDoc(i, k), source: "board" } : k === "professions" ? [{ name: cDoc(i, k), source: "board" }] : cDoc(i, k));
const sheetValue = (i, f) => (f === "professions" ? [cSheet(i, f)] : f === "level" ? 40 + i : cSheet(i, f));
const hidden = (i, f) => HIDES[i].includes(f);
const PRO_HIDERS = [4, ALLHID];

function partyDoc() {
  const members = NAMES.map((name, i) => ({ name, ...Object.fromEntries(DOC_KEYS.map((k) => [k, docValue(i, k)])) }));
  const settled = [
    { text: `Tank: ${NAMES[0]} zqsettledkept0x`, source: "board" },                       // names a member who hides only race: kept
    { text: `${NAMES[1]} zqsettleddrop1x`, source: "board" },                             // class hidden: dropped
    { text: `Healers: ${NAMES[4]}, plus ${NAMES[2]} from level 40 zqsettleddrop2x`, source: "board" }, // names a spec-path hider: dropped
    { text: `${NAMES[3]} zqsettleddrop3x`, source: "board" },                             // spec_at_40 hidden: dropped
    { text: `${NAMES[CONTROL]} zqsettledkept6x`, source: "board" },                       // the control: kept
    { text: "Faction: Horde zqsettledkeptf", source: "board" },
  ];
  return {
    generated: AT, party: "Fictional Four", faction: "Horde", ruleset: "Normal", members, settled,
    settled_extra: [{ text: `${NAMES[1]} zqextradrop1x`, source: "group notes" }, { text: "Raids open zqextrakept", source: "group notes" }],
    open: [{ title: "Professions", text: "the options. Gap: zqgapdrop.", links: [], source: "board" }, { title: "Guild name", text: "poll closes zqopenkept.", links: [], source: "board" }],
    polls: [], glossary: [],
  };
}
function decideDoc() {
  const decisions = (i) => [
    { key: "professions", title: "Professions", state: "declared", state_text: cDecide(i, "prof"),
      group: [{ label: "Enchanting", text: `also {${cDoc(1, "class_key")}}'s zqdgroupdrop`, status: "forever" }, { label: "Mining", text: "nobody else's zqdgroupdrop2", status: "forever" }],
      options: [{ name: "Alchemy", lines: [{ label: "Open", text: `one of {${cDoc(2, "class_key")}}'s two open options zqdoptiondrop`, status: "forever" }] }] },
    { key: "spec40", title: "Spec at 40", state: "declared", state_text: cDecide(i, "spec") },
    { key: "talents", title: "Talents", state: "none", state_text: cDecide(i, "talents"), lines: [{ label: `for the ${cDoc(0, "race")} at this table`, text: "zqdraceline", status: "forever" }] },
    { key: "locked", title: "Locked", state: "locked", state_text: cDecide(i, "locked") },
  ];
  return {
    generated: AT, labels: {}, dates: {},
    people: NAMES.map((_, i) => ({ class_key: cDecide(i, "classkey"), race: cDecide(i, "race"), decisions: decisions(i) })),
    party: {
      brackets: [{ from: 1, to: 39, note: "zqdnote", tank: [cDecide(0, "classkey")], healer: [cDecide(1, "classkey")], damage: NAMES.slice(2).map((_, j) => cDecide(j + 2, "classkey")) }],
      role_lines: [{ label: "Tank", text: "zqdrolelines", status: "forever" }],
      buffs: [{ key: "b", name: "zqdbuff", giver: cDecide(1, "classkey"), to: [cDecide(2, "classkey")] }],
      nobody: { classes: [{ name: "zqdnobodyclass", lines: [] }], professions: [{ name: "zqdnobodyprof", lines: [] }], secondaries: [{ label: "zqdsecondary" }], buffs: [{ name: "zqdnobodybuff" }] },
      lines: [{ label: "zqdgeneric", text: "5 players" }, { label: "zqdlinetokendrop", text: `{${cDoc(1, "class_key")}} is the healer` }],
    },
  };
}
function tonightDoc() {
  return {
    generated: AT, cards: [], labels: {}, steps: {}, events: [], launch: "Launch zqtgeneric",
    people: NAMES.map((_, i) => ({ member: i, class_key: cTonight(i, "classkey"), step: cTonight(i, "step") })),
    week_one: { trainers: Object.fromEntries(NAMES.map((_, i) => [cTonight(i, "classkey"), null])), first_dungeon: null },
    links: {},
  };
}
function atlasDoc() {
  return {
    generated: AT, build: "1.0", starter_cap: { level: 5 },
    classes: Object.fromEntries(NAMES.map((_, i) => [cDoc(i, "class_key"), { start: { id: `zs${i}`, name: `zqatlasstart${i}x`, zone: cDoc(i, "start_zone"), zone_name: cDoc(i, "start_zone") }, trainer: { name: `zqtrainer${i}x` }, town: { id: `zt${i}`, name: `zqtown${i}x`, trainer: `zqtowntrainer${i}x` } }])),
    dungeon: { id: "d", name: "zqdungeonkept" }, meet: { id: "m", name: "zqmeetkept", chosen: false },
  };
}
function clientDoc() {
  return {
    generated: AT, build: "1.0", level: 60,
    classes: Object.fromEntries(NAMES.map((_, i) => [cDoc(i, "class"), [{ id: i, name: `zqspell${i}x` }]])),
    racials: Object.fromEntries(NAMES.map((_, i) => [cDoc(i, "race"), [{ name: `zqracial${i}x`, kind: "active" }]])),
    synergy: NAMES.map((_, i) => ({ from: cDoc(i, "class_key"), to: NAMES.map((__, j) => cDoc(j, "class_key")), what: `zqsynergy${i}x`, refs: [] })),
    legacy: { total: 65 }, flags: {},
    buffs: { build: "1.0", levels: [1, 60], marks: [20, 40, 60], list: NAMES.map((_, i) => ({ key: `zqbuff${i}x`, class: cDoc(i, "class_key"), name: `zqbuffname${i}x` })), rules: [{ text: `zqbuffrule ${cDoc(0, "class")}`, status: "classic" }] },
  };
}
function launchDoc() { return NAMES.map((name, i) => ({ slug: SLUG[i], name, state: cSheet(i, "launch_state"), at: AT })); }
function sheetList(hides = HIDES) {
  return NAMES.map((name, i) => ({
    slug: SLUG[i], name, updated: AT,
    fields: Object.fromEntries(SHEET_FIELDS.map((f) => [f, { value: sheetValue(i, f), visible: !hides[i].includes(f), source: "board", at: AT }])),
  }));
}

// A database holding the whole, unprojected documents.
// apiControl: the control member's sheet row holds values that are on the board's list (sheet-vocab.js), so a POST /sheet of the same value is a hide or a show and not a new value
// (a new value is copied into the party document). Every other row keeps the canaries.
const API_VAL = { race: "orc", class: "mage", spec_path: "fire", spec_at_40: "frost", professions: ["mining"], plan_zone: "durotar" };
async function makeEnv({ hides = HIDES, sheets, apiControl = false } = {}) {
  invalidatePagesCache(); invalidateConfigCache();
  await purgeWorkerCache(ORIGIN, [...PARTY_CACHE_PATHS]);
  const DB = schemaDb();
  const kv = (k, v) => DB.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES (?, ?, ?)").run(k, typeof v === "string" ? v : JSON.stringify(v), AT);
  kv("party", partyDoc()); kv("decide", decideDoc()); kv("tonight", tonightDoc()); kv("guided-atlas", atlasDoc()); kv("client", clientDoc()); kv("launch", launchDoc());
  kv("signups", { generated: AT, present: true, updated: AT, options: { meet: [], when: [] }, entries: [{ name: NAMES[1], rsvp: "in", pack: "no", meet: null, when: "8pm", updated: AT }, { name: NAMES[CONTROL], rsvp: "maybe", updated: AT }], tallies: {} });
  kv("party_sheets", sheets !== undefined ? sheets : apiControl ? sheetList(hides).map((r, i) => (i === CONTROL ? { ...r, fields: Object.fromEntries(Object.entries(r.fields).map(([f, v]) => [f, API_VAL[f] === undefined ? v : { ...v, value: API_VAL[f] }])) } : r)) : sheetList(hides));
  kv("discord_members", [{ slug: "asker-x", name: "Asker X", match: ["asker x"], id: "100000000000000900" }, ...NAMES.map((name, i) => ({ slug: SLUG[i], name, match: [name.toLowerCase()], id: `10000000000000010${i}` }))]);
  DB.raw.prepare("INSERT INTO members (slug, key_hash, created_at) VALUES ('asker-x', ?, ?)").run(await sha256Hex(`${KEY_SALT}:${ASKER_KEY}`), AT);
  const sent = [];
  const room = { fetch: async (_u, init) => { if (init && init.body) sent.push(String(init.body)); return new Response(JSON.stringify({ ok: true, sent: 0, skipped: 0 })); } };
  invalidateConfigCache();
  return { DB, sent, KEY_SALT, USER_SALT, BOARD_ADMIN_TOKEN: ADMIN, ALLOWED_ORIGINS: "", BOARD_ROOM: { idFromName: () => "r", get: () => room }, DISCORD_PUBLIC_KEY: signer.publicKeyHex, BOARD_PUBLIC_URL: "https://leeroy.test" };
}
const signer = createDiscordSigner();
let ipN = 0;
const http = async (env, method, path, { headers = {}, body } = {}) => {
  const init = { method, headers: { "CF-Connecting-IP": `203.0.113.${(ipN++ % 200) + 1}`, ...headers } };
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers["Content-Type"] = "application/json"; }
  const res = await quiet(() => worker.fetch(new Request(`${ORIGIN}/api${path}`, init), env, ctx));
  return { status: res.status, text: await res.text() };
};
const slash = (name, options = []) => ({ id: String(900000000000000000n + BigInt(++ipN)), type: 2, application_id: "100000000000000099", token: "tok", guild_id: "200000000000000001", data: { name, type: 1, options }, member: { user: { id: "100000000000000900", username: "asker" }, permissions: "0" } });
const discord = async (env, payload) => quiet(async () => { const res = await handleDiscordInteraction(signer.signedRequest(payload), env, ctx, ORIGIN); const t = await res.text(); return t; });

// ---- the table of read paths --------------------------------------------------------------------------------------------------------
// Each entry: id, the ROUTES (or "discord:<command>") it covers, and run(env) -> [{ where, text }].
const stored = (env, key) => env.DB.raw.prepare("SELECT json FROM kv_state WHERE key = ?").get(key).json;
const ANON = ["/state", "/state?full=1&roster=1&admin=1&raw=1", "/bootstrap", "/bootstrap?full=1&roster=1&admin=1", "/data/party", "/data/party.json", "/data/party?full=1&roster=1", "/data/decide", "/data/decide.json", "/data/tonight", "/data/tonight.json", "/data/guided-atlas", "/data/guided-atlas.json", "/data/client", "/data/client.json", "/data/launch", "/data/launch.json", "/data//party", "/data/part%79", "/data//guided-atlas"];
const READS = [
  ...ANON.map((p) => ({ id: `GET ${p}`, covers: [p.startsWith("/state") ? "GET /state" : p.startsWith("/bootstrap") ? "GET /bootstrap" : "GET /data/*"], run: async (env) => { const r = await http(env, "GET", p); assert.equal(r.status, 200, p); return [{ where: `GET ${p}`, text: r.text }]; } })),
  { id: "GET /sheet as another member", covers: ["ANY /sheet"], run: async (env) => { const r = await http(env, "GET", "/sheet", { headers: { Authorization: `Board ${ASKER_KEY}` } }); assert.equal(r.status, 200, r.text); return [{ where: "GET /sheet (a member reading the party)", text: r.text }]; } },
  { id: "broadcast of a party document (admin PUT /data/party)", covers: ["PUT /data/*", "ANY /live"], run: async (env) => { const full = JSON.parse(stored(env, "party")); env.sent.length = 0; const r = await http(env, "PUT", "/data/party", { headers: { Authorization: `Bearer ${ADMIN}` }, body: full }); assert.equal(r.status, 200, r.text); assert.ok(env.sent.length > 0, "a broadcast was sent"); return env.sent.map((t) => ({ where: "socket: PUT /data/party", text: t })); } },
  { id: "broadcast of decide and tonight (admin PUT)", covers: ["PUT /data/*", "ANY /live"], run: async (env) => { env.sent.length = 0; for (const n of ["decide", "tonight"]) assert.equal((await http(env, "PUT", `/data/${n}`, { headers: { Authorization: `Bearer ${ADMIN}` }, body: JSON.parse(stored(env, n)) })).status, 200); return env.sent.map((t) => ({ where: "socket: PUT /data/decide|tonight", text: t })); } },
  { id: "broadcast {type:data,key:party} from the Worker (a /build)", covers: ["POST /discord", "ANY /live"], run: async (env) => { env.sent.length = 0; await quiet(() => broadcastToRoom(env, { type: "data", key: "party", data: JSON.parse(stored(env, "party")) })); return env.sent.map((t) => ({ where: "socket: /build broadcast", text: t })); } },
  { id: "broadcast {type:state} after a sheet write (POST /sheet)", covers: ["ANY /sheet", "ANY /live"], run: async (env) => { env.sent.length = 0; const r = await http(env, "POST", "/sheet", { headers: { Authorization: `Board ${ASKER_KEY}` }, body: { field: "goals", value: "zqaskergoal", visible: true } }); assert.equal(r.status, 200, r.text); return env.sent.map((t) => ({ where: "socket: sheet write", text: t })); } },
  { id: "Discord /tonight", covers: ["POST /discord", "discord:tonight"], run: async (env) => [{ where: "/tonight", text: await discord(env, slash("tonight")) }] },
  { id: "Discord /sheet for each member", covers: ["POST /discord", "discord:sheet"], run: async (env) => { const out = []; for (let i = 0; i < NAMES.length; i++) out.push({ where: `/sheet ${NAMES[i]}`, text: await discord(env, slash("sheet", [{ name: "member", type: 6, value: `10000000000000010${i}` }])), member: i }); return out; } },
  { id: "the sign-up and party cards", covers: ["POST /discord", "discord:signup"], run: async (env) => { const st = await loadCardState(env); return [{ where: "cards", text: JSON.stringify([renderBoardCard(st), renderSignupCard(st)]) }]; } },
  { id: "the ask prompt", covers: ["POST /intent", "discord:ask"], run: async (env) => { const q = await buildAnswerInputs(env, { question: "Who is in the party and what do they play?", by: "Asker X", memberSlug: "asker-x", isMember: true, share: true }); return [{ where: "ask prompt", text: `${q.systemPrompt}\n${q.userPrompt}` }]; } },
];

test("every route and Discord command that carries member data is covered by a read in READS", () => {
  const covered = new Set(READS.flatMap((r) => r.covers));
  for (const [route, kind] of Object.entries(ROUTE_CLASS)) if (kind === "member") assert.ok(covered.has(route), `${route} carries member data but no read covers it`);
  for (const [cmd, kind] of Object.entries(DISCORD_CLASS)) if (kind === "member") assert.ok(covered.has(`discord:${cmd}`), `/${cmd} carries member data but no read covers it`);
});

// ---- the leak check -------------------------------------------------------------------------------------------------------------------------
function leaks(text, { member } = {}) {
  const bad = [];
  const lo = (m) => member === undefined || member === m;
  for (let i = 0; i < NAMES.length; i++) {
    if (!lo(i) && member !== undefined) continue;
    for (const k of docGone(i)) if (text.includes(cDoc(i, k))) bad.push(`${NAMES[i]} doc ${k}`);
    for (const f of sheetGone(i)) { if (f === "level") continue; if (text.includes(cSheet(i, f))) bad.push(`${NAMES[i]} sheet ${f}`); }
  }
  // The composites. Every fixture reader has a member who hides something, so NO member-derived section of any composite may appear, for anyone: not the entries of members who hide
  // nothing, not a line that names none. These are the canaries of every such section; each one is in the stored rows.
  const composite = ["zqdprof", "zqdspec", "zqdtalents", "zqdlocked", "zqdrace", "zqdgroup", "zqdoption", "zqdline", "zqdrole", "zqdnobody", "zqdbuff", "zqdsecondary", "zqdnote", "zqdgeneric",
    "zqtstep", "zqatlasstart", "zqtown", "zqtrainer", "zqspell", "zqracial", "zqsynergy", "zqbuff", "zqsettled", "zqextra", "zqgap", "zqopenkept"];
  for (const c of composite) if (text.includes(c)) bad.push(c);
  return bad;
}
test("the fixture itself is unprojected: every hidden value is in the stored rows", async () => {
  const env = await makeEnv();
  const all = stored(env, "party") + stored(env, "decide") + stored(env, "tonight");
  for (let i = 0; i < NAMES.length; i++) for (const k of docGone(i)) assert.ok(all.includes(cDoc(i, k)), `stored party holds ${NAMES[i]} ${k}`);
  assert.ok(leaks(all).length > 20, "a read of the stored rows leaks, so the check can fail");
});

for (const read of READS) {
  test(`anonymous read path: ${read.id} shows nothing a member hid (and still shows the rest)`, async () => {
    const env = await makeEnv();
    const surfaces = await read.run(env);
    assert.ok(surfaces.length > 0 && surfaces.every((s) => s.text && s.text.length > 20), "the read returned something");
    for (const s of surfaces) {
      const bad = leaks(s.text, s.member === undefined ? {} : { member: s.member });
      assert.deepEqual(bad, [], `${s.where} leaks`);
    }
  });
}

// non-vacuous: the same reads, with nothing hidden, show every canary the table says they carry
test("with nothing hidden the same reads show the build (so a read of an empty document cannot pass)", async () => {
  const env = await makeEnv({ hides: NAMES.map(() => []) });
  const party = JSON.parse((await http(env, "GET", "/data/party")).text);
  for (let i = 0; i < NAMES.length; i++) { const m = party.members[i]; for (const k of DOC_KEYS) assert.deepEqual(m[k], docValue(i, k), `${NAMES[i]} ${k}`); }
  assert.equal(party.settled.length, 6); assert.equal(party.settled_extra.length, 2); assert.ok(party.open[0].text.includes("zqgapdrop"));
  const decide = JSON.parse((await http(env, "GET", "/data/decide")).text);
  assert.equal(decide.people.length, 8); assert.ok(decide.party.brackets.length === 1 && decide.party.role_lines.length === 1);
  const tonight = JSON.parse((await http(env, "GET", "/data/tonight")).text);
  assert.equal(tonight.people.length, 8); assert.ok(tonight.people.every((p) => p.class_key && p.step)); assert.equal(Object.keys(tonight.week_one.trainers).length, 8);
  const st = JSON.parse((await http(env, "GET", "/state")).text);
  assert.equal(st.party.length, 8); for (const s of st.party) assert.equal(Object.keys(s.fields).length, 9);
});

test("what stays shown: role for every member, names, the control's whole build, the owner of nothing is special", async () => {
  const env = await makeEnv();
  const party = JSON.parse((await http(env, "GET", "/data/party")).text);
  NAMES.forEach((n, i) => { assert.equal(party.members[i].name, n); assert.equal(party.members[i].role, cDoc(i, "role"), `${n}: role is always shown`); });
  for (const k of DOC_KEYS) assert.deepEqual(party.members[CONTROL][k], docValue(CONTROL, k), `control ${k}`);
  assert.deepEqual(Object.keys(party.members[ALLHID]).sort(), ["name", "role"], "a member who hides everything shows a name and a role");
  assert.deepEqual(party.members[0].professions, docValue(0, "professions"), "another field of a member who hid only race stays");
  const st = JSON.parse((await http(env, "GET", "/state")).text);
  assert.deepEqual(Object.keys(st.party[ALLHID].fields), [], "all hidden: no sheet field");
  assert.deepEqual(Object.keys(st.party[1].fields).sort(), ["goals", "launch_state", "level", "plan_zone", "professions", "race"], "class hidden also removes spec_path and spec_at_40 from the sheet");
  assert.deepEqual(Object.keys(st.party[0].fields).sort(), ["class", "goals", "launch_state", "level", "professions", "spec_at_40", "spec_path"], "race hidden also removes plan_zone from the sheet");
  // the composites: withheld whole, with the one line; what does not depend on the party stays
  const d = JSON.parse((await http(env, "GET", "/data/decide")).text);
  assert.equal(d.withheld, WITHHELD_LINE); assert.deepEqual(d.people, []); assert.deepEqual(d.party.brackets, []); assert.deepEqual(d.party.lines, []);
  const t = JSON.parse((await http(env, "GET", "/data/tonight")).text);
  assert.equal(t.withheld, WITHHELD_LINE); assert.deepEqual(t.people, []); assert.deepEqual(t.week_one.trainers, {}); assert.equal(t.launch, "Launch zqtgeneric", "the launch line does not depend on the party");
  const a = JSON.parse((await http(env, "GET", "/data/guided-atlas")).text);
  assert.equal(a.withheld, WITHHELD_LINE); assert.deepEqual(a.classes, {}); assert.equal(a.dungeon.name, "zqdungeonkept"); assert.equal(a.meet.name, "zqmeetkept"); assert.equal(a.starter_cap.level, 5);
  const c = JSON.parse((await http(env, "GET", "/data/client")).text);
  assert.equal(c.withheld, WITHHELD_LINE); assert.deepEqual([c.classes, c.racials, c.synergy, c.buffs.list, c.buffs.rules], [{}, {}, [], [], []]);
  assert.deepEqual(c.buffs.marks, [20, 40, 60]); assert.equal(c.level, 60); assert.equal(c.legacy.total, 65);
  assert.equal(party.withheld, WITHHELD_LINE); assert.deepEqual([party.settled, party.settled_extra, party.open], [[], [], []]);
  assert.equal(st.decide.withheld, WITHHELD_LINE); assert.equal(st.partyDoc.withheld, WITHHELD_LINE); assert.equal(st.tonight.withheld, WITHHELD_LINE);
  const bs = JSON.parse((await http(env, "GET", "/bootstrap")).text);
  assert.ok(JSON.stringify(bs).includes(WITHHELD_LINE), "the bootstrap bundle carries the line too");
});

// ---- the stored rows are whole, and every writer keeps them whole ---------------------------------------------------------------------------
test("a hide (POST /sheet) stores the whole party document; showing the field again changes nothing stored", async () => {
  const env = await makeEnv({ hides: NAMES.map(() => []), apiControl: true });
  const auth = { Authorization: `Board ${ASKER_KEY}` };
  const before = stored(env, "party");
  // the asker has no party-document card, so use the member whose card it is: add a key for the control member
  env.DB.raw.prepare("INSERT INTO members (slug, key_hash, created_at) VALUES (?, ?, ?)").run(SLUG[CONTROL], await sha256Hex(`${KEY_SALT}:ctl-key-0123456789abcdef0123`), AT);
  const ctl = { Authorization: "Board ctl-key-0123456789abcdef0123" };
  for (const field of ["race", "class", "spec_path", "professions", "plan_zone"]) {
    const h = await http(env, "POST", "/sheet", { headers: ctl, body: { field, value: API_VAL[field], visible: false } });
    assert.equal(h.status, 200, h.text);
    assert.equal(stored(env, "party"), before, `hide ${field}: the stored party row is unchanged`);
    const s = await http(env, "POST", "/sheet", { headers: ctl, body: { field, value: API_VAL[field], visible: true } });
    assert.equal(s.status, 200, s.text);
    assert.equal(stored(env, "party"), before, `show ${field}: the stored party row is byte-identical`);
  }
  void auth;
});

test("admin PUT of a whole party document: stored whole; a hide that commits before it still hides on every read and in the broadcast (the PUT race)", async () => {
  const env = await makeEnv();
  const withValue = JSON.parse(stored(env, "party"));
  withValue.members[1].class = cDoc(1, "class"); // the admin's copy carries Bren's class; Bren hid it a moment ago
  const put = await http(env, "PUT", "/data/party", { headers: { Authorization: `Bearer ${ADMIN}` }, body: withValue });
  assert.equal(put.status, 200);
  assert.ok(stored(env, "party").includes(cDoc(1, "class")), "the stored row may hold the value");
  assert.ok(!(await http(env, "GET", "/data/party")).text.includes(cDoc(1, "class")));
  assert.ok(!(await http(env, "GET", "/state")).text.includes(cDoc(1, "class")));
  assert.ok(!(await http(env, "GET", "/bootstrap")).text.includes(cDoc(1, "class")));
  assert.ok(env.sent.length > 0 && env.sent.every((t) => !t.includes(cDoc(1, "class"))), "the PUT broadcast is projected");
});

// ---- junk rows, unreadable sheets, fail closed -----------------------------------------------------------------------------------------
test("null and junk rows in party_sheets are skipped; the rest is projected; nothing is served unprojected and nothing throws", async () => {
  const junk = [null, 7, "x", [], { slug: 5 }, { slug: "t", name: null, fields: null }, { slug: "u", name: "Nobody", fields: [] }, ...sheetList()];
  const env = await makeEnv({ sheets: junk });
  for (const p of ["/state", "/bootstrap", "/data/party", "/data/decide", "/data/tonight"]) {
    const r = await http(env, "GET", p);
    assert.equal(r.status, 200, p);
    assert.deepEqual(leaks(r.text), [], p);
  }
  const st = JSON.parse((await http(env, "GET", "/state")).text);
  assert.ok(st.party.every((s) => s && typeof s === "object" && !Array.isArray(s)), "no null or junk row in the public sheet list");
  assert.ok(st.party.some((s) => s.slug === SLUG[CONTROL]));
  assert.equal(stored(env, "party_sheets").startsWith("[null,7"), true, "the stored sheets row is untouched");
});

test("a party_sheets row that is not a list is rebuilt from the sheet events, which keep the hide", async () => {
  const env = await makeEnv({ sheets: "null" });
  env.DB.raw.prepare("INSERT INTO sheet_events (slug, name, field, value_json, visible, source, created_at) VALUES (?, ?, 'class', ?, 0, 'board', ?)").run(SLUG[1], NAMES[1], JSON.stringify("zqsclass1x"), AT);
  const text = (await http(env, "GET", "/data/party")).text;
  assert.ok(!text.includes(cDoc(1, "class")) && !text.includes(cDoc(1, "class_key")));
});

test("when the sheets cannot be read at all, every projection hides everything (fail closed), and nothing throws", async () => {
  const doc = partyDoc();
  const out = projectForAnonymous(doc, null);
  for (const m of out.members) assert.deepEqual(Object.keys(m).sort(), ["name", "role"]);
  assert.deepEqual([out.settled, out.settled_extra, out.open, out.withheld], [[], [], [], WITHHELD_LINE], "unreadable sheets: the party document's lines are withheld");
  assert.deepEqual(projectDecide(decideDoc(), doc, null).people, []);
  assert.equal(projectDecide(decideDoc(), doc, null).withheld, WITHHELD_LINE);
  assert.deepEqual(projectTonight(tonightDoc(), doc, null).people, []);
  assert.deepEqual(projectGuidedAtlas(atlasDoc(), doc, null).classes, {});
  assert.deepEqual(projectClient(clientDoc(), doc, null).classes, {});
  assert.deepEqual(projectSheets(null), []);
  const broken = { DB: { prepare: () => { throw new Error("D1 down"); } } };
  const inputs = await loadPublicInputs(broken);
  assert.equal(inputs.sheets, null);
  assert.ok(projectForAnonymous(doc, inputs.sheets).members.every((m) => Object.keys(m).length === 2));
  // junk inputs never throw
  for (const d of [null, undefined, 5, "x", [], {}, { members: null }, { members: [null, 3, "x", {}] }]) { projectForAnonymous(d, sheetList()); projectDecide(d, d, sheetList()); projectTonight(d, d, sheetList()); projectDataDoc("party", d, { sheets: [null] }); projectBroadcast(d, {}); }
});

// ---- the cascade, hand-written -----------------------------------------------------------------------------------------------------------
for (const field of SHEET_FIELDS) {
  test(`cascade: hiding ${field} removes exactly what the approved table says, in the party document and in the public sheet`, () => {
    const hides = NAMES.map((_, i) => (i === 1 ? [field] : []));
    const out = projectForAnonymous(partyDoc(), sheetList(hides)).members;
    const m = out[1], whole = partyDoc().members[1];
    for (const k of Object.keys(whole)) assert.equal(k in m, !DOC_GONE[field].includes(k), `${field}: ${k}`);
    assert.equal("role" in m, true, "role is never removed");
    assert.deepEqual(out[0], partyDoc().members[0], "a member who hides nothing is untouched");
    const sheet = projectSheets(sheetList(hides))[1];
    assert.deepEqual(SHEET_FIELDS.filter((f) => f in sheet.fields).sort(), SHEET_FIELDS.filter((f) => !SHEET_GONE[field].includes(f)).sort(), `${field}: sheet fields`);
    for (const k of DOC_GONE[field]) assert.ok(CASCADE[field].doc.includes(k), `the module's cascade for ${field} includes ${k}`);
    for (const k of SHEET_GONE[field]) assert.ok(CASCADE[field].sheet.includes(k), `the module's sheet cascade for ${field} includes ${k}`);
    assert.ok(!CASCADE[field].doc.includes("role") && !CASCADE[field].doc.includes("name"));
  });
}

test("the owner's own sheet stays whole; the projection never changes its input", () => {
  const sheets = sheetList();
  const copy = JSON.stringify(sheets);
  const mine = projectSheets(sheets, SLUG[ALLHID]).find((s) => s.slug === SLUG[ALLHID]);
  assert.equal(Object.keys(mine.fields).length, 9);
  const doc = partyDoc(), docCopy = JSON.stringify(doc);
  projectForAnonymous(doc, sheets); projectDecide(decideDoc(), doc, sheets); projectTonight(tonightDoc(), doc, sheets);
  assert.equal(JSON.stringify(sheets), copy); assert.equal(JSON.stringify(doc), docCopy);
});


// ---- the choke points -------------------------------------------------------------------------------------------------------------------
test("a mutation guard: reading the stored documents without the projection leaks, so every path above is doing real work", async () => {
  const env = await makeEnv();
  for (const key of ["party", "decide", "tonight"]) assert.ok(leaks(stored(env, key)).length > 0, `the stored ${key} row leaks if served as it is`);
});

test("a null or junk row in party_sheets does not break a sheet write either (the write skips it)", async () => {
  const env = await makeEnv({ sheets: [null, 7, ...sheetList()] });
  const r = await http(env, "POST", "/sheet", { headers: { Authorization: `Board ${ASKER_KEY}` }, body: { field: "goals", value: "zqaskergoal2", visible: true } });
  assert.equal(r.status, 200, r.text);
  const rows = JSON.parse(stored(env, "party_sheets"));
  assert.ok(rows.every((s) => s && typeof s === "object") && rows.some((s) => s.slug === "asker-x"));
});

// ---- round 3: guided-atlas and client, decide text, the stored read, the cache, fail closed, launch, surviving mutations --------------------------------
const getJson = async (env, p, headers) => { const r = await http(env, "GET", p, { headers }); assert.equal(r.status, 200, `${p}: ${r.text.slice(0, 120)}`); return JSON.parse(r.text); };
const keyFor = async (env, i) => { const k = `member-key-${i}-0123456789abcdef0123`; env.DB.raw.prepare("INSERT INTO members (slug, key_hash, created_at) VALUES (?, ?, ?)").run(SLUG[i], await sha256Hex(`${KEY_SALT}:${k}`), AT); return { Authorization: `Board ${k}` }; };
const KEYS = (c) => Object.keys(c).sort();






test("tools/add-member.mjs reads the STORED party document (admin token), so hide, add a member, un-hide loses nothing", async () => {
  const { applyPlan, buildPlan } = await import("../../tools/add-member.mjs");
  const env = await makeEnv({ hides: NAMES.map(() => []), apiControl: true });
  const ctl = await keyFor(env, CONTROL);
  for (const f of ["class", "race", "professions"]) assert.equal((await http(env, "POST", "/sheet", { headers: ctl, body: { field: f, value: API_VAL[f], visible: false } })).status, 200);
  // the public read has the control's class cut out; the stored read has it
  assert.ok(!(await http(env, "GET", "/data/party")).text.includes(cDoc(CONTROL, "class")));
  const anon = await http(env, "GET", "/data/party?stored=1");
  assert.equal(anon.status, 401, "anonymous: refused");
  assert.equal((await http(env, "GET", "/data/party?stored=1", { headers: ctl })).status, 401, "a member key: refused");
  const storedRead = await http(env, "GET", "/data/party?stored=1", { headers: { Authorization: `Bearer ${ADMIN}` } });
  assert.equal(storedRead.status, 200); assert.ok(storedRead.text.includes(cDoc(CONTROL, "class")) && storedRead.text.includes(cDoc(CONTROL, "race")), "the stored read is whole");
  // run the tool's own apply path against this Worker
  const fetchImpl = async (url, init = {}) => { const u = new URL(url); const r = await quiet(() => worker.fetch(new Request(url, { ...init, headers: { "CF-Connecting-IP": "203.0.113.77", ...(init.headers || {}) } }), env, ctx)); return r; };
  const plan = buildPlan({ name: "Newcomer Vale", class: "mage", race: "gnome", id: "100000000000000999" }, null);
  assert.ok(plan.ok !== false, JSON.stringify(plan.errors));
  const res = await applyPlan(plan, { api: ORIGIN, env: { BOARD_ADMIN_TOKEN: ADMIN }, fetchImpl, backupPath: join(tmpdir(), `add-member-backup-${process.pid}.json`) });
  const after = JSON.parse(stored(env, "party"));
  assert.ok(res.ok, JSON.stringify(res.log));
  assert.ok(after.members.some((m) => m.name === "Newcomer Vale"), "the member was added");
  assert.equal(after.members[CONTROL].class, cDoc(CONTROL, "class"), "the hidden class is still in the stored row");
  assert.equal(after.members[CONTROL].race, cDoc(CONTROL, "race"));
  assert.deepEqual(after.members[CONTROL].professions, docValue(CONTROL, "professions"));
  for (const f of ["class", "race", "professions"]) assert.equal((await http(env, "POST", "/sheet", { headers: ctl, body: { field: f, value: API_VAL[f], visible: true } })).status, 200);
  const shown = await getJson(env, "/data/party");
  for (const k of ["class", "race", "class_key", "professions", "spec", "color"]) assert.deepEqual(shown.members[CONTROL][k], docValue(CONTROL, k), `un-hidden: ${k} is back`);
  try { unlinkSync(res.backup); } catch {}
});

// F4: a hide purges every member document, whatever spelling it was read under
const SPELLINGS = (n) => [`/data/${n}`, `/data/${n}.json`, `/data//${n}`, `/data/${n.slice(0, -1)}%${n.charCodeAt(n.length - 1).toString(16)}`, `/data/%${n.charCodeAt(0).toString(16)}${n.slice(1)}.json`];
const HIDE_FOR = { party: ["class", cDoc(CONTROL, "class")], decide: ["class", cDoc(CONTROL, "class_key")], tonight: ["class", cDoc(CONTROL, "class_key")], "guided-atlas": ["class", cDoc(CONTROL, "class_key")], client: ["class", cDoc(CONTROL, "class")], launch: ["launch_state", cSheet(CONTROL, "launch_state")] };
for (const name of MEMBER_DOCS) {
  test(`cache: read ${name} in every spelling, hide, read again: nothing stale (the hide purges every member document and every spelling shares one entry)`, async () => {
    const env = await makeEnv({ hides: NAMES.map(() => []), apiControl: true });
    const [field, canary] = HIDE_FOR[name];
    const ctl = await keyFor(env, CONTROL);
    for (const p of SPELLINGS(name)) { const r = await http(env, "GET", p); assert.equal(r.status, 200, p); assert.ok(r.text.includes(canary), `before the hide ${p} shows the value`); }
    const value = field === "launch_state" ? "in" : API_VAL[field];
    assert.equal((await http(env, "POST", "/sheet", { headers: ctl, body: { field, value, visible: false } })).status, 200);
    for (const p of SPELLINGS(name)) { const r = await http(env, "GET", p); assert.equal(r.status, 200, p); assert.ok(!r.text.includes(canary), `after the hide ${p} is fresh`); }
  });
}
test("cache: PARTY_CACHE_PATHS lists every member document, both spellings, and the two documents that embed them", () => {
  for (const n of MEMBER_DOCS) for (const p of [`/api/data/${n}`, `/api/data/${n}.json`]) assert.ok(PARTY_CACHE_PATHS.includes(p), p);
  assert.ok(PARTY_CACHE_PATHS.includes("/api/state") && PARTY_CACHE_PATHS.includes("/api/bootstrap"));
});

// F6: fail closed
test("a stored sheet row that is junk, after a real hide: the hide comes from the sheet events and every read still hides it", async () => {
  const env = await makeEnv({ sheets: [null, 5, "x"] });
  env.DB.raw.prepare("INSERT INTO sheet_events (slug, name, field, value_json, visible, source, created_at) VALUES (?, ?, 'class', ?, 0, 'board', ?)").run(SLUG[1], NAMES[1], JSON.stringify("zqsclass1x"), AT);
  for (const p of ["/data/party", "/state", "/bootstrap", "/data/decide", "/data/guided-atlas", "/data/client"]) {
    const r = await http(env, "GET", p); assert.equal(r.status, 200, p);
    assert.ok(!r.text.includes(cDoc(1, "class")) && !r.text.includes(cDoc(1, "class_key")), `${p} hides the class of the member who hid it`);
  }
  const party = await getJson(env, "/data/party");
  assert.equal(party.members[0].class, cDoc(0, "class"), "a member with no hide event is shown (a new person is not hidden)");
});

test("a hider renamed by an admin PUT: the old sheet belongs to nobody in the document, its hidden fields apply to the new row", async () => {
  const sheets = sheetList().map((s, i) => (i === 1 ? { ...s, name: "Bren Old", slug: "bren-old" } : s));
  const env = await makeEnv({ sheets });
  const party = await getJson(env, "/data/party");
  const bren = party.members.find((m) => m.name === NAMES[1]);
  assert.ok(bren && !("class" in bren) && !("class_key" in bren), "the renamed member keeps the hide");
});

test("sheet_events cannot be read and the sheets row is empty: nothing is shown (null inputs, every member reduced to name and role), not the visible-everything seed", async () => {
  const env = await makeEnv({ sheets: [] });
  const real = env.DB.prepare.bind(env.DB);
  const broken = { ...env.DB, prepare: (sql) => { if (/sheet_events/i.test(sql) && /select/i.test(sql)) throw new Error("D1 down"); return real(sql); } };
  const e2 = { ...env, DB: broken };
  const inputs = await loadPublicInputs(e2);
  assert.equal(inputs.sheets, null);
  const r = await http(e2, "GET", "/data/party"); assert.equal(r.status, 200);
  for (const m of JSON.parse(r.text).members) assert.deepEqual(Object.keys(m).sort(), ["name", "role"]);
  for (const p of ["/state", "/bootstrap", "/data/decide", "/data/guided-atlas", "/data/client", "/data/tonight"]) assert.ok(!leaks((await http(e2, "GET", p)).text).length, p);
  const st = JSON.parse((await http(e2, "GET", "/state")).text);
  assert.ok(st.party.every((s) => Object.keys(s.fields).length === 0), "no sheet field for anyone");
  // the callers that are not strict (the Discord /tonight, an authed GET /sheet) get every field hidden, not the seed
  const { buildPartySheetsFromD1 } = await import("../../infrastructure/worker/index.js");
  const lax = await buildPartySheetsFromD1(e2, { persist: true });
  assert.ok(lax.party.length > 0 && lax.party.every((s) => Object.values(s.fields).every((f) => f.visible === false)));
  assert.equal(env.DB.raw.prepare("SELECT json FROM kv_state WHERE key = 'party_sheets'").get().json, "[]", "nothing was persisted from the failed read");
});


// F8: launch
test("launch: a member who hid launch_state is not in /state.launch, /data/launch, the broadcast or the Discord /launch reply; the stored row keeps it", async () => {
  const env = await makeEnv();
  const state = await getJson(env, "/state");
  assert.ok(state.launch.length === NAMES.length && state.launch.find((r) => r.slug === SLUG[ALLHID]).state === undefined);
  assert.equal(state.launch.find((r) => r.slug === SLUG[0]).state, cSheet(0, "launch_state"));
  const doc = await getJson(env, "/data/launch");
  assert.equal(doc.find((r) => r.slug === SLUG[ALLHID]).state, undefined);
  assert.ok(stored(env, "launch").includes(cSheet(ALLHID, "launch_state")), "stored whole");
  env.sent.length = 0;
  await quiet(() => broadcastToRoom(env, { type: "data", key: "launch", data: JSON.parse(stored(env, "launch")) }));
  assert.ok(env.sent.length === 1 && !env.sent[0].includes(cSheet(ALLHID, "launch_state")) && env.sent[0].includes(cSheet(0, "launch_state")));
  // Discord /launch only lists the states before launch (after launch it answers one line and records nothing), so pin the clock before it.
  const realNow = Date.now;
  Date.now = () => LAUNCH_EPOCH * 1000 - 3600000;
  let reply;
  try { reply = await discord(env, slash("launch")); } finally { Date.now = realNow; }
  assert.ok(!reply.includes(cSheet(ALLHID, "launch_state")), "the Discord reply");
  assert.ok(reply.includes(cSheet(0, "launch_state")), "and it still lists the others");
  assert.ok(stored(env, "launch").includes(cSheet(ALLHID, "launch_state")), "reading /launch did not rewrite the stored list");
});
test("launch: {rows:[...]} form, owner sees own row, unreadable sheets show no state", () => {
  const rows = [{ slug: "a-a", name: "A A", state: "in" }, { slug: "b-b", name: "B B", state: "queue" }];
  const sheets = [{ slug: "a-a", name: "A A", fields: { launch_state: { value: "in", visible: false } } }, { slug: "b-b", name: "B B", fields: {} }];
  assert.deepEqual(projectLaunch({ rows, voice: "v" }, sheets), { rows: [{ slug: "a-a", name: "A A" }, rows[1]], voice: "v" });
  assert.deepEqual(projectLaunch(rows, sheets, "a-a"), rows);
  assert.deepEqual(projectLaunch(rows, null), [{ slug: "a-a", name: "A A" }, { slug: "b-b", name: "B B" }]);
});

// ---- surviving mutations ------------------------------------------------------------------------------------------------------------------
const hideOne = (f) => NAMES.map((_, i) => (i === 3 ? [f] : []));


test("loadPublicInputs: a failed sheets read is null (fail closed), never an empty list; and the party read failing is null too", async () => {
  const env = await makeEnv();
  const real = env.DB.prepare.bind(env.DB);
  const sheetsDown = { ...env, DB: { ...env.DB, prepare: (sql) => (/party_sheets/.test(sql) ? (() => { throw new Error("down"); })() : real(sql)) } };
  const a = await loadPublicInputs(sheetsDown); assert.equal(a.sheets, null); assert.ok(a.partyDoc && a.partyDoc.members);
  assert.ok(projectForAnonymous(a.partyDoc, a.sheets).members.every((m) => Object.keys(m).length === 2));
  const partyDown = { ...env, DB: { ...env.DB, prepare: (sql) => (/key = 'party'/.test(sql) ? (() => { throw new Error("down"); })() : real(sql)) } };
  const b = await loadPublicInputs(partyDown); assert.equal(b.sheets, null); assert.equal(b.partyDoc, null);
  assert.deepEqual((await loadPublicInputs(env, { sheets: "nope" })).sheets, null);
});

test("GET /data/<member doc> that cannot be projected is an error, never the stored document", async () => {
  for (const name of MEMBER_DOCS) {
    const env = await makeEnv();
    env.DB.raw.prepare("UPDATE kv_state SET json = ? WHERE key = ?").run("{not json zq" + name, name);
    const r = await http(env, "GET", `/data/${name}`);
    assert.equal(r.status, 500, name); assert.ok(!r.text.includes("zq" + name), name);
  }
});

test("projectSheets: a sheet whose fields are junk (a list, a string, a number, null) serves no fields, never the junk", () => {
  const rows = [{ slug: "a", name: "A", fields: [{ race: { value: "zq", visible: true } }] }, { slug: "b", name: "B", fields: "zqrace" }, { slug: "c", name: "C", fields: 5 }, { slug: "d", name: "D", fields: null }, { slug: "e", name: "E" }];
  for (const r of projectSheets(rows)) assert.deepEqual(r.fields, {}, r.slug);
  assert.deepEqual(projectSheets(rows, "a")[0].fields, rows[0].fields, "the owner's own row is returned as it is");
});

// ---- round 4: mutation survivors ------------------------------------------------------------------------------------------------------------


test("sheet_events cannot be read while party_sheets holds only junk: every read fails closed (name and role only)", async () => {
  const env = await makeEnv({ sheets: [null, 5, "x"] });
  const real = env.DB.prepare.bind(env.DB);
  const e2 = { ...env, DB: { ...env.DB, prepare: (sql) => { if (/sheet_events/i.test(sql) && /select/i.test(sql)) throw new Error("D1 down"); return real(sql); } } };
  assert.equal((await loadPublicInputs(e2)).sheets, null);
  for (const m of JSON.parse((await http(e2, "GET", "/data/party")).text).members) assert.deepEqual(Object.keys(m).sort(), ["name", "role"]);
});

// ---- round 4: the composites are withheld whole (the design: fail closed, no text matching) ------------------------------------------------------------
// One member of eight hides one field. Every composite must then lose every member-derived section and carry the one line; what does not depend on the party stays.
const NOBODY = () => NAMES.map(() => []);
const COMPOSITES = {
  party: { project: (sh) => projectForAnonymous(partyDoc(), sh), sections: (o) => [o.settled, o.settled_extra, o.open], empty: [[], [], []], stays: (o) => o.faction === "Horde" && o.members.length === 8 },
  decide: { project: (sh) => projectDecide(decideDoc(), partyDoc(), sh), sections: (o) => [o.people, o.party.brackets, o.party.role_lines, o.party.buffs, o.party.nobody, o.party.lines], empty: [[], [], [], [], { classes: [], professions: [], secondaries: [], buffs: [] }, []], stays: (o) => o.generated === AT && typeof o.labels === "object" },
  tonight: { project: (sh) => projectTonight(tonightDoc(), partyDoc(), sh), sections: (o) => [o.people, o.week_one.trainers], empty: [[], {}], stays: (o) => o.launch === "Launch zqtgeneric" && o.week_one.first_dungeon === null },
  "guided-atlas": { project: (sh) => projectGuidedAtlas(atlasDoc(), partyDoc(), sh), sections: (o) => [o.classes], empty: [{}], stays: (o) => o.dungeon.name === "zqdungeonkept" && o.meet.name === "zqmeetkept" && o.starter_cap.level === 5 },
  client: { project: (sh) => projectClient(clientDoc(), partyDoc(), sh), sections: (o) => [o.classes, o.racials, o.synergy, o.buffs.list, o.buffs.rules], empty: [{}, {}, [], [], []], stays: (o) => o.level === 60 && o.legacy.total === 65 && o.buffs.marks.length === 3 && o.buffs.levels.length === 2 },
};
for (const [name, c] of Object.entries(COMPOSITES)) {
  for (const f of SHEET_FIELD_NAMES) {
    test(`composite ${name}: one member hiding only ${f} withholds every member-derived section and carries the one line`, () => {
      const out = c.project(sheetList(hideOne(f)));
      assert.equal(out.withheld, WITHHELD_LINE);
      assert.deepEqual(c.sections(out), c.empty, `${name}: sections`);
      assert.ok(c.stays(out), `${name}: what does not depend on the party stays`);
    });
  }
  test(`composite ${name}: nobody hides anything: the document is served as it is; unreadable sheets withhold`, () => {
    const whole = c.project(sheetList(NOBODY()));
    assert.equal(whole.withheld, undefined);
    assert.deepEqual(whole, c.project(sheetList(NOBODY())));
    assert.notDeepEqual(c.sections(whole), c.empty, `${name}: the sections are there when nobody hides`);
    assert.equal(c.project(null).withheld, WITHHELD_LINE, "sheets that cannot be read");
  });
}
test("a sheet of a person the party document does not list still withholds when it hides a field", () => {
  const rows = [...sheetList(NOBODY()), { slug: "outsider", name: "Outsider", fields: { goals: { value: "x", visible: false } } }];
  assert.equal(anyHidden(partyDoc(), rows), true);
  assert.equal(projectDecide(decideDoc(), partyDoc(), rows).withheld, WITHHELD_LINE);
  assert.equal(anyHidden(partyDoc(), sheetList(NOBODY())), false);
  assert.equal(anyHidden(partyDoc(), [...sheetList(NOBODY()), { slug: "a", name: "A", fields: { race: { value: "orc", visible: true } } }]), false, "a shown field hides nothing");
});
test("the composites do not mutate their input, and the line is one constant that the site never copies", () => {
  const sheets = sheetList(hideOne("race")), docs = [partyDoc(), decideDoc(), tonightDoc(), atlasDoc(), clientDoc()], before = JSON.stringify(docs);
  projectForAnonymous(docs[0], sheets); projectDecide(docs[1], docs[0], sheets); projectTonight(docs[2], docs[0], sheets); projectGuidedAtlas(docs[3], docs[0], sheets); projectClient(docs[4], docs[0], sheets);
  assert.equal(JSON.stringify(docs), before);
  assert.equal(WITHHELD_LINE, "Part of this is hidden because a member keeps their build private.");
  for (const dir of ["js/", "scenes/"]) for (const n of readdirSync(new URL(dir, ROOT)).filter((x) => x.endsWith(".js"))) assert.ok(!readSrc(dir + n).includes("keeps their build private"), `${dir}${n} carries its own copy of the line: it must render what the Worker sends`);
});
test("the text scrub is gone: no judge, no word or phrase matching of hidden values, in the module or in any test", () => {
  const src = readSrc("infrastructure/worker/public-party.js");
  for (const gone of ["judge", "scrubDoc", "scrubNode", "lineIsBad", "exposureOf", "ownTextIsBad", "personMask", "NEEDLE_DOC_KEYS", "valuesOf(", "sheetValues("]) assert.ok(!src.includes(gone), `public-party.js still has ${gone}`);
  assert.ok(!/\.split\(\/\[\^\p\{L\}/.test(src), "no word splitting of document text");
});
