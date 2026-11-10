// /ask personalisation: the asker's own build reaches the prompt, other members' hidden fields never do, an empty build degrades
// honestly, invented names are replaced by the "not published" line, and the chicken egg is rare and never on a personalised answer.
// Fictional members only. Run: node --test tests/unit/ask-personalisation.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { buildAnswerInputs, buildAnswerCacheKey, finishAnswerText, invalidatePagesCache, PERSONALISE_RULE } from "../../infrastructure/worker/ai-models.js";
import { invalidatePersonaCache } from "../../infrastructure/worker/persona.js";
import { invalidateConfigCache } from "../../infrastructure/worker/config.js";
import { eggDue, DEFAULT_EGG } from "../../infrastructure/worker/answer-format.js";
import { findAskerSheet, unknownNames, NOT_PUBLISHED_LINE, buildRelevant, askerFacts, BUILD_NOT_RELEVANT_LINE } from "../../infrastructure/worker/ask-build.js";
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
const inputsMine = (env, o) => inputs(env, { question: "what suits my build", ...o });

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
  assert.match(visitor.userPrompt, /Visitor: no build; do not mention sheets/);
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
  const slugWins = await inputsMine(makeEnv(), { by: "Blue Owl", memberSlug: "red-fox", share: false });
  assert.match(slugWins.userPrompt, /Red Fox \(the asker\)/);
  assert.match(slugWins.userPrompt, /tank the Deadmines/);
  assert.ok(!slugWins.userPrompt.includes("hidden goal text"), "Blue Owl's hidden goal stays out");
  const nameOnly = await inputsMine(makeEnv(), { by: "Blue Owl", share: false });
  assert.match(nameOnly.userPrompt, /Blue Owl \(the asker\)/);
  assert.ok(!nameOnly.userPrompt.includes("hidden goal text") && !nameOnly.userPrompt.includes("secretspec"), "by-only: visible fields only, even on a private ask");
  const unknownSlug = await inputsMine(makeEnv(), { by: "Red Fox", memberSlug: "someone-else", share: false });
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
const ALLOWED = "Party: Santa, Bible Boi, Street Rat, Handsome Squidward. Protection Paladins tank with Holy Shield. Deadmines is a dungeon. Ragefire Chasm is in Orgrimmar. Onyxia's Lair opens soon. Red Fox: class paladin; level 12";
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

// ---- round 3: possessives, bold labels, sheet wording, property-style pass-through ----
import { HIDDEN_BUILD_LINE } from "../../infrastructure/worker/ask-build.js";

test("possessives of grounded names pass untouched", () => {
  for (const a of [
    "**Bible Boi's signup is yes.** Holy Shield helps you tank.",
    "Street Rat's build is public. Handsome Squidward's plan is set.",
    "Holy Shield's cooldown is in the library page. Ragefire Chasm's entrance is in Orgrimmar.",
    "Onyxia's Lair opens soon.",
  ]) {
    const r = g(a);
    assert.ok(r.ok, `${a} -> ${r.bad}`);
    assert.equal(r.answer, a);
  }
  assert.ok(!g("Frost Hammer's damage is huge. Holy Shield helps you tank.").ok, "a possessive of an invention is still an invention");
});

test("a bold label ending in a colon is not an invention", () => {
  for (const a of ["**Talent Tree:** put points in Protection first.", "**Horde Side:** Ragefire Chasm is in Orgrimmar."]) {
    const r = g(a);
    assert.ok(r.ok, `${a} -> ${r.bad}`);
    assert.equal(r.answer, a);
  }
});

test("the build line never tells visitors, or members with only hidden data on a public ask, to fill in a sheet", async () => {
  const visitor = await inputsMine(makeEnv(), { by: "Visitor", isMember: false });
  assert.ok(!/fill in/.test(visitor.userPrompt));
  const hiddenOnly = [{ slug: "quiet-bat", name: "Quiet Bat", fields: { class: f("rogue", false), level: f(5, false) }, updated: "x" }];
  const pub = await inputsMine(makeEnv({ sheets: hiddenOnly }), { by: "Quiet Bat", memberSlug: "quiet-bat", share: true });
  assert.ok(pub.userPrompt.includes(HIDDEN_BUILD_LINE));
  assert.ok(!/fill in|rogue/.test(pub.userPrompt));
  const priv = await inputsMine(makeEnv({ sheets: hiddenOnly }), { by: "Quiet Bat", memberSlug: "quiet-bat", share: false });
  assert.match(priv.userPrompt, /class: rogue/);
  const none = await inputsMine(makeEnv({ sheets: [{ slug: "new-cat", name: "New Cat", fields: {}, updated: "x" }] }), { by: "New Cat", memberSlug: "new-cat" });
  assert.match(none.userPrompt, /fill in their sheet/);
  assert.ok(!/fill in|sheet/i.test(PERSONALISE_RULE.replace(/Only if YOUR_BUILD says[^;]*;[^.]*\./, "")), "the rule itself mentions sheets only conditionally");
});

