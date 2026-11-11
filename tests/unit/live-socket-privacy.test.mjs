// Audit 2026-11-06 follow-up to finding 4: the /api/live socket used to push every shared question and answer to every open socket,
// signed in or not. Now only member sockets (valid member key or web session) and the one guest socket that owns an ask get the text;
// everyone else gets the same message with the text removed. Real BoardRoom, fake sockets, made-up key and names. No network, no AI.
import test from "node:test";
import assert from "node:assert/strict";
import { BoardRoom, LIVE_AUTH_HEADER } from "../../infrastructure/worker/room.js";
import worker from "../../infrastructure/worker/index.js";
import { sha256Hex } from "../../infrastructure/worker/crypto.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";

const SALT = "salt-for-tests-0123456789", KEY = "member-key-for-tests-0123456789ab";
const Q = "PRIVATE-PROBE-QUESTION-31 call me on 555-0100", A = "PRIVATE-PROBE-ANSWER-31";

function fakeSocket(att) {
  const s = { got: [], att: att || null, send(m) { s.got.push(m); }, serializeAttachment(a) { s.att = a; }, deserializeAttachment() { return s.att; } };
  return s;
}
async function makeRoom(env = {}) {
  const sockets = { anon: fakeSocket(), member: fakeSocket(), web: fakeSocket(), guestA: fakeSocket(), guestB: fakeSocket() };
  const ctx = { getWebSockets: () => Object.values(sockets), setWebSocketAutoResponse() {}, acceptWebSocket() {} };
  const room = new BoardRoom(ctx, env);
  return { room, sockets };
}
const push = (room, payload) => room.fetch(new Request("https://room.internal/broadcast", { method: "POST", body: JSON.stringify(payload) }));
const frame = (room, ws, o) => room.webSocketMessage(ws, JSON.stringify(o));
const text = (s) => s.got.join("\n");
async function authedRoom() {
  const DB = schemaDb();
  DB.raw.prepare("INSERT INTO members (slug, key_hash, created_at) VALUES ('santa', ?, '2026-11-01T00:00:00Z')").run(await sha256Hex(`${SALT}:${KEY}`));
  const r = await makeRoom({ DB, KEY_SALT: SALT });
  await frame(r.room, r.sockets.member, { type: "auth", key: KEY });
  r.sockets.web.serializeAttachment({ member: true }); // what the upgrade does when the Worker vouches for a web session
  await frame(r.room, r.sockets.guestA, { type: "auth", ask: "11111111-2222-3333-4444-555555555555" });
  await frame(r.room, r.sockets.guestB, { type: "auth", ask: "99999999-2222-3333-4444-555555555555" });
  for (const s of Object.values(r.sockets)) s.got.length = 0;
  return r;
}

test("shared ask: member key and web session sockets get the text; an anonymous socket gets a nudge with no question or answer", async () => {
  const { room, sockets } = await authedRoom();
  await push(room, { type: "ask", slug: "santa", ask: { id: "x1", q: Q, text: Q, answer: A, cites: ["p"], share: true, status: "answered" } });
  assert.ok(text(sockets.member).includes(A) && text(sockets.member).includes(Q), "member key socket");
  assert.ok(text(sockets.web).includes(A), "web session socket");
  for (const s of [sockets.anon, sockets.guestA, sockets.guestB]) {
    assert.equal(s.got.length, 1);
    assert.ok(!text(s).includes("PRIVATE-PROBE"), "no text for a non-member");
    assert.deepEqual(JSON.parse(s.got[0]), { type: "ask", slug: "santa" });
  }
});

test("shared ask in flight: the intent item and the stats row lose the question, answer and error text for non-members", async () => {
  const { room, sockets } = await authedRoom();
  await push(room, { type: "intent", item: { id: 5, kind: "ask", by: "Santa", q: Q, status: "thinking", at: "t" } });
  await push(room, { type: "data", key: "stats", intent: { id: 5, kind: "ask", q: Q, text: Q, answer: A, status: "answered" } });
  await push(room, { type: "intent", item: { id: 5, kind: "ask", by: "Santa", q: Q, status: "error", error: A } });
  assert.ok(text(sockets.member).includes(Q) && text(sockets.member).includes(A));
  assert.ok(!text(sockets.anon).includes("PRIVATE-PROBE"));
  assert.deepEqual(JSON.parse(sockets.anon.got[0]).item, { id: 5, kind: "ask", by: "Santa", status: "thinking", at: "t" });
  assert.equal(JSON.parse(sockets.anon.got[1]).intent.status, "answered");
});

test("guest ask: only the socket that sent that ask's id gets the answer; not another guest, not an anonymous socket, not a member", async () => {
  const { room, sockets } = await authedRoom();
  await push(room, { type: "ask", slug: "guest", forAsk: "11111111-2222-3333-4444-555555555555", ask: { id: "11111111-2222-3333-4444-555555555555", q: Q, answer: A, share: false, status: "answered" } });
  assert.ok(text(sockets.guestA).includes(A), "the owner");
  for (const s of [sockets.guestB, sockets.anon, sockets.member, sockets.web]) assert.ok(!text(s).includes("PRIVATE-PROBE"));
  assert.ok(!text(sockets.guestA).includes("forAsk"), "the routing field never leaves the room");
  assert.deepEqual(JSON.parse(sockets.member.got[0]), { type: "ask", slug: "guest" });
});

test("a bad member key, or someone else's ask id guess, earns nothing", async () => {
  const { room, sockets } = await authedRoom();
  await frame(room, sockets.anon, { type: "auth", key: "wrong-key-for-tests-0123456789abcdef" });
  await frame(room, sockets.anon, { type: "auth", ask: "short" });
  assert.equal(JSON.parse(sockets.anon.got[0]).ok, false);
  sockets.anon.got.length = 0;
  await push(room, { type: "ask", slug: "santa", ask: { q: Q, answer: A } });
  assert.ok(!text(sockets.anon).includes("PRIVATE-PROBE"));
});

test("messages with no text (presence, state, library) reach every socket unchanged", async () => {
  const { room, sockets } = await authedRoom();
  await push(room, { type: "ask", slug: "santa" });
  for (const s of Object.values(sockets)) assert.equal(s.got[0], '{"type":"ask","slug":"santa"}');
});

test("Worker /live: a client-supplied live-auth header never reaches the room", async () => {
  const seen = [];
  const room = { fetch: async (req) => { seen.push(req.headers.get(LIVE_AUTH_HEADER)); return new Response("no", { status: 426 }); } };
  const env = { DB: schemaDb(), KEY_SALT: SALT, USER_SALT: "user-salt-for-tests-0123456789", ALLOWED_ORIGINS: "", BOARD_ROOM: { idFromName: () => "r", get: () => room } };
  await worker.fetch(new Request("https://api.test/api/live", { headers: { Upgrade: "websocket", [LIVE_AUTH_HEADER]: "web" } }), env, { waitUntil() {}, passThroughOnException() {} });
  assert.deepEqual(seen, [null]);
});
