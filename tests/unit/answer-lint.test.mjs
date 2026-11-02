// Unit tests for the deterministic answer linter. Pure: no network, no AI.
// Run: node --test tests/unit/answer-lint.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { lintAnswer } from "../../infrastructure/worker/answer-lint.js";

const GOOD = [
  "**The first dungeon is a short one with a friendly pace.**",
  "",
  "• **Length** · about 45 minutes",
  "",
  "-# Sources: [Dungeon basics](<https://leeroy.party/#library.dungeons.basics>) · [Pacing](<https://leeroy.party/#library.dungeons.pacing>)",
  "-# [Open on the board](<https://leeroy.party/#library>)",
].join("\n");

const fails = (text, ctx) => lintAnswer(text, ctx).failures;

test("a well formed answer passes with nothing to report", () => {
  const l = lintAnswer(GOOD);
  assert.deepEqual(l.failures, []);
  assert.equal(l.pass, true);
  assert.equal(l.sources.present, true);
  assert.equal(l.sources.masked, true);
  assert.equal(l.sources.items, 2);
  assert.equal(l.boardLink, true);
  assert.equal(l.firstSentenceBold, true);
  assert.equal(l.bareUrls, 0);
  assert.equal(l.boldSpans, 2);
});

test("lint is deterministic", () => {
  assert.deepEqual(lintAnswer(GOOD), lintAnswer(GOOD));
});

test("bracket ids and bare urls are counted; masked links are not bare", () => {
  const t = "**Short answer here.** See [dungeons/basics] and https://example.com/x and [ok](<https://example.com/y>).";
  const l = lintAnswer(t);
  assert.equal(l.bracketIds, 1);
  assert.equal(l.bareUrls, 1);
  assert.ok(l.failures.includes("bracket_ids") && l.failures.includes("bare_urls"));
});

test("a sources line with plain ids is unmasked", () => {
  const l = lintAnswer("**Done.**\n\n-# Sources: dungeons/basics, dungeons/pacing");
  assert.equal(l.sources.present, true);
  assert.equal(l.sources.masked, false);
  assert.ok(l.failures.includes("sources_unmasked"));
});

test("a missing sources line is a warning, not a failure", () => {
  const l = lintAnswer("**Nothing is published on that yet.**");
  assert.ok(l.warnings.includes("no_sources_line"));
  assert.equal(l.pass, true);
});

test("first sentence must be a bold whole sentence", () => {
  assert.ok(fails("Plain start.\n\n**Bold later.**").includes("first_sentence_not_bold"));
  assert.ok(fails("**Not a sentence**\n\nbody").includes("first_sentence_not_bold"));
  assert.ok(!fails("**It is a sentence.** And more text.").includes("first_sentence_not_bold"));
});

test("length is checked against the persona limits", () => {
  const long = `**${"x".repeat(50)}.**`;
  assert.ok(fails(long, { maxChars: 40 }).includes("length"));
  assert.ok(!fails(long, { maxChars: 400 }).includes("length"));
  assert.ok(fails("**Hi there.**", { minChars: 100 }).includes("length"));
  assert.ok(fails("").includes("empty"));
});

test("forbidden words are whole words; Matt does not match matter or Matthew", () => {
  assert.deepEqual(lintAnswer("**Ask Matt about it.**").forbidden, ["Matt"]);
  assert.deepEqual(lintAnswer("**Skippy says hi.**").forbidden, ["Skippy"]);
  assert.deepEqual(lintAnswer("**It does not matter to Matthew.**").forbidden, []);
  assert.deepEqual(lintAnswer("**Mind the Cobra.**", { forbidden: ["cobra"] }).forbidden, ["cobra"]);
});

test("mentions: everyone, here, user and role ids, @handles; not email-like text", () => {
  assert.equal(lintAnswer("**Hi @everyone and @here.**").mentions, 2);
  assert.equal(lintAnswer("**Ping <@123456789012345678> and <@&987654321098765432>.**").mentions, 2);
  assert.equal(lintAnswer("**Ask @someone.**").mentions, 1);
  assert.equal(lintAnswer("**Write to a@b.example.**").mentions, 0);
});

test("stock openers are flagged on the first line only", () => {
  assert.equal(lintAnswer("**Great question, the dungeon is short.**").stockOpener, "great question");
  assert.ok(lintAnswer("Sure, here you go.").failures.includes("stock_opener"));
  assert.equal(lintAnswer("**The dungeon is short. Great fun.**").stockOpener, null);
});

test("party members addressed to a non-member are counted; fine for a member", () => {
  const t = "**Santa, the dungeon is short.**\n\nSure thing. Bloise, bring water.";
  assert.equal(lintAnswer(t, { asker: { isMember: false } }).nonMemberAddressed, 2);
  assert.equal(lintAnswer(t, { asker: { isMember: true } }).nonMemberAddressed, 0);
  assert.equal(lintAnswer("**The roster has Santa and Bloise.**", { asker: { isMember: false } }).nonMemberAddressed, 0);
});

test("emoji are counted including flags; none allowed by default", () => {
  assert.equal(lintAnswer("**Fun times.** \u{1F389}\u{1F525}").emoji, 2);
  assert.ok(fails("**Fun times.** \u{1F389}").includes("emoji"));
  assert.ok(!fails("**Fun times.** \u{1F389}", { maxEmoji: 1 }).includes("emoji"));
  assert.equal(lintAnswer("**Plain text only.** 1 2 3 …").emoji, 0);
});

test("non string input never throws", () => {
  assert.equal(lintAnswer(undefined).pass, false);
  assert.equal(lintAnswer(null, null).chars, 0);
});

test("gold fixture: master's formatter output lints with zero failures", async () => {
  const { readFileSync } = await import("node:fs");
  const { formatAnswer } = await import("../../infrastructure/worker/answer-format.js");
  const raw = readFileSync(new URL("./fixtures/answer-gold-early.txt", import.meta.url), "utf8");
  const pages = [
    { id: "systems/earning-gold", title: "Earning gold" },
    { id: "systems/gold-and-riding", title: "Gold, riding and economy rules" },
  ];
  const out = formatAnswer(raw, { pages, asker: { name: "Santa", isMember: true }, boardUrl: "https://leeroy.party", maxChars: 1200 });
  const l = lintAnswer(out, { maxChars: 1200, asker: { isMember: true } });
  assert.deepEqual(l.failures, [], out);
});
