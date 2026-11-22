// REPLY_STYLE (docs/discord-reply-style.md): the house style for the sign-up card, the party board, the answer buttons and the /page, /tooltip and
// /map cards. Flag off: today's bodies, byte for byte. Flag on: the rules, inside every Discord limit, with a picture card's image kept.
// Fictional names, ids and data only. No network (fetch is stubbed), no AI.
// Run: node --test tests/unit/reply-style.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderSignupCard, renderBoardCard, postCard, requestCardEdit } from "../../infrastructure/worker/cards.js";
import { buildAnswerComponents } from "../../infrastructure/worker/answer-ux.js";
import { handleDiscordInteraction } from "../../infrastructure/worker/discord.js";
import { invalidateConfigCache } from "../../infrastructure/worker/config.js";
import {
  replyStyleOn, REPLY_STYLE_FLAG, REPLY_COLORS, styleSignupCard, styleBoardCard, styleAnswerButtons, pageCard, tooltipCard, mapCard,
  finishEmbed, finishComponents, embedTimestamp, embedChars, clip, boardBase, STAMP_AHEAD_MS, SIGNUP_LOOK, BOARD_LOOK,
} from "../../infrastructure/worker/reply-style.js";
import { createDiscordSigner } from "../helpers/discord-sign.mjs";
import { fakeD1, fakeFetch } from "./fake-d1.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const cp = (...n) => String.fromCodePoint(...n);
const ZWSP = cp(0x200b), RLO = cp(0x202e), PDF = cp(0x202c), LSEP = cp(0x2028), BOM = cp(0xfeff), BLANK = cp(0x200b);
const INVISIBLE_RE = new RegExp(`[${cp(0x200b)}-${cp(0x200f)}${cp(0x2028)}-${cp(0x202e)}${cp(0x2060)}-${cp(0x206f)}${cp(0xfeff)}]`);
const NOW = Date.parse("2026-11-22T12:00:00.000Z");
const BASE = "https://board.test";
const CH = "100000000000000001", MSG = "200000000000000002";
const IMAGE = { url: `${BASE}/img/cards/fixture.png` };
const RSVPS = ["in", "maybe", "late", "out"];

const STATE = {
  updated: "2026-11-21T20:15:00.000Z",
  siteBase: BASE,
  boardUrl: `${BASE}/#signups`,
  options: { meet: ["Valley of Strength", "The Crossroads"], when: ["6pm", "8pm", "later"] },
  entries: [
    { name: "Quillfeather", rsvp: "in", pack: "yes", meet: "Valley of Strength", when: "6pm" },
    { name: "Bramblewick", rsvp: "maybe", pack: "no", meet: "The Crossroads", when: "8pm" },
    { name: "Nimbus", rsvp: "late", meet: "Behind the inn", when: "later" },
    { name: "Tallowmere", rsvp: "out" },
  ],
};
const MEMBERS = [
  { slug: "quill", name: "Quillfeather", classKey: "mage", classLabel: "Mage", race: "Undead", role: "damage" },
  { slug: "bram", name: "Bramblewick", classKey: "priest", classLabel: "Priest", race: "Troll", role: "healer" },
  { slug: "rook", name: "Rookmantle", classKey: "warrior", classLabel: "Warrior", race: "Orc", role: "tank" },
];
const longRoster = (n) => Array.from({ length: n }, (_, i) => ({ name: `${"Long fictional name ".repeat(3)}${i}`, rsvp: RSVPS[i % 4], meet: `${"Meeting place ".repeat(6)}${i % 9}`, when: `late ${i}`, pack: i % 2 ? "yes" : "no", slug: `m${i}` }));
const longMembers = (entries) => entries.map((e) => ({ slug: e.slug, name: e.name, classKey: "", classLabel: "Frost Mage", race: "Undead", role: "damage" }));
const HOSTILE = [
  "@everyone", "@here", "<@123456789012345678>", "<@&123456789012345678>", "<#123456789012345678>", "[click](https://evil.test)", "[a](<https://evil.test>)",
  `${RLO}evil${PDF}`, `a${ZWSP}b`, "line one\nline two", `line${LSEP}sep`, "# heading", "> quote", "`code`", "**bold**", "_italic_", "||spoiler||", "~~strike~~",
  "https://evil.test/x", "discord.gg/abcdef", `${BOM}bom`, "constructor", "__proto__", "toString",
];
const OFF_LIKE = [undefined, null, "", " ", "off", "OFF", "Off", false, true, 0, 1, "0", "1", "no", "false", "true", "nope", "of", "onn", "on!", "o n", `o${ZWSP}n`, cp(0xff4f, 0xff4e), {}, []];

