// Arm runner internals (tools/voice-eval/run-arms.mjs): fixtures, prompt building through the Worker's own code, finishing, and the provider adapters.
// Everything here is fictional (Testbard, Examplemage and friends). No key is read here: adapters receive credentials from the caller, which reads them only from
// process.env at run time. No adapter ever logs, returns or throws a request body, a response body or a credential: errors are short fixed codes.
import { buildAnswerInputs, finishAnswerText, invalidatePagesCache } from "../../infrastructure/worker/ai-models.js";
import { RESEARCH_MAX_TOKENS } from "../../infrastructure/worker/research/rules.js";
import { prepareResearchPrivacy } from "../../infrastructure/worker/research/claude.js";
import { usableAnswer } from "../../infrastructure/worker/research/label.js";
import { guardUserText, guardBody } from "../../infrastructure/worker/privacy/outbound-guard.js";
import { isFollowUp } from "../../infrastructure/worker/self-rag.js";
import { ROSTER_DATA } from "../../infrastructure/worker/bot-data.js";
import { invalidatePersonaCache } from "../../infrastructure/worker/persona.js";
import { invalidateConfigCache } from "../../infrastructure/worker/config.js";
import { schemaDb } from "../../tests/helpers/sqlite-d1.mjs";
import { questionWords } from "../../infrastructure/worker/rank-core.js";
import { mulberry32, sha256Hex } from "./lib.mjs";

// The flag-off answer call in ai-models.js (ANSWER_GEN_PARAMS, not exported). A unit test pins this literal against the source.
export const FLAG_OFF_GEN = { max_tokens: 350, temperature: 0.3 };
export const RESEARCH_GEN = { max_tokens: RESEARCH_MAX_TOKENS, temperature: FLAG_OFF_GEN.temperature };
export const WORKERS_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
export const DEFAULT_CLAUDE_MODEL = "claude-haiku-5-5";
export const MODEL_ID_RE = /^[A-Za-z0-9._:-]{1,80}$/;

// Real arm names (private: only mapping.json and usage.json carry them). The files the judge sees use arm1..arm3.
export const ARMS = [
  { name: "prod-prompt-llama", research: false, provider: "workers-ai", gen: FLAG_OFF_GEN },
  { name: "restored-llama", research: true, provider: "workers-ai", gen: RESEARCH_GEN },
  { name: "restored-claude", research: true, provider: "claude", gen: { max_tokens: RESEARCH_MAX_TOKENS } },
];

// Offline flow (--emit-prompts / --ingest-answers): the answers come from models run elsewhere. Arm A is the production prompt (model-agnostic), B and C are the same
// research-mode prompt for a Haiku-class and a Sonnet-class model. The research arms use provider "claude" so the same tokenise and guard checks apply before emitting.
export const OFFLINE_ARMS = [
  { name: "prod-prompt", research: false, provider: "workers-ai", gen: FLAG_OFF_GEN },
  { name: "restored-haiku", research: true, provider: "claude", gen: { max_tokens: RESEARCH_MAX_TOKENS } },
  { name: "restored-sonnet", research: true, provider: "claude", gen: { max_tokens: RESEARCH_MAX_TOKENS } },
];

// ---- fictional fixtures -------------------------------------------------------------------------------------------------------------------------------
const f = (value) => ({ value, visible: true, source: "board", at: "2026-11-01T00:00:00.000Z" });
export const ASKER = { name: "Fakepriest", slug: "fakepriest" };
// No sheet for Examplemage: with one, the outbound guard flags the ordinary phrase "the game" (a fuzzy match against that name), which would skip Claude for two of the 4b prompts. Its name still appears in prompts as plain text.
export const SHEETS = [
  { slug: "testbard", name: "Testbard", fields: { class: f("bard"), race: f("human"), level: f(19), role: f("support"), professions: f("tailoring, herbalism") }, updated: "x" },
  { slug: "sampleshaman", name: "Sampleshaman", fields: { spec_path: f("restoration"), race: f("orc"), level: f(20), role: f("healer"), professions: f("herbalism, alchemy") }, updated: "x" },
  { slug: "fakepriest", name: "Fakepriest", fields: { spec_path: f("holy"), race: f("dwarf"), level: f(18), role: f("healer"), professions: f("tailoring, enchanting") }, updated: "x" },
  { slug: "demorogue", name: "Demorogue", fields: { spec_path: f("combat"), race: f("elf"), level: f(22), role: f("damage"), professions: f("mining, skinning") }, updated: "x" },
];

