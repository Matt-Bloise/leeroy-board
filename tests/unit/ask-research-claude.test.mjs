// W-wire: /ask research mode provider order Claude -> Workers AI -> library facts, with every outside call after tokenisation and the outbound guards.
// Offline: a fake Anthropic endpoint (fake fetch), a fake Workers AI binding, an in-memory D1. Fake key only. Fictional names only; the real roster is read at
// runtime from bot-data.js (never copied here, never printed). Run: node --test tests/unit/ask-research-claude.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { answerWithAi, invalidatePagesCache } from "../../infrastructure/worker/ai-models.js";
import { invalidatePersonaCache } from "../../infrastructure/worker/persona.js";
import { invalidateConfigCache } from "../../infrastructure/worker/config.js";
import { resetKeyCacheForTests } from "../../infrastructure/worker/ai-keys.js";
import { ROSTER_DATA } from "../../infrastructure/worker/bot-data.js";
import { scanBody, CANARY } from "../../infrastructure/worker/privacy/outbound-guard.js";
import { researchRoster, setFirstNameSource, genericAliases } from "../../infrastructure/worker/privacy/roster-config.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";

const FAKE_KEY = "sk-ant-FAKE-TEST-0000";
const realFetch = globalThis.fetch;
let anth = []; // every request to an Anthropic URL: { model, body, headers }
let others = []; // every other fetch URL
let wai = []; // Workers AI inputs
let claudeAnswer = () => ({ status: 200, text: "**Short answer first.**\nThat is how Classic handled it.\n-# Sources: general Classic-era knowledge · unconfirmed" });
let waiAnswer = () => "**Workers answer first.**\nThat is how Classic handled it.\n-# Sources: general Classic-era knowledge · unconfirmed";
let waiThrows = false;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes("anthropic")) {
    const body = JSON.parse(init.body);
    anth.push({ model: body.model, body, raw: init.body, headers: { ...init.headers }, url: u });
    const r = claudeAnswer(body, anth.length);
    if (r.throws) throw r.throws;
    const usage = r.usage === undefined ? { input_tokens: 111, output_tokens: 22 } : r.usage;
    return new Response(JSON.stringify({ content: r.text === undefined ? [] : [{ type: "text", text: r.text }], ...(usage ? { usage } : {}) }), { status: r.status, headers: { "content-type": "application/json" } });
  }
  others.push(u);
  return new Response("{}", { status: 200 });
};
const fakeAi = { run: async (_m, inputs) => { wai.push(inputs); if (waiThrows) throw new Error("workers ai down"); return { response: waiAnswer(inputs), usage: { prompt_tokens: 5, completion_tokens: 5 } }; } };
test.after(() => { globalThis.fetch = realFetch; });
test.beforeEach(() => { resetKeyCacheForTests(); setFirstNameSource(null); });

const f = (value) => ({ value, visible: true, source: "board", at: "2026-11-01T00:00:00.000Z" });
const SHEETS = [{ slug: "red-fox", name: "Red Fox", fields: { class: f("paladin"), race: f("human"), level: f(12) }, updated: "x" }];
const TANK_PAGE = { id: "classes/tanking", category: "classes", title: "Tanking", blurb: "Who tanks", facts: [{ key: "tanking.tonight", value: "Who tanks tonight is agreed in the party channel." }] };
const ABSTAIN_Q = "tell me about the weather";
const NAMES = ROSTER_DATA.map((r) => r.display); // runtime only
const month = () => new Date().toISOString().slice(0, 7).replace("-", "");
const bodiesText = (list) => list.map((b) => JSON.stringify(b)).join("\n=====\n");