// ---- Discord's own rules, written out here so a change to the module's constants cannot move the test ----
const D = { title: 256, description: 4096, fields: 25, fieldName: 256, fieldValue: 1024, footer: 2048, author: 256, total: 6000 };
const str = (s) => (typeof s === "string" ? s : "");
function strings(x, out = []) {
  if (typeof x === "string") out.push(x);
  else if (x && typeof x === "object") for (const v of Object.values(x)) strings(v, out);
  return out;
}
function assertHttps(u, at) {
  let p;
  assert.doesNotThrow(() => { p = new URL(u); }, `${at}: url parses`);
  assert.equal(p.protocol, "https:", `${at}: https`);
}
function assertEmbedValid(e, at) {
  const total = str(e.title).length + str(e.description).length + str(e.author && e.author.name).length + str(e.footer && e.footer.text).length +
    (e.fields || []).reduce((n, f) => n + f.name.length + f.value.length, 0);
  assert.ok(total <= D.total, `${at}: ${total} characters in all`);
  assert.equal(total, embedChars(e), `${at}: embedChars counts what Discord counts`);
  if ("title" in e) assert.ok(e.title.length >= 1 && e.title.length <= D.title, `${at}: title`);
  if ("description" in e) assert.ok(e.description.length >= 1 && e.description.length <= D.description, `${at}: description`);
  if ("author" in e) assert.ok(e.author.name.length >= 1 && e.author.name.length <= D.author, `${at}: author`);
  if ("footer" in e) assert.ok(e.footer.text.length >= 1 && e.footer.text.length <= D.footer, `${at}: footer`);
  assert.ok((e.fields || []).length <= D.fields, `${at}: fields`);
  for (const f of e.fields || []) {
    assert.ok(f.name.length >= 1 && f.name.length <= D.fieldName, `${at}: field name ${JSON.stringify(f.name)}`);
    assert.ok(f.value.length >= 1 && f.value.length <= D.fieldValue, `${at}: field value of ${f.name}`);
    assert.equal(typeof f.inline, "boolean", `${at}: inline is a boolean`);
  }
  for (const u of [e.url, e.author && e.author.icon_url, e.thumbnail && e.thumbnail.url, e.footer && e.footer.icon_url]) if (u !== undefined) assertHttps(u, at);
  if ("timestamp" in e) assert.equal(new Date(e.timestamp).toISOString(), e.timestamp, `${at}: timestamp is ISO`);
  if ("color" in e) assert.ok(Number.isInteger(e.color) && e.color >= 0 && e.color <= 0xffffff, `${at}: color`);
  assert.ok(!(e.thumbnail && e.image), `${at}: one picture per card`);
  for (const s of strings(e)) assert.ok(s.isWellFormed(), `${at}: a string is not well-formed Unicode`);
}
function assertComponentsValid(rows, at) {
  assert.ok(Array.isArray(rows) && rows.length <= 5, `${at}: up to 5 rows`);
  const ids = [];
  for (const [ri, row] of rows.entries()) {
    assert.equal(row.type, 1, `${at} row ${ri}: an action row`);
    assert.ok(row.components.length >= 1 && row.components.length <= 5, `${at} row ${ri}: 1 to 5 buttons`);
    for (const c of row.components) {
      assert.equal(c.type, 2, `${at}: a button`);
      assert.ok(typeof c.label === "string" && c.label.length >= 1 && c.label.length <= 80, `${at}: label ${JSON.stringify(c.label)}`);
      assert.equal((c.custom_id ? 1 : 0) + (c.url ? 1 : 0), 1, `${at}: one of custom_id or url`);
      assert.equal(c.style === 5, Boolean(c.url), `${at}: style 5 iff url`);
      assert.ok(Number.isInteger(c.style) && c.style >= 1 && c.style <= 5, `${at}: style`);
      if (c.custom_id) { assert.ok(c.custom_id.length <= 100, `${at}: custom_id`); ids.push(c.custom_id); }
      if (c.url) assertHttps(c.url, at);
    }
    const links = row.components.map((c) => c.style === 5);
    assert.deepEqual(links, [...links].sort((a, b) => a - b), `${at} row ${ri}: link buttons last`);
  }
  assert.equal(new Set(ids).size, ids.length, `${at}: custom ids are unique`);
}
function assertBodyValid(body, at) {
  assert.deepEqual(body.allowed_mentions, { parse: [] }, `${at}: no mention is parsed`);
  assert.ok(Array.isArray(body.embeds) && body.embeds.length >= 1, `${at}: an embed`);
  for (const e of body.embeds) assertEmbedValid(e, at);
  assertComponentsValid(body.components, at);
}
const ids = (body) => body.components.map((r) => r.components.map((c) => c.custom_id || c.url));
const styles = (body) => body.components.map((r) => r.components.map((c) => c.style));
const byId = (body) => new Map(body.components.flatMap((r) => r.components).map((c) => [c.custom_id || c.url, c]));
const json = (x) => JSON.stringify(x);

// ---- the flag ----
test("flag: only the word on (any case, trimmed) is on; absent and every off-like value are off", () => {
  assert.equal(REPLY_STYLE_FLAG, "REPLY_STYLE");
  for (const env of [undefined, null, {}]) assert.equal(replyStyleOn(env), false, json(env));
  for (const v of OFF_LIKE) assert.equal(replyStyleOn({ REPLY_STYLE: v }), false, json(v));
  for (const v of ["on", "ON", " On ", "on\n"]) assert.equal(replyStyleOn({ REPLY_STYLE: v }), true, json(v));
  // The known coercion every legacyOn helper shares (docs/review-classes.md F-15): an array ["on"] stringifies to "on". wrangler.toml [vars] holds strings only.
  assert.equal(replyStyleOn({ REPLY_STYLE: ["on"] }), true);
});

function cardEnv(DB, extra = {}) {
  return { CARDS_ENABLED: "on", DISCORD_BOT_TOKEN: "test-token", BOARD_PUBLIC_URL: BASE, DB, ...extra };
}
async function postedBody(flag) {
  const DB = fakeD1({ signups: STATE });
  const f = fakeFetch((method) => (method === "POST" ? { status: 200, json: { id: MSG } } : { status: 204 }));
  const env = cardEnv(DB, flag === undefined ? {} : { REPLY_STYLE: flag });
  const r = await postCard(env, { card: "signups", channelId: CH, fetchImpl: f });
  assert.equal(r.ok, true);
  assert.equal(f.calls[0].method, "POST");
  return f.calls[0].body;
}
async function editedBody(flag, card = "signups") {
  const DB = fakeD1({ signups: STATE, cards: { [card]: { channel: CH, message: MSG } } });
  const f = fakeFetch(() => ({ status: 200 }));
  const env = cardEnv(DB, flag === undefined ? {} : { REPLY_STYLE: flag });
  let t = 1_000_000;
  const r = await requestCardEdit(env, { clock: () => t, sleep: async (ms) => { t += ms; }, fetchImpl: f });
  assert.equal(r.status, "edited");
  assert.equal(f.calls[0].method, "PATCH");
  return f.calls[0].body;
}
const SALT = "fictional-salt-for-tests-0123456789abcdef";
const answerRows = (flag, more = true, sources = true) =>
  buildAnswerComponents({ USER_SALT: SALT, ...(flag === undefined ? {} : { REPLY_STYLE: flag }) }, { intentId: "intent1", messageId: "300000000000000003", hasMore: more, hasSources: sources });

test("absent equals off at every gate (card post, card edit, answer buttons), and on changes the body", async () => {
  const gates = [["postCard", () => postedBody], ["redrawCards (signups)", () => (f) => editedBody(f, "signups")], ["redrawCards (board)", () => (f) => editedBody(f, "board")], ["buildAnswerComponents", () => answerRows]];
  for (const [name, mk] of gates) {
    const probe = mk();
    const absent = await probe(undefined);
    assert.deepEqual(await probe("off"), absent, `${name}: absent differs from "off"`);
    for (const v of ["", "OFF", "no", "true", "1"]) assert.deepEqual(await probe(v), absent, `${name}: ${json(v)} differs from absent`);
    assert.notDeepEqual(await probe("on"), absent, `${name}: "on" changes nothing, so the probe would prove nothing`);
  }
});

