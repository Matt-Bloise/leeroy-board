// W5: with ASK_RESEARCH on, a roster member (or signed-in web member) never meets a wall on /ask: the per-user cap (40/day), the neuron cap and ask 41 degrade
// the answer (Claude, then Workers AI, then library facts) instead of refusing. Guests stay rate limited and cannot touch members. With the flag off nothing changes
// (the old wall tests stay in place; two flag-off counterparts live at the end of this file).
// Real Worker code over an in-memory SQLite D1. Fake fetch, fake Workers AI binding, fake keys, fictional names only. No wall-clock limits.
// Run: node --test tests/unit/ask-no-walls.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../../infrastructure/worker/index.js";
import { handleDiscordInteraction, answerAndDeliver } from "../../infrastructure/worker/discord.js";
import { answerWithAi, invalidatePagesCache, findRecentSameAnswer } from "../../infrastructure/worker/ai-models.js";
import { invalidatePersonaCache, pickLine } from "../../infrastructure/worker/persona.js";
import { invalidateConfigCache } from "../../infrastructure/worker/config.js";
import { askBudgetKeys, hashId, budgetMessage, checkAskBudget, DEFAULT_USER_DAILY_ASKS, utcDayKey } from "../../infrastructure/worker/budget.js";
import { RESEARCH_DOWN_NOTE, RESEARCH_DOWN_ANSWER } from "../../infrastructure/worker/research/provider.js";
import { WALL_RE, MEMBER_FALLBACK_LINES, memberLine, memberAck, researchTimeoutMs, guestBudgetKeys } from "../../infrastructure/worker/research/no-wall.js";
import { sha256Hex } from "../../infrastructure/worker/crypto.js";
import { resetKeyCacheForTests } from "../../infrastructure/worker/ai-keys.js";
import { resetResearchClaudeForTests, privacyBudget } from "../../infrastructure/worker/research/claude.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";
import { createDiscordSigner } from "../helpers/discord-sign.mjs";

