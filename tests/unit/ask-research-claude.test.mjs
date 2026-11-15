// W-wire: /ask research mode provider order Claude -> Workers AI -> library facts, with every outside call after tokenisation and the outbound guards.
// Offline: a fake Anthropic endpoint (fake fetch), a fake Workers AI binding, an in-memory D1. Fake key only. Fictional names only; the real roster is read at
// runtime from bot-data.js (never copied here, never printed). Run: node --test tests/unit/ask-research-claude.test.mjs
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { answerWithAi, invalidatePagesCache, fetchWithGatewayFallback } from "../../infrastructure/worker/ai-models.js";
import { invalidatePersonaCache } from "../../infrastructure/worker/persona.js";
import { invalidateConfigCache } from "../../infrastructure/worker/config.js";
import { resetKeyCacheForTests } from "../../infrastructure/worker/ai-keys.js";
import { ROSTER_DATA } from "../../infrastructure/worker/bot-data.js";
import { scanBody, CANARY } from "../../infrastructure/worker/privacy/outbound-guard.js";
import { researchRoster, setFirstNameSource, genericAliases } from "../../infrastructure/worker/privacy/roster-config.js";
import { resetResearchClaudeForTests, privacyBudget, classifyField, STRUCTURED_FIELDS, FREE_TEXT_FIELDS, prepareResearchPrivacy, reserveTokens, counterKey, estimateTokens, usageTokens } from "../../infrastructure/worker/research/claude.js";
import { buildNameMap, tokenise } from "../../infrastructure/worker/privacy/tokenise.js";
import { RESEARCH_MAX_TOKENS } from "../../infrastructure/worker/research/rules.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";

const FAKE_KEY = "sk-ant-FAKE-TEST-0000";
const DEFAULT_BUDGET_MS = privacyBudget.ms;
const realFetch = globalThis.fetch;
let anth = []; // every compose-side request to an Anthropic URL: { model, body, headers }
const understandSends = [];
const UNDERSTAND_TOKENS = 1; // what the fake understand reply reports as usage
let others = []; // every other fetch URL
let wai = []; // Workers AI inputs
let claudeAnswer = () => ({ status: 200, text: "**Short answer first.**\nThat is how Classic handled it.\n-# Sources: general Classic-era knowledge · unconfirmed" });
let waiAnswer = () => "**Workers answer first.**\nThat is how Classic handled it.\n-# Sources: general Classic-era knowledge · unconfirmed";
let waiThrows = false;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes("anthropic")) {
    const body = JSON.parse(init.body);
    // The understand step (research/understand.js, 120-token Haiku-class send, own test file) is answered here and kept out of `anth`, so these tests keep counting COMPOSE sends only.
    // It reports 1 token of usage, so each ask adds UNDERSTAND_TOKENS to the monthly counter.
    if (body.max_tokens === 120) { understandSends.push(body); return new Response(JSON.stringify({ content: [{ type: "text", text: '{"kind":"game_fact","depth":"standard"}' }], usage: { input_tokens: 1, output_tokens: 0 } }), { status: 200, headers: { "content-type": "application/json" } }); }
    anth.push({ model: body.model, body, raw: init.body, headers: { ...init.headers }, url: u });
    const r = claudeAnswer(body, anth.length);
    if (r.throws) throw r.throws;
    const usage = r.usage === undefined ? { input_tokens: 111, output_tokens: 22 } : r.usage;
    if (r.errBody) return new Response(JSON.stringify(r.errBody), { status: r.status, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ content: r.text === undefined ? [] : [{ type: "text", text: r.text }], ...(usage ? { usage } : {}) }), { status: r.status, headers: { "content-type": "application/json" } });
  }
  others.push(u);
  return new Response("{}", { status: 200 });
};
const fakeAi = { run: async (_m, inputs) => { wai.push(inputs); if (waiThrows) throw new Error("workers ai down"); return { response: waiAnswer(inputs), usage: { prompt_tokens: 5, completion_tokens: 5 } }; } };
test.after(() => { globalThis.fetch = realFetch; });
test.beforeEach(() => { resetKeyCacheForTests(); setFirstNameSource(null); resetResearchClaudeForTests(); privacyBudget.ms = 1000; }); // cold JIT in a test run can exceed the real 8 ms budget; the CPU test sets its own

const f = (value) => ({ value, visible: true, source: "board", at: "2026-11-01T00:00:00.000Z" });
const SHEETS = [{ slug: "red-fox", name: "Red Fox", fields: { class: f("paladin"), race: f("human"), level: f(12) }, updated: "x" }];
const TANK_PAGE = { id: "classes/tanking", category: "classes", title: "Tanking", blurb: "Who tanks", facts: [{ key: "tanking.tonight", value: "Who tanks tonight is agreed in the party channel." }] };
const ABSTAIN_Q = "tell me about the weather";
const NAMES = ROSTER_DATA.map((r) => r.display); // runtime only
const month = () => new Date().toISOString().slice(0, 7).replace("-", "");
const bodiesText = (list) => list.map((b) => JSON.stringify(b)).join("\n=====\n");

let n = 0;
async function ask(question, { by = "Red Fox", memberSlug = "red-fox", research = true, key = true, deep = false, env: envPatch = null, db = null, claude = null, wai: waiFn = null, waiFail = false, provider = "groq", isMember = true, sheets = null, state = null } = {}) {
  invalidatePersonaCache(); invalidatePagesCache(); invalidateConfigCache();
  const DB = db || schemaDb();
  DB.raw.prepare("INSERT OR REPLACE INTO lib_pages (id, category, title, blurb, aliases_json, facts_json, updated_at) VALUES (?, ?, ?, ?, '[]', ?, '2026-11-01T00:00:00Z')").run(TANK_PAGE.id, TANK_PAGE.category, TANK_PAGE.title, TANK_PAGE.blurb, JSON.stringify(TANK_PAGE.facts));
  DB.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES ('party_sheets', ?, 'x')").run(JSON.stringify(sheets || SHEETS));
  for (const [k, v] of Object.entries(state || {})) DB.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES (?, ?, 'x')").run(k, JSON.stringify(v));
  const env = { DB, AI: fakeAi, GROQ_API_KEY: "test-key-not-real", GEMINI_API_KEY: "test-gemini-not-real", ...(key ? { ANTHROPIC_API_KEY: FAKE_KEY } : {}), ...(research ? { ASK_RESEARCH: "on" } : {}), BOARD_ROOM: { idFromName: () => "r", get: () => ({ fetch: async () => new Response("ok") }) } };
  if (envPatch) envPatch(env);
  const id = `cw${++n}`;
  DB.raw.prepare("INSERT INTO ask_turns (id, by_name, question, model, status, share, created_at) VALUES (?, ?, ?, 'groq', 'thinking', 1, 'x')").run(id, by, question);
  anth = []; others = []; wai = []; waiThrows = waiFail;
  claudeAnswer = claude || (() => ({ status: 200, text: "**Short answer first.**\nThat is how Classic handled it.\n-# Sources: general Classic-era knowledge · unconfirmed" }));
  waiAnswer = waiFn || (() => "**Workers answer first.**\nThat is how Classic handled it.\n-# Sources: general Classic-era knowledge · unconfirmed");
  const logs = [];
  const real = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of Object.keys(real)) console[k] = (...a) => logs.push(a.map(String).join(" "));
  try { await answerWithAi({ env, origin: "https://worker.test", intentId: id, by, memberSlug, question, provider, share: true, deep, journey: "curious", isMember }); } finally { Object.assign(console, real); }
  const row = DB.raw.prepare("SELECT answer, model, status FROM ask_turns WHERE id = ?").get(id);
  return { DB, env, row: { ...row }, answer: row.answer, anth: anth.slice(), wai: wai.slice(), others: others.slice(), logs, dump: () => JSON.stringify(DB.raw.prepare("SELECT * FROM kv_state").all()) + JSON.stringify(DB.raw.prepare("SELECT * FROM ask_turns").all()) };
}

