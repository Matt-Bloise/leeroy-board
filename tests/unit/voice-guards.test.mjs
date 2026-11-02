// Golden tests for the deterministic voice guards in infrastructure/worker/answer-format.js. Pure, no network, no AI.
// Run: node --test tests/unit/voice-guards.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyVoiceGuards, formatAnswer, eggDue, eggSettings, answerUxEnabled, DEFAULT_EGG } from "../../infrastructure/worker/answer-format.js";
import { rosterAliases } from "../../infrastructure/worker/ai-models.js";

const ROSTER = { squidward: "Handsome Squidward", bible: "Bible Boi" };
const g = (text, extra = {}) => applyVoiceGuards(text, { full: true, ...extra });
const idem = (text, extra = {}) => {
  const once = g(text, extra);
  assert.equal(g(once, extra), once, `not idempotent for: ${text}`);
  return once;
};

test("the flag is off by default and reads ANSWER_UX", () => {
  assert.equal(answerUxEnabled({}), false);
  assert.equal(answerUxEnabled(undefined), false);
  assert.equal(answerUxEnabled({ ANSWER_UX: "on" }), true);
  assert.equal(answerUxEnabled({ ANSWER_UX: " ON " }), true);
  assert.equal(answerUxEnabled({ ANSWER_UX: "off" }), false);
});

test("Skippy is renamed to Leeroy in any case, including possessives", () => {
  assert.equal(idem("Skippy says the raid opens Dec 9."), "Leeroy says the raid opens Dec 9.");
  assert.equal(idem("SKIPPY's list is short. skippy agrees."), "Leeroy's list is short. Leeroy agrees.");
  assert.ok(!/skippy/i.test(idem("Ask skippy or Skippy.")));
});

test("a sentence that cannot survive the rename is dropped", () => {
  assert.equal(idem("Skippy is not Leeroy. The raid opens Dec 9."), "The raid opens Dec 9.");
  assert.equal(idem("The raid opens Dec 9. Leeroy, formerly Skippy, agrees."), "The raid opens Dec 9.");
  // Never empties the answer.
  assert.equal(idem("Skippy is not Leeroy."), "Leeroy is not Leeroy.");
});

test("the whole word Matt becomes Bloise and nothing else", () => {
  assert.equal(idem("Matt's build is ready. Matt said so."), "Bloise's build is ready. Bloise said so.");
  assert.equal(idem("Matthew and Mattel and matt and Matte stay."), "Matthew and Mattel and matt and Matte stay.");
  assert.equal(idem("See https://github.com/Matt-Bloise/x for Matt."), "See https://github.com/Matt-Bloise/x for Bloise.");
});

test("party display names are exact", () => {
  assert.equal(idem("Squidward has the tank gear.", { roster: ROSTER }), "Handsome Squidward has the tank gear.");
  assert.equal(idem("Handsome Squidward and squidward's pet.", { roster: ROSTER }), "Handsome Squidward and Handsome Squidward's pet.");
  assert.equal(idem("Bible Boi reads the Bible.", { roster: ROSTER }), "Bible Boi reads the Bible Boi.");
  assert.equal(idem("Squidwards plural stays.", { roster: ROSTER }), "Squidwards plural stays.");
  assert.equal(idem("Squidward stays without a roster."), "Squidward stays without a roster.");
});

test("rosterAliases only maps distinctive aliases inside a longer display name", () => {
  assert.deepEqual(rosterAliases(), { squidward: "Handsome Squidward" });
});

test("stock openers are stripped without breaking the sentence", () => {
  assert.equal(idem("Honestly, the raid opens Dec 9."), "The raid opens Dec 9.");
  assert.equal(idem("Honestly it opens Dec 9."), "It opens Dec 9.");
  assert.equal(idem("On paper, it is 40 players. The catch: you need attunement."), "It is 40 players. You need attunement.");
  assert.equal(idem("Short answer: yes. Great question! It opens Dec 9."), "Yes. It opens Dec 9.");
  assert.equal(idem("The honest bit - it is long. Fine."), "It is long. Fine.");
  assert.equal(idem("**Honestly, it opens Dec 9.**"), "**It opens Dec 9.**");
  assert.equal(idem("Line one.\nHonestly, line two."), "Line one.\nLine two.");
  // Not an opener: mid-sentence, or "the catch" used as a noun phrase, or the whole word is part of another word.
  assert.equal(idem("It is honest work, the catch is the price."), "It is honest work, the catch is the price.");
  assert.equal(idem("Honestly."), "Honestly.");
});

test("mention syntax is removed", () => {
  const out = idem("@everyone and @here look: <@123456> <@!123456> <@&123456> done.");
  assert.ok(!/@everyone|@here|<@/.test(out));
  assert.equal(out, "and look: done.");
});

test("at most one bold span survives, the first", () => {
  assert.equal(idem("**One.** two **Two** three **Three**"), "**One.** two Two three Three");
});

