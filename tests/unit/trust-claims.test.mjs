// Trust claims: every sentence on the trust card (data/trust.json) and the privacy page is backed by what the Worker does.
// Seeded with fictional data only: a made-up member key, made-up names, a made-up hidden value. No network, no AI.
//   reads:  names and builds only; the avatar and guild roles are not read or used anywhere in the Worker or the page code.
//   sees:   anyone who asks the server can read names, builds and sign-ups; hidden sheet fields are not in any anonymous read.
//   needs a key: /api/me and /api/sheet refuse an anonymous caller; with the key, /api/sheet adds the member's own hidden field.
// If the wording is made false (or the behaviour changes under it), a test here fails.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import worker, { purgeWorkerCache } from "../../infrastructure/worker/index.js";
import { cardMembers } from "../../infrastructure/worker/card-members.js";
import { projectForAnonymous } from "../../infrastructure/worker/public-party.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";
import { sha256Hex } from "../../infrastructure/worker/crypto.js";

const realFetch = globalThis.fetch;
globalThis.fetch = async () => new Response("blocked in tests", { status: 599 });
test.after(() => { globalThis.fetch = realFetch; });

const ROOT = new URL("../../", import.meta.url);
const read = (rel) => readFileSync(new URL(rel, ROOT), "utf8");
const trust = JSON.parse(read("data/trust.json"));
const line = (id) => trust.lines.find((l) => l.id === id);
const ORIGIN = "https://api.test";
const ctx = { waitUntil() {}, passThroughOnException() {} };
const AT = "2026-11-12T00:00:00.000Z";
const KEY = "member-key-trust-claims-0123456789", KEY_SALT = "key-salt-for-tests-0123456789";
const HIDDEN = "zqtc hidden sheet value", OTHER_HIDDEN = "zqto other hidden value";
const quiet = async (fn) => { const e = console.error, w = console.warn, l = console.log; console.error = console.warn = console.log = () => {}; try { return await fn(); } finally { console.error = e; console.warn = w; console.log = l; } };

async function makeEnv() {
  const DB = schemaDb();
  const kv = (k, v) => DB.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES (?, ?, ?)").run(k, JSON.stringify(v), AT);
  const party = JSON.parse(read("data/party.json"));
  party.members.push({ name: "Red Fox", class: "Paladin", class_key: "paladin", race: "Human", role: "tank", spec: "Holy", professions: [{ name: "Mining", source: "board" }] });
  kv("party", party);
  kv("signups", { generated: AT, present: true, updated: AT, options: { meet: ["Valley of Strength"], when: ["8pm"] }, entries: [{ name: "Red Fox", pack: "no", meet: "Valley of Strength", rsvp: "in", when: "8pm", updated: AT }] });
  kv("party_sheets", [
    { slug: "red-fox", name: "Red Fox", fields: { class: { value: "paladin", visible: true, source: "board", at: AT }, goals: { value: HIDDEN, visible: false, source: "board", at: AT } }, updated: AT },
    { slug: "blue-owl", name: "Blue Owl", fields: { class: { value: "mage", visible: true, source: "board", at: AT }, goals: { value: OTHER_HIDDEN, visible: false, source: "board", at: AT } }, updated: AT },
  ]);
  DB.raw.prepare("INSERT INTO members (slug, key_hash, created_at) VALUES ('red-fox', ?, ?)").run(await sha256Hex(`${KEY_SALT}:${KEY}`), AT);
  const sent = [];
  const room = { fetch: async (u, init) => { if (init && init.body) sent.push(String(init.body)); return new Response(JSON.stringify({ ok: true, sent: 0, skipped: 0 })); } };
  return { DB, ALLOWED_ORIGINS: "", KEY_SALT, USER_SALT: "user-salt-for-tests-0123456789", BOARD_ADMIN_TOKEN: "admin-token-for-tests-0123456789abcdef", BOARD_ROOM: { idFromName: () => "r", get: () => room }, sent };
}
const call = (env, path, headers = {}) => quiet(() => worker.fetch(new Request(`${ORIGIN}/api${path}`, { headers: { "CF-Connecting-IP": "203.0.113.50", ...headers } }), env, ctx));
const anon = async (env, path) => { const r = await call(env, path); return { status: r.status, text: await r.text() }; };

