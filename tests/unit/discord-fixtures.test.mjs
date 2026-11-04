// Runs every recorded-shape Discord payload in tests/fixtures/discord/ through the real handler in
// infrastructure/worker/discord.js with a stubbed env and a stubbed D1. No network, no AI, no real keys, no real ids.
// The signing key is a throwaway Ed25519 pair made in memory (tests/helpers/discord-sign.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleDiscordInteraction, DISCORD_SLASH_COMMANDS_MANIFEST } from "../../infrastructure/worker/discord.js";
import { createDiscordSigner } from "../helpers/discord-sign.mjs";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "discord");
const fixtures = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => ({ file: f, ...JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")) }));

const MEMBERS = [{ slug: "fixture-tester", name: "Fixture Tester", match: ["fixture tester"], id: "fixture-user-0001" }];
const SEEDS = {
  discord_members: MEMBERS,
  signups: { entries: [{ slug: "fixture-tester", name: "Fixture Tester", rsvp: "in" }] },
  party: { members: [{ name: "Fixture Tester", race: "Orc", class: "Warrior" }] },
  launch: [],
};

// A D1 stand-in: every query resolves, reads return seeded kv_state rows or nothing, writes are recorded.
function stubDb() {
  const writes = [];
  const prepare = (sql) => {
    let args = [];
    const stmt = {
      bind: (...a) => ((args = a), stmt),
      first: async () => {
        if (/FROM kv_state/i.test(sql)) {
          const key = /key = '([a-z_]+)'/.exec(sql)?.[1] ?? args[0];
          return key in SEEDS ? { json: JSON.stringify(SEEDS[key]) } : null;
        }
        if (/COUNT\(\*\)/i.test(sql)) return { count: 0 };
        if (/FROM lib_pages/i.test(sql)) return { id: "fixture-page", category: "fixture", title: "Fixture Page", page_json: "{}" };
        return null;
      },
      all: async () => ({ results: /FROM lib_pages/i.test(sql) ? [{ id: "fixture-page", title: "Fixture Page" }] : [] }),
      run: async () => (writes.push({ sql, args }), { success: true, meta: { changes: 1, last_row_id: writes.length } }),
    };
    return stmt;
  };
  const batch = async (stmts) => stmts.map(() => ({ success: true, meta: { changes: 1 } }));
  return { prepare, batch, writes };
}

function makeEnv(publicKeyHex) {
  const db = stubDb();
  const room = { fetch: async () => new Response("ok") };
  return {
    env: { DB: db, DISCORD_PUBLIC_KEY: publicKeyHex, BOARD_PUBLIC_URL: "https://board.test", USER_SALT: "fixture-salt-0123456789", BOARD_ROOM: { idFromName: () => "room", get: () => room } },
    writes: db.writes,
  };
}

// Never let a fixture reach the real network (the /ask path PATCHes a Discord webhook and may call an AI provider).
const realFetch = globalThis.fetch;
const outbound = [];
globalThis.fetch = async (url) => (outbound.push(String(url)), new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }));
test.after(() => {
  globalThis.fetch = realFetch;
});

async function dispatch(request, env) {
  const pending = [];
  const res = await handleDiscordInteraction(request, env, { waitUntil: (p) => pending.push(p) }, "https://worker.test");
  await Promise.allSettled(pending);
  return res;
}

const signer = createDiscordSigner();

for (const fx of fixtures) {
  test(`fixture ${fx.file}: ${fx.description}`, async () => {
    const { env } = makeEnv(signer.publicKeyHex);
    const res = await dispatch(signer.signedRequest(fx.interaction), env);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("Content-Type") || "", /application\/json/);
    const body = await res.json();
    assert.equal(body.type, fx.expectType, `response type for ${fx.file}`);
    if (fx.expectEphemeral) assert.equal(body.data.flags & 64, 64, "response should be ephemeral");
    if (body.data && typeof body.data.content === "string") assert.ok(body.data.content.length <= 2000, "content is clamped");
    if (body.type === 4 || body.type === 7) assert.ok(body.data.allowed_mentions, "allowed_mentions is set on every message reply");
  });
}

test("every slash command in the manifest has a fixture", () => {
  const covered = new Set(fixtures.filter((f) => f.interaction.type === 2 && (f.interaction.data.type || 1) === 1).map((f) => f.interaction.data.name));
  for (const c of DISCORD_SLASH_COMMANDS_MANIFEST.filter((c) => !c.type || c.type === 1)) assert.ok(covered.has(c.name), `no fixture for /${c.name}`);
});

test("every context-menu command in the manifest has a fixture", () => {
  const covered = new Set(fixtures.filter((f) => f.interaction.type === 2 && f.interaction.data.type === 3).map((f) => f.interaction.data.name));
  for (const c of DISCORD_SLASH_COMMANDS_MANIFEST.filter((c) => c.type === 3)) assert.ok(covered.has(c.name), `no fixture for "${c.name}"`);
});

test("fixture library covers each interaction kind", () => {
  const kinds = new Set(fixtures.map((f) => f.interaction.type));
  for (const t of [1, 2, 3, 4, 5]) assert.ok(kinds.has(t), `no fixture with interaction type ${t}`);
});

test("fixtures contain no real-looking Discord ids or secrets", () => {
  for (const f of fixtures) {
    const text = JSON.stringify(f);
    assert.doesNotMatch(text, /\b\d{17,20}\b/, `${f.file} has a snowflake-shaped number`);
    assert.doesNotMatch(text, /[A-Za-z0-9_-]{60,}/, `${f.file} has a token-shaped string`);
  }
});

test("the handler writes to D1 for a state-changing fixture", async () => {
  const { env, writes } = makeEnv(signer.publicKeyHex);
  const fx = fixtures.find((f) => f.file === "cmd-launch.json");
  await dispatch(signer.signedRequest(fx.interaction), env);
  assert.ok(writes.some((w) => /kv_state/.test(w.sql)), "launch state is written to kv_state");
});

test("unsigned, tampered, stale and wrong-key requests are rejected with 401", async () => {
  const { env } = makeEnv(signer.publicKeyHex);
  const ping = fixtures.find((f) => f.file === "ping.json").interaction;
  assert.equal((await dispatch(signer.signedRequest(ping, { tamper: true }), env)).status, 401);
  assert.equal((await dispatch(signer.signedRequest(ping, { timestamp: Math.floor(Date.now() / 1000) - 3600 }), env)).status, 401);
  assert.equal((await dispatch(new Request("https://worker.test/discord", { method: "POST", body: JSON.stringify(ping) }), env)).status, 401);
  const other = createDiscordSigner();
  assert.equal((await dispatch(other.signedRequest(ping), env)).status, 401);
});

test("a missing public key answers 500 rather than crashing", async () => {
  const { env } = makeEnv(signer.publicKeyHex);
  delete env.DISCORD_PUBLIC_KEY;
  const res = await dispatch(signer.signedRequest({ type: 1 }), env);
  assert.equal(res.status, 500);
});
