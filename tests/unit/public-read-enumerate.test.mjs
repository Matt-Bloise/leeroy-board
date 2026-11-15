// The enumeration test. Nothing here is a hand list of reads that someone remembered: it walks the Worker's own route table (ROUTES), the Discord command list read from
// discord.js, the broadcast sites read from the source, and the stored documents, and it fails when any of them has no entry below.
//
//   - ROUTE_KIND classifies every route as "projected" (its answer can carry member data and is projected: public-party.js), "none" (carries no member data) or "refused"
//     (the route refuses an anonymous caller: asserted). A route on none of the three FAILS the test, as does a route that is gone from ROUTES.
//   - One member hides ALL NINE sheet fields (race, class, spec_path, spec_at_40, professions, plan_zone, level, launch_state, goals: every line of the sheet has a hide switch,
//     scenes/sheet.js). Every value of theirs, and every string derived from it, is unique and starts with "qz". The stored documents hold all of it.
//   - The whole suite runs TWICE: on a small fictional party (FICTIONAL), and on a copy of the repo's real data/*.json documents (decide, client, guided-atlas, tonight, party,
//     launch) in which one member's real class, race, spec, professions, start zone and colour are replaced by canaries EVERYWHERE they occur, keys and derived words included
//     (REAL). The real shapes cannot drift from the fixture: they are the files the board serves. For the real copy, what is derived from the hider's class, race and start zone
//     (spell names, race skills, trainers, towns) is searched for too.
//   - Every route, with every document name and spelling its wildcard allows, is requested as an anonymous caller; the socket greeting and every broadcast are read off a real BoardRoom
//     socket; every Discord command is run; the cards, the ask prompt and /tonight are composed. In every answer, the body (keys and values, at any depth) and the headers are
//     searched for each canary and for the prefix "qz" itself. And each answer that should be projected still shows the visible members (so an empty answer cannot pass).
// Fictional data only. No network, no AI.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker, { ROUTES, PARTY_CACHE_PATHS, purgeWorkerCache, broadcastToRoom } from "../../infrastructure/worker/index.js";
import { BoardRoom } from "../../infrastructure/worker/room.js";
import { PUBLIC_DATA_DOCS, PUBLIC_ATLAS_DOCS } from "../../infrastructure/worker/public-docs.js";
import { MEMBER_DOCS, WITHHELD_LINE } from "../../infrastructure/worker/public-party.js";
import { loadCardState, renderBoardCard, renderSignupCard } from "../../infrastructure/worker/cards.js";
import { buildAnswerInputs, invalidatePagesCache } from "../../infrastructure/worker/ai-models.js";
import { handleDiscordInteraction } from "../../infrastructure/worker/discord.js";
import { invalidateConfigCache } from "../../infrastructure/worker/config.js";
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

// ---- the allow-list ---------------------------------------------------------------------------------------------------------------------------
const P = "projected", N = "none", R = "refused";
const ROUTE_KIND = {
  "POST /discord": P, "GET /discord/commands": N, "GET /votes": N, "GET /me": R, "POST /probe": N, "ANY /sheet": P,
  "POST /announce": R, "PUT /vocab": R, "PUT /config/:key": R, "POST /admin/members": R, "POST /admin/sheet": R, "POST /admin/cards/post": R,
  "GET /admin/feedback": R, "GET /admin/export": R, "GET /admin/requests": R, "PUT /persona": R, "POST /dispatch": R, "POST /admin/events/sync": R,
  "GET /admin/moments": R, "POST /admin/eval": R, "GET /intents": R, "POST /ack": R, "POST /answer": R, "GET /signups": N, "POST /signups": R,
  "ANY /live": P, "GET /state": P, "POST /token": N, "POST /auth/discord": N, "GET /auth/discord/start": N, "GET /auth/discord/callback": N,
  "POST /auth/logout": N, "ANY /me": R, "GET /me/export": R, "POST /me/erase": R, "POST /me/characters": R, "ANY /state/:doc": R, "GET /ask": N,
  "GET /wiki/snapshots": R, "GET /wiki/proposals": R, "GET /wiki/proposals/:id": R, "POST /wiki/proposals/:id/approve": R, "POST /wiki/proposals/:id/reject": R,
  "PUT /wiki/page": R, "GET /bootstrap": P, "GET /library/*": N, "GET /data/*": P, "PUT /data/*": P, "GET /atlas/*": N, "PUT /atlas/*": R,
  "POST /intent": P, "POST /refresh": N, "GET /": N, "GET /health": N,
};
const DISCORD_RUN = ["ack", "answer", "ask", "build", "countdown", "dates", "didyouknow", "help", "intents", "journey", "launch", "leeroy", "library", "map", "page", "quiz", "sheet", "signup", "start", "tonight", "tooltip", "vote"];

