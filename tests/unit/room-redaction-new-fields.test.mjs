// A field added or renamed at a broadcast call site must not reach a stranger by default. room.js keeps allow lists (PUBLIC_TOP_KEYS,
// PUBLIC_ITEM_KEYS), so a new key is dropped for anonymous sockets until someone lists it here and in public-read-contract's allow list.
// socket-ask-ids.test.mjs drives today's shapes; this drives shapes that do not exist yet: a renamed `ask`, a new content key at the top
// and on an item, a non-scalar value under an allowed key, an item that is not an object. Fictional data only.
import test from "node:test";
import assert from "node:assert/strict";
import { BoardRoom, redactForPublic, PUBLIC_ITEM_KEYS, PUBLIC_TOP_KEYS } from "../../infrastructure/worker/room.js";

const SECRET = "zqnew private text";
const OWN_ID = "11111111-2222-4333-8444-555555555555", OTHER_ID = "99999999-2222-4333-8444-555555555555";

function fanOut(payload) {
  const got = { anon: [], member: [], owner: [], otherOwner: [] };
  const sock = (aud, sink) => ({ deserializeAttachment: () => aud, send: (m) => sink.push(m) });
  const ctx = { getWebSockets: () => [sock({}, got.anon), sock({ member: true }, got.member), sock({ ask: OWN_ID }, got.owner), sock({ ask: OTHER_ID }, got.otherOwner)], setWebSocketAutoResponse() {} };
  new BoardRoom(ctx, {}).broadcast(JSON.stringify(payload));
  return got;
}

test("a new or renamed top-level key never reaches an anonymous socket", () => {
  for (const key of ["turn", "preview", "prompt", "summary", "note", "user", "member", "text", "question", "answer", "q", "error", "body", "ask", "forAsk", "slug"]) {
    const { anon } = fanOut({ type: "data", key: "stats", [key]: SECRET });
    assert.equal(anon.length, 1, key);
    assert.ok(!anon[0].includes(SECRET), `top-level "${key}" reached an anonymous socket: ${anon[0]}`);
    assert.equal(JSON.parse(anon[0]).type, "data", "the nudge itself still arrives");
  }
});

test("a new or renamed key on an item or intent never reaches an anonymous socket", () => {
  for (const holder of ["item", "intent"]) {
    for (const key of ["id", "by", "slug", "q", "text", "question", "answer", "prompt", "preview", "note", "user", "name", "error", "body", "cites", "sources", "asker", "title", "label"]) {
      const { anon } = fanOut({ type: "intent", [holder]: { kind: "ask", status: "answered", [key]: SECRET } });
      assert.ok(!anon[0].includes(SECRET), `${holder}.${key} reached an anonymous socket: ${anon[0]}`);
      assert.equal(JSON.parse(anon[0])[holder].kind, "ask", "the allowed keys stay");
    }
  }
});

test("a non-scalar value under an allowed item key is dropped, so a secret cannot ride inside an object or array", () => {
  for (const key of PUBLIC_ITEM_KEYS) {
    for (const wrapped of [{ q: SECRET }, [SECRET], { nested: { deeper: SECRET } }]) {
      const out = redactForPublic({ type: "intent", item: { [key]: wrapped } });
      assert.ok(!JSON.stringify(out).includes(SECRET), `item.${key} = ${JSON.stringify(wrapped)}`);
    }
  }
});

test("an item or intent that is not a plain object is removed whole", () => {
  for (const bad of [SECRET, 7, true, null, [SECRET], [{ kind: "ask", q: SECRET }]]) {
    for (const holder of ["item", "intent"]) {
      const out = redactForPublic({ type: "intent", [holder]: bad });
      assert.ok(!(holder in out), `${holder} = ${JSON.stringify(bad)}`);
    }
  }
});

test("members and the owner of a guest ask still get what they got before; a different guest, and a member, do not get a guest's answer", () => {
  const msg = { type: "ask", forAsk: OWN_ID, ask: { id: OWN_ID, q: SECRET, answer: SECRET, share: false } };
  const got = fanOut(msg);
  assert.ok(got.owner[0].includes(SECRET), "the owner reads its own answer");
  for (const who of ["anon", "member", "otherOwner"]) assert.ok(!got[who][0].includes(SECRET), `${who} read a guest's private answer: ${got[who][0]}`);
  for (const who of Object.keys(got)) assert.ok(!got[who][0].includes("forAsk"), `forAsk left the room to ${who}`);
});

test("a member socket gets a new top-level key; that is the documented difference from an anonymous one", () => {
  const { member, anon } = fanOut({ type: "data", key: "stats", summary: SECRET });
  assert.ok(member[0].includes(SECRET));
  assert.ok(!anon[0].includes(SECRET));
  assert.ok(!PUBLIC_TOP_KEYS.includes("summary"));
});

test("a broadcast that is not valid JSON or not an object reaches no one and does not throw", () => {
  const sent = [];
  const ctx = { getWebSockets: () => [{ deserializeAttachment: () => ({ member: true }), send: (m) => sent.push(m) }], setWebSocketAutoResponse() {} };
  const room = new BoardRoom(ctx, {});
  for (const bad of ["{not json", "null", "5", '"text"']) {
    assert.doesNotThrow(() => room.broadcast(bad), bad);
  }
  assert.ok(!sent.some((m) => m.includes("not json")));
});
