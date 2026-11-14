// An anonymous live socket never learns an ask's id or who asked. An ask's id is its credential (GET /api/ask?id= answers anyone holding a UUID id),
// so a stranger who saw one could read the question and answer; and a private ask must not say who asked. Every broadcast shape the Worker sends
// today (ai-models.js, ask-answer.js, index.js) goes through BoardRoom to an anonymous, a member and a guest-owner socket.
// Fictional data only. Run: node --test tests/unit/socket-ask-ids.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { BoardRoom, redactForPublic, PUBLIC_ITEM_KEYS, PUBLIC_TOP_KEYS } from "../../infrastructure/worker/room.js";

const ID = "11111111-2222-4333-8444-555555555555";
const ASKER = "zq-asker-red-fox"; // the asker's name or slug: a marker that must not reach a stranger
const Q = "zq question text", A = "zq answer text";

function fanOut(payload) {
  const got = { anon: [], member: [], owner: [] };
  const sock = (aud, sink) => ({ deserializeAttachment: () => aud, send: (m) => sink.push(m) });
  const ctx = { getWebSockets: () => [sock({}, got.anon), sock({ member: true }, got.member), sock({ ask: ID }, got.owner)], setWebSocketAutoResponse() {} };
  new BoardRoom(ctx, {}).broadcast(JSON.stringify(payload));
  return got;
}
const item = (over = {}) => ({ id: ID, kind: "ask", by: ASKER, slug: ASKER, q: Q, text: Q, answer: A, cites: [], sources: [], model: "m", provider: "p", share: true, ms: 9, status: "answered", at: "t", ...over });

// The shapes, from the broadcastToRoom call sites
const SHAPES = {
  "shared completion, stats intent (ai-models.js)": { type: "data", key: "stats", intent: item() },
  "shared completion, ask (ai-models.js)": { type: "ask", slug: ASKER, ask: item() },
  "guest completion, forAsk (ai-models.js)": { type: "ask", slug: ASKER, forAsk: ID, ask: item({ share: false }) },
  "private nudge (ai-models.js, ask-answer.js)": { type: "ask", slug: ASKER },
  "reused answer (ai-models.js)": { type: "ask", slug: ASKER, ask: item({ model: "reused-answer" }) },
  "thinking item (index.js POST /intent)": { type: "intent", item: { id: ID, kind: "ask", by: ASKER, slug: ASKER, q: Q, provider: "p", status: "thinking", at: "t" } },
  "private thinking item": { type: "intent", item: { id: ID, kind: "ask", by: ASKER, slug: ASKER, provider: "p", status: "thinking", at: "t" } },
  "error item": { type: "intent", item: { id: ID, kind: "ask", by: ASKER, status: "error", error: A, at: "t" } },
  "manual answer (ask-answer.js)": { type: "ask", ask: { id: ID, status: "answered", answer: A, sources: [], answered_at: "t", failed: null } },
};

for (const [name, payload] of Object.entries(SHAPES)) {
  test(`anonymous socket, ${name}: no ask id, no asker, no question or answer`, () => {
    const { anon } = fanOut(payload);
    assert.equal(anon.length, 1);
    for (const needle of [ID, ASKER, Q, A]) assert.ok(!anon[0].includes(needle), `${needle} reached an anonymous socket: ${anon[0]}`);
  });
}

test("members keep the full message; the owner of a guest ask gets its own answer", () => {
  const shared = fanOut(SHAPES["shared completion, ask (ai-models.js)"]);
  assert.ok(shared.member[0].includes(Q) && shared.member[0].includes(ID) && shared.member[0].includes(ASKER));
  const guest = fanOut(SHAPES["guest completion, forAsk (ai-models.js)"]);
  assert.ok(guest.owner[0].includes(A));
  assert.ok(!guest.member[0].includes(A), "a member does not get a guest's private answer");
  assert.ok(!guest.owner[0].includes("forAsk"));
});

test("the allow lists hold no id, by or slug", () => {
  for (const k of ["id", "by", "slug"]) assert.ok(!PUBLIC_ITEM_KEYS.includes(k), k);
  for (const k of ["slug", "ask", "forAsk"]) assert.ok(!PUBLIC_TOP_KEYS.includes(k), k);
});

test("a message with nothing to remove is passed on unchanged", () => {
  const m = { type: "library", categories: ["classes"], page: "classes/mage" };
  assert.equal(redactForPublic(m), m);
});
