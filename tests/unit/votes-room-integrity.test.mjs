// B41 + B43d: vote ballots, room bounds, hidden-field leftovers, answered-ask overwrite. Real Worker code over in-memory SQLite built
// from schema.sql (which carries vote_ballots, mirrored from migration 0010). No network, no AI, made-up ids and salts only.
// Each test fails when its change is reverted. Run: node --test tests/unit/votes-room-integrity.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import worker, { recordSheetEventInD1 } from "../../infrastructure/worker/index.js";
import { handleDiscordInteraction } from "../../infrastructure/worker/discord.js";
import { applyManualAnswer } from "../../infrastructure/worker/ask-answer.js";
import { BoardRoom } from "../../infrastructure/worker/room.js";
import { loadPublicVotes, voterHash } from "../../infrastructure/worker/votes.js";
import { invalidateConfigCache } from "../../infrastructure/worker/config.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";
import { createDiscordSigner } from "../helpers/discord-sign.mjs";

// The limits are written out here on purpose: the test pins the numbers, not the exports.
const MAX_BROADCAST_BYTES = 256 * 1024, MAX_BROADCAST_RECIPIENTS = 500, MAX_SOCKETS = 500;
const USER_SALT = "user-salt-for-tests-0123456789";
const VOTE = "0a1b2c3d";
const ORIGIN = "https://api.test";
const ctx = { waitUntil() {}, passThroughOnException() {} };
const signer = createDiscordSigner();
const silently = async (fn) => { const e = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = e; } };

function makeEnv() {
  const DB = schemaDb();
  const sent = [];
  const room = { fetch: async (_u, init) => { sent.push(JSON.parse(init.body)); return new Response("ok"); } };
  invalidateConfigCache();
  return { DB, sent, USER_SALT, KEY_SALT: "k".repeat(24), DISCORD_PUBLIC_KEY: signer.publicKeyHex, ALLOWED_ORIGINS: "", BOARD_ROOM: { idFromName: () => "r", get: () => room } };
}
function seedVote(env) {
  env.DB.raw.prepare("INSERT INTO kv_state (key, json, updated_at) VALUES ('votes:index', ?, 'x')").run(JSON.stringify({ ids: [VOTE] }));
  env.DB.raw.prepare("INSERT INTO kv_state (key, json, updated_at) VALUES (?, ?, 'x')").run(`vote:${VOTE}`, JSON.stringify({
    id: VOTE, title: "Pick", choices: ["Alpha", "Beta"], ballots: {}, created_at: "2026-11-01T00:00:00Z", closes_at: "2999-01-01T00:00:00Z",
  }));
}
let seq = 0;
const press = (env, userId, index) => silently(async () => {
  const res = await handleDiscordInteraction(signer.signedRequest({
    id: String(910000000000000000n + BigInt(++seq)), type: 3, application_id: "100000000000000099", token: "tok", guild_id: "200000000000000001",
    data: { custom_id: `vote:${VOTE}:${index}`, component_type: 2 }, member: { user: { id: userId, username: "u" }, permissions: "0" },
  }), env, ctx, ORIGIN);
  return JSON.parse(await res.text());
});
const ids = ["100000000000000001", "100000000000000002", "100000000000000003"];

// ---- 1. votes: one row per ballot ------------------------------------------------------------------------------------------------
test("votes: concurrent casts by different people both count (no lost update)", async () => {
  const env = makeEnv(); seedVote(env);
  await Promise.all(ids.map((id, i) => press(env, id, i % 2)));
  const [vote] = await loadPublicVotes(env.DB, Date.now());
  assert.equal(vote.choices.reduce((n, c) => n + c.count, 0), 3, "all three ballots survive");
});

