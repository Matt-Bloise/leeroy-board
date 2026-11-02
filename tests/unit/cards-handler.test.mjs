// Sign-up interactions with CARDS_ENABLED: allowed channels, buttons, write-in and select modals, and the admin post route. Fakes only.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../../infrastructure/worker/index.js";
import { handleCardInteraction, signupSelectModal, writeInModal, FORM_MODAL_ID, WRITE_IN_MODAL_ID } from "../../infrastructure/worker/cards-handler.js";
import { CONFIRM_LINES } from "../../infrastructure/worker/cards.js";
import { invalidateConfigCache } from "../../infrastructure/worker/config.js";
import { fakeD1, fakeFetch } from "./fake-d1.mjs";

const CH = "100000000000000001", OTHER = "100000000000000044", MSG = "200000000000000002";
const NOW = Date.UTC(2026, 10, 3, 18, 0, 0);
const member = { slug: "ada", name: "Ada" };

function setup({ cards = { signups: { channel: CH, message: MSG } }, env = {} } = {}) {
  invalidateConfigCache();
  const DB = fakeD1({ signups: { options: { meet: ["Valley of Strength", "The Crossroads"], when: ["6pm", "8pm", "later"] }, entries: [{ name: "Bo", rsvp: "in" }] }, ...(cards ? { cards } : {}) });
  const calls = { intents: [], purged: 0, broadcast: 0, recompute: 0 };
  const deps = {
    origin: "https://api.test",
    recompute: async (d) => { calls.recompute++; d.tallies = { fake: true }; },
    insertIntent: async (_e, i) => { calls.intents.push(i); },
    purgeWorkerCache: async () => { calls.purged++; },
    broadcastToRoom: async () => { calls.broadcast++; },
  };
  const waits = [];
  const ctx = { waitUntil: (p) => waits.push(p) };
  const e = { CARDS_ENABLED: "on", DB, ...env };
  const run = (interaction) => handleCardInteraction({ interaction, env: e, ctx, member, byName: "Ada", deps, now: NOW });
  return { DB, deps, calls, ctx, waits, env: e, run };
}
const click = (custom_id, channel_id = CH, id = "300000000000000003") => ({ type: 3, id, channel_id, data: { custom_id } });
const submit = (custom_id, fields, channel_id = CH) => ({
  type: 5, id: "300000000000000004", channel_id,
  data: { custom_id, components: Object.entries(fields).map(([k, v]) => ({ type: 18, component: Array.isArray(v) ? { type: 3, custom_id: k, values: v } : { type: 4, custom_id: k, value: v } })) },
});
const saved = (s) => JSON.parse(s.DB.kv.get("signups"));

test("not ours or flag off: null, no writes", async () => {
  const s = setup();
  assert.equal(await s.run({ type: 3, data: { custom_id: "vote:abc:1" } }), null);
  const off = setup({ env: { CARDS_ENABLED: "off" } });
  assert.equal(await off.run(click("signup:rsvp:in")), null);
});

test("a click from a channel that is not allowed is refused and not counted", async () => {
  const s = setup();
  const r = await s.run(click("signup:rsvp:in", OTHER));
  assert.match(r.data.content, /only count from the sign-ups channel/);
  assert.equal(r.data.flags, 64);
  assert.equal(saved(s).entries.length, 1);
  assert.equal(s.calls.intents.length, 0);
  assert.equal((await s.run(click("signup:rsvp:in", ""))).data.content.length > 0, true); // no channel at all
  assert.equal(saved(s).entries.length, 1);
  assert.match((await s.run(submit(WRITE_IN_MODAL_ID, { place: "Inn" }, OTHER))).data.content, /sign-ups channel/);
  const open = setup({ cards: null });
  assert.equal(saved(open).entries.length, 1);
  assert.equal((await open.run(click("signup:rsvp:in", OTHER))).data.flags, 64); // not configured: no restriction, counted
  assert.equal(saved(open).entries.length, 2);
});

