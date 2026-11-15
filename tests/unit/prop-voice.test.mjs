// Property and fuzz tests: the answer linter (answer-lint.js) and house-voice repair (ai-models.js repairHouseVoice, answer-format.js
// applyVoiceGuards / formatAnswer). Pure, offline, zero dependencies. Seed printed on failure; replay with PROP_SEED=<n>.
// Run: node --test tests/unit/prop-voice.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { lintAnswer } from "../../infrastructure/worker/answer-lint.js";
import { repairHouseVoice } from "../../infrastructure/worker/ai-models.js";
import { neutraliseMentions, defuseLinks, fitToCap } from "../../infrastructure/worker/research/label.js";
import { applyVoiceGuards, formatAnswer } from "../../infrastructure/worker/answer-format.js";
import { property, word, nastyString } from "../helpers/prop.mjs";

const PIECES = ["**Bold one.**", "**x**", "@everyone", "@here", "<@123456789012345678>", "<@!123456789012345678>", "<@&123456789012345678>", "@every@everyoneone", "<@1<@2>2>", "@@everyoneeveryone", "<@<@12>34>",
  "https://example.com/a", "http://example.org", "[t](<https://example.com/x>)", "-# Sources: [Page](<https://leeroy.party/#library.a.b>)", "-# [Open on the board](<https://leeroy.party/#library>)",
  "[raids/a-keep]", "[a/b]", "Don't pull early.", "Make sure you queue.", "Do not wait. Don't stop. Remember to log.", "Skippy", "Matt", "Santa", "Great question", "Honestly,", "Short answer:", "😀", "\n", "\n\n\n", "  ", "\t", "\r\n", "12345678901234567", "123456789012345678901", "•", "-#", "---more---", "{board:library.x}", "Santa, hello", "A", "Bloise"];
