// Every ANONYMOUS read path that can show another member's build, one table, one fixture. What a member hides on their sheet, and what is derived from it,
// must be absent from all of them, while the STORED rows hold the whole documents (the projection is on the read side only: public-party.js).
//
//   1. The table of read paths (READS) is checked against the code: every route in ROUTES is classified; every route that carries member data is covered by a read
//      here; every public document that carries member data (a class_key anywhere in the repo's copy) is one the projection knows; every literal broadcast key and every
//      Discord command is classified. A route, document, broadcast or command added without a projection fails here until it is classified and covered.
//   2. The fixture STORES unprojected rows (every hidden value is in kv_state party, decide and tonight), and 8 fictional members hide 0, 1 or every field.
//      Every read path is then run and each hidden canary, and each canary derived from it (the cascade table below, written by hand), must be absent; role and
//      the visible fields must still be there (so an empty read cannot pass).
//   3. Round trip, junk rows, unreadable sheets, the admin PUT that races a hide, the cascade, settled text, decide.people, tonight.
// Fictional data only. No network, no AI.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import worker, { ROUTES, purgeWorkerCache, broadcastToRoom } from "../../infrastructure/worker/index.js";
import { projectForAnonymous, projectSheets, projectDataDoc, projectDecide, projectTonight, projectBroadcast, loadPublicInputs, MEMBER_DOCS, CASCADE } from "../../infrastructure/worker/public-party.js";
import { PUBLIC_DATA_DOCS } from "../../infrastructure/worker/public-docs.js";
import { loadCardState, renderBoardCard, renderSignupCard } from "../../infrastructure/worker/cards.js";
import { buildAnswerInputs, invalidatePagesCache } from "../../infrastructure/worker/ai-models.js";
import { handleDiscordInteraction } from "../../infrastructure/worker/discord.js";
import { invalidateConfigCache } from "../../infrastructure/worker/config.js";
import { slugify } from "../../infrastructure/worker/member-model.js";
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
const NON_MEMBER_DOCS = ["timeline", "client", "stats", "signups", "launch", "guided-atlas"];
// Literal keys the Worker broadcasts as {type:"data", key}. Member documents go through the one choke point (broadcastToRoom -> projectBroadcast).
const NON_MEMBER_BROADCAST_KEYS = ["signups", "launch", "stats"];

test("every route of ROUTES is classified here; a new route fails until it is", () => {
  assert.deepEqual(Object.keys(ROUTE_CLASS).sort(), [...ROUTES].sort());
});

test("every public document is either known to the projection or free of member data; a document that carries a class_key must be a member document", () => {
  assert.deepEqual([...PUBLIC_DATA_DOCS].sort(), [...MEMBER_DOCS, ...NON_MEMBER_DOCS].sort(), "a new public document must be classified");
  for (const name of PUBLIC_DATA_DOCS) {
    let text = "";
    try { text = readSrc(`data/${name}.json`); } catch { continue; }
    const carries = /"class_key"/.test(text);
    assert.equal(carries, MEMBER_DOCS.includes(name), `${name}: ${carries ? "carries a class_key but is not projected" : "is projected but carries no member data"}`);
  }
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
    { key: "professions", title: "Professions", state: "declared", state_text: cDecide(i, "prof") },
    { key: "spec40", title: "Spec at 40", state: "declared", state_text: cDecide(i, "spec") },
    { key: "talents", title: "Talents", state: "none", state_text: cDecide(i, "talents") },
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
      lines: [{ label: "zqdgeneric", text: "5 players" }],
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
function sheetList(hides = HIDES) {
  return NAMES.map((name, i) => ({
    slug: SLUG[i], name, updated: AT,
    fields: Object.fromEntries(SHEET_FIELDS.map((f) => [f, { value: sheetValue(i, f), visible: !hides[i].includes(f), source: "board", at: AT }])),
  }));
}

// A database holding the whole, unprojected documents.
async function makeEnv({ hides = HIDES, sheets } = {}) {
  invalidatePagesCache(); invalidateConfigCache();
  await purgeWorkerCache(ORIGIN, ["/api/bootstrap", "/api/state", "/api/data/party", "/api/data/party.json", "/api/data/decide", "/api/data/tonight", "/api/data/decide.json", "/api/data/tonight.json"]);
  const DB = schemaDb();
  const kv = (k, v) => DB.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES (?, ?, ?)").run(k, typeof v === "string" ? v : JSON.stringify(v), AT);
  kv("party", partyDoc()); kv("decide", decideDoc()); kv("tonight", tonightDoc());
  kv("signups", { generated: AT, present: true, updated: AT, options: { meet: [], when: [] }, entries: [{ name: NAMES[1], rsvp: "in", pack: "no", meet: null, when: "8pm", updated: AT }, { name: NAMES[CONTROL], rsvp: "maybe", updated: AT }], tallies: {} });
  kv("party_sheets", sheets === undefined ? sheetList(hides) : sheets);
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
const ANON = ["/state", "/state?full=1&roster=1&admin=1&raw=1", "/bootstrap", "/bootstrap?full=1&roster=1&admin=1", "/data/party", "/data/party.json", "/data/party?full=1&roster=1", "/data/decide", "/data/decide.json", "/data/tonight", "/data/tonight.json"];
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
    // decide and tonight
    const entryGone = HIDES[i].some((f) => ["race", "class", "spec_path", "spec_at_40"].includes(f));
    if (entryGone) for (const k of ["race", "prof", "spec", "talents", "locked"]) if (text.includes(cDecide(i, k))) bad.push(`${NAMES[i]} decide ${k}`);
    if (hidden(i, "professions") && text.includes(cDecide(i, "prof"))) bad.push(`${NAMES[i]} decide prof`);
    if (hidden(i, "class") && text.includes(cTonight(i, "classkey"))) bad.push(`${NAMES[i]} tonight classkey`);
    if (HIDES[i].some((f) => ["class", "spec_path", "spec_at_40", "professions"].includes(f)) && text.includes(cTonight(i, "step"))) bad.push(`${NAMES[i]} tonight step`);
  }
  for (const c of ["zqsettleddrop1x", "zqsettleddrop2x", "zqsettleddrop3x", "zqextradrop1x", "zqgapdrop", "zqdrolelines", "zqdnobodyclass", "zqdnobodyprof", "zqdbuff", "zqdnobodybuff", "zqdsecondary", "zqdnote"]) if (text.includes(c)) bad.push(c);
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
  const d = JSON.parse((await http(env, "GET", "/data/decide")).text);
  assert.deepEqual(d.people.map((p) => p.class_key), [4, 5, CONTROL].map((i) => cDecide(i, "classkey")), "decide.people drops entries of members who hide race, class or spec, in party order");
  assert.ok(!d.people.find((p) => p.class_key === cDecide(4, "classkey")).decisions.some((x) => x.key === "professions"), "professions hidden: only the professions card goes");
  assert.equal(d.party.withheld, true);
  assert.ok(d.party.lines.some((l) => l.label === "zqdgeneric"), "the generic group lines stay");
  const t = JSON.parse((await http(env, "GET", "/data/tonight")).text);
  assert.equal(t.people[1].class_key, undefined); assert.equal(t.people[1].step, null); assert.equal(t.people[1].member, 1);
  assert.equal(t.people[0].class_key, cTonight(0, "classkey")); assert.equal(t.people[0].step, cTonight(0, "step"), "race hidden: class and step stay");
  assert.ok(!(cTonight(1, "classkey") in t.week_one.trainers) && (cTonight(0, "classkey") in t.week_one.trainers));
  assert.ok(party.settled.map((l) => l.text).join("|").includes("zqsettledkept0x") && party.settled.some((l) => l.text.includes("zqsettledkeptf")));
  assert.deepEqual(party.settled.map((l) => l.text.match(/zqsettled(?:kept|drop)\w+/)[0]), ["zqsettledkept0x", "zqsettledkept6x", "zqsettledkeptf"]);
  assert.deepEqual(party.settled_extra.map((l) => l.text), ["Raids open zqextrakept"]);
  assert.ok(!party.open[0].text.includes("Gap") && party.open[0].text.startsWith("the options"), "the professions gap is dropped when someone hides professions");
  assert.ok(party.open[1].text.includes("zqopenkept"));
});