test("allowedChannels adds channels beyond the cards' own", async () => {
  const s = setup({ cards: { signups: { channel: CH, message: MSG }, allowedChannels: [OTHER] } });
  await s.run(click("signup:rsvp:late", OTHER));
  assert.equal(saved(s).entries.find((e) => e.name === "Ada").rsvp, "late");
});

test("button: state saved, tallies recomputed, intent + cache + room, one ephemeral line from the six", async () => {
  const s = setup();
  const r = await s.run(click("signup:rsvp:maybe"));
  assert.equal(r.type, 4);
  assert.equal(r.data.flags, 64);
  assert.ok(CONFIRM_LINES.some((l) => r.data.content === l.replace("{what}", "you're tentative")), r.data.content);
  const doc = saved(s);
  assert.deepEqual(doc.entries.find((e) => e.name === "Ada"), { name: "Ada", slug: "ada", rsvp: "maybe", updated: "2026-11-03T18:00:00.000Z" });
  assert.deepEqual([s.calls.recompute, s.calls.purged, s.calls.broadcast, s.calls.intents.length], [1, 1, 1, 1]);
  assert.deepEqual(s.calls.intents[0].body.patch, { rsvp: "maybe" });
  assert.equal(s.waits.length, 1, "the card redraw is scheduled, not awaited");
});

test("all four states and the pack, meeting and arrival buttons", async () => {
  const s = setup();
  for (const [id, key, want] of [["rsvp:in", "rsvp", "in"], ["rsvp:late", "rsvp", "late"], ["rsvp:out", "rsvp", "out"], ["pack:yes", "pack", "yes"], ["meet:xroads", "meet", "The Crossroads"], ["when:8pm", "when", "8pm"]]) {
    await s.run(click(`signup:${id}`));
    assert.equal(saved(s).entries.find((e) => e.name === "Ada")[key], want, id);
  }
});

test("invalid tokens never write: unknown field, bad value, injected field names", async () => {
  const s = setup();
  for (const id of ["signup:name:Mallory", "signup:rsvp:yes", "signup:slug:x", "signup:when:9pm", "signup:pack:maybe", "signup:meet:m9", "signup:__proto__:x", "signup:rsvp"]) {
    const r = await s.run(click(id));
    assert.match(r.data.content, /not valid/, id);
  }
  assert.equal(saved(s).entries.length, 1);
  assert.equal(s.calls.intents.length, 0);
});

test("Elsewhere opens the write-in modal: 40 characters, one required field", async () => {
  const s = setup();
  const r = await s.run(click("signup:meet:other"));
  assert.equal(r.type, 9);
  assert.deepEqual(r, writeInModal());
  assert.equal(r.data.custom_id, "signup:modal:meet");
  assert.equal(r.data.components[0].component.max_length, 40);
  assert.equal(saved(s).entries.length, 1);
});

test("write-in submit: sanitised to 40 characters and stored as the meeting point", async () => {
  const s = setup();
  const r = await s.run(submit(WRITE_IN_MODAL_ID, { place: `  <@123456789012345678> **Behind** the inn http://x.test ${"y".repeat(60)}` }));
  const meet = saved(s).entries.find((e) => e.name === "Ada").meet;
  assert.ok(meet.length <= 40 && meet.startsWith("Behind the inn"), meet);
  assert.ok(!/[<>@*]|http/.test(meet));
  assert.match(r.data.content, /meeting at Behind the inn/);
  const bad = await s.run(submit(WRITE_IN_MODAL_ID, { place: " <@1> http://x.test " }));
  assert.match(bad.data.content, /did not look like a place/);
});

test("select modal: four selects, current answers pre-selected, no more than 5 components", () => {
  const doc = { options: { meet: ["Valley of Strength", "The Crossroads"], when: ["6pm", "8pm"] } };
  const m = signupSelectModal(doc, { rsvp: "late", pack: "no", meet: "The Crossroads", when: "8pm" });
  assert.equal(m.type, 9);
  assert.equal(m.data.custom_id, FORM_MODAL_ID);
  assert.deepEqual(m.data.components.map((c) => c.component.custom_id), ["rsvp", "pack", "meet", "when"]);
  const defaults = m.data.components.map((c) => c.component.options.find((o) => o.default)?.value);
  assert.deepEqual(defaults, ["late", "no", "xroads", "8pm"]);
  assert.deepEqual(signupSelectModal({}, null).data.components.length, 4);
});

