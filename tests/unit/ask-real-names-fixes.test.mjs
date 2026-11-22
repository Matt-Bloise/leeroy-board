// Fixes after the Fable read of PR 370 (RESEARCH_NAMES): written red first, one block per finding.
//  1 guests never get the real-mode party text   2 bearer false positive, field redaction   3 degraded line by cause class   4 exact "real"
//  5 wider secret screen, honest privacy page, guest fail-closed   6 admin evaluation never sends raw party context to Workers AI   7 ping defang without word boundaries
// Offline: fake Anthropic endpoint, fake Workers AI binding, in-memory D1. Fictional names; the real roster is read at runtime. Run: node --test tests/unit/ask-real-names-fixes.test.mjs
import test from "node:test";
// Built at runtime: a literal Slack-shaped token in the repo trips GitHub push protection.
const SLACK_FIXTURE = ["xo", "xb-", "123456789012", "-", "abcdefghijklmn"].join("");
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { answerWithAi, invalidatePagesCache } from "../../infrastructure/worker/ai-models.js";
import { invalidatePersonaCache } from "../../infrastructure/worker/persona.js";
import { invalidateConfigCache } from "../../infrastructure/worker/config.js";
import { resetKeyCacheForTests } from "../../infrastructure/worker/ai-keys.js";
import { ROSTER_DATA } from "../../infrastructure/worker/bot-data.js";
import { resetResearchClaudeForTests, privacyBudget } from "../../infrastructure/worker/research/claude.js";
import { setFirstNameSource } from "../../infrastructure/worker/privacy/roster-config.js";
import { researchNames, scanSecrets, redactIds, defangPings, prepareRealPrompt, cleanRealReply } from "../../infrastructure/worker/research/real-names.js";
import { DEGRADED_SUFFIX, degradedLines } from "../../infrastructure/worker/research/provider.js";
import { WALL_RE } from "../../infrastructure/worker/research/no-wall.js";
import { neutraliseMentions } from "../../infrastructure/worker/research/label.js";
import { lintResearchAnswer } from "../../infrastructure/worker/answer-lint.js";
import { runEval } from "../../infrastructure/worker/eval.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";

const FAKE_KEY = "sk-ant-FAKE-TEST-0000";
const realFetch = globalThis.fetch;
const OK = "**Short answer first.**\nThat is how Classic handled it.\n-# Sources: general Classic-era knowledge · unconfirmed";
let anth = [];
let wai = [];
let claudeAnswer = () => ({ status: 200, text: OK });
globalThis.fetch = async (url, init) => {
  if (String(url).includes("anthropic")) {
    const body = JSON.parse(init.body);
    anth.push({ body, raw: init.body, url: String(url) });
    const r = claudeAnswer(body, anth.length);
    if (r.throws) throw r.throws;
    return new Response(JSON.stringify({ content: r.text === undefined ? [] : [{ type: "text", text: r.text }], usage: { input_tokens: 111, output_tokens: 22 } }), { status: r.status, headers: { "content-type": "application/json" } });
  }
  return new Response("{}", { status: 200 });
};
const fakeAi = { run: async (_m, inputs) => { wai.push(inputs); return { response: OK, usage: { prompt_tokens: 5, completion_tokens: 5 } }; } };
test.after(() => { globalThis.fetch = realFetch; });
test.beforeEach(() => { resetKeyCacheForTests(); resetResearchClaudeForTests(); setFirstNameSource(null); privacyBudget.ms = 1000; });

const f = (value) => ({ value, visible: true, source: "board", at: "2026-11-01T00:00:00.000Z" });
const NAME = ROSTER_DATA[2].display;
const ZW = String.fromCharCode(0x200b);
const FW_AT = String.fromCharCode(0xff20);
const fw = (s) => s.replace(/[0-9]/g, (d) => String.fromCharCode(0xff10 + Number(d)));
const live = (t) => /[@＠][​-‏⁠﻿]*(?:every\s*one|here)/i.test(String(t).split(ZW).join("")) && !new RegExp(`[@${FW_AT}]${ZW}(?:every|here)`, "i").test(String(t));
const TANK = { id: "classes/tanking", category: "classes", title: "Tanking", blurb: "Who tanks", facts: [{ key: "tanking.tonight", value: "Who tanks tonight is agreed in the party channel." }] };
const ABSTAIN_Q = "tell me about the weather";
const H = "a".repeat(64);
const promptOf = (r) => r.anth.map((a) => [...a.body.system.map((s) => s.text), ...a.body.messages.map((m) => m.content)].join("\n")).join("\n=====\n");

