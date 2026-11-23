// ADR 0002 step 2 gates: what must hold before ROSTER_FROM_D1 may ever be turned on. The interlock constant ROSTER_STEP2_READY stays false in this PR; the last test fails if it is
// true while any gate test below is missing. Every name here is fictional; the built-in members are read from the code under test and never printed: assertions on them are
// booleans, so a failure cannot write a real name into a public CI log.
//   G1 one roster read per operation, shared by auth, default admin and redaction
//   G2 the flag or the row changing mid-operation changes nothing for that operation
//   G3 interleaved operations in one isolate never see each other's roster (and there is no module-level roster state)
//   G4 no lockout: a built-in member the row omits keeps the member match
//   G5 a row without a usable default admin is refused (write and read)
//   G6 /admin/export leaves party_roster out
//   G7 the redaction roster is always the union of the built-ins and the row
//   G8 flag off and interlock closed: no extra D1 query, no flag evaluation
//   G9 nothing wraps, copies or proxies env
//   G11 every route-level roster read carries its operation (sheet writes, public data reads): one resolution per request (attack review F1 and F3)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../../infrastructure/worker/index.js";
import { PARTY_MEMBERS, loadPartyMembers, loadRoster } from "../../infrastructure/worker/party-source.js";
import { ROSTER_DATA } from "../../infrastructure/worker/bot-data.js";
import { rosterSnapshot, setStep2ReadyForTests, ROSTER_STEP2_READY } from "../../infrastructure/worker/roster-source.js";
import { validateConfigValue, invalidateConfigCache } from "../../infrastructure/worker/config.js";
import * as rosterConfig from "../../infrastructure/worker/privacy/roster-config.js";
import { researchMembers, setFirstNameSource } from "../../infrastructure/worker/privacy/roster-config.js";
import { ROW_FILTERS } from "../../infrastructure/worker/export.js";
import { invalidateMembersCache } from "../../infrastructure/worker/auth.js";
import { sha256Hex } from "../../infrastructure/worker/crypto.js";
import { resetResearchClaudeForTests } from "../../infrastructure/worker/research/claude.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ADMIN_TOKEN = "admin-token-for-tests-0123456789abcdef";
const KEY_SALT = "salt-for-tests-0123456789";
const MEMBER_KEY = "member-key-for-tests-0123456789ab";
const ctx = { waitUntil() {}, passThroughOnException() {} };

const member = (slug, name, extra = {}) => ({ slug, name, race: "human", class: "rogue", ...extra });
const ROW_OBJ = { version: 1, default_admin: "cask-wren", members: [member("alderfox", "Alderfox", { aliases: ["alderfox", "fox"] }), member("brindle-moth", "Brindle Moth", { aliases: ["brindle moth", "brindle"] }), member("cask-wren", "Cask Wren", { aliases: ["cask wren", "cask"] })] };
const ROW = JSON.stringify(ROW_OBJ);

// In-memory D1 that records its SQL, with a Flagship binding that counts evaluations. flagValues: array consumed one evaluation at a time (the last value repeats).
async function envOf({ flagValues = null, flag, kv = {}, memberSlug = null } = {}) {
  const seen = [];
  const counter = { flag: 0 };
  const memberHash = await sha256Hex(`${KEY_SALT}:${MEMBER_KEY}`);
  const stmt = (sql) => {
    let args = [];
    const o = {
      bind: (...a) => { args = a; return o; },
      all: async () => { seen.push(sql); return { results: /FROM members/i.test(sql) && memberSlug ? [{ slug: memberSlug, key_hash: memberHash }] : [] }; },
      first: async () => {
        seen.push(sql + " " + JSON.stringify(args));
        const lit = /WHERE key = '([^']+)'/i.exec(sql);
        const k = lit ? lit[1] : args[0];
        return /FROM kv_state WHERE key/i.test(sql) && Object.prototype.hasOwnProperty.call(kv, k) ? { json: kv[k], updated_at: "1" } : null;
      },
      run: async () => ({ meta: { changes: 0, last_row_id: 1 } }),
    };
    return o;
  };
  const env = { DB: { prepare: stmt, batch: async () => [] }, BOARD_ADMIN_TOKEN: ADMIN_TOKEN, KEY_SALT, USER_SALT: "user-salt-for-tests-0123456789", ALLOWED_ORIGINS: "" };
  if (flag !== undefined) env.ROSTER_FROM_D1 = flag;
  if (flagValues) env.FLAGS = { getBooleanValue: async (key) => { if (key !== "ROSTER_FROM_D1") return false; const i = Math.min(counter.flag, flagValues.length - 1); counter.flag++; return flagValues[i]; } };
  Object.defineProperty(env, "__seen", { value: seen, enumerable: false });
  Object.defineProperty(env, "__counter", { value: counter, enumerable: false });
  return env;
}
async function me(env, who) {
  const headers = who === "admin" ? { Authorization: `Bearer ${ADMIN_TOKEN}` } : who === "member" ? { Authorization: `Board ${MEMBER_KEY}` } : {};
  const silence = console.error; console.error = () => {};
  try {
    const res = await worker.fetch(new Request("https://api.test/api/me", { headers: { ...headers, "CF-Connecting-IP": "203.0.113.9" } }), env, ctx);
    return { status: res.status, body: await res.text() };
  } finally { console.error = silence; }
}
const reset = () => { setStep2ReadyForTests(true); invalidateMembersCache(); invalidateConfigCache(); setFirstNameSource(null); resetResearchClaudeForTests(); };
const privacyKeys = (members) => new Set(members.flatMap((m) => [m.display, ...(m.aliases || []), ...(m.firstNames || []), ...(m.characterNames || [])].map((x) => String(x).toLowerCase().replace(/[^a-z0-9]/g, ""))));
globalThis.fetch = async () => new Response("blocked in tests", { status: 599 });

