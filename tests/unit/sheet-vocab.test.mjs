// The vocabulary of the party sheet: POST /sheet and the Discord /sheet command refuse a race, class, spec, profession or plan zone that is not on the board's list, and the board's
// own copy of the list (data/sheet-vocab.json, what the sheet page offers) is the Worker's list. level and goals keep their own rules. Fictional data only. No network, no AI.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../../infrastructure/worker/index.js";
import { handleDiscordInteraction } from "../../infrastructure/worker/discord.js";
import { invalidateConfigCache } from "../../infrastructure/worker/config.js";
import { sha256Hex } from "../../infrastructure/worker/crypto.js";
import { SHEET_VOCAB, VOCAB_LIST, canonicalVocab, vocabProblem } from "../../infrastructure/worker/sheet-vocab.js";
import { sheetValueProblem } from "../../infrastructure/worker/sheet-values.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";
import { createDiscordSigner } from "../helpers/discord-sign.mjs";

const ROOT = new URL("../../", import.meta.url);
const ORIGIN = "https://api.test";
const ctx = { waitUntil() {}, passThroughOnException() {} };
const AT = "2026-11-12T00:00:00.000Z";
const KEY = "member-key-vocab-0123456789abcdef", KEY_SALT = "key-salt-for-tests-0123456789";
const NAME = "Red Fox", SLUG = "red-fox", DISCORD_ID = "100000000000000100";
const quiet = async (fn) => { const e = console.error, w = console.warn, l = console.log; console.error = console.warn = console.log = () => {}; try { return await fn(); } finally { console.error = e; console.warn = w; console.log = l; } };

