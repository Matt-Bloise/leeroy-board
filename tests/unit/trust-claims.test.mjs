// Trust claims: every sentence on the trust card (data/trust.json) and the privacy page is backed by what the Worker does.
// Seeded with fictional data only: a made-up member key, made-up names, a made-up hidden value. No network, no AI.
//   reads:  names and builds only; the avatar and guild roles are not read or used anywhere in the Worker or the page code.
//   sees:   anyone who asks the server can read names, builds and sign-ups; hidden sheet fields are not in any anonymous read.
//   needs a key: /api/me and /api/sheet refuse an anonymous caller; with the key, /api/sheet adds the member's own hidden field.
// If the wording is made false (or the behaviour changes under it), a test here fails.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import worker from "../../infrastructure/worker/index.js";
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
    { slug: "red-fox", name: "Red Fox", fields: { class: { value: "paladin", visible: true, source: "board", at: AT }, notes: { value: HIDDEN, visible: false, source: "board", at: AT } }, updated: AT },
    { slug: "blue-owl", name: "Blue Owl", fields: { class: { value: "mage", visible: true, source: "board", at: AT }, notes: { value: OTHER_HIDDEN, visible: false, source: "board", at: AT } }, updated: AT },
  ]);
  DB.raw.prepare("INSERT INTO members (slug, key_hash, created_at) VALUES ('red-fox', ?, ?)").run(await sha256Hex(`${KEY_SALT}:${KEY}`), AT);
  const room = { fetch: async () => new Response(JSON.stringify({ ok: true, sent: 0, skipped: 0 })) };
  return { DB, ALLOWED_ORIGINS: "", KEY_SALT, USER_SALT: "user-salt-for-tests-0123456789", BOARD_ADMIN_TOKEN: "admin-token-for-tests-0123456789abcdef", BOARD_ROOM: { idFromName: () => "r", get: () => room } };
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

test("a field the member hides on the sheet is in no anonymous read", async () => {
  const env = await makeEnv();
  for (const p of ["/data/party", "/data/signups", "/bootstrap", "/state", "/state?full=1&admin=1", "/bootstrap?full=1&roster=1"]) {
    const r = await anon(env, p);
    assert.equal(r.status, 200, p);
    assert.ok(!r.text.includes("zqtc") && !r.text.includes("zqto"), `${p} holds no hidden value`);
    assert.ok(!r.text.includes('"notes"'), `${p} holds no hidden field key`);
  }
  // the visible field of the same sheet is shown, so the check above is not an empty read
  assert.ok((await anon(env, "/state")).text.includes('"class"'));
});

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
  assert.equal(sj.sheet.fields.notes.value, HIDDEN, "the owner's own sheet holds the hidden field");
  assert.ok(!text.includes("zqto"), "another member's hidden field stays out of the owner's read");
  assert.equal(sj.party.find((s) => s.slug === "red-fox").fields.notes.value, HIDDEN);
  assert.equal(sj.party.find((s) => s.slug === "blue-owl").fields.notes, undefined);
});

test("trust card: 'sees' says anyone can read names, builds and sign-ups, hidden fields are not shown, settings and sheet need a key", () => {
  const sees = line("sees").what;
  assert.match(sees, /anyone/i);
  assert.match(sees, /anyone with the link/i);
  assert.match(sees, /names, builds and sign-ups/);
  assert.match(sees, /hide on your sheet are not shown/i);
  assert.match(sees, /need your key/i);
  assert.match(sees, /Matt and the group admins run the board/);
  assert.doesNotMatch(JSON.stringify(trust), /Members of your own guild see/);
});

test("trust card: 'reads' names only what the code reads (no avatar, no guild roles, no email)", () => {
  const reads = line("reads").what;
  assert.match(reads, /Discord name/);
  assert.match(reads, /Not your picture, your roles or your email/);
  assert.doesNotMatch(reads.replace(/Not your picture, your roles or your email\./, ""), /avatar|picture|roles|email/i);
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