test("every route of ROUTES is on the allow-list as projected, none or refused; a new route fails until it is classified", () => {
  assert.deepEqual(Object.keys(ROUTE_KIND).sort(), [...ROUTES].sort());
  for (const v of Object.values(ROUTE_KIND)) assert.ok([P, N, R].includes(v));
});

// ---- the fixtures -----------------------------------------------------------------------------------------------------------------------------
const ALL_FIELDS = ["race", "class", "spec_path", "spec_at_40", "professions", "plan_zone", "level", "launch_state", "goals"]; // every line of the sheet has a hide switch
const slugOf = (n) => n.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const LEVEL_CANARY = 4747, GOAL_CANARY = "qzgoal fictional", LAUNCH_CANARY = "qzlaunchword";
const ROLES = ["tank", "healer", "damage"];
const kvDoc = (fx, k) => JSON.parse(fx.stored[k]);

// A) a small fictional party: Zed hides everything.
function fictional() {
  const ZED = { name: "Zed Quarry", class_key: "qzclasskey", class: "Qzclassname", race: "Qzracename", spec: "Qzspecname bear", spec_status: { status: "declared", source: "board" }, role: "damage", role_detail: "Qzroledetail from level 40",
    color: "#qz0c0a", start_zone: "Qzzonename", board_line: "Qzracename Qzclassname Qzspecname", professions: [{ name: "Qzprofone", source: "board" }, { name: "Qzproftwo", source: "board" }] };
  const SEEN = (n, role) => ({ name: n.name, class_key: n.k, class: n.c, race: n.r, spec: `${n.k}spec`, spec_status: { status: "declared", source: "board" }, role, role_detail: null, color: "#aa00bb", start_zone: n.z, board_line: `${n.r} ${n.c}`, professions: [{ name: `${n.k}prof`, source: "board" }] });
  const OTHERS = [{ name: "Ada Fenn", k: "adaclasskey", c: "Adaclassname", r: "Adaracename", z: "Adazonename" }, { name: "Bix Moor", k: "bixclasskey", c: "Bixclassname", r: "Bixracename", z: "Bixzonename" }, { name: "Cal Dray", k: "calclasskey", c: "Calclassname", r: "Calracename", z: "Calzonename" }];
  const MEMBERS = [...OTHERS.map((o, i) => SEEN(o, ROLES[i])), ZED];
  const hider = MEMBERS.length - 1;
  const SLUGS = MEMBERS.map((m) => slugOf(m.name));
  const ZED_SHEET = { race: "Qzracename", class: "Qzclassname", spec_path: "qzspecpath", spec_at_40: "qzspecat40", professions: ["Qzprofone", "Qzproftwo"], plan_zone: "qzplanzone", level: LEVEL_CANARY, launch_state: LAUNCH_CANARY, goals: GOAL_CANARY };
  const sheets = MEMBERS.map((m, i) => ({ slug: SLUGS[i], name: m.name, updated: AT, fields: Object.fromEntries(ALL_FIELDS.map((f) => [f, { value: i === hider ? ZED_SHEET[f] : (f === "level" ? 40 : f === "professions" ? [`${OTHERS[i].k}prof`] : f === "launch_state" ? "queue" : `${OTHERS[i].k}${f}`), visible: i !== hider, source: "board", at: AT }])) }));
  const party = { generated: AT, party: "Fictional Four", faction: "Horde", ruleset: "Normal", members: MEMBERS,
    settled: [{ text: "Damage: Zed Quarry, the Qzclassname, qzsettled", source: "board" }, { text: "Faction: Horde", source: "board" }],
    settled_extra: [], open: [{ title: "Professions", text: "the options. Gap: Qzprofone and Qzproftwo.", links: [], source: "board" }], polls: [], glossary: [] };
  const lineFor = () => [{ label: "Touch of the Dead, for the Qzracename at this table", text: "qzdecide racial", status: "forever" }, { label: "Enchanting", text: "also {qzclasskey}'s qzdecide", status: "forever" }, { label: "Open", text: "Qzprofone is open", status: "forever" }];
  const decide = { generated: AT, labels: {}, dates: {},
    people: MEMBERS.map((m) => ({ class_key: m.class_key, race: m.race, decisions: [{ key: "professions", title: "Professions", state: "declared", state_text: m.professions.map((p) => p.name).join(", "), group: lineFor(), options: [{ name: "Alchemy", lines: lineFor() }] }, { key: "spec40", title: "Spec", state: "declared", state_text: m.spec, lines: lineFor() }, { key: "locked", title: "Locked", state: "locked", state_text: m.board_line, lines: [] }] })),
    party: { brackets: [{ from: 1, to: 39, note: "n", tank: [OTHERS[0].k], healer: [OTHERS[1].k], damage: [OTHERS[2].k, "qzclasskey"] }], role_lines: [{ label: "Damage", text: "qzdecide Qzclassname", status: "forever" }], buffs: [{ key: "b", name: "Qzbuff", giver: "qzclasskey", to: ["adaclasskey"] }], nobody: { classes: [{ name: "Priest", lines: [] }], professions: [{ name: "Mining", lines: [] }], secondaries: [], buffs: [] }, lines: [{ label: "Group", text: "5 players" }, { label: "Zed", text: "{qzclasskey} heals qzdecide" }] } };
  const tonight = { generated: AT, cards: [], labels: {}, steps: { choose: "Choose {x}." }, actions: {}, events: [], launch: "Launch night", people: MEMBERS.map((m, i) => ({ member: i, class_key: m.class_key, step: i === hider ? "Choose Qzprofone or Qzproftwo qztonight" : null })), week_one: { trainers: Object.fromEntries(MEMBERS.map((m) => [m.class_key, null])), first_dungeon: null }, links: {}, poll_closes: null, play: null };
  const atlas = { generated: AT, build: "1", starter_cap: { level: 5 }, classes: Object.fromEntries(MEMBERS.map((m, i) => [m.class_key, { start: { id: `s${i}`, name: `${m.class_key} start`, zone: m.start_zone.toLowerCase(), zone_name: m.start_zone }, trainer: { name: `${m.class_key} trainer` }, town: { id: `t${i}`, name: `${m.class_key} town` } }])), dungeon: { id: "d", name: "Barrow Deeps" }, meet: { id: "m", name: "Valley of Strength", chosen: false } };
  const client = { generated: AT, build: "1", level: 60, classes: Object.fromEntries(MEMBERS.map((m) => [m.class, [{ id: 1, name: `${m.class_key} bolt` }]])), racials: Object.fromEntries(MEMBERS.map((m) => [m.race, [{ name: `${m.race} racial`, kind: "active" }]])), synergy: MEMBERS.map((m) => ({ from: m.class_key, to: MEMBERS.map((x) => x.class_key), what: `${m.class_key} buff`, refs: [] })), legacy: { total: 65 }, flags: {},
    buffs: { build: "1", levels: [1, 60], marks: [20, 40, 60], list: MEMBERS.map((m) => ({ key: `${m.class_key}_buff`, class: m.class_key, name: `${m.class_key} buff` })), rules: [{ text: `${MEMBERS[hider].class_key} rule`, status: "classic" }] } };
  const launch = MEMBERS.map((m, i) => ({ slug: SLUGS[i], name: m.name, state: i === hider ? LAUNCH_CANARY : "queue", at: AT }));
  return { kind: "FICTIONAL", members: MEMBERS, hider, slugs: SLUGS, names: MEMBERS.map((m) => m.name), docs: { party, decide, tonight, "guided-atlas": atlas, client, launch }, sheets,
    canaries: ["qzclasskey", "qzclassname", "qzracename", "qzspecname", "qzspecpath", "qzspecat40", "qzroledetail", "#qz0c0a", "qzzonename", "qzplanzone", "qzprofone", "qzproftwo", "qzlaunchword", "qzsettled", "qzdecide", "qztonight", "{qzclasskey}", String(LEVEL_CANARY), GOAL_CANARY],
    visible: ["ada fenn", "bix moor"], derived: [] };
}

