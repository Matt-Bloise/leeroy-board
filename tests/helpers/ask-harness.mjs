// A stubbed /ask answer path over a fictional library, for the ASK_PICKED tests and the flag-off differential against master.
// loadHarness(root) imports the Worker modules under `root` (this checkout, or an extracted copy of another commit), so the same scenarios can run against both.
// Fictional members, pages and facts only. No network (fetch is stubbed by the caller), no real AI: env.AI.run returns the reply given.
import { pathToFileURL } from "node:url";
import path from "node:path";

const f = (value, visible = true) => ({ value, visible, source: "board", at: "2026-11-01T00:00:00.000Z" });
export const SHEETS = [
  { slug: "moss-wren", name: "Moss Wren", fields: { class: f("lantern"), race: f("owlkin"), spec_path: f("warden"), level: f(22), role: f("tank"), professions: f(["reedcraft", "stonecutting"]), goals: f("secret goal words", false) }, updated: "x" },
  { slug: "tern-vale", name: "Tern Vale", fields: { class: f("tidecaller"), race: f("reedfolk"), spec_path: f("current", false) }, updated: "x" },
];
const page = (id, title, facts) => ({ id, category: id.split("/")[0], title, blurb: title, facts });
export const LIBRARY = [
  page("callings/lantern", "Lantern", [
    { key: "lantern.role", value: "tank or support; Warden and Beacon paths" },
    { key: "lantern.trainer", value: "Lantern trainers stand in Hollowmere by the bell tower" },
    { key: "lantern.warden.bulwark", value: "Bulwark absorbs 30 percent of damage for 8 seconds" },
  ]),
  page("callings/tidecaller", "Tidecaller", [{ key: "tidecaller.role", value: "healer; Current and Undertow paths" }]),
  page("kinds/overview", "Kinds and calling combinations", [{ key: "kinds.sunward.lantern", value: "Owlkin, Marsh" }, { key: "kinds.duskward.lantern", value: "Reedfolk" }]),
  page("vaults/glass-spire", "Glass Spire", [{ key: "glass_spire.size", value: "the Glass Spire vault holds 10 players" }, { key: "glass_spire.crowns", value: "8 crowns, the last on a timer" }, { key: "glass_spire.opens", value: "the Glass Spire vault opens on 2026-12-09" }]),
  page("crafts/reedcraft", "Reedcraft", [{ key: "reedcraft.trainer", value: "Reedcraft trainers work at the Hollowmere docks" }]),
  page("places/hollowmere", "Hollowmere", [{ key: "hollowmere.trainers", value: "general trainers stand at the Hollowmere market" }]),
];

export const SCENARIOS = [
  { question: "how many players does the glass spire vault hold" },
  { question: "when does the glass spire vault open", share: true },
  { question: "what does a lantern warden do" },
  { question: "what should I train first as a lantern" },
  { question: "where are the reedcraft trainers" },
  { question: "what is the best pizza topping for a vault night" },
  { question: "hi" },
  { question: "what suits my build" },
  { question: "how many crowns in the glass spire", by: "Visitor", memberSlug: undefined, isMember: false },
  { question: "how do I tank as a lantern", journey: "guided", share: false },
  { question: "any better answers to my previous question" },
  { question: "how many players does the glass spire vault hold", by: "Tern Vale", memberSlug: "tern-vale" },
];
export const REPLIES = [
  "**The Glass Spire holds 10 players.**\n\n-# Sources: vaults/glass-spire",
  '["f1"]',
  '["f2","f1"]',
  "[]",
  "The Ember Throne drops at level 60. -# Sources: vaults/ember-throne",
  new Error("down"),
];