// ---- the stored rows are whole, and every writer keeps them whole ---------------------------------------------------------------------------
test("a hide (POST /sheet) stores the whole party document; showing the field again changes nothing stored", async () => {
  const env = await makeEnv({ hides: NAMES.map(() => []) });
  const auth = { Authorization: `Board ${ASKER_KEY}` };
  const before = stored(env, "party");
  // the asker has no party-document card, so use the member whose card it is: add a key for the control member
  env.DB.raw.prepare("INSERT INTO members (slug, key_hash, created_at) VALUES (?, ?, ?)").run(SLUG[CONTROL], await sha256Hex(`${KEY_SALT}:ctl-key-0123456789abcdef0123`), AT);
  const ctl = { Authorization: "Board ctl-key-0123456789abcdef0123" };
  for (const field of ["race", "class", "spec_path", "professions", "plan_zone"]) {
    const h = await http(env, "POST", "/sheet", { headers: ctl, body: { field, value: sheetValue(CONTROL, field), visible: false } });
    assert.equal(h.status, 200, h.text);
    assert.equal(stored(env, "party"), before, `hide ${field}: the stored party row is unchanged`);
    const s = await http(env, "POST", "/sheet", { headers: ctl, body: { field, value: sheetValue(CONTROL, field), visible: true } });
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
  assert.deepEqual(out.settled.map((l) => l.text), ["Faction: Horde zqsettledkeptf"], "no line that names anyone survives");
  assert.deepEqual(projectDecide(decideDoc(), doc, null).people, []);
  assert.equal(projectDecide(decideDoc(), doc, null).party.withheld, true);
  assert.ok(projectTonight(tonightDoc(), doc, null).people.every((p) => p.class_key === undefined && p.step === null));
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

test("a settled line is dropped only when it names a member who hid class or spec", () => {
  const doc = { members: [{ name: "Ada Fox", role: "tank" }, { name: "Bo Reed", role: "healer" }], settled: [{ text: "Tank: Ada Fox, Healers: Bo Reed" }, "Bo Reed is in", { text: "Ruleset: Normal" }], settled_extra: [] };
  const hide = (f) => [{ slug: "ada-fox", name: "Ada Fox", fields: { [f]: { value: "x", visible: false } } }, { slug: "bo-reed", name: "Bo Reed", fields: {} }];
  assert.equal(projectForAnonymous(doc, hide("race")).settled.length, 3, "race hidden: nothing dropped");
  assert.equal(projectForAnonymous(doc, hide("professions")).settled.length, 3);
  for (const f of ["class", "spec_path", "spec_at_40"]) assert.deepEqual(projectForAnonymous(doc, hide(f)).settled, ["Bo Reed is in", { text: "Ruleset: Normal" }].filter((l) => !(typeof l === "string" ? l : l.text).includes("Ada")), f);
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