test("flag off: the renderers return today's body byte for byte, whatever the sign-up document says", () => {
  const states = [
    STATE, { entries: [] }, {}, null, undefined, { ...STATE, members: MEMBERS }, { ...STATE, withheld: true }, { entries: longRoster(300) },
    { entries: longRoster(300), members: longMembers(longRoster(300)) }, { entries: HOSTILE.map((name, i) => ({ name, rsvp: RSVPS[i % 4], meet: name, when: name })) },
    // a document carrying look-alike keys must not switch the style on: the flag comes from env through the executors only
    { ...STATE, style: true, replyStyle: true, REPLY_STYLE: "on", opts: { style: true } },
  ];
  for (const s of states) {
    for (const [render, title] of [[renderSignupCard, "Launch-night sign-ups"], [renderBoardCard, "Party board"]]) {
      const today = json(render(s));
      for (const opts of [undefined, {}, { style: false }, { style: "on" }, { style: 1 }, { style: "true" }, null]) assert.equal(json(render(s, opts)), today, `${render.name} ${json(opts)}`);
      // and that body is today's look, not a styled one: today's title and gold, no author line, no timestamp
      const e = render(s).embeds[0];
      assert.equal(e.title, title, `${render.name}: today's title`);
      assert.equal(e.color, 0xffd100, `${render.name}: today's gold`);
      assert.equal("author" in e || "timestamp" in e, false, `${render.name}: no styled parts`);
    }
  }
});

test("a sign-up document carrying look-alike keys cannot switch the style on through the card executors", async () => {
  const DB = fakeD1({ signups: { ...STATE, style: true, replyStyle: true, REPLY_STYLE: "on" } });
  const f = fakeFetch((method) => (method === "POST" ? { status: 200, json: { id: MSG } } : { status: 204 }));
  assert.equal((await postCard(cardEnv(DB), { card: "signups", channelId: CH, fetchImpl: f })).ok, true);
  const e = f.calls[0].body.embeds[0];
  assert.equal(e.title, "Launch-night sign-ups");
  assert.equal("author" in e, false);
});

// ---- the pinned cards ----
test("sign-up card, styled: author line, title link, green, footer and timestamp; fields, names and custom ids are today's", () => {
  const today = renderSignupCard(STATE);
  const card = styleSignupCard(today, STATE, { now: NOW });
  assert.deepEqual(renderSignupCard(STATE, { style: true }).embeds[0].fields, card.embeds[0].fields);
  const e = card.embeds[0];
  assert.deepEqual(e.author, { name: "Sign-ups", icon_url: `${BASE}/img/icons/tab-signups.png` });
  assert.equal(e.title, "Who is coming");
  assert.equal(e.url, `${BASE}/#signups`);
  assert.equal(e.color, 0x8fc97a);
  assert.deepEqual(e.footer, { text: "The Living Board" });
  assert.equal(e.timestamp, "2026-11-21T20:15:00.000Z");
  assert.deepEqual(e.thumbnail, { url: `${BASE}/img/seal.png` });
  assert.equal(e.description, today.embeds[0].description);
  assert.deepEqual(e.fields, today.embeds[0].fields);
  assert.deepEqual(ids(card), [
    ["signup:rsvp:in", "signup:rsvp:maybe", "signup:rsvp:late", "signup:rsvp:out"],
    ["signup:meet:vos", "signup:meet:xroads", "signup:meet:other"],
    ["signup:when:6pm", "signup:when:8pm", "signup:when:later"],
    ["signup:pack:yes", "signup:pack:no"],
  ]);
  assert.deepEqual(styles(card), [[3, 2, 2, 4], [2, 2, 2], [2, 2, 2], [2, 2]]);
  const was = byId(today);
  assert.deepEqual([...byId(card).keys()].sort(), [...was.keys()].sort(), "the same buttons, regrouped");
  for (const [id, c] of byId(card)) assert.equal(c.label, was.get(id).label, id);
  assertBodyValid(card, "sign-up card");
});

test("party board, styled: author line, title link, footer with the people that did not fit, link last as Open on the board", () => {
  const s = { ...STATE, members: MEMBERS };
  const today = renderBoardCard(s);
  const card = renderBoardCard(s, { style: true });
  const e = card.embeds[0];
  assert.deepEqual(e.author, { name: "The party", icon_url: `${BASE}/img/icons/tab-five.png` });
  assert.equal(e.title, "Party board");
  assert.equal(e.url, `${BASE}/#signups`);
  assert.equal(e.color, REPLY_COLORS.party);
  assert.deepEqual(e.footer, { text: "The Living Board" });
  assert.ok(e.timestamp, "the time of the last change");
  assert.equal(e.description, today.embeds[0].description);
  assert.deepEqual(e.fields, today.embeds[0].fields);
  assert.deepEqual(card.components, [{ type: 1, components: [{ type: 2, style: 5, label: "Open on the board", url: `${BASE}/#signups` }] }]);
  assertBodyValid(card, "party board");
  // 300 long members: today's footer says how many did not fit, and the styled footer keeps that count
  const big = { updated: STATE.updated, siteBase: BASE, boardUrl: `${BASE}/#signups`, entries: longRoster(300), members: longMembers(longRoster(300)) };
  const n = /\+(\d+) more on the board/.exec(renderBoardCard(big).embeds[0].footer.text)[1];
  assert.equal(renderBoardCard(big, { style: true }).embeds[0].footer.text, `The Living Board · +${n} more on the board`);
});

test("every styled card stays inside Discord's limits for 0 to 300 long sign-ups, with and without a picture card's image", () => {
  for (const n of [0, 1, 5, 25, 100, 300]) {
    const entries = longRoster(n);
    for (const s of [{ ...STATE, entries }, { ...STATE, entries, members: longMembers(entries) }, { entries }]) {
      for (const [name, render, style] of [["signups", renderSignupCard, styleSignupCard], ["board", renderBoardCard, styleBoardCard]]) {
        const styled = render(s, { style: true });
        assertBodyValid(styled, `${name} ${n}`);
        // a picture card that adds its image before the style runs: kept as given, and the thumbnail goes
        const today = render(s);
        const pictured = { ...today, embeds: [{ ...today.embeds[0], image: IMAGE }] };
        const out = style(pictured, s, { now: NOW });
        assert.equal(out.embeds[0].image, IMAGE, `${name} ${n}: the image object is untouched`);
        assert.equal(out.embeds[0].thumbnail, undefined, `${name} ${n}: one picture per card`);
        assertBodyValid(out, `${name} ${n} with image`);
        // and one that adds it after the style, then passes the embed through finishEmbed (docs/discord-reply-style.md, "Picture cards"): one picture, still valid
        const after = { ...styled, embeds: [finishEmbed({ ...styled.embeds[0], image: IMAGE })] };
        assert.equal(after.embeds[0].image, IMAGE, `${name} ${n}: image added after the style is untouched`);
        assert.equal(after.embeds[0].thumbnail, undefined, `${name} ${n}: image added after the style still leaves one picture`);
        assertBodyValid(after, `${name} ${n} image after`);
      }
    }
  }
});

