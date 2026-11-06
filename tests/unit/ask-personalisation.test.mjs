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
