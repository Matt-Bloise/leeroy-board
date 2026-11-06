// /ask personalisation: the asker's own build reaches the prompt, other members' hidden fields never do, an empty build degrades
// honestly, invented names are replaced by the "not published" line, and the chicken egg is rare and never on a personalised answer.
// Fictional members only. Run: node --test tests/unit/ask-personalisation.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { buildAnswerInputs, buildAnswerCacheKey, finishAnswerText, invalidatePagesCache, PERSONALISE_RULE } from "../../infrastructure/worker/ai-models.js";
import { invalidatePersonaCache } from "../../infrastructure/worker/persona.js";
import { invalidateConfigCache } from "../../infrastructure/worker/config.js";
import { eggDue, DEFAULT_EGG } from "../../infrastructure/worker/answer-format.js";
import { findAskerSheet, unknownNames, NOT_PUBLISHED_LINE } from "../../infrastructure/worker/ask-build.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";

const f = (value, visible = true) => ({ value, visible, source: "board", at: "2026-11-01T00:00:00.000Z" });
const SHEETS = [
  { slug: "red-fox", name: "Red Fox", fields: { class: f("paladin"), race: f("human"), spec_path: f("protection"), level: f(12), professions: f(["mining", "smithing"]), goals: f("tank the Deadmines", false) }, updated: "x" },
  { slug: "blue-owl", name: "Blue Owl", fields: { class: f("mage"), race: f("gnome"), spec_path: f("frost secretspec", false), goals: f("hidden goal text", false), level: f(9) }, updated: "x" },
  { slug: "green-elk", name: "Green Elk", fields: {}, updated: "x" },
];
const LIB = [{ id: "classes/paladin-protection", category: "classes", title: "Protection Paladin", blurb: "Tank basics", facts: [{ key: "pp.tank", value: "Protection Paladins tank with Holy Shield." }] }];

function makeEnv({ sheets = SHEETS, kv = {} } = {}) {
  invalidatePagesCache(); invalidatePersonaCache(); invalidateConfigCache();
  const DB = schemaDb();
  for (const p of LIB) DB.raw.prepare("INSERT INTO lib_pages (id, category, title, blurb, aliases_json, facts_json, updated_at) VALUES (?, ?, ?, ?, '[]', ?, '2026-11-01T00:00:00Z')").run(p.id, p.category, p.title, p.blurb, JSON.stringify(p.facts));
  const put = (k, v) => DB.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES (?, ?, 'x')").run(k, JSON.stringify(v));
  put("party_sheets", sheets);
  for (const [k, v] of Object.entries(kv)) put(k, v);
  return { DB };
}
const inputs = (env, o) => buildAnswerInputs(env, { question: "how do I tank as a paladin", journey: "curious", ...o });

test("the prompt carries the asker's own build, found by slug; their hidden field only on a private ask", async () => {
  const kv = { signups: { roster: { "Red Fox": "yes" } }, tonight: { title: "Deadmines run" } };
  const pub = await inputs(makeEnv({ kv }), { by: "Red Fox", memberSlug: "red-fox", share: true });
  assert.ok(!pub.userPrompt.includes("tank the Deadmines"), "a public ask must not carry the asker's hidden field");
  assert.match(pub.userPrompt, /class: paladin/);
  const { userPrompt, systemPrompt, personalised } = await inputs(makeEnv({ kv }), { by: "Red Fox", memberSlug: "red-fox", share: false });
  assert.match(userPrompt, /YOUR_BUILD/);
  assert.match(userPrompt, /class: paladin/);
  assert.match(userPrompt, /spec_path: protection/);
  assert.match(userPrompt, /professions: mining, smithing/);
  assert.match(userPrompt, /tank the Deadmines/, "private ask: the asker's own hidden field is used for them");
  assert.ok(!userPrompt.includes("secretspec") && !userPrompt.includes("hidden goal text"), "others' hidden fields never");
  assert.match(userPrompt, /signup: yes/);
  assert.match(userPrompt, /tonight: Deadmines run/);
  assert.ok(personalised);
  assert.ok(systemPrompt.includes(PERSONALISE_RULE));
});