test("votes: a cast writes a ballot row and never rewrites the vote document", async () => {
  const env = makeEnv(); seedVote(env);
  const before = env.DB.raw.prepare("SELECT json FROM kv_state WHERE key = ?").get(`vote:${VOTE}`).json;
  await press(env, ids[0], 1);
  const rows = env.DB.raw.prepare("SELECT voter_hash, choice FROM vote_ballots WHERE vote_id = ?").all(VOTE);
  assert.deepEqual(rows.map((r) => r.choice), [1]);
  assert.equal(rows[0].voter_hash, await voterHash(ids[0], VOTE, USER_SALT));
  assert.equal(env.DB.raw.prepare("SELECT json FROM kv_state WHERE key = ?").get(`vote:${VOTE}`).json, before, "document untouched");
});

test("votes: changing a vote replaces that voter's row only; an erased document ballot is not brought back", async () => {
  const env = makeEnv(); seedVote(env);
  await press(env, ids[0], 0); await press(env, ids[1], 0); await press(env, ids[0], 1);
  const [vote] = await loadPublicVotes(env.DB, Date.now());
  assert.deepEqual(vote.choices.map((c) => c.count), [1, 1]);
});

test("votes: an erase that lands between a cast's read and its write is not undone", async () => {
  const env = makeEnv(); seedVote(env);
  const h = await voterHash(ids[2], VOTE, USER_SALT);
  const path = `$.ballots."${h}"`;
  env.DB.raw.prepare("UPDATE kv_state SET json = json_set(json, ?, 0) WHERE key = ?").run(path, `vote:${VOTE}`); // a legacy ballot inside the document
  const real = env.DB.prepare.bind(env.DB);
  let erased = false;
  env.DB.prepare = (sql) => {
    const st = real(sql);
    if (erased || !/^SELECT json FROM kv_state WHERE key = \?/.test(sql)) return st;
    const first = st.first.bind(st);
    st.first = async () => { // the cast has just read the document; the erase (data-rights does json_remove) lands now
      const row = await first();
      if (row && row.json.includes(h)) { erased = true; env.DB.raw.prepare("UPDATE kv_state SET json = json_remove(json, ?) WHERE key = ?").run(path, `vote:${VOTE}`); }
      return row;
    };
    return st;
  };
  await press(env, ids[0], 1);
  assert.ok(erased, "the race was staged");
  const doc = JSON.parse(env.DB.raw.prepare("SELECT json FROM kv_state WHERE key = ?").get(`vote:${VOTE}`).json);
  assert.ok(!(h in doc.ballots), "erased ballot stays erased");
});

test("votes: a D1 error other than a missing table is not swallowed", async () => {
  const env = makeEnv(); seedVote(env);
  const real = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => { if (/FROM vote_ballots/.test(sql)) throw new Error("D1_ERROR: database is locked"); return real(sql); };
  await assert.rejects(() => loadPublicVotes(env.DB, Date.now()), /locked/);
});

// ---- 2. room bounds --------------------------------------------------------------------------------------------------------------
function makeRoom(socketCount) {
  const received = [];
  const sockets = Array.from({ length: socketCount }, () => ({ send: (m) => received.push(m) }));
  const room = new BoardRoom({ getWebSockets: () => sockets, setWebSocketAutoResponse() {} }, {});
  return { room, received };
}
const post = (room, body, headers = {}) => room.fetch(new Request("https://room.internal/api/broadcast", { method: "POST", headers, body }));

test("room: an oversize payload is rejected with 413 and reaches no socket", async () => {
  const { room, received } = makeRoom(3);
  const res = await post(room, JSON.stringify({ type: "data", blob: "x".repeat(MAX_BROADCAST_BYTES + 1) }));
  assert.equal(res.status, 413);
  assert.equal((await res.json()).error, "payload_too_large");
  assert.equal(received.length, 0);
});

test("room: bad JSON is 400, a non-object is 400, a normal message is delivered", async () => {
  const { room, received } = makeRoom(2);
  assert.equal((await post(room, "{nope")).status, 400);
  assert.equal((await post(room, JSON.stringify([1, 2]))).status, 400);
  const ok = await post(room, JSON.stringify({ type: "ask" }));
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, sent: 2, skipped: 0 });
  assert.equal(received.length, 2);
});

