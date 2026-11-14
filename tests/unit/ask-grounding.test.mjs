// /ask grounding: the party's factions and the asker's are derived from data, library facts carry their source scope, a "no X" claim needs a library clause that says
// so, a leading Yes or No is dropped for a mixed group, and the name check no longer deletes a grounded "Name in Place" sentence. Fictional members only
// (Red Fox, Blue Owl, Green Elk). Run: node --test tests/unit/ask-grounding.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { groupComposition, factionTag, scopeOf, scopeTag, stripVerdictOpener, GROUNDING_RULE } from "../../infrastructure/worker/ask-grounding.js";
import { unknownNames, groundedOrNotPublished } from "../../infrastructure/worker/ask-build.js";
import { buildAnswerInputs, finishAnswerText, invalidatePagesCache } from "../../infrastructure/worker/ai-models.js";
import { invalidatePersonaCache } from "../../infrastructure/worker/persona.js";
import { invalidateConfigCache } from "../../infrastructure/worker/config.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";

const f = (value, visible = true) => ({ value, visible, source: "board", at: "2026-11-01T00:00:00.000Z" });
const FOX = { slug: "red-fox", name: "Red Fox", fields: { class: f("paladin"), race: f("human"), spec_path: f("protection"), level: f(34) }, updated: "x" };
const OWL = { slug: "blue-owl", name: "Blue Owl", fields: { class: f("mage"), race: f("orc"), level: f(28) }, updated: "x" };
const ELK = { slug: "green-elk", name: "Green Elk", fields: { class: f("priest"), race: f("undead", false), level: f(31) }, updated: "x" };
const ELK_HORDE = { ...ELK, fields: { ...ELK.fields, race: f("troll") } };

test("groupComposition: mixed, single-faction and hidden races come from the sheets, nothing is assumed", () => {
  const mixed = groupComposition([FOX, OWL, ELK]);
  assert.equal(mixed.mixed, true);
  assert.deepEqual(mixed.alliance, ["Red Fox"]);
  assert.deepEqual(mixed.horde, ["Blue Owl"]);
  assert.deepEqual(mixed.unknown, ["Green Elk"], "a hidden race counts as not on file");
  assert.match(mixed.line, /^mixed faction; Horde: Blue Owl; Alliance: Red Fox; faction not on file: Green Elk$/);
  assert.ok(!/undead/i.test(mixed.line), "the hidden race never leaks");
  const horde = groupComposition([OWL, ELK_HORDE]);
  assert.equal(horde.mixed, false);
  assert.match(horde.line, /^Horde only among the sheets that say; Horde: Blue Owl, Green Elk$/);
  assert.equal(groupComposition([]).line, "");
  assert.match(groupComposition([ELK]).line, /^no faction on file for anyone/);
  // the asker's own hidden race counts on a private ask only
  assert.equal(groupComposition([ELK], { askerSheet: ELK, includeHidden: true }).horde.length, 1);
  assert.equal(groupComposition([ELK], { askerSheet: ELK, includeHidden: false }).horde.length, 0);
});

test("factionTag marks a fact for the other faction and nothing else", () => {
  assert.match(factionTag("systems/x", "the Horde trainers stand in Razor Hill", "Alliance"), /Horde fact/);
  assert.match(factionTag("races/horde-racials", "a racial", "Alliance"), /Horde fact/);
  assert.equal(factionTag("systems/x", "Horde and Alliance both train here", "Alliance"), "");
  assert.equal(factionTag("systems/x", "the Horde trainers stand in Razor Hill", "Horde"), "");
  assert.equal(factionTag("systems/x", "the Horde trainers stand in Razor Hill", ""), "", "an unknown faction tags nothing");
});

test("scopeOf labels a fact by the source its own text names", () => {
  assert.deepEqual(scopeOf("x.y", "layer moves on invite (beta reports)"), ["beta reports"]);
  assert.deepEqual(scopeOf("x.y", "the Oct 29 podcast said it (Wowhead recap)"), ["podcast recap", "guide or fan site"]);
  assert.ok(scopeOf("a.OPEN", "Cross-realm grouping: untested").includes("unsettled"));
  assert.deepEqual(scopeOf("x.y", "60 at launch (Blizzard post)"), []);
  assert.equal(scopeTag("x.y", "60 at launch (Blizzard post)"), "");
  assert.equal(scopeTag("x.y", "datamined from client 70450"), " [scope: datamined]");
});