test("hostile names: the styled cards print exactly today's field text, and nothing the style adds is friend-written", () => {
  const entries = HOSTILE.map((name, i) => ({ name, rsvp: RSVPS[i % 4], meet: name, when: "6pm", pack: "yes" }));
  for (const render of [renderSignupCard, renderBoardCard]) {
    const today = render({ ...STATE, entries });
    const styled = render({ ...STATE, entries }, { style: true });
    assert.deepEqual(styled.embeds[0].fields, today.embeds[0].fields, render.name);
    const added = [styled.embeds[0].title, styled.embeds[0].author.name, styled.embeds[0].footer.text];
    for (const t of added) for (const h of HOSTILE) assert.ok(!t.includes(h), `${render.name}: ${json(t)} carries ${json(h)}`);
    assertBodyValid(styled, render.name);
  }
});

test("timestamps: a zoned ISO stamp at most 10 minutes ahead is shown; anything else shows no time and is never guessed", () => {
  const ok = [["2026-11-21T20:15:00.000Z", "2026-11-21T20:15:00.000Z"], ["2026-11-21T20:15:00Z", "2026-11-21T20:15:00.000Z"], ["2026-11-21T15:15:00-05:00", "2026-11-21T20:15:00.000Z"],
    ["2026-11-21T20:15Z", "2026-11-21T20:15:00.000Z"], [new Date(NOW + 5 * 60000).toISOString(), new Date(NOW + 5 * 60000).toISOString()]];
  for (const [v, want] of ok) assert.equal(embedTimestamp(v, NOW), want, v);
  assert.equal(embedTimestamp("2024-02-29T10:00:00Z", NOW), "2024-02-29T10:00:00.000Z", "a real leap day");
  assert.equal(embedTimestamp("2026-11-21T20:15:00+05:30", NOW), "2026-11-21T14:45:00.000Z");
  const bad = ["2026-11-21T20:15:00", "2026-11-21T20:15", "2026-11-21", NOW, String(NOW), new Date(NOW + 3600000).toISOString(), new Date(NOW + 365 * 86400000).toISOString(),
    new Date(NOW + STAMP_AHEAD_MS + 1000).toISOString(), "", " ", "yesterday", "not a date", "2026-13-45T25:61:00Z", "1999-12-31T23:59:59Z", " 2026-11-21T20:15:00Z", {}, [], null, undefined, true,
    // impossible calendar times, which Date.parse would roll over instead of refusing
    "2026-02-30T10:00:00Z", "2026-02-29T10:00:00Z", "2026-04-31T10:00:00Z", "2026-00-10T10:00:00Z", "2026-11-00T10:00:00Z", "2026-11-21T24:00:00Z", "2026-11-21T20:60:00Z", "2026-11-21T20:15:60Z", "2026-11-21T20:15:00+15:00", "2026-11-21T20:15:00+05:60"];
  for (const v of bad) assert.equal(embedTimestamp(v, NOW), null, json(v));
  for (const updated of bad) {
    const e = styleSignupCard(renderSignupCard({ ...STATE, updated }), { ...STATE, updated }, { now: NOW }).embeds[0];
    assert.equal("timestamp" in e, false, json(updated));
    assert.deepEqual(e.footer, { text: "The Living Board" });
  }
});

test("object-property words are plain data in the styled cards", () => {
  const words = ["constructor", "__proto__", "toString", "hasOwnProperty"];
  const s = { ...STATE, options: { meet: words, when: words }, entries: words.map((w, i) => ({ name: w, rsvp: w, meet: w, when: w, pack: w, slug: w })), members: words.map((w) => ({ slug: w, name: w, classKey: w, classLabel: w, race: w, role: w })) };
  for (const render of [renderSignupCard, renderBoardCard]) {
    const styled = render(s, { style: true });
    assertBodyValid(styled, render.name);
    assert.deepEqual([...byId(styled).keys()].sort(), [...byId(render(s)).keys()].sort(), render.name);
  }
});

test("party board, styled: no person's line is ever cut; whoever does not fit is counted in +N more, whatever the stamp", () => {
  for (const updated of [undefined, "", "not a date", STATE.updated]) {
    for (let n = 1; n <= 120; n++) {
      const entries = longRoster(n);
      for (const members of [longMembers(entries), longMembers(entries).slice(0, Math.floor(n / 2))]) {
        const s = { siteBase: BASE, boardUrl: `${BASE}/#signups`, updated, entries, members };
        const e = renderBoardCard(s, { style: true }).embeds[0];
        const at = `n=${n} members=${members.length} updated=${json(updated)}`;
        assert.ok(embedChars(e) <= 6000, at);
        const values = e.fields.map((f) => f.value).join("\n");
        assert.ok(!values.includes("…"), `${at}: a line was cut`);
        const people = members.length + entries.filter((x) => !members.some((m) => m.slug === x.slug)).length;
        const shown = values.split("\n").filter((l) => l.startsWith("**")).length;
        const more = /\+(\d+) more on the board$/.exec(e.footer.text);
        assert.equal(shown + (more ? Number(more[1]) : 0), people, `${at}: everyone is shown or counted`);
      }
    }
  }
});

test("admin-set meeting and arrival options print exactly as today on the styled cards (no character removed, so nothing inert becomes live)", () => {
  const options = { meet: [`disc${ZWSP}ord.gg/fict`, `Gate${LSEP}two`], when: ["6pm", `6${ZWSP}8pm`] };
  const s = { ...STATE, options, entries: [{ name: "Quillfeather", rsvp: "in", meet: options.meet[0], when: options.when[1] }, { name: "Nimbus", rsvp: "in", meet: options.meet[1], when: "6pm" }] };
  for (const render of [renderSignupCard, renderBoardCard]) {
    const today = render(s);
    const styled = render(s, { style: true });
    assert.deepEqual(styled.embeds[0].fields, today.embeds[0].fields, render.name);
    const labels = byId(today);
    for (const [id, c] of byId(styled)) if (c.custom_id) assert.equal(c.label, labels.get(id).label, `${render.name} ${id}`); // a choice keeps its label; the link label is the style's own
  }
});

