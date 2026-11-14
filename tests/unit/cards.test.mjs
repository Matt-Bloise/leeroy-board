// Cards: rendering goldens, coalescing, write-in sanitising, state transitions, the edit executor (including a deleted message). No network, no AI.
import test from "node:test";
import assert from "node:assert/strict";
import {
  renderSignupCard, renderBoardCard, planCardEdit, sanitiseWriteIn, cleanName, resolveChoice, applySignupChange, confirmationLine, CONFIRM_LINES,
  validateCardsConfig, channelAllowed, requestCardEdit, postCard, cardsEnabled, cardsShadow, boardLinesEnabled, describeChange,
} from "../../infrastructure/worker/cards.js";
import { fakeD1, fakeFetch } from "./fake-d1.mjs";

const CH = "100000000000000001", MSG = "200000000000000002", CH2 = "100000000000000009";
const STATE = {
  updated: "2026-11-02T20:15:00.000Z",
  options: { meet: ["Valley of Strength", "The Crossroads"], when: ["6pm", "8pm", "later"] },
  entries: [
    { name: "Ada", rsvp: "in", pack: "yes", meet: "Valley of Strength", when: "6pm" },
    { name: "Bo", rsvp: "maybe", pack: "no", meet: "The Crossroads", when: "8pm" },
    { name: "Cy", rsvp: "late", meet: "Behind the inn", when: "later" },
    { name: "Di", rsvp: "out" },
  ],
};

test("flags: off unless on, 1, true or yes", () => {
  assert.equal(cardsEnabled({}), false);
  assert.equal(cardsEnabled({ CARDS_ENABLED: "off" }), false);
  assert.equal(cardsEnabled({ CARDS_ENABLED: "on" }), true);
  assert.equal(cardsShadow({ CARDS_SHADOW: "1" }), true);
  assert.equal(boardLinesEnabled({ CARDS_ENABLED: "on" }), false);
});

test("signup card golden: embed fields and three button rows", () => {
  const card = renderSignupCard(STATE);
  assert.deepEqual(card.allowed_mentions, { parse: [] });
  const e = card.embeds[0];
  assert.equal(e.title, "Launch-night sign-ups");
  assert.deepEqual(e.fields.map((f) => [f.name, f.value]), [
    ["In (1)", "Ada"],
    ["Tentative (1)", "Bo"],
    ["Running late (1)", "Cy"],
    ["Out (1)", "Di"],
    ["Pre-order pack", "Yes 1 · No 1"],
    ["Meeting point", "Valley of Strength: Ada\nThe Crossroads: Bo\nElsewhere: Behind the inn: Cy"],
    ["Arriving", "6pm: Ada\n8pm: Bo\nlater: Cy"],
  ]);
  assert.equal(e.footer.text, "Updated 2026-11-02 20:15 UTC");
  assert.deepEqual(card.components.map((r) => r.components.map((c) => c.custom_id)), [
    ["signup:rsvp:in", "signup:rsvp:maybe", "signup:rsvp:late", "signup:rsvp:out"],
    ["signup:pack:yes", "signup:pack:no", "signup:meet:vos", "signup:meet:xroads", "signup:meet:other"],
    ["signup:when:6pm", "signup:when:8pm", "signup:when:later"],
  ]);
  assert.deepEqual(card.components[0].components.map((c) => c.label), ["I'm in", "Tentative", "Running late", "Out"]);
});

test("signup card: empty state still renders In (0) and stays inside Discord limits", () => {
  const card = renderSignupCard({ entries: [] });
  assert.deepEqual(card.embeds[0].fields, [{ name: "In (0)", value: "—", inline: false }]);
  assert.equal(card.embeds[0].footer, undefined);
  const many = { entries: Array.from({ length: 80 }, (_, i) => ({ name: `Player number ${i}`, rsvp: "in" })) };
  const big = renderSignupCard(many);
  for (const f of big.embeds[0].fields) assert.ok(f.value.length <= 1024 && f.name.length <= 256);
  for (const row of big.components) assert.ok(row.components.length <= 5);
  assert.ok(big.components.length <= 5);
});

