// How the cards code is wired into infrastructure/worker/discord.js, through the real signed-request entry point.
//   - flag on: `signup:` ids go to the card handler first; a bare /signup opens the select modal; every interaction schedules the flush
//   - flag off: /signup without options and the old button path (3b) answer exactly as before, and nothing is scheduled
// Throwaway Ed25519 key, fake D1, fake fetch. No network, no AI. Ids are made up.
import test from "node:test";
import assert from "node:assert/strict";
import { handleDiscordInteraction } from "../../infrastructure/worker/discord.js";
import { CONFIRM_LINES } from "../../infrastructure/worker/cards.js";
import { invalidateConfigCache } from "../../infrastructure/worker/config.js";
import { createDiscordSigner } from "../helpers/discord-sign.mjs";
import { fakeD1 } from "./fake-d1.mjs";

const signer = createDiscordSigner();
const CH = "100000000000000001", ELSEWHERE = "100000000000000055", USER = "1".repeat(18);
const NOW = Date.now();

const realFetch = globalThis.fetch;
const outbound = [];
globalThis.fetch = async (url, init = {}) => {
  outbound.push({ url: String(url), method: init.method || "GET", body: init.body ? JSON.parse(init.body) : undefined });
  return new Response(JSON.stringify({ id: "1" }), { status: 200, headers: { "Content-Type": "application/json" } });
};
test.after(() => { globalThis.fetch = realFetch; });

const doc = () => ({ options: { meet: ["Valley of Strength", "The Crossroads"], when: ["6pm", "8pm", "later"] }, entries: [{ name: "Bo", rsvp: "in" }] });
function world({ flags = {}, kv = {} } = {}) {
  invalidateConfigCache();
  outbound.length = 0;
  const DB = fakeD1({
    discord_members: [{ slug: "ada", name: "Ada", match: ["ada"], id: USER }],
    signups: doc(),
    cards: { signups: { channel: CH, message: "200000000000000002" } },
    ...kv,
  }, { lenient: true });
  const env = { DB, DISCORD_PUBLIC_KEY: signer.publicKeyHex, BOARD_PUBLIC_URL: "https://board.test", ...flags };
  const waits = [];
  const ctx = { waitUntil: (p) => waits.push(p) };
  const send = async (interaction) => {
    const res = await handleDiscordInteraction(signer.signedRequest(interaction), env, ctx, "https://worker.test");
    const body = await res.json();
    await Promise.allSettled(waits);
    return body;
  };
  return { DB, env, waits, send };
}
const who = { user: { id: USER, username: "ada" } };
const button = (custom_id, channel_id = CH) => ({ type: 3, id: "300000000000000003", application_id: "400000000000000004", token: "t", channel_id, member: who, data: { custom_id, component_type: 2 } });
const slash = (name, options = []) => ({ type: 2, id: "300000000000000005", application_id: "400000000000000004", token: "t", channel_id: CH, member: who, data: { name, options } });
const saved = (w) => JSON.parse(w.DB.kv.get("signups"));
const ON = { CARDS_ENABLED: "on" };

test("flag on: signup: ids go to the card handler first (confirmation line, channel check, id allow-list)", async () => {
  const w = world({ flags: ON });
  const ok = await w.send(button("signup:rsvp:in"));
  assert.equal(ok.type, 4);
  assert.equal(ok.data.flags, 64);
  assert.ok(CONFIRM_LINES.some((l) => ok.data.content === l.replace("{what}", "you're in")), ok.data.content);
  assert.equal(saved(w).entries.find((e) => e.name === "Ada").rsvp, "in");

  const wrong = await w.send(button("signup:rsvp:out", ELSEWHERE));
  assert.match(wrong.data.content, /only count from the sign-ups channel/);
  assert.equal(saved(w).entries.find((e) => e.name === "Ada").rsvp, "in");

  const injected = await w.send(button("signup:name:Mallory"));
  assert.match(injected.data.content, /not valid/);
  assert.equal(saved(w).entries.some((e) => e.name === "Mallory"), false);
  assert.equal(saved(w).entries.find((e) => e.name === "Ada").name, "Ada");
});

test("flag on: other component ids are not taken by the card handler", async () => {
  const w = world({ flags: ON });
  const r = await w.send(button("vote:0a1b2c3d:0"));
  assert.equal(r.data.content, "That vote no longer exists.");
  assert.equal(w.DB.kv.has("cards_edit"), false);
});

