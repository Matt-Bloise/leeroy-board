// Discord text builders under size and injection pressure: the sign-up card, the board card and the "From the board" line.
// Fictional names only. No network, no D1, no AI. cards.test.mjs covers the goldens and 80 short names; this adds the cases a long
// roster or a hostile name produces. Known gaps (a bare discord.gg/ invite survives in a name; a footer time with no zone is read as local time but
// labelled UTC; a free-text `when` is printed as stored) are in docs/review-classes.md as follow-ups.
import test from "node:test";
import assert from "node:assert/strict";
import { renderSignupCard, renderBoardCard, cleanName, EMBED_TEXT_MAX } from "../../infrastructure/worker/cards.js";
import { composeLine, LINE_MAX } from "../../infrastructure/worker/board-lines.js";

const RSVPS = ["in", "maybe", "late", "out"];
const textLength = (embed) =>
  (embed.title || "").length + (embed.description || "").length + ((embed.footer && embed.footer.text) || "").length +
  (embed.fields || []).reduce((n, f) => n + f.name.length + f.value.length, 0);
const longRoster = (n) => Array.from({ length: n }, (_, i) => ({ name: `${"Long fictional name ".repeat(3)}${i}`, rsvp: RSVPS[i % 4], meet: `${"Meeting place ".repeat(6)}${i % 9}`, when: `late ${i}`, pack: i % 2 ? "yes" : "no" }));
const HOSTILE = [
  "@everyone", "@here", "<@123456789012345678>", "<@&123456789012345678>", "<#123456789012345678>", "[click](https://evil.test)", "[a](<https://evil.test>)",
  "\u202Eevil\u202C", "a\u200Bb", "line one\nline two", "# heading", "> quote", "`code`", "**bold**", "_italic_", "||spoiler||", "~~strike~~", "https://evil.test/x",
  "discord.gg/abcdef", "x *y* _z_ ~w~ |v| `u`",
];

test("signup card: 300 long entries stay inside every Discord embed limit", () => {
  for (const n of [1, 25, 100, 300]) {
    const card = renderSignupCard({ updated: "2026-11-02T20:15:00.000Z", entries: longRoster(n) });
    const e = card.embeds[0];
    assert.ok(textLength(e) <= EMBED_TEXT_MAX, `${n}: ${textLength(e)} characters in all`);
    assert.ok(e.fields.length <= 25, `${n}: ${e.fields.length} fields`);
    for (const f of e.fields) assert.ok(f.name.length > 0 && f.name.length <= 256 && f.value.length > 0 && f.value.length <= 1024, `${n}: ${f.name}`);
    assert.ok(card.components.length <= 5);
    for (const row of card.components) assert.ok(row.components.length <= 5);
    for (const c of card.components.flatMap((r) => r.components)) assert.ok(c.custom_id.length <= 100 && c.label.length <= 80);
  }
});

test("board card: 300 members with long lines stay inside every Discord embed limit", () => {
  const entries = longRoster(300);
  entries.forEach((e, i) => { e.slug = `m${i}`; }); // pair each entry with its member, so the member path renders the long meet and when lines
  const members = entries.map((e, i) => ({ slug: `m${i}`, name: e.name, classKey: "", classLabel: "Frost Mage", race: "Undead", role: "damage" }));
  const card = renderBoardCard({ updated: "2026-11-02T20:15:00.000Z", entries, members });
  const e = card.embeds[0];
  assert.ok(textLength(e) <= EMBED_TEXT_MAX, `${textLength(e)} characters in all`);
  assert.ok(e.fields.length <= 25);
  for (const f of e.fields) assert.ok(f.value.length > 0 && f.value.length <= 1024);
  assert.ok((e.description || "").length <= 4096);
  assert.ok(e.fields.some((f) => f.value.includes("Meeting place")) && e.fields.some((f) => f.value.includes("late ")), "the member path rendered the meet and when lines");
  const plain = renderBoardCard({ entries });
  assert.ok(textLength(plain.embeds[0]) <= EMBED_TEXT_MAX);
});

// A bare discord.gg/ invite in a name is NOT asserted: it survives today (docs/review-classes.md F-10). The entries that carry one are still checked for everything else.
test("hostile names print no mention, link, channel, markdown or direction syntax on either card or in the board line", () => {
  const entries = HOSTILE.map((name, i) => ({ name, rsvp: RSVPS[i % 4], meet: name, when: "6pm", pack: "yes" }));
  const texts = [];
  for (const card of [renderSignupCard({ entries }), renderBoardCard({ entries })]) {
    assert.deepEqual(card.allowed_mentions, { parse: [] });
    // The board card wraps each name in its own **bold**; take that one pair off so a star that came from the name is still seen.
    for (const f of card.embeds[0].fields) texts.push(f.value.replace(/^\*\*(.*?)\*\*/gm, "$1"));
  }
  texts.push(composeLine(Object.fromEntries(HOSTILE.map((name, i) => [`k${i}`, { name, to: RSVPS[i % 4] }]))));
  for (const name of HOSTILE) texts.push(cleanName(name));
  for (const t of texts) {
    assert.ok(!/[<>@\[\]*_~|`\u200B-\u200F\u202A-\u202E]/.test(t), JSON.stringify(t));
    assert.ok(!/https?:\/\//i.test(t), JSON.stringify(t));
  }
});

test("board line: any number of long names still fits in 120 characters and never ends mid-sentence without a full stop", () => {
  for (const n of [1, 2, 5, 60]) {
    const changes = Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, { name: `Person with a long fictional name ${i}`, to: RSVPS[i % 3] }]));
    const line = composeLine(changes);
    assert.ok(line.length > 0 && line.length <= LINE_MAX, `${n}: ${line.length}`);
    assert.match(line, /^From the board: .+\.$/);
  }
  assert.equal(composeLine({}), "");
  assert.equal(composeLine(null), "");
});

test("card footer: a valid stamp prints as a UTC minute; a malformed, empty or missing one prints no footer", () => {
  const foot = (updated) => renderSignupCard({ entries: [], updated }).embeds[0].footer;
  assert.deepEqual(foot("2026-11-02T20:15:00.000Z"), { text: "Updated 2026-11-02 20:15 UTC" });
  assert.deepEqual(foot("2026-11-02T20:15:59Z"), { text: "Updated 2026-11-02 20:15 UTC" });
  for (const bad of [undefined, null, "", "yesterday", "not a date", {}, []]) assert.equal(foot(bad), undefined, JSON.stringify(bad));
});