test("signup card: names cannot ping or inject markdown links", () => {
  const card = renderSignupCard({ entries: [{ name: "<@123456789012345678> @everyone [x](http://e.test)", rsvp: "in" }] });
  const v = card.embeds[0].fields[0].value;
  assert.ok(!/[<>@\[\]()]/.test(v), v);
});

test("board card golden", () => {
  const c = renderBoardCard({ ...STATE, boardUrl: "https://leeroy.test/#signups" });
  assert.equal(c.embeds[0].description, "1 in · 1 tentative · 1 running late · 1 out");
  assert.equal(c.embeds[0].fields[0].value.split("\n")[0], "**Ada**: In · 6pm · Valley of Strength · pack yes");
  assert.equal(c.components[0].components[0].url, "https://leeroy.test/#signups");
  assert.deepEqual(renderBoardCard({ entries: [], boardUrl: "http://insecure.test" }).components, []);
});

test("planCardEdit: coalescing cases", () => {
  assert.deepEqual(planCardEdit({ lastEditAt: 1000, pendingSince: null, now: 1500 }), { action: "none" });
  assert.deepEqual(planCardEdit({ lastEditAt: null, pendingSince: 10, now: 10 }), { action: "edit", waitMs: 0 });
  assert.deepEqual(planCardEdit({ lastEditAt: 1000, pendingSince: 1200, now: 1200 }), { action: "wait", waitMs: 2800 });
  assert.deepEqual(planCardEdit({ lastEditAt: 1000, pendingSince: 1200, now: 3999 }), { action: "wait", waitMs: 1 });
  assert.deepEqual(planCardEdit({ lastEditAt: 1000, pendingSince: 1200, now: 4000 }), { action: "edit", waitMs: 0 });
  assert.deepEqual(planCardEdit({ lastEditAt: 5000, pendingSince: 5001, now: 4000 }), { action: "wait", waitMs: 3000 }); // clock stepped back
  assert.deepEqual(planCardEdit({ lastEditAt: "x", pendingSince: 1, now: 2 }), { action: "edit", waitMs: 0 });
  assert.deepEqual(planCardEdit(), { action: "none" });
});

test("write-in: 40 characters, control chars, mentions, markdown and links removed", () => {
  assert.equal(sanitiseWriteIn("  Orgrimmar   bank\n\ttower "), "Orgrimmar bank tower");
  assert.equal(sanitiseWriteIn("<@123456789012345678> hi <#99999> there"), "hi there");
  assert.equal(sanitiseWriteIn("@everyone **bold** `code` _x_ ~y~ ||spoiler||"), "everyone bold code x y spoiler");
  assert.equal(sanitiseWriteIn("meet http://evil.test/a now"), "meet now");
  assert.equal(sanitiseWriteIn("ＡＢ＠ｃ"), "ABc"); // fullwidth @ folds to @ and is removed
  assert.equal(sanitiseWriteIn("a​b\u0007c"), "a b c");
  assert.equal(sanitiseWriteIn("x".repeat(100)).length, 40);
  assert.equal([...sanitiseWriteIn("😀".repeat(60))].length, 40);
  assert.equal(sanitiseWriteIn("   "), "");
  assert.equal(sanitiseWriteIn(null), "");
  assert.equal(cleanName(""), "Someone");
  assert.equal(cleanName("n".repeat(50)).length, 24);
});