// One library page per prompt that carries facts (the prompt's own frozen facts are the library's contents); prompts with no facts find nothing and so
// exercise the "library lacks it" state in both modes.
export function seedDb(prompts) {
  const DB = schemaDb();
  const page = DB.raw.prepare("INSERT OR REPLACE INTO lib_pages (id, category, title, blurb, aliases_json, facts_json, updated_at) VALUES (?, ?, ?, ?, '[]', ?, '2026-11-01T00:00:00Z')");
  for (const p of prompts) {
    if (!Array.isArray(p.facts) || !p.facts.length) continue;
    // The ranker matches a fact on its dotted key plus its value, and abstains when too many question words appear nowhere in the library. The frozen facts are terse
    // ("levels 18 to 24"), so each fact's key is built from the question's own content words: the library "holds" the answer to its prompt, which is the state under test.
    const base = [...new Set(questionWords(`${p.previous || ""} ${p.prompt}`))].slice(0, 6).join(".") || p.id;
    const facts = p.facts.map((v, i) => ({ key: `${base}.${String.fromCharCode(97 + i)}`, value: String(v) }));
    page.run(`testlib/${p.id}`, "guides", String(p.facts[0]), String(p.facts[0]), JSON.stringify(facts));
  }
  DB.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES ('party_sheets', ?, 'x')").run(JSON.stringify(SHEETS));
  return DB;
}

export function makeEnv(DB) {
  // No AI binding, no keys, no flags: the harness never calls a provider through the Worker. The flag-off path is exactly the Worker's defaults.
  return { DB, BOARD_PUBLIC_URL: "https://leeroy.party" };
}

// The nonce in a tokenised prompt comes from crypto.getRandomValues. Seeded here (only for the synchronous privacy call) so a run is reproducible.
function withSeededNonce(rng, fn) {
  const desc = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: { getRandomValues: (a) => { for (let i = 0; i < a.length; i++) a[i] = Math.floor(rng() * 256); return a; } } });
  try { return fn(); } finally { Object.defineProperty(globalThis, "crypto", desc); }
}