test("flag off: the old button path (3b) answers exactly as before and schedules nothing", async () => {
  const w = world();
  const r = await w.send(button("signup:rsvp:in", ELSEWHERE)); // no channel check when off
  assert.deepEqual(r, { type: 4, data: { content: "Recorded **rsvp: in** for **Ada** on the Living Board.", flags: 64, allowed_mentions: { parse: [] } } });
  assert.equal(saved(w).entries.find((e) => e.name === "Ada").rsvp, "in");
  assert.equal(w.waits.length, 0, "no waitUntil with the flag off");
  assert.deepEqual([...w.DB.kv.keys()].filter((k) => ["cards_edit", "board_lines_pending"].includes(k)), []);
  assert.equal(outbound.length, 0);
  // issue #126: an unknown field is refused and nothing is stored (full cases in signup-allowlist.test.mjs)
  const odd = await w.send(button("signup:nickname:Zed"));
  assert.match(odd.data.content, /not recorded/);
  assert.equal(saved(w).entries.find((e) => e.name === "Ada").nickname, undefined);
});

test("flag on: /signup without options opens the select modal; flag off keeps the status panel", async () => {
  const on = await world({ flags: ON }).send(slash("signup"));
  assert.equal(on.type, 9);
  assert.equal(on.data.custom_id, "signup:modal:form");
  assert.deepEqual(on.data.components.map((c) => c.component.custom_id), ["rsvp", "pack", "meet", "when"]);

  const off = await world().send(slash("signup"));
  assert.equal(off.type, 4);
  assert.equal(off.data.flags, 64);
  assert.match(off.data.content, /^\*\*Ada's Sign-up Status:\*\*/);
  assert.deepEqual(off.data.components[0].components.slice(0, 3).map((c) => c.custom_id), ["signup:rsvp:in", "signup:rsvp:maybe", "signup:rsvp:out"]);
});

test("/signup with options: flag off writes as before with no card work; flag on also queues the follow-ups", async () => {
  const off = world();
  const r0 = await off.send(slash("signup", [{ name: "rsvp", type: 3, value: "maybe" }]));
  assert.match(r0.data.content, /^Recorded sign-up update for \*\*Ada\*\*: \*\*rsvp\*\*: `maybe`/);
  assert.equal(off.waits.length, 0);
  assert.equal(off.DB.kv.has("board_lines_pending"), false);

  const on = world({ flags: { ...ON, BOARD_LINES_ENABLED: "on" } });
  const r1 = await on.send(slash("signup", [{ name: "rsvp", type: 3, value: "maybe" }]));
  assert.match(r1.data.content, /^Recorded sign-up update for \*\*Ada\*\*/);
  assert.ok(on.waits.length >= 1);
  assert.deepEqual(Object.values(JSON.parse(on.DB.kv.get("board_lines_pending")).changes), [{ name: "Ada", from: null, to: "maybe" }]);
  const patches = outbound.filter((o) => o.method === "PATCH");
  assert.equal(patches.length, 0, "the card edit needs DISCORD_BOT_TOKEN; without it nothing is sent");
});

test("flag on: every interaction schedules the flush, and a due board line is posted silently; flag off does neither", async () => {
  const due = { lastChangeAt: NOW - 10 * 60_000, changes: { ada: { name: "Ada", from: null, to: "maybe" } } };
  const kv = { board_lines_pending: due, noise: { perDay: 10, quiet: { start: 3, end: 3 } } };

  const on = world({ flags: { ...ON, BOARD_LINES_ENABLED: "on", DISCORD_BOT_TOKEN: "test-token" }, kv });
  await on.send(slash("signup"));
  assert.ok(on.waits.length >= 1, "waitUntil is called for the flush");
  const posts = outbound.filter((o) => o.method === "POST" && o.url.endsWith(`/channels/${CH}/messages`));
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].body, { content: "From the board: Ada is tentative.", flags: 4096, allowed_mentions: { parse: [] } });
  assert.equal(on.DB.kv.has("board_lines_pending"), false);

  const off = world({ flags: { BOARD_LINES_ENABLED: "on", DISCORD_BOT_TOKEN: "test-token" }, kv });
  await off.send(slash("signup"));
  assert.equal(off.waits.length, 0);
  assert.equal(outbound.length, 0);
  assert.ok(off.DB.kv.has("board_lines_pending"), "untouched with CARDS_ENABLED off");
});
