// Latent defects from the 2026-11-14 catalogue (docs/review-classes.md, follow-ups F-1, F-3, F-6, F-7, F-9, F-10), one test block per fix.
// Each test failed on master before its fix. Fictional data only. No network, no D1, no AI.
import test from "node:test";
import assert from "node:assert/strict";
import { applySignupChange, tallyEntries, renderSignupCard, renderBoardCard, cleanName, sanitiseWriteIn } from "../../infrastructure/worker/cards.js";
import { rank, expandWords } from "../../vendor/rank-core.js";
import * as workerRank from "../../infrastructure/worker/rank-core.js";
import { upsertSignupEntry } from "../../infrastructure/worker/limits.js";
import { composeLine } from "../../infrastructure/worker/board-lines.js";

const NOW = Date.UTC(2026, 10, 3, 12);
const JUNK = [null, undefined, 5, "text", true, [], [1, 2]];

// F-1: applySignupChange read `e.name` on every row and threw on a null one.
test("F-1 applySignupChange: rows that are not objects are skipped and kept; the click lands on the real row", () => {
  const doc = { entries: [...JUNK, { slug: "red-fox", name: "Red Fox", rsvp: "maybe" }] };
  const r = applySignupChange(doc, { name: "Red Fox", slug: "red-fox", field: "rsvp", value: "in", now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  assert.equal(r.before, "maybe");
  assert.equal(r.doc.entries.length, JUNK.length + 1, "no junk row is removed and no second row is added");
  const fox = r.doc.entries.find((e) => e && e.slug === "red-fox");
  assert.equal(fox.rsvp, "in");
  assert.equal(fox.updated, "2026-11-03T12:00:00.000Z");
  const fresh = applySignupChange({ entries: [null, 5] }, { name: "Blue Owl", field: "when", value: "8pm", now: NOW });
  assert.equal(fresh.ok, true);
  assert.deepEqual(fresh.doc.entries.at(-1), { name: "Blue Owl", when: "8pm", updated: "2026-11-03T12:00:00.000Z" });
  assert.equal(doc.entries.at(-1).rsvp, "maybe", "the input document is not changed");
});

// F-3 and F-6: a stored value that is also an Object.prototype name was used as a lookup key (`table[value]`), so the sign-up card threw
// (`out.rsvp[e.rsvp].push is not a function`), the board card printed a function's source, and the ranker threw on `synonyms[w] || []`.
const PROTO_WORDS = ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"];

test("F-3 cards: an rsvp or pack that is an object-property word is plain data, counted nowhere and printed as no answer", () => {
  const entries = PROTO_WORDS.flatMap((w, i) => [{ name: `Rsvp Word ${i}`, rsvp: w }, { name: `Pack Word ${i}`, rsvp: "in", pack: w }]);
  const t = tallyEntries({ entries });
  assert.deepEqual(Object.fromEntries(Object.entries(t.rsvp).map(([k, v]) => [k, v.length])), { in: PROTO_WORDS.length, maybe: 0, late: 0, out: 0 });
  assert.deepEqual([t.pack.yes.length, t.pack.no.length], [0, 0]);
  const members = entries.map((e) => ({ slug: e.name.toLowerCase().replace(/ /g, "-"), name: e.name, classKey: "", classLabel: "", race: "", role: "" }));
  const cards = [renderSignupCard({ entries }), renderSignupCard({ entries, members }), renderBoardCard({ entries }), renderBoardCard({ entries, members })];
  for (const card of cards) {
    const text = JSON.stringify(card.embeds[0]);
    assert.ok(!/native code|function|\[object/i.test(text), text);
    assert.ok(!/pack (constructor|__proto__|toString|hasOwnProperty|valueOf)\b/.test(text), "a prototype word is not printed as a pack answer");
  }
  assert.match(cards[2].embeds[0].fields[0].value, /\*\*Rsvp Word 0\*\*: No answer/);
  assert.equal({}.push, undefined, "Object.prototype is untouched");
});

test("F-6 rank-core: a question or sheet word that is an object-property word ranks like any other word", () => {
  const pages = [{ id: "classes/warden", aliases: ["warden"], facts: [{ key: "warden.role", value: "A constructor of wards." }], open: [] }];
  for (const set of [expandWords(["constructor"]), workerRank.expandWords(["constructor"])]) assert.deepEqual([...set], ["constructor"]);
  for (const r of [rank, workerRank.rank]) {
    const out = r("__proto__ constructor wardens", pages);
    assert.ok(out.words.includes("constructor"));
    assert.equal(out.hits[0].key, "warden.role");
    assert.ok(Number.isFinite(out.hits[0].score) && out.hits[0].score > 0);
    assert.doesNotThrow(() => r("valueof hasownproperty tostring", pages));
  }
  assert.ok(expandWords(["zone"]).has("area"), "a real synonym still expands");
});

// F-7: upsertSignupEntry merged duplicate rows by comparing `updated` as strings, so "yesterday" (or a zone-less stamp) beat a valid ISO one.
test("F-7 upsertSignupEntry: a malformed or zone-less stamp never wins a duplicate-row merge over a valid one", () => {
  const VALID = "2026-11-01T10:00:00.000Z";
  for (const bad of ["yesterday", "zzz", "2026-11-09T10:00:00", "2026-11-09", "", 9e15, null, {}, ["2027"]]) {
    for (const order of ["valid first", "bad first"]) {
      const good = { slug: "red-fox", name: "Red Fox", rsvp: "in", updated: VALID };
      const junk = { name: "Red Fox", rsvp: "out", meet: "The Crossroads", updated: bad };
      const doc = { entries: order === "valid first" ? [good, junk] : [junk, good] };
      const e = upsertSignupEntry(doc, { slug: "red-fox", name: "Red Fox" });
      const label = `${JSON.stringify(bad)}, ${order}`;
      assert.equal(doc.entries.length, 1, label);
      assert.equal(e.rsvp, "in", label);
      assert.equal(e.updated, VALID, label);
      assert.equal(e.meet, "The Crossroads", `${label}: a field the valid row lacks is still filled`);
    }
  }
  // Two valid stamps compare by instant, not by spelling: 11:30+01:00 is 10:30Z, later than 10:00Z.
  const doc = { entries: [{ slug: "red-fox", name: "Red Fox", rsvp: "maybe", updated: "2026-11-01T11:30:00+01:00" }, { name: "Red Fox", rsvp: "late", updated: VALID }] };
  assert.equal(upsertSignupEntry(doc, { slug: "red-fox", name: "Red Fox" }).rsvp, "maybe");
  // The newer valid row still wins, as before.
  const later = { entries: [{ slug: "red-fox", name: "Red Fox", rsvp: "in", updated: VALID }, { name: "Red Fox", rsvp: "out", updated: "2026-11-02T10:00:00.000Z" }] };
  assert.equal(upsertSignupEntry(later, { slug: "red-fox", name: "Red Fox" }).rsvp, "out");
});

// F-9: a free-text `when` (a member write takes any string up to 200 characters) was printed as stored in the sign-up card's Arriving field
// and in the plain board card, so a channel mention or a masked link rendered live. `meet` was already cleaned.
test("F-9 cards: a free-text when is cleaned like meet before it is printed; the offered options print as before", () => {
  const HOSTILE_WHEN = ["<#123456789012345678> # x", "[soon](https://e.test)", "@everyone 9pm", "**late** ||s||", "https://e.test/a"];
  const entries = [...HOSTILE_WHEN.map((when, i) => ({ name: `Hostile When ${i}`, rsvp: "in", when })), { name: "Plain When", rsvp: "in", when: "8pm" }];
  const signup = renderSignupCard({ entries }).embeds[0];
  const arriving = signup.fields.find((f) => f.name === "Arriving");
  const board = renderBoardCard({ entries }).embeds[0].fields[0].value.replace(/^\*\*(.*?)\*\*/gm, "$1");
  for (const text of [arriving.value, board]) {
    assert.ok(!/[<>@\[\]*_~|`]/.test(text), JSON.stringify(text));
    assert.ok(!/https?:\/\//i.test(text), JSON.stringify(text));
    assert.ok(!/<#\d+>/.test(text), JSON.stringify(text));
  }
  assert.match(arriving.value, /^8pm: Plain When$/m);
  assert.match(arriving.value, /^x: Hostile When 0$/m, "a when that would start a heading line loses the marker");
  assert.ok(!/^\s*(#|>|-#)/m.test(arriving.value), arriving.value);
  assert.match(board, /^Plain When: In · 8pm$/m);
  // A when that cleans to nothing is not shown as an empty arrival.
  const empty = renderSignupCard({ entries: [{ name: "Only Links", rsvp: "in", when: "https://e.test/x" }] }).embeds[0];
  assert.equal(empty.fields.find((f) => f.name === "Arriving"), undefined);
});

// F-10: cleanName removed https:// links but kept a bare `discord.gg/` invite, which Discord turns into a live invite in the In list.
test("F-10 cleanName: a bare Discord invite is removed from a printed name; other names print as before", () => {
  const INVITES = ["discord.gg/abcdef", "Ada discord.gg/abcdef", "DISCORD.GG/AbC", "www.discord.gg/x1", "discord.com/invite/abcdef", "discordapp.com/invite/x", "ｄｉｓｃｏｒｄ．ｇｇ/abc", "join discord.gg/abc now"];
  for (const raw of INVITES) {
    const n = cleanName(raw);
    assert.ok(!/discord(app)?\.(gg|com)|\/invite|gg\//i.test(n), `${JSON.stringify(raw)} -> ${JSON.stringify(n)}`);
  }
  assert.equal(cleanName("discord.gg/abcdef"), "Someone");
  assert.equal(cleanName("Ada discord.gg/abcdef"), "Ada");
  assert.equal(cleanName("join discord.gg/abc now"), "join now");
  for (const name of ["Discord Fan", "Red Fox", "gg wp", "A".repeat(40), "@Ada [x](https://e.test)"]) assert.equal(cleanName(name), sanitiseWriteIn(name, 24), name);
  const card = renderSignupCard({ entries: [{ name: "Blue Owl discord.gg/abcdef", rsvp: "in" }] }).embeds[0];
  assert.equal(card.fields[0].value, "Blue Owl");
  assert.equal(composeLine({ k: { name: "discord.gg/abc Blue Owl", to: "in" } }), "From the board: Blue Owl is in.");
});