test("anyone who asks the server can read names, builds and sign-ups, with no key", async () => {
  const env = await makeEnv();
  const party = await anon(env, "/data/party");
  assert.equal(party.status, 200);
  const m = JSON.parse(party.text).members.find((x) => x.name === "Red Fox");
  assert.ok(m, "the member's name is in the anonymous party document");
  assert.equal(m.class, "Paladin"); assert.equal(m.race, "Human"); assert.equal(m.role, "tank"); assert.equal(m.spec, "Holy");
  assert.ok(Array.isArray(m.professions) && m.professions[0].name === "Mining");
  const signups = await anon(env, "/data/signups");
  assert.equal(signups.status, 200);
  const e = JSON.parse(signups.text).entries.find((x) => x.name === "Red Fox");
  assert.ok(e && e.rsvp === "in" && e.pack === "no" && e.meet === "Valley of Strength" && e.when === "8pm", "name, pack, meet, rsvp and when are public");
  for (const p of ["/bootstrap", "/state"]) {
    const r = await anon(env, p);
    assert.equal(r.status, 200, p);
    assert.ok(r.text.includes("Red Fox") && r.text.includes("Paladin"), `${p} carries the name and the build`);
    assert.ok(/"rsvp"\s*:\s*"in"/.test(r.text), `${p} carries the sign-ups`);
  }
});

