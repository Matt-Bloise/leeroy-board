// Pure unit tests for infrastructure/worker/persona.js. No network, no D1, no AI.
// Run: node --test tests/unit/persona.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { buildSystemPrompt, pickBits, pickExamples, pickLine, helpIntro, loadPersona, invalidatePersonaCache } from "../../infrastructure/worker/persona.js";

const persona = {
  version: 1,
  system: "SYSTEM TEXT",
  journeys: { guided: "GUIDED TEXT", curious: "CURIOUS TEXT", everything: "EVERYTHING TEXT" },
  format: { chatMaxChars: 900 },
  ackLines: ["ack one", "ack two", "ack three"],
  errorLines: ["err one", "err two"],
  emptyLines: ["empty one"],
  helpIntro: "HELP INTRO",
  bits: [
    { id: "tank", text: "TANK BIT", when: "Tank seats, warlock pets, aggro", safe: true },
    { id: "polls", text: "POLL BIT", when: "Polls, votes, turnout", safe: true },
    { id: "unsafe", text: "UNSAFE BIT", when: "Tank seats and aggro", safe: false },
    { id: "gold", text: "GOLD BIT", when: "Gold and riding costs", safe: true },
  ],
  examples: [
    { q: "how do mounts work", a: "MOUNT ANSWER", journey: "curious", tags: ["mounts"] },
    { q: "which dungeon first", a: "DUNGEON ANSWER", journey: "guided", tags: ["dungeons"] },
    { q: "what about riding gold", a: "GOLD ANSWER", journey: "curious", tags: ["gold"] },
    { q: "random topic", a: "RANDOM ANSWER", journey: "everything", tags: [] },
  ],
  avoid: ["Never ping people."],
};
const ctx = { journey: "curious", question: "who holds aggro on the tank seat?", partySummary: "Party: five friends", libraryStamp: "stamp9" };

test("buildSystemPrompt is deterministic", () => {
  assert.equal(buildSystemPrompt(persona, ctx), buildSystemPrompt(persona, ctx));
});

test("buildSystemPrompt uses the asker's journey and defaults to curious", () => {
  assert.match(buildSystemPrompt(persona, { ...ctx, journey: "guided" }), /GUIDED TEXT/);
  assert.doesNotMatch(buildSystemPrompt(persona, { ...ctx, journey: "guided" }), /CURIOUS TEXT/);
  assert.match(buildSystemPrompt(persona, { ...ctx, journey: "nonsense" }), /CURIOUS TEXT/);
});

test("platform block keeps the machine rules", () => {
  const p = buildSystemPrompt(persona, ctx);
  assert.match(p, /\[Library-Epoch: stamp9\]/);
  assert.match(p, /strictly from the verified library facts and party state/);
  assert.match(p, /\[classes\/paladin-holy\]/);
  assert.match(p, /under 900 characters/);
  assert.match(p, /dated party facts that are newer/);
  assert.ok(p.indexOf("SYSTEM TEXT") < p.indexOf("PLATFORM RULES"));
});

test("bits: keyword overlap only, skips unsafe, at most 2, stable order", () => {
  assert.deepEqual(pickBits(persona, "tank aggro polls votes"), ["TANK BIT", "POLL BIT"]);
  assert.deepEqual(pickBits(persona, "the weather"), []);
  assert.ok(!pickBits(persona, "tank seat aggro").includes("UNSAFE BIT"));
  assert.ok(pickBits(persona, "tank polls gold riding costs", 5).length <= 4);
  assert.equal(pickBits(persona, "tank polls gold").length, 2);
});

test("bits: light stemming matches tank to tanking", () => {
  assert.deepEqual(pickBits(persona, "who is tanking for us right now?"), ["TANK BIT"]);
});

test("examples: same journey first, then overlap, at most 3", () => {
  const ex = pickExamples(persona, "riding gold", "curious");
  assert.equal(ex.length, 3);
  assert.equal(ex[0].a, "GOLD ANSWER");
  assert.equal(ex[1].a, "MOUNT ANSWER");
  const g = pickExamples(persona, "riding gold", "guided");
  assert.equal(g[0].a, "DUNGEON ANSWER");
});

test("buildSystemPrompt includes example pairs and coach prompt", () => {
  const p = buildSystemPrompt(persona, { ...ctx, isCoach: true, coachPrompt: "COACH TEXT" });
  assert.match(p, /Example question: .*\nExample answer: /);
  assert.match(p, /COACH TEXT/);
  assert.doesNotMatch(buildSystemPrompt(persona, ctx), /COACH TEXT/);
});

test("pickLine is deterministic by seed and stays in the list", () => {
  assert.equal(pickLine(persona, "ackLines", "seed-1"), pickLine(persona, "ackLines", "seed-1"));
  const seen = new Set();
  for (let i = 0; i < 50; i++) seen.add(pickLine(persona, "ackLines", `s${i}`));
  assert.ok([...seen].every((l) => persona.ackLines.includes(l)));
  assert.ok(seen.size > 1);
});

test("fallbacks when the persona is null", () => {
  for (const k of ["ackLines", "errorLines", "emptyLines"]) {
    assert.equal(typeof pickLine(null, k, "x"), "string");
    assert.ok(pickLine(null, k, "x").length > 0);
  }
  assert.equal(pickLine(null, "emptyLines", "x", "custom"), "custom");
  assert.equal(helpIntro(null, "fallback"), "fallback");
  assert.equal(helpIntro(persona, "fallback"), "HELP INTRO");
});

test("loadPersona never throws and caches", async () => {
  invalidatePersonaCache();
  let calls = 0;
  const env = { DB: { prepare: () => ({ first: async () => { calls++; return { json: JSON.stringify(persona) }; } }) } };
  assert.equal((await loadPersona(env)).system, "SYSTEM TEXT");
  await loadPersona(env);
  assert.equal(calls, 1);
  invalidatePersonaCache();
  assert.equal(await loadPersona({ DB: { prepare: () => ({ first: async () => ({ json: "{bad" }) }) } }), null);
  invalidatePersonaCache();
  assert.equal(await loadPersona({ DB: { prepare: () => { throw new Error("no db"); } } }), null);
  invalidatePersonaCache();
});