// The closed set: the styled card is today's card with exactly the documented parts replaced. Unknown keys and friend text in the document
// (canaries below) can only reach the parts today's card already prints.
test("the styled cards are today's cards with only the documented parts replaced, for any document", () => {
  const CANARY = "Canary-7f3e";
  let seed = 11;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let i = 0; i < 300; i++) {
    const n = [0, 1, 4, 12, 31, 45, 60][rnd(7)];
    const entries = Array.from({ length: n }, (_, k) => ({ name: rnd(5) ? `Name${k}` : `${CANARY}${k}`, rsvp: RSVPS[rnd(4)], slug: `s${k}`, when: ["6pm", "8pm", "", CANARY][rnd(4)], meet: ["Valley of Strength", "", CANARY][rnd(3)], pack: ["yes", "no", ""][rnd(3)], note: CANARY }));
    const s = {
      entries, updated: [STATE.updated, "", "2026-11-21T20:15", undefined][rnd(4)], options: rnd(2) ? STATE.options : undefined,
      siteBase: [BASE, "", "http://board.test"][rnd(3)], boardUrl: [`${BASE}/#signups`, undefined, "http://x"][rnd(3)],
      journeys: [{ name: CANARY }], notes: CANARY, owner: { name: CANARY }, withheld: rnd(4) === 0,
      ...(rnd(2) ? { members: entries.slice(0, Math.ceil(n / 2)).map((x) => ({ slug: x.slug, name: x.name, classKey: "mage", classLabel: "Mage", race: "Orc", role: "tank" })) } : {}),
    };
    for (const [render, style, look, icon] of [[renderSignupCard, styleSignupCard, SIGNUP_LOOK, "img/icons/tab-signups.png"], [renderBoardCard, styleBoardCard, BOARD_LOOK, "img/icons/tab-five.png"]]) {
      const today = render(s);
      const styled = render(s, { style: true });
      const t = today.embeds[0];
      const e = styled.embeds[0];
      const at = `${render.name} #${i}`;
      const base = s.siteBase === BASE ? BASE : "";
      const stamp = embedTimestamp(s.updated);
      // At these sizes nobody is left over, so the footer is the fixed text; with people left over it may only add " · +N more on the board"
      const footer = e.footer && new RegExp(`^${look.footer} · \\+\\d+ more on the board$`).test(e.footer.text) ? e.footer.text : look.footer;
      const want = { ...t, author: { name: look.author, ...(base ? { icon_url: `${base}/${icon}` } : {}) }, title: look.title, color: REPLY_COLORS.party, footer: { text: footer } };
      if (s.boardUrl === `${BASE}/#signups`) want.url = s.boardUrl;
      if (stamp) want.timestamp = stamp;
      assert.deepEqual(e, want, at);
      assert.deepEqual(style(today, s), styled, `${at}: the renderer's style option is exactly the styler applied to today's body`);
      if (!json(today).includes(CANARY)) assert.ok(!json(styled).includes(CANARY), `${at}: the style printed text today's card does not`);
      for (const part of [e.title, e.author.name, e.footer.text]) assert.ok(!part.includes(CANARY), `${at}: ${json(part)}`);
    }
  }
});

test("null and non-object rows, documents and bodies never throw; a body the style cannot read comes back unchanged", () => {
  const junk = [null, undefined, 5, "x", true, [], [1]];
  for (const s of [...junk, ...junk.map((r) => ({ entries: [r, ...junk] })), ...junk.map((c) => ({ entries: c, options: c, members: c }))]) {
    for (const render of [renderSignupCard, renderBoardCard]) assertBodyValid(render(s, { style: true }), `${render.name} ${json(s)}`);
  }
  const warn = console.warn;
  console.warn = () => {};
  try {
    for (const body of [...junk, { embeds: [] }, { embeds: [null] }, { embeds: "x" }]) {
      assert.equal(styleSignupCard(body, STATE), body);
      assert.equal(styleBoardCard(body, STATE), body);
    }
    for (const rows of [null, 5, "x", [null]]) assert.equal(styleAnswerButtons(rows), rows);
  } finally {
    console.warn = warn;
  }
});

// ---- /ask ----
test("answer buttons, styled: the first detail button is the one blurple next step; rows, labels and custom ids are today's", async () => {
  const today = await answerRows(undefined);
  const styled = await answerRows("on");
  assert.deepEqual(styled.map((r) => r.components.map((c) => [c.label, c.custom_id])), today.map((r) => r.components.map((c) => [c.label, c.custom_id])));
  assert.deepEqual(styled.map((r) => r.components.map((c) => c.style)), [[1, 2], [2, 2]]);
  assert.deepEqual((await answerRows("on", false, true)).map((r) => r.components.map((c) => c.style)), [[1], [2, 2]], "Sources is the next step when there is no More");
  assert.deepEqual((await answerRows("on", false, false)).map((r) => r.components.map((c) => c.style)), [[2, 2]], "feedback alone stays grey");
  assertComponentsValid(styled, "answer buttons");
});

// ---- /page, /tooltip, /map ----
const ROW = { id: "dungeons/fixture-keep", category: "dungeons", title: "Fixture Keep", blurb: "A fictional dungeon for tests." };
const FACTS = [{ key: "Levels", value: "13 to 18" }, { key: "Where", value: "A fictional canyon, far from anywhere" }];

test("/page card: the rules, today's link, and at most 5 facts", () => {
  const body = pageCard({ row: ROW, facts: FACTS, boardUrl: BASE, now: NOW });
  const e = body.embeds[0];
  assert.deepEqual(e.author, { name: "Library · Dungeons", icon_url: `${BASE}/img/icons/tab-library.png` });
  assert.equal(e.title, "Fixture Keep");
  assert.equal(e.url, `${BASE}/#lib.dungeons/fixture-keep`);
  assert.equal(e.description, ROW.blurb);
  assert.equal(e.color, 0xffd100);
  assert.deepEqual(e.fields, [{ name: "Levels", value: "13 to 18", inline: true }, { name: "Where", value: FACTS[1].value, inline: false }]);
  assert.deepEqual(e.footer, { text: "Verified library" });
  assert.equal(e.thumbnail, undefined, "a command reply has no thumbnail");
  assert.deepEqual(body.components, [{ type: 1, components: [{ type: 2, style: 5, label: "Open on the board", url: `${BASE}/#lib.dungeons/fixture-keep` }] }]);
  assertBodyValid(body, "page");
  const many = pageCard({ row: ROW, facts: Array.from({ length: 9 }, (_, i) => ({ key: `Fact ${i}`, value: `${i}` })), boardUrl: BASE });
  assert.equal(many.embeds[0].fields.length, 5);
  assert.equal(pageCard({ row: { ...ROW, blurb: "" }, facts: [], boardUrl: BASE }).embeds[0].description, "Open the page for every verified fact.");
});