// The real sheet fields (the Worker's SHEET_FIELDS), read from the source so a new field cannot be missed.
const SHEET_FIELDS = JSON.parse(/const SHEET_FIELDS = (\[[^\]]*\])/.exec(read("infrastructure/worker/index.js"))[1]);
const SHEET_VALUE = { race: "zqrace-sheet", class: "zqclass-sheet", spec_path: "zqspec-sheet", spec_at_40: "zqspec40-sheet", professions: ["zqprof-sheet"], level: 47, launch_state: "zqlaunch-sheet", plan_zone: "zqzone-sheet", goals: "zqgoal-sheet" };
// What a reader could learn from each field's echoes in the public party document. Written by hand here, not taken from the Worker.
const CANARIES = {
  race: ["Zqrace", "Zqzone", "zqrace-sheet", "zqzone-sheet"],
  class: ["Zqclass", "zqclasskey", "#c0ffee", "zqspecname", "zqroledetail", "zqclass-sheet", "zqspec-sheet", "zqspec40-sheet"],
  spec_path: ["zqspecname", "zqroledetail", "zqspec-sheet"],
  spec_at_40: ["zqspecname", "zqroledetail", "zqspec40-sheet"],
  professions: ["Zqprof", "zqprof-sheet"],
  plan_zone: ["Zqzone", "zqzone-sheet"],
  level: [], launch_state: ["zqlaunch-sheet"], goals: ["zqgoal-sheet"],
};
// Canaries that must STILL be shown when only this field is hidden (so a read of an empty document cannot pass).
const STILL_SHOWN = { race: ["Zqclass", "zqrole"], class: ["Zqrace", "Zqprof", "zqrole"], spec_path: ["Zqrace", "Zqclass", "zqrole"], spec_at_40: ["Zqrace", "Zqclass", "zqrole"], professions: ["Zqrace", "Zqclass"], plan_zone: ["Zqrace", "Zqprof"], level: ["Zqrace"], launch_state: ["Zqrace"], goals: ["Zqrace"] };
const LEVEL_SHEET = /"level"\s*:\s*\{\s*"value"/;

async function envWithFullMember() {
  const env = await makeEnv();
  const party = JSON.parse(read("data/party.json"));
  party.members = party.members.filter((x) => x.name !== "Red Fox");
  party.members.push({ name: "Red Fox", class_key: "zqclasskey", class: "Zqclass", race: "Zqrace", spec: "zqspecname", spec_status: { status: "declared", source: "board" }, role: "zqrole", role_detail: "zqroledetail", color: "#c0ffee", start_zone: "Zqzone", board_line: "Zqrace Zqclass zqspecname", professions: [{ name: "Zqprof", source: "board" }] });
  env.DB.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES ('party', ?, ?)").run(JSON.stringify(party), AT);
  const sheet = { slug: "red-fox", name: "Red Fox", fields: {}, updated: AT };
  for (const k of SHEET_FIELDS) sheet.fields[k] = { value: SHEET_VALUE[k], visible: true, source: "board", at: AT };
  env.DB.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES ('party_sheets', ?, ?)").run(JSON.stringify([sheet]), AT);
  return env;
}
const ANON_PATHS = ["/data/party", "/data/party.json", "/state", "/bootstrap", "/state?full=1&roster=1&admin=1", "/bootstrap?full=1&roster=1&admin=1", "/data/party?full=1&roster=1&admin=1"];
const postSheet = (env, body) => quiet(() => worker.fetch(new Request(`${ORIGIN}/api/sheet`, { method: "POST", headers: { "CF-Connecting-IP": "203.0.113.50", Authorization: `Board ${KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }), env, ctx));
const storedParty = (env) => env.DB.raw.prepare("SELECT json FROM kv_state WHERE key = 'party'").get().json;

async function assertHidden(env, field) {
  const surfaces = [];
  for (const p of ANON_PATHS) {
    const r = await call(env, p);
    assert.equal(r.status, 200, p);
    const headers = [...r.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n");
    surfaces.push([p, await r.text(), headers]);
  }
  for (const body of env.sent) surfaces.push(["socket broadcast", body, ""]);
  // the stored row is whole by design (so a hidden field can be shown again); what Discord /tonight and the cards read is the stored row PROJECTED
  const stored = JSON.parse(storedParty(env));
  const sheetsRow = JSON.parse(env.DB.raw.prepare("SELECT json FROM kv_state WHERE key = 'party_sheets'").get().json);
  const projected = projectForAnonymous(stored, sheetsRow);
  surfaces.push(["stored party row, projected (Discord /tonight)", JSON.stringify(projected), ""]);
  surfaces.push(["card members", JSON.stringify(cardMembers(projected)), ""]);
  for (const [name, text, headers] of surfaces) {
    for (const c of CANARIES[field]) {
      assert.ok(!text.includes(c), `hide ${field}: ${name} still holds ${c}`);
      assert.ok(!headers.includes(c), `hide ${field}: ${name} headers hold ${c}`);
    }
    if (field === "level") assert.ok(!LEVEL_SHEET.test(text), `hide ${field}: ${name} still holds the level`);
  }
  const docText = surfaces.find(([n]) => n === "/data/party")[1];
  for (const c of STILL_SHOWN[field]) assert.ok(docText.includes(c), `hide ${field}: ${c} is still shown, so the read is not empty`);
}

for (const field of SHEET_FIELDS) {
  test(`hiding ${field} on the sheet removes it and everything derived from it from every anonymous read`, async () => {
    const env = await envWithFullMember();
    const res = await postSheet(env, { field, value: SHEET_VALUE[field], visible: false });
    assert.equal(res.status, 200, await res.clone().text());
    await assertHidden(env, field);
  });
}

test("an admin write of the party document is stored whole, and no read or broadcast brings a hidden field back", async () => {
  const env = await envWithFullMember();
  assert.equal((await postSheet(env, { field: "class", value: "zqclass-sheet", visible: false })).status, 200);
  assert.equal((await postSheet(env, { field: "plan_zone", value: "zqzone-sheet", visible: false })).status, 200);
  const full = JSON.parse(storedParty(env));
  const fox = full.members.find((x) => x.name === "Red Fox");
  Object.assign(fox, { class: "Zqclass", color: "#c0ffee", start_zone: "Zqzone" }); // a hand edit that carries the old build
  const put = await quiet(() => worker.fetch(new Request(`${ORIGIN}/api/data/party`, { method: "PUT", headers: { "CF-Connecting-IP": "203.0.113.50", Authorization: "Board admin-token-for-tests-0123456789abcdef", "Content-Type": "application/json" }, body: JSON.stringify(full) }), env, ctx));
  assert.equal(put.status, 200);
  assert.ok(storedParty(env).includes("Zqclass"), "the stored row holds the value (it is stored whole)");
  const text = (await anon(env, "/data/party")).text;
  for (const c of ["Zqclass", "#c0ffee", "Zqzone"]) assert.ok(!text.includes(c), c);
  for (const body of env.sent) for (const c of ["Zqclass", "#c0ffee", "Zqzone"]) assert.ok(!body.includes(c), `socket ${c}`);
});

const VOLATILE = /"(at|updated|generated)":"[^"]*"/g;
const normalise = (t) => t.replace(VOLATILE, '"$1":"T"');
for (const field of SHEET_FIELDS) {
  test(`round trip: hide then show ${field}; the stored row and every read are byte-identical to before the hide`, async () => {
    const env = await envWithFullMember();
    await purgeWorkerCache(ORIGIN, ["/api/bootstrap", "/api/state", "/api/data/party", "/api/data/party.json"]); // the Worker caches reads across tests
    const reads = async () => Object.fromEntries(await Promise.all(ANON_PATHS.map(async (p) => [p, normalise((await anon(env, p)).text)])));
    const before = { stored: storedParty(env), reads: await reads() };
    const hide = await postSheet(env, { field, value: SHEET_VALUE[field], visible: false });
    assert.equal(hide.status, 200, await hide.clone().text());
    assert.equal(storedParty(env), before.stored, "hiding stores nothing different: the document is whole");
    const hidden = await reads();
    assert.notDeepEqual(hidden, before.reads, `hiding ${field} changes at least one read`);
    const show = await postSheet(env, { field, value: SHEET_VALUE[field], visible: true });
    assert.equal(show.status, 200, await show.clone().text());
    assert.equal(storedParty(env), before.stored, "the stored row is byte-identical after show");
    const after = await reads();
    for (const p of ANON_PATHS) assert.equal(after[p], before.reads[p], `${p} is byte-identical after hide then show`);
  });
}

test("/api/me and /api/sheet need the member's key", async () => {
  const env = await makeEnv();
  assert.equal((await anon(env, "/me")).status, 401);
  assert.equal((await anon(env, "/sheet")).status, 401);
  assert.ok((await anon(env, "/state/settings")).status >= 400, "settings need a key");
  assert.equal((await call(env, "/me", { Authorization: "Board wrong-key-for-tests-0123456789abcdef" })).status, 401);
  assert.equal((await call(env, "/sheet", { Authorization: "Board wrong-key-for-tests-0123456789abcdef" })).status, 401);
});

test("the key adds the member's own identity and own hidden field, and nobody else's hidden field", async () => {
  const env = await makeEnv();
  const auth = { Authorization: `Board ${KEY}` };
  const me = await call(env, "/me", auth);
  assert.equal(me.status, 200);
  assert.equal((await me.json()).slug, "red-fox");
  const sheet = await call(env, "/sheet", auth);
  assert.equal(sheet.status, 200);
  const text = await sheet.text(); const sj = JSON.parse(text);
  assert.equal(sj.sheet.fields.goals.value, HIDDEN, "the owner's own sheet holds the hidden field");
  assert.ok(!text.includes("zqto"), "another member's hidden field stays out of the owner's read");
  assert.equal(sj.party.find((s) => s.slug === "red-fox").fields.goals.value, HIDDEN);
  assert.equal(sj.party.find((s) => s.slug === "blue-owl").fields.goals, undefined);
});

test("trust card: 'sees' says anyone can read names, builds and sign-ups, hidden fields are not shown, settings and sheet need a key", () => {
  const sees = line("sees").what;
  assert.match(sees, /anyone/i);
  assert.match(sees, /anyone with the link/i);
  assert.match(sees, /names, builds and sign-ups/);
  assert.match(sees, /hide on your sheet are not shown/i);
  assert.match(sees, /Your role \(tank, healer or damage\) is always shown; it is not one of the fields you can hide\./);
  assert.match(sees, /need your key/i);
  assert.match(sees, /public code and older commits/i);
  assert.match(sees, /hiding a field does not remove them there/i);
  assert.match(sees, /named on the privacy page/i);
  assert.doesNotMatch(sees, /Matt and the group admins/);
  assert.doesNotMatch(JSON.stringify(trust), /Members of your own guild see/);
});

test("trust card: 'reads' names only what the code reads (no avatar, no guild roles, no email)", () => {
  const reads = line("reads").what;
  assert.match(reads, /Discord name/);
  assert.match(reads, /what you send to Leeroy \(commands, button presses, direct messages to it, and messages that mention it\)/);
  assert.match(reads, /Not your role list or your email\. It does check whether Discord says you can manage the server\./);
  assert.match(reads, /The board does not read your picture\. A party card posted in Discord in October 2026 used profile pictures\./);
  assert.doesNotMatch(reads, /Not your picture/);
  // the code backs it: nothing in the Worker, the page scripts or the scenes reads an avatar or a member's guild roles
  const files = (dir) => readdirSync(new URL(dir, ROOT)).flatMap((n) => { const rel = `${dir}${n}`; return statSync(new URL(rel, ROOT)).isDirectory() ? files(`${rel}/`) : /\.(js|mjs)$/.test(n) ? [rel] : []; });
  const hits = [];
  for (const f of [...files("infrastructure/worker/"), ...files("js/"), ...files("scenes/")]) {
    const src = read(f);
    if (/avatar/i.test(src)) hits.push(`${f}: avatar`);
    if (/\bmember\??\.roles\b|\buser\??\.roles\b|guild_roles/.test(src)) hits.push(`${f}: guild roles`);
  }
  assert.deepEqual(hits, []);
  // web sign-in asks Discord for identify only: no guilds scope, no email scope
  assert.match(read("infrastructure/worker/web-auth.js"), /scope: "identify"/);
});

test("privacy page: the device check link is /#probe, and no link or code span points at /probe", () => {
  const html = read("privacy/index.html");
  assert.ok(!/href="\/probe"/.test(html));
  assert.ok(!/<code>\/probe<\/code>/.test(html));
  assert.ok(html.includes("<code>/#probe</code>"));
  assert.ok(!read("docs/privacy.md").includes("(`/probe`)"), "the source markdown is fixed too");
});

test("the erase line promises a future button, marked coming soon, and the privacy page says a person deletes by hand today", () => {
  const del = line("delete");
  assert.match(del.what, /will be able/i);
  assert.equal(del.soon, "coming soon");
  assert.match(read("privacy/index.html"), /self-serve delete button is built but turned off for now, so a person does it by hand/);
});

test("privacy page: says what stays public in the repo, what the AI company gets, and is not called private", () => {
  const md = read("docs/privacy.md");
  assert.match(md, /a board for a small group of friends/);
  assert.doesNotMatch(md, /private board/);
  assert.match(md, /first members' builds are also written into the board's public code and older commits of the repo\. Hiding a field does not remove them there/);
  assert.match(md, /when you ask privately, your own hidden sheet fields/);
  assert.match(md, /A party card posted in Discord in October 2026 used profile pictures/);
  assert.doesNotMatch(read("docs/subprocessors.md") + read("docs/legal/dpa-template.md"), /avatar|guild roles/i);
});