test("G1 one roster read per operation: auth, the loaders and redaction share one flag evaluation and one party_roster read", async () => {
  reset();
  const env = await envOf({ flagValues: [true], kv: { party_roster: ROW } });
  const op = {}; // the operation: in the Worker the Request
  const a = await rosterSnapshot(env, op);
  const b = await rosterSnapshot(env, op);
  const c = await rosterSnapshot(env, op);
  assert.ok(a && a === b && b === c, "the same frozen snapshot object every time");
  await loadPartyMembers(env, op);
  await loadRoster(env, op);
  assert.equal(env.__counter.flag, 1, "the flag was evaluated once for the operation");
  assert.equal(env.__seen.filter((s) => s.includes("party_roster")).length, 1, "the row was read once for the operation");
  assert.equal(Object.isFrozen(a) && Object.isFrozen(a.sheetMembers) && Object.isFrozen(a.privacyMembers), true, "the snapshot cannot be edited by a consumer");
  // a whole HTTP request: auth and the loaders it uses are one operation (the Request is the key)
  reset();
  const env2 = await envOf({ flagValues: [true], kv: { party_roster: ROW }, memberSlug: "brindle-moth" });
  assert.equal(JSON.parse((await me(env2, "member")).body).slug, "brindle-moth");
  assert.ok(env2.__counter.flag <= 1, `one request evaluated the flag ${env2.__counter.flag} times`);
  reset();
});

test("G2 the flag or the row changing mid-operation changes nothing for that operation", async () => {
  reset();
  // the flag answers true for the first evaluation and false afterwards; the row is removed after the first read
  const kv = { party_roster: ROW };
  const env = await envOf({ flagValues: [true, false, false], kv });
  const op = {};
  const first = await rosterSnapshot(env, op);
  delete kv.party_roster;
  invalidateConfigCache();
  const second = await rosterSnapshot(env, op);
  assert.ok(first !== null && second === first, "the operation keeps the roster it started with");
  assert.equal(JSON.stringify((await privacyOf(env, op)).map((m) => m.display).slice(0, 3)), JSON.stringify(["Alderfox", "Brindle Moth", "Cask Wren"]), "redaction in the same operation still uses it");
  // control: a NEW operation sees the changed world
  assert.equal(await rosterSnapshot(env, {}), null, "the next operation sees the flag off");
  reset();
});
const privacyOf = async (env, op) => researchMembers(((await rosterSnapshot(env, op)) || {}).privacyMembers || null);

test("G3 interleaved operations in one isolate never see each other's roster, and there is no module-level roster state", async () => {
  reset();
  const onEnv = await envOf({ flagValues: [true], kv: { party_roster: ROW } });
  const offEnv = await envOf({ flagValues: [false], kv: { party_roster: ROW } });
  const opA = {}, opB = {}, opC = {};
  const slow = (p, ms) => new Promise((r) => setTimeout(r, ms)).then(() => p);
  const [a, b, c] = await Promise.all([slow(privacyOf(onEnv, opA), 5), privacyOf(offEnv, opB), slow(privacyOf(onEnv, opC), 1)]);
  const baseline = JSON.stringify(researchMembers());
  assert.equal(JSON.stringify(b), baseline, "the flag-off operation redacts with the built-ins only");
  assert.ok(a.some((m) => m.display === "Alderfox") && c.some((m) => m.display === "Alderfox"), "the flag-on operations redact with the row too");
  assert.equal(JSON.stringify(researchMembers()), baseline, "nothing is left behind in the isolate for the next operation");
  for (const gone of ["setRosterOverride", "getRosterOverride"]) assert.equal(gone in rosterConfig, false, `${gone} no longer exists`);
  const src = fs.readFileSync(path.join(ROOT, "infrastructure/worker/privacy/roster-config.js"), "utf8").replace(/\/\/.*$/gm, "");
  assert.equal(/^let (rosterOverride|overrideKey)\b/m.test(src), false, "no module-level override variable");
  reset();
});