test("resolveChoice: only allowed values pass", () => {
  const o = STATE.options;
  assert.equal(resolveChoice("rsvp", "late", o), "late");
  assert.equal(resolveChoice("rsvp", "maybe-ish", o), null);
  assert.equal(resolveChoice("pack", "yes", o), "yes");
  assert.equal(resolveChoice("pack", "y", o), null);
  assert.equal(resolveChoice("meet", "vos", o), "Valley of Strength");
  assert.equal(resolveChoice("meet", "m1", { meet: ["A", "B"] }), "B");
  assert.equal(resolveChoice("meet", "m9", { meet: ["A", "B"] }), null);
  assert.equal(resolveChoice("when", "8pm", o), "8pm");
  assert.equal(resolveChoice("when", "9pm", o), null);
  for (const f of ["name", "slug", "updated", "__proto__"]) assert.equal(resolveChoice(f, "x", o), null);
});

test("state transitions: new entry, change, same value, unknown field, copy not mutation", () => {
  const doc = { entries: [{ name: "Ada", rsvp: "in" }] };
  const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);
  const t1 = applySignupChange(doc, { name: "Ada", field: "rsvp", value: "maybe", now: NOW });
  assert.deepEqual([t1.ok, t1.changed, t1.before, t1.after], [true, true, "in", "maybe"]);
  assert.equal(doc.entries[0].rsvp, "in");
  assert.equal(t1.doc.entries[0].updated, "2026-11-03T12:00:00.000Z");
  const t2 = applySignupChange(t1.doc, { name: "ada", field: "rsvp", value: "maybe", now: NOW + 1 });
  assert.deepEqual([t2.ok, t2.changed, t2.doc.entries.length], [true, false, 1]);
  const t3 = applySignupChange(doc, { name: "Bo", slug: "bo", field: "rsvp", value: "late", now: NOW });
  assert.deepEqual([t3.doc.entries.length, t3.before, t3.doc.entries[1].slug], [2, null, "bo"]);
  for (const bad of ["name", "slug", "tallies"]) assert.equal(applySignupChange(doc, { name: "Ada", field: bad, value: "x", now: NOW }).ok, false);
  assert.equal(applySignupChange(doc, { name: "Ada", field: "rsvp", value: "", now: NOW }).ok, false);
});

test("six rotating confirmation lines, each carrying the change", () => {
  assert.equal(CONFIRM_LINES.length, 6);
  const seen = new Set(Array.from({ length: 6 }, (_, i) => confirmationLine(i, "you're in")));
  assert.equal(seen.size, 6);
  for (const l of seen) assert.ok(l.includes("you're in"));
  assert.equal(confirmationLine(6, "x"), confirmationLine(0, "x"));
  assert.equal(confirmationLine(-1, "x"), confirmationLine(1, "x"));
  assert.equal(describeChange("rsvp", "late"), "you're running late");
  assert.equal(describeChange("meet", "The Crossroads"), "meeting at The Crossroads");
});

test("cards config: shape and allowed channels", () => {
  assert.equal(validateCardsConfig({ signups: { channel: CH, message: MSG }, allowedChannels: [CH2] }), null);
  for (const bad of [[], { signups: { channel: "x", message: MSG } }, { other: {} }, { allowedChannels: "x" }, { signups: { channel: CH, message: MSG, deleted: "yes" } }]) {
    assert.ok(validateCardsConfig(bad), JSON.stringify(bad));
  }
  const cards = { signups: { channel: CH, message: MSG }, allowedChannels: [CH2] };
  assert.equal(channelAllowed(cards, CH), true);
  assert.equal(channelAllowed(cards, CH2), true);
  assert.equal(channelAllowed(cards, "300000000000000003"), false);
  assert.equal(channelAllowed(cards, undefined), false);
  assert.equal(channelAllowed(null, "anything"), true); // not configured: no restriction
});

// ---- executor ----
function setup({ cards = { signups: { channel: CH, message: MSG } }, env = {}, edit } = {}) {
  const seed = { signups: STATE };
  if (cards) seed.cards = cards;
  if (edit) seed.cards_edit = edit;
  const DB = fakeD1(seed);
  let t = 1_000_000;
  const clock = () => t;
  const slept = [];
  const sleep = async (ms) => { slept.push(ms); t += ms; };
  return { DB, env: { CARDS_ENABLED: "on", DISCORD_BOT_TOKEN: "test-token", DB, ...env }, clock, sleep, slept, tick: (ms) => { t += ms; } };
}