test("at most three emojis survive, the first three", () => {
  assert.equal(idem("Go \u{1F525}\u{1F525} now \u{1F680} fast \u{1F389} done \u{1F37A}"), "Go \u{1F525}\u{1F525} now \u{1F680} fast done");
  // Symbols that are not emoji are untouched.
  assert.equal(idem("© ™ • · … ok"), "© ™ • · … ok");
});

// ---- chicken egg ----

function idsWhereEggDue(n, egg) {
  const due = [];
  for (let i = 0; i < n; i++) if (eggDue(String(1790000000000 + i * 7919), egg)) due.push(String(1790000000000 + i * 7919));
  return due;
}

test("the egg is deterministic, about one in twelve, and never random", () => {
  const a = idsWhereEggDue(2400);
  const b = idsWhereEggDue(2400);
  assert.deepEqual(a, b);
  assert.ok(a.length > 120 && a.length < 290, `expected about 200 of 2400, got ${a.length}`);
  assert.equal(eggDue("", {}), false);
  assert.equal(eggDue(undefined, {}), false);
  const src = readFileSync(new URL("../../infrastructure/worker/answer-format.js", import.meta.url), "utf8");
  assert.ok(!/Math\.random/.test(src), "answer-format.js must not use Math.random");
});

test("the egg appends once, as the last line, to plain answers", () => {
  const id = idsWhereEggDue(400)[0];
  const out = g("The raid opens Dec 9.", { intentId: id });
  assert.equal(out, `The raid opens Dec 9.\n\n${DEFAULT_EGG.line}`);
  assert.equal(g(out, { intentId: id }), out, "never twice");
  const already = g(`The raid opens Dec 9.\n\n${DEFAULT_EGG.line}`, { intentId: id });
  assert.equal(already.split(DEFAULT_EGG.line).length - 1, 1);
});

test("the egg skips coach answers and ids that are not due", () => {
  const due = idsWhereEggDue(400)[0];
  assert.equal(g("Do the next thing.", { intentId: due, isCoach: true }), "Do the next thing.");
  const notDue = String(1790000000000 + 1);
  assert.equal(eggDue(notDue, {}), false);
  assert.equal(g("Plain.", { intentId: notDue }), "Plain.");
});

test("persona.egg overrides the line and the rate", () => {
  assert.deepEqual(eggSettings({ line: "Extra chicken.", oneIn: 1 }), { line: "Extra chicken.", oneIn: 1 });
  assert.deepEqual(eggSettings({ line: "", oneIn: 0 }), DEFAULT_EGG);
  assert.deepEqual(eggSettings(null), DEFAULT_EGG);
  assert.equal(g("Plain.", { intentId: "any", egg: { line: "Extra chicken.", oneIn: 1 } }), "Plain.\n\nExtra chicken.");
});

// ---- wiring through formatAnswer ----

const ctx = (extra = {}) => ({ pages: [], asker: { name: "Santa", isMember: true }, boardUrl: "https://leeroy.party", maxChars: 1200, ...extra });

test("formatAnswer applies the guards only when ux is on", () => {
  const raw = "**Honestly, Skippy says Matt opens it.** Squidward agrees.";
  assert.equal(formatAnswer(raw, ctx()), formatAnswer(raw, ctx({ roster: ROSTER })), "off: roster is ignored");
  assert.match(formatAnswer(raw, ctx()), /Skippy/);
  const on = formatAnswer(raw, ctx({ ux: true, roster: ROSTER, intentId: "x" }));
  assert.equal(on, "**Leeroy says Bloise opens it.**\n\nHandsome Squidward agrees.".replace("\n\n", " "));
  assert.equal(formatAnswer(on, ctx({ ux: true, roster: ROSTER, intentId: "x" })), on, "idempotent through formatAnswer");
});

test("guided answers never get the egg through formatAnswer", () => {
  const id = idsWhereEggDue(400)[0];
  const coach = formatAnswer("Start with the sheet.", ctx({ ux: true, intentId: id, journey: "guided", isCoach: true }));
  assert.ok(!coach.includes(DEFAULT_EGG.line));
  const plain = formatAnswer("Start with the sheet.", ctx({ ux: true, intentId: id }));
  assert.ok(plain.endsWith(DEFAULT_EGG.line));
});

// ---- hygiene: no Discord ids in the voice code or its fixtures ----

test("no 17 to 20 digit Discord id in the voice code, persona code or this file", () => {
  for (const f of ["../../infrastructure/worker/answer-format.js", "../../infrastructure/worker/persona.js", "./voice-guards.test.mjs"]) {
    const text = readFileSync(new URL(f, import.meta.url), "utf8");
    assert.ok(!/(?<![0-9])[0-9]{17,20}(?![0-9])/.test(text), `${f} contains a Discord-style id`);
  }
});