const genText = (r) => { let s = ""; for (let i = r.range(0, 16); i > 0; i--) s += r.bool(0.7) ? r.pick(PIECES) + (r.bool(0.5) ? " " : "") : r.bool(0.5) ? word(r) + " " : nastyString(r, 2); return s; };
const genCtx = (r) => r.pick([undefined, null, {}, { maxChars: r.range(0, 3000) }, { asker: { isMember: false }, forbidden: ["Alder", 5, null] }, { maxEmoji: r.range(0, 4), minChars: r.range(0, 50) }, "x", 5, { maxChars: "abc" }]);
const MENTION = /<@[!&]?\d+>|@(?:everyone|here)\b/i;
const BARE_URL = /(?<![<(])https?:\/\/\S/i;

property("lintAnswer never throws, is deterministic and self-consistent on any input", (r) => ({ text: r.bool(0.1) ? r.pick([undefined, null, 5, {}, []]) : genText(r), ctx: genCtx(r) }), ({ text, ctx }) => {
  const a = lintAnswer(text, ctx), b = lintAnswer(text, ctx);
  assert.deepEqual(a, b);
  assert.equal(a.chars, typeof text === "string" ? text.length : 0);
  assert.equal(a.pass, a.failures.length === 0);
  assert.equal(new Set(a.failures).size, a.failures.length);
  for (const k of ["bracketIds", "bareUrls", "boldSpans", "mentions", "emoji", "nonMemberAddressed"]) assert.ok(Number.isInteger(a[k]) && a[k] >= 0, k);
  if (a.chars === 0) assert.ok(a.failures.includes("empty"));
  if (a.mentions) assert.ok(a.failures.includes("mentions"));
  if (a.bareUrls) assert.ok(a.failures.includes("bare_urls"));
}, { runs: 500 });

property("lintAnswer length rule matches the cap exactly", (r) => ({ text: word(r, 1, 60), cap: r.range(1, 80) }), ({ text, cap }) => {
  assert.equal(lintAnswer(text, { maxChars: cap }).lengthOk, text.length <= cap);
});

property("repairHouseVoice is idempotent", genText, (t) => {
  const once = repairHouseVoice(t);
  assert.equal(repairHouseVoice(once), once);
  const coach = repairHouseVoice(t, { isCoach: true });
  assert.equal(repairHouseVoice(coach, { isCoach: true }), coach);
}, { runs: 600 });

property("repairHouseVoice never lengthens the text (no name map) and leaves no snowflake, Skippy or double bold", genText, (t) => {
  const out = repairHouseVoice(t);
  assert.ok(out.length <= String(t).trim().length, `grew ${t.trim().length} -> ${out.length}`);
  assert.ok(!/\bSkippy\b/i.test(out));
  assert.ok(!/(?<!https:\/\/discord\.com\/[^\s"]*)\b\d{17,20}\b/.test(out));
  assert.ok((out.match(/\*\*([^*]+)\*\*/g) || []).length <= 1);
  assert.ok(!/[ \t]{2,}|\n{3,}/.test(out));
}, { runs: 600 });

property("repairHouseVoice with a name map only lengthens by the names it swaps in", (r) => ({ t: genText(r) + " alwen " + genText(r), m: { alwen: "Aldermere" } }), ({ t, m }) => {
  const out = repairHouseVoice(t, { nameMap: m });
  const hits = (t.match(/\balwen\b/g) || []).length;
  assert.ok(out.length <= t.trim().length + hits * (m.alwen.length - 5), "grew past the swaps");
  assert.ok(!/\balwen\b/.test(out));
  assert.equal(repairHouseVoice(out, { nameMap: m }), out);
});

property("applyVoiceGuards is idempotent and emits no mention", genText, (t) => {
  for (const full of [false, true]) {
    const once = applyVoiceGuards(t, { full, isCoach: true });
    const twice = applyVoiceGuards(once, { full, isCoach: true });
    assert.equal(twice, once, "not idempotent");
    assert.ok(!MENTION.test(once), `mention survived: ${JSON.stringify(once)}`);
  }
}, { runs: 800 });

property("formatAnswer never exceeds maxChars and emits no mention or bare URL that the input did not already hold safely", (r) => ({ t: genText(r), cap: r.range(200, 1500) }), ({ t, cap }) => {
  const out = formatAnswer(t, { maxChars: cap, boardUrl: "https://leeroy.party", asker: { name: "Aldermere", isMember: true }, pages: [] });
  assert.equal(typeof out, "string");
  assert.ok(out.length <= Math.max(cap, t.length), `output ${out.length} past cap ${cap}`);
  const ux = formatAnswer(t, { maxChars: cap, ux: true, boardUrl: "https://leeroy.party", asker: { name: "Aldermere", isMember: true }, pages: [] });
  assert.ok(!MENTION.test(ux), `mention survived in ux output: ${JSON.stringify(ux)}`);
}, { runs: 500 });

const PING = /<@[!&]?\d+>|@(?:everyone|here)\b/i;
const safe = (t, cap) => fitToCap(neutraliseMentions(defuseLinks(t, { allow: ["leeroy.party"] })), cap);
property("research output chain (defuseLinks, neutraliseMentions, fitToCap): no ping, no bare URL, within the cap, idempotent", (r) => ({ t: genText(r) + genText(r), cap: r.range(100, 1999) }), ({ t, cap }) => {
  const out = safe(t, cap);
  assert.ok(out.length <= cap, `output ${out.length} past cap ${cap}`);
  assert.ok(!PING.test(out), `ping in ${JSON.stringify(out)}`);
  assert.equal(lintAnswer(out).bareUrls, 0, `bare url in ${JSON.stringify(out)}`);
  assert.equal(safe(out, cap), out, "not idempotent");
}, { runs: 600 });

property("repair never creates a mention that the input did not hold", genText, (t) => {
  const n = (x) => (x.match(/<@[!&]?\d+>|@(?:everyone|here)\b/gi) || []).length;
  assert.ok(n(repairHouseVoice(t)) <= n(t), "repair created a mention");
}, { runs: 500 });

test("lintAnswer and repair never throw on pathological strings", () => {
  for (const s of ["", " ", "\0".repeat(5000), "**".repeat(20000), "@".repeat(30000), "<@".repeat(10000), "a".repeat(200000), "https://".repeat(5000), "𐀀\ud800", "-# Sources: ".repeat(3000)]) {
    assert.doesNotThrow(() => lintAnswer(s));
    assert.doesNotThrow(() => repairHouseVoice(s));
    assert.doesNotThrow(() => applyVoiceGuards(s, { full: true }));
  }
});