let n = 0;
async function ask(question, { by = "Red Fox", memberSlug = "red-fox", research = true, key = true, deep = false, env: envPatch = null, db = null, claude = null, wai: waiFn = null, waiFail = false, provider = "groq", isMember = true } = {}) {
  invalidatePersonaCache(); invalidatePagesCache(); invalidateConfigCache();
  const DB = db || schemaDb();
  DB.raw.prepare("INSERT OR REPLACE INTO lib_pages (id, category, title, blurb, aliases_json, facts_json, updated_at) VALUES (?, ?, ?, ?, '[]', ?, '2026-11-01T00:00:00Z')").run(TANK_PAGE.id, TANK_PAGE.category, TANK_PAGE.title, TANK_PAGE.blurb, JSON.stringify(TANK_PAGE.facts));
  DB.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES ('party_sheets', ?, 'x')").run(JSON.stringify(SHEETS));
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
  assert.equal(r.anth.length, 1);
  assert.equal(r.wai.length, 0);
  assert.equal(r.anth[0].model, "claude-haiku-5-5");
  assert.equal(r.anth[0].body.max_tokens, 700);
  assert.match(r.row.model, /^claude:claude-haiku-5-5\+research/);
  assert.match(r.answer, /Short answer first/);
  assert.equal(r.anth[0].headers["x-api-key"], FAKE_KEY);
  assert.ok(!r.anth[0].raw.includes(FAKE_KEY), "the key is a header, never in the body");
  assert.deepEqual(r.others.filter((u) => /groq|gemini|googleapis|openrouter|cerebras|azure/.test(u)), [], "no other provider ever sees the ask");
});

test("deep uses the deep research model", async () => {
  const r = await ask(ABSTAIN_Q, { deep: true });
  assert.equal(r.anth[0].model, "claude-sonnet-5-5");
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
  const r = await ask(ABSTAIN_Q, { claude: (body) => (body.model === "claude-haiku-5-5" ? { status: 404 } : { status: 200, text: "**Fallback model answer.**\nThat is how Classic handled it.\n-# Sources: general Classic-era knowledge · unconfirmed" }) });
  assert.deepEqual(r.anth.map((a) => a.model), ["claude-haiku-5-5", "claude-haiku-4-5-20251001"]);
  assert.match(r.answer, /Fallback model answer/);
  assert.equal(r.wai.length, 0);
  const both = await ask(ABSTAIN_Q, { deep: true, claude: () => ({ status: 404 }) });
  assert.deepEqual(both.anth.map((a) => a.model), ["claude-sonnet-5-5", "claude-sonnet-4-5-20250929"], "exactly one retry");
  assert.equal(both.wai.length, 1);
  const custom = await ask(ABSTAIN_Q, { env: (e) => { e.RESEARCH_CLAUDE_MODEL_FAST = "model-x"; e.RESEARCH_CLAUDE_FALLBACK_FAST = "model-y"; }, claude: (b) => (b.model === "model-x" ? { status: 400 } : { status: 200, text: "**Ok answer.**\nThat is how Classic handled it.\n-# Sources: general Classic-era knowledge · unconfirmed" }) });
  assert.deepEqual(custom.anth.map((a) => a.model), ["model-x", "model-y"]);
});

test("token counter: usage is added to claude_tokens_YYYYMM; the cap sends later asks to Workers AI with one alert row a month", async () => {
  const db = schemaDb();
  const r1 = await ask(ABSTAIN_Q, { db, env: (e) => { e.RESEARCH_CLAUDE_MONTHLY_TOKENS = "200"; } });
  assert.equal(r1.anth.length, 1);
  const key = `claude_tokens_${month()}`;
  assert.equal(Number(db.raw.prepare("SELECT json FROM kv_state WHERE key = ?").get(key).json), 133);
  // 133 < 200: still allowed; this one pushes it to 266
  const r2 = await ask(ABSTAIN_Q, { db, env: (e) => { e.RESEARCH_CLAUDE_MONTHLY_TOKENS = "200"; } });
  assert.equal(r2.anth.length, 1);
  assert.equal(Number(db.raw.prepare("SELECT json FROM kv_state WHERE key = ?").get(key).json), 266);
  assert.equal(db.raw.prepare("SELECT COUNT(*) c FROM kv_state WHERE key LIKE 'alert:claude-cap:%'").get().c, 0);
  for (let i = 0; i < 3; i++) {
    const r = await ask(ABSTAIN_Q, { db, env: (e) => { e.RESEARCH_CLAUDE_MONTHLY_TOKENS = "200"; } });
    assert.equal(r.anth.length, 0, "at or above the cap Claude is skipped");
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

test("a reply with a bare token, a foreign-nonce token or an id token is discarded and Workers AI answers", async () => {
  for (const bad of ["{P1}", "{P2.zzzz}", "{ID.zzzz}", "{ p1 }"]) {
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