test("stripVerdictOpener drops a leading Yes or No for a mixed group only", () => {
  assert.equal(stripVerdictOpener("Yes, a group can level together.", { mixed: true }), "A group can level together.");
  assert.equal(stripVerdictOpener("**Yes. Grouping works within one faction.**", { mixed: true }), "**Grouping works within one faction.**");
  assert.equal(stripVerdictOpener("No - the Library lists three.", { mixed: true }), "The Library lists three.");
  assert.equal(stripVerdictOpener("Yes, a group can level together.", { mixed: false }), "Yes, a group can level together.");
  assert.equal(stripVerdictOpener("Yesterday the post went up.", { mixed: true }), "Yesterday the post went up.");
  assert.equal(stripVerdictOpener("Yes.", { mixed: true }), "Yes.");
  assert.equal(stripVerdictOpener("**Yes,** the group can enter.", { mixed: true }), "The group can enter.");
  // a verdict word without punctuation after it is the first word of a sentence, not a verdict
  for (const t of ["No Druid trainer in Durotar; Thunder Bluff has three.", "No one has signed up.", "No more than five players fit.", "Yes and no: it depends on the ruleset.", "No worries, the library has it.", "Nobody tanks there.", "Yes please"]) {
    assert.equal(stripVerdictOpener(t, { mixed: true }), t, t);
  }
  assert.equal(stripVerdictOpener("No: the Library lists three.", { mixed: true }), "The Library lists three.");
});

test("the name check no longer deletes a grounded 'Name in Place' sentence, nor a leading 'Official'", () => {
  const allowed = "paladin: arthur the faithful, katherine the pure and lord grayson shadowbreaker in the cathedral of light; stormwind trainers; blizzard post";
  assert.deepEqual(unknownNames("Lord Grayson Shadowbreaker in Stormwind teaches Paladins.", allowed), []);
  assert.deepEqual(unknownNames("Official Blizzard posts say so.", allowed), []);
  // an invented name is still caught, on either side of the connector
  assert.deepEqual(unknownNames("Lord Mordrek Vane in Stormwind teaches Paladins.", allowed), ["Lord Mordrek Vane"]);
  const out = groundedOrNotPublished("Lord Grayson Shadowbreaker in Stormwind teaches Paladins. Brother Quillon Ashfall in Stormwind teaches too.", allowed);
  assert.match(out.answer, /Grayson/);
  assert.ok(!/Quillon/.test(out.answer));
});

// ---- the production path: buildAnswerInputs + finishAnswerText ----------------------------------------------------------------
const LIB = [
  { id: "systems/trainers", category: "systems", title: "Class trainers", blurb: "Where trainers stand", facts: [
    { key: "trainers.horde", value: "the Horde trainers stand in Razor Hill (Durotar: Hunter, Mage) and in Brill (guide roster, tier 2)" },
    { key: "trainers.druid", value: "no Druid trainer in Durotar; Thunder Bluff has three (guide roster)" },
    { key: "trainers.layers", value: "accepting a group invite can move you to the inviter's layer (beta reports)" },
  ] },
];
function makeEnv(sheets) {
  invalidatePagesCache(); invalidatePersonaCache(); invalidateConfigCache();
  const DB = schemaDb();
  for (const p of LIB) DB.raw.prepare("INSERT INTO lib_pages (id, category, title, blurb, aliases_json, facts_json, updated_at) VALUES (?, ?, ?, ?, '[]', ?, '2026-11-01T00:00:00Z')").run(p.id, p.category, p.title, p.blurb, JSON.stringify(p.facts));
  DB.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES ('party_sheets', ?, 'x')").run(JSON.stringify(sheets));
  return { DB };
}
const ask = (env, question, by = "Red Fox", slug = "red-fox") => buildAnswerInputs(env, { question, by, memberSlug: slug, journey: "curious", share: true });

test("the prompt states the group's make-up from the sheets, never 'Horde group', and carries the grounding rule", async () => {
  const i = await ask(makeEnv([FOX, OWL, ELK]), "where do trainers stand in Durotar for the group");
  assert.match(i.userPrompt, /<<<GROUP_COMPOSITION\nmixed faction; Horde: Blue Owl; Alliance: Red Fox; faction not on file: Green Elk\nGROUP_COMPOSITION>>>/);
  assert.ok(!/Horde group/.test(i.systemPrompt), "the faction of the group is never asserted by the prompt text");
  assert.ok(i.systemPrompt.includes(GROUNDING_RULE));
  assert.equal(i.group.mixed, true);
  assert.match(i.groundingText, /GROUP_COMPOSITION: mixed faction;/);
});