test("G4 no lockout: a built-in member the row omits keeps the member match, and a row that drops the built-in admin position still lets that member in", async () => {
  reset();
  const builtIn = PARTY_MEMBERS[3]; // the built-in default admin by position
  const env = await envOf({ flagValues: [true], kv: { party_roster: ROW }, memberSlug: builtIn.slug });
  const r = await me(env, "member");
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).slug === builtIn.slug, true, "the omitted built-in member still authenticates as themselves");
  assert.equal(JSON.parse((await me(env, "admin")).body).slug, "cask-wren", "the admin token acts as the configured default admin");
  const op = {};
  const party = await loadPartyMembers(env, op);
  assert.equal(PARTY_MEMBERS.every((b) => party.some((p) => p.slug === b.slug)), true, "every built-in is in the member list");
  assert.equal(ROW_OBJ.members.every((m) => party.some((p) => p.slug === m.slug)), true, "and so is every row member");
  const roster = await loadRoster(env, op);
  assert.equal(ROSTER_DATA.every((b) => roster.some((r2) => r2.display === b.display)), true, "every built-in is in the roster list");
  reset();
});

test("G5 a row without a usable default admin is refused on write and on read, and the roster is closed (F2)", async () => {
  reset();
  for (const bad of [{ ...ROW_OBJ, default_admin: "nobody" }, { ...ROW_OBJ, default_admin: undefined }, { ...ROW_OBJ, default_admin: ["cask-wren"] }, { ...ROW_OBJ, members: [] }]) {
    assert.equal(typeof validateConfigValue("party_roster", bad), "string", "refused at PUT time");
    invalidateConfigCache();
    const env = await envOf({ flagValues: [true], kv: { party_roster: JSON.stringify(bad) } });
    assert.equal((await rosterSnapshot(env, {})).closed, true, "an invalid row at read time closes the roster");
    assert.equal((await me(env, "admin")).status, 401, "nobody is the default admin, and the built-in admin does not answer");
  }
  // a row that does not list the built-in admin but names another one is fine: the built-in member keeps their member match (G4), the admin is the configured one
  assert.equal(validateConfigValue("party_roster", ROW_OBJ), null);
  reset();
});

test("G6 /admin/export leaves party_roster out of the kv_state rows", () => {
  assert.match(ROW_FILTERS.kv_state, /key <> 'party_roster'/);
  assert.match(fs.readFileSync(path.join(ROOT, "infrastructure/worker/export.js"), "utf8"), /party_roster/);
});

test("G7 the redaction roster is always the union of the built-ins and the row, for any valid row", async () => {
  reset();
  const builtInKeys = privacyKeys(researchMembers());
  const rows = [
    ROW_OBJ,
    { version: 1, default_admin: "solo-one", members: [member("solo-one", "Solo One")] },
    { version: 1, default_admin: "xx-one", members: [member("xx-one", "Zed Only", { aliases: ["zedonly"], first_names: ["Ottoline"] })] },
  ];
  for (const row of rows) {
    invalidateConfigCache();
    const env = await envOf({ flagValues: [true], kv: { party_roster: JSON.stringify(row) } });
    const keys = privacyKeys(await privacyOf(env, {}));
    assert.equal([...builtInKeys].every((k) => keys.has(k)), true, "every built-in key is still covered");
    assert.equal(row.members.every((m) => keys.has(m.name.toLowerCase().replace(/[^a-z0-9]/g, "")) && keys.has(m.slug.replace(/[^a-z0-9]/g, ""))), true, "and every row name and slug is covered");
  }
  reset();
});

test("G8 flag off and interlock closed: no extra D1 query and no flag evaluation, whatever the flag says", async () => {
  const runs = [];
  for (const opts of [{ flag: "off" }, { flag: "on" }, {}, { flagValues: [true] }, { flagValues: [false] }]) {
    reset();
    setStep2ReadyForTests(null); // the shipped state: interlock closed
    const env = await envOf({ ...opts, kv: { party_roster: ROW }, memberSlug: PARTY_MEMBERS[1].slug });
    const sql = [];
    for (const who of ["admin", "member", "anon"]) { await me(env, who); sql.push(...env.__seen.splice(0)); }
    await loadPartyMembers(env, {}); await loadRoster(env, {});
    sql.push(...env.__seen.splice(0));
    assert.equal(sql.some((s) => s.includes("party_roster")), false, "the roster row is never asked for");
    assert.equal(env.__counter.flag, 0, "Flagship is never asked about ROSTER_FROM_D1");
    runs.push(JSON.stringify(sql));
  }
  assert.equal(new Set(runs).size, 1, "the D1 statements are identical for every flag setting");
  reset();
});

