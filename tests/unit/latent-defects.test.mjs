// Latent defects from the 2026-11-14 catalogue (docs/review-classes.md, follow-ups F-1, F-3, F-6, F-7, F-9, F-10), one test block per fix.
// Each test failed on master before its fix. Fictional data only. No network, no D1, no AI.
import test from "node:test";
import assert from "node:assert/strict";
import { applySignupChange, tallyEntries, renderSignupCard, renderBoardCard, cleanName, sanitiseWriteIn } from "../../infrastructure/worker/cards.js";
import { rank, expandWords } from "../../vendor/rank-core.js";
import * as workerRank from "../../infrastructure/worker/rank-core.js";
import { upsertSignupEntry } from "../../infrastructure/worker/limits.js";
import { composeLine, diffRsvp, recordChanges } from "../../infrastructure/worker/board-lines.js";
import { handleCardInteraction } from "../../infrastructure/worker/cards-handler.js";
import { recomputeSignupTallies } from "../../infrastructure/worker/discord.js";
import { cardMembers } from "../../infrastructure/worker/card-members.js";
import { invalidateConfigCache } from "../../infrastructure/worker/config.js";
import { fakeD1 } from "./fake-d1.mjs";

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

// F-1 (end to end): a null or non-object row in the sign-up doc crashed the tally recompute, the card click and the board-line diff.
test("F-1 recomputeSignupTallies and diffRsvp: junk rows are skipped, real rows still count", async () => {
  const doc = { entries: [...JUNK, { name: "Red Fox", rsvp: "in", pack: "yes", when: "8pm", meet: "vos" }] };
  const out = await recomputeSignupTallies(doc);
  assert.equal(out.tallies.rsvp.in.count, 1);
  assert.equal(out.tallies.pack.yes.count, 1);
  assert.equal(doc.entries.length, JUNK.length + 1, "junk rows are kept, not removed");
  const before = { entries: [...JUNK, { name: "Red Fox", rsvp: "maybe" }] };
  const after = { entries: [...JUNK, { name: "Red Fox", rsvp: "in" }] };
  assert.deepEqual(diffRsvp(before, after).map((c) => [c.name, c.from, c.to]), [["Red Fox", "maybe", "in"]]);
  assert.deepEqual(diffRsvp({ entries: JUNK }, { entries: JUNK }), []);
});

test("F-1 card click: a null row in the stored doc does not crash the click; the click lands on the member's row", async () => {
  invalidateConfigCache();
  const DB = fakeD1({ signups: { options: {}, entries: [null, 5, "x", [], { name: "Ada", rsvp: "maybe" }] }, cards: { signups: { channel: "100000000000000001", message: "200000000000000002" } } });
  const deps = { origin: "https://api.test", recompute: async (d) => { await recomputeSignupTallies(d); }, insertIntent: async () => {}, purgeWorkerCache: async () => {}, broadcastToRoom: async () => {} };
  const waits = [];
  const env = { CARDS_ENABLED: "on", DB };
  const r = await handleCardInteraction({ interaction: { type: 3, id: "300000000000000003", channel_id: "100000000000000001", data: { custom_id: "signup:rsvp:in" } }, env, ctx: { waitUntil: (p) => waits.push(p) }, member: { slug: "ada", name: "Ada" }, byName: "Ada", deps, now: NOW });
  await Promise.all(waits);
  assert.equal(r.data.flags, 64);
  const doc = JSON.parse(DB.kv.get("signups"));
  assert.equal(doc.entries.length, 5);
  assert.equal(doc.entries.find((e) => e && e.name === "Ada").rsvp, "in");
});

// F-9 bypass: the URL strip ran before the markdown strip, so markdown characters inside the scheme hid it, and removing them left a live link.
test("F-9 sanitiseWriteIn, cleanName and meet: a link split by markdown characters is removed", () => {
  for (const raw of ["ht*tps://e.test/a", "ht[]tp://e.test", "h_t~t|ps://e.test/x", "see ht*tps://e.test/a now"]) {
    assert.ok(!/https?:|e\.test/i.test(sanitiseWriteIn(raw)), `sanitise ${raw}`);
    assert.ok(!/https?:|e\.test/i.test(cleanName(raw)), `name ${raw}`);
    const card = renderSignupCard({ entries: [{ name: "Ada", rsvp: "in", meet: raw, when: raw }] }).embeds[0];
    assert.ok(!/https?:|e\.test/i.test(JSON.stringify(card)), `card ${raw}`);
  }
  assert.equal(cleanName("see ht*tps://e.test/a now"), "see now");
});

