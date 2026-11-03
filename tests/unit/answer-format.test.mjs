// Unit tests for infrastructure/worker/answer-format.js. Pure function, no network, no AI calls.
// Run: node --test tests/unit/answer-format.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { formatAnswer, answerFormatEnabled } from "../../infrastructure/worker/answer-format.js";

const pages = [
  { id: "raids/onyxias-lair", category: "raids", title: "Onyxia's Lair" },
  { id: "events/raids-dec-9", category: "events", title: "Raids on Dec 9" },
  { id: "classes/paladin-holy", category: "classes", title: "Holy Paladin" },
];
const visitor = { name: "Visitor", isMember: false };
const member = { name: "Santa", isMember: true };
const ctx = (asker = visitor, extra = {}) => ({ pages, asker, boardUrl: "https://leeroy.party", maxChars: 1200, ...extra });

const RAW =
  "**Onyxia's Lair opens on 2026-12-09.** Santa, you have a month to gear up.\n" +
  "Onyxia's Lair · 40 players, level 60, Dec 9\n" +
  "Raid size · 40 players, like the old days, Bible Boi\n" +
  "Launch date · Nov 4, 2026, so Onyxia's Lair comes five weeks after launch\n\n" +
  "Worth a look next: the Drakefire Amulet, required for raid attunement.\n\n" +
  "-# Sources: [events/raids-dec-9~onyxia.opens], [raids/onyxias-lair~onyxia.opens]\n" +
  "-# https://leeroy.party/#library.raids\n" +
  "At least I have chicken.";

const GOLDEN =
  "**Onyxia's Lair opens on 2026-12-09.**\n\n" +
  "• **Onyxia's Lair** · 40 players, level 60, Dec 9\n" +
  "• **Raid size** · 40 players, like the old days, Bible Boi\n" +
  "• **Launch date** · Nov 4, 2026, so Onyxia's Lair comes five weeks after launch\n\n" +
  "Worth a look next: the Drakefire Amulet, required for raid attunement.\n\n" +
  "-# Sources: [Raids on Dec 9](<https://leeroy.party/#library.events.raids-dec-9>) · [Onyxia's Lair](<https://leeroy.party/#library.raids.onyxias-lair>)\n" +
  "-# [Open on the board](<https://leeroy.party/#library.raids>)\n\n" +
  "At least I have chicken.";

test("golden: the production answer for a visitor", () => {
  assert.equal(formatAnswer(RAW, ctx(visitor)), GOLDEN);
});

test("golden: a member keeps being addressed by name", () => {
  const out = formatAnswer(RAW, ctx(member));
  assert.ok(out.startsWith("**Onyxia's Lair opens on 2026-12-09.** Santa, you have a month to gear up."));
  assert.ok(out.includes("-# Sources: [Raids on Dec 9]"));
});

test("idempotent", () => {
  for (const asker of [visitor, member]) {
    const once = formatAnswer(RAW, ctx(asker));
    assert.equal(formatAnswer(once, ctx(asker)), once);
  }
  const plain = "Just one sentence.";
  assert.equal(formatAnswer(formatAnswer(plain, ctx()), ctx()), formatAnswer(plain, ctx()));
});

test("source line shapes all become masked links", () => {
  const want = "-# Sources: [Holy Paladin](<https://leeroy.party/#library.classes.paladin-holy>)";
  for (const line of ["-# Sources: [classes/paladin-holy]", "-# Sources: classes/paladin-holy", "Sources: [classes/paladin-holy~role]", "-# Sources: classes/paladin-holy, classes/paladin-holy"]) {
    const out = formatAnswer(`**Answer.**\n\n${line}`, ctx());
    assert.equal(out, `**Answer.**\n\n${want}`, line);
  }
});

test("unknown ids are dropped, never shown raw; all-unknown removes the line", () => {
  const some = formatAnswer("**A.**\n-# Sources: [nope/missing], [classes/paladin-holy]", ctx());
  assert.ok(!some.includes("nope"));
  assert.ok(some.includes("Holy Paladin"));
  const none = formatAnswer("**A.**\n-# Sources: [nope/missing]", ctx());
  assert.equal(none, "**A.**");
});

test("bare and -# URL lines become one masked line", () => {
  assert.equal(formatAnswer("**A.**\nhttps://leeroy.party/#library.raids", ctx()), "**A.**\n\n-# [Open on the board](<https://leeroy.party/#library.raids>)");
  assert.equal(formatAnswer("**A.**\n-# https://leeroy.party/#library.raids\n-# https://other.example/x", ctx()), "**A.**\n\n-# [Open on the board](<https://leeroy.party/#library.raids>)");
});