test("/tooltip and /map cards: the rules and today's links", () => {
  const tip = tooltipCard({ name: "Fixture Bolt", row: { id: "classes/fixture-spells", category: "classes", title: "Fixture spells" }, verified: true, boardUrl: BASE, now: NOW });
  assert.equal(tip.embeds[0].title, "Fixture Bolt");
  assert.equal(tip.embeds[0].author.name, "Library · Tooltip");
  assert.equal(tip.embeds[0].description, "Verified in **Fixture spells** (Classes).");
  assert.equal(tip.embeds[0].url, `${BASE}/#lib.classes/fixture-spells`);
  assertBodyValid(tip, "tooltip");
  assert.equal(tooltipCard({ name: "x", row: { id: "a/b", category: "", title: "**Star** page" }, verified: "yes", boardUrl: BASE }).embeds[0].description, "Mentioned on **Star page**.");
  const cases = [
    [{ plan: { value: "valley-of-strength", name: "Valley of Strength" } }, "Route plan: Valley of Strength", "#atlas.plan.valley-of-strength"],
    [{ place: "red-cloud-mesa" }, "Red Cloud Mesa", "#atlas.red-cloud-mesa"],
    [{ place: "some_far-place" }, "Some Far Place", "#atlas.some_far-place"],
    [{}, "Azeroth Atlas", "#atlas"],
    [{ place: "Bad Place!", plan: { value: "x y" } }, "Azeroth Atlas", "#atlas"],
  ];
  for (const [input, title, hash] of cases) {
    const m = mapCard({ ...input, boardUrl: BASE, now: NOW });
    assert.equal(m.embeds[0].title, title, json(input));
    assert.equal(m.embeds[0].url, `${BASE}/${hash}`, json(input));
    assert.equal(m.embeds[0].color, 0xb5471f);
    assert.deepEqual(m.components[0].components[0], { type: 2, style: 5, label: "Open in the Atlas", url: `${BASE}/${hash}` });
    assertBodyValid(m, `map ${json(input)}`);
  }
});

test("builders: hostile text stays on one line with no control or direction characters; a bad id or board URL gives no link, never a broken one", () => {
  for (const h of HOSTILE) {
    const bodies = [
      pageCard({ row: { id: "a/b", category: h, title: h, blurb: h }, facts: [{ key: h, value: h }], boardUrl: BASE }),
      tooltipCard({ name: h, row: { id: "a/b", category: h, title: h }, boardUrl: BASE }),
      mapCard({ plan: { value: "valley-of-strength", name: h }, boardUrl: BASE }),
    ];
    for (const b of bodies) {
      assertBodyValid(b, json(h));
      const e = b.embeds[0];
      for (const t of [e.title, e.author.name, e.footer.text, ...(e.fields || []).map((f) => f.name)]) {
        assert.ok(!/[\n\r\t]/.test(t) && !INVISIBLE_RE.test(t), `${json(h)}: ${json(t)}`);
      }
    }
  }
  for (const id of ["a b", "javascript:alert(1)", "<@123456789012345678>", "a\nb", "", null, 5, "x".repeat(200)]) {
    const b = pageCard({ row: { ...ROW, id }, facts: FACTS, boardUrl: BASE });
    assert.equal(b.embeds[0].url, undefined, json(id));
    assert.deepEqual(b.components, [], json(id));
  }
  for (const base of ["http://board.test", "javascript:alert(1)", "https://user:pw@board.test", "https://board.test?x=1", "https://board.test#x", "", null, "board.test"]) {
    for (const b of [pageCard({ row: ROW, facts: FACTS, boardUrl: base }), mapCard({ place: "brill", boardUrl: base })]) {
      assert.equal(b.embeds[0].url, undefined, json(base));
      assert.equal(b.embeds[0].author.icon_url, undefined, json(base));
      assert.deepEqual(b.components, [], json(base));
      assertBodyValid(b, json(base));
    }
  }
  for (const input of [undefined, {}, { row: null, facts: "x" }, { row: 5, facts: [null, 5, "x", [], { key: "" }, { key: "constructor", value: {} }] }]) {
    assertBodyValid(pageCard(input), json(input));
    assertBodyValid(tooltipCard(input), json(input));
    assertBodyValid(mapCard(input), json(input));
  }
  assert.equal(boardBase("https://board.test/"), BASE);
});

