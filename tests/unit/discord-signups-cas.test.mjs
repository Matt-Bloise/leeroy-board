// Follow-up to audit 2026-11-06 finding 2 (PRs 203 and 207): the Discord sign-up writers (slash /signup, the legacy button, and the sign-up card handler's
// buttons and modals) read the whole sign-ups document, changed it in JS and wrote it back unguarded, so they could erase a web write made in between (and
// the other way round). They now use updateKvJson with 3 tries (the interaction must be answered within 3 seconds). Writers from every path racing each
// other must all land. Real Worker over an in-memory SQLite D1 whose calls interleave like concurrent requests. Made-up names and keys, no network.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../../infrastructure/worker/index.js";
import { handleCardInteraction } from "../../infrastructure/worker/cards-handler.js";
import { recomputeSignupTallies } from "../../infrastructure/worker/discord.js";
import { sha256Hex } from "../../infrastructure/worker/crypto.js";
import { invalidateConfigCache } from "../../infrastructure/worker/config.js";
import { createDiscordSigner } from "../helpers/discord-sign.mjs";
import { schemaDb } from "../helpers/sqlite-d1.mjs";

const realFetch = globalThis.fetch;
globalThis.fetch = async () => new Response("blocked in tests", { status: 599 });
test.after(() => { globalThis.fetch = realFetch; });

const SALT = "salt-for-tests-0123456789";
const KEYS = { bloise: "member-key-bloise-0123456789ab", santa: "member-key-santa-0123456789abc" };
const signer = createDiscordSigner();
const room = { fetch: async () => new Response("ok") };
const ctx = { waitUntil() {}, passThroughOnException() {} };
const CH = "100000000000000001";
const DISCORD = [
  { slug: "ada", name: "Ada Tester", match: ["ada tester"], id: "fixture-user-0001" },
  { slug: "bo", name: "Bo Tester", match: ["bo tester"], id: "fixture-user-0002" },
];

const latent = (d1) => {
  const tick = () => new Promise((r) => setImmediate(r));
  return {
    raw: d1.raw, exec: d1.exec,
    batch: async (list) => { await tick(); return d1.batch(list); },
    prepare: (sql) => {
      const st = d1.prepare(sql), w = { bind: (...a) => (st.bind(...a), w), _run: () => st._run() };
      for (const m of ["all", "first", "run"]) w[m] = async () => { await tick(); return st[m](); };
      return w;
    },
  };
};
const SEED = () => ({ options: { meet: ["Valley of Strength", "The Crossroads"] }, entries: [{ name: "Street Rat", rsvp: "in" }] });
async function makeEnv(extra = {}) {
  const DB = schemaDb();
  for (const [slug, key] of Object.entries(KEYS)) DB.raw.prepare("INSERT INTO members (slug, key_hash, created_at) VALUES (?, ?, '2026-11-01T00:00:00Z')").run(slug, await sha256Hex(`${SALT}:${key}`));
  const put = (k, v) => DB.raw.prepare("INSERT INTO kv_state (key, json, updated_at) VALUES (?, ?, '2026-10-29T00:00:00Z')").run(k, JSON.stringify(v));
  put("signups", SEED()); put("discord_members", DISCORD); put("party", { members: [] }); put("launch", []);
  for (const [k, v] of Object.entries(extra.kv || {})) put(k, v);
  return { DB: latent(DB), raw: DB, KEY_SALT: SALT, USER_SALT: "user-salt-for-tests-0123456789", DISCORD_PUBLIC_KEY: signer.publicKeyHex, BOARD_PUBLIC_URL: "https://board.test", ALLOWED_ORIGINS: "", BOARD_ROOM: { idFromName: () => "r", get: () => room }, ...(extra.env || {}) };
}
const kv = (env, key) => { const r = env.raw.raw.prepare("SELECT json FROM kv_state WHERE key = ?").get(key); return r ? JSON.parse(r.json) : null; };
const silent = async (f) => { const s = console.error; console.error = () => {}; try { return await f(); } finally { console.error = s; } };
async function web(env, who, path, body) {
  return silent(() => worker.fetch(new Request(`https://api.test/api${path}`, { method: "POST", headers: { Authorization: `Board ${KEYS[who]}`, "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.9" }, body: JSON.stringify(body) }), env, ctx));
}
const base = (n, user) => ({ id: `fixture-interaction-000${n}`, application_id: "fixture-app-0001", token: "fixture-token-not-real", version: 1, guild_id: "fixture-guild-0001", channel_id: CH, locale: "en-US", member: { user: { id: user.id, username: user.slug, global_name: user.name }, roles: [] } });
const slash = (n, user, options) => ({ ...base(n, user), type: 2, data: { id: "fixture-cmd", name: "signup", type: 1, options: options.map(([name, value]) => ({ name, type: 3, value })) } });
const button = (n, user, custom_id) => ({ ...base(n, user), type: 3, data: { custom_id, component_type: 2 } });
async function discord(env, interaction) {
  const res = await silent(() => worker.fetch(signer.signedRequest(interaction, { url: "https://api.test/api/discord" }), env, ctx));
  return { status: res.status, body: await res.json() };
}
const row = (doc, slug) => doc.entries.find((e) => e.slug === slug);