test("the asker is found by display name when no slug is given; a visitor matches nothing", async () => {
  const { userPrompt } = await inputs(makeEnv(), { by: "Red Fox" });
  assert.match(userPrompt, /class: paladin/);
  assert.equal(findAskerSheet(SHEETS, { by: "Visitor", isMember: false }), null);
});

test("other members: visible fields only; hidden values never reach the prompt (any journey)", async () => {
  for (const journey of ["curious", "guided"]) {
    const { userPrompt } = await inputs(makeEnv(), { by: "Red Fox", memberSlug: "red-fox", journey });
    assert.match(userPrompt, /PARTY_BUILDS/);
    assert.match(userPrompt, /Blue Owl: class mage/);
    assert.ok(!userPrompt.includes("secretspec"), "hidden spec");
    assert.ok(!userPrompt.includes("hidden goal text"), "hidden goal");
    assert.match(userPrompt, /Green Elk: no public build yet/);
  }
});

test("an empty build degrades honestly; a visitor gets no build", async () => {
  const empty = await inputs(makeEnv(), { by: "Green Elk", memberSlug: "green-elk" });
  assert.match(empty.userPrompt, /fill in their sheet/);
  assert.equal(empty.personalised, false);
  const unknown = await inputs(makeEnv(), { by: "Nobody Here", memberSlug: "nobody-here" });
  assert.match(unknown.userPrompt, /fill in their sheet/);
  const visitor = await inputs(makeEnv(), { by: "Visitor", isMember: false });
  assert.match(visitor.userPrompt, /Visitor: no build on file/);
  assert.ok(!visitor.userPrompt.includes("class: paladin"));
});

test("different askers never share an AI Gateway cache key", async () => {
  const env = makeEnv();
  const a = await inputs(env, { by: "Red Fox", memberSlug: "red-fox" });
  const b = await inputs(env, { by: "Blue Owl", memberSlug: "blue-owl" });
  const key = (i) => buildAnswerCacheKey({ provider: "workers-ai", model: "m", systemPrompt: i.systemPrompt, userPrompt: i.userPrompt });
  assert.notEqual(await key(a), await key(b));
  assert.equal(await key(a), await key(a));
});

test("grounding: an invented spell or place is replaced by the honest line; library and build names pass", async () => {
  const env = makeEnv();
  const i = await inputs(env, { by: "Red Fox", memberSlug: "red-fox" });
  const run = (rawAnswer, personalised = i.personalised) => finishAnswerText(env, { rawAnswer, isCoach: false, parsedPages: i.parsedPages, by: "Red Fox", askerIsMember: true, persona: i.persona, intentId: "t1", groundingText: i.groundingText, personalised });
  const bad = await run("**As a Paladin tank you learn Seal of Fury at level 10.**\n\n-# Sources: classes/paladin-protection");
  assert.ok(bad.answer.includes(NOT_PUBLISHED_LINE));
  assert.ok(!bad.answer.includes("Seal of Fury"));
  const good = await run("**As a Protection Paladin you tank with Holy Shield.**\n\n-# Sources: classes/paladin-protection");
  assert.ok(good.answer.includes("Holy Shield"));
  const realistic = await run("**As a Paladin tank at level 12, you hold threat with Holy Shield.**\n- **Protection Paladin** · tanks with Holy Shield\n- Start with the Tank basics page.\n\n-# Sources: classes/paladin-protection");
  assert.ok(!realistic.answer.includes(NOT_PUBLISHED_LINE), "a good answer is not replaced");
  assert.ok(realistic.answer.includes("Holy Shield"));
  assert.deepEqual(unknownNames("Good luck out there. Red Fox is human.", i.groundingText), []);
});

test("the egg is rare (about 1 in 25) and never on a personalised answer", async () => {
  let n = 0;
  for (let k = 0; k < 5000; k++) if (eggDue(String(1790000000000 + k * 7919), {})) n++;
  assert.ok(n > 120 && n < 290, `expected about 200 of 5000, got ${n}`);
  const env = makeEnv();
  const i = await inputs(env, { by: "Red Fox", memberSlug: "red-fox" });
  let dueId = null;
  for (let k = 0; k < 400 && !dueId; k++) if (eggDue(String(1790000000000 + k), {})) dueId = String(1790000000000 + k);
  const run = (personalised) => finishAnswerText(env, { rawAnswer: "**Holy Shield helps you tank.**", isCoach: false, parsedPages: i.parsedPages, by: "Red Fox", askerIsMember: true, persona: { egg: { oneIn: 1 } }, intentId: dueId, groundingText: i.groundingText, personalised });
  assert.ok(!(await run(true)).answer.includes(DEFAULT_EGG.line));
});

