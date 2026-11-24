// ADR 0002 F2 and F4, the two pre-flip gates from the attack review of step 2. Fictional names only; built-in names are read from the code at the moment of use, never typed here.
//   F2: with the interlock open, a flag that cannot be asked (timeout, throw, rejection, a non-boolean answer) or a flag-on roster that cannot be resolved (row unreadable, invalid,
//       or colliding with a built-in member) is CLOSED: nobody is a member, nobody is the default admin, no outside model call is made. A definite false is the flag-off behaviour, unchanged.
//       A row that is DEFINITELY absent (the D1 read succeeded and found none) is NOT closed: the built-ins answer until ADR step 6 removes them; at that step absent becomes closed too.
//   F4: a row member cannot reuse a built-in person's slug, display name, alias or first name under another slug, at write time (PUT) and at read time (the row is then closed).
// Run: node --test tests/unit/roster-fail-closed.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../../infrastructure/worker/index.js";
import { answerWithAi } from "../../infrastructure/worker/ai-models.js";
import { flagOn, flagState, FLAG_TIMEOUT_MS } from "../../infrastructure/worker/flags.js";
import { rosterSnapshot, setStep2ReadyForTests, isClosed } from "../../infrastructure/worker/roster-source.js";
import { PARTY_MEMBERS, loadPartyMembers, loadRoster } from "../../infrastructure/worker/party-source.js";
import { ROSTER_DATA } from "../../infrastructure/worker/bot-data.js";
import { builtInPeople, builtInCollision, validateRosterConfig } from "../../infrastructure/worker/roster-shape.js";
import { invalidateConfigCache } from "../../infrastructure/worker/config.js";
import { invalidateMembersCache } from "../../infrastructure/worker/auth.js";
import { setFirstNameSource, getFirstNameSource } from "../../infrastructure/worker/privacy/roster-config.js";
import { resetResearchClaudeForTests, privacyBudget } from "../../infrastructure/worker/research/claude.js";
import { resetKeyCacheForTests } from "../../infrastructure/worker/ai-keys.js";
import { invalidatePagesCache } from "../../infrastructure/worker/ai-models.js";
import { invalidatePersonaCache } from "../../infrastructure/worker/persona.js";
import { sha256Hex } from "../../infrastructure/worker/crypto.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ADMIN = "admin-token-for-tests-0123456789abcdef";
const KEY_SALT = "salt-for-tests-0123456789";
const MEMBER_KEY = "member-key-for-tests-0123456789ab";
const ctx = { waitUntil() {}, passThroughOnException() {} };
const member = (slug, name, extra = {}) => ({ slug, name, race: "human", class: "rogue", ...extra });
const ROW_OBJ = { version: 1, default_admin: "cask-wren", members: [member("alderfox", "Alderfox", { aliases: ["alderfox", "fox"] }), member("brindle-moth", "Brindle Moth"), member("cask-wren", "Cask Wren", { first_names: ["Odalys"] })] };
const ROW = JSON.stringify(ROW_OBJ);
const Q = "when does onyxia open";
const WORKERS_TEXT = "**Onyxia's Lair opens on 2026-12-09.** Bring fire resistance.\n-# Sources: raids/onyxias-lair";

let anth = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  if (String(url).includes("anthropic")) { anth.push(String(init.body || "")); return new Response(JSON.stringify({ content: [{ type: "text", text: WORKERS_TEXT }], usage: { input_tokens: 5, output_tokens: 5 } }), { status: 200, headers: { "content-type": "application/json" } }); }
  return new Response("{}", { status: 200 });
};
test.after(() => { globalThis.fetch = realFetch; setStep2ReadyForTests(null); });
const reset = () => { setStep2ReadyForTests(true); invalidateMembersCache(); invalidateConfigCache(); setFirstNameSource(null); resetResearchClaudeForTests(); resetKeyCacheForTests(); invalidatePersonaCache(); invalidatePagesCache(); privacyBudget.ms = 1000; anth = []; };

// A Flagship stand-in whose answer is switchable per test: a boolean, "throw", "reject", "hang", or a non-boolean.
const flags = (mode) => ({ calls: 0, mode, getBooleanValue(key) {
  this.calls++;
  if (key !== "ROSTER_FROM_D1") return Promise.resolve(false);
  if (this.mode === "throw") throw new Error("flag service down");
  if (this.mode === "reject") return Promise.reject(new Error("flag service rejected"));
  if (this.mode === "hang") return new Promise(() => {});
  return Promise.resolve(this.mode);
} });

