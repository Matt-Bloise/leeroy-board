// Discord cards with party-member data (slice 8): same members as /api/state, class icons, phone-first lines, privacy. Fictional people, no network.
import test from "node:test";
import assert from "node:assert/strict";
import { renderSignupCard, renderBoardCard, loadCardState, requestCardEdit } from "../../infrastructure/worker/cards.js";
import { cardMembers, parseClassEmoji, memberFor } from "../../infrastructure/worker/card-members.js";
import { fakeD1, fakeFetch } from "./fake-d1.mjs";

const CH = "100000000000000001", MSG = "200000000000000002";
const PARTY = {
  members: [
    { name: "Ada", class_key: "mage", class: "Mage", race: "Undead", role: "damage" },
    { name: "Bo", class_key: "priest", class: "Priest", race: "Troll", role: "healer" },
    { name: "Di", class_key: "warrior", class: "Warrior", race: "Orc", role: "tank" },
    { name: "Hidden Hal", race: "Tauren", role: "damage" }, // class hidden on the board: the document has no class or class_key
  ],
};
const SIGNUPS = {
  updated: "2026-11-02T20:15:00.000Z",
  entries: [
    { name: "Ada", rsvp: "in", pack: "yes", meet: "Valley of Strength", when: "6pm" },
    { name: "Bo", rsvp: "maybe", when: "8pm" },
    { name: "Cy", rsvp: "late", slug: "cy" }, // signed up, absent from the party sheets
  ],
};
const EMOJI = { mage: "<:class_mage:300000000000000001>", priest: "<:class_priest:300000000000000002>" };
const state = (extra = {}) => ({ ...SIGNUPS, members: cardMembers(PARTY), classEmoji: EMOJI, siteBase: "https://leeroy.test", boardUrl: "https://leeroy.test/#signups", ...extra });

test("cardMembers: shapes the party document, drops nameless rows, never invents a class", () => {
  const m = cardMembers({ members: [...PARTY.members, { name: "" }, null, { name: "Ada" }] });
  assert.deepEqual(m.map((x) => x.slug), ["ada", "bo", "di", "hidden-hal"]);
  assert.equal(m[3].classKey, "");
  assert.equal(m[3].classLabel, "");
  assert.deepEqual(cardMembers(null), []);
});

test("memberFor: by slug, else by name; a stranger matches nothing", () => {
  const m = cardMembers(PARTY);
  assert.equal(memberFor(m, { name: "ADA" }).slug, "ada");
  assert.equal(memberFor(m, { name: "x", slug: "bo" }).slug, "bo");
  assert.equal(memberFor(m, { name: "Cy" }), null);
});

test("parseClassEmoji: only well-formed application emoji for real classes", () => {
  assert.deepEqual(parseClassEmoji(JSON.stringify({ mage: EMOJI.mage, rogue: "<:x:1>", nope: EMOJI.mage, priest: "@everyone" })), { mage: EMOJI.mage });
  assert.deepEqual(parseClassEmoji("not json"), {});
  assert.deepEqual(parseClassEmoji(undefined), {});
});

test("board card snapshot with members: two lines per person, -# detail line, no instructions", () => {
  const c = renderBoardCard(state());
  assert.deepEqual(c, {
    embeds: [{
      title: "Party board",
      description: "1 in · 1 tentative · 1 running late · 0 out",
      color: 0xffd100,
      fields: [{
        name: "Who",
        value: [
          "<:class_mage:300000000000000001> **Ada** · Mage · damage",
          "-# Undead · In · 6pm · Valley of Strength · pack yes",
          "<:class_priest:300000000000000002> **Bo** · Priest · healer",
          "-# Troll · Tentative · 8pm",
          "**Di** · Warrior · tank",
          "-# Orc · No answer",
          "**Hidden Hal** · damage",
          "-# Tauren · No answer",
          "**Cy**",
          "-# Not on the party sheets yet · Running late",
        ].join("\n"),
        inline: false,
      }],
      footer: { text: "Updated 2026-11-02 20:15 UTC" },
      thumbnail: { url: "https://leeroy.test/img/seal.png" },
    }],
    components: [{ type: 1, components: [{ type: 2, style: 5, label: "Open the board", url: "https://leeroy.test/#signups" }] }],
    allowed_mentions: { parse: [] },
  });
});