test("select modal submit: valid answers saved together, junk ignored, nothing valid says so", async () => {
  const s = setup();
  const r = await s.run(submit(FORM_MODAL_ID, { rsvp: ["in"], pack: ["yes"], meet: ["vos"], when: ["9pm"] }));
  const e = saved(s).entries.find((x) => x.name === "Ada");
  assert.deepEqual([e.rsvp, e.pack, e.meet, e.when], ["in", "yes", "Valley of Strength", undefined]);
  assert.equal(r.data.flags, 64);
  assert.equal(s.calls.intents.length, 1);
  const none = await s.run(submit(FORM_MODAL_ID, { rsvp: ["bogus"] }));
  assert.equal(none.data.content, "Nothing changed.");
});

test("no member: refused politely, nothing written", async () => {
  const s = setup();
  const r = await handleCardInteraction({ interaction: click("signup:rsvp:in"), env: s.env, ctx: s.ctx, member: null, byName: "Guest", deps: s.deps, now: NOW });
  assert.match(r.data.content, /can't tell which party member/);
  assert.equal(saved(s).entries.length, 1);
});

// ---- the admin route through the real Worker fetch ----
const ADMIN = "admin-token-for-tests-0123456789abcdef";
async function admin(env, body, bearer = ADMIN) {
  const res = await worker.fetch(new Request("https://api.test/api/admin/cards/post", { method: "POST", headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }), env, { waitUntil() {} });
  return { status: res.status, body: await res.json() };
}
test("POST /api/admin/cards/post: gates, posts, records the id, never echoes ids, recreates after a deleted card", async () => {
  invalidateConfigCache();
  const DB = fakeD1({ discord_roster: { channels: { signups: CH } }, signups: { entries: [{ name: "Ada", rsvp: "in" }] } });
  const env = { DB, BOARD_ADMIN_TOKEN: ADMIN, CARDS_ENABLED: "on", DISCORD_BOT_TOKEN: "test-token" };
  const f = fakeFetch((m, p) => (m === "POST" ? { status: 200, json: { id: MSG } } : { status: 204 }));
  const real = globalThis.fetch;
  globalThis.fetch = f;
  try {
    assert.equal((await admin(env, { card: "signups", channel_key: "signups" }, "wrong")).status, 401);
    assert.equal((await admin({ ...env, CARDS_ENABLED: "off" }, { card: "signups", channel_key: "signups" })).status, 404);
    assert.equal((await admin({ ...env, DISCORD_BOT_TOKEN: "" }, { card: "signups", channel_key: "signups" })).status, 503);
    assert.equal((await admin(env, { card: "party", channel_key: "signups" })).status, 400);
    assert.equal((await admin(env, { card: "signups", channel_key: "nowhere" })).status, 400);
    assert.equal(f.calls.length, 0);
    const ok = await admin(env, { card: "signups", channel_key: "signups" });
    assert.deepEqual([ok.status, ok.body], [200, { ok: true, card: "signups", pinned: true }]);
    assert.deepEqual(JSON.parse(DB.kv.get("cards")), { signups: { channel: CH, message: MSG } });
    assert.ok(!JSON.stringify(ok.body).includes(MSG));
    assert.equal((await admin(env, { card: "signups", channel_key: "signups" })).status, 409);
    // a person deletes the message: the edit marks it deleted, the admin route recreates it
    DB.kv.set("cards", JSON.stringify({ signups: { channel: CH, message: MSG, deleted: true } }));
    const again = await admin(env, { card: "signups", channel_key: "signups" });
    assert.equal(again.status, 200);
    assert.equal(JSON.parse(DB.kv.get("cards")).signups.deleted, undefined);
  } finally {
    globalThis.fetch = real;
  }
});