test("order: Claude answers first, with the research model, 700 tokens, no cache, and Workers AI is not called", async () => {
  const r = await ask(ABSTAIN_Q);
  assert.equal(r.anth.length, 1, r.row.model);
  assert.equal(r.wai.length, 0);
  assert.equal(r.anth[0].model, "claude-sonnet-5-5", "research compose is the Sonnet-class (deep) model");
  assert.equal(r.anth[0].body.max_tokens, 700);
  assert.match(r.row.model, /^claude:claude-sonnet-5-5\+research/);
  assert.match(r.answer, /Short answer first/);
  assert.equal(r.anth[0].headers["x-api-key"], FAKE_KEY);
  assert.ok(!r.anth[0].raw.includes(FAKE_KEY), "the key is a header, never in the body");
  assert.deepEqual(r.others.filter((u) => /groq|gemini|googleapis|openrouter|cerebras|azure/.test(u)), [], "no other provider ever sees the ask");
});

test("compose always uses the deep research model: the ask's deep flag no longer picks the Haiku-class one", async () => {
  for (const deep of [false, true]) {
    const r = await ask(ABSTAIN_Q, { deep });
    assert.deepEqual(r.anth.map((a) => a.model), ["claude-sonnet-5-5"], `deep=${deep}`);
  }
});

test("Claude unavailable: Workers AI answers and no Anthropic request is made", async () => {
  const r = await ask(ABSTAIN_Q, { key: false });
  assert.equal(r.anth.length, 0);
  assert.equal(r.wai.length, 1);
  assert.match(r.row.model, /^workers-ai:/);
  assert.match(r.answer, /Workers answer first/);
});

test("Claude 429, 500, 401 and a timeout each fall to Workers AI inside the ask deadline", async () => {
  for (const c of [{ status: 429 }, { status: 500 }, { status: 401 }, { status: 200, throws: Object.assign(new Error("t"), { name: "TimeoutError" }) }]) {
    const t0 = Date.now();
    const r = await ask(ABSTAIN_Q, { claude: () => c });
    assert.equal(r.wai.length, 1, JSON.stringify(c.status));
    assert.match(r.answer, /Workers answer first/);
    assert.ok(Date.now() - t0 < 5000);
    assert.ok(!r.logs.join("\n").includes(FAKE_KEY));
    assert.ok(!r.dump().includes(FAKE_KEY));
  }
});

test("an empty Claude answer falls to Workers AI", async () => {
  const r = await ask(ABSTAIN_Q, { claude: () => ({ status: 200, text: "" }) });
  assert.equal(r.wai.length >= 1, true);
  assert.match(r.answer, /Workers answer first/);
});

test("both down: library facts with the honest line, and still no other provider", async () => {
  const r = await ask("who tanks tonight", { claude: () => ({ status: 500 }), waiFail: true });
  assert.match(r.answer, /agreed in the party channel/);
  assert.deepEqual(r.others.filter((u) => /groq|gemini|googleapis|openrouter|cerebras|azure/.test(u)), []);
  const r2 = await ask(ABSTAIN_Q, { claude: () => ({ status: 500 }), waiFail: true });
  assert.ok(r2.answer && r2.answer.length > 20);
});

test("model id: a 404 on the new id retries once with the 4.5 fallback id", async () => {
  const NF = (m) => ({ status: 404, errBody: { type: "error", error: { type: "not_found_error", message: `model: ${m}` } } });
  const r = await ask(ABSTAIN_Q, { claude: (body) => (body.model === "claude-sonnet-5-5" ? NF(body.model) : { status: 200, text: "**Fallback model answer.**\nThat is how Classic handled it.\n-# Sources: general Classic-era knowledge · unconfirmed" }) });
  assert.deepEqual(r.anth.map((a) => a.model), ["claude-sonnet-5-5", "claude-sonnet-4-5-20250929"]);
  assert.match(r.answer, /Fallback model answer/);
  assert.equal(r.wai.length, 0);
  const both = await ask(ABSTAIN_Q, { claude: (b) => NF(b.model) });
  assert.deepEqual(both.anth.map((a) => a.model), ["claude-sonnet-5-5", "claude-sonnet-4-5-20250929"], "exactly one retry");
  assert.equal(both.wai.length, 1);
  const custom = await ask(ABSTAIN_Q, { env: (e) => { e.RESEARCH_CLAUDE_MODEL_DEEP = "model-x"; e.RESEARCH_CLAUDE_FALLBACK_DEEP = "model-y"; }, claude: (b) => (b.model === "model-x" ? { status: 400, errBody: { type: "error", error: { type: "invalid_request_error", message: "model: model-x does not exist" } } } : { status: 200, text: "**Ok answer.**\nThat is how Classic handled it.\n-# Sources: general Classic-era knowledge · unconfirmed" }) });
  assert.deepEqual(custom.anth.map((a) => a.model), ["model-x", "model-y"]);
});

test("token counter: usage is added to claude_tokens_YYYYMM; the cap sends later asks to Workers AI with one alert row a month", async () => {
  const E = await learnE(); // the estimate this ask reserves; the cap below fits three of them
  const cap = String(3 * E);
  const db = schemaDb();
  const r1 = await ask(ABSTAIN_Q, { db, env: (e) => { e.RESEARCH_CLAUDE_MONTHLY_TOKENS = cap; } });
  assert.equal(r1.anth.length, 1);
  const key = `claude_tokens_${month()}`;
  assert.equal(Number(db.raw.prepare("SELECT json FROM kv_state WHERE key = ?").get(key).json), 133 + UNDERSTAND_TOKENS);
  // 133 < 200: still allowed; this one pushes it to 266
  const r2 = await ask(ABSTAIN_Q, { db, env: (e) => { e.RESEARCH_CLAUDE_MONTHLY_TOKENS = cap; } });
  assert.equal(r2.anth.length, 1);
  assert.equal(Number(db.raw.prepare("SELECT json FROM kv_state WHERE key = ?").get(key).json), 266 + 2 * UNDERSTAND_TOKENS);
  assert.equal(db.raw.prepare("SELECT COUNT(*) c FROM kv_state WHERE key LIKE 'alert:claude-cap:%'").get().c, 0);
  db.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES (?, ?, 'x')").run(key, String(2 * E + 1)); // 2E+1 used of 3E: the whole reservation no longer fits
  for (let i = 0; i < 3; i++) {
    const r = await ask(ABSTAIN_Q, { db, env: (e) => { e.RESEARCH_CLAUDE_MONTHLY_TOKENS = cap; } });
    assert.equal(r.anth.length, 0, "when the reservation does not fit under the cap Claude is skipped");
    assert.equal(r.wai.length, 1);
    assert.match(r.answer, /Workers answer first/);
  }
  const alerts = db.raw.prepare("SELECT key, json FROM kv_state WHERE key LIKE 'alert:claude-cap:%'").all();
  assert.equal(alerts.length, 1, "one alert row per month");
  assert.equal(alerts[0].key, `alert:claude-cap:${month()}`);
  assert.ok(!alerts[0].json.includes("Red Fox"));
  assert.ok(!alerts[0].json.includes(FAKE_KEY));
  // default cap and an invalid value both mean 2,000,000, not unlimited
  db.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES (?, '2000000', 'x')").run(key);
  for (const v of [undefined, "abc", "-5", ""]) {
    const r = await ask(ABSTAIN_Q, { db, env: (e) => { if (v !== undefined) e.RESEARCH_CLAUDE_MONTHLY_TOKENS = v; } });
    assert.equal(r.anth.length, 0, `cap value ${v}`);
  }
});