// B) the repo's real documents, with one member's values replaced by canaries everywhere.
function realShape() {
  const raw = (n) => readFileSync(new URL(`data/${n}.json`, ROOT), "utf8");
  const SUBS = [["bear tank", "qzbeartank"], ["Feral Combat", "Qzspecname"], ["feral-combat", "qzspecname"], ["Feral", "Qzspecname"], ["feral", "qzspecname"], ["Druid", "Qzclassname"], ["druid", "qzclasskey"],
    ["Tauren", "Qzracename"], ["tauren", "qzracename"], ["Mulgore", "Qzzonename"], ["mulgore", "qzzonename"], ["Leatherworking", "Qzprofone"], ["leatherworking", "qzprofone"], ["Skinning", "Qzproftwo"], ["skinning", "qzproftwo"], ["#ff7c0a", "#qz0c0a"]];
  const canarise = (t) => SUBS.reduce((acc, [a, b]) => acc.split(a).join(b), t);
  const real = Object.fromEntries(["party", "decide", "tonight", "guided-atlas", "client"].map((n) => [n, JSON.parse(raw(n))]));
  const docs = Object.fromEntries(Object.entries(real).map(([n]) => [n, JSON.parse(canarise(raw(n)))]));
  const members = docs.party.members;
  const hider = 0; // Santa: the druid, the Tauren from Mulgore
  const SLUGS = members.map((m) => slugOf(m.name));
  const slugged = (v) => slugOf(String(v || ""));
  const sheets = members.map((m, i) => ({ slug: SLUGS[i], name: m.name, updated: AT, fields: Object.fromEntries(ALL_FIELDS.map((f) => {
    const v = i === hider
      ? { race: "qzracename", class: "qzclasskey", spec_path: "qzspecname", spec_at_40: "qzspecname", professions: ["qzprofone", "qzproftwo"], plan_zone: "qzzonename", level: LEVEL_CANARY, launch_state: LAUNCH_CANARY, goals: GOAL_CANARY }[f]
      : { race: slugged(m.race), class: m.class_key, spec_path: slugged(String(m.spec).split(/[ ,]/)[0]), spec_at_40: slugged(String(m.spec).split(/[ ,]/)[0]), professions: (m.professions || []).filter((p) => !p.status).map((p) => slugged(p.name)), plan_zone: slugged(m.start_zone), level: 40, launch_state: "queue", goals: "A fictional goal" }[f];
    return [f, { value: v, visible: i !== hider, source: "board", at: AT }];
  })) }));
  const launch = { ...JSON.parse(raw("launch")), rows: members.map((m, i) => ({ slug: SLUGS[i], name: m.name, state: i === hider ? LAUNCH_CANARY : "queue", at: AT })) };
  // Words derived from the hider's class, race and start zone, taken from the UNREPLACED documents: the spells and race skills, the trainers, the towns. Words that also stand in
  // text that stays public (the static parts, the other members, the glossary, the sign-ups) are not canaries.
  const names = (list) => (Array.isArray(list) ? list.map((x) => (x && typeof x === "object" ? x.name : null)).filter(Boolean) : []);
  const c0 = real.client, a0 = real["guided-atlas"].classes.druid;
  const derivedRaw = [...names(c0.classes.Druid), ...names(c0.racials.Tauren), a0.start.name, a0.trainer.name, a0.town.name, a0.town.trainer];
  const publicText = JSON.stringify([docs.party.glossary, docs.party.polls, docs.party.play, members.slice(1), docs.tonight.cards, docs.tonight.labels, docs.tonight.steps, docs.tonight.events, docs.tonight.launch, docs.tonight.links, docs.tonight.play, docs["guided-atlas"].dungeon, docs["guided-atlas"].meet, docs["guided-atlas"].dungeon_def, docs.client.legacy, docs.client.flags, docs.client.formula, docs.client.buffs.marks, docs.decide.labels, docs.decide.dates, launch, JSON.parse(raw("signups"))]).toLowerCase();
  const derived = [...new Set(derivedRaw.filter((w) => typeof w === "string" && w.length >= 5).map((w) => w.toLowerCase()))].filter((w) => !publicText.includes(w));
  return { kind: "REAL", members, hider, slugs: SLUGS, names: members.map((m) => m.name), docs: { ...docs, launch }, sheets,
    canaries: ["qzclasskey", "qzclassname", "qzracename", "qzspecname", "qzbeartank", "qzzonename", "qzprofone", "qzproftwo", "#qz0c0a", "qzlaunchword", String(LEVEL_CANARY), GOAL_CANARY, ...derived],
    visible: ["bible boi", "street rat"], derived };
}
const FIXTURES = [fictional(), realShape()];