test("slash, legacy button, web sign-up and web journey racing: every write lands, in every round", async () => {
  for (let round = 0; round < 6; round++) {
    const env = await makeEnv();
    const [ada, bo] = DISCORD;
    const res = await Promise.all([
      discord(env, slash(1, ada, [["rsvp", "late"], ["when", "8pm"]])),
      discord(env, button(2, ada, "signup:pack:yes")),
      discord(env, slash(3, bo, [["rsvp", "out"]])),
      discord(env, button(4, bo, "signup:meet:xroads")),
      web(env, "bloise", "/signups", { patch: { rsvp: "maybe", when: "6pm" } }),
      web(env, "santa", "/intent", { kind: "journey", patch: { journey: "guided" } }),
      web(env, "santa", "/signups", { patch: { pack: "no" } }),
    ]);
    for (const r of res.slice(0, 4)) assert.match(r.body.data.content, /Recorded/, JSON.stringify(r.body));
    assert.deepEqual(res.slice(4).map((r) => r.status), [200, 200, 200]);
    const doc = kv(env, "signups");
    assert.equal(row(doc, "ada").rsvp, "late"); assert.equal(row(doc, "ada").when, "8pm"); assert.equal(row(doc, "ada").pack, "yes");
    assert.equal(row(doc, "bo").rsvp, "out"); assert.equal(row(doc, "bo").meet, "The Crossroads");
    assert.equal(row(doc, "bloise").rsvp, "maybe"); assert.equal(row(doc, "bloise").when, "6pm");
    assert.equal(row(doc, "santa").pack, "no");
    assert.equal(doc.journeys.find((j) => j.slug === "santa").journey, "guided");
    assert.equal(doc.entries.length, 5, "the seed row plus four people, no duplicates");
    assert.ok(doc.entries.some((e) => e.name === "Street Rat"));
  }
});

test("sign-up card buttons and modals racing slash commands and web writes: every write lands", async () => {
  for (let round = 0; round < 4; round++) {
    invalidateConfigCache();
    const env = await makeEnv({ kv: { cards: { signups: { channel: CH, message: "200000000000000002" } } }, env: { CARDS_ENABLED: "on" } });
    const deps = { origin: "https://api.test", recompute: recomputeSignupTallies, insertIntent: async () => {}, purgeWorkerCache: async () => {}, broadcastToRoom: async () => {} };
    const card = (n, user, interaction) => handleCardInteraction({ interaction: { ...interaction, id: `30000000000000000${n}`, channel_id: CH }, env, ctx, member: { slug: user.slug, name: user.name }, byName: user.name, deps, now: Date.UTC(2026, 10, 3, 18, 0, 0) });
    const [ada, bo] = DISCORD;
    const res = await Promise.all([
      card(1, ada, { type: 3, data: { custom_id: "signup:rsvp:in" } }),
      card(2, ada, { type: 5, data: { custom_id: "signup:modal:meet", components: [{ type: 18, component: { type: 4, custom_id: "place", value: "The Old Mill" } }] } }),
      card(3, bo, { type: 3, data: { custom_id: "signup:pack:yes" } }),
      discord(env, slash(4, bo, [["when", "8pm"]])),
      web(env, "bloise", "/signups", { patch: { rsvp: "late" } }),
    ]);
    for (const r of res.slice(0, 3)) assert.equal(r.type, 4, JSON.stringify(r));
    assert.match(res[3].body.data.content, /Recorded/);
    const doc = kv(env, "signups");
    assert.equal(row(doc, "ada").rsvp, "in"); assert.equal(row(doc, "ada").meet, "The Old Mill");
    assert.equal(row(doc, "bo").pack, "yes"); assert.equal(row(doc, "bo").when, "8pm");
    assert.equal(row(doc, "bloise").rsvp, "late");
    assert.equal(doc.entries.length, 4);
  }
});

test("under sustained contention the Discord writers answer 'busy' (an ephemeral message), never a silent overwrite, in 5 tries", async () => {
  const env = await makeEnv();
  let casAttempts = 0;
  const inner = env.DB;
  env.DB = { ...inner, prepare: (sql) => {
    const w = inner.prepare(sql);
    if (/^UPDATE kv_state SET json = \?, updated_at = \? WHERE key = \? AND json = \?/.test(sql)) {
      const run = w.all;
      w.all = async () => { casAttempts++; env.raw.raw.prepare("UPDATE kv_state SET json = ? WHERE key = 'signups'").run(JSON.stringify({ ...SEED(), n: Math.random() })); return run(); };
    }
    return w;
  } };
  const r = await discord(env, slash(1, DISCORD[0], [["rsvp", "late"]]));
  assert.equal(r.status, 200);
  assert.match(r.body.data.content, /busy/);
  assert.equal(r.body.data.flags, 64);
  const b = await discord(env, button(2, DISCORD[0], "signup:pack:yes"));
  assert.match(b.body.data.content, /busy/);
  assert.equal(casAttempts, 10, "5 tries per request");
  assert.ok(!kv(env, "signups").entries.some((e) => e.slug === "ada"), "no stale write landed");
});

test("the dead bot-sync route is gone: POST /api/signups with an entries array replaces nothing", async () => {
  const env = await makeEnv();
  const r = await web(env, "bloise", "/signups", { entries: [{ name: "Intruder", rsvp: "in" }] });
  assert.equal(r.status, 400, "answered by the member route as an unknown sign-up field");
  assert.ok(!kv(env, "signups").entries.some((e) => e.name === "Intruder"));
});