test("a counter read failure skips Claude (fails to Workers AI, never to unlimited Claude)", async () => {
  const db = schemaDb();
  const real = db.prepare;
  db.prepare = (sql) => {
    const s = real(sql);
    const bind = s.bind;
    s.bind = (...a) => (String(a[0] || "").startsWith("claude_tokens_") ? { first: async () => { throw new Error("d1 down"); }, all: async () => { throw new Error("d1 down"); }, run: async () => { throw new Error("d1 down"); } } : bind(...a));
    return s;
  };
  const r = await ask(ABSTAIN_Q, { db });
  assert.equal(r.anth.length, 0);
  assert.equal(r.wai.length, 1);
  assert.match(r.answer, /Workers answer first/);
});

test("a Claude request never carries a roster name: the prompt is tokenised, tokens come back as display names", async () => {
  const target = NAMES[2];
  const r = await ask(`what should ${target} play and what is the weather like`, {
    claude: (body) => {
      const tok = (body.messages[0].content.match(/what should (\{P\d+\.[a-z0-9]+\}) play/) || [])[1];
      return { status: 200, text: `**${tok} should play whatever is fun.**\nThat is how Classic handled it.\n-# Sources: general Classic-era knowledge · unconfirmed` };
    },
  });
  assert.equal(r.anth.length, 1);
  const all = bodiesText(r.anth.map((a) => a.body));
  assert.ok(!all.toLowerCase().includes(target.toLowerCase()));
  assert.ok(/\{P\d+\.[a-z0-9]{4}\}/.test(all), "tokens are in the request");
  assert.ok(r.answer.includes(target), "the reply carries the DISPLAY name again");
  assert.ok(!/\{P\d/.test(r.answer));
  assert.deepEqual(scanBody(r.anth[0].body, researchRoster()), []);
});

test("nonce tolerance: a reply whose token has a mis-copied nonce on a valid index is NOT discarded and restores the display name", async () => {
  const target = NAMES[2];
  const r = await ask(`what should ${target} play and what is the weather like`, {
    claude: (body) => {
      const [, idx, nonce] = body.messages[0].content.match(/what should \{P(\d+)\.([a-z0-9]+)\} play/);
      const wrongNonce = nonce === "702f" ? "0abc" : "702f";
      return { status: 200, text: `**{P${idx}.${wrongNonce}} should play whatever is fun.**
That is how Classic handled it.
-# Sources: general Classic-era knowledge · unconfirmed` };
    },
  });
  assert.equal(r.anth.length, 1);
  assert.equal(r.wai.length, 0, "answered by Claude, not discarded");
  assert.match(r.row.model, /^claude:/);
  assert.ok(r.answer.includes(target), "display name restored");
  assert.ok(!/\{P\d/.test(r.answer));
});

test("nonce tolerance: a wrong nonce on an index that is not in the map is still discarded", async () => {
  const r = await ask(ABSTAIN_Q, { claude: () => ({ status: 200, text: "**{P99.702f} should play whatever is fun.**\nThat is how Classic handled it.\n-# Sources: general knowledge · unconfirmed" }) });
  assert.equal(r.wai.length >= 1, true);
  assert.match(r.answer, /Workers answer first/);
});

test("nonce tolerance: a token typed in the QUESTION is escaped to brackets, never sent as a brace token, and a reply echoing it as a brace token stays discarded when the index is absent", async () => {
  const r = await ask("what about {P1.abcd} and {P77.abcd} in the weather", { claude: () => ({ status: 200, text: "**Plain answer.**\nThat is how Classic handled it.\n-# Sources: general Classic-era knowledge · unconfirmed" }) });
  assert.equal(r.anth.length, 1);
  const body = r.anth[0].body.messages[0].content;
  assert.ok(body.includes("[P1.ABCD]") && body.includes("[P77.ABCD]"), "escaped to brackets");
  assert.ok(!body.includes("{P1.abcd}") && !body.includes("{P77.abcd}"));
  assert.match(r.answer, /Plain answer/);
});

test("a reply with a bare token, a foreign-nonce token on an unknown index, or an id token is discarded and Workers AI answers", async () => {
  for (const bad of ["{P1}", "{P99.zzzz}", "{ID.zzzz}", "{ p1 }"]) {
    const r = await ask(ABSTAIN_Q, { claude: () => ({ status: 200, text: `**${bad} should play whatever is fun.**\nThat is how Classic handled it.\n-# Sources: general knowledge · unconfirmed` }) });
    assert.equal(r.wai.length >= 1, true, bad);
    assert.match(r.answer, /Workers answer first/, bad);
    assert.ok(!r.answer.includes("someone"), bad);
  }
});

test("a reply naming a first name (injected, fictional) is discarded; the same name typed by the asker is tokenised", async () => {
  setFirstNameSource((m, i) => (i === 0 ? ["Zorbal"] : []));
  const leak = await ask(ABSTAIN_Q, { claude: () => ({ status: 200, text: "**Zorbal should play whatever is fun.**\nThat is how Classic handled it.\n-# Sources: general knowledge · unconfirmed" }) });
  assert.equal(leak.wai.length >= 1, true);
  assert.ok(!/Zorbal/.test(leak.answer));
  const typed = await ask("what does Zorbal think of the weather");
  assert.ok(!bodiesText(typed.anth.map((a) => a.body)).includes("Zorbal"));
  assert.equal(typed.anth.length, 1, "tokenised, so Claude is still used");
  const odd = await ask("what does Z o r b a l think of the weather");
  assert.ok(!bodiesText([...odd.anth.map((a) => a.body), ...odd.wai]).includes("Z o r b a l"));
});

function oddForms(name) {
  const lower = name.toLowerCase();
  const rev = [...lower].reverse().join("");
  const spaced = [...name].join(" ");
  const dotted = [...name].join(".");
  const zw = [...name].join("​");
  const leet = lower.replace(/a/g, "4").replace(/e/g, "3").replace(/i/g, "1").replace(/o/g, "0");
  const ent = [...name].map((c) => `&#${c.codePointAt(0)};`).join("");
  const b64 = Buffer.from(name).toString("base64");
  const hex = Buffer.from(name).toString("hex");
  const cyr = name.replace(/a/g, "а").replace(/e/g, "е").replace(/o/g, "о");
  return { upper: name.toUpperCase(), spaced, dotted, zw, leet, ent, b64, hex, rev, cyr, mixed: [...name].map((c, i) => (i % 2 ? c.toUpperCase() : c.toLowerCase())).join("") };
}

test("odd forms of real roster names: never a roster identifier in an outbound body; encodings the tokeniser misses stop Claude entirely", async () => {
  for (const name of NAMES) {
    for (const [form, text] of Object.entries(oddForms(name))) {
      const r = await ask(`what does ${text} think about the weather`);
      const all = [...r.anth.map((a) => a.body), ...r.wai];
      const txt = bodiesText(all);
      assert.ok(!txt.toLowerCase().includes(name.toLowerCase()), `${form} leaked the raw name`);
      assert.deepEqual(scanBody(r.anth.map((a) => a.body), researchRoster()), [], `${form} failed the body check`);
      if (/^(b64|hex|rev)$/.test(form)) assert.ok(r.anth.length === 0 || !bodiesText(r.anth.map((x) => x.body)).includes(text), `${form} must not reach Claude as typed`);
      if (r.anth.length === 0) assert.equal(r.wai.length >= 1, true, `${form}: Workers AI must answer`);
      assert.ok(r.answer && r.answer.length > 10, form);
    }
  }
});

test("the canary and an id in the question stop Claude (guard hit: Workers AI answers, never a refusal)", async () => {
  for (const q of [`weather ${CANARY}`, "weather 123456789012345678", "weather <@123456789012345678>", "weather @everyone"]) {
    const r = await ask(q);
    assert.ok(!bodiesText(r.anth.map((a) => a.body)).includes(CANARY));
    assert.ok(!bodiesText(r.anth.map((a) => a.body)).includes(CANARY), "the canary never reaches Anthropic");
    assert.ok(!/123456789012345678/.test(bodiesText(r.anth.map((a) => a.body))));
    assert.ok(r.answer && !/can't|cannot|refuse|not allowed/i.test(r.answer));
  }
});

test("a guard hit records a short non-identifying reason code and no value", async () => {
  const r = await ask(`what does ${Buffer.from(NAMES[0]).toString("base64")} think`);
  assert.equal(r.anth.length, 0);
  assert.match(r.row.model, /guard:[a-z-]+/);
  assert.ok(!r.row.model.toLowerCase().includes(NAMES[0].toLowerCase()));
});

test("property: 200 seeded asks with the real roster, no identifier in any outbound body, no key, no canary", async () => {
  let seed = 20261114;
  const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const nonGeneric = ROSTER_DATA.flatMap((r) => [r.display, ...r.aliases]).filter((x) => !genericAliases.includes(x.toLowerCase()));
  const stems = ["what should", "does", "is it true that", "tell me what", "did", "can you explain why", "how does"];
  const tails = ["think about the weather", "play at level 10", "know about the auction house", "need for the dungeon run", "say about fishing", "feel about boats"];
  let claude = 0, workers = 0, blocked = 0;
  const odd = Object.keys(oddForms("Examplemage"));
  for (let i = 0; i < 200; i++) {
    const base = pick(nonGeneric);
    const form = rnd() < 0.5 ? base : oddForms(base)[pick(odd)];
    const q = `${pick(stems)} ${form} ${pick(tails)}${rnd() < 0.2 ? ` ${pick(NAMES)}'s idea` : ""}`;
    const r = await ask(q, { by: rnd() < 0.3 ? pick(NAMES) : "Red Fox", memberSlug: "x" });
    const bodies = [...r.anth.map((a) => a.body), ...r.wai];
    const txt = bodiesText(bodies);
    const low = txt.toLowerCase();
    for (const nme of nonGeneric) assert.ok(!low.includes(nme.toLowerCase()), `ask ${i} (${q.length} chars) carried a roster identifier`);
    assert.ok(!low.includes(CANARY.toLowerCase()) && !txt.includes(FAKE_KEY));
    assert.deepEqual(scanBody(bodies, researchRoster()), [], `ask ${i} failed the body scan`);
    assert.ok(!r.dump().includes(FAKE_KEY));
    claude += r.anth.length > 0 ? 1 : 0; workers += r.anth.length === 0 ? 1 : 0; blocked += /guard:/.test(r.row.model) ? 1 : 0;
  }
  console.log(`[property] claude=${claude} workers-ai-only=${workers} guard-blocked=${blocked} of 200`);
  assert.ok(claude + workers === 200);
});

test("the key never appears in a body, a console line or a stored row across failure modes", async () => {
  for (const c of [{ status: 200 }, { status: 500 }, { status: 404 }, { status: 200, throws: new Error(`boom ${FAKE_KEY}`) }]) {
    const r = await ask(ABSTAIN_Q, { claude: () => c });
    assert.ok(!bodiesText([...r.anth.map((a) => a.body), ...r.wai]).includes(FAKE_KEY));
    assert.ok(!r.logs.join("\n").includes(FAKE_KEY));
    assert.ok(!r.dump().includes(FAKE_KEY));
    assert.ok(!r.dump().includes("sk-ant-"));
  }
});

test("ASK_RESEARCH off: the old path, byte for byte (real names in the prompt, legacy model id, 350 tokens, no counter, no guard label)", async () => {
  const db = schemaDb();
  const r = await ask("who tanks tonight", { research: false, provider: "claude", db });
  assert.equal(r.anth.length, 1);
  assert.equal(r.anth[0].model, "claude-haiku-4-5-20251001");
  assert.equal(r.anth[0].body.max_tokens, 350);
  assert.ok(!/\{P\d+\.[a-z0-9]+\}/.test(r.anth[0].raw), "no tokens flag-off");
  assert.ok(r.anth[0].raw.includes(NAMES[0]) || r.anth[0].raw.includes("Santa"), "the legacy prompt still names the party");
  assert.equal(db.raw.prepare("SELECT COUNT(*) c FROM kv_state WHERE key LIKE 'claude_tokens_%' OR key LIKE 'alert:claude-cap:%'").get().c, 0);
  assert.ok(!/research|guard:/.test(r.row.model));
  const golden = JSON.parse(readFileSync(new URL("./fixtures/ask-research-golden.json", import.meta.url), "utf8"));
  assert.ok(golden);
});

test("wrangler.toml declares the research Claude vars; the key is not in the file", () => {
  const toml = readFileSync(new URL("../../infrastructure/wrangler.toml", import.meta.url), "utf8");
  assert.match(toml, /^RESEARCH_CLAUDE_MODEL_FAST = "claude-haiku-5-5"/m);
  assert.match(toml, /^RESEARCH_CLAUDE_MODEL_DEEP = "claude-sonnet-5-5"/m);
  assert.match(toml, /^RESEARCH_CLAUDE_FALLBACK_FAST = "claude-haiku-4-5-20251001"/m);
  assert.match(toml, /^RESEARCH_CLAUDE_FALLBACK_DEEP = "claude-sonnet-4-5-20250929"/m);
  assert.match(toml, /^RESEARCH_CLAUDE_MONTHLY_TOKENS = "2000000"/m);
  assert.match(toml, /^CLAUDE_MODEL_FAST = "claude-haiku-4-5-20251001"/m, "legacy vars unchanged");
  assert.ok(!/sk-ant-/.test(toml));
});

test("docs: secrets.md no longer says every deploy re-puts the key; flags.md documents the order, the guards and the cap", () => {
  const secrets = readFileSync(new URL("../../docs/runbooks/secrets.md", import.meta.url), "utf8");
  const flags = readFileSync(new URL("../../docs/runbooks/flags.md", import.meta.url), "utf8");
  assert.ok(!/every deploy/i.test(secrets.split("\n").filter((l) => /ANTHROPIC_API_KEY/.test(l)).join("\n")));
  assert.match(secrets, /non-empty/i);
  for (const k of ["RESEARCH_CLAUDE_MONTHLY_TOKENS", "RESEARCH_CLAUDE_MODEL_FAST", "claude_tokens_", "guard:"]) assert.ok(flags.includes(k), k);
});

// ======================= round 2 (Fable attack on 584ba402) =======================
const noSpace = (x) => x.replace(/\s+/g, "");
const vis = (value) => ({ value, visible: true, source: "board", at: "2026-11-01T00:00:00.000Z" });
const sheetOf = (fields, extra = {}) => [{ slug: "red-fox", name: "Red Fox", fields, updated: "x", ...extra }];
const anthText = (r) => bodiesText(r.anth.map((a) => a.body));
const OKTEXT = "**Fallback ok.**\nThat is how Classic handled it.\n-# Sources: general knowledge · unconfirmed";

test("1. a structured sheet field with an obfuscated roster name stops Claude (b64, hex, reversed, xx-wrapped); nothing reaches Anthropic verbatim", async () => {
  const name = NAMES[2];
  for (const v of [Buffer.from(name).toString("base64"), Buffer.from(name).toString("hex"), [...name.toLowerCase()].reverse().join(""), `mining with xx${noSpace(name)}xx`]) {
    const r = await ask(ABSTAIN_Q, { sheets: sheetOf({ class: vis("paladin"), professions: vis(v) }) });
    assert.ok(!anthText(r).includes(v), `field ${v.slice(0, 6)} reached Anthropic verbatim`);
    assert.ok(!anthText(r).toLowerCase().includes(name.toLowerCase()));
    assert.equal(r.wai.length >= 1 || r.anth.length >= 1, true);
  }
  const hex = await ask(ABSTAIN_Q, { sheets: sheetOf({ professions: vis(Buffer.from(name).toString("hex")) }) });
  assert.equal(hex.anth.length, 0, "a structured field the guard rejects means no Claude call");
  assert.match(hex.row.model, /guard:/);
  assert.match(hex.answer, /Workers answer first/);
});

test("1. the tonight title and sign-up keys and values are guarded: an obfuscated name there stops Claude", async () => {
  const hex = Buffer.from(NAMES[0]).toString("hex");
  for (const state of [{ tonight: { title: `raid ${hex}` } }, { signups: { roster: { [hex]: "yes" } } }, { signups: { roster: { someone: `note ${hex}` } } }]) {
    const r = await ask(ABSTAIN_Q, { state });
    assert.equal(r.anth.length, 0, JSON.stringify(state).slice(0, 30));
    assert.equal(r.wai.length >= 1, true);
  }
});

test("2. free-text fields (goals, plan_zone, unknown ones) reach Claude only when they pass the guard; structured fields are sent", async () => {
  const hex = Buffer.from(NAMES[1]).toString("hex");
  const ok = await ask("what should I do about my build", { sheets: sheetOf({ class: vis("paladin"), goals: vis("farm the barrens at dawn"), plan_zone: vis("Durotar") }) });
  assert.equal(ok.anth.length, 1);
  assert.ok(anthText(ok).includes("paladin"));
  assert.ok(anthText(ok).includes("farm the barrens at dawn"), "a clean free-text field is sent");
  const bad = await ask("what should I do about my build", { sheets: sheetOf({ class: vis("paladin"), goals: vis(`meet ${hex} soon`), plan_zone: vis("Durotar") }) });
  assert.equal(bad.anth.length, 1, "a dropped free-text field does not stop Claude");
  assert.ok(!anthText(bad).includes(hex), "the free-text field that fails the guard is not sent at all");
  assert.ok(anthText(bad).includes("paladin") && anthText(bad).includes("Durotar"));
  assert.ok(!bodiesText(bad.wai).includes(hex), "nor to Workers AI");
});

test("2. names outside the five-member roster: sheet names, slugs and character names are tokenised by construction", async () => {
  const sheets = [
    ...sheetOf({ class: vis("paladin"), goals: vis("my main is Grukthar Bonechewer and I like it"), main: vis("Grukthar Bonechewer") }),
    { slug: "zed-ex", name: "Examplemage Zedford", fields: { class: vis("rogue"), professions: vis("mining"), goals: vis("help Examplemage Zedford level") }, updated: "x" },
  ];
  const r = await ask("what should I do about my build and my party", { sheets });
  assert.equal(r.anth.length, 1);
  const t = anthText(r);
  for (const leak of ["Grukthar", "Bonechewer", "Examplemage", "Zedford", "zed-ex"]) assert.ok(!t.includes(leak), `${leak} reached Anthropic`);
  assert.ok(!bodiesText(r.wai).includes("Zedford"));
  const reply = await ask("what should I do about my party", { sheets, claude: (b) => ({ status: 200, text: `**${(b.messages[0].content.match(/(\{P\d+\.[a-z0-9]+\}): class rogue/) || [])[1]} is ready.**\nThat is how Classic handled it.\n-# Sources: general knowledge · unconfirmed` }) });
  assert.match(reply.answer, /Examplemage Zedford/, "the token comes back as that member's display name");
});

test("2. the structured vs free-text field table is in flags.md and matches the code (fictional field list)", () => {
  const flags = readFileSync(new URL("../../docs/runbooks/flags.md", import.meta.url), "utf8");
  for (const k of [...STRUCTURED_FIELDS, ...FREE_TEXT_FIELDS]) assert.ok(flags.includes(`\`${k}\``), k);
  assert.equal(classifyField("class"), "structured");
  assert.equal(classifyField("goals"), "free");
  assert.equal(classifyField("hobby_notes"), "free", "an unknown field is free-text: the safe default");
  assert.equal(classifyField("level"), "structured");
});

test("3. the cap counts all four usage fields, clamps each call, and treats bad usage as an estimated maximum", async () => {
  const key = `claude_tokens_${month()}`;
  const run = async (usage) => { const db = schemaDb(); await ask(ABSTAIN_Q, { db, claude: () => ({ status: 200, usage }) }); const row = db.raw.prepare("SELECT json FROM kv_state WHERE key = ?").get(key); return row ? Number(row.json) - UNDERSTAND_TOKENS : null; };
  assert.equal(await run({ input_tokens: 3, output_tokens: 2, cache_creation_input_tokens: 5000, cache_read_input_tokens: 4000 }), 9005);
  assert.equal(await run({ input_tokens: 10, output_tokens: 5 }), 15);
  assert.equal(await run({ input_tokens: 1e15, output_tokens: 1 }), 200001, "clamped per field, never months of budget in one call");
  for (const bad of [{ input_tokens: -5, output_tokens: 2 }, { input_tokens: "abc", output_tokens: 2 }, { input_tokens: 1e308, output_tokens: 1 }, null]) {
    const v = await run(bad);
    assert.ok(v >= 700 && v < 100000 || (bad && bad.input_tokens === 1e308 && v === 200001), `bad usage ${JSON.stringify(bad)} counted ${v}`);
  }
});

test("3. the research call carries no cache_control; the legacy flag-off call still does", async () => {
  const r = await ask(ABSTAIN_Q);
  assert.ok(!r.anth[0].raw.includes("cache_control"));
  const off = await ask("who tanks tonight", { research: false, provider: "claude" });
  assert.ok(off.anth[0].raw.includes("cache_control"));
});

test("4. the model fallback retries only on a model-not-found signal, never on credit, auth or rate errors, and sends once per attempt", async () => {
  const e = (status, type, message) => ({ status, errBody: { type: "error", error: { type, message } } });
  for (const c of [e(400, "invalid_request_error", "Your credit balance is too low to access the API"), e(401, "authentication_error", "invalid x-api-key"), e(403, "permission_error", "nope"), e(429, "rate_limit_error", "slow down"), e(404, "not_found_error", "the requested resource was not found"), { status: 404 }, { status: 400 }]) {
    const r = await ask(ABSTAIN_Q, { claude: () => c });
    assert.equal(r.anth.length, 1, `${c.status} ${c.errBody ? c.errBody.error.type : "no body"} must not retry`);
    assert.equal(r.wai.length >= 1, true);
  }
  const miss = await ask(ABSTAIN_Q, { claude: (b) => (b.model === "claude-sonnet-5-5" ? e(404, "not_found_error", "model: claude-sonnet-5-5") : { status: 200, text: OKTEXT }) });
  assert.deepEqual(miss.anth.map((a) => a.model), ["claude-sonnet-5-5", "claude-sonnet-4-5-20250929"]);
  const bad400 = await ask(ABSTAIN_Q, { claude: (b) => (b.model === "claude-sonnet-5-5" ? e(400, "invalid_request_error", "model: claude-sonnet-5-5 does not exist") : { status: 200, text: OKTEXT }) });
  assert.equal(bad400.anth.length, 2);
  const gw = await ask(ABSTAIN_Q, { env: (x) => { x.CLOUDFLARE_ACCOUNT_ID = "acct"; x.AI_GATEWAY_ID = "gw"; }, claude: () => ({ status: 500 }) });
  assert.equal(gw.anth.length, 2, "a 500 is retried once on the Haiku-class model; still one send per attempt: no gateway-then-direct double hop");
  for (const a of gw.anth) assert.match(a.url, /gateway\.ai\.cloudflare\.com/);
  assert.equal(gw.wai.length >= 1, true);
});

test("5. the cap gate reserves before the call: 20 concurrent asks with room for one reservation make one send", async () => {
  const db = schemaDb();
  const key = `claude_tokens_${month()}`;
  const E = await learnE();
  const CAP = Math.floor(1.5 * E); // one reservation fits, two never do
  await ask(ABSTAIN_Q, { db }); // seeds library, sheets, schema
  db.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES (?, '0', 'x')").run(key);
  anth = []; wai = []; waiThrows = false;
  claudeAnswer = () => ({ status: 200, text: OKTEXT, usage: { input_tokens: 5 * E, output_tokens: 1 } }); // settles above the cap, so a later refund cannot admit a second ask
  const ids = Array.from({ length: 20 }, (_, i) => {
    const id = `cc${++n}x${i}`;
    db.raw.prepare("INSERT INTO ask_turns (id, by_name, question, model, status, share, created_at) VALUES (?, 'Red Fox', ?, 'groq', 'thinking', 1, 'x')").run(id, ABSTAIN_Q);
    return id;
  });
  const env = { DB: db, AI: fakeAi, ANTHROPIC_API_KEY: FAKE_KEY, ASK_RESEARCH: "on", RESEARCH_CLAUDE_MONTHLY_TOKENS: String(CAP), BOARD_ROOM: { idFromName: () => "r", get: () => ({ fetch: async () => new Response("ok") }) } };
  const e0 = console.error, w0 = console.warn; console.error = () => {}; console.warn = () => {};
  try { await Promise.all(ids.map((id) => answerWithAi({ env, origin: "https://worker.test", intentId: id, by: "Red Fox", memberSlug: "red-fox", question: ABSTAIN_Q, provider: "groq", share: true, journey: "curious", isMember: true }))); } finally { console.error = e0; console.warn = w0; }
  assert.equal(anth.length, 1, "exactly one send past the gate");
  const used = Number(db.raw.prepare("SELECT json FROM kv_state WHERE key = ?").get(key).json);
  assert.ok(used >= CAP, `counter ${used}`);
});

test("5. a counter write failure stops Claude for a while (spend must not go unrecorded)", async () => {
  const db = schemaDb();
  const real = db.prepare;
  let failWrites = true;
  let updates = 0; // the 1st UPDATE is the understand step's settle; the compose settle is the 2nd
  db.prepare = (sql) => {
    const s = real(sql);
    const bind = s.bind;
    s.bind = (...a) => (failWrites && /^\s*UPDATE/i.test(sql) && a.some((x) => String(x).startsWith("claude_tokens_")) && ++updates >= 2 ? { first: async () => { throw new Error("d1"); }, all: async () => { throw new Error("d1"); }, run: async () => { throw new Error("d1"); } } : bind(...a));
    return s;
  };
  const first = await ask(ABSTAIN_Q, { db });
  assert.equal(first.anth.length, 1, first.row.model);
  failWrites = false;
  const second = await ask(ABSTAIN_Q, { db });
  assert.equal(second.anth.length, 0, "paused after a failed counter write");
  assert.equal(second.wai.length, 1);
  resetResearchClaudeForTests();
  assert.equal((await ask(ABSTAIN_Q, { db })).anth.length, 1, "the pause is in memory and ends");
});

test("6. an unknown asker named like a common word does not garble the prompt: only the asker label becomes a token", async () => {
  const counts = [];
  for (const by of ["Zorpling", "The", "Library", "Party"]) {
    const r = await ask("tell me about the weather and the party and the library", { by, memberSlug: "nobody" });
    assert.equal(r.anth.length, 1, by);
    const user = r.anth[0].body.messages[0].content;
    assert.match(user, /Asker: \{P\d+\.[a-z0-9]+\} \(/, by);
    assert.match(user, /Question from \{P\d+\.[a-z0-9]+\} \(journey/, by);
    counts.push((user.match(/\bthe\b/gi) || []).length + (r.anth[0].body.system[0].text.match(/\bthe\b/gi) || []).length);
  }
  assert.equal(new Set(counts).size, 1, `the word "the" must be unchanged whatever the asker is called: ${counts}`);
});

test("minor. the CPU budget guard skips Claude when tokenise+guards exceed the budget; the map is cached per roster and only the nonce changes", async () => {
  privacyBudget.ms = 0;
  const r = await ask(ABSTAIN_Q);
  assert.equal(r.anth.length, 0);
  assert.equal(r.wai.length, 1);
  assert.match(r.row.model, /cpu:budget/);
  assert.ok(!bodiesText(r.wai).toLowerCase().includes(NAMES[0].toLowerCase()), "Workers AI still gets the tokenised prompt");
  assert.equal(DEFAULT_BUDGET_MS, 8, "the shipped budget is 8 ms");
  const a =prepareResearchPrivacy({ systemPrompt: `hi ${NAMES[0]}`, userPrompt: `u ${NAMES[1]}`, question: "q", by: "Zed", party: null });
  const b = prepareResearchPrivacy({ systemPrompt: `hi ${NAMES[0]}`, userPrompt: `u ${NAMES[1]}`, question: "q", by: "Zed", party: null });
  assert.notEqual(a.map.nonce, b.map.nonce);
  assert.equal(a.system.replace(a.map.nonce, "N"), b.system.replace(b.map.nonce, "N"));
  const fresh = buildNameMap(a.roster.members, null, { genericAliases, nonce: a.map.nonce });
  assert.equal(tokenise(`hi ${NAMES[0]} and ${NAMES[3]}`, a.map), tokenise(`hi ${NAMES[0]} and ${NAMES[3]}`, fresh), "the cached map tokenises exactly like a freshly built one");
});

test("minor. build-time check: the library pages contain no roster key (the cheap guard plus whole-word keys)", () => {
  const roster = researchRoster();
  const keys = ROSTER_DATA.flatMap((r) => [r.display, ...r.aliases]).filter((k) => !genericAliases.includes(k.toLowerCase()));
  const dir = new URL("../../data/library/", import.meta.url);
  const esc = (k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const hits = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json") || f === "search.json") continue; // search.json is the client's search index (a long numeric hash in it is not prompt text); every page file is checked
    const text = readFileSync(new URL(f, dir), "utf8");
    if (scanBody({ t: text }, roster).length) hits.push(`${f}: guard`);
    for (const k of keys) if (new RegExp(`(?<![\\p{L}\\p{N}])${esc(k)}(?![\\p{L}\\p{N}])`, "iu").test(text)) hits.push(`${f}: key`);
  }
  assert.deepEqual(hits, []);
});

test("minor. stale 'Workers AI only' wording is gone from the ASK_RESEARCH comment and provider.js header; flags.md fixes the over-count claim", () => {
  const toml = readFileSync(new URL("../../infrastructure/wrangler.toml", import.meta.url), "utf8");
  const line = toml.split("\n").find((l) => l.startsWith("ASK_RESEARCH ="));
  assert.ok(!/Workers AI only/i.test(line));
  const prov = readFileSync(new URL("../../infrastructure/worker/research/provider.js", import.meta.url), "utf8");
  assert.ok(!/model call goes to the Workers AI binding and nowhere else/.test(prov));
  const flags = readFileSync(new URL("../../docs/runbooks/flags.md", import.meta.url), "utf8");
  assert.ok(!/so it over-counts/.test(flags));
  for (const k of ["cache_creation_input_tokens", "cpu:budget", "8 ms"]) assert.ok(flags.includes(k), k);
});

// ======================= compose on the Sonnet-class model, Haiku-class only as the fallback =======================
const OKT = "**Composed answer.**\nThat is how Classic handled it.\n-# Sources: general Classic-era knowledge · unconfirmed";
const SONNET = "claude-sonnet-5-5";
const HAIKU = "claude-haiku-5-5";
const errOf = (status) => ({ status, errBody: { type: "error", error: { type: status === 529 ? "overloaded_error" : "api_error", message: "try later" } } });
const slow = () => ({ status: 200, throws: Object.assign(new Error("t"), { name: "TimeoutError" }) });
const counter = (db) => Number(db.raw.prepare("SELECT json FROM kv_state WHERE key = ?").get(`claude_tokens_${month()}`).json);

test("C1. the Haiku-class model is used only after 529, 5xx or a timeout on compose, once, and its answer is used", async () => {
  for (const [label, first] of [["529", errOf(529)], ["500", errOf(500)], ["503", errOf(503)], ["timeout", slow()]]) {
    const r = await ask(ABSTAIN_Q, { claude: (b) => (b.model === SONNET ? first : { status: 200, text: OKT }) });
    assert.deepEqual(r.anth.map((a) => a.model), [SONNET, HAIKU], label);
    assert.equal(r.wai.length, 0, label);
    assert.match(r.answer, /Composed answer/, label);
    assert.match(r.row.model, new RegExp(`^claude:${HAIKU}\\+research`), label);
  }
});

test("C2. at most 2 Anthropic sends per ask: both models failing goes to Workers AI, and a Haiku-class not-found does not add a third", async () => {
  const both = await ask(ABSTAIN_Q, { claude: () => errOf(529) });
  assert.deepEqual(both.anth.map((a) => a.model), [SONNET, HAIKU]);
  assert.equal(both.wai.length >= 1, true);
  assert.match(both.answer, /Workers answer first/);
  const NF = { status: 404, errBody: { type: "error", error: { type: "not_found_error", message: "model: x" } } };
  const hk = await ask(ABSTAIN_Q, { claude: (b) => (b.model === SONNET ? errOf(500) : NF) });
  assert.equal(hk.anth.length, 2, "no third send");
  const sn = await ask(ABSTAIN_Q, { claude: (b) => (b.model === SONNET ? NF : errOf(500)) });
  assert.deepEqual(sn.anth.map((a) => a.model), [SONNET, "claude-sonnet-4-5-20250929"], "a not-found goes to the 4.5 id, not the Haiku-class one");
  assert.equal(sn.wai.length >= 1, true);
});

test("C3. 401, 403, 400 credit, 429 and an unrelated 404 never retry on the Haiku-class model", async () => {
  const mk = (status, type, message) => ({ status, errBody: { type: "error", error: { type, message } } });
  for (const c of [mk(401, "authentication_error", "invalid x-api-key"), mk(403, "permission_error", "nope"), mk(400, "invalid_request_error", "Your credit balance is too low to access the API"), mk(429, "rate_limit_error", "slow down"), mk(404, "not_found_error", "route")]) {
    const r = await ask(ABSTAIN_Q, { claude: () => c });
    assert.equal(r.anth.length, 1, `${c.status} ${c.errBody.error.type}`);
    assert.equal(r.anth[0].model, SONNET);
    assert.equal(r.wai.length >= 1, true);
  }
});

test("C4. cap: each attempt reserves and settles its own estimate; the cap and the pause still apply to the retry", async () => {
  const E = await learnE();
  // a failed 5xx attempt keeps its reservation (possibly billed); the Haiku-class retry reserves its own and settles to its real usage
  const db = schemaDb();
  const r = await ask(ABSTAIN_Q, { db, claude: (b) => (b.model === SONNET ? errOf(529) : { status: 200, text: OKT, usage: { input_tokens: 100, output_tokens: 20 } }) });
  assert.deepEqual(r.anth.map((a) => a.model), [SONNET, HAIKU]);
  assert.equal(counter(db), E + 120, "one kept reservation for the failed send plus the real usage of the retry");
  // room for only one reservation: compose is sent, the retry is refused by the cap, Workers AI answers, one alert row
  const db2 = schemaDb();
  const r2 = await ask(ABSTAIN_Q, { db: db2, env: (e) => { e.RESEARCH_CLAUDE_MONTHLY_TOKENS = String(Math.floor(1.5 * E)); }, claude: () => errOf(529) });
  assert.equal(r2.anth.length, 1, "the retry never goes out over the cap");
  assert.equal(r2.wai.length >= 1, true);
  assert.equal(db2.raw.prepare("SELECT COUNT(*) AS n FROM kv_state WHERE key LIKE 'alert:claude-cap:%'").get().n, 1);
  assert.ok(counter(db2) <= Math.floor(1.5 * E));
  // a retry that fails with a not-billed 4xx gives its own reservation back
  const db3 = schemaDb();
  await ask(ABSTAIN_Q, { db: db3, claude: (b) => (b.model === SONNET ? errOf(500) : { status: 401 }) });
  assert.equal(counter(db3), E, "only the first (kept) reservation remains");
});

test("C5. ASK_RESEARCH off: the legacy provider path is untouched by the compose-model change", async () => {
  const off = await ask("who tanks tonight", { research: false, provider: "claude", deep: true });
  assert.equal(off.anth.length, 1);
  assert.equal(off.anth[0].model, "claude-sonnet-4-5-20250929", "legacy deep id");
  const fast = await ask("who tanks tonight", { research: false, provider: "claude" });
  assert.equal(fast.anth[0].model, "claude-haiku-4-5-20251001");
});

// ======================= round 3 (second-family review of the budget code) =======================
async function learnE() {
  const db = schemaDb();
  await ask(ABSTAIN_Q, { db, claude: () => ({ status: 200, usage: null }) }); // no usage block: settles at the estimate
  return Number(db.raw.prepare("SELECT json FROM kv_state WHERE key = ?").get(`claude_tokens_${month()}`).json);
}
const rowOf = (db, key) => db.raw.prepare("SELECT json FROM kv_state WHERE key = ?").get(key);

test("R1. a reservation must fit under the cap on BOTH branches (insert and update)", async () => {
  const key = counterKey(new Date());
  const env = (n) => { const db = schemaDb(); if (n !== null) db.raw.prepare("INSERT INTO kv_state (key, json, updated_at) VALUES (?, ?, 'x')").run(key, String(n)); return { DB: db }; };
  // absent counter, estimate alone over the cap: refused, and nothing is created
  let e = env(null);
  assert.equal(await reserveTokens(e, 1000, 100), false);
  assert.equal(rowOf(e.DB, key), undefined);
  // present counter 99 + 1000 > 100: refused, unchanged
  e = env(99);
  assert.equal(await reserveTokens(e, 1000, 100), false);
  assert.equal(rowOf(e.DB, key).json, "99");
  // fits exactly: allowed; one more does not
  e = env(90);
  assert.equal(await reserveTokens(e, 10, 100), true);
  assert.equal(rowOf(e.DB, key).json, "100");
  assert.equal(await reserveTokens(e, 1, 100), false);
  // absent counter and the estimate fits: allowed on the insert branch
  e = env(null);
  assert.equal(await reserveTokens(e, 100, 100), true);
  assert.equal(rowOf(e.DB, key).json, "100");
  // cap 0 never admits; a non-numeric stored value is never admitted
  assert.equal(await reserveTokens(env(null), 1, 0), false);
  assert.equal(await reserveTokens(env("abc"), 1, 100), false);
});

test("R1. an ask whose estimate alone exceeds the cap skips Claude, Workers AI answers, one alert row", async () => {
  const db = schemaDb();
  for (let i = 0; i < 2; i++) {
    const r = await ask(ABSTAIN_Q, { db, env: (e) => { e.RESEARCH_CLAUDE_MONTHLY_TOKENS = "100"; } });
    assert.equal(r.anth.length, 0);
    assert.equal(r.wai.length, 1);
    assert.match(r.row.model, /claude:cap/);
  }
  assert.equal(db.raw.prepare("SELECT COUNT(*) c FROM kv_state WHERE key LIKE 'alert:claude-cap:%'").get().c, 1);
  assert.equal(rowOf(db, `claude_tokens_${month()}`), undefined, "nothing was reserved");
});

test("R2. the estimate is a conservative upper bound: non-ASCII text counts at 1.5 tokens per character, not 1/3", () => {
  const ascii = "a".repeat(3000);
  assert.ok(estimateTokens(ascii, "") > 1000 + RESEARCH_MAX_TOKENS, "ASCII is no longer chars/3 (see ask-research-estimate.test.mjs for the full bound)");
  const cjk = "中文字".repeat(1000); // 3000 CJK characters, 9000 UTF-8 bytes
  assert.ok(estimateTokens(cjk, "") >= 9000 + RESEARCH_MAX_TOKENS);
  const emoji = "\u{1F600}".repeat(1000); // 4000 UTF-8 bytes
  assert.ok(estimateTokens("", emoji) >= 4000 + RESEARCH_MAX_TOKENS);
  // scales with the input: ten times the CJK text is about ten times the estimate
  const ratio = (estimateTokens(cjk.repeat(10), "") - RESEARCH_MAX_TOKENS) / (estimateTokens(cjk, "") - RESEARCH_MAX_TOKENS);
  assert.ok(ratio > 9.5 && ratio < 10.5, String(ratio));
});

test("R2. a long CJK/emoji question reserves a conservative estimate end to end", async () => {
  const q = `${"中文字\u{1F600}".repeat(300)} tell me about the weather`;
  const db = schemaDb();
  const r = await ask(q, { db, claude: () => ({ status: 200, usage: null }) });
  assert.equal(r.anth.length, 1, r.row.model);
  const settled = Number(rowOf(db, `claude_tokens_${month()}`).json);
  const sent = r.anth[0].body.messages[0].content.length + r.anth[0].body.system[0].text.length;
  const nonAscii = (r.anth[0].raw.match(/[^\x00-\x7f]/g) || []).length;
  assert.ok(settled >= nonAscii * 1.5 + RESEARCH_MAX_TOKENS - 1, `settled ${settled} for ${nonAscii} non-ASCII characters of ${sent}`);
});

test("R3. usage needs BOTH valid input_tokens and output_tokens; otherwise it settles at the estimate (no refund)", () => {
  assert.equal(usageTokens({ output_tokens: 1 }, 5000), 5000);
  assert.equal(usageTokens({ input_tokens: 7 }, 5000), 5000);
  assert.equal(usageTokens({ cache_read_input_tokens: 9, cache_creation_input_tokens: 9 }, 5000), 5000);
  assert.equal(usageTokens({ input_tokens: 10, output_tokens: 5 }, 5000), 15);
  assert.equal(usageTokens({ input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 5000, cache_read_input_tokens: 4000 }, 20000), 9015);
  assert.equal(usageTokens({ input_tokens: 1e15, output_tokens: 1 }, 5000), 200001);
  for (const bad of [{ input_tokens: -1, output_tokens: 5 }, { input_tokens: NaN, output_tokens: 5 }, { input_tokens: "10", output_tokens: 5 }, { input_tokens: 10, output_tokens: null }, { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: -3 }, { input_tokens: 0, output_tokens: 0 }, null, undefined, "x", []]) {
    assert.equal(usageTokens(bad, 5000), 5000, JSON.stringify(bad));
  }
});

test("R3. an ask whose usage block is partial settles at the estimate end to end", async () => {
  const E = await learnE();
  for (const usage of [{ output_tokens: 1 }, { input_tokens: 3 }]) {
    const db = schemaDb();
    await ask(ABSTAIN_Q, { db, claude: () => ({ status: 200, usage }) });
    assert.equal(Number(rowOf(db, `claude_tokens_${month()}`).json), E, JSON.stringify(usage));
  }
});

// ======================= review round: real fetch timeouts, single-hop budget, slow reservation, missing 5-5 ids =======================
function recordTimeouts() {
  const real = AbortSignal.timeout;
  const seen = [];
  AbortSignal.timeout = (ms) => { seen.push(ms); return real.call(AbortSignal, ms); };
  return { seen, stop: () => { AbortSignal.timeout = real; } };
}
const GW = (e) => { e.CLOUDFLARE_ACCOUNT_ID = "acct"; e.AI_GATEWAY_ID = "gw"; };

test("F1. research sends get the budget they were promised, with and without a gateway: compose ~6000 ms, the retry the remaining budget (>= 2500 ms)", async () => {
  for (const [label, envPatch] of [["gateway", GW], ["no gateway", () => {}]]) {
    const rec = recordTimeouts();
    try {
      await ask(ABSTAIN_Q, { env: envPatch, claude: (b) => (b.model === SONNET ? errOf(529) : { status: 200, text: OKT }) });
    } finally { rec.stop(); }
    const [, compose, retry] = rec.seen;
    assert.ok(compose > 5800 && compose <= 6000, `${label} compose ${compose}`);
    assert.ok(retry >= 2500 && retry <= 9000, `${label} retry ${retry}`);
  }
});

test("F1b. fetchWithGatewayFallback: single-hop gets the whole remaining time; the legacy two-hop path keeps its 0.6 gateway share and a full-remainder direct hop (unchanged)", async () => {
  const env = { CLOUDFLARE_ACCOUNT_ID: "acct", AI_GATEWAY_ID: "gw" };
  const run = async (singleHop) => {
    const rec = recordTimeouts();
    const prevFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("{}", { status: 500 });
    try {
      await fetchWithGatewayFallback({ env, providerSlug: "anthropic/v1/messages", defaultEndpoint: "https://api.anthropic.com/v1/messages", headers: {}, body: "{}", deadlineAt: Date.now() + 10000, singleHop });
    } catch {} finally { rec.stop(); globalThis.fetch = prevFetch; }
    return rec.seen;
  };
  const single = await run(true);
  assert.equal(single.length, 1);
  assert.ok(single[0] > 9800 && single[0] <= 10000, String(single[0]));
  const legacy = await run(false);
  assert.equal(legacy.length, 2, "gateway then direct");
  assert.ok(legacy[0] > 5800 && legacy[0] <= 6000, `legacy gateway hop ${legacy[0]}`);
  assert.ok(legacy[1] > 9800 && legacy[1] <= 10000, `legacy direct hop keeps the full remaining budget ${legacy[1]}`);
});

test("F3. a slow second reservation write cannot push the retry past the Claude budget: the retry is skipped, its reservation refunded, Workers AI answers", async () => {
  const E = await learnE();
  const db = schemaDb();
  const real = db.prepare;
  let reserves = 0;
  db.prepare = (sql) => {
    const st = real(sql);
    const bind = st.bind;
    st.bind = (...a) => {
      const o = bind(...a);
      if (String(a[0] || "").startsWith("claude_tokens_") && /RETURNING/.test(sql) && ++reserves === 3) {
        const all = o.all.bind(o);
        o.all = async () => { mock.timers.tick(7000); return all(); }; // the second reservation "takes" 7 s of the 9 s budget
      }
      return o;
    };
    return st;
  };
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
  let r;
  try {
    r = await ask(ABSTAIN_Q, { db, claude: () => errOf(529) });
  } finally { mock.timers.reset(); }
  assert.equal(r.anth.length, 1, "no retry started past the budget");
  assert.equal(r.wai.length >= 1, true);
  assert.match(r.answer, /Workers answer first/);
  assert.equal(counter(db), E, "the unused second reservation was given back");
});

test("F5. if the 5-5 ids do not exist, every ask spends 2 sends (the 4.5 ids); the cost is documented and RESEARCH_CLAUDE_FALLBACK_FAST is documented as unused", async () => {
  const NF = (m) => ({ status: 404, errBody: { type: "error", error: { type: "not_found_error", message: `model: ${m}` } } });
  for (let i = 0; i < 2; i++) {
    const r = await ask(ABSTAIN_Q, { claude: (b) => (/-5-5$/.test(b.model) ? NF(b.model) : { status: 200, text: OKT }) });
    assert.deepEqual(r.anth.map((a) => a.model), [SONNET, "claude-sonnet-4-5-20250929"]);
  }
  const flags = readFileSync(new URL("../../docs/runbooks/flags.md", import.meta.url), "utf8");
  assert.ok(/do(es)? not exist[^.]*2 (Anthropic )?sends/i.test(flags), "flags.md states the 2-sends-per-ask cost when the 5-5 ids are missing");
  assert.ok(/RESEARCH_CLAUDE_FALLBACK_FAST[^.]*unused/i.test(flags));
});