test("property: 20 good answers built from grounded names come back unchanged", () => {
  const names = ["Holy Shield", "Deadmines", "Ragefire Chasm", "Bible Boi", "Street Rat", "Handsome Squidward", "Onyxia's Lair"];
  const shapes = [
    (n) => `**${n} is worth a look.**`,
    (n) => `${n}'s notes are in the library.`,
    (n) => `**Recommended Next Steps**\n- Start with ${n}.\n- Then check Deadmines.`,
    (n) => `**Quick Tips:** ${n} comes first.\n\n-# Sources: classes/paladin-protection`,
    (n) => `Meet in ${n} tonight. Good Luck out there.`,
    (n) => `# ${n}\n\nAs a Paladin you tank with Holy Shield.`,
  ];
  let count = 0;
  for (const n of names) for (const shape of shapes) {
    if (count >= 40) break;
    const a = shape(n);
    const r = g(a);
    assert.ok(r.ok && r.answer === a, `${a} -> ${r.bad} / ${r.answer}`);
    count++;
  }
  assert.ok(count >= 20);
});

test("a phrase with an embedded possessive is checked as separate names", () => {
  for (const a of [
    "Street Rat's Holy Shield is your main threat tool.",
    "Bible Boi's Ragefire Chasm run is tonight.",
    "Look at the asker's Red Fox's talents for this.",
  ]) {
    const r = g(a);
    assert.ok(r.ok, `${a} -> ${r.bad}`);
    assert.equal(r.answer, a);
  }
  assert.ok(!g("Street Rat's Frost Hammer is your main threat tool. Holy Shield helps you tank.").ok, "an invented segment is still caught");
});

// AR145 voice: the voice instructions are present, every old guardrail survives, and the prompt grows by under 30 percent.
test("ask system prompt carries the Leeroy voice rule, keeps the guardrails, and grows under 30 percent", async () => {
  const { VOICE_RULE } = await import("../../infrastructure/worker/ai-models.js");
  const { FENCE_RULE } = await import("../../infrastructure/worker/prompt-fence.js");
  const r = await inputs(makeEnv());
  const sp = r.systemPrompt;
  for (const phrase of ["confident, playful, well-read friend", "first sentence answers", "One light smile on the first phone screen", "Never use the words Skippy or honestly", "No personal callouts", "Inform, never instruct"]) {
    assert.ok(VOICE_RULE.includes(phrase), `voice rule lacks: ${phrase}`);
  }
  assert.ok(sp.includes(VOICE_RULE));
  assert.ok(sp.includes(PERSONALISE_RULE));
  assert.ok(sp.includes(FENCE_RULE));
  for (const g of ["Answer ONLY from LIBRARY facts", "The library does not have that yet.", "-# Sources:", "Never write bare web addresses", "2 to 4 sentences"]) {
    assert.ok(sp.includes(g), `guardrail missing: ${g}`);
  }
  const before = sp.replace(`${VOICE_RULE}\n\n`, "");
  assert.ok(before.length < sp.length);
  assert.ok(sp.length / before.length < 1.30, `prompt grew ${((sp.length / before.length - 1) * 100).toFixed(1)}%`);
});