// The Worker's own prompts hardcode the real five display names (the group line in the system prompt, the "Party:" line in the user prompt). Every arm gets the same
// fictional names instead, before tokenising: real roster entry i becomes fictional name i, built at runtime from ROSTER_DATA (no real name is written in this tool).
// The only differences from the Worker's output are those name substitutions; nothing else is touched. So no real name is in a prompt, a provider request or an answer.
export const FICTIONAL_NAMES = ["Testbard", "Examplemage", "Sampleshaman", "Fakepriest", "Demorogue"];
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const REAL_TO_FICTIONAL = ROSTER_DATA.map((r, i) => [new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(r.display)}(?![\\p{L}\\p{N}])`, "gu"), FICTIONAL_NAMES[i % FICTIONAL_NAMES.length]]);
export const fictionaliseRoster = (text) => REAL_TO_FICTIONAL.reduce((t, [re, to]) => t.replace(re, to), String(text));

// ---- prompt building (the Worker's own code) ----------------------------------------------------------------------------------------------------------
// Returns one plan item: the exact system and user prompt the arm sends, plus what finishing needs. Never calls a provider.
export async function planItem(env, arm, p, seed) {
  invalidatePersonaCache(); invalidateConfigCache();
  const previousQuestion = p.previous && isFollowUp(p.prompt) ? String(p.previous) : null;
  const inputs = await buildAnswerInputs(env, { question: p.prompt, by: ASKER.name, memberSlug: ASKER.slug, journey: "curious", share: true, isMember: true, previousQuestion, research: arm.research });
  const rawSystem = fictionaliseRoster(inputs.systemPrompt);
  const rawUser = fictionaliseRoster(inputs.userPrompt);
  const item = { arm, p, inputs, previousQuestion, rawSystem, rawUser, system: rawSystem, user: rawUser, priv: null, blocked: null, composed: inputs.abstainAnswer || null, maxTokens: arm.gen.max_tokens };
  if (!arm.research) return item;
  const priv = withSeededNonce(mulberry32(`${seed}:nonce:${p.id}`), () => prepareResearchPrivacy({ systemPrompt: rawSystem, userPrompt: rawUser, question: p.prompt, previousQuestion, by: ASKER.name, party: inputs.researchParty }));
  item.priv = priv;
  if (arm.provider === "claude") {
    // The same checks as research/claude.js tryResearchClaude, before any send: anything that fails means no Claude call (no Workers AI fallback here: the arm is Claude or nothing).
    if (!priv.ok) { item.blocked = priv.reason || "tokenise:error"; return item; }
    try {
      guardUserText(priv.userSegments, priv.roster);
      for (const seg of priv.partySegments) guardUserText([seg], priv.roster);
      guardBody(claudeBody(priv.system, priv.user, "model-placeholder", arm.gen.max_tokens), priv.roster);
    } catch (e) { item.blocked = e && e.code === "OUTBOUND_IDENTIFIER_LEAK" ? "guard:leak" : "guard:config"; return item; }
  }
  if (priv.ok) { item.system = priv.system; item.user = priv.user; } // as answerWithAi: the tokenised prompt is what is sent; if tokenising failed Workers AI takes the prompt as it is
  return item;
}

// The body research/claude.js sends through callAnthropicClaude (wantUsage: no cache_control).
export const claudeBody = (system, user, model, maxTokens) => ({ model, max_tokens: maxTokens, system: [{ type: "text", text: system }], messages: [{ role: "user", content: user }] });

// Raw model text -> the finished answer, as answerWithAi does it. Returns { answer } or { error }.
export async function finishItem(env, item, rawText) {
  const { arm, p, inputs } = item;
  let rawAnswer = rawText;
  if (item.composed) rawAnswer = item.composed;
  else if (item.priv && item.priv.ok) {
    const cleaned = item.priv.clean(rawText);
    if (cleaned === null) return { error: String(rawText || "").trim() ? "reply:flagged" : "reply:empty" }; // a name we never send, or a token that is not ours
    rawAnswer = cleaned;
    if (arm.research && !usableAnswer(rawAnswer)) return { error: "reply:unusable" };
  } else if (arm.research && !usableAnswer(rawAnswer)) return { error: "reply:unusable" };
  if (!String(rawAnswer || "").trim()) return { error: "reply:empty" };
  invalidatePersonaCache(); invalidateConfigCache();
  const { answer } = await finishAnswerText(env, {
    rawAnswer, isCoach: inputs.isCoach, parsedPages: inputs.parsedPages, by: ASKER.name, askerIsMember: inputs.askerIsMember, persona: inputs.persona,
    intentId: `harness-${p.id}`, groundingText: inputs.groundingText, personalised: inputs.personalised || Boolean(item.composed), retrieval: inputs.retrieval,
    trusted: Boolean(item.composed), question: p.prompt, opener: inputs.opener, research: arm.research,
  });
  return String(answer || "").trim() ? { answer } : { error: "reply:empty" };
}

export const resetCaches = () => invalidatePagesCache();

// ---- token estimate (the repo's own rule: characters / 3, plus the output allowance) ----------------------------------------------------------------------
export const estimateIn = (item) => Math.ceil((item.system.length + item.user.length) / 3);
export const estimateOut = (item) => item.maxTokens;

// ---- adapters -------------------------------------------------------------------------------------------------------------------------------------------
class ProviderError extends Error {
  constructor(code, status) { super(code); this.name = "ProviderError"; this.code = code; this.status = status || 0; }
}
const TIMEOUT_MS = 60000;

async function post(fetchImpl, url, headers, bodyObject) {
  let resp;
  try {
    resp = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(bodyObject), signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw new ProviderError(e && (e.name === "TimeoutError" || e.name === "AbortError") ? "timeout" : "network");
  }
  if (!resp.ok) throw new ProviderError(`http-${resp.status}`, resp.status);
  try { return await resp.json(); } catch { throw new ProviderError("parse"); }
}

// Workers AI over the Cloudflare REST API. Credentials come from the caller (process.env), go only into the URL path and the Authorization header.
export function workersAiAdapter({ accountId, token, model = WORKERS_AI_MODEL, fetchImpl = globalThis.fetch, seed = null }) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${model}`;
  return async ({ system, user, gen }) => {
    const data = await post(fetchImpl, url, { authorization: `Bearer ${token}` }, {
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      max_tokens: gen.max_tokens, temperature: gen.temperature,
      ...(Number.isInteger(seed) ? { seed } : {}),
    });
    const r = data && data.result;
    const text = r && typeof r.response === "string" ? r.response : "";
    const u = (r && r.usage) || {};
    return { text, usage: { input: Number(u.prompt_tokens) || 0, output: Number(u.completion_tokens) || 0 } };
  };
}