test("edit: with no card recorded nothing is sent and nothing is marked", async () => {
  const s = setup({ cards: null });
  const f = fakeFetch(() => ({ status: 200 }));
  assert.deepEqual(await requestCardEdit(s.env, { clock: s.clock, sleep: s.sleep, fetchImpl: f }), { status: "no_card" });
  assert.equal(f.calls.length, 0);
  assert.equal(s.DB.kv.has("cards_edit"), false);
});

test("edit: flag off or no bot token does nothing", async () => {
  const f = fakeFetch(() => ({ status: 200 }));
  const s = setup({ env: { CARDS_ENABLED: "off" } });
  assert.equal((await requestCardEdit(s.env, { clock: s.clock, fetchImpl: f })).status, "off");
  const s2 = setup({ env: { DISCORD_BOT_TOKEN: "" } });
  assert.equal((await requestCardEdit(s2.env, { clock: s2.clock, fetchImpl: f })).status, "unconfigured");
  assert.equal(f.calls.length, 0);
});

test("edit: PATCHes the stored message with the rendered card, bot auth, no mentions", async () => {
  const s = setup();
  const f = fakeFetch(() => ({ status: 200 }));
  const r = await requestCardEdit(s.env, { clock: s.clock, sleep: s.sleep, fetchImpl: f });
  assert.equal(r.status, "edited");
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].method, "PATCH");
  assert.equal(f.calls[0].path, `/channels/${CH}/messages/${MSG}`);
  assert.equal(f.calls[0].auth, "Bot test-token");
  assert.deepEqual(f.calls[0].body.allowed_mentions, { parse: [] });
  assert.equal(f.calls[0].body.embeds[0].title, "Launch-night sign-ups");
  assert.deepEqual(s.slept, []);
});

test("edit: a burst within 3 s becomes one edit; the next burst 3 s later is another", async () => {
  const s = setup();
  const f = fakeFetch(() => ({ status: 200 }));
  const opts = { clock: s.clock, sleep: s.sleep, fetchImpl: f };
  assert.equal((await requestCardEdit(s.env, opts)).status, "edited");
  s.tick(500);
  const second = requestCardEdit(s.env, opts); // waits 2500 ms
  assert.equal((await second).status, "edited");
  assert.deepEqual(s.slept, [2500]);
  assert.equal(f.calls.length, 2);
  // two requests arrive while one is waiting: only one more edit happens
  s.tick(100);
  const [a, b] = await Promise.all([requestCardEdit(s.env, opts), requestCardEdit(s.env, opts)]);
  assert.deepEqual([a.status, b.status].sort(), ["coalesced", "edited"]);
  assert.equal(f.calls.length, 3);
  s.tick(3000);
  assert.equal((await requestCardEdit(s.env, opts)).status, "edited");
  assert.equal(f.calls.length, 4);
});

test("edit: Discord failure keeps the mark so a later tick retries after the gap", async () => {
  const s = setup();
  let fail = true;
  const f = fakeFetch(() => ({ status: fail ? 500 : 200 }));
  const opts = { clock: s.clock, sleep: s.sleep, fetchImpl: f };
  const r = await requestCardEdit(s.env, opts);
  assert.equal(r.status, "failed");
  assert.ok(JSON.parse(s.DB.kv.get("cards_edit")).pendingSince);
  fail = false;
  s.tick(3000);
  assert.equal((await requestCardEdit(s.env, { ...opts, dirty: false })).status, "edited");
  assert.equal(JSON.parse(s.DB.kv.get("cards_edit")).pendingSince, null);
});