test("room: fan-out is capped and the response says how many were skipped", async () => {
  const { room, received } = makeRoom(MAX_BROADCAST_RECIPIENTS + 7);
  const res = await post(room, JSON.stringify({ type: "ask" }));
  assert.deepEqual(await res.json(), { ok: true, sent: MAX_BROADCAST_RECIPIENTS, skipped: 7 });
  assert.equal(received.length, MAX_BROADCAST_RECIPIENTS);
});

test("room: new sockets are refused (503) once MAX_SOCKETS are open", async () => {
  const { room } = makeRoom(MAX_SOCKETS);
  const res = await room.fetch(new Request("https://room.internal/api/live", { headers: { Upgrade: "websocket" } }));
  assert.equal(res.status, 503);
});

// ---- 3. hidden-to-visible leftovers ----------------------------------------------------------------------------------------------
test("sheet: a field that turns hidden stops being published in the party document", async () => {
  const env = makeEnv();
  env.DB.raw.prepare("INSERT INTO kv_state (key, json, updated_at) VALUES ('party', ?, 'x')").run(JSON.stringify({ members: [{ name: "Santa", race: "Orc", class: "Rogue", spec: "Sub" }] }));
  const party = () => JSON.parse(env.DB.raw.prepare("SELECT json FROM kv_state WHERE key = 'party'").get().json).members[0];
  const ev = (field, value, visible) => recordSheetEventInD1(env, ORIGIN, { slug: "santa", name: "Santa", field, value, visible });
  await ev("race", "Troll", true);
  assert.equal(party().race, "Troll");
  await ev("race", "Troll", false);
  assert.equal(party().race, undefined, "the old public value is gone once hidden");
  await ev("class", null, false);
  assert.equal(party().class, undefined, "hiding with no value also unpublishes");
  assert.equal(party().spec, "Sub", "other fields untouched");
  await ev("race", "Dwarf", true);
  assert.equal(party().race, "Dwarf", "showing it again publishes the new value");
});

// ---- 4. answered-ask overwrite guard ---------------------------------------------------------------------------------------------
const seedAsk = (env, id, status) => env.DB.raw.prepare("INSERT INTO ask_turns (id, by_name, question, answer, status, share, created_at) VALUES (?, 'Santa', 'q', ?, ?, 1, 'x')").run(id, status === "answered" ? "FIRST" : null, status);
const answerRow = (env, id) => env.DB.raw.prepare("SELECT answer, status FROM ask_turns WHERE id = ?").get(id);

test("ask: the asker cannot overwrite an already answered ask; an admin can", async () => {
  const env = makeEnv();
  seedAsk(env, "t1", "answered");
  const denied = await applyManualAnswer(env, { id: "t1", answer: "OVERWRITE", byName: "Santa", isAdmin: false });
  assert.deepEqual([denied.ok, denied.code], [false, "already_answered"]);
  assert.equal(answerRow(env, "t1").answer, "FIRST");
  const adm = await applyManualAnswer(env, { id: "t1", answer: "CORRECTED", byName: "", isAdmin: true });
  assert.equal(adm.ok, true);
  assert.equal(answerRow(env, "t1").answer, "CORRECTED");
});

test("ask: the asker can still answer a waiting ask (thinking or pending), and only once", async () => {
  const env = makeEnv();
  seedAsk(env, "t2", "thinking"); seedAsk(env, "t3", "pending");
  for (const id of ["t2", "t3"]) {
    assert.equal((await applyManualAnswer(env, { id, answer: "mine", byName: "Santa", isAdmin: false })).ok, true, id);
    assert.equal((await applyManualAnswer(env, { id, answer: "again", byName: "Santa", isAdmin: false })).code, "already_answered", id);
    assert.equal(answerRow(env, id).answer, "mine");
  }
});