// Rule 8: every fact, link and number of today's reply survives. Today's reply comes from the real handler, driven as tests/unit/discord-components.test.mjs does.
test("builders keep every fact, link and number of today's /page, /tooltip and /map replies", async () => {
  const signer = createDiscordSigner();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ id: "1" }), { status: 200, headers: { "Content-Type": "application/json" } });
  try {
    const pageRow = { ...ROW, facts_json: JSON.stringify(FACTS), aliases_json: "[]" };
    let n = 0;
    const call = async (name, options) => {
      invalidateConfigCache();
      const DB = fakeD1({ discord_members: [], signups: { options: { meet: ["Valley of Strength", "The Crossroads"] }, entries: [] } }, { lenient: true });
      if (!DB.batch) DB.batch = async (s) => s.map(() => ({ success: true, results: [], meta: { changes: 1 } }));
      const prepare = DB.prepare.bind(DB);
      DB.prepare = (sql) => {
        const o = prepare(sql);
        if (!/FROM lib_pages/.test(sql)) return o;
        return { ...o, bind: (...a) => ({ ...o.bind(...a), first: async () => pageRow }) };
      };
      const interaction = { type: 2, id: String(300000000000000000n + BigInt(++n) * 7n), application_id: "400000000000000004", token: "t", channel_id: CH, member: { user: { id: "1".repeat(18), username: "fixture" } }, data: { name, options: options.map(([k, v]) => ({ name: k, type: 3, value: v })) } };
      const res = await handleDiscordInteraction(signer.signedRequest(interaction), { DB, DISCORD_PUBLIC_KEY: signer.publicKeyHex, BOARD_PUBLIC_URL: BASE }, { waitUntil() {} }, "https://worker.test");
      return (await res.json()).data;
    };
    const page = await call("page", [["title", "Fixture Keep"]]);
    const styledPage = pageCard({ row: pageRow, facts: FACTS, boardUrl: BASE });
    assert.equal(styledPage.embeds[0].url, page.embeds[0].url);
    assert.equal(styledPage.embeds[0].title, page.embeds[0].title);
    for (const f of FACTS) assert.ok(page.embeds[0].description.includes(`**${f.key}:** ${f.value}`) && styledPage.embeds[0].fields.some((x) => x.name === f.key && x.value === f.value), f.key);
    assert.ok(page.embeds[0].description.includes(ROW.category) && styledPage.embeds[0].author.name.toLowerCase().includes(ROW.category), "the category");
    assert.equal(styledPage.components[0].components[0].url, page.components[0].components[0].url);

    const tip = await call("tooltip", [["name", "Fixture"]]);
    const styledTip = tooltipCard({ name: "Fixture", row: pageRow, verified: /^Verified in/.test(tip.embeds[0].description), boardUrl: BASE });
    assert.equal(styledTip.embeds[0].url, tip.embeds[0].url);
    assert.match(tip.embeds[0].description, /^Verified in \*\*Fixture Keep\*\*/);
    assert.match(styledTip.embeds[0].description, /^Verified in \*\*Fixture Keep\*\* \(Dungeons\)\.$/);

    for (const [opts, plan] of [[[["place", "razor-hill"]], null], [[["plan", "vos"]], { value: "valley-of-strength", name: "Valley of Strength" }], [[], null]]) {
      const m = await call("map", opts);
      const place = opts.length && opts[0][0] === "place" ? opts[0][1] : "";
      const styled = mapCard({ place, plan, boardUrl: BASE });
      assert.equal(styled.embeds[0].url, m.components[0].components[0].url, json(opts));
      assert.ok(m.content.includes(styled.embeds[0].url), json(opts));
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---- the finishers ----
test("finishEmbed: Discord's limits, whole characters, one picture, https only, unknown keys kept", () => {
  const smile = cp(0x1f600);
  assert.ok(clip(`${"a".repeat(254)}${smile}b`, 256).isWellFormed());
  assert.equal(clip(`${"a".repeat(300)}`, 256).length, 256);
  assert.equal(clip(`a${String.fromCharCode(0xd83d)}b`, 10), `a${cp(0xfffd)}b`);
  const e = finishEmbed({
    title: "t".repeat(300), description: "d".repeat(5000), author: { name: "a".repeat(300), icon_url: "http://board.test/i.png" },
    footer: { text: `f${RLO}${ZWSP}`.repeat(10) }, url: "http://board.test", color: 0x1000000, thumbnail: { url: `${BASE}/t.png` }, image: IMAGE, video: { url: "x" },
    fields: [...Array.from({ length: 30 }, (_, i) => ({ name: i ? `n${i}` : "", value: i === 1 ? "" : "v".repeat(1100) })), { name: BLANK, value: "x" }, null, 5],
    timestamp: "2026-11-21T20:15:00Z",
  }, { now: NOW });
  assertEmbedValid(e, "finishEmbed");
  assert.equal(e.image, IMAGE, "the image is the caller's object, untouched");
  assert.deepEqual(e.video, { url: "x" }, "an unknown key is kept");
  assert.equal(e.thumbnail, undefined);
  assert.equal(e.url, undefined);
  assert.equal(e.color, undefined);
  assert.equal(e.author, undefined, "over 6000, the author line gives way before any fact is cut");
  assert.deepEqual(finishEmbed({ author: { name: "Shelf", icon_url: "http://board.test/i.png" } }).author, { name: "Shelf" }, "an http icon is left off");
  assert.equal(e.fields.length, 25);
  assert.equal(e.fields[0].name, BLANK, "an empty name is Discord's blank name");
  assert.equal(e.fields[1].value, "—", "an empty value is a dash");
  assert.ok(!INVISIBLE_RE.test(e.footer.text));
  assert.equal(e.timestamp, "2026-11-21T20:15:00.000Z");
  assert.deepEqual(finishEmbed({ fields: [{ name: BLANK, value: "x" }] }).fields, [{ name: BLANK, value: "x", inline: false }], "the blank continuation name survives");
  assert.deepEqual(finishEmbed({ title: "  ", description: "\n\n", footer: { text: "" }, author: { name: ZWSP } }), {}, "empty parts are left out, never sent empty");
  // Text the style did not write is never changed: an inert zero-width break or a line separator stays exactly where it was (no live invite, no new number)
  const inert = `disc${ZWSP}ord.gg/fict and 6${LSEP}8pm`;
  const kept = finishEmbed({ description: inert, fields: [{ name: "n", value: inert }] });
  assert.equal(kept.description, inert);
  assert.equal(kept.fields[0].value, inert);
  // In a one-line slot the same characters become spaces, never nothing
  assert.equal(finishEmbed({ title: `60${ZWSP}30 gold` }).title, "60 30 gold");
  // Decoration gives way in the order asked, before a fact is cut
  const tightInput = { author: { name: "a".repeat(40) }, footer: { text: "f".repeat(40) }, title: "t".repeat(256), description: "d".repeat(4096), fields: [{ name: "n", value: "v".repeat(1000) }, { name: "m", value: "w".repeat(600) }] };
  assert.equal(embedChars(tightInput), 6034);
  const tight = finishEmbed(tightInput, { yields: ["author", "footer"] });
  assert.equal(tight.author, undefined, "the author line went first");
  assert.deepEqual(tight.footer, { text: "f".repeat(40) }, "and that was enough: the footer stays");
  assert.deepEqual(tight.fields.map((f) => f.value.length), [1000, 600], "no fact was cut");
  assert.equal(embedChars(tight), 5994);
});

test("finishComponents: only shapes Discord accepts, link buttons last, at most 5 by 5, unknown keys kept", () => {
  const rows = finishComponents([
    { type: 1, components: [{ type: 2, style: 5, label: "Link", url: `${BASE}/x` }, { type: 2, style: 1, label: "A", custom_id: "a", emoji: { name: "x" } }, { type: 2, style: 9, label: "B", custom_id: "b" }, { type: 2, style: 2, label: "dup", custom_id: "a" }, { type: 2, style: 5, label: "Insecure", url: "http://board.test" }, { type: 2, style: 2, label: "", custom_id: "c" }, { type: 2, style: 2, label: "long", custom_id: "x".repeat(101) }, null] },
    { type: 1, components: Array.from({ length: 7 }, (_, i) => ({ type: 2, style: 2, label: `n${i}`, custom_id: `n${i}` })) },
    ...Array.from({ length: 5 }, (_, i) => ({ type: 1, components: [{ type: 2, style: 2, label: `r${i}`, custom_id: `r${i}` }] })),
    { type: 4, components: [] }, null,
  ]);
  assertComponentsValid(rows, "finishComponents");
  assert.deepEqual(rows[0].components.map((c) => c.label), ["A", "B", "Link"]);
  assert.deepEqual(rows[0].components[0].emoji, { name: "x" });
  assert.equal(rows[0].components[1].style, 2);
  assert.deepEqual(rows[1].components.map((c) => c.label), ["n0", "n1", "n2", "n3", "n4"]);
  assert.deepEqual(rows[2].components.map((c) => c.label), ["n5", "n6"]);
  assert.equal(rows.length, 5);
  // a link button never keeps a custom_id (Discord refuses the pair); a label is cut, never otherwise changed; a blank label is left out
  const [linkRow] = finishComponents([{ type: 1, components: [{ type: 2, style: 5, label: "Go", url: `${BASE}/x`, custom_id: "stray" }, { type: 2, style: 2, label: "   ", custom_id: "blank" }, { type: 2, style: 2, label: `Meet ${ZWSP}here`, custom_id: "m" }] }]);
  assert.deepEqual(linkRow.components, [{ type: 2, style: 2, label: `Meet ${ZWSP}here`, custom_id: "m" }, { type: 2, style: 5, label: "Go", url: `${BASE}/x` }]);
  // a row that holds a select menu is passed through as it is
  const select = { type: 1, components: [{ type: 3, custom_id: "pick", options: [{ label: "A", value: "a" }] }] };
  assert.deepEqual(finishComponents([select]), [select]);
});

// ---- where the flag is read, and the docs ----
function sourceFiles(dir) {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sourceFiles(`${dir}/${e.name}`) : /\.m?js$/.test(e.name) ? [`${dir}/${e.name}`] : []));
}
const code = (src) => src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).map((l) => l.replace(/\s\/\/.*$/, ""));