test("edit: a deleted message (404) is marked deleted, never edited again, never loops", async () => {
  const s = setup();
  const f = fakeFetch(() => ({ status: 404, json: { code: 10008 } }));
  const opts = { clock: s.clock, sleep: s.sleep, fetchImpl: f };
  const r = await requestCardEdit(s.env, opts);
  assert.equal(r.status, "edited");
  assert.deepEqual(r.results, [{ card: "signups", status: "deleted" }]);
  assert.equal(f.calls.length, 1);
  assert.equal(JSON.parse(s.DB.kv.get("cards")).signups.deleted, true);
  assert.equal(JSON.parse(s.DB.kv.get("cards")).signups.message, MSG); // the id stays for the record
  s.tick(10_000);
  assert.equal((await requestCardEdit(s.env, opts)).status, "no_card");
  assert.equal((await requestCardEdit(s.env, { ...opts, dirty: false })).status, "no_card");
  assert.equal(f.calls.length, 1, "no further Discord call for a deleted card");
});

test("edit: one deleted card does not stop the other card", async () => {
  const s = setup({ cards: { signups: { channel: CH, message: MSG }, board: { channel: CH, message: "200000000000000003" } } });
  const f = fakeFetch((m, p) => ({ status: p.endsWith(MSG) ? 404 : 200 }));
  const r = await requestCardEdit(s.env, { clock: s.clock, sleep: s.sleep, fetchImpl: f });
  assert.deepEqual(r.results.map((x) => x.status), ["deleted", "edited"]);
  s.tick(3000);
  await requestCardEdit(s.env, { clock: s.clock, sleep: s.sleep, fetchImpl: f });
  assert.deepEqual(f.calls.map((c) => c.path.split("/").pop()), [MSG, "200000000000000003", "200000000000000003"]);
});

test("shadow mode: records 'would edit' in the ledger and never calls Discord", async () => {
  const s = setup({ env: { CARDS_SHADOW: "1", DISCORD_BOT_TOKEN: "" } });
  const f = fakeFetch(() => ({ status: 200 }));
  const r = await requestCardEdit(s.env, { clock: s.clock, sleep: s.sleep, fetchImpl: f });
  assert.deepEqual(r.results, [{ card: "signups", status: "shadow" }]);
  assert.equal(f.calls.length, 0);
  assert.deepEqual([...s.DB.ledger.entries()].map(([k, n]) => [k.replace(/^\d{4}-\d{2}-\d{2}\|/, ""), n]), [[`shadow:edit:${CH}`, 1]]);
});

test("post: first post records the id and pins; no id is echoed; existing live card needs replace", async () => {
  const s = setup({ cards: null });
  const f = fakeFetch((m, p) => (m === "POST" && p === `/channels/${CH}/messages` ? { status: 200, json: { id: MSG } } : { status: 204 }));
  const r = await postCard(s.env, { card: "signups", channelId: CH, fetchImpl: f });
  assert.deepEqual(r, { ok: true, card: "signups", pinned: true });
  assert.deepEqual(JSON.parse(s.DB.kv.get("cards")), { signups: { channel: CH, message: MSG } });
  assert.deepEqual(f.calls.map((c) => `${c.method} ${c.path}`), [`POST /channels/${CH}/messages`, `PUT /channels/${CH}/messages/pins/${MSG}`]);
  const again = await postCard(s.env, { card: "signups", channelId: CH, fetchImpl: f });
  assert.deepEqual([again.ok, again.status], [false, 409]);
});