const realFetch = globalThis.fetch;
let patches = [];
let anth = [];
let claudeText = null; // null: the Anthropic endpoint is unreachable
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.includes("/messages/@original")) { patches.push(JSON.parse(init.body)); return new Response("{}", { status: 200 }); }
  if (u.includes("anthropic")) {
    anth.push(JSON.parse(init.body));
    if (claudeText === null) return new Response("down", { status: 500 });
    return new Response(JSON.stringify({ content: [{ type: "text", text: claudeText }], usage: { input_tokens: 50, output_tokens: 20 } }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response("{}", { status: 200 });
};
test.after(() => { globalThis.fetch = realFetch; });
test.beforeEach(() => { privacyBudget.ms = 1000; /* cold JIT under a full run can pass the real 8 ms CPU budget */ resetKeyCacheForTests(); resetResearchClaudeForTests(); invalidateConfigCache(); invalidatePersonaCache(); invalidatePagesCache(); patches = []; anth = []; claudeText = null; });

const ADMIN = "admin-token-for-tests-0123456789abcdef";
const MEMBER_KEY = "member-key-for-tests-0123456789ab";
const KEY_SALT = "salt-for-tests-0123456789";
const USER_SALT = "user-salt-for-tests-0123456789";
const DISCORD_ID = "100000000000000001";
const room = { fetch: async () => new Response("ok") };
const WORKERS_TEXT = "**Onyxia's Lair opens on 2026-12-09.** Bring fire resistance.\n-# Sources: raids/onyxias-lair";
const Q = "when does onyxia open";
const signer = createDiscordSigner();
const day = () => utcDayKey();

async function makeEnv({ research = true, persona = null, extra = {} } = {}) {
  const DB = schemaDb();
  DB.raw.prepare("INSERT INTO members (slug, key_hash, created_at) VALUES ('santa', ?, '2026-11-01T00:00:00Z')").run(await sha256Hex(`${KEY_SALT}:${MEMBER_KEY}`));
  DB.raw.prepare("INSERT INTO lib_pages (id, category, title, blurb, aliases_json, facts_json, updated_at) VALUES ('raids/onyxias-lair', 'raids', 'Onyxia', 'The raid', '[]', ?, '2026-11-01T00:00:00Z')")
    .run(JSON.stringify([{ key: "onyxia.opens", value: "Onyxia's Lair opens on 2026-12-09." }]));
  DB.raw.prepare("INSERT INTO kv_state (key, json, updated_at) VALUES ('discord_members', ?, 'x')").run(JSON.stringify([{ slug: "santa", name: "Santa", match: ["santa"], id: DISCORD_ID }]));
  if (persona) DB.raw.prepare("INSERT INTO kv_state (key, json, updated_at) VALUES ('persona', ?, 'x')").run(JSON.stringify(persona));
  const env = {
    DB, BOARD_ADMIN_TOKEN: ADMIN, KEY_SALT, USER_SALT, ALLOWED_ORIGINS: "", DISCORD_PUBLIC_KEY: signer.publicKeyHex,
    BOARD_ROOM: { idFromName: () => "r", get: () => room },
    AI: { run: async () => { env.__wai = (env.__wai || 0) + 1; return { response: env.__waiReply ? env.__waiReply() : WORKERS_TEXT, usage: { prompt_tokens: 5, completion_tokens: 5 } }; } },
    ...(research ? { ASK_RESEARCH: "on" } : {}), ASK_DEADLINE_MS: "5000", ...extra,
  };
  return env;
}
const setRow = (env, key, obj) => env.DB.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES (?, ?, 'x')").run(key, JSON.stringify(obj));
const getRow = (env, key) => { const r = env.DB.raw.prepare("SELECT json FROM kv_state WHERE key = ?").get(key); return r ? JSON.parse(r.json) : null; };
const userKey = async (raw, prefix = "") => `ai_budget:${day()}:user:${prefix}${await hashId(raw)}`;
const turn = (env, id) => env.DB.raw.prepare("SELECT * FROM ask_turns WHERE id = ?").get(id);
const lastTurn = (env) => env.DB.raw.prepare("SELECT * FROM ask_turns ORDER BY rowid DESC LIMIT 1").get();

async function runPending(pending) { await Promise.allSettled(pending); }
const quiet = async (fn) => { const e = console.error, w = console.warn, l = console.log; console.error = console.warn = console.log = () => {}; try { return await fn(); } finally { console.error = e; console.warn = w; console.log = l; } };

// ---- the three surfaces --------------------------------------------------------------------------------------------------------------
async function webAsk(env, { member = true, body = {}, ip = "203.0.113.9" } = {}) {
  const pending = [];
  const headers = { "Content-Type": "application/json", "CF-Connecting-IP": ip, ...(member ? { Authorization: `Board ${MEMBER_KEY}` } : {}) };
  const res = await quiet(() => worker.fetch(new Request("https://api.test/api/intent", { method: "POST", headers, body: JSON.stringify({ kind: "ask", q: Q, ...body }) }), env, { waitUntil: (p) => pending.push(p), passThroughOnException() {} }));
  const json = await res.json().catch(() => ({}));
  await quiet(() => runPending(pending));
  return { res, json, row: json && json.id ? turn(env, json.id) : null };
}
async function discordRun(env, payload) {
  const pending = [];
  const res = await quiet(() => handleDiscordInteraction(signer.signedRequest(payload), env, { waitUntil: (p) => pending.push(p) }, "https://worker.test"));
  const ack = await res.json();
  await quiet(() => runPending(pending));
  return { ack, patches: patches.slice(), row: lastTurn(env) };
}
const base = (id = DISCORD_ID) => ({ id: "i1", application_id: "app1", token: "tok-not-real", version: 1, type: 2, channel_id: "3", member: { user: { id, username: "santa_u" }, nick: "Santa", roles: [] } });
const discordAsk = (env, id) => discordRun(env, { ...base(id), data: { name: "ask", type: 1, options: [{ name: "question", type: 3, value: Q }] } });
const discordMenu = (env, id) => discordRun(env, { ...base(id), data: { name: "Ask Leeroy", type: 3, target_id: "m1", resolved: { messages: { m1: { content: Q } } } } });
const SURFACES = {
  web: async (env) => { await setRow(env, await userKey("santa"), { neurons: 100, asks: 40 }); const r = await webAsk(env); return { text: r.row && r.row.answer, row: r.row, shown: r.row && r.row.answer }; },
  "discord /ask": async (env) => { await setRow(env, await userKey(DISCORD_ID), { neurons: 100, asks: 40 }); const r = await discordAsk(env); return { text: r.patches.at(-1) && r.patches.at(-1).content, row: r.row, ack: r.ack, shown: r.patches.map((p) => p.content).join("\n") + JSON.stringify(r.ack) }; },
  "discord Ask Leeroy": async (env) => { await setRow(env, await userKey(DISCORD_ID), { neurons: 100, asks: 40 }); const r = await discordMenu(env); return { text: r.patches.at(-1) && r.patches.at(-1).content, row: r.row, ack: r.ack, shown: r.patches.map((p) => p.content).join("\n") + JSON.stringify(r.ack) }; },
};

// ---- 1. member ask 41 is answered on all three surfaces -----------------------------------------------------------------------------------
for (const [name, run] of Object.entries(SURFACES)) {
  test(`1. ${name}: a member at ask 41 (counter at 40) gets a real answer, no wall text, and the counter keeps counting`, async () => {
    const env = await makeEnv();
    const r = await run(env);
    assert.equal(r.row.status, "answered", r.row.model);
    assert.match(r.row.answer, /Onyxia's Lair opens on 2026-12-09/);
    assert.ok(!/budget_|daily-limit/.test(r.row.model), r.row.model);
    assert.match(String(r.text), /Onyxia's Lair opens on 2026-12-09/, "what the member sees is the answer");
    assert.doesNotMatch(String(r.shown), WALL_RE, "nothing the member sees reads as a wall");
    const counted = getRow(env, await userKey(name === "web" ? "santa" : DISCORD_ID));
    assert.equal(counted.asks, 41, "the per-user counter still counts, for the owner's visibility");
  });
}

test("1. a member at 41 on Claude: Claude answers (within the monthly token cap) and the counter still counts", async () => {
  const env = await makeEnv({ extra: { ANTHROPIC_API_KEY: "sk-ant-FAKE-TEST-0000" } });
  claudeText = "**Onyxia's Lair opens on 2026-12-09.**\n-# Sources: raids/onyxias-lair";
  await setRow(env, await userKey(DISCORD_ID), { neurons: 100, asks: 40 });
  const r = await discordAsk(env);
  assert.equal(r.row.status, "answered");
  assert.match(r.row.model, /^claude:/, r.row.model);
  assert.equal(anth.length, 1);
  assert.equal(env.__wai, undefined, "Workers AI was not needed");
  assert.equal(getRow(env, await userKey(DISCORD_ID)).asks, 41, "an answer from Claude counts as an ask too");
});

test("1. the per-user cap is not special: 100 asks over the cap in a row are all answered", async () => {
  const env = await makeEnv();
  await setRow(env, await userKey("santa"), { neurons: 100, asks: 500 });
  for (let i = 0; i < 3; i++) {
    const r = await webAsk(env, { body: { q: `${Q} ${i}` } });
    assert.equal(r.row.status, "answered");
    assert.match(r.row.answer, /Onyxia/);
  }
});

// ---- 2. the neuron cap degrades, never walls -----------------------------------------------------------------------------------------------
for (const [name, ask] of [["web", async (env) => (await webAsk(env)).row], ["discord /ask", async (env) => (await discordAsk(env)).row], ["discord Ask Leeroy", async (env) => (await discordMenu(env)).row]]) {
  test(`2. ${name}: neurons exhausted for the day: a member still gets an answer (library facts, honest in-voice line), no wall text`, async () => {
    const env = await makeEnv();
    setRow(env, `ai_budget:${day()}`, { neurons: 99999, asks: 5, cron: 0 });
    const row = await ask(env);
    assert.equal(row.status, "answered", row.model);
    assert.match(row.answer, /Onyxia's Lair opens on 2026-12-09/, "the library fact is the answer");
    assert.equal(env.__wai, undefined, "Workers AI was not called past the cap");
    assert.ok(!/budget_|daily-limit/.test(row.model), row.model);
    assert.doesNotMatch(row.answer, WALL_RE);
    assert.match(row.answer, /research hand/i, "the honest line says what this is");
  });
}

test("2. neurons exhausted and the library has nothing: the in-voice honest line, still no wall", async () => {
  const env = await makeEnv();
  env.DB.raw.prepare("DELETE FROM lib_pages").run();
  setRow(env, `ai_budget:${day()}`, { neurons: 99999, asks: 5, cron: 0 });
  const r = await webAsk(env, { body: { q: "who wins the arena finals" } });
  assert.equal(r.row.status, "answered");
  assert.doesNotMatch(r.row.answer, WALL_RE);
  assert.ok(r.row.answer.trim().length > 20);
});

test("2. neurons exhausted but Claude is up: Claude still answers a member (the neuron cap is Workers AI's, not Claude's)", async () => {
  const env = await makeEnv({ extra: { ANTHROPIC_API_KEY: "sk-ant-FAKE-TEST-0000" } });
  claudeText = "**Onyxia's Lair opens on 2026-12-09.**\n-# Sources: raids/onyxias-lair";
  setRow(env, `ai_budget:${day()}`, { neurons: 99999, asks: 5, cron: 0 });
  const r = await discordAsk(env);
  assert.equal(r.row.status, "answered");
  assert.match(r.row.model, /^claude:/);
});

test("2. the tenant share is not a wall for a member either", async () => {
  const env = await makeEnv();
  setRow(env, "ai_budget_caps", { tenantSharePct: 10 });
  setRow(env, `ai_budget:${day()}:tenant:default`, { neurons: 7000, asks: 9 });
  const r = await webAsk(env);
  assert.equal(r.row.status, "answered");
  assert.match(r.row.answer, /Onyxia/);
  assert.ok(!/budget/.test(r.row.model));
});

// ---- 3. guests: still limited, and a guest flood changes nothing for members ----------------------------------------------------------------
test("3. a guest is still limited: the third public ask in an hour is a 429, with the flag on", async () => {
  const env = await makeEnv();
  const a = await webAsk(env, { member: false });
  const b = await webAsk(env, { member: false, body: { q: "second one" } });
  const c = await webAsk(env, { member: false, body: { q: "third one" } });
  assert.equal(a.res.status, 200);
  assert.equal(b.res.status, 200);
  assert.equal(c.res.status, 429);
});

test("3. guests keep their own budget keys: a separate tenant row and a separate user row from every member", async () => {
  const g = guestBudgetKeys({ userPart: "abc123" });
  const m = askBudgetKeys({ userPart: "abc123" });
  assert.equal(g.guest, true);
  assert.notEqual(g.tenantKey, m.tenantKey, "a guest flood cannot fill the members' tenant row");
  assert.notEqual(g.userKey, m.userKey);
  assert.ok(g.tenantSharePct > 0 && g.tenantSharePct < 100, "guests get a share of the day, not all of it");
});

test("3. a guest flood (guest tenant share spent): guests are refused, the member asked at the same moment is answered, and no member row moved", async () => {
  const env = await makeEnv();
  const guestShare = guestBudgetKeys({ userPart: "x" }).tenantSharePct;
  const spent = (8000 * guestShare) / 100 + 1;
  setRow(env, `ai_budget:${day()}`, { neurons: spent, asks: 30, cron: 0 }); // the global record includes the guests' spend
  setRow(env, `ai_budget:${day()}:tenant:guests`, { neurons: spent, asks: 30 });
  const guest = await webAsk(env, { member: false, ip: "198.51.100.7" });
  assert.equal(guest.res.status, 200);
  assert.match(guest.row.model, /budget|daily-limit/, "the guest is refused by the guest share");
  assert.equal(env.__wai, undefined);
  const before = JSON.stringify([getRow(env, `ai_budget:${day()}:tenant:default`), getRow(env, await userKey("santa"))]);
  const member = await webAsk(env);
  assert.equal(member.row.status, "answered");
  assert.match(member.row.answer, /Onyxia/);
  assert.ok(!/budget/.test(member.row.model));
  assert.equal(env.__wai, 1, "the member reached Workers AI: the guests' spend left room");
  assert.doesNotMatch(before, /guest/);
  assert.equal(getRow(env, `ai_budget:${day()}:tenant:default`) && getRow(env, `ai_budget:${day()}:tenant:default`).asks, 1, "only the member's own ask moved the member tenant row");
});

test("3. guest asks count against the guest tenant row only", async () => {
  const env = await makeEnv();
  const g = await webAsk(env, { member: false, ip: "198.51.100.8" });
  assert.equal(g.row.status, "answered");
  assert.equal(getRow(env, `ai_budget:${day()}:tenant:default`), null);
  assert.equal(getRow(env, `ai_budget:${day()}:tenant:guests`).asks, 1);
});

// ---- 4. the cap cannot be raised by a request parameter -------------------------------------------------------------------------------------
test("4. body and patch parameters cannot raise the cap or claim membership: a guest stays a guest", async () => {
  const env = await makeEnv();
  const guestShare = guestBudgetKeys({ userPart: "x" }).tenantSharePct;
  const spent = (8000 * guestShare) / 100 + 1;
  setRow(env, `ai_budget:${day()}`, { neurons: spent, asks: 30, cron: 0 });
  setRow(env, `ai_budget:${day()}:tenant:guests`, { neurons: spent, asks: 30 });
  const lie = { isMember: true, member: true, memberSlug: "santa", slug: "santa", userDailyAsks: 99999, tenantSharePct: 100, cap: 99999, limit: 99999, budget: { guest: false }, patch: { userDailyAsks: 99999, isMember: true, member: true, cap: 99999 }, deep: true };
  const r = await webAsk(env, { member: false, ip: "198.51.100.9", body: lie });
  assert.match(r.row.model, /budget|daily-limit/, "still refused by the guest share");
  assert.equal(env.__wai, undefined);
  const lim = [];
  for (let i = 0; i < 3; i++) lim.push((await webAsk(env, { member: false, ip: "198.51.100.10", body: { ...lie, q: `q ${i}` } })).res.status);
  assert.deepEqual(lim, [200, 200, 429], "the 2 per hour rate limit does not move");
});

test("4. the discord caps come only from the private config row, never from the interaction", async () => {
  const env = await makeEnv();
  // A non-roster Discord user is a guest: still walled at 40, whatever the interaction carries.
  await setRow(env, await userKey("100000000000000777"), { neurons: 1, asks: 40 });
  const r = await discordRun(env, { ...base("100000000000000777"), data: { name: "ask", type: 1, options: [{ name: "question", type: 3, value: Q }, { name: "cap", type: 4, value: 99999 }, { name: "member", type: 5, value: true }] } });
  assert.match(JSON.stringify(r.ack), /midnight|used your questions/i, "a non-member keeps the old behaviour");
});

// ---- 5. no wall strings anywhere a member can reach -----------------------------------------------------------------------------------------
test("5. the strings the ask paths can emit for a member (flag on) match no wall pattern", () => {
  const strings = [RESEARCH_DOWN_NOTE, RESEARCH_DOWN_ANSWER, ...MEMBER_FALLBACK_LINES];
  for (const seed of ["a", "b", "c", "d"]) {
    strings.push(memberLine(null, seed));
    strings.push(memberLine({ errorLines: ["Leeroy tripped. Try again in a moment.", "Past the limit, back at midnight.", "Too many questions, quota used."] }, seed));
    strings.push(memberLine({ errorLines: ["Leeroy tripped over a footnote."] }, seed));
  }
  for (const seed of ["a", "b", "c"]) {
    strings.push(memberAck(null, seed));
    strings.push(memberAck({ ackLines: ["Back at it in a tick, no limit on patience.", "Thinking, too many questions today"] }, seed));
    strings.push(memberAck({ ackLines: ["Leeroy is warming up..."] }, seed));
  }
  for (const s of strings) assert.doesNotMatch(s, WALL_RE, s);
  // The persona default and the old budget lines are the walls themselves: they are not on the member path any more.
  assert.match(pickLine(null, "errorLines", "x"), WALL_RE, "(the flag-off default still says it: it is only used for non-members and with the flag off)");
  assert.match(budgetMessage("budget_user"), WALL_RE);
  assert.doesNotMatch(memberLine(null, "x"), WALL_RE);
});

test("5. the delivered text on a deadline or error is wall-free for a member, even when the persona pack's own error line is a wall", async () => {
  const persona = { system: "S", ackLines: ["thinking line"], errorLines: ["Leeroy tripped over a footnote. Try again in a moment.", "Over the limit. Back at midnight."] };
  for (const mode of ["deadline", "throw"]) {
    patches = [];
    const env = await makeEnv({ persona, extra: { ASK_DEADLINE_MS: "30" } });
    invalidatePersonaCache();
    const answer = mode === "deadline" ? () => new Promise((r) => setTimeout(r, 300)) : () => Promise.reject(new Error("boom"));
    await quiet(() => answerAndDeliver({ env, interaction: { application_id: "a", token: "t" }, intentId: "none", persona, answer, memberOpen: true }));
    assert.equal(patches.length, 1, mode);
    assert.doesNotMatch(patches[0].content, WALL_RE, `${mode}: ${patches[0].content}`);
    assert.ok(patches[0].content.length > 10);
  }
});

test("5. through the handlers: a failing model plus an empty library for a member never shows a wall on any surface", async () => {
  const persona = { system: "S", ackLines: ["thinking line"], errorLines: ["Leeroy tripped over a footnote. Try again in a moment."] };
  for (const [name, run] of Object.entries({ "discord /ask": discordAsk, "discord Ask Leeroy": discordMenu })) {
    patches = [];
    const env = await makeEnv({ persona });
    env.DB.raw.prepare("DELETE FROM lib_pages").run();
    env.AI.run = async () => { throw new Error("workers ai down"); };
    await setRow(env, await userKey(DISCORD_ID), { neurons: 1, asks: 77 });
    const r = await run(env);
    const all = patches.map((p) => p.content).join("\n") + JSON.stringify(r.ack);
    assert.doesNotMatch(all, WALL_RE, name);
    assert.ok(patches.length >= 1, name);
  }
  const env = await makeEnv({ persona });
  env.DB.raw.prepare("DELETE FROM lib_pages").run();
  env.AI.run = async () => { throw new Error("workers ai down"); };
  const w = await webAsk(env);
  assert.doesNotMatch(String(w.row.answer), WALL_RE);
});

// ---- 6. refusals, errors and Off-voted answers are never reused -----------------------------------------------------------------------------
test("6. a stored budget line or error line from earlier is never reused as the answer (flag on)", async () => {
  const env = await makeEnv();
  const hashA = "a".repeat(64);
  const insert = (id, answer, status, model) => {
    env.DB.raw.prepare("INSERT INTO ask_turns (id, by_name, question, answer, model, status, share, created_at, answered_at) VALUES (?, 'Santa', ?, ?, ?, ?, 1, ?, ?)").run(id, Q, answer, model, status, new Date().toISOString(), new Date().toISOString());
    env.DB.raw.prepare("INSERT INTO ask_turn_askers (intent_id, asker_hash) VALUES (?, ?)").run(id, hashA);
  };
  insert("p1", "Leeroy is back at midnight UTC. Try again in a moment.", "answered", "workers-ai:budget_user");
  insert("p2", "Leeroy could not answer that one.", "error", "workers-ai:daily-limit");
  insert("p3", "Off-voted answer text", "answered", "workers-ai:@cf/x");
  env.DB.raw.prepare("INSERT INTO answer_feedback (intent_id, user_hash, vote, created_at) VALUES ('p3', 'u', -1, ?)").run(new Date().toISOString());
  env.DB.raw.prepare("INSERT INTO ask_turns (id, by_name, question, model, status, share, created_at) VALUES ('new1', 'Santa', ?, 'workers-ai', 'thinking', 1, ?)").run(Q, new Date().toISOString());
  env.DB.raw.prepare("INSERT INTO ask_turn_askers (intent_id, asker_hash) VALUES ('new1', ?)").run(hashA);
  await quiet(() => answerWithAi({ env, origin: "https://worker.test", intentId: "new1", by: "Santa", memberSlug: "santa", question: Q, provider: "workers-ai", share: true, isMember: true }));
  const row = turn(env, "new1");
  assert.notEqual(row.model, "reused-answer");
  assert.match(row.answer, /Onyxia's Lair opens/);
  assert.doesNotMatch(row.answer, /back at midnight|Off-voted/);
  assert.equal(env.__wai, 1, "a fresh model call, not a reuse");
});

test("6. flag on, a good earlier answer is not reused either (reuse stays off in research mode, so no refusal or Off-voted row can ever come back)", async () => {
  const env = await makeEnv();
  env.DB.raw.prepare("INSERT INTO ask_turns (id, by_name, question, answer, model, status, share, created_at, answered_at) VALUES ('g1', 'Santa', ?, 'Good earlier answer', 'workers-ai:m', 'answered', 1, ?, ?)").run(Q, new Date().toISOString(), new Date().toISOString());
  env.DB.raw.prepare("INSERT INTO ask_turn_askers (intent_id, asker_hash) VALUES ('g1', ?)").run("b".repeat(64));
  env.DB.raw.prepare("INSERT INTO ask_turns (id, by_name, question, model, status, share, created_at) VALUES ('g2', 'Santa', ?, 'workers-ai', 'thinking', 1, ?)").run(Q, new Date().toISOString());
  env.DB.raw.prepare("INSERT INTO ask_turn_askers (intent_id, asker_hash) VALUES ('g2', ?)").run("b".repeat(64));
  await quiet(() => answerWithAi({ env, origin: "https://worker.test", intentId: "g2", by: "Santa", memberSlug: "santa", question: Q, provider: "workers-ai", share: true, isMember: true }));
  assert.notEqual(turn(env, "g2").model, "reused-answer");
});

test("6. flag off: findRecentSameAnswer still never returns a budget line (unchanged)", async () => {
  const env = await makeEnv({ research: false });
  env.DB.raw.prepare("INSERT INTO ask_turns (id, by_name, question, answer, model, status, share, created_at, answered_at) VALUES ('o1', 'Santa', ?, 'Leeroy is back at midnight', 'workers-ai:budget_user', 'answered', 1, ?, ?)").run(Q, new Date().toISOString(), new Date().toISOString());
  env.DB.raw.prepare("INSERT INTO ask_turn_askers (intent_id, asker_hash) VALUES ('o1', ?)").run("c".repeat(64));
  env.DB.raw.prepare("INSERT INTO ask_turns (id, by_name, question, model, status, share, created_at) VALUES ('o2', 'Santa', ?, 'x', 'thinking', 1, ?)").run(Q, new Date().toISOString());
  env.DB.raw.prepare("INSERT INTO ask_turn_askers (intent_id, asker_hash) VALUES ('o2', ?)").run("c".repeat(64));
  assert.equal(await findRecentSameAnswer(env, { intentId: "o2", question: Q, share: true }), null);
});

// ---- 7. flag off: the walls are exactly as before (counterparts to the old wall tests) ------------------------------------------------------------
test("7. flag off: a member at ask 41 still gets the old ephemeral wall on /ask, and web/context-menu still answer through the old budget line", async () => {
  const env = await makeEnv({ research: false });
  await setRow(env, await userKey(DISCORD_ID), { neurons: 100, asks: DEFAULT_USER_DAILY_ASKS });
  const r = await discordAsk(env);
  assert.equal(r.ack.data.content, budgetMessage("budget_user"));
  assert.equal(r.ack.data.flags, 64);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM ask_turns").get().n, 0, "nothing stored, as before");
  const web = await (async () => { await setRow(env, await userKey("santa"), { neurons: 100, asks: 40 }); return webAsk(env); })();
  assert.match(web.row.model, /budget_user/);
});

test("7. flag off: a failed ask still ends with the persona line plus Try again in a moment", async () => {
  const persona = { system: "S", ackLines: ["t"], errorLines: ["Leeroy tripped over a footnote."] };
  const env = await makeEnv({ research: false, persona, extra: { ASK_DEADLINE_MS: "30" } });
  await quiet(() => answerAndDeliver({ env, interaction: { application_id: "a", token: "t" }, intentId: "none", persona, answer: () => Promise.reject(new Error("x")), memberOpen: false }));
  assert.match(patches[0].content, /Leeroy tripped over a footnote\. Try again in a moment\./);
});


// ---- W5 follow-ups: 1. guests never spend the Claude cap ---------------------------------------------------------------------------------------
const FAKE_KEY = "sk-ant-FAKE-TEST-0000";
const monthKey = () => `claude_tokens_${new Date().toISOString().slice(0, 7).replace("-", "")}`;

test("8. 60 guests (web, distinct IPs, plus a non-roster Discord user) never reach Claude and never touch its token counter; then a member gets Claude and only the member moves the counter", async () => {
  const env = await makeEnv({ extra: { ANTHROPIC_API_KEY: FAKE_KEY } });
  claudeText = "**Onyxia's Lair opens on 2026-12-09.**\n-# Sources: raids/onyxias-lair";
  for (let i = 0; i < 60; i++) {
    const g = await webAsk(env, { member: false, ip: `198.51.${i}.9`, body: { q: `guest question ${i}` } });
    assert.equal(g.row.status, "answered");
    assert.ok(!/^claude:/.test(g.row.model), g.row.model);
  }
  const d = await discordRun(env, { ...base("100000000000000777"), data: { name: "ask", type: 1, options: [{ name: "question", type: 3, value: Q }] } });
  assert.ok(!/^claude:/.test(d.row.model), d.row.model);
  assert.equal(anth.length, 0, "no request to Anthropic for any guest");
  assert.equal(getRow(env, monthKey()), null, "the Claude counter row was never created by guests");
  const m = await discordAsk(env);
  assert.match(m.row.model, /^claude:/, m.row.model);
  assert.equal(anth.length, 1);
  assert.notEqual(getRow(env, monthKey()), null, "the member moved the counter");
});

// ---- 2. the guest neuron share is reserved atomically -------------------------------------------------------------------------------------------
test("9. 60 concurrent guests on distinct IPs: the guests' neurons never pass their share while the asks are in flight, and a member asked during the flood is answered", async () => {
  const env = await makeEnv();
  const share = (8000 * guestBudgetKeys({ userPart: "x" }).tenantSharePct) / 100;
  let inflight = 0, peak = 0, maxSeen = 0;
  env.AI.run = async () => {
    inflight++; peak = Math.max(peak, inflight);
    await new Promise((r) => setTimeout(r, 25)); // hold the reservation while the others arrive
    const row = getRow(env, `ai_budget:${day()}:tenant:guests`);
    maxSeen = Math.max(maxSeen, row ? row.neurons : 0);
    inflight--;
    return { response: WORKERS_TEXT, usage: { prompt_tokens: 5, completion_tokens: 5 } };
  };
  const guests = Array.from({ length: 60 }, (_, i) => webAsk(env, { member: false, ip: `203.0.${i}.7`, body: { q: `flood ${i}` } }));
  const member = webAsk(env, { body: { q: "member during the flood" } });
  const results = await Promise.all([member, ...guests]);
  assert.equal(results[0].row.status, "answered");
  assert.match(results[0].row.answer, /Onyxia/);
  assert.ok(!/budget_/.test(results[0].row.model), results[0].row.model);
  assert.ok(maxSeen <= share, `guest neurons in flight ${maxSeen} passed the share ${share}`);
  assert.ok(peak < 60, `peak concurrent Workers AI calls ${peak}: the reservation must have refused some`);
  for (const g of results.slice(1)) assert.equal(g.row.status, "answered", "a refused guest reservation falls back to library facts, still an answer");
  const after = getRow(env, `ai_budget:${day()}:tenant:guests`);
  assert.ok(after.neurons <= share, "settled total within the share");
});

// ---- 3. ack lines are filtered like error lines ------------------------------------------------------------------------------------------------------
test("10. persona ackLines that read as a wall never reach a member (Discord /ask and Ask Leeroy); a clean line is still used", async () => {
  for (const run of [discordAsk, discordMenu]) {
    let env = await makeEnv({ persona: { system: "S", ackLines: ["Back at it in a tick, no limit on patience."], errorLines: [] } });
    let r = await run(env);
    assert.doesNotMatch(r.ack.data.content, WALL_RE, r.ack.data.content);
    assert.ok(r.ack.data.content.length > 3);
    env = await makeEnv({ persona: { system: "S", ackLines: ["Back at it in a tick, no limit on patience.", "Leeroy is warming up..."], errorLines: [] } });
    invalidatePersonaCache();
    r = await run(env);
    assert.equal(r.ack.data.content, "Leeroy is warming up...");
  }
});

// ---- 4. validation strings are not walls, said explicitly --------------------------------------------------------------------------------------------
// The client's own input checks ("That is 12 over the 280 character limit.") say "limit" about what the member typed, not about how many questions they may ask.
// They are the only strings in the ask UI allowed to match WALL_RE, and only in this exact shape. WALL_RE itself stays strict.
const VALIDATION_OK = /^That is (?:\$\{n - MAX\} )?over the \$\{MAX\} character limit\.$|^Model: Cloudflare Workers AI \(2\/hr limit\)$/; // the second alternative is the model label shown only when isGuest (scenes/chamber.js); a member sees the Llama label
test("11. every wall-pattern string in the ask UI files is the typed-length validation message", async () => {
  const { readFileSync } = await import("node:fs");
  for (const f of ["js/ask.js", "scenes/chamber.js"]) {
    const src = readFileSync(new URL(`../../${f}`, import.meta.url), "utf8");
    const found = [...src.matchAll(/`([^`\n]*)`|"([^"\n]*)"/g)].map((m) => m[1] ?? m[2]).filter((t) => /^[A-Z][a-z]/.test(t) && WALL_RE.test(t)); // user-facing text only: a bare token like the "limited" state name is not a string anyone reads
    for (const t of found) assert.match(t, VALIDATION_OK, `${f}: ${t}`);
  }
});

// ---- 5. deadline margin ---------------------------------------------------------------------------------------------------------------------------------
test("12. researchTimeoutMs keeps every Workers AI attempt inside deadline minus 4 s", () => {
  assert.equal(researchTimeoutMs(0, 12000), 12000);
  assert.equal(researchTimeoutMs(9000, 12000), 11000);
  assert.equal(researchTimeoutMs(12000, 9000), 8000);
  assert.equal(researchTimeoutMs(19900, 9000), 1000, "never below 1 s");
});

test("12. worst case with a faked clock: Claude takes 9 s, then Workers AI; every Workers AI attempt ends by 20 s, and a retry only starts at or before 12 s", async () => {
  const realNow = Date.now, realTimeout = AbortSignal.timeout;
  for (const [firstCost, expectRetry] of [[3000, true], [4000, false]]) {
    const env = await makeEnv({ extra: { ANTHROPIC_API_KEY: FAKE_KEY } });
    let clock = 1_800_000_000_000;
    const start = clock;
    Date.now = () => clock;
    let lastMs = null; const ai = [];
    AbortSignal.timeout = (ms) => { lastMs = ms; return new AbortController().signal; };
    const prevFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => { if (String(url).includes("anthropic")) { clock += 9000; return new Response("down", { status: 500 }); } return prevFetch(url, init); };
    env.AI.run = async () => { ai.push({ at: clock - start, ms: lastMs }); clock += firstCost; return { response: "I can't help with that.", usage: { prompt_tokens: 5, completion_tokens: 5 } }; };
    try {
      const r = await webAsk(env);
      assert.equal(r.row.status, "answered", r.row.model);
    } finally { Date.now = realNow; AbortSignal.timeout = realTimeout; globalThis.fetch = prevFetch; }
    assert.equal(ai.length, expectRetry ? 2 : 1, JSON.stringify(ai));
    for (const a of ai) assert.ok(a.at + a.ms <= 20000, `attempt at ${a.at} with ${a.ms} ms ends after 20 s`);
    assert.equal(ai[0].ms, 11000);
    if (expectRetry) assert.ok(ai[1].at <= 12000);
  }
});