const signer = createDiscordSigner();
async function makeEnv(fx) {
  invalidatePagesCache(); invalidateConfigCache();
  await purgeWorkerCache(ORIGIN, [...PARTY_CACHE_PATHS, "/api/signups", "/api/data/signups", "/api/data/signups.json"]); // the Worker caches reads across tests: another fixture's answer must not be served
  const DB = schemaDb();
  const kv = (k, v) => DB.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES (?, ?, ?)").run(k, typeof v === "string" ? v : JSON.stringify(v), AT);
  for (const k of ["party", "decide", "tonight", "guided-atlas", "client", "launch"]) kv(k, fx.docs[k]);
  kv("party_sheets", fx.sheets);
  kv("signups", { generated: AT, present: true, updated: AT, options: { meet: [], when: [] }, entries: [{ name: fx.names[fx.hider === 0 ? 1 : 0], rsvp: "in", updated: AT }, { name: fx.names[fx.hider], rsvp: "in", when: "8pm", updated: AT }], tallies: {} });
  kv("discord_members", [{ slug: "asker-x", name: "Asker X", match: ["asker x"], id: "100000000000000900" }, ...fx.names.map((n, i) => ({ slug: fx.slugs[i], name: n, match: [n.toLowerCase()], id: `10000000000000010${i}` }))]);
  DB.raw.prepare("INSERT INTO members (slug, key_hash, created_at) VALUES ('asker-x', ?, ?)").run(await sha256Hex(`${KEY_SALT}:${ASKER_KEY}`), AT);
  const stored = Object.fromEntries(["party", "decide", "tonight", "guided-atlas", "client", "launch", "party_sheets"].map((k) => [k, DB.raw.prepare("SELECT json FROM kv_state WHERE key = ?").get(k).json]));
  // a real BoardRoom with one anonymous socket: what the Worker broadcasts is what that socket gets
  const anon = { got: [], send(m) { anon.got.push(m); }, serializeAttachment() {}, deserializeAttachment() { return null; } };
  const room = new BoardRoom({ getWebSockets: () => [anon], setWebSocketAutoResponse() {}, acceptWebSocket() {} }, { DB });
  invalidateConfigCache();
  return { anon, room, DB, stored, KEY_SALT, USER_SALT, BOARD_ADMIN_TOKEN: ADMIN, ALLOWED_ORIGINS: "", BOARD_ROOM: { idFromName: () => "r", get: () => ({ fetch: (u, init) => room.fetch(u instanceof Request ? u : new Request(u, init)) }) }, DISCORD_PUBLIC_KEY: signer.publicKeyHex, BOARD_PUBLIC_URL: "https://leeroy.test" };
}
let ipN = 0;
async function call(env, method, path, { headers = {}, body } = {}) {
  const init = { method, headers: { "CF-Connecting-IP": `203.0.113.${(ipN++ % 200) + 1}`, ...headers } };
  if (body !== undefined) { init.body = typeof body === "string" ? body : JSON.stringify(body); init.headers["Content-Type"] = "application/json"; }
  const res = await quiet(() => worker.fetch(new Request(`${ORIGIN}/api${path}`, init), env, ctx));
  const text = await res.text();
  return { status: res.status, text, headers: [...res.headers].map(([k, v]) => `${k}: ${v}`).join("\n") };
}
const slash = (name, options = []) => ({ id: String(900000000000000000n + BigInt(++ipN)), type: 2, application_id: "100000000000000099", token: "tok", guild_id: "200000000000000001", data: { name, type: 1, options }, member: { user: { id: "100000000000000900", username: "asker" }, permissions: "0" } });
const discord = async (env, payload) => quiet(async () => (await (await handleDiscordInteraction(signer.signedRequest(payload), env, ctx, ORIGIN)).text()));