test("post: recreates a deleted card and records the new id; the old pin route is the fallback", async () => {
  const s = setup({ cards: { signups: { channel: CH, message: MSG, deleted: true }, allowedChannels: [CH2] } });
  const NEW = "200000000000000077";
  const f = fakeFetch((m, p) => (m === "POST" ? { status: 200, json: { id: NEW } } : p.includes("/messages/pins/") ? { status: 404 } : { status: 204 }));
  const r = await postCard(s.env, { card: "signups", channelId: CH, fetchImpl: f });
  assert.equal(r.ok, true);
  assert.equal(r.pinned, true);
  assert.deepEqual(JSON.parse(s.DB.kv.get("cards")), { signups: { channel: CH, message: NEW }, allowedChannels: [CH2] });
  // and edits resume on the new message
  s.tick(5000);
  const e = fakeFetch(() => ({ status: 200 }));
  await requestCardEdit(s.env, { clock: s.clock, sleep: s.sleep, fetchImpl: e });
  assert.equal(e.calls[0].path, `/channels/${CH}/messages/${NEW}`);
});

test("post: Discord refusing the post leaves the cards row alone; unknown card is refused; shadow does not call Discord", async () => {
  const s = setup({ cards: null });
  const f = fakeFetch(() => ({ status: 403 }));
  const r = await postCard(s.env, { card: "signups", channelId: CH, fetchImpl: f });
  assert.deepEqual([r.ok, r.status], [false, 502]);
  assert.equal(s.DB.kv.has("cards"), false);
  assert.equal((await postCard(s.env, { card: "party", channelId: CH, fetchImpl: f })).ok, false);
  const sh = setup({ cards: null, env: { CARDS_SHADOW: "1" } });
  const f2 = fakeFetch(() => ({ status: 200 }));
  assert.deepEqual(await postCard(sh.env, { card: "signups", channelId: CH, fetchImpl: f2 }), { ok: true, shadow: true, card: "signups" });
  assert.equal(f2.calls.length, 0);
});

// ---- terminal and rate-limited Discord answers ----
test("edit: 403 (and 401) is terminal: card marked errored, no retry, pendingSince not re-marked, never loops", async () => {
  for (const status of [403, 401]) {
    const s = setup();
    const f = fakeFetch(() => ({ status, json: { code: 50013 } }));
    const opts = { clock: s.clock, sleep: s.sleep, fetchImpl: f };
    const r = await requestCardEdit(s.env, opts);
    assert.equal(r.status, "edited", String(status));
    assert.deepEqual(r.results, [{ card: "signups", status: "errored", http: status }]);
    assert.equal(JSON.parse(s.DB.kv.get("cards")).signups.errored, true);
    assert.equal(JSON.parse(s.DB.kv.get("cards_edit")).pendingSince, null, "pending is not re-marked");
    for (let i = 0; i < 5; i++) {
      s.tick(10_000);
      assert.equal((await requestCardEdit(s.env, opts)).status, "no_card");
      assert.equal((await requestCardEdit(s.env, { ...opts, dirty: false })).status, "no_card");
    }
    assert.equal(f.calls.length, 1, `exactly one Discord call after a ${status}`);
  }
});

test("edit: an errored card is skipped but the other card keeps working; admin repost clears the error", async () => {
  const s = setup({ cards: { signups: { channel: CH, message: MSG, errored: true }, board: { channel: CH, message: "200000000000000003" } } });
  const f = fakeFetch(() => ({ status: 200, json: { id: "200000000000000088" } }));
  const r = await requestCardEdit(s.env, { clock: s.clock, sleep: s.sleep, fetchImpl: f });
  assert.deepEqual(r.results.map((x) => [x.card, x.status]), [["board", "edited"]]);
  const post = await postCard(s.env, { card: "signups", channelId: CH, fetchImpl: f });
  assert.equal(post.ok, true);
  assert.equal(JSON.parse(s.DB.kv.get("cards")).signups.errored, undefined);
});