// detailBits pushed an empty `when`, leaving a dangling " · " in the board card.
test("board card: a when or meet that cleans to nothing leaves no dangling separator", () => {
  const members = cardMembers({ members: [{ name: "Red Fox", class_key: "druid" }] });
  const v = renderBoardCard({ members, entries: [{ slug: "red-fox", name: "Red Fox", rsvp: "in", when: "https://e.test/x", meet: "discord.gg/abc" }, { name: "Stranger", rsvp: "in", when: "https://e.test/x" }] }).embeds[0].fields[0].value;
  assert.ok(!/ · (\n|$)/.test(v) && !/ ·  · /.test(v), JSON.stringify(v));
  assert.match(v, /-# In$/m);
});

// Offered admin `when` options print unchanged, even when cleaning would change them.
test("offered when options print unchanged in both cards", () => {
  const options = { when: ["#1 slot", "9pm (late)"] };
  const entries = [{ name: "Ada", rsvp: "in", when: "#1 slot" }, { name: "Bo", rsvp: "in", when: "9pm (late)" }];
  const sign = renderSignupCard({ options, entries }).embeds[0].fields.find((f) => f.name === "Arriving").value;
  assert.match(sign, /^#1 slot: Ada$/m);
  assert.match(sign, /^9pm \(late\): Bo$/m);
  const board = renderBoardCard({ options, entries }).embeds[0].fields[0].value;
  assert.match(board, /Ada\*\*: In · #1 slot/);
  assert.match(board, /Bo\*\*: In · 9pm \(late\)/);
  const members = cardMembers({ members: [{ name: "Ada" }] });
  assert.match(renderBoardCard({ options, members, entries: [entries[0]] }).embeds[0].fields[0].value, /In · #1 slot/);
});

// Object-property words are plain data in the class-emoji lookup, the line composer and the pending record.
test("classKey constructor and friends: no inherited property prints; changes keyed __proto__ survive", () => {
  const parsed = cardMembers({ members: [{ name: "Red Fox", class_key: "constructor" }] });
  assert.equal(parsed[0].classKey, "");
  const hand = [{ slug: "red-fox", name: "Red Fox", classKey: "constructor", classLabel: "x" }, { slug: "ada", name: "Ada", classKey: "toString", classLabel: "x" }];
  const entries = [{ name: "Red Fox", rsvp: "in" }];
  for (const text of [JSON.stringify(renderSignupCard({ members: hand, entries })), JSON.stringify(renderBoardCard({ members: hand, entries }))]) assert.ok(!/function|\[native/.test(text), text);
  assert.equal(composeLine({ a: { name: "Ada", to: "constructor" }, b: { name: "Bo", to: "in" } }), "From the board: Bo is in.");
  const p = recordChanges(null, [{ key: "__proto__", name: "Ada", from: null, to: "in" }, { key: "constructor", name: "Bo", from: null, to: "out" }], NOW);
  assert.equal(Object.keys(p.changes).length, 2);
  assert.equal(composeLine(p.changes), "From the board: Ada is in and Bo is out.");
  assert.equal(recordChanges(p, [{ key: "constructor", name: "Bo", from: "out", to: null }], NOW + 1) !== null, true);
});

// Codex review (a): a member whose entry has an invalid rsvp is in no RSVP list, so they belong under "No answer yet".
test("signup card: an invalid stored rsvp counts as no answer", () => {
  const members = cardMembers({ members: [{ name: "Red Fox" }, { name: "Ada" }] });
  const f = renderSignupCard({ members, entries: [{ slug: "red-fox", name: "Red Fox", rsvp: "constructor" }, { slug: "ada", name: "Ada", rsvp: "in" }] }).embeds[0].fields;
  const quiet = f.find((x) => x.name.startsWith("No answer yet"));
  assert.ok(quiet, JSON.stringify(f));
  assert.equal(quiet.name, "No answer yet (1)");
  assert.match(quiet.value, /Red Fox/);
});

// Codex review (b): a bare Discord invite in `when` or `meet` printed as a live invite.
test("cards: a bare Discord invite in when or meet is removed in both card variants", () => {
  const entries = [{ name: "Ada", rsvp: "in", when: "discord.gg/abcdef", meet: "inn discord.gg/abcdef" }, { name: "Bo", rsvp: "in", when: "9pm discord.com/invite/xyz" }];
  const members = cardMembers({ members: [{ name: "Ada" }] });
  for (const out of [renderSignupCard({ entries }), renderSignupCard({ members, entries }), renderBoardCard({ entries }), renderBoardCard({ members, entries })]) {
    const text = JSON.stringify(out);
    assert.ok(!/discord\.(gg|com)|\/invite/i.test(text), text);
  }
  const arr = renderSignupCard({ entries }).embeds[0].fields.find((f) => f.name === "Arriving").value;
  assert.match(arr, /^9pm: Bo$/m);
});