// the search: canaries, the prefix, in the body (keys and values) and the headers
function leaksIn(fx, where, ...texts) {
  const hay = texts.join("\n").toLowerCase();
  const bad = fx.canaries.filter((c) => hay.includes(c.toLowerCase())).map((c) => `${where}: ${c}`);
  if (/qz[a-z0-9]/.test(hay)) bad.push(`${where}: a string that starts with qz`);
  return bad;
}
const showsVisible = (fx, t) => fx.visible.some((v) => t.toLowerCase().includes(v));
const hiderName = (fx) => fx.names[fx.hider];

for (const fx of FIXTURES) {
  const T = (name, fn) => test(`[${fx.kind}] ${name}`, fn);

  // ---- the stored rows hold everything -------------------------------------------------------------------------------------------------------------
  T("fixture: the stored documents hold every canary, so a read that skipped the projection fails below", async () => {
    const env = await makeEnv(fx);
    const all = Object.values(env.stored).join("\n").toLowerCase();
    for (const c of fx.canaries) assert.ok(all.includes(c.toLowerCase()), `the stored rows hold ${c}`);
    assert.ok(leaksIn(fx, "stored", all).length > 10);
    if (fx.kind === "REAL") {
      assert.ok(fx.derived.length >= 8, `derived words (spells, race skills, trainers, towns) are searched for: ${fx.derived.length}`);
      const real = JSON.parse(readFileSync(new URL("data/decide.json", ROOT), "utf8"));
      assert.deepEqual(Object.keys(kvDoc(env, "decide")), Object.keys(real), "the stored decide document has the shape of the real one");
      assert.equal(kvDoc(env, "client").buffs.list.length, JSON.parse(readFileSync(new URL("data/client.json", ROOT), "utf8")).buffs.list.length, "the stored client document has the real buffs");
    }
  });

  // ---- every route, anonymous ----------------------------------------------------------------------------------------------------------------------
  const NAMES = { data: [...PUBLIC_DATA_DOCS], atlas: [...PUBLIC_ATLAS_DOCS], library: ["index.json", "news.json"] };
  const requestsFor = (route) => {
    let [method, path] = route.split(" ");
    if (method === "ANY") method = "GET";
    const out = [];
    const spell = (p) => { out.push([method, p]); };
    if (path === "/data/*") for (const n of NAMES.data) { spell(`/data/${n}`); spell(`/data/${n}.json`); spell(`/data//${n}`); spell(`/data/${n}?full=1&roster=1&admin=1&stored=1`); }
    else if (path === "/atlas/*") for (const n of NAMES.atlas) spell(`/atlas/${n}`);
    else if (path === "/library/*") for (const n of NAMES.library) spell(`/library/${n}`);
    else spell(path.replace(":key", "name_map").replace(":id", "1").replace(":doc", "party"));
    if (path === "/state" || path === "/bootstrap") spell(`${path}?full=1&roster=1&admin=1&raw=1&slug=${fx.slugs[fx.hider]}`);
    return out.map(([m, p]) => [m, p, m === "GET" ? undefined : "{}"]);
  };
  for (const [route, kind] of Object.entries(ROUTE_KIND)) {
    T(`anonymous ${route} [${kind}]: no hidden value, no string derived from one, in any body or header${kind === R ? "; the route refuses" : ""}`, async () => {
      const env = await makeEnv(fx);
      let sawVisible = false;
      for (const [method, path, body] of requestsFor(route)) {
        const r = await call(env, method, path, { body });
        assert.deepEqual(leaksIn(fx, `${method} ${path} (${r.status})`, r.text, r.headers), []);
        if (kind === R) assert.ok([401, 403, 404, 405, 426, 503].includes(r.status), `${method} ${path} answered ${r.status} to an anonymous caller`);
        if (kind === P && r.status === 200 && showsVisible(fx, r.text)) sawVisible = true;
      }
      if (kind === P && ["GET /state", "GET /bootstrap", "GET /data/*"].includes(route)) assert.ok(sawVisible, `${route}: an answer that shows the visible members (not an empty read)`);
    });
  }

  // ---- the routes an anonymous caller cannot reach but that compose public text ------------------------------------------------------------------------
  T("a member reading the party: GET /sheet and GET /sheet?slug=<the hider> show nothing the hider hid", async () => {
    const env = await makeEnv(fx);
    for (const p of ["/sheet", `/sheet?slug=${fx.slugs[fx.hider]}`, "/sheet?full=1&roster=1"]) {
      const r = await call(env, "GET", p, { headers: { Authorization: `Board ${ASKER_KEY}` } });
      assert.deepEqual(leaksIn(fx, `GET ${p} (${r.status})`, r.text, r.headers), []);
    }
    assert.ok(showsVisible(fx, (await call(env, "GET", "/sheet", { headers: { Authorization: `Board ${ASKER_KEY}` } })).text));
  });

  T("the socket: the greeting, and every message a Worker path broadcasts, as an anonymous socket receives it", async () => {
    const env = await makeEnv(fx);
    // the greeting is composed in room.js: read it off the real room (the Response with status 101 cannot be built in Node, so the throw after the send is expected)
    const sent = [];
    globalThis.WebSocketPair = function () { return { 0: {}, 1: { send: (m) => sent.push(m), serializeAttachment() {} } }; };
    try { await env.room.fetch(new Request("https://room.internal/api/live", { headers: { Upgrade: "websocket" } })); } catch { /* status 101 */ }
    delete globalThis.WebSocketPair;
    assert.ok(sent.length >= 1 && JSON.parse(sent[0]).type === "connected", "the greeting was sent");
    assert.deepEqual(leaksIn(fx, "greeting", ...sent), []);
    // every document that carries member data, as the Worker broadcasts it after a write (admin PUT) and from its own paths (broadcastToRoom)
    for (const key of MEMBER_DOCS) {
      env.anon.got.length = 0;
      await quiet(() => broadcastToRoom(env, { type: "data", key, data: kvDoc(env, key) }));
      assert.equal(env.anon.got.length, 1, key);
      assert.deepEqual(leaksIn(fx, `broadcast ${key}`, ...env.anon.got), []);
      env.anon.got.length = 0;
      const put = await call(env, "PUT", `/data/${key}`, { headers: { Authorization: `Bearer ${ADMIN}` }, body: kvDoc(env, key) });
      assert.equal(put.status, 200, `${key}: ${put.text}`);
      assert.deepEqual(leaksIn(fx, `PUT /data/${key} reply`, put.text, put.headers), []);
      assert.ok(env.anon.got.length >= 1, `PUT ${key} broadcasts`);
      assert.deepEqual(leaksIn(fx, `PUT /data/${key} broadcast`, ...env.anon.got), []);
      if (key === "party") assert.ok(showsVisible(fx, env.anon.got.join("\n")), `${key}: the broadcast still shows the visible members`);
      else if (key !== "launch") assert.ok(env.anon.got.join("\n").includes(WITHHELD_LINE), `${key}: the broadcast carries the one line (every member-derived section is withheld)`);
    }
    env.anon.got.length = 0;
    await quiet(() => broadcastToRoom(env, { type: "state", party: fx.sheets }));
    assert.deepEqual(leaksIn(fx, "broadcast state", ...env.anon.got), []);
    assert.ok(showsVisible(fx, env.anon.got.join("\n")));
    // a sheet write by a member (a hide, a show) broadcasts the sheet list
    env.anon.got.length = 0;
    const w = await call(env, "POST", "/sheet", { headers: { Authorization: `Board ${ASKER_KEY}` }, body: { field: "goals", value: "a goal", visible: true } });
    assert.equal(w.status, 200, w.text);
    assert.deepEqual(leaksIn(fx, "broadcast after a sheet write", ...env.anon.got), []);
  });

  // ---- the composers of public text -----------------------------------------------------------------------------------------------------------------
  T("every Discord command in discord.js is run here; each reply shows nothing the hider hid", async () => {
    const env = await makeEnv(fx);
    const src = readFileSync(new URL("infrastructure/worker/discord.js", ROOT), "utf8");
    const cmds = new Set([...src.matchAll(/cmd === "([a-z_-]+)"/g)].map((m) => m[1]));
    assert.deepEqual([...cmds].sort(), [...DISCORD_RUN].sort(), "a new Discord command must be added to DISCORD_RUN");
    for (const c of DISCORD_RUN) {
      const options = c === "sheet" ? [{ name: "member", type: 6, value: `10000000000000010${fx.hider}` }] : c === "ask" ? [{ name: "question", type: 3, value: "Who plays what, and what are their professions?" }] : c === "launch" ? [{ name: "state", type: 3, value: "queue" }] : [];
      const text = await discord(env, slash(c, options));
      assert.deepEqual(leaksIn(fx, `/${c}`, text), []);
    }
    for (const c of ["tonight", "sheet"]) assert.ok(showsVisible(fx, await discord(env, slash(c, c === "sheet" ? [{ name: "member", type: 6, value: `10000000000000010${fx.hider === 0 ? 1 : 0}` }] : []))), `/${c} still shows the visible members`);
  });

  T("the cards, the ask prompt (shared and private) and /tonight show nothing the hider hid", async () => {
    const env = await makeEnv(fx);
    const st = await loadCardState(env);
    const cards = JSON.stringify([renderBoardCard(st), renderSignupCard(st)]);
    assert.deepEqual(leaksIn(fx, "cards", cards), []); assert.ok(showsVisible(fx, cards));
    assert.ok(cards.includes(WITHHELD_LINE), "the cards carry the one line instead of any member's build part");
    for (const share of [true, false]) {
      const q = await buildAnswerInputs(env, { question: "Who is in the party and what do they play?", by: "Asker X", memberSlug: "asker-x", isMember: true, share });
      const text = `${q.systemPrompt}\n${q.userPrompt}`;
      assert.deepEqual(leaksIn(fx, `ask prompt share=${share}`, text), []);
      assert.ok(text.includes(WITHHELD_LINE), `ask prompt share=${share}: the one line stands for the other members' builds`);
    }
    const tonight = await discord(env, slash("tonight"));
    assert.deepEqual(leaksIn(fx, "/tonight", tonight), []);
    assert.ok(!/undefined|null|NaN/.test(tonight), "no undefined");
    assert.ok(tonight.includes(`${hiderName(fx)} (Build hidden)`), "a member who hid race or class is never a bare name");
    assert.ok(tonight.split("Party (")[1].includes(`${hiderName(fx)} (Build hidden)`), "in the roster line");
  });

  // ---- what a member who hides every line still shows (the sentence on the trust card is written from this) --------------------------------------------
  T("a member who hides all nine lines still shows exactly: their name and role, that they are in the party, their sign-up, and the time their sheet and launch row last changed", async () => {
    const env = await makeEnv(fx);
    const party = JSON.parse((await call(env, "GET", "/data/party")).text);
    const z = party.members.find((m) => m.name === hiderName(fx));
    assert.deepEqual(Object.keys(z).sort(), ["name", "role"], "the party document: name and role");
    const st = JSON.parse((await call(env, "GET", "/state")).text);
    const zs = st.party.find((s) => s.name === hiderName(fx));
    assert.deepEqual(Object.keys(zs).sort(), ["fields", "name", "slug", "updated"], "the sheet list: name, slug and the time the sheet last changed");
    assert.deepEqual(zs.fields, {}, "no sheet line at all: every line has a hide switch, level and goals included");
    assert.equal(st.partyDoc.members.length, fx.members.length, "the member is still counted: the party is as big as before");
    for (const k of ["decide", "tonight"]) assert.equal(st[k].withheld, WITHHELD_LINE, `${k} in /state carries the one line`);
    const launch = JSON.parse((await call(env, "GET", "/data/launch")).text);
    const rows = Array.isArray(launch) ? launch : launch.rows;
    assert.deepEqual(Object.keys(rows.find((r) => r.slug === fx.slugs[fx.hider])).sort(), ["at", "name", "slug"], "launch: that they are on the list and when it last changed, not the state");
    const signups = JSON.parse((await call(env, "GET", "/signups")).text);
    assert.ok(signups.entries.find((e) => e.name === hiderName(fx) && e.rsvp === "in" && e.when === "8pm"), "sign-up answers are not a sheet field and stay");
    // the shared planning pages: every member-derived section is empty and carries the line; what does not depend on the party stays
    const d = JSON.parse((await call(env, "GET", "/data/decide")).text);
    assert.deepEqual([d.withheld, d.people, d.party.lines], [WITHHELD_LINE, [], []]);
    const t = JSON.parse((await call(env, "GET", "/data/tonight")).text);
    assert.deepEqual([t.withheld, t.people, t.week_one.trainers], [WITHHELD_LINE, [], {}]);
    const a = JSON.parse((await call(env, "GET", "/data/guided-atlas")).text);
    assert.deepEqual([a.withheld, a.classes], [WITHHELD_LINE, {}]);
    assert.ok(a.meet && a.dungeon, "the meeting place and the dungeon do not depend on the party");
    const c = JSON.parse((await call(env, "GET", "/data/client")).text);
    assert.deepEqual([c.withheld, c.classes, c.racials, c.synergy, c.buffs.list, c.buffs.rules], [WITHHELD_LINE, {}, {}, [], [], []]);
    assert.deepEqual([party.withheld, party.settled, party.settled_extra, party.open], [WITHHELD_LINE, [], [], []]);
  });
}

// every broadcast site in the source is a key this test knows (does not depend on a fixture)
test("every broadcast key found in the source is either a member document (projected) or classified here", () => {
  const dir = new URL("infrastructure/worker/", ROOT);
  const NOT_MEMBER = ["signups", "stats"];
  const keys = new Set();
  for (const f of ["index.js", "discord.js", "ai-models.js", "cards.js", "moments.js", "announce.js", "scheduled-events.js", "join.js", "account.js", "characters-api.js", "wiki-proposals.js"]) {
    let src = ""; try { src = readFileSync(new URL(f, dir), "utf8"); } catch { continue; }
    for (const m of src.matchAll(/type:\s*"data",\s*key:\s*"([a-z_-]+)"/g)) keys.add(m[1]);
  }
  assert.ok(keys.size > 0);
  for (const k of keys) assert.ok(MEMBER_DOCS.includes(k) || NOT_MEMBER.includes(k), `broadcast key ${k} is neither projected nor classified`);
});