test("edit: 429 honours Retry-After (header, then body), backs off without calling Discord, then retries once", async () => {
  const s = setup();
  let limited = true;
  const f = fakeFetch(() => (limited ? { status: 429, headers: { "retry-after": "30" }, json: { retry_after: 99 } } : { status: 200 }));
  const opts = { clock: s.clock, sleep: s.sleep, fetchImpl: f };
  const r = await requestCardEdit(s.env, opts);
  assert.equal(r.status, "failed");
  const st = JSON.parse(s.DB.kv.get("cards_edit"));
  assert.equal(st.retryAt - st.lastEditAt, 30_000, "header wins over body");
  assert.ok(st.pendingSince, "the change is still owed");
  for (let i = 0; i < 6; i++) {
    s.tick(4_000); // 24 s in total, still inside Retry-After
    assert.equal((await requestCardEdit(s.env, opts)).status, "backoff");
    assert.equal((await requestCardEdit(s.env, { ...opts, dirty: false })).status, "backoff");
  }
  assert.equal(f.calls.length, 1, "no Discord call while backing off");
  limited = false;
  s.tick(7_000); // past 30 s
  assert.equal((await requestCardEdit(s.env, { ...opts, dirty: false })).status, "edited");
  assert.equal(f.calls.length, 2);
  assert.equal(JSON.parse(s.DB.kv.get("cards_edit")).retryAt, null);
});

test("edit: a change that arrives during a back-off is remembered, not dropped", async () => {
  const s = setup();
  const f = fakeFetch(() => ({ status: 429, headers: { "retry-after": "60" } }));
  const opts = { clock: s.clock, sleep: s.sleep, fetchImpl: f };
  await requestCardEdit(s.env, opts);
  s.DB.kv.set("cards_edit", JSON.stringify({ lastEditAt: 1, pendingSince: null, retryAt: s.clock() + 60_000 }));
  s.tick(1000);
  assert.equal((await requestCardEdit(s.env, opts)).status, "backoff");
  assert.ok(JSON.parse(s.DB.kv.get("cards_edit")).pendingSince);
});

test("retry-after parsing: header, body, default, cap", async () => {
  const { retryAfterMs, MAX_BACKOFF_MS } = await import("../../infrastructure/worker/cards.js");
  const h = (v) => ({ headers: { get: () => v } });
  assert.equal(retryAfterMs(h("2"), {}), 2000);
  assert.equal(retryAfterMs(h(null), { retry_after: 1.5 }), 1500);
  assert.equal(retryAfterMs({}, {}), 5000);
  assert.equal(retryAfterMs(h("999999"), {}), MAX_BACKOFF_MS);
  assert.equal(retryAfterMs(h("0"), {}), 1000);
});

test("when options: custom ids stay under 100 characters and cannot inject a colon; bad options fall back", () => {
  const hostile = ["x".repeat(300), "a:b", "8pm", " pad ", "tab\there", ""];
  const card = renderSignupCard({ options: { when: hostile }, entries: [] });
  const ids = card.components.flatMap((r) => r.components.map((c) => c.custom_id));
  for (const id of ids) assert.ok(id.length <= 100, id);
  const whenIds = ids.filter((i) => i.startsWith("signup:when:"));
  assert.deepEqual(whenIds, ["signup:when:8pm"]);
  for (const id of ids) assert.equal(id.split(":").length, 3, id);
  assert.deepEqual(renderSignupCard({ options: { when: ["a:b"] }, entries: [] }).components[2].components.map((c) => c.custom_id), ["signup:when:6pm", "signup:when:8pm", "signup:when:later"]);
  assert.equal(resolveChoice("when", "a:b", { when: ["a:b", "8pm"] }), null);
  assert.equal(resolveChoice("when", "8pm", { when: ["a:b", "8pm"] }), "8pm");
  const many = renderSignupCard({ options: { when: ["1", "2", "3", "4", "5", "6", "7"] }, entries: [] });
  assert.equal(many.components[2].components.length, 5);
  assert.equal(validateCardsConfig({ signups: { channel: CH, message: MSG, errored: true } }), null);
  assert.ok(validateCardsConfig({ signups: { channel: CH, message: MSG, errored: "x" } }));
});