// ---- identity: the authenticated slug decides; a name alone never unlocks hidden fields ----
import { readFileSync } from "node:fs";
import { groundedOrNotPublished } from "../../infrastructure/worker/ask-build.js";

test("conflicting memberSlug and by choose the slug's sheet; a name-only match never gets hidden fields", async () => {
  const slugWins = await inputs(makeEnv(), { by: "Blue Owl", memberSlug: "red-fox", share: false });
  assert.match(slugWins.userPrompt, /Red Fox \(the asker\)/);
  assert.match(slugWins.userPrompt, /tank the Deadmines/);
  assert.ok(!slugWins.userPrompt.includes("hidden goal text"), "Blue Owl's hidden goal stays out");
  const nameOnly = await inputs(makeEnv(), { by: "Blue Owl", share: false });
  assert.match(nameOnly.userPrompt, /Blue Owl \(the asker\)/);
  assert.ok(!nameOnly.userPrompt.includes("hidden goal text") && !nameOnly.userPrompt.includes("secretspec"), "by-only: visible fields only, even on a private ask");
  const unknownSlug = await inputs(makeEnv(), { by: "Red Fox", memberSlug: "someone-else", share: false });
  assert.match(unknownSlug.userPrompt, /fill in their sheet/, "an unknown slug does not fall back to the name");
  assert.ok(!unknownSlug.userPrompt.includes("tank the Deadmines"));
});

test("both Discord answerWithAi call sites pass the verified member slug", () => {
  const src = readFileSync(new URL("../../infrastructure/worker/discord.js", import.meta.url), "utf8");
  const calls = [...src.matchAll(/answerWithAi\(\{[^\n]*\}\)/g)].map((m) => m[0]);
  assert.equal(calls.length, 2);
  for (const c of calls) assert.match(c, /memberSlug: member \? member\.slug : undefined/);
});

// ---- grounding: repair, do not wipe ----
const ALLOWED = "Party: Santa. Protection Paladins tank with Holy Shield. Deadmines is a dungeon. Red Fox: class paladin; level 12";
const g = (a) => groundedOrNotPublished(a, ALLOWED);

test("grounded names, connectors and generic headings pass untouched", () => {
  for (const a of [
    "**Meet in Deadmines at eight.**\n\n-# Sources: classes/paladin-protection",
    "**As a Paladin in Deadmines you tank with Holy Shield.**",
    "**Recommended Next Steps**\n- Tank with Holy Shield.\n\nWorth a Look Next: Deadmines.",
    "Good Luck out there. Then Start with Holy Shield.",
  ]) {
    const r = g(a);
    assert.ok(r.ok, `${a} -> ${r.bad}`);
    assert.equal(r.answer, a);
  }
});

test("an invented name removes only its sentence; the rest and the Sources line survive", () => {
  const r = g("**Protection Paladins tank with Holy Shield.**\n\nFrost Hammer deals huge damage. Deadmines is a good first dungeon.\n- Seal of Fury comes at level 10.\n\n-# Sources: classes/paladin-protection");
  assert.ok(!r.ok);
  assert.ok(!r.answer.includes("Frost Hammer") && !r.answer.includes("Seal of Fury"));
  assert.ok(r.answer.includes("Holy Shield") && r.answer.includes("Deadmines is a good first dungeon"));
  assert.ok(r.answer.includes("-# Sources: classes/paladin-protection"));
});

test("when nothing substantive remains the honest line replaces the answer", () => {
  assert.equal(g("**Frost Hammer is the best weapon.**\n\n-# Sources: classes/paladin-protection").answer, NOT_PUBLISHED_LINE);
});

test("party state in the grounding text lets party names through", async () => {
  const i = await inputs(makeEnv(), { by: "Red Fox", memberSlug: "red-fox" });
  assert.ok(i.groundingText.includes("Party:"));
});