// ---- relevance: the build is kept by default; code suppresses it only when the question names another class or race ----
const FOX = askerFacts(SHEETS[0]); // human paladin, protection, level 12, mining and smithing
const mkFacts = (cls, race, spec = "", professions = "") => askerFacts({ slug: "x", name: "X", fields: { class: f(cls), race: f(race), spec_path: f(spec), level: f(20), professions: f(professions) } });
const MAGE_28 = mkFacts("mage", "gnome", "frost"), UNDEAD_PRIEST = mkFacts("priest", "undead", "holy"), UNDEAD_MAGE = mkFacts("mage", "undead"), MAGE = mkFacts("mage", "human");
const TRUTH = [
  // [question, facts, kept?]  rows from the Nov 9 measurement, then the council cases
  ["best class for a beginner", MAGE_28, true],
  ["What is the cooldown on Will of the Forsaken?", UNDEAD_PRIEST, true],
  ["how many tanks for Onyxia", FOX, true],
  ["what are professions", mkFacts("priest", "human", "", "tailoring, enchanting"), true],
  ["how do I find a group", UNDEAD_PRIEST, true],
  ["How much does Cannibalize heal for an undead mage?", UNDEAD_MAGE, true],
  ["can we all meet in Durotar at level 1", FOX, true],
  ["when is launch", FOX, true],
  ["is there a day/night cycle", FOX, true],
  // self-identification as another class or race: suppressed
  ["I am a Hunter on the Alliance side, where do I train weapon skills", FOX, false],
  ["Where do I train weapon skills, I am a Hunter on the Alliance side?", FOX, false],
  ["I'm a hunter, what pet is best", FOX, false],
  ["as a hunter where do I train", FOX, false],
  ["I play a rogue, best poison?", FOX, false],
  ["I main hunter, what bow", FOX, false],
  ["my hunter needs a bow", FOX, false],
  ["I am a dwarf, where do I start", FOX, false],
  ["as an undead where do I start", FOX, false],
  ["I am a night elf hunter, where do I train", mkFacts("druid", "night elf"), false],
  // self-identification as the stored class or race, and explicit phrases: kept
  ["I am a paladin, how do I tank", FOX, true],
  ["as a human where do I start", FOX, true],
  ["I am a hunter, what is my build good at", FOX, true],
  ["what should my build do next", MAGE, true],
  // third-person mentions never suppress; the model decides
  ["How do I survive a rogue attacking me?", FOX, true],
  ["Where are the Rogue trainers", FOX, true],
  ["How do I open this lock?", FOX, true],
  ["Can a Paladin use two-handed swords?", MAGE, true],
  ["Where can we find a hunter trainer?", FOX, true],
  ["what do night elves get at level 1", FOX, true],
  ["and what is the best mount", mkFacts("mage", ""), true],
];
test("buildRelevant truth table from the real measured rows", () => {
  for (const [q, facts, kept] of TRUTH) assert.equal(buildRelevant(q, facts).relevant, kept, q);
  assert.equal(buildRelevant("I am a hunter", FOX, { skip: "build" }).relevant, true);
});
test("buildRelevant: a follow-up inherits a self-identified suppression unless it self-identifies as the stored class", () => {
  assert.equal(buildRelevant("And which weapon?", FOX, { previousQuestion: "I am a hunter, can I use bows?" }).relevant, false);
  assert.equal(buildRelevant("And which weapon, I am a paladin?", FOX, { previousQuestion: "I am a hunter, can I use bows?" }).relevant, true);
  assert.equal(buildRelevant("And which weapon?", FOX, { previousQuestion: "Can a hunter use bows?" }).relevant, true);
  assert.equal(buildRelevant("And which weapon?", FOX, { previousQuestion: "what should my build train at level 10" }).relevant, true);
});
test("a self-identified different class drops the YOUR_BUILD block; everything else keeps it", async () => {
  const off = await inputs(makeEnv(), { by: "Red Fox", memberSlug: "red-fox", question: "I am a hunter, where do I train pets" });
  assert.ok(off.userPrompt.includes(BUILD_NOT_RELEVANT_LINE));
  assert.ok(!/YOUR_BUILD/.test(off.userPrompt) && !off.userPrompt.includes("class: paladin"));
  assert.equal(off.personalised, false);
  for (const question of ["how do I tank as a paladin", "what does red in a tooltip mean", "when is launch", "where are the hunter pet trainers"]) {
    const on = await inputs(makeEnv(), { by: "Red Fox", memberSlug: "red-fox", question });
    assert.match(on.userPrompt, /YOUR_BUILD/, question);
    assert.ok(!on.userPrompt.includes(BUILD_NOT_RELEVANT_LINE) && on.personalised, question);
  }
});
test("PERSONALISE_RULE leaves the decision to the model and bans personalising invention", () => {
  assert.match(PERSONALISE_RULE, /only when it changes the answer/);
  assert.match(PERSONALISE_RULE, /do not mention it at all/);
  assert.match(PERSONALISE_RULE, /never add facts about items or spells/);
});