async function makeEnv() {
  invalidateConfigCache();
  const DB = schemaDb();
  DB.raw.prepare("INSERT INTO kv_state (key, json, updated_at) VALUES ('party', ?, ?)").run(JSON.stringify({ members: [{ name: NAME, class_key: "paladin", class: "Paladin", race: "Human", role: "tank" }] }), AT);
  DB.raw.prepare("INSERT INTO kv_state (key, json, updated_at) VALUES ('discord_members', ?, ?)").run(JSON.stringify([{ slug: SLUG, name: NAME, match: ["red fox"], id: DISCORD_ID }]), AT);
  DB.raw.prepare("INSERT INTO members (slug, key_hash, created_at) VALUES (?, ?, ?)").run(SLUG, await sha256Hex(`${KEY_SALT}:${KEY}`), AT);
  const signer = createDiscordSigner();
  const room = { fetch: async () => new Response(JSON.stringify({ ok: true })) };
  return { DB, signer, KEY_SALT, USER_SALT: "user-salt-for-tests-0123456789", ALLOWED_ORIGINS: "", DISCORD_PUBLIC_KEY: signer.publicKeyHex, BOARD_ROOM: { idFromName: () => "r", get: () => room } };
}
const post = (env, body) => quiet(() => worker.fetch(new Request(`${ORIGIN}/api/sheet`, { method: "POST", headers: { Authorization: `Board ${KEY}`, "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.9" }, body: JSON.stringify(body) }), env, ctx));
const sheetRow = (env) => (JSON.parse(env.DB.raw.prepare("SELECT json FROM kv_state WHERE key = 'party_sheets'").get()?.json || "[]").find((s) => s.slug === SLUG) || { fields: {} });
const events = (env) => Number(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM sheet_events").get().n);
async function discordSheet(env, field, value) {
  const res = await quiet(() => handleDiscordInteraction(env.signer.signedRequest({
    type: 2, id: "1", application_id: "2", token: "t", channel_id: "3", guild_id: "4", member: { nick: NAME, user: { id: DISCORD_ID, username: "redfox" } },
    data: { name: "sheet", options: [{ name: "field", type: 3, value: field }, { name: "value", type: 3, value }] },
  }), env, ctx, ORIGIN));
  assert.equal(res.status, 200);
  return (await res.json()).data;
}

const GOOD = { race: "night-elf", class: "druid", spec_path: "feral-combat", spec_at_40: "restoration", professions: ["mining", "tailoring"], plan_zone: "valley-of-strength" };
const BAD = { race: ["qzrace", "Night Elf", "orc ", "ORC", "constructor", "__proto__", "", 7, ["orc"], { orc: 1 }], class: ["qzclass", "Mage", "toString", "hasOwnProperty"], spec_path: ["qzspec", "feral", "Frost "], spec_at_40: ["qzspec40", "FIRE"],
  professions: [["qzprof"], ["mining", "mining"], ["mining", "tailoring", "qzprof"], [], "mining", [7], ["Mining"], "constructor"], plan_zone: ["qzzone", "Durotar", "tirisfal glades", "valley of strength"] };

test("POST /sheet: every value on the list is stored; every field of the vocabulary has a list", async () => {
  const env = await makeEnv();
  assert.deepEqual(Object.keys(VOCAB_LIST).sort(), ["class", "plan_zone", "professions", "race", "spec_at_40", "spec_path"]);
  for (const [field, value] of Object.entries(GOOD)) {
    const r = await post(env, { field, value, visible: true });
    assert.equal(r.status, 200, `${field}: ${await r.clone().text()}`);
    assert.deepEqual(sheetRow(env).fields[field].value, value, field);
  }
});

for (const [field, values] of Object.entries(BAD)) {
  test(`POST /sheet: an unknown ${field} is a 400 and nothing is written`, async () => {
    const env = await makeEnv();
    const before = events(env);
    for (const value of values) {
      const r = await post(env, { field, value, visible: true });
      assert.equal(r.status, 400, `${field} ${JSON.stringify(value)} answered ${r.status}`);
    }
    assert.equal(events(env), before, "no event was recorded");
    assert.equal(sheetRow(env).fields[field], undefined, "nothing was stored");
  });
}

test("POST /sheet: a visibility change and a clear still work for a vocabulary field; level and goals keep their rules", async () => {
  const env = await makeEnv();
  assert.equal((await post(env, { field: "race", value: "orc", visible: true })).status, 200);
  assert.equal((await post(env, { field: "race", visible: false })).status, 200, "hide: no value in the body");
  assert.equal(sheetRow(env).fields.race.value, "orc");
  assert.equal(sheetRow(env).fields.race.visible, false);
  assert.equal((await post(env, { field: "race", value: null, visible: true })).status, 200, "an explicit null clears");
  // level: a whole number from 1 to 60, as before; goals: any text, as before
  assert.equal((await post(env, { field: "level", value: 61 })).status, 400);
  assert.equal((await post(env, { field: "level", value: 42 })).status, 200);
  assert.equal((await post(env, { field: "goals", value: "a fictional goal, with any words in it" })).status, 200);
  assert.equal((await post(env, { field: "launch_state", value: "queue" })).status, 200, "launch_state keeps the rule it had");
});

test("Discord /sheet: a value on the list is stored in its stored form; an unknown one is an ephemeral refusal and nothing is written", async () => {
  const env = await makeEnv();
  const cases = [["race", "Night Elf", "night-elf"], ["class", "Druid", "druid"], ["spec_path", "Feral Combat", "feral-combat"], ["spec_at_40", "restoration", "restoration"], ["plan_zone", "Valley of Strength", "valley-of-strength"], ["professions", "Mining and Tailoring", ["mining", "tailoring"]], ["professions", "herbalism, alchemy", ["herbalism", "alchemy"]]];
  for (const [field, typed, stored] of cases) {
    const d = await discordSheet(env, field, typed);
    assert.equal(d.flags, 64);
    assert.deepEqual(sheetRow(env).fields[field].value, stored, `${field} ${typed}`);
  }
  const before = events(env);
  for (const [field, typed] of [["race", "Qzrace"], ["class", "qzclass"], ["spec_path", "Qzspec"], ["spec_at_40", "Frost Fire"], ["plan_zone", "Qzzone"], ["professions", "Mining and Qzprof"], ["professions", "mining mining"], ["race", "constructor"]]) {
    const d = await discordSheet(env, field, typed);
    assert.equal(d.flags, 64, `${field} ${typed}`);
    assert.match(d.content, /not on the board's list/, `${field} ${typed}`);
    assert.ok(!d.content.includes("Qzrace"), "the refusal does not echo the value");
  }
  assert.equal(events(env), before, "nothing was written");
});

test("the unit rules: vocabProblem and sheetValueProblem agree, and a numeric or object value is never on a list", () => {
  for (const [field, v] of Object.entries(GOOD)) { assert.equal(vocabProblem(field, v), null, field); assert.equal(sheetValueProblem(field, v, undefined), null, field); }
  assert.notEqual(vocabProblem("race", "Orc"), null, "exact slugs only on the board's path");
  assert.equal(vocabProblem("race", "Orc", { loose: true }), null, "the Discord path reads typed words");
  assert.equal(canonicalVocab("professions", "Mining & Tailoring", { loose: true }).join(), "mining,tailoring");
  assert.equal(sheetValueProblem("goals", "anything"), null);
  assert.equal(sheetValueProblem("race", undefined, { visible: false }), null);
  assert.equal(sheetValueProblem("race", null, undefined, { allowClear: true }), null);
  assert.notEqual(sheetValueProblem("race", null, undefined), null, "Discord and the admin route cannot clear");
});

// The board's copy of the list is the Worker's list: what the sheet page offers is exactly what a write accepts.
test("data/sheet-vocab.json is the Worker's vocabulary, and every entry is a slug with a label", () => {
  const json = JSON.parse(readFileSync(new URL("data/sheet-vocab.json", ROOT), "utf8"));
  assert.deepEqual(json, JSON.parse(JSON.stringify(SHEET_VOCAB)), "regenerate data/sheet-vocab.json from infrastructure/worker/sheet-vocab.js");
  for (const list of ["race", "class", "spec", "professions", "plan_zone"]) for (const [k, label] of Object.entries(json[list])) { assert.match(k, /^[a-z0-9-]{1,32}$/, k); assert.ok(typeof label === "string" && label.length > 0, k); }
  for (const [cls, specs] of Object.entries(json.spec_of)) { assert.ok(cls in json.class, cls); for (const sp of specs) assert.ok(sp in json.spec, `${cls}: ${sp}`); }
  assert.deepEqual(Object.keys(json.spec_of).sort(), Object.keys(json.class).sort(), "every class has its specs");
});

test("the sheet page offers the vocabulary and nothing else: scenes/sheet.js reads data/sheet-vocab.json and no longer builds a list from the party's own documents", () => {
  const src = readFileSync(new URL("scenes/sheet.js", ROOT), "utf8");
  assert.ok(src.includes("data/sheet-vocab.json"));
  const fn = /function vocab\(\) \{[\s\S]*?\n\}\n/.exec(src);
  assert.ok(fn, "vocab() takes no document");
  assert.ok(!/D\.party|D\.decide|\.people|nobody|racials/.test(fn[0]), "the lists do not come from party-derived documents (they are withheld while a member hides a field)");
});