test("static proof: the flag is named once (reply-style.js, read through legacyOn), the gate is called only by the card executors and the answer buttons, and wrangler.toml declares it only as on or off", () => {
  const found = {};
  const calls = {};
  for (const f of [...sourceFiles("infrastructure/worker"), ...sourceFiles("pages-worker")]) {
    const lines = code(read(f));
    const n = lines.filter((l) => /\bREPLY_STYLE\b/.test(l)).length;
    if (n) found[f] = n;
    const c = lines.filter((l) => /\breplyStyleOn\(/.test(l)).length; // every call, whatever its argument is named
    for (const l of lines) if (/\breplyStyleOn\(/.test(l)) assert.match(l, /\breplyStyleOn\(env\)/, `${f}: the gate reads the Worker's env: ${l.trim()}`);
    if (c) calls[f] = c;
    for (const l of lines) assert.ok(!/\bREPLY_STYLE\b[^;?]*!==?\s*["']off["']/.test(l), `${f}: ${l.trim()}`);
  }
  assert.deepEqual(found, { "infrastructure/worker/reply-style.js": 1 });
  const src = read("infrastructure/worker/reply-style.js");
  assert.match(src, /^export const REPLY_STYLE_FLAG = "REPLY_STYLE";$/m);
  assert.match(src, /^export const replyStyleOn = \(env\) => legacyOn\(env, REPLY_STYLE_FLAG\);$/m);
  assert.equal((src.match(/\bREPLY_STYLE_FLAG\b/g) || []).length, 2, "the constant is defined once and used once, by the gate");
  assert.deepEqual(calls, { "infrastructure/worker/cards.js": 2, "infrastructure/worker/answer-ux.js": 1 });
  // Who may use the module, by exact name and with no alias, and every styler call sits on a line gated by the flag's value.
  const importers = {};
  const uses = {};
  const UNWIRED = /\b(pageCard|tooltipCard|mapCard|finishEmbed|finishComponents)\b/;
  for (const f of [...sourceFiles("infrastructure/worker"), ...sourceFiles("pages-worker")]) {
    if (f.endsWith("/reply-style.js")) continue;
    const src = read(f);
    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']\.\/reply-style\.js["']/g)) importers[f] = m[1].split(",").map((x) => x.trim()).filter(Boolean).sort();
    assert.ok(!/reply-style(\.js)?["']\s*\)/.test(src) && !/import\s*\*\s*as\s+\w+\s+from\s*["']\.\/reply-style/.test(src), `${f}: no dynamic or namespace import of reply-style.js`);
    for (const l of code(src)) {
      if (/\bstyle(SignupCard|BoardCard)\(/.test(l)) (uses[f] ||= []).push(l.includes("opts && opts.style === true ?") ? "gated" : `UNGATED: ${l.trim()}`);
      if (/\bstyleAnswerButtons\(/.test(l)) (uses[f] ||= []).push(l.includes("replyStyleOn(env) ?") ? "gated" : `UNGATED: ${l.trim()}`);
      assert.ok(!UNWIRED.test(l), `${f}: ${l.trim()} (the builders and finishers are not wired outside reply-style.js yet; wiring them is its own change)`);
    }
  }
  assert.deepEqual(importers, {
    "infrastructure/worker/answer-ux.js": ["replyStyleOn", "styleAnswerButtons"],
    "infrastructure/worker/cards.js": ["BOARD_STYLE_RESERVE", "replyStyleOn", "styleBoardCard", "styleSignupCard"],
  });
  assert.deepEqual(uses, { "infrastructure/worker/cards.js": ["gated", "gated"], "infrastructure/worker/answer-ux.js": ["gated"] });
  const toml = read("infrastructure/wrangler.toml");
  const m = toml.slice(toml.indexOf("[vars]")).match(/^REPLY_STYLE\s*=\s*"([^"]*)"/m);
  if (m) assert.ok(["on", "off"].includes(m[1]), `REPLY_STYLE declared as ${m[1]}`);
  // Turning it on is one [vars] line: nothing may list it as "never declared" (wrangler-flags.test.mjs refuses a name that is both).
  assert.ok(!/"REPLY_STYLE"/.test(read("tests/unit/wrangler-flags.test.mjs")), "not in wrangler-flags.test.mjs DOCUMENTED, so adding the line needs no other edit");
});

test("docs: the style doc carries the palette the code uses, the flag and every builder; the cards runbook names the flag", () => {
  const doc = read("docs/discord-reply-style.md");
  const hexes = [...doc.matchAll(/`#([0-9A-F]{6})`/g)].map((x) => parseInt(x[1], 16));
  assert.deepEqual([...new Set(hexes)].sort(), Object.values(REPLY_COLORS).sort());
  for (const k of ["REPLY_STYLE", "pageCard", "tooltipCard", "mapCard", "styleSignupCard", "styleBoardCard", "styleAnswerButtons", "tests/local/reply-style-preview.mjs"]) assert.ok(doc.includes(k), k);
  assert.ok(read("docs/runbooks/cards.md").includes("`REPLY_STYLE`"));
});