export async function loadHarness(root) {
  const imp = (p) => import(pathToFileURL(path.join(root, p)).href);
  const ai = await imp("infrastructure/worker/ai-models.js");
  const { invalidatePersonaCache } = await imp("infrastructure/worker/persona.js");
  const { invalidateConfigCache } = await imp("infrastructure/worker/config.js");
  const { insertAskTurn } = await imp("infrastructure/worker/answer-ux.js");
  const { schemaDb } = await imp("tests/helpers/sqlite-d1.mjs");

  function makeEnv(extra = {}) {
    ai.invalidatePagesCache(); invalidatePersonaCache(); invalidateConfigCache();
    const DB = schemaDb();
    for (const p of LIBRARY) DB.raw.prepare("INSERT INTO lib_pages (id, category, title, blurb, aliases_json, facts_json, updated_at) VALUES (?, ?, ?, ?, '[]', ?, '2026-11-01T00:00:00Z')").run(p.id, p.category, p.title, p.blurb, JSON.stringify(p.facts));
    DB.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES ('party_sheets', ?, 'x')").run(JSON.stringify(SHEETS));
    const room = { fetch: async () => new Response("ok") };
    const aiCalls = [];
    const env = { DB, USER_SALT: "user-salt-for-tests-0123456789", KEY_SALT: "key-salt-for-tests-0123456789", ALLOWED_ORIGINS: "https://leeroy.test", BOARD_ROOM: { idFromName: () => "r", get: () => room }, ...extra };
    env.AI = { run: async (_m, inputs) => { aiCalls.push(inputs.messages); throw new Error("workers ai down"); } };
    return { env, aiCalls };
  }
  const aiSays = (ctx, response) => {
    ctx.env.AI.run = async (_m, inputs) => { ctx.aiCalls.push(inputs.messages); if (response instanceof Error) throw response; return { response: typeof response === "function" ? response(inputs.messages) : response, usage: { prompt_tokens: 5, completion_tokens: 5 } }; };
    return ctx;
  };
  let n = 0;
  async function ask(env, { by = "Moss Wren", memberSlug = "moss-wren", question, share = false, journey = "curious", isMember = true } = {}) {
    const id = `p${++n}`;
    await insertAskTurn(env, { id, byName: by, question, provider: "workers-ai", share, createdAt: "2026-11-01T00:00:00Z" }, {});
    const silence = [console.error, console.warn, console.log]; console.error = () => {}; console.warn = () => {}; console.log = () => {};
    try { await ai.answerWithAi({ env, origin: "https://worker.test", intentId: id, by, memberSlug, question, provider: "workers-ai", share, journey, isMember }); } finally { [console.error, console.warn, console.log] = silence; }
    const row = env.DB.raw.prepare("SELECT answer, cites_json, model, status FROM ask_turns WHERE id = ?").get(id);
    return { answer: row.answer, cites: row.cites_json, model: row.model, status: row.status };
  }
  // buildAnswerInputs as data: everything it returns except the parsed pages and persona objects, with hits reduced to what they say.
  async function inputs(env, { by = "Moss Wren", memberSlug = "moss-wren", question, share = false, journey = "curious", isMember = true } = {}) {
    const r = await ai.buildAnswerInputs(env, { question, by, memberSlug, journey, share, isMember });
    const { parsedPages, persona, hits, ranked, ...rest } = r;
    return { ...rest, hits: hits.map((h) => [h.page, h.key, h.value, h.score]), ranked: ranked.map((p) => p.id) };
  }
  // Runs every scenario with one reply; returns a JSON string of the answers, the stored rows and the exact prompts sent, plus buildAnswerInputs.
  async function runAll(extraEnv, reply, scenarios = SCENARIOS) {
    const out = [];
    n = 0; // the same turn ids on every run: the answer tail is seeded by them (the rare egg line)
    for (const s of scenarios) {
      const ctx = aiSays(makeEnv(extraEnv), reply);
      const r = await ask(ctx.env, s);
      const inp = await inputs(makeEnv(extraEnv).env, s);
      out.push({ s: s.question, r, prompts: ctx.aiCalls, inp });
    }
    return JSON.stringify(out);
  }
  return { ai, makeEnv, aiSays, ask, inputs, runAll };
}