test("a fact for the other faction and a fact with a source scope are tagged in the prompt", async () => {
  const i = await ask(makeEnv([FOX, OWL, ELK]), "where do the Horde trainers stand in Razor Hill and what do beta reports say about group invite layers");
  assert.match(i.userPrompt, /\[systems\/trainers~trainers\.horde\] \(score [\d.]+\) \[Horde fact: not the asker's faction\] \[scope: guide or fan site\]:/);
  assert.match(i.userPrompt, /\[systems\/trainers~trainers\.layers\] \(score [\d.]+\) \[scope: beta reports\]:/);
  const owl = await ask(makeEnv([FOX, OWL, ELK]), "where do the Horde trainers stand in Razor Hill", "Blue Owl", "blue-owl");
  assert.ok(!owl.userPrompt.includes("not the asker's faction"), "a Horde asker is not told a Horde fact is not theirs");
});

test("finishAnswerText: Yes is dropped for a mixed group and kept for a single-faction group", async () => {
  const env = makeEnv([FOX, OWL, ELK]);
  const i = await ask(env, "where do the trainers stand in Razor Hill and Durotar for the group");
  const raw = "Yes, the Horde trainers stand in Razor Hill and Brill.\n\n-# Sources: systems/trainers";
  const out = await finishAnswerText(env, { rawAnswer: raw, isCoach: false, parsedPages: i.parsedPages, by: "Red Fox", askerIsMember: true, persona: i.persona, intentId: "g1", groundingText: i.groundingText, personalised: i.personalised, retrieval: i.retrieval, group: i.group });
  assert.ok(!/^Yes/i.test(out.answer), out.answer);
  assert.match(out.answer, /^The Horde trainers stand in Razor Hill and Brill\./);
  assert.deepEqual(out.cites, ["systems/trainers"]);
  assert.ok(out.answer.length <= 1200);
  assert.ok(!/https?:\/\/[^\s<>)]*(?<!\))\s/.test(out.answer.split("-# Sources")[0]), "no bare address in the body");
  const hordeEnv = makeEnv([OWL, ELK_HORDE]);
  const h = await ask(hordeEnv, "where do the trainers stand in Razor Hill and Durotar", "Blue Owl", "blue-owl");
  const yes = await finishAnswerText(hordeEnv, { rawAnswer: "Yes, the Horde trainers stand in Razor Hill.\n\n-# Sources: systems/trainers", isCoach: false, parsedPages: h.parsedPages, by: "Blue Owl", askerIsMember: true, persona: h.persona, intentId: "g3", groundingText: h.groundingText, personalised: h.personalised, retrieval: h.retrieval, group: h.group });
  assert.match(yes.answer, /^Yes, the Horde trainers/);
});

test("the offline eval path (grounding text only, no group argument) still drops the Yes for a mixed group", async () => {
  const env = makeEnv([FOX, OWL, ELK]);
  const i = await ask(env, "where do the trainers stand in Razor Hill and Durotar for the group");
  const out = await finishAnswerText(env, { rawAnswer: "Yes, the Horde trainers stand in Razor Hill.\n\n-# Sources: systems/trainers", isCoach: false, parsedPages: i.parsedPages, by: "Red Fox", askerIsMember: true, persona: i.persona, intentId: "g4", groundingText: i.groundingText, personalised: i.personalised });
  assert.ok(!/^Yes/.test(out.answer), out.answer);
});

test("the length limit still holds and a long answer ends on a finished sentence with the cut mark", async () => {
  const env = makeEnv([FOX, OWL, ELK]);
  const i = await ask(env, "where do the Horde trainers stand in Razor Hill");
  const body = Array.from({ length: 25 }, (_, n) => `The Horde trainers stand in Razor Hill and Brill, entry ${n}.`).join(" ");
  const out = await finishAnswerText(env, { rawAnswer: `${body}\n\n-# Sources: systems/trainers`, isCoach: false, parsedPages: i.parsedPages, by: "Red Fox", askerIsMember: true, persona: i.persona, intentId: "g5", groundingText: i.groundingText, personalised: false, retrieval: i.retrieval, group: i.group });
  assert.ok(out.answer.length <= 1200, String(out.answer.length));
  const main = out.answer.split("\n\n-#")[0];
  assert.match(main, /\.\s…$|\.$/, main.slice(-40));
});