async function makeEnv({ mode = true, row = ROW, research = false, extra = {} } = {}) {
  const DB = schemaDb();
  DB.raw.prepare("INSERT INTO members (slug, key_hash, created_at) VALUES (?, ?, '2026-11-01T00:00:00Z')").run(PARTY_MEMBERS[1].slug, await sha256Hex(`${KEY_SALT}:${MEMBER_KEY}`));
  DB.raw.prepare("INSERT INTO lib_pages (id, category, title, blurb, aliases_json, facts_json, updated_at) VALUES ('raids/onyxias-lair', 'raids', 'Onyxia', 'The raid', '[]', ?, '2026-11-01T00:00:00Z')").run(JSON.stringify([{ key: "onyxia.opens", value: "Onyxia's Lair opens on 2026-12-09." }]));
  DB.raw.prepare("INSERT INTO kv_state (key, json, updated_at) VALUES ('discord_members', ?, 'x')").run(JSON.stringify([{ slug: "red-fox", name: "Red Fox", match: ["red fox"], id: "100000000000000002" }]));
  if (row !== null) DB.raw.prepare("INSERT INTO kv_state (key, json, updated_at) VALUES ('party_roster', ?, 'x')").run(row);
  const env = {
    DB, BOARD_ADMIN_TOKEN: ADMIN, KEY_SALT, USER_SALT: "user-salt-for-tests-0123456789", ALLOWED_ORIGINS: "", FLAGS: flags(mode),
    BOARD_ROOM: { idFromName: () => "r", get: () => ({ fetch: async () => new Response("ok") }) },
    AI: { run: async () => { env.__wai = (env.__wai || 0) + 1; return { response: WORKERS_TEXT, usage: { prompt_tokens: 5, completion_tokens: 5 } }; } },
    ...(research ? { ASK_RESEARCH: "on", ANTHROPIC_API_KEY: "sk-ant-FAKE-TEST-0000" } : {}), ASK_DEADLINE_MS: "5000", ...extra,
  };
  return env;
}
const quiet = async (fn) => { const e = console.error, w = console.warn, l = console.log; console.error = console.warn = console.log = () => {}; try { return await fn(); } finally { console.error = e; console.warn = w; console.log = l; } };
async function me(env, who) {
  const headers = who === "admin" ? { Authorization: `Bearer ${ADMIN}` } : who === "member" ? { Authorization: `Board ${MEMBER_KEY}` } : {};
  const res = await quiet(() => worker.fetch(new Request("https://api.test/api/me", { headers: { ...headers, "CF-Connecting-IP": "203.0.113.9" } }), env, ctx));
  return { status: res.status, body: await res.text() };
}
const put = async (env, body) => quiet(async () => {
  const res = await worker.fetch(new Request("https://api.test/api/config/party_roster", { method: "PUT", headers: { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.9" }, body: typeof body === "string" ? body : JSON.stringify(body) }), env, ctx);
  return { status: res.status, json: await res.json() };
});

// ---- F2: the flag --------------------------------------------------------------------------------------------------------------------------------------
test("flagState tells 'false' from 'could not ask'; flagOn is unchanged", async () => {
  const cases = [[true, "on"], [false, "off"], ["throw", "unknown"], ["reject", "unknown"], ["hang", "unknown"], ["yes", "unknown"], [1, "unknown"], [null, "unknown"], [undefined, "unknown"]];
  for (const [mode, want] of cases) {
    const env = { FLAGS: flags(mode) };
    assert.equal(await flagState(env, "ROSTER_FROM_D1"), want, `mode ${String(mode)}`);
    assert.equal(await flagOn(env, "ROSTER_FROM_D1"), mode === true, `flagOn(${String(mode)}) keeps folding everything but true into false`);
  }
  assert.equal(await flagState({ ROSTER_FROM_D1: "on" }, "ROSTER_FROM_D1"), "on", "no binding: the legacy variable");
  assert.equal(await flagState({ ROSTER_FROM_D1: "off" }, "ROSTER_FROM_D1"), "off");
  assert.equal(await flagState({}, "ROSTER_FROM_D1"), "off");
  assert.equal(await flagState({ FLAGS: {} }, "ROSTER_FROM_D1"), "off", "a binding without getBooleanValue is no binding, as flagOn reads it");
  assert.ok(FLAG_TIMEOUT_MS <= 200);
});

test("F2 the snapshot: a flag that cannot be asked is CLOSED; a definite false is flag-off (null); the interlock still short-circuits before any flag call", async () => {
  for (const mode of ["throw", "reject", "hang", "yes"]) {
    reset();
    const snap = await rosterSnapshot(await makeEnv({ mode }), {});
    assert.equal(isClosed(snap), true, `flag ${mode}`);
    assert.equal(snap.reason, "flag-unknown");
    assert.deepEqual([snap.sheetMembers, snap.rosterData, snap.privacyMembers, snap.defaultAdminSlug], [[], [], [], null]);
    assert.ok(Object.isFrozen(snap));
  }
  reset();
  const off = await makeEnv({ mode: false });
  assert.equal(await rosterSnapshot(off, {}), null, "a definite false is the flag-off path");
  assert.equal(off.DB.raw.prepare("SELECT 1 FROM kv_state WHERE 0").all().length, 0);
  setStep2ReadyForTests(false);
  const closedInterlock = await makeEnv({ mode: "throw" });
  assert.equal(await rosterSnapshot(closedInterlock, {}), null, "interlock closed: null, never closed");
  assert.equal(closedInterlock.FLAGS.calls, 0, "and the flag is not even asked");
  reset();
});

test("F2 the snapshot: flag on and the row unreadable, invalid or colliding with a built-in is CLOSED with a fixed reason; a DEFINITELY absent row is the built-ins (null)", async () => {
  const builtIn = PARTY_MEMBERS[0];
  const collides = JSON.stringify({ ...ROW_OBJ, members: [...ROW_OBJ.members, member("someone-else", builtIn.name)] });
  const cases = [["{not json", "row-unreadable"], [JSON.stringify({ ...ROW_OBJ, default_admin: "nobody" }), "row-invalid"], [JSON.stringify({ version: 1, members: [] }), "row-invalid"], [collides, "row-collides-with-built-in"]];
  for (const [row, reason] of cases) {
    reset();
    const snap = await rosterSnapshot(await makeEnv({ row }), {});
    assert.equal(isClosed(snap), true, reason);
    assert.equal(snap.reason, reason);
  }
  reset();
  assert.equal(await rosterSnapshot(await makeEnv({ row: null }), {}), null, "absent: the D1 read succeeded and found no row, so the built-ins, as ADR 0002 step 1 says");
  reset();
  const ok = await rosterSnapshot(await makeEnv({}), {});
  assert.equal(isClosed(ok), false, "a valid row opens");
  assert.equal(ok.defaultAdminSlug, "cask-wren");
  const dbDown = await makeEnv({});
  dbDown.DB = { prepare: () => { throw new Error("d1 down"); } };
  reset();
  assert.equal(isClosed(await rosterSnapshot(dbDown, {})), true, "an unreadable D1 is closed");
});

test("F2 what closed means for a request: no member (not even a signed-in one), no default admin; the admin-only routes still answer so the row can be repaired", async () => {
  reset();
  const env = await makeEnv({ mode: "throw" });
  assert.equal((await me(env, "admin")).status, 401, "the admin token is nobody: no array-position admin");
  assert.equal((await me(env, "member")).status, 401, "a signed-in built-in member is not matched");
  assert.equal((await me(env, "anon")).status, 401);
  // the flag-off control on the same data: today's behaviour
  reset();
  const control = await makeEnv({ mode: false });
  assert.equal(JSON.parse((await me(control, "admin")).body).slug, PARTY_MEMBERS[3].slug);
  assert.equal((await me(control, "member")).status, 200);
  // repair: the admin-only PUT works while closed; once the flag answers again the roster opens
  reset();
  const broken = await makeEnv({ mode: true, row: "{not json" });
  assert.equal((await me(broken, "admin")).status, 401);
  const r = await put(broken, ROW);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(JSON.parse((await me(broken, "admin")).body).slug, "cask-wren", "after the repair the configured default admin answers");
  reset();
});

test("F2 the loaders: closed is the empty list, also when the D1 read itself fails; with the flag off a failed read still falls back to the built-ins (unchanged)", async () => {
  reset();
  const env = await makeEnv({ mode: "throw" });
  assert.deepEqual(await loadPartyMembers(env, {}), []);
  assert.deepEqual(await loadRoster(env, {}), []);
  const down = await makeEnv({ mode: "throw" });
  down.DB = { prepare: () => { throw new Error("d1 down"); } };
  assert.deepEqual(await loadPartyMembers(down, {}), [], "a failed party read under a closed roster is empty, not the built-ins");
  assert.deepEqual(await loadRoster(down, {}), []);
  reset();
  const off = await makeEnv({ mode: false });
  off.DB = { prepare: () => { throw new Error("d1 down"); } };
  assert.deepEqual(await loadPartyMembers(off, {}), PARTY_MEMBERS, "flag off: as before");
  assert.deepEqual(await loadRoster(off, {}), ROSTER_DATA);
  reset();
});

test("F2 one decision per operation: closed stays closed for the whole operation even if the flag service recovers mid-way", async () => {
  reset();
  const env = await makeEnv({ mode: "throw" });
  const op = {};
  assert.equal(isClosed(await rosterSnapshot(env, op)), true);
  env.FLAGS.mode = true;
  assert.equal(isClosed(await rosterSnapshot(env, op)), true, "same operation: same answer");
  assert.equal(isClosed(await rosterSnapshot(env, {})), false, "the next operation sees the recovered flag");
  reset();
});

test("F2 no path falls back to a built-in member once the roster is closed (source guard over every reader of the built-ins)", () => {
  const rd = (f) => fs.readFileSync(path.join(ROOT, f), "latin1");
  const idx = rd("infrastructure/worker/index.js");
  const auth = idx.slice(idx.indexOf("async function resolveMemberAuth"), idx.indexOf("// Admin-token-only gate"));
  assert.ok(auth.indexOf("isClosed(rost)") > 0 && auth.indexOf("isClosed(rost)") < auth.indexOf("PARTY_MEMBERS"), "resolveMemberAuth closes before it names a built-in");
  assert.ok(auth.indexOf("isClosed(rost)") < auth.indexOf("loadPartyMembers"), "and before the party document is read");
  const readers = [...idx.matchAll(/PARTY_MEMBERS/g)].map((m) => m.index);
  const inAuth = readers.filter((i) => i >= idx.indexOf("async function resolveMemberAuth") && i < idx.indexOf("// Admin-token-only gate"));
  const outside = readers.filter((i) => !inAuth.includes(i));
  const outsideLines = outside.map((i) => idx.slice(idx.lastIndexOf("\n", i) + 1, idx.indexOf("\n", i)).trim());
  assert.ok(outsideLines.every((l) => /^import |builtInPeople\(PARTY_MEMBERS/.test(l)), `index.js reads PARTY_MEMBERS outside resolveMemberAuth only to import it or to build the F4 collision list: ${outsideLines.join(" | ")}`);
  const ps = rd("infrastructure/worker/party-source.js");
  for (const fn of ["export async function loadPartyMembers", "export async function loadRoster"]) {
    const body = ps.slice(ps.indexOf(fn), ps.indexOf("\n}\n", ps.indexOf(fn)));
    assert.ok(body.includes("isClosed(rost)"), `${fn} checks closed`);
    assert.ok(/catch \{[^}]*isClosed\(await rosterSnapshot\(env, op\)\) \? \[\]/s.test(body), `${fn}: its catch fallback is empty when closed`);
  }
  // every rosterSnapshot call site in the Worker is either one of the checked readers above or hands the snapshot to researchParty, which closes
  const sites = [];
  for (const f of fs.readdirSync(path.join(ROOT, "infrastructure/worker"), { recursive: true }).filter((x) => String(x).endsWith(".js"))) {
    const t = rd(path.join("infrastructure/worker", String(f)));
    if (String(f) === "roster-source.js") continue; // the definition itself
    for (const m of t.matchAll(/rosterSnapshot\(env, [a-zA-Z]+\)/g)) sites.push(`${f}`);
  }
  assert.deepEqual(sites.sort(), ["ai-models.js", "index.js", "listener.js", "party-source.js", "party-source.js", "party-source.js", "party-source.js"], "no new, unchecked reader of the snapshot");
  assert.match(rd("infrastructure/worker/research/claude.js"), /roster && roster\.closed === true\) return \{ failed: true, closed: true/);
  assert.match(rd("infrastructure/worker/ai-models.js"), /rosterClosed\s*\? \{ reason: "roster:closed" \}/);
});

// ---- F2: the outside model call ------------------------------------------------------------------------------------------------------------------------
const ask = (env, opts = {}) => quiet(() => answerWithAi({ env, origin: "https://worker.test", intentId: "q1", by: "Fenwick", memberSlug: "fenwick", question: Q, provider: "workers-ai", share: true, isMember: true, ...opts }));
const turnRow = (env) => env.DB.raw.prepare("SELECT * FROM ask_turns WHERE id = 'q1'").get();
const newTurn = (env) => env.DB.raw.prepare("INSERT INTO ask_turns (id, by_name, question, model, status, share, created_at) VALUES ('q1', 'Fenwick', ?, 'workers-ai', 'thinking', 1, ?)").run(Q, new Date().toISOString());

test("F2 research asks: with the roster closed NO outside call is made (tokenised or RESEARCH_NAMES real), members get the degraded line and guests library facts, Workers AI never sees a member's text", async () => {
  for (const extra of [{}, { RESEARCH_NAMES: "real" }]) {
    for (const mode of ["throw", "hang", true]) {
      reset();
      const env = await makeEnv({ mode, row: mode === true ? "{not json" : ROW, research: true, extra });
      newTurn(env);
      await ask(env);
      assert.equal(anth.length, 0, `no Anthropic request (flag ${String(mode)}, names ${extra.RESEARCH_NAMES || "tokenised"})`);
      assert.equal(env.__wai, undefined, "a member's friend text never reaches Workers AI either");
      const row = turnRow(env);
      assert.ok(row && row.status !== "thinking", "the turn was finished");
      assert.match(String(row.answer || ""), /brain is out right now, so that is only what the library holds/, "the honest degraded line, library facts only");
      assert.doesNotMatch(String(row.answer || ""), /Bring fire resistance/, "nothing a model wrote");
      reset();
      const guestEnv = await makeEnv({ mode, row: mode === true ? "{not json" : ROW, research: true, extra });
      newTurn(guestEnv);
      await ask(guestEnv, { isMember: false, memberSlug: null, by: "Visitor" });
      assert.equal(anth.length, 0, "a guest neither");
    }
  }
});

test("F2 control: the same ask with a valid row and the flag on DOES reach Claude once (so the zero above is the gate, not the harness)", async () => {
  reset();
  const env = await makeEnv({ mode: true, research: true });
  newTurn(env);
  await ask(env);
  assert.equal(anth.length, 1);
  assert.match(turnRow(env).answer || "", /Onyxia's Lair opens/);
  // and flag off (definite false) with the same env: the pre-existing research path, unchanged
  reset();
  const off = await makeEnv({ mode: false, research: true });
  newTurn(off);
  await ask(off);
  assert.equal(anth.length, 1);
  reset();
});

// ---- F4: the built-ins ---------------------------------------------------------------------------------------------------------------------------------
const people = () => builtInPeople(PARTY_MEMBERS, ROSTER_DATA, getFirstNameSource());
const withMember = (m) => ({ ...ROW_OBJ, members: [...ROW_OBJ.members, m] });
const B0 = PARTY_MEMBERS[0], B1 = PARTY_MEMBERS[1];
const aliasOf = (i) => (ROSTER_DATA.find((r) => r.display === PARTY_MEMBERS[i].name) || ROSTER_DATA[i]).aliases.find((a) => /^[a-z][a-z0-9' -]+$/.test(a) && a.length > 2);

test("F4 the people list joins each built-in sheet member with its roster entry and aliases", () => {
  const p = people();
  assert.equal(p.length, PARTY_MEMBERS.length);
  const first = p.find((x) => x.id === B0.slug);
  assert.ok(first.words.includes(B0.name) && first.words.includes(B0.slug));
  assert.ok(ROSTER_DATA.every((r) => p.some((x) => x.words.includes(r.display))), "every roster entry belongs to a person");
});

test("F4 a row member cannot reuse a built-in display name, slug, alias or first name under another slug; its own slug may change the built-in member", () => {
  const p = people();
  const bad = (label, cfg) => { const e = builtInCollision(cfg, p); assert.equal(typeof e, "string", label); assert.match(e, /built-in member under another slug/, label); return e; };
  bad("name", withMember(member("not-the-built-in", B0.name)));
  bad("name in other case and spacing", withMember(member("not-the-built-in", "  " + B0.name.toUpperCase() + "  ")));
  assert.equal(typeof builtInCollision(withMember(member(B1.slug, B0.name)), p), "string", "under the slug of a DIFFERENT built-in (refused as a rename)");
  assert.match(builtInCollision(withMember(member(B0.slug, "Plainly Fictional")), p), /not renamed/, "the built-in's own slug with another name is a rename, refused");
  const a = aliasOf(1);
  if (a) bad("alias", withMember(member("not-the-built-in", "Plainly Fictional", { aliases: [a] })));
  bad("alias via first name", withMember(member("not-the-built-in", "Plainly Fictional", { first_names: [B1.name] })));
  const sneaky = (word) => withMember(member("sneaky", "Plainly Fictional", { first_names: [word] }));
  bad("accent look-alike", sneaky(B0.name.replace(/a/i, "á")));
  // a row member under the built-in's OWN slug may change that built-in member (name, build, aliases of its own) without colliding with itself
  assert.equal(builtInCollision({ ...ROW_OBJ, members: [...ROW_OBJ.members, member(B0.slug, B0.name, { aliases: [B0.name.toLowerCase()] })] }, p), null);
  assert.match(builtInCollision({ ...ROW_OBJ, members: [...ROW_OBJ.members, member(B0.slug, "Renamed Fictional")] }, p), /changed under its own slug but not renamed/, "a rename would put two people on one slug key and break every tokenised ask");
  assert.equal(builtInCollision(ROW_OBJ, p), null, "the fictional row collides with nothing");
  assert.equal(builtInCollision(null, p), null);
  assert.equal(builtInCollision(ROW_OBJ, null), null);
});

test("F4 the runtime first-name source counts: a row member cannot reuse a built-in person's first name", () => {
  reset();
  setFirstNameSource((r, i) => (i === 0 ? ["Perrin-Test"] : []));
  const p = builtInPeople(PARTY_MEMBERS, ROSTER_DATA, getFirstNameSource());
  assert.equal(typeof builtInCollision(withMember(member("not-the-built-in", "Plainly Fictional", { aliases: ["perrin-test"] })), p), "string");
  assert.equal(builtInCollision(ROW_OBJ, p), null);
  reset();
});

test("F4 at write time: PUT refuses a colliding row with 400 and stores nothing; a clean row is stored", async () => {
  reset();
  const env = await makeEnv({ mode: true, row: null });
  const r = await put(env, withMember(member("not-the-built-in", B0.name)));
  assert.equal(r.status, 400, JSON.stringify(r.json));
  assert.match(r.json.error, /built-in member under another slug/);
  assert.equal(env.DB.raw.prepare("SELECT json FROM kv_state WHERE key = 'party_roster'").get(), undefined, "nothing was stored");
  assert.equal((await put(env, ROW)).status, 200);
  assert.ok(env.DB.raw.prepare("SELECT json FROM kv_state WHERE key = 'party_roster'").get());
  // the generic validator is unchanged for everything else (the built-in check is an extra, not a replacement)
  assert.equal(validateRosterConfig(withMember(member("not-the-built-in", B0.name))), null, "validateRosterConfig alone cannot see the built-ins: the callers add the check");
  reset();
});

test("F4 at read time: a row that already collides (written before this check, or by hand in D1) is CLOSED, not used", async () => {
  reset();
  const env = await makeEnv({ mode: true, row: JSON.stringify(withMember(member("not-the-built-in", B0.name))) });
  const snap = await rosterSnapshot(env, {});
  assert.equal(snap.reason, "row-collides-with-built-in");
  assert.equal((await me(env, "admin")).status, 401);
  reset();
});

test("F4 look-alike spellings: doubled letters and digit-for-letter variants of a built-in name collide too (the tokeniser would give them one token)", () => {
  const p = people();
  const n = B0.name;
  const variants = [n.replace(/(.)/, "$1$1"), n.replace(/a/i, "4"), n.replace(/s/i, "5"), n.replace(/o/i, "0"), n.replace(/e/i, "3"), n.replace(/i/i, "1")].filter((v) => v.toLowerCase() !== n.toLowerCase());
  assert.ok(variants.length >= 2, "the fixture name offers variants");
  for (const v of variants) assert.equal(typeof builtInCollision(withMember(member("not-the-built-in", v)), p), "string", v);
  assert.equal(builtInCollision(ROW_OBJ, p), null, "the fictional row is still clean");
});

test("F2 the listener's classifier and the group-wiki cron check the closed roster before any outside call (source guard; behaviour in listener-b.test.mjs)", () => {
  const rd = (f) => fs.readFileSync(path.join(ROOT, f), "latin1");
  const l = rd("infrastructure/worker/listener.js");
  assert.ok(l.indexOf("isClosed(await rosterSnapshot(env, ev))") > 0 && l.indexOf("isClosed(await rosterSnapshot(env, ev))") < l.indexOf("await classifyUntagged("));
  const i = rd("infrastructure/worker/index.js");
  const c = i.indexOf("maybeRefreshGroupWiki(env,");
  assert.ok(c > 0 && i.lastIndexOf("isClosed(await rosterSnapshot(env, {}))", c) > i.lastIndexOf("groupWikiCronOn(env)", c) - 1, "the cron returns before the wiki refresh when the roster is closed");
});

// ---- which roster is live: GET /health with the admin token ---------------------------------------------------------------------------------------------
const health = async (env, admin = true) => quiet(async () => {
  const res = await worker.fetch(new Request("https://api.test/health", { headers: { ...(admin ? { Authorization: `Bearer ${ADMIN}` } : {}), "CF-Connecting-IP": "203.0.113.9" } }), env, ctx);
  return { status: res.status, json: await res.json() };
});

test("the live roster source is reported in the admin health output: built-in (flag off), built-in (row absent), d1, closed (reason), and built-in with the interlock closed", async () => {
  reset();
  assert.deepEqual((await health(await makeEnv({ mode: false }))).json.rosterSource, { source: "built-in", detail: "flag off" });
  reset();
  assert.deepEqual((await health(await makeEnv({ mode: true, row: null }))).json.rosterSource, { source: "built-in", detail: "row absent" });
  reset();
  assert.deepEqual((await health(await makeEnv({ mode: true }))).json.rosterSource, { source: "d1", detail: "row valid" });
  for (const [env0, reason] of [[{ mode: "throw" }, "flag-unknown"], [{ mode: true, row: "{not json" }, "row-unreadable"], [{ mode: true, row: JSON.stringify({ ...ROW_OBJ, default_admin: "nobody" }) }, "row-invalid"], [{ mode: true, row: JSON.stringify(withMember(member("not-the-built-in", PARTY_MEMBERS[0].name))) }, "row-collides-with-built-in"]]) {
    reset();
    assert.deepEqual((await health(await makeEnv(env0))).json.rosterSource, { source: "closed", detail: reason });
  }
  // interlock closed (the shipped state): reported without reading the flag or D1
  reset();
  setStep2ReadyForTests(false);
  const env = await makeEnv({ mode: true });
  const sql = [];
  const prep = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (s) => { const st = prep(s); const bind = st.bind.bind(st); st.bind = (...a) => { sql.push(s + " " + JSON.stringify(a)); return bind(...a); }; sql.push(s); return st; };
  const r = await health(env);
  assert.deepEqual(r.json.rosterSource, { source: "built-in", detail: "interlock closed (the flag is not read)" });
  assert.equal(env.FLAGS.calls, 0, "the flag was not asked");
  assert.equal(sql.filter((s) => /party_roster/i.test(s)).length, 0, "D1 was not asked for the roster row");
  reset();
});

test("the roster source is for the admin token only: a request without it gets the minimal health body, no rosterSource", async () => {
  reset();
  const r = await health(await makeEnv({ mode: true }), false);
  assert.equal(r.status, 200);
  assert.equal("rosterSource" in r.json, false);
  reset();
});

test("the roster comments name the right ADR step: the built-ins are removed at step 6, step 3 writes the real row", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  for (const f of ["infrastructure/worker/roster-source.js", "infrastructure/worker/roster-shape.js"]) {
    const src = fs.readFileSync(path.join(root, f), "utf8");
    assert.doesNotMatch(src, /step 3 (removes|gate)|until step 3 removes/, `${f} says step 3 where the ADR says step 6`);
  }
});