let n = 0;
async function ask(question, { names = "real", by = "Red Fox", memberSlug = "red-fox", isMember = true, key = true, claude = null, sheets = null, state = null, env: patch = null } = {}) {
  invalidatePersonaCache(); invalidatePagesCache(); invalidateConfigCache();
  const DB = schemaDb();
  DB.raw.prepare("INSERT OR REPLACE INTO lib_pages (id, category, title, blurb, aliases_json, facts_json, updated_at) VALUES (?, ?, ?, ?, '[]', ?, '2026-11-01T00:00:00Z')").run(TANK.id, TANK.category, TANK.title, TANK.blurb, JSON.stringify(TANK.facts));
  DB.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES ('party_sheets', ?, 'x')").run(JSON.stringify(sheets || [{ slug: "red-fox", name: "Red Fox", fields: { class: f("paladin"), level: f(12) }, updated: "x" }]));
  for (const [k, v] of Object.entries(state || {})) DB.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES (?, ?, 'x')").run(k, JSON.stringify(v));
  const env = { DB, AI: fakeAi, GROQ_API_KEY: "g", GEMINI_API_KEY: "g", ...(key ? { ANTHROPIC_API_KEY: FAKE_KEY } : {}), ASK_RESEARCH: "on", ...(names ? { RESEARCH_NAMES: names } : {}), BOARD_ROOM: { idFromName: () => "r", get: () => ({ fetch: async () => new Response("ok") }) } };
  if (patch) patch(env);
  const id = `rf${++n}`;
  DB.raw.prepare("INSERT INTO ask_turns (id, by_name, question, model, status, share, created_at) VALUES (?, ?, ?, 'groq', 'thinking', 1, ?)").run(id, by, question, new Date().toISOString());
  DB.raw.prepare("INSERT INTO ask_turn_askers (intent_id, asker_hash) VALUES (?, ?)").run(id, H);
  anth = []; wai = [];
  claudeAnswer = claude || (() => ({ status: 200, text: OK }));
  const real = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of Object.keys(real)) console[k] = () => {};
  try { await answerWithAi({ env, origin: "https://worker.test", intentId: id, by, memberSlug, question, provider: "groq", share: true, deep: false, journey: "curious", isMember }); } finally { Object.assign(console, real); }
  const row = DB.raw.prepare("SELECT answer, model, status FROM ask_turns WHERE id = ?").get(id);
  return { row: { ...row }, answer: row.answer, anth: anth.slice(), wai: wai.slice() };
}

// ---- 1 guests never get the real-mode party text -------------------------------------------------------------------------------------------------
test("1. a guest's Workers AI prompt drops a guard-failing free-text sheet field; a member in real mode keeps it", async () => {
  const b64 = Buffer.from(NAME).toString("base64");
  const rev = [...NAME.toLowerCase()].reverse().join("");
  const sheets = [{ slug: "red-fox", name: "Red Fox", fields: { class: f("paladin"), goals: f(`tank for ${b64}`), plan_zone: f(`meet ${rev} at dusk`) }, updated: "x" }];
  for (const names of ["real", "tokenised"]) {
    const g = await ask(ABSTAIN_Q, { names, sheets, isMember: false, by: "Visitor", memberSlug: "" });
    assert.equal(g.anth.length, 0);
    assert.ok(g.wai.length >= 1, "a guest is answered by Workers AI");
    const sent = JSON.stringify(g.wai);
    assert.ok(!sent.includes(b64) && !sent.includes(rev), `${names}: guest prompt must not carry the guard-failing field`);
  }
  const m = await ask(ABSTAIN_Q, { names: "real", sheets });
  assert.ok(promptOf(m).includes(b64), "a member in real mode keeps the field");
  const mt = await ask(ABSTAIN_Q, { names: "tokenised", sheets });
  assert.ok(!promptOf(mt).includes(b64), "tokenised member: dropped as before");
});

// ---- 2 bearer ------------------------------------------------------------------------------------------------------------------------------------
test("2. 'bearer' in ordinary words is not a secret; a real Bearer token is", () => {
  for (const t of ["standard bearer responsibilities", "Torch Bearer Extraordinaire", "flag bearer extraordinaire", "the Bearer of bad tidings arrives", "bearer ghijklmnop0123456789qrstuvwx"]) assert.deepEqual(scanSecrets(t, {}), [], t);
  assert.ok(scanSecrets("Authorization: Bearer ghijklmnop0123456789qrstuvwx", {}).includes("bearer"));
  assert.deepEqual(scanSecrets("Bearer eyJhbGciOi.payload12345.sig-nature_9", {}).includes("bearer"), true);
});
test("2. a member's ask is not degraded by 'flag bearer extraordinaire' in a sheet field", async () => {
  const sheets = [{ slug: "red-fox", name: "Red Fox", fields: { class: f("paladin"), goals: f("flag bearer extraordinaire of the Deadmines") }, updated: "x" }];
  for (const names of ["real", "tokenised"]) {
    const r = await ask(ABSTAIN_Q, { names, sheets });
    assert.equal(r.anth.length, 1, `${names}: ${r.row.model}`);
    assert.ok(!r.row.model.endsWith(DEGRADED_SUFFIX), r.row.model);
  }
});
test("2. real mode: a secret inside a sheet field, a sign-up or the tonight title is redacted and the ask goes on; in the question it still stops the send", async () => {
  const TOKEN = `${"M".repeat(24)}.${"a1B2c3"}.${"x".repeat(27)}`;
  const sheets = [{ slug: "red-fox", name: "Red Fox", fields: { class: f("paladin"), goals: f(`my token ${TOKEN} ok`) }, updated: "x" }];
  const r = await ask(ABSTAIN_Q, { names: "real", sheets, state: { tonight: { title: `Raid, key ${FAKE_KEY}` }, signups: { roster: { "Red Fox": { note: `Bearer abcdef0123456789abcdef0123456789` } } } } });
  assert.equal(r.anth.length, 1, r.row.model);
  assert.ok(!r.anth[0].raw.includes(TOKEN) && !r.anth[0].raw.includes(FAKE_KEY) && !r.anth[0].raw.includes("abcdef0123456789abcdef0123456789"));
  assert.ok(!r.row.model.endsWith(DEGRADED_SUFFIX));
  const q = await ask(`here is ${TOKEN}`, { names: "real" });
  assert.equal(q.anth.length, 0);
  assert.ok(q.row.model.endsWith(DEGRADED_SUFFIX));
});

// ---- 3 degraded line by cause class --------------------------------------------------------------------------------------------------------------
const PROMISE = /again|minutes?\b|\bsoon\b|shortly|later|few moments|\bretry\b|\btry\b/i;
test("3. degradedLines: transient causes say a brief outage with no time promise; every other cause promises nothing and names what would settle it", () => {
  for (const r of ["claude:timeout", "claude:http-529", "claude:http-500", "claude:http-503", "claude:http-429"]) {
    const L = degradedLines(r);
    assert.match(L.answer, /brief outage/i, r);
    assert.doesNotMatch(`${L.answer} ${L.note}`, PROMISE, r);
    assert.doesNotMatch(`${L.answer} ${L.note}`, WALL_RE, r);
  }
  for (const r of ["claude:cap", "guard:secret", "guard:host", "cpu:budget", "claude:reply-flagged", "claude:counter-error", "claude:paused", null, "", undefined]) {
    const L = degradedLines(r);
    assert.doesNotMatch(L.answer, /outage/i, String(r));
    assert.match(L.answer, /would settle it/i, String(r));
    assert.doesNotMatch(`${L.answer} ${L.note}`, PROMISE, String(r));
    assert.doesNotMatch(`${L.answer} ${L.note}`, WALL_RE, String(r));
  }
  for (const r of ["claude:timeout", "claude:cap", null]) assert.equal(lintResearchAnswer(degradedLines(r).answer).failures.includes("outage_line"), false);
});
test("3. end to end: each cause class gets its own line, never a time promise", async () => {
  const sevens = await ask(ABSTAIN_Q, { claude: () => ({ status: 529 }) });
  assert.match(sevens.answer, /brief outage/i); assert.doesNotMatch(sevens.answer, PROMISE);
  const tmo = await ask(ABSTAIN_Q, { claude: () => ({ status: 200, throws: Object.assign(new Error("t"), { name: "TimeoutError" }) }) });
  assert.match(tmo.answer, /brief outage/i);
  const cap = await ask(ABSTAIN_Q, { env: (e) => { e.RESEARCH_CLAUDE_MONTHLY_TOKENS = "0"; } });
  assert.doesNotMatch(cap.answer, /outage/i); assert.match(cap.answer, /would settle it/i); assert.doesNotMatch(cap.answer, PROMISE);
  const nokey = await ask(ABSTAIN_Q, { key: false });
  assert.doesNotMatch(nokey.answer, /outage/i); assert.doesNotMatch(nokey.answer, PROMISE);
  const sec = await ask(`token ${FAKE_KEY}`);
  assert.doesNotMatch(sec.answer, /outage/i); assert.doesNotMatch(sec.answer, PROMISE);
  const host = await ask(ABSTAIN_Q, { env: (e) => { e.CLOUDFLARE_ACCOUNT_ID = "acct/../../evil.example"; e.AI_GATEWAY_ID = "gw"; } });
  assert.doesNotMatch(host.answer, /outage/i); assert.doesNotMatch(host.answer, PROMISE);
  privacyBudget.ms = -1;
  const cpu = await ask(ABSTAIN_Q, { names: "tokenised" });
  assert.match(cpu.row.model, /cpu:budget/); assert.doesNotMatch(cpu.answer, /outage/i); assert.doesNotMatch(cpu.answer, PROMISE);
  const lib = await ask("who tanks tonight", { env: (e) => { e.RESEARCH_CLAUDE_MONTHLY_TOKENS = "0"; } });
  assert.match(lib.answer, /agreed in the party channel/); assert.doesNotMatch(lib.answer, PROMISE);
  for (const r of [sevens, tmo, cap, nokey, sec, host, cpu, lib]) { assert.match(r.row.model, /\+degraded$/); assert.doesNotMatch(r.answer, WALL_RE); }
});

// ---- 4 exact "real" ------------------------------------------------------------------------------------------------------------------------------
test("4. RESEARCH_NAMES is exactly 'real': no trim, no case folding", () => {
  assert.equal(researchNames({ RESEARCH_NAMES: "real" }), "real");
  for (const v of [" real ", "REAL", "Real", "real\n", "real ", " real", "", undefined, "tokenised"]) assert.equal(researchNames({ RESEARCH_NAMES: v }), "tokenised", JSON.stringify(v));
});

// ---- 5 wider secret screen, page, guest fail-closed -----------------------------------------------------------------------------------------------
test("5. the screen catches AWS keys, JWTs, Slack tokens, Basic auth, mfa tokens, 32+ hex and fullwidth ids; ordinary text is left alone", () => {
  const hit = {
    "an AWS access key": "key AKIAIOSFODNN7EXAMPLE here",
    "a JWT": "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk ok",
    "a Slack token": SLACK_FIXTURE,
    "Basic auth": "Authorization: Basic dXNlcjpwYXNzd29yZDEyMw==",
    "an mfa token": `mfa.${"a1B2c3D4e5".repeat(3)}`,
    "a 40 hex token": "token 356a192b7913b04c54574d18c28d46e6395428ab",
    "a fullwidth id": `id ${fw("123456789012345678")}`,
  };
  for (const [what, t] of Object.entries(hit)) assert.ok(scanSecrets(t, {}).length > 0, what);
  for (const t of ["Basic stats for a Basic paladin build", "Authorization from the raid leader", "the xo-xo guild", "mfa is a hobby", "a hex colour #ff00aa and 0xDEADBEEF", "level 60 gear at 1234 gold", "AKIA is a word", "eyJ is a prefix", "2026-11-15 18:30 UTC", "a sentence about tokens and keys and passwords in the abstract"]) assert.deepEqual(scanSecrets(t, {}), [], t);
  assert.equal(redactIds(`a ${fw("123456789012345678")} b`), "a [id] b");
  assert.throws(() => prepareRealPrompt({ system: "s", user: "q" }, {}, [], { friend: [SLACK_FIXTURE] }), (e) => e.code === "OUTBOUND_SECRET");
});
test("5. the privacy page says what is screened, best effort, and no longer promises 'never'; the gateway logging caveat is stated", () => {
  const md = readFileSync(new URL("../../docs/privacy.md", import.meta.url), "utf8");
  const html = readFileSync(new URL("../../privacy/index.html", import.meta.url), "utf8");
  for (const t of [md, html]) {
    assert.doesNotMatch(t, /never sent: keys, tokens and passwords/i);
    assert.match(t, /best effort/i);
    assert.match(t, /typed password/i);
    assert.match(t, /not reliably caught/i);
    assert.match(t, /AI Gateway/);
  }
});
test("5. a guest whose prompt cannot be tokenised gets library facts only: the raw prompt never reaches Workers AI", async () => {
  setFirstNameSource(() => { throw new Error("roster source down"); });
  const g = await ask("who tanks tonight", { isMember: false, by: "Visitor", memberSlug: "" });
  assert.equal(g.wai.length, 0, "Workers AI was not called with an untokenised prompt");
  assert.equal(g.anth.length, 0);
  assert.match(g.answer, /agreed in the party channel/, "library facts answer");
  const g2 = await ask(ABSTAIN_Q, { isMember: false, by: "Visitor", memberSlug: "" });
  assert.equal(g2.wai.length, 0);
  assert.ok(g2.answer && g2.answer.length > 10);
});

// ---- 6 admin evaluation --------------------------------------------------------------------------------------------------------------------------
test("6. admin evaluation under research tokenises the prompt before Workers AI: no roster name leaves", async () => {
  const sent = [];
  const deps = {
    now: () => 1_000_000, sleep: async () => {}, lastCallAt: new Map(), cooldownUntil: new Map(), configured: () => true, budgetVerdict: async () => null, research: true,
    buildInputs: async () => ({ systemPrompt: `You help ${NAME}.`, userPrompt: `${NAME} asks about shields`, isCoach: false, parsedPages: [], askerIsMember: true, persona: null, groundingText: "", retrieval: { ids: [], abstain: true } }),
    dispatch: async (a) => { sent.push(a); return { answer: "**Use a shield.**", model: "m" }; },
    finish: async (_e, a) => ({ answer: a.rawAnswer }),
  };
  const req = { questions: [{ id: "q1", text: `${NAME} asks about shields`, journey: "curious" }], candidates: [{ label: "g", provider: "gemini", promptVariant: "production" }], cursor: 0, maxCalls: 5, jobId: "j" };
  await runEval({ ASK_RESEARCH: "on" }, req, deps);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].provider, "workers-ai");
  assert.ok(!JSON.stringify([sent[0].systemPrompt, sent[0].userPrompt]).toLowerCase().includes(NAME.toLowerCase()), "no roster name in the evaluation prompt");
  const off = [];
  await runEval({}, { ...req }, { ...deps, research: false, dispatch: async (a) => { off.push(a); return { answer: "x", model: "m" }; } });
  assert.ok(JSON.stringify(off[0].userPrompt).includes(NAME), "flag off: the prompt is untouched");
});
test("6. the stale provider.js header no longer says Workers AI answers when Claude is skipped", () => {
  const head = readFileSync(new URL("../../infrastructure/worker/research/provider.js", import.meta.url), "utf8").split("\n").slice(0, 5).join("\n");
  assert.doesNotMatch(head, /Workers AI \(inside Cloudflare\) answers/);
  assert.match(head, /degraded/i);
});

// ---- 7 ping defang without word boundaries --------------------------------------------------------------------------------------------------------
const FORMS = ["@everyonelol", "@everyone_x", "@here1", "@hereabout", "@EVERYONE", `${FW_AT}everyone`, `@${ZW}${ZW}everyone`, "@ everyone", "x@everyone", "<@123456789012345678>", "<@&123456789012345678>"];
test("7. defangPings, prepareRealPrompt, cleanRealReply and neutraliseMentions break every @everyone/@here form, whatever follows", () => {
  for (const t of FORMS) {
    for (const fn of [defangPings, neutraliseMentions, (x) => cleanRealReply(`ok ${x}`, {}), (x) => prepareRealPrompt({ system: x, user: x }, {}).user]) {
      const out = fn(t);
      assert.ok(!/(?:<@[!&]?\d|[@＠](?!​)[​-‏]*(?:every\s*one|here))/i.test(out.replace(/[@＠]​+/g, "@Z")) || !/[@＠](?:every|here)/i.test(out), `${JSON.stringify(t)} -> ${JSON.stringify(out)}`);
      assert.doesNotMatch(out, /[@＠](?:every\s*one|here)/i, `${JSON.stringify(t)} stays live`);
      assert.doesNotMatch(out, /<@[!&]?\d/, t);
    }
  }
  assert.equal(defangPings(defangPings("@everyonelol")), defangPings("@everyonelol"), "idempotent");
  assert.equal(defangPings("plain text and mail@example.com"), "plain text and mail@example.com");
});
test("7. end to end: pings with trailing characters are defanged in the sent prompt and in the stored reply", async () => {
  const q = "ping @everyonelol and @here1 and @everyone_x about the weather";
  const r = await ask(q, { claude: () => ({ status: 200, text: `**Pinging @everyonelol and @here1 and ${FW_AT}everyone_x.**\nThat is how Classic handled it.\n-# Sources: general · unconfirmed` }) });
  assert.equal(r.anth.length, 1, r.row.model);
  assert.doesNotMatch(r.anth[0].raw, /[@＠](?:every|here)/i);
  assert.doesNotMatch(r.answer, /[@＠](?:every|here)/i);
  const rt = await ask(q, { names: "tokenised", claude: () => ({ status: 200, text: `**Pinging @everyonelol.**\nThat is how Classic handled it.\n-# Sources: general · unconfirmed` }) });
  assert.doesNotMatch(rt.answer, /[@＠](?:every|here)/i);
  for (const a of rt.anth) assert.doesNotMatch(a.raw, /[@＠](?:every|here)/i);
});
test("7. a removed defang is caught: the three layers each have a direct assertion (prompt, reply, finish)", () => {
  assert.notEqual(prepareRealPrompt({ system: "@everyone", user: "@here" }, {}).user, "@here");
  assert.notEqual(cleanRealReply("hi @everyone", {}), "hi @everyone");
  assert.notEqual(neutraliseMentions("hi @everyone"), "hi @everyone");
  assert.notEqual(defangPings("<@123456789012345678>"), "<@123456789012345678>");
});
test("7. web path: the stored reply is the defanged text (the web page shows stored text; allowed_mentions applies to Discord posts only)", () => {
  const src = readFileSync(new URL("../../infrastructure/worker/ai-models.js", import.meta.url), "utf8");
  assert.ok(/neutraliseMentions\(defuseLinks\(parts\.main/.test(src), "finishAnswerText defangs before the row is stored");
  const dc = readFileSync(new URL("../../infrastructure/worker/discord.js", import.meta.url), "utf8");
  assert.ok(/allowed_mentions: ALLOWED_MENTIONS_NONE/.test(dc));
});

test("replyFlagKind names why a reply was dropped, with a fixed word and never a value", async () => {
  const { replyFlagKind } = await import("../../infrastructure/worker/research/real-names.js");
  assert.equal(replyFlagKind("", {}), "empty");
  assert.equal(replyFlagKind("   \n", {}), "empty");
  const key = ["sk", "ant", "x".repeat(12)].join("-");
  assert.equal(replyFlagKind(`here is ${key}`, {}), "anthropic-key");
  assert.equal(replyFlagKind("a normal answer", {}), "other");
  const envVal = "v".repeat(12);
  assert.equal(replyFlagKind(`has ${envVal} inside`, { SOME_SECRET: envVal }), "env-secret");
  for (const out of [replyFlagKind(`here is ${key}`, {}), replyFlagKind("", {})]) assert.ok(!out.includes(key) && /^[a-z-]{1,24}$/.test(out));
});