// Anthropic Messages API, direct (not through the gateway). The key goes only into the x-api-key header.
export function claudeAdapter({ apiKey, model = DEFAULT_CLAUDE_MODEL, fetchImpl = globalThis.fetch }) {
  return async ({ system, user, gen }) => {
    const data = await post(fetchImpl, "https://api.anthropic.com/v1/messages", { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }, claudeBody(system, user, model, gen.max_tokens));
    const text = Array.isArray(data && data.content) ? data.content.filter((b) => b && b.type === "text").map((b) => b.text).join("") : "";
    const u = (data && data.usage) || {};
    return { text, usage: { input: (Number(u.input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0), output: Number(u.output_tokens) || 0 } };
  };
}

// ---- dry-run: recorded fake replies, no network ---------------------------------------------------------------------------------------------------------
// A small bank of canned replies in the shapes the models produce. {T} is replaced by the first name token found in the prompt (so detokenising is exercised),
// or removed when the prompt has none. Chosen by a hash of seed, arm and prompt id: the same seed gives the same files.
const CANNED = [
  "**Short answer first.** That one is a plain pick, and {T} should take the sturdier route.\nChoose the other only if the group changes.\n-# Sources: general Classic-era knowledge · unconfirmed",
  "Fair question, and I did read the notes. The steady option wins for most tables, so go with it, {T}.\nIf the group is short on healing, swap.\n-# Sources: the library · likely",
  "**Here is the version without the drama.** Do the careful thing first, then the clever thing. It is the same advice as always.\n-# Sources: general Classic-era knowledge · unconfirmed",
  "Not my finest hour to say so, but yes. {T} has the right idea here, and the trade-off is time, not gold.\n-# Sources: the library · likely",
  "**Take the first option.** It is steadier, it is cheaper, and it forgives mistakes. Pick the second only if you enjoy punishment.\n-# Sources: general Classic-era knowledge · likely",
];
const TOKEN_RE = /\{P\d+\.[a-z0-9]+\}/;
export function fakeAdapter({ seed, armName }) {
  return async ({ system, user, id }) => {
    const n = parseInt(sha256Hex(`${seed}:${armName}:${id}`).slice(0, 8), 16) % CANNED.length;
    const tok = (user.match(TOKEN_RE) || [""])[0];
    const text = CANNED[n].replace("{T}", tok || "friend");
    return { text, usage: { input: Math.ceil((system.length + user.length) / 3), output: Math.ceil(text.length / 4) } };
  };
}
