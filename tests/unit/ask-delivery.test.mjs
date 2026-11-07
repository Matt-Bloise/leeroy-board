// answerWithAi wiring (format, prompt, fallback provenance) and the Discord /ask delivery guarantee.
// Fake D1, fake fetch, fake Workers AI binding, fake ctx.waitUntil. No network, no AI calls, no real keys.
// Run: node --test tests/unit/ask-delivery.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { answerWithAi, invalidatePagesCache, ASK_CHOSEN_TIMEOUT_MS, ASK_FALLBACK_TIMEOUT_MS, ASK_DEADLINE_MS } from "../../infrastructure/worker/ai-models.js";
import { buildSystemPrompt, invalidatePersonaCache } from "../../infrastructure/worker/persona.js";
import { handleDiscordInteraction } from "../../infrastructure/worker/discord.js";
import { createDiscordSigner } from "../helpers/discord-sign.mjs";

const PAGES = [
  { id: "raids/onyxias-lair", category: "raids", title: "Onyxia's Lair", facts: [{ key: "onyxia.opens", value: "Onyxia's Lair opens on 2026-12-09." }, { key: "onyxia.size", value: "Onyxia's Lair opens as a 40 player raid." }] },
  { id: "classes/paladin-holy", category: "classes", title: "Holy Paladin", facts: [] },
].map((p) => ({ ...p, as_of: "2026-11-01", blurb: p.title, aliases_json: "[]", facts_json: JSON.stringify(p.facts), open_json: "[]" }));

const MODEL_RAW =
  "**Onyxia's Lair opens on 2026-12-09.** Santa, you have a month to gear up.\n" +
  "Raid size · 40 players\n\n" +
  "-# Sources: raids/onyxias-lair, nope/unknown\n" +
  "https://leeroy.party/#library.raids\n" +
  "At least I have chicken.";

function fakeDb(seeds = {}, pages = PAGES) {
  const turns = new Map();
  const writes = [];
  const prepare = (sql) => {
    let args = [];
    const stmt = {
      bind: (...a) => ((args = a), stmt),
      first: async () => {
        if (/FROM ask_turns/i.test(sql)) return turns.get(args[0]) || null;
        if (/FROM kv_state/i.test(sql)) {
          const key = /key = '([a-z_]+)'/.exec(sql)?.[1] ?? args[0];
          return key in seeds ? { json: JSON.stringify(seeds[key]) } : null;
        }
        return null;
      },
      all: async () => ({ results: /FROM lib_pages/i.test(sql) ? pages : [] }),
      run: async () => {
        writes.push({ sql, args });
        if (/^INSERT INTO ask_turns/i.test(sql)) turns.set(args[0], { id: args[0], answer: null, status: "thinking", model: args[3] });
        if (/^UPDATE ask_turns SET answer = \?, cites_json/i.test(sql)) {
          const [answer, cites, model, , , id] = args;
          turns.set(id, { id, answer, cites, model, status: "answered" });
        }
        if (/^UPDATE ask_turns SET status = 'error'/i.test(sql)) turns.set(args[2], { id: args[2], answer: args[0], status: "error" });
        return { success: true, meta: { changes: 1, last_row_id: writes.length } };
      },
    };
    return stmt;
  };
  return { prepare, batch: async (s) => s.map(() => ({ success: true, meta: { changes: 1 } })), turns, writes };
}

function baseEnv(db, extra = {}) {
  const room = { fetch: async () => new Response("ok") };
  return { DB: db, BOARD_ROOM: { idFromName: () => "room", get: () => room }, ...extra };
}

const realFetch = globalThis.fetch;
test.beforeEach(() => {
  invalidatePagesCache();
  invalidatePersonaCache();
});
test.afterEach(() => {
  globalThis.fetch = realFetch;
});

function seedTurn(db, id) {
  db.turns.set(id, { id, answer: null, status: "thinking" });
}

test("timeouts are defined once and fit the Discord deadline", () => {
  assert.equal(ASK_CHOSEN_TIMEOUT_MS, 12000);
  assert.equal(ASK_FALLBACK_TIMEOUT_MS, 9000);
  assert.equal(ASK_DEADLINE_MS, 24000);
  assert.ok(ASK_CHOSEN_TIMEOUT_MS + ASK_FALLBACK_TIMEOUT_MS <= ASK_DEADLINE_MS);
});