// ---- round 2: fail closed, headings are checked, bold is re-balanced, web-shaped integration ----
import { renderPartyBuilds, renderAskerBuild } from "../../infrastructure/worker/ask-build.js";
import { answerWithAi } from "../../infrastructure/worker/ai-models.js";
import { insertAskTurn } from "../../infrastructure/worker/answer-ux.js";

test("visibility fails closed: missing, null and bare values are hidden for others and for a public ask", () => {
  const sheet = { slug: "x", name: "Ex", fields: { class: { value: "rogue" }, race: { value: "orc", visible: null }, level: 7, goals: { value: "g", visible: "yes" }, spec_path: { value: "combat", visible: true } } };
  const others = renderPartyBuilds([sheet], null);
  assert.match(others, /spec_path combat/);
  for (const hidden of ["rogue", "orc", "7", "\bg\b"]) assert.ok(!new RegExp(hidden).test(others), `${hidden} leaked`);
  const pub = renderAskerBuild(sheet, {}, { includeHidden: false });
  assert.match(pub, /spec_path: combat/);
  assert.ok(!/rogue|orc|level|goals/.test(pub));
  const priv = renderAskerBuild(sheet, {}, { includeHidden: true });
  assert.match(priv, /class: rogue/);
  assert.match(priv, /level: 7/);
});

test("invented names inside headings and colon lead-ins are caught; generic headings are not", () => {
  for (const a of ["# Frost Hammer\n\nHoly Shield helps you tank.", "**Frost Hammer:** deals damage.\n\nHoly Shield helps you tank with a long enough sentence here.", "Here is what you need to know about the new gear drops and rewards for tanks, and also Frost Hammer: it rocks.\n\nHoly Shield helps you tank."]) {
    const r = g(a);
    assert.ok(!r.ok && !r.answer.includes("Frost Hammer"), a);
    assert.ok(r.answer.includes("Holy Shield"), "the rest survives: " + r.answer);
  }
  assert.ok(g("**Recommended Next Steps:**\n\nHoly Shield helps you tank in Deadmines.").ok);
});

test("cutting a sentence out of a bold line leaves no unpaired **", () => {
  const r = g("**Frost Hammer is strong. Holy Shield helps you tank.**\n\nDeadmines is a dungeon.");
  assert.ok(!r.ok);
  assert.equal((r.answer.match(/\*\*/g) || []).length % 2, 0, r.answer);
  assert.ok(r.answer.includes("Holy Shield") && !r.answer.includes("Frost Hammer"));
});

test("web-shaped answerWithAi: the signed-in slug's sheet reaches the model, and not another member's hidden field", async () => {
  const { DB } = makeEnv();
  const prompts = [];
  const env = {
    DB, USER_SALT: "user-salt-for-tests-0123456789", KEY_SALT: "key-salt-for-tests-0123456789", BOARD_ADMIN_TOKEN: "admin-token-for-tests-0123456789abcdef",
    BOARD_ROOM: { idFromName: () => "r", get: () => ({ fetch: async () => new Response("ok") }) },
    AI: { run: async (_m, inputs) => { prompts.push(inputs.messages.map((m) => m.content).join("\n")); return { response: "**Holy Shield helps you tank.**\n\n-# Sources: classes/paladin-protection", usage: { prompt_tokens: 5, completion_tokens: 5 } }; } },
  };
  const id = "web-1";
  await insertAskTurn(env, { id, byName: "Red Fox", question: "how do I tank as a paladin", provider: "workers-ai", share: false, createdAt: new Date().toISOString() }, { slug: "red-fox" });
  const silence = [console.error, console.warn]; console.error = () => {}; console.warn = () => {};
  try { await answerWithAi({ env, origin: "https://worker.test", intentId: id, by: "Red Fox", memberSlug: "red-fox", question: "how do I tank as a paladin", provider: "workers-ai", share: false, isMember: true }); }
  finally { [console.error, console.warn] = silence; }
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /class: paladin/);
  assert.match(prompts[0], /tank the Deadmines/, "private ask by the signed-in member: own hidden field is used");
  assert.ok(!prompts[0].includes("hidden goal text") && !prompts[0].includes("secretspec"));
});