test("sign-up card with members: class icons, party members with no answer listed, buttons unchanged", () => {
  const c = renderSignupCard(state());
  const f = Object.fromEntries(c.embeds[0].fields.map((x) => [x.name, x.value]));
  assert.equal(f["In (1)"], "<:class_mage:300000000000000001> Ada");
  assert.equal(f["Tentative (1)"], "<:class_priest:300000000000000002> Bo");
  assert.equal(f["Running late (1)"], "Cy");
  assert.equal(f["No answer yet (2)"], "Di, Hidden Hal");
  assert.equal(c.embeds[0].thumbnail.url, "https://leeroy.test/img/seal.png");
  assert.equal(c.components.length, 3);
  for (const fld of c.embeds[0].fields) assert.ok(fld.value.length <= 1024 && fld.name.length <= 256);
});

test("privacy: a hidden class never reaches a card; the member is still listed", () => {
  const text = JSON.stringify([renderBoardCard(state()), renderSignupCard(state())]);
  assert.ok(!/Hal[^"]*Mage|Hal[^"]*Warrior/.test(text));
  assert.ok(text.includes("Hidden Hal"));
});

test("no emoji map, no site base: plain names, no thumbnail, still valid", () => {
  const c = renderBoardCard(state({ classEmoji: {}, siteBase: undefined }));
  assert.equal(c.embeds[0].thumbnail, undefined);
  assert.ok(c.embeds[0].fields[0].value.startsWith("**Ada** · Mage · damage\n-# Undead · In"));
  const bad = renderBoardCard(state({ siteBase: "http://insecure.test" }));
  assert.equal(bad.embeds[0].thumbnail, undefined);
});

test("names and sign-up text cannot ping or link; many members split into fields under 1024", () => {
  const evil = renderBoardCard({ members: [], entries: [{ name: "<@123456789012345678> @everyone [x](http://e.test)", rsvp: "in", meet: "@here http://e.test" }] });
  assert.ok(!/[<>@\[\]()]/.test(evil.embeds[0].fields[0].value.replace("-# ", "")), evil.embeds[0].fields[0].value);
  const many = { members: Array.from({ length: 40 }, (_, i) => ({ name: `Player ${i}`, class_key: "mage", race: "Orc", role: "damage" })), entries: [] };
  const big = renderBoardCard({ ...many, members: cardMembers(many) });
  assert.ok(big.embeds[0].fields.length > 1 && big.embeds[0].fields.length <= 6);
  for (const f of big.embeds[0].fields) assert.ok(f.value.length <= 1024);
});

test("legacy shape unchanged when no members are supplied", () => {
  const c = renderBoardCard(SIGNUPS);
  assert.equal(c.embeds[0].fields[0].value.split("\n")[0], "**Ada**: In · 6pm · Valley of Strength · pack yes");
  assert.equal(c.embeds[0].thumbnail, undefined);
  assert.equal(renderSignupCard(SIGNUPS).embeds[0].fields.some((f) => /No answer yet/.test(f.name)), false);
});

test("loadCardState + redraw: one extra party read, PATCH carries party members; a failed read falls back", async () => {
  let t = 1_000_000;
  const DB = fakeD1({ signups: SIGNUPS, party: PARTY, cards: { board: { channel: CH, message: MSG } } });
  const env = { CARDS_ENABLED: "on", DISCORD_BOT_TOKEN: "test-token", DB, BOARD_PUBLIC_URL: "https://leeroy.test/", CARD_CLASS_EMOJI: JSON.stringify(EMOJI) };
  const s = await loadCardState(env);
  assert.deepEqual(s.members.map((m) => m.slug), ["ada", "bo", "di", "hidden-hal"]);
  assert.equal(s.siteBase, "https://leeroy.test");
  const f = fakeFetch(() => ({ status: 200 }));
  const r = await requestCardEdit(env, { clock: () => t, sleep: async () => {}, fetchImpl: f });
  assert.equal(r.status, "edited");
  assert.match(f.calls[0].body.embeds[0].fields[0].value, /\*\*Di\*\* · Warrior · tank/);
  const broken = fakeD1({ signups: SIGNUPS, party: "{not json" });
  const s2 = await loadCardState({ DB: broken });
  assert.equal(s2.members, undefined);
});