test("answerWithAi formats the stored answer, filters cites, and records why a provider was skipped", async () => {
  const db = fakeDb();
  const prompts = [];
  globalThis.fetch = async () => new Response("provider down", { status: 500 });
  const env = baseEnv(db, {
    ANTHROPIC_API_KEY: "test-key",
    AI: { run: async (model, inputs) => (prompts.push(inputs.messages), { response: MODEL_RAW }) },
  });
  await answerWithAi({ env, origin: "https://worker.test", intentId: "t1", by: "Visitor", question: "when does onyxia open", provider: "claude", isMember: false });
  const row = db.turns.get("t1") || (seedTurn(db, "t1"), db.turns.get("t1"));
  assert.equal(row.status, "answered");
  assert.equal(
    row.answer,
    "**Onyxia's Lair opens on 2026-12-09.**\n\n• **Raid size** · 40 players\n\n" +
      "-# Sources: [Onyxia's Lair](<https://leeroy.party/#library.raids.onyxias-lair>)\n" +
      "-# [Open on the board](<https://leeroy.party/#library.raids>)"
  );
  assert.deepEqual(JSON.parse(row.cites), ["raids/onyxias-lair"]);
  assert.match(row.model, /^workers-ai:.* \(after claude: .*500.*\)$/);
  assert.ok(row.model.length <= 120);
  assert.ok(!row.model.includes("test-key"));
  const userPrompt = prompts[0][1].content;
  assert.match(userPrompt, /Asker: Visitor \(visitor\)/);
  assert.match(userPrompt, /only when they are a party member/);
  assert.ok(!prompts[0][0].content.includes("[classes/paladin-holy]"));
  assert.match(prompts[0][0].content, /-# Sources: id1, id2/);
});

test("a party member keeps being addressed by name", async () => {
  const db = fakeDb();
  const env = baseEnv(db, { AI: { run: async () => ({ response: MODEL_RAW }) } });
  await answerWithAi({ env, origin: "https://worker.test", intentId: "t2", by: "Santa", question: "when does onyxia open", provider: "workers-ai", isMember: true });
  assert.match(db.turns.get("t2").answer, /Santa, you have a month to gear up\./);
});

test("ANSWER_FORMAT=off stores the unformatted answer", async () => {
  const db = fakeDb();
  const env = baseEnv(db, { ANSWER_FORMAT: "off", AI: { run: async () => ({ response: MODEL_RAW }) } });
  await answerWithAi({ env, origin: "https://worker.test", intentId: "t3", by: "Visitor", question: "when does onyxia open", provider: "workers-ai", isMember: false });
  const stored = db.turns.get("t3").answer;
  assert.match(stored, /Santa, you have a month/);
  assert.ok(!stored.includes("Open on the board"));
});

test("the platform rule no longer asks for bracketed ids", () => {
  const prompt = buildSystemPrompt({ system: "S", format: { chatMaxChars: 900 } }, { question: "q" });
  assert.ok(!prompt.includes("[classes/paladin-holy]"));
  assert.ok(!/in brackets like/.test(prompt));
  assert.match(prompt, /-# Sources: id1, id2/);
  assert.match(prompt, /Never write bare web addresses\./);
});

// ---- Discord /ask delivery ----

const signer = createDiscordSigner();
const askInteraction = {
  id: "fixture-interaction-0001",
  application_id: "fixture-app-0001",
  token: "fixture-token-not-real",
  version: 1,
  type: 2,
  member: { user: { id: "fixture-user-0001", username: "fixture_tester", global_name: "Fixture Tester" }, nick: null, roles: [] },
  data: { id: "fixture-cmd-ask", name: "ask", type: 1, options: [{ name: "question", type: 3, value: "when does onyxia open" }] },
};

async function runAsk({ providerDelayMs, providerStatus = 200, deadlineMs = 60, pages = PAGES }) {
  const db = fakeDb({ persona: { system: "S", ackLines: ["thinking line"], errorLines: ["Leeroy tripped over a footnote."] } }, pages);
  const patches = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes("/messages/@original")) {
      patches.push(JSON.parse(init.body));
      return new Response("{}", { status: 200 });
    }
    if (u.includes("api.anthropic.com")) {
      await new Promise((r) => setTimeout(r, providerDelayMs));
      if (providerStatus !== 200) return new Response("boom", { status: providerStatus });
      return new Response(JSON.stringify({ content: [{ type: "text", text: MODEL_RAW }] }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  };
  const env = baseEnv(db, { DISCORD_PUBLIC_KEY: signer.publicKeyHex, ANTHROPIC_API_KEY: "test-key", ASK_DEADLINE_MS: String(deadlineMs), USER_SALT: "fixture-salt-0123456789" });
  const pending = [];
  const res = await handleDiscordInteraction(signer.signedRequest(askInteraction), env, { waitUntil: (p) => pending.push(p) }, "https://worker.test");
  const ack = await res.json();
  const patchesAtAck = patches.length;
  await Promise.allSettled(pending);
  return { ack, patches, patchesAtAck, db };
}

test("/ask: provider hangs past the deadline, the placeholder is still replaced exactly once", async () => {
  const { ack, patches, patchesAtAck, db } = await runAsk({ providerDelayMs: 400, deadlineMs: 60 });
  assert.equal(ack.type, 4);
  assert.equal(ack.data.content, "thinking line");
  assert.equal(patchesAtAck, 0);
  assert.equal(patches.length, 1, "exactly one PATCH");
  assert.match(patches[0].content, /Leeroy tripped over a footnote\. Try again in a moment\./);
  // The late answer is still stored for the website and is not sent a second time.
  const stored = [...db.turns.values()].find((t) => t.status === "answered");
  assert.ok(stored && /Onyxia's Lair opens/.test(stored.answer));
});

test("/ask: a fast answer is delivered formatted, once", async () => {
  const { patches } = await runAsk({ providerDelayMs: 0, deadlineMs: 2000 });
  assert.equal(patches.length, 1);
  assert.ok(patches[0].content.startsWith("> **Q:** when does onyxia open\n\n**Onyxia's Lair opens on 2026-12-09.**"), "the reply quotes the question it answers");
  assert.match(patches[0].content, /\[Onyxia's Lair\]\(<https:\/\/board\.test|\[Onyxia's Lair\]\(<https:\/\/leeroy\.party/);
  assert.ok(!/Santa, you have/.test(patches[0].content), "guest is not addressed as a party member");
});

test("/ask: provider error and nothing to answer from still replaces the placeholder, now with the honest line written by code", async () => {
  const { patches } = await runAsk({ providerDelayMs: 0, providerStatus: 500, deadlineMs: 2000, pages: [] });
  assert.equal(patches.length, 1);
  assert.match(patches[0].content, /does not cover that yet/i);
});

test("/ask: provider error falls back to a library answer, delivered once", async () => {
  const { patches } = await runAsk({ providerDelayMs: 0, providerStatus: 500, deadlineMs: 2000 });
  assert.equal(patches.length, 1);
  assert.match(patches[0].content, /Onyxia/);
});
