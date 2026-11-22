// Minimal repros of the bugs the property suites (prop-*.test.mjs) found. Each one failed before its fix. Fictional names only.
// Run: node --test tests/unit/prop-regressions.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { repairHouseVoice } from "../../infrastructure/worker/ai-models.js";
import { applyVoiceGuards, formatAnswer, formatAnswerParts, MENTIONS_ONLY_LINE } from "../../infrastructure/worker/answer-format.js";
import { fitToCap } from "../../infrastructure/worker/research/label.js";
import { scanUserText } from "../../infrastructure/worker/privacy/outbound-guard.js";
import { lintAnswer } from "../../infrastructure/worker/answer-lint.js";

const PING = /<@[!&]?\d+>|@(?:everyone|here)\b/i;

test("repairHouseVoice is idempotent when imperative sentences follow each other", () => {
  const once = repairHouseVoice("Do not wait. Don't stop. Fine thing to say here.");
  assert.equal(once, "Fine thing to say here.");
  assert.equal(repairHouseVoice(once), once);
  const chain = repairHouseVoice("ao Do not wait. Don't stop. Remember to log.Make sure you queue. Fine thing to say here.");
  assert.equal(repairHouseVoice(chain), chain);
});

test("repairHouseVoice is idempotent when dropping a second bold span exposes an order", () => {
  const t = "**One bold.** Fine words here. **Two bold.** Do not wait. Fine words again.";
  const once = repairHouseVoice(t);
  assert.equal(repairHouseVoice(once), once);
});

test("applyVoiceGuards removes a mention that a removal would rebuild (<@1<@2>2>)", () => {
  for (const full of [false, true]) {
    const out = applyVoiceGuards("hello <@1<@2>2> there <@<@12>34> x", { full });
    assert.ok(!PING.test(out), out);
    assert.equal(applyVoiceGuards(out, { full }), out);
  }
});

test("applyVoiceGuards never hands back an answer that was only mentions", () => {
  for (const t of ["@everyone", "<@123456789012345678>", "<@1<@2>2> @here"]) {
    const out = applyVoiceGuards(t, { full: true });
    assert.ok(!PING.test(out), `${t} came back as ${JSON.stringify(out)}`);
    assert.ok(!PING.test(formatAnswer(t, { ux: true })), "formatAnswer re-emitted the original");
  }
  assert.equal(applyVoiceGuards("   ", { full: true }), "   ", "blank input stays as it was");
});

test("applyVoiceGuards is idempotent when a mention at the start hid an opener", () => {
  const t = "<@123456789012345678> Honestly,http://example.org rest of it";
  const once = applyVoiceGuards(t, { full: true, isCoach: true });
  assert.equal(applyVoiceGuards(once, { full: true, isCoach: true }), once);
});

test("applyVoiceGuards is idempotent when the emoji limit exposes an opener", () => {
  const t = "😀😀😀\n😀Short answer: rpc x";
  const once = applyVoiceGuards(t, { full: true, isCoach: true });
  assert.equal(applyVoiceGuards(once, { full: true, isCoach: true }), once);
});

test("fitToCap never cuts a link into a bare address or exposes @everyone at the cut", () => {
  const link = "-# [Open on the board](<https://leeroy.party/#library>)";
  const cut = fitToCap(`${"x ".repeat(5)}${link} ${"y".repeat(400)}`, 40);
  assert.ok(cut.length <= 40);
  assert.equal(lintAnswer(cut).bareUrls, 0, cut);
  const long = `-# Sources: [A page](<https://leeroy.party/#library.a.b${"c".repeat(400)}>)`;
  assert.equal(lintAnswer(fitToCap(`Body.\n${long}`, 120)).bareUrls, 0);
  const ping = fitToCap("word ".repeat(10) + "@everyone123456789", 55);
  assert.ok(!PING.test(ping), ping);
});

test("guard catches a name that is both reversed and written with digits", () => {
  const roster = { members: [{ display: "Brindlewick", aliases: [], firstNames: [], characterNames: [] }], genericAliases: [] };
  for (const t of ["kc1w3ldn1rB", "k c 1 w 3 l d n 1 r B", "KC1W3LDN1RB"]) assert.ok(scanUserText([t], roster).length > 0, t);
});

test("an answer that is only mentions becomes a plain substitute line, not an empty string", () => {
  for (const t of ["@everyone", "<@123456789012345678>", "<@1<@2>2> @here"]) {
    const out = applyVoiceGuards(t, { full: true });
    assert.equal(out, MENTIONS_ONLY_LINE);
    assert.ok(!PING.test(out));
    assert.equal(applyVoiceGuards(out, { full: true }), out, "the substitute is a fixed point");
    const parts = formatAnswerParts(t, { ux: true });
    assert.equal(parts.main, MENTIONS_ONLY_LINE, "the channel body is never empty");
    assert.ok(parts.main.length > 0);
  }
  assert.equal(applyVoiceGuards("<@123456789012345678>", { full: false }), "", "a detail section stays empty and is omitted");
});

test("fitToCap output is never longer than the cap (cutClean used to return cap + 1, or +2 with a ZWSP)", () => {
  const cases = [
    ["a".repeat(400), 40],
    ["a".repeat(400), 300],
    ["word ".repeat(10) + "@everyone123456789", 55],
    ["x ".repeat(5) + "[Page](<https://leeroy.party/#links>) " + "y".repeat(400), 40],
    ["Body.\n-# Sources: " + "s".repeat(400), 120],
    ["Body.\n-# Sources: " + "a · ".repeat(200), 500],
  ];
  for (const [t, cap] of cases) assert.ok(fitToCap(t, cap).length <= cap, `cap ${cap} got ${fitToCap(t, cap).length}`);
});