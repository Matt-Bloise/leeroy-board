// Delta fixes after the second read of PR 370, written red first. Token-shaped fixtures are built at runtime, never written as literals (push protection).
//  1 a field with anything secret-shaped is dropped whole (no partial redaction, no markers)   2 lower-case Authorization: bearer   3 hex shapes   4 defang leaves emails and channel links
//  5 guest fail-closed label   6 the final leftover scan and eval's research_prompt_not_tokenised are pinned
// Run: node --test tests/unit/ask-real-names-delta.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { answerWithAi, invalidatePagesCache } from "../../infrastructure/worker/ai-models.js";
import { invalidatePersonaCache } from "../../infrastructure/worker/persona.js";
import { invalidateConfigCache } from "../../infrastructure/worker/config.js";
import { resetKeyCacheForTests } from "../../infrastructure/worker/ai-keys.js";
import { ROSTER_DATA } from "../../infrastructure/worker/bot-data.js";
import { resetResearchClaudeForTests, privacyBudget } from "../../infrastructure/worker/research/claude.js";
import { setFirstNameSource } from "../../infrastructure/worker/privacy/roster-config.js";
import { scanSecrets, defangPings, prepareRealPrompt } from "../../infrastructure/worker/research/real-names.js";
import { DEGRADED_SUFFIX } from "../../infrastructure/worker/research/provider.js";
import { runEval } from "../../infrastructure/worker/eval.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";

const FAKE_KEY = "sk-ant-FAKE-TEST-0000";
const OK = "**Short answer first.**\nThat is how Classic handled it.\n-# Sources: general Classic-era knowledge · unconfirmed";
const realFetch = globalThis.fetch;
let anth = [];
let wai = [];
globalThis.fetch = async (url, init) => {
  if (String(url).includes("anthropic")) {
    anth.push({ raw: init.body, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ content: [{ type: "text", text: OK }], usage: { input_tokens: 5, output_tokens: 5 } }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response("{}", { status: 200 });
};
const fakeAi = { run: async (_m, inputs) => { wai.push(inputs); return { response: OK, usage: { prompt_tokens: 5, completion_tokens: 5 } }; } };
test.after(() => { globalThis.fetch = realFetch; });
test.beforeEach(() => { resetKeyCacheForTests(); resetResearchClaudeForTests(); setFirstNameSource(null); privacyBudget.ms = 1000; });

// runtime-built fixtures
const WEBHOOK_TOKEN = ["Wq", "Zx", "9Lm", "Nb", "4Tr", "8Yu", "2Ik", "7Op", "5As", "3Df", "6Gh", "1Jk", "0Pl", "Mn", "Bv", "Cx"].join("");
const WEBHOOK = ["https://discord.com/api/web", "hooks/", "123456789012345678", "/", WEBHOOK_TOKEN].join("");
const KEY_BODY = ["MIIEvQIBADANBgkqhkiG9w0BAQEFAASC", "BKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj", "MzEfYyjiWA4R4/M2bS1GB4t7NXp98C3S"].join("");
const KEY_BEGIN = ["-----BEGIN ", "PRIVATE KEY-----"].join("");
const KEY_END = ["-----END ", "PRIVATE KEY-----"].join("");
const PEM = `${KEY_BEGIN}\n${KEY_BODY}\n${KEY_END}`;
const SHA40 = ["356a192b7913b04c", "54574d18c28d46e6", "395428ab"].join("");
const MD5 = ["d41d8cd98f00b204", "e9800998ecf8427e"].join("");
const ZW = String.fromCharCode(0x200b);
const f = (value) => ({ value, visible: true, source: "board", at: "2026-11-01T00:00:00.000Z" });
const TANK = { id: "classes/tanking", category: "classes", title: "Tanking", blurb: "Who tanks", facts: [{ key: "tanking.tonight", value: "Who tanks tonight is agreed in the party channel." }] };
const ABSTAIN_Q = "tell me about the weather";
const NAME = ROSTER_DATA[2].display;

let n = 0;
async function ask(question, { names = "real", by = "Red Fox", memberSlug = "red-fox", isMember = true, sheets = null, state = null } = {}) {
  invalidatePersonaCache(); invalidatePagesCache(); invalidateConfigCache();
  const DB = schemaDb();
  DB.raw.prepare("INSERT OR REPLACE INTO lib_pages (id, category, title, blurb, aliases_json, facts_json, updated_at) VALUES (?, ?, ?, ?, '[]', ?, '2026-11-01T00:00:00Z')").run(TANK.id, TANK.category, TANK.title, TANK.blurb, JSON.stringify(TANK.facts));
  DB.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES ('party_sheets', ?, 'x')").run(JSON.stringify(sheets || [{ slug: "red-fox", name: "Red Fox", fields: { class: f("paladin"), level: f(12) }, updated: "x" }]));
  for (const [k, v] of Object.entries(state || {})) DB.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES (?, ?, 'x')").run(k, JSON.stringify(v));
  const env = { DB, AI: fakeAi, GROQ_API_KEY: "g", GEMINI_API_KEY: "g", ANTHROPIC_API_KEY: FAKE_KEY, ASK_RESEARCH: "on", RESEARCH_NAMES: names, BOARD_ROOM: { idFromName: () => "r", get: () => ({ fetch: async () => new Response("ok") }) } };
  const id = `rd${++n}`;
  DB.raw.prepare("INSERT INTO ask_turns (id, by_name, question, model, status, share, created_at) VALUES (?, ?, ?, 'groq', 'thinking', 1, ?)").run(id, by, question, new Date().toISOString());
  anth = []; wai = [];
  const real = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of Object.keys(real)) console[k] = () => {};
  try { await answerWithAi({ env, origin: "https://worker.test", intentId: id, by, memberSlug, question, provider: "groq", share: true, deep: false, journey: "curious", isMember }); } finally { Object.assign(console, real); }
  const row = DB.raw.prepare("SELECT answer, model, status FROM ask_turns WHERE id = ?").get(id);
  return { row: { ...row }, answer: row.answer, anth: anth.slice(), wai: wai.slice() };
}
const bodyOf = (r) => r.anth.map((a) => a.raw).join("\n");
const clean = (r, what) => {
  assert.equal(r.anth.length, 1, `${what}: ${r.row.model}`);
  assert.ok(!r.row.model.endsWith(DEGRADED_SUFFIX), `${what}: not degraded`);
  const b = bodyOf(r);
  for (const bad of [WEBHOOK_TOKEN, KEY_BODY, "[redacted]", "123456789012345678", SHA40]) assert.ok(!b.includes(bad), `${what}: ${bad.slice(0, 8)} leaked`);
  assert.ok(!/api\/webhooks|PRIVATE KEY/.test(b), `${what}: no fragment of the shape remains`);
};

// ---- 1 drop the whole field ----------------------------------------------------------------------------------------------------------------------
test("1. a sheet field holding a webhook URL or a private key is dropped whole (no markers, no partial URL), the other fields stay, the ask goes on", async () => {
  for (const names of ["real", "tokenised"]) {
    for (const [what, text] of [["webhook", `ping ${WEBHOOK} when raid starts`], ["private key", PEM], ["lone BEGIN line", `${KEY_BEGIN}\n${KEY_BODY}\nmore notes after it`], ["webhook url alone", WEBHOOK]]) {
      const sheets = [{ slug: "red-fox", name: "Red Fox", fields: { class: f("paladin"), level: f(12), goals: f(text) }, updated: "x" }];
      const r = await ask(ABSTAIN_Q, { names, sheets });
      clean(r, `${names} ${what}`);
      assert.ok(bodyOf(r).includes("paladin"), `${names} ${what}: the sibling field stays`);
    }
  }
});
test("1. a secret on a line of the tonight title or a sign-up (real mode) drops that line whole and the ask goes on", async () => {
  for (const text of [`Raid night ${WEBHOOK}`, `${KEY_BEGIN} ${KEY_BODY} ${KEY_END}`]) {
    const r = await ask(ABSTAIN_Q, { names: "real", state: { tonight: { title: text }, signups: { roster: { "Red Fox": { note: text } } } } });
    clean(r, "title/sign-up");
  }
});
test("1. prepareRealPrompt drops a secret line whole, whatever surrounds it, and a lone BEGIN line takes the rest of the text", () => {
  const out = prepareRealPrompt({ system: "keep system", user: `line one\nsee ${WEBHOOK} now\nline three\n${KEY_BEGIN}\n${KEY_BODY}\nafter the key` }, {});
  assert.ok(out.user.includes("line one") && out.user.includes("line three"));
  assert.ok(!/webhooks|123456789012345678|\[id\]|\[redacted\]|PRIVATE KEY/.test(out.user) && !out.user.includes(WEBHOOK_TOKEN) && !out.user.includes(KEY_BODY));
  assert.ok(!out.user.includes("after the key"), "a lone BEGIN line takes the rest");
  assert.equal(out.system, "keep system");
});

// ---- 2 lower-case Authorization: bearer ---------------------------------------------------------------------------------------------------------
test("2. 'Authorization: bearer <token>' is caught in any case; the bare word 'bearer' stays case-sensitive", () => {
  const tail = "ghijklmnop0123456789qrstuvwxyzGHIJKLMN";
  for (const h of [`Authorization: bearer ${tail}`, `authorization:bearer ${tail}`, `AUTHORIZATION: BEARER ${tail}`, `Authorization: Bearer ${tail}`]) assert.ok(scanSecrets(h, {}).length > 0, h);
  assert.deepEqual(scanSecrets(`a standard bearer ${tail}`, {}), [], "bare lower-case word");
  assert.deepEqual(scanSecrets("Authorization: bearer of the standard", {}), []);
});

// ---- 3 hex shapes --------------------------------------------------------------------------------------------------------------------------------
test("3. md5, 32+ zeros and short hex are not secrets; a 40+ hex with 12+ distinct characters is", () => {
  assert.deepEqual(scanSecrets(`md5 ${MD5}`, {}), []);
  assert.deepEqual(scanSecrets(`zeros ${"0".repeat(40)} and ${"a".repeat(48)} and ${"0123456789".repeat(5)}`, {}, { ids: false }), []); // ids:false: a long digit run is the id rule's business, this is the hex rule
  assert.ok(scanSecrets(`sha ${SHA40}`, {}).length > 0);
});
test("3. a hex string in the asker's own question is redacted and the ask goes on (not stopped); an md5 or zeros reach Claude untouched", async () => {
  for (const names of ["real", "tokenised"]) {
    const r = await ask(`what is the commit ${SHA40} about`, { names });
    assert.equal(r.anth.length, 1, `${names}: ${r.row.model}`);
    assert.ok(!r.row.model.endsWith(DEGRADED_SUFFIX));
    assert.ok(!bodyOf(r).includes(SHA40), "the hex is not sent");
    const m = await ask(`what is the checksum ${MD5} and ${"0".repeat(40)}`, { names });
    assert.equal(m.anth.length, 1);
    assert.ok(bodyOf(m).includes(MD5), "an md5 is ordinary text");
  }
});

// ---- 4 defang leaves ordinary text ---------------------------------------------------------------------------------------------------------------
test("4. defangPings leaves email addresses and channel links alone, keeps whitespace variants in place, still breaks pings with trailing characters", () => {
  for (const t of ["bob@hereford.co.uk", "contact@heresy.gg", "write to a.b@everyone-club.org", "<#123456789012345678>"]) assert.equal(defangPings(t), t, t);
  assert.ok(defangPings("@everyonelol").includes(ZW));
  assert.ok(defangPings("x@everyone").includes(ZW), "a letter before the @ is not an email by itself");
  assert.ok(defangPings("@hereafter").includes(ZW));
  assert.equal(defangPings("@ here").replace(ZW, ""), "@ here", "the space stays");
  assert.equal(defangPings("@\nhere").replace(ZW, ""), "@\nhere", "the newline stays");
  assert.ok(!/@(?:\s{0,3})here/.test(defangPings("@ here")) || defangPings("@ here").includes(ZW));
  assert.equal(defangPings(defangPings("@ here")), defangPings("@ here"), "idempotent");
});

// ---- 5 guest fail-closed label -------------------------------------------------------------------------------------------------------------------
test("5. a guest whose prompt cannot be tokenised is labelled library:degraded-*+research [guard:tokenise]+degraded and the line promises nothing", async () => {
  setFirstNameSource(() => { throw new Error("roster source down"); });
  const g = await ask("who tanks tonight", { isMember: false, by: "Visitor", memberSlug: "" });
  assert.equal(g.wai.length, 0);
  assert.match(g.row.model, /^library:degraded-(?:library-facts|honest-line)\+research \[guard:tokenise\]\+degraded$/);
  const g2 = await ask(ABSTAIN_Q, { isMember: false, by: "Visitor", memberSlug: "" });
  assert.match(g2.row.model, /^library:degraded-honest-line\+research \[guard:tokenise\]\+degraded$/);
  assert.doesNotMatch(g2.answer, /research hand|proper run|again|minutes?\b|soon|later/i);
  assert.match(g2.answer, /would settle it/i);
});

// ---- 6 the leftover scan and eval's refusal ------------------------------------------------------------------------------------------------------
test("6. the final leftover scan: a secret shape that survives the line drop (it spans a newline) fails closed", () => {
  const tail = "ghijklmnop0123456789qrstuvwx";
  assert.throws(() => prepareRealPrompt({ system: "s", user: `x Bearer\n${tail} y` }, {}), (e) => e.code === "OUTBOUND_SECRET");
  assert.throws(() => prepareRealPrompt({ system: `Bearer\n${tail}`, user: "u" }, {}), (e) => e.code === "OUTBOUND_SECRET");
});
test("6. admin evaluation: a prompt that cannot be tokenised fails the candidate with research_prompt_not_tokenised and nothing is dispatched", async () => {
  setFirstNameSource(() => { throw new Error("roster source down"); });
  const sent = [];
  const deps = {
    now: () => 1_000_000, sleep: async () => {}, lastCallAt: new Map(), cooldownUntil: new Map(), configured: () => true, budgetVerdict: async () => null, research: true,
    buildInputs: async () => ({ systemPrompt: `You help ${NAME}.`, userPrompt: `${NAME} asks`, isCoach: false, parsedPages: [], askerIsMember: true, persona: null, groundingText: "", retrieval: { ids: [], abstain: true }, researchParty: { failed: true } }),
    dispatch: async (a) => { sent.push(a); return { answer: "x", model: "m" }; },
    finish: async (_e, a) => ({ answer: a.rawAnswer }),
  };
  const out = await runEval({ ASK_RESEARCH: "on" }, { questions: [{ id: "q1", text: "hi", journey: "curious" }], candidates: [{ label: "g", provider: "gemini", promptVariant: "production" }], cursor: 0, maxCalls: 5, jobId: "j" }, deps);
  assert.equal(sent.length, 0);
  assert.equal(out.results[0].ok, false);
  assert.equal(out.results[0].error, "research_prompt_not_tokenised");
});