test("G9 nothing wraps, copies or proxies env: the handlers get the env they were given", async () => {
  reset();
  const idx = fs.readFileSync(path.join(ROOT, "infrastructure/worker/index.js"), "utf8");
  assert.ok(idx.includes("async fetch(req, env, ctx)") && idx.includes("async scheduled(controller, env, ctx)"));
  const code = ["roster-source.js", "party-source.js", "roster-shape.js"].map((f) => fs.readFileSync(path.join(ROOT, "infrastructure/worker", f), "utf8").replace(/\/\/.*$/gm, "")).join("\n");
  assert.equal(/Object\.create\(|new Proxy\(|Object\.assign\(\s*\{\}\s*,\s*env|\{\s*\.\.\.env\b/.test(code), false);
  const env = await envOf({ flagValues: [true], kv: { party_roster: ROW } });
  env.SOME_SECRET = "a-secret-value-0123456789";
  const keys = Object.keys(env).sort();
  await me(env, "admin");
  await rosterSnapshot(env, {});
  assert.deepEqual(Object.keys(env).sort(), keys, "the env's own keys are unchanged by a request and a snapshot");
  reset();
});

test("G11 every route-level roster read carries its operation, so a request resolves the roster once (sheet writes and public data reads included)", async () => {
  const src = (f) => fs.readFileSync(path.join(ROOT, "infrastructure/worker", f), "utf8");
  const idx = src("index.js"), dis = src("discord.js"), pub = src("public-party.js");
  // every call site is found by splitting on the call text; the argument list that follows must name op
  // (a definition, `function name(...`, is not a call)
  const callsOf = (text, head, len = 60) => text.split(head).map((rest, i, parts) => ({ rest, before: i > 0 ? parts[i - 1] : null })).slice(1).filter((x) => !x.before.endsWith("function ")).map((x) => x.rest.slice(0, len));
  for (const [name, text] of [["index.js", idx], ["discord.js", dis]]) {
    const writes = [...callsOf(text, "recordSheetEventInD1(env, url.origin, {"), ...callsOf(text, "recordSheetEventInD1(env, origin, {")];
    assert.ok(writes.length > 0 && writes.every((w) => w.includes("op: req")), `${name}: every recordSheetEventInD1 call passes op: req`);
    const reads = callsOf(text, "loadPublicInputs(env", 40).filter((c) => !c.startsWith(")"));
    assert.ok(reads.every((c) => c.includes("op: req")), `${name}: every loadPublicInputs call that has options passes op: req`);
  }
  assert.ok(callsOf(idx, "loadPublicInputs(env", 40).filter((c) => c.includes("op: req")).length >= 3, "the three public data routes in index.js pass op");
  assert.ok(pub.includes("buildPartySheetsFromD1(env, { persist: false, partyDoc: doc, strict: true, op })"), "public-party passes op on to the sheet build");
  assert.ok(idx.includes("{ persist: false, partyDoc, strict: true, op }"), "the sheet write commit passes op on to the sheet build");
  // behaviour: two reads for one operation resolve the roster once
  reset();
  const env = await envOf({ flagValues: [true], kv: { party_roster: ROW } });
  const op = {};
  await loadPartyMembers(env, op); await loadPartyMembers(env, op); await rosterSnapshot(env, op);
  assert.equal(env.__counter.flag, 1);
  reset();
});

test("G10 the interlock stays closed unless every gate test above is present and not skipped", () => {
  const src = fs.readFileSync(path.join(ROOT, "infrastructure/worker/roster-source.js"), "utf8");
  const open = /^export const ROSTER_STEP2_READY = true;$/m.test(src);
  assert.equal(ROSTER_STEP2_READY, open, "the exported constant matches the source line");
  assert.equal(ROSTER_STEP2_READY, false, "this PR ships the interlock closed; opening it is the owner's decision, in its own change");
  const me2 = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
  for (const id of ["G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8", "G9", "G11"]) assert.ok(new RegExp(`test\\("${id} `).test(me2), `${id} is present`);
  assert.equal(/\btest\.(skip|todo|only)\b|\{\s*skip\s*:/.test(me2.replace(/\/\/.*$/gm, "").replace(/"[^"]*"/g, '""')), false, "no gate test is skipped or narrowed");
});