test("inline bracket ids are stripped, markdown links survive", () => {
  const out = formatAnswer("**A.** It opens Dec 9 [raids/onyxias-lair~x] for 40 players [events/raids-dec-9]. See [the page](https://x.test/a).", ctx(member));
  assert.ok(!/\[[a-z]+\/[a-z-]/.test(out), out);
  assert.ok(out.includes("[the page](https://x.test/a)"));
  assert.ok(out.includes("It opens Dec 9 for 40 players."));
});

test("visitor: member-addressing sentences are removed, facts kept", () => {
  const out = formatAnswer("**Dec 9.** Bible Boi, bring friends. The raid has 40 slots. Street Rat, you too!", ctx(visitor));
  assert.equal(out, "**Dec 9.** The raid has 40 slots.");
  const named = formatAnswer("**Dec 9.** Santa, hi.", { ...ctx(), asker: { name: "Visitor", isMember: true } });
  assert.equal(named, "**Dec 9.**");
});

test("closing signature gets its own paragraph, with and without a footer", () => {
  assert.equal(formatAnswer("**A.**\nWorth a look next: B.\nAt least I have chicken.", ctx()), "**A.**\n\nWorth a look next: B.\n\nAt least I have chicken.");
  assert.equal(formatAnswer("**A.**\n\n-# Sources: [classes/paladin-holy]\nBye.", ctx()), "**A.**\n\n-# Sources: [Holy Paladin](<https://leeroy.party/#library.classes.paladin-holy>)\n\nBye.");
});

test("hyphen facts become bullets; blank lines collapse", () => {
  const out = formatAnswer("**A.**\n\n\n\nSize - 40 players\nLevel - 60\n\n\n\nDone.", ctx());
  assert.equal(out, "**A.**\n\n• **Size** · 40 players\n• **Level** · 60\n\nDone.");
});

test("over-length is cut at a line boundary and keeps -# lines", () => {
  const body = Array.from({ length: 40 }, (_, i) => `Line ${i} with some filler text to make it long.`).join("\n");
  const raw = `**Head.**\n\n${body}\n\n-# Sources: [classes/paladin-holy]\n-# https://leeroy.party/#library.raids\nSig.`;
  const out = formatAnswer(raw, ctx(visitor, { maxChars: 300 }));
  assert.ok(out.length <= 300, String(out.length));
  assert.ok(out.startsWith("**Head.**"));
  assert.ok(out.includes("-# Sources: [Holy Paladin]"));
  assert.ok(out.includes("-# [Open on the board]"));
  assert.ok(!out.endsWith("with some fil"), "no mid-line cut");
  assert.equal(formatAnswer(out, ctx(visitor, { maxChars: 300 })), out);
});

test("malformed input is returned unchanged and never throws", () => {
  assert.equal(formatAnswer(undefined, ctx()), undefined);
  assert.equal(formatAnswer(null, ctx()), null);
  assert.equal(formatAnswer(42, ctx()), 42);
  assert.equal(formatAnswer("", ctx()), "");
  assert.equal(formatAnswer("plain", null), "plain");
  assert.equal(formatAnswer("plain", { pages: "bad", asker: 7, maxChars: "x" }), "plain");
  assert.equal(formatAnswer("-# Sources: [[[", ctx()), "-# Sources: [[[");
});

test("kill switch reads ANSWER_FORMAT", () => {
  assert.equal(answerFormatEnabled({}), true);
  assert.equal(answerFormatEnabled({ ANSWER_FORMAT: "off" }), false);
  assert.equal(answerFormatEnabled({ ANSWER_FORMAT: "OFF " }), false);
  assert.equal(answerFormatEnabled(undefined), true);
});

// ---- Real production sample: member path, two sources lines, inline fact ids ----
const goldRaw = fs.readFileSync(new URL("./fixtures/answer-gold-early.txt", import.meta.url), "utf8");
const goldPages = [
  { id: "systems/earning-gold", category: "systems", title: "Earning gold" },
  { id: "systems/gold-and-riding", category: "systems", title: "Gold, riding and economy rules" },
];

for (const asker of [{ name: "Matt", isMember: true }, visitor]) {
  test(`gold-early fixture (${asker.name}): one sources line, one board link, clean text, idempotent`, () => {
    const c = { pages: goldPages, asker };
    const out = formatAnswer(goldRaw, c);
    assert.ok(!/\[[a-z0-9_-]+\/[a-z0-9_.~-]+\](?!\()/i.test(out), "no bracket ids");
    assert.ok(!/(^|\s)https?:\/\/[^\s<]/m.test(out.replace(/\(<https?:[^>]*>\)/g, "")), "no bare URL");
    assert.equal(out.split("\n").filter((l) => l.startsWith("-# Sources:")).length, 1);
    const src = out.split("\n").find((l) => l.startsWith("-# Sources:"));
    const links = src.match(/\]\(<[^>]+>\)/g);
    assert.equal(links.length, 2);
    assert.equal(new Set(links).size, 2);
    assert.equal(out.split("\n").filter((l) => l.startsWith("-# [Open on the board](")).length, 1);
    assert.ok(out.length <= 1200);
    assert.ok(!/ {2}/.test(out) && !/ [.,;:!?]/.test(out), "no double spaces or space before punctuation");
    assert.equal(formatAnswer(out, c), out);
  });
}

test("inline fact ids are removed with one adjacent space", () => {
  const out = formatAnswer("**A.**\n\n- Quest rewards · [systems/earning-gold~gold.earn.quests] pay a bit, sell to vendors [systems/earning-gold~x]. Done [systems/earning-gold] .", { ...ctx(), pages: goldPages });
  assert.equal(out, "**A.**\n\n• **Quest rewards** · pay a bit, sell to vendors. Done.");
});

test("every golden input is idempotent under both asker kinds", () => {
  const inputs = [RAW, goldRaw, "**A.**\nWorth a look next: B.\nAt least I have chicken.", "**A.**\n\n-# Sources: [classes/paladin-holy]\nBye.", "**A.**\nhttps://leeroy.party/#library.raids", "**A.**\n\n\n\nSize - 40 players\nLevel - 60\n\n\n\nDone.", "Sources: a/b\n-# Sources: classes/paladin-holy\nSources: [classes/paladin-holy]"];
  for (const raw of inputs) for (const asker of [visitor, member]) {
    const c = { pages: [...pages, ...goldPages], asker };
    const once = formatAnswer(raw, c);
    assert.equal(formatAnswer(once, c), once, JSON.stringify(raw).slice(0, 60));
  }
});