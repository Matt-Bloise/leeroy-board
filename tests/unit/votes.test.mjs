// Unit tests for the vote logic. Made-up ids and salts only. No network, no D1, no AI.
import test from "node:test";
import assert from "node:assert/strict";
import {
  voterHash, newVoteId, parseChoices, createVote, isOpen, castVote, tally, publicView,
  parseVoteCustomId, renderMessage, addToIndex, loadPublicVotes,
} from "../../infrastructure/worker/votes.js";
import { sha256Hex } from "../../infrastructure/worker/crypto.js";

const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);
const mk = (over = {}) => {
  const r = createVote({ id: "0a1b2c3d", title: "Pick a name", choices: "Alpha | Beta | Gamma", now: NOW, ...over });
  assert.ok(r.ok, r.error);
  return r.vote;
};

test("create: defaults to 72 hours and trims choices", () => {
  const v = mk();
  assert.deepEqual(v.choices, ["Alpha", "Beta", "Gamma"]);
  assert.equal(Date.parse(v.closes_at) - NOW, 72 * 3600000);
  assert.deepEqual(v.ballots, {});
});

test("create: honours closes_in_hours and rejects bad hours", () => {
  assert.equal(Date.parse(mk({ hours: 2 }).closes_at) - NOW, 2 * 3600000);
  for (const h of [0, -1, 1.5, 721, "abc"]) {
    assert.equal(createVote({ id: "0a1b2c3d", title: "t", choices: "a|b", hours: h, now: NOW }).ok, false, String(h));
  }
});

test("limits: 2 to 5 choices, length, duplicates, title", () => {
  assert.equal(parseChoices("only").ok, false);
  assert.equal(parseChoices("a||").ok, false);
  assert.equal(parseChoices("a|b").ok, true);
  assert.equal(parseChoices("a|b|c|d|e").ok, true);
  assert.equal(parseChoices("a|b|c|d|e|f").ok, false);
  assert.equal(parseChoices(`a|${"x".repeat(81)}`).ok, false);
  assert.equal(parseChoices(`a|${"x".repeat(80)}`).ok, true);
  assert.equal(parseChoices("Same|same").ok, false);
  assert.equal(createVote({ id: "0a1b2c3d", title: "  ", choices: "a|b", now: NOW }).ok, false);
  assert.equal(createVote({ id: "0a1b2c3d", title: "x".repeat(201), choices: "a|b", now: NOW }).ok, false);
  assert.equal(createVote({ id: "bad id", title: "t", choices: "a|b", now: NOW }).ok, false);
});

test("newVoteId gives 8 hex characters", () => {
  assert.match(newVoteId(), /^[a-f0-9]{8}$/);
  assert.equal(newVoteId(new Uint8Array([1, 2, 255, 0])), "0102ff00");
});

test("one vote per voter", () => {
  let v = mk();
  v = castVote(v, "voter-one", 0, NOW).vote;
  v = castVote(v, "voter-one", 0, NOW).vote;
  v = castVote(v, "voter-two", 0, NOW).vote;
  assert.deepEqual(tally(v), [2, 0, 0]);
  assert.equal(Object.keys(v.ballots).length, 2);
});

test("a voter can change their vote while open", () => {
  const v1 = castVote(mk(), "voter-one", 0, NOW);
  const v2 = castVote(v1.vote, "voter-one", 2, NOW + 1000);
  assert.equal(v2.ok, true);
  assert.equal(v2.changed, true);
  assert.equal(v2.previous, 0);
  assert.deepEqual(tally(v2.vote), [0, 0, 1]);
});

test("castVote does not mutate its input", () => {
  const v = mk();
  castVote(v, "voter-one", 1, NOW);
  assert.deepEqual(v.ballots, {});
});

test("closed vote rejects new votes and changes", () => {
  const v = mk({ hours: 1 });
  const voted = castVote(v, "voter-one", 0, NOW).vote;
  const later = NOW + 3600000;
  assert.equal(isOpen(voted, later - 1), true);
  assert.equal(isOpen(voted, later), false);
  assert.deepEqual(castVote(voted, "voter-two", 1, later), { ok: false, error: "closed" });
  assert.deepEqual(castVote(voted, "voter-one", 1, later), { ok: false, error: "closed" });
  assert.deepEqual(tally(voted), [1, 0, 0]);
});

test("castVote rejects a bad index or missing voter", () => {
  const v = mk();
  for (const i of [-1, 3, 1.5, "1", null]) assert.equal(castVote(v, "voter-one", i, NOW).error, "bad_choice", String(i));
  assert.equal(castVote(v, "", 0, NOW).error, "no_voter");
});

test("public view has counts and no voter data", () => {
  let v = mk();
  v = castVote(v, "secret-voter-id-123", 1, NOW).vote;
  const view = publicView(v, NOW);
  assert.deepEqual(view, {
    id: "0a1b2c3d",
    title: "Pick a name",
    choices: [{ label: "Alpha", count: 0 }, { label: "Beta", count: 1 }, { label: "Gamma", count: 0 }],
    closes_at: v.closes_at,
    open: true,
  });
  const text = JSON.stringify(view);
  assert.ok(!text.includes("secret-voter-id-123"));
  assert.ok(!/voter|hash|ballot/i.test(text));
  assert.equal(publicView(v, Date.parse(v.closes_at)).open, false);
});

test("hashing differs per salt, per vote, per user and hides the raw id", async () => {
  const a = await voterHash("user-1", "0a1b2c3d", "salt-one-example");
  assert.equal(a, await voterHash("user-1", "0a1b2c3d", "salt-one-example"));
  assert.notEqual(a, await voterHash("user-1", "0a1b2c3d", "salt-two-example"));
  assert.notEqual(a, await voterHash("user-1", "ffffffff", "salt-one-example"));
  assert.notEqual(a, await voterHash("user-2", "0a1b2c3d", "salt-one-example"));
  assert.match(a, /^[a-f0-9]{64}$/);
  // The old check (!a.includes("user-1")) could never fail: a hex digest has no "u" or "-". Use a snowflake-shaped id, which is made of hex digits,
  // and prove the digest is not just the id or an unsalted hash of it.
  const id = "123456789012345678", h = await voterHash(id, "0a1b2c3d", "salt-one-example");
  assert.ok(!h.includes(id) && !h.includes(id.slice(0, 8)) && !h.includes(id.slice(-8)), "digest must not contain the raw id");
  assert.notEqual(h, await sha256Hex(id));
  assert.notEqual(h, await sha256Hex(`vote:0a1b2c3d:${id}`));
  assert.notEqual(h, await sha256Hex(`salt-one-example:${id}`));
  assert.ok(h !== id && h.length === 64);
  assert.throws(() => voterHash("user-1", "0a1b2c3d", ""), { name: "SaltMissingError" });
});

test("custom_id parsing", () => {
  assert.deepEqual(parseVoteCustomId("vote:0a1b2c3d:2"), { id: "0a1b2c3d", action: "choice", index: 2 });
  assert.deepEqual(parseVoteCustomId("vote:0a1b2c3d:results"), { id: "0a1b2c3d", action: "results" });
  for (const bad of ["vote:0a1b2c3d:5", "vote:xyz:1", "signup:rsvp:in", "vote:0a1b2c3d", "vote:0a1b2c3d:1:2"]) {
    assert.equal(parseVoteCustomId(bad), null, bad);
  }
});

test("rendered message: one button per choice plus Results, ids match", () => {
  const v = mk();
  const m = renderMessage(v, NOW);
  assert.ok(m.content.includes("Pick a name"));
  const buttons = m.components.flatMap((r) => r.components);
  assert.deepEqual(buttons.map((b) => b.custom_id), ["vote:0a1b2c3d:0", "vote:0a1b2c3d:1", "vote:0a1b2c3d:2", "vote:0a1b2c3d:results"]);
  assert.ok(m.components.every((r) => r.components.length <= 5));
  assert.ok(buttons.every((b) => b.label.length <= 80 && b.custom_id.length <= 100));
  assert.equal(renderMessage(v, Date.parse(v.closes_at)).components[0].components[0].disabled, true);
});

test("six buttons (5 choices + Results) split over two rows", () => {
  const m = renderMessage(mk({ choices: "a|b|c|d|e" }), NOW);
  assert.deepEqual(m.components.map((r) => r.components.length), [5, 1]);
});

test("index keeps newest first, de-duplicates and caps", () => {
  assert.deepEqual(addToIndex({ ids: ["a", "b"] }, "c"), { ids: ["c", "a", "b"] });
  assert.deepEqual(addToIndex({ ids: ["a", "b"] }, "a"), { ids: ["a", "b"] });
  assert.deepEqual(addToIndex(null, "a"), { ids: ["a"] });
  assert.equal(addToIndex({ ids: Array.from({ length: 60 }, (_, i) => `x${i}`) }, "new").ids.length, 50);
});

test("loadPublicVotes returns only the public view", async () => {
  const v = castVote(mk(), "secret-voter-id-123", 0, NOW).vote;
  const store = { "votes:index": { ids: ["0a1b2c3d", "ffffffff", "not-an-id"] }, "vote:0a1b2c3d": v };
  const db = {
    prepare: (sql) => ({
      bind: (key) => ({ first: async () => (store[key] ? { json: JSON.stringify(store[key]) } : null), all: async () => ({ results: [] }) }), // no vote_ballots rows
      first: async () => (sql.includes("votes:index") ? { json: JSON.stringify(store["votes:index"]) } : null),
    }),
  };
  const out = await loadPublicVotes(db, NOW);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].choices.map((c) => c.count), [1, 0, 0]);
  assert.ok(!/voter|hash|ballot|secret/i.test(JSON.stringify(out)));
});
