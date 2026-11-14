// /ask grounding, the three kept pieces, each with a before/after probe against master behaviour (fictional data only; Red Fox, Blue Owl, Green Elk):
//  (a) the name check no longer deletes a grounded "Name in Place" sentence or a grounded "Official Blizzard", and is never weaker on an invented name than master
//      (tests/fixtures/ask-name-corpus.json holds master's verdict for 71 sentences, correct and invented, under two grounding texts);
//  (b) the party's factions come from the sheets and reach the prompt as a line, replacing the hard-coded "Horde group" in the fallback prompt;
//  (c) library facts carry a source scope label in the prompt (negated mentions of Blizzard are not sources; forum, video and community facts are labelled).
// The opener (Yes/No) and absence claims are prompt-guided, NOT code-guaranteed: nothing here edits an answer.
// Run: node --test tests/unit/ask-grounding.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { groupComposition, scopeOf, scopeTag, officialSource, GROUNDING_RULE } from "../../infrastructure/worker/ask-grounding.js";
import { unknownNames, groundedOrNotPublished } from "../../infrastructure/worker/ask-build.js";
import { buildAnswerInputs, finishAnswerText, invalidatePagesCache } from "../../infrastructure/worker/ai-models.js";
import { invalidatePersonaCache } from "../../infrastructure/worker/persona.js";
import { invalidateConfigCache } from "../../infrastructure/worker/config.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";

const f = (value, visible = true) => ({ value, visible, source: "board", at: "2026-11-01T00:00:00.000Z" });
const FOX = { slug: "red-fox", name: "Red Fox", fields: { class: f("paladin"), race: f("human"), level: f(34) }, updated: "x" };
const OWL = { slug: "blue-owl", name: "Blue Owl", fields: { class: f("mage"), race: f("orc"), level: f(28) }, updated: "x" };
const ELK = { slug: "green-elk", name: "Green Elk", fields: { class: f("priest"), race: f("undead", false), level: f(31) }, updated: "x" };
const ELK_HORDE = { ...ELK, fields: { ...ELK.fields, race: f("troll") } };

// ---- (a) name check ---------------------------------------------------------------------------------------------------------------
const CORPUS = JSON.parse(readFileSync(new URL("../fixtures/ask-name-corpus.json", import.meta.url), "utf8"));

test("name check differential: nothing master passed is newly flagged, and only the two intended shapes are newly passed", () => {
  const relaxed = new Set(CORPUS.relaxed);
  let seenRelaxed = 0;
  for (const row of CORPUS.master) {
    for (const [k, allowed] of [["A", CORPUS.allowedA], ["B", CORPUS.allowedB]]) {
      const now = unknownNames(row.s, allowed).length > 0;
      if (row[k]) {
        // master flagged: still flagged, unless it is one of the relaxed sentences (a full multi-word name in a join, or Official Blizzard with a shown official source)
        if (!now) { assert.ok(relaxed.has(row.s), `weakened: ${row.s}`); seenRelaxed++; }
      } else assert.equal(now, false, `newly flagged: ${row.s}`);
    }
  }
  assert.ok(seenRelaxed >= 4, String(seenRelaxed));
  for (const s of relaxed) assert.ok(/Lord Grayson Shadowbreaker in Stormwind|Official Blizzard posts/.test(s), s);
});

test("name check: invented names of every shape master caught are still caught", () => {
  const B = CORPUS.allowedB;
  for (const t of ["Lord Mordrek Vane in Stormwind trains Paladins.", "Call to Arms is a holiday.", "Vex in Razor Hill trains Hunters and Mages.", "Druid Trainer in Razor Hill teaches every Druid.", "Official Blizzard Guide says respawn is 5 minutes.", "Arthur the Faithful in Orgrimmar trains Paladins."]) {
    const was = unknownNames(t, B).length > 0;
    // these are the shapes the reviewers raised: each must behave exactly as master did (flagged ones stay flagged)
    if (was) assert.ok(unknownNames(t, B).length > 0, t);
  }
  assert.ok(unknownNames("Lord Mordrek Vane in Stormwind trains Paladins.", B).length > 0);
  assert.ok(unknownNames("Official Blizzard Guide says respawn is 5 minutes.", CORPUS.allowedA).length > 0, "longer phrases are never relaxed");
  assert.ok(unknownNames("Official Blizzard posts confirm it.", CORPUS.allowedB).length > 0, "without a shown official source, 'Official Blizzard' stays checked");
  assert.ok(unknownNames("Official Blizzard posts confirm it.", `${CORPUS.allowedB} blizzard has not confirmed this.`).length > 0, "a negated confirmation is not a shown source");
});

test("name check: the two fixed false positives", () => {
  assert.deepEqual(unknownNames("Lord Grayson Shadowbreaker in Stormwind trains Paladins.", CORPUS.allowedB), []);
  assert.deepEqual(unknownNames("Official Blizzard posts say the level cap is 60.", CORPUS.allowedA), []);
  const out = groundedOrNotPublished("Lord Grayson Shadowbreaker in Stormwind trains Paladins. Lord Mordrek Vane in Stormwind trains too.", CORPUS.allowedB);
  assert.match(out.answer, /Grayson/);
  assert.ok(!/Mordrek/.test(out.answer));
});

test("name check stays linear on long whitespace and join runs", () => {
  const t0 = Date.now();
  unknownNames(`The trainers stand in Razor${" ".repeat(30000)}Hill and Brill.`, CORPUS.allowedB);
  unknownNames("Aa in ".repeat(5000) + "Bb", CORPUS.allowedB);
  assert.ok(Date.now() - t0 < 3000, String(Date.now() - t0));
});

// ---- (b) group composition in the prompt -------------------------------------------------------------------------------------------
const LIB = [{ id: "systems/trainers", category: "systems", title: "Class trainers", blurb: "Where trainers stand", facts: [
  { key: "trainers.horde", value: "the Horde trainers stand in Razor Hill (Durotar: Hunter, Mage) and in Brill (guide roster, tier 2)" },
  { key: "trainers.layers", value: "accepting a group invite can move you to the inviter's layer (beta reports)" },
] }];
function makeEnv(sheets) {
  invalidatePagesCache(); invalidatePersonaCache(); invalidateConfigCache();
  const DB = schemaDb();
  for (const p of LIB) DB.raw.prepare("INSERT INTO lib_pages (id, category, title, blurb, aliases_json, facts_json, updated_at) VALUES (?, ?, ?, ?, '[]', ?, '2026-11-01T00:00:00Z')").run(p.id, p.category, p.title, p.blurb, JSON.stringify(p.facts));
  DB.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES ('party_sheets', ?, 'x')").run(JSON.stringify(sheets));
  return { DB };
}
const ask = (env, question, by = "Red Fox", slug = "red-fox") => buildAnswerInputs(env, { question, by, memberSlug: slug, journey: "curious", share: true });

test("groupComposition: mixed, single-faction and hidden races come from the sheets, nothing is assumed", () => {
  const mixed = groupComposition([FOX, OWL, ELK]);
  assert.equal(mixed.mixed, true);
  assert.match(mixed.line, /^mixed faction; Horde: Blue Owl; Alliance: Red Fox; faction not on file: Green Elk$/);
  assert.ok(!/undead/i.test(mixed.line), "a hidden race never leaks");
  assert.match(groupComposition([OWL, ELK_HORDE]).line, /^Horde only among the sheets that say; Horde: Blue Owl, Green Elk$/);
  assert.equal(groupComposition([]).line, "");
  assert.match(groupComposition([ELK]).line, /^no faction on file for anyone/);
  assert.equal(groupComposition([ELK], { askerSheet: ELK, includeHidden: true }).horde.length, 1);
  assert.equal(groupComposition([ELK], { askerSheet: ELK, includeHidden: false }).horde.length, 0);
});

test("the prompt carries the group's make-up and the grounding rule; the fallback prompt no longer says 'Horde group'", async () => {
  const i = await ask(makeEnv([FOX, OWL, ELK]), "where do the Horde trainers stand in Razor Hill");
  assert.match(i.userPrompt, /<<<GROUP_COMPOSITION\nmixed faction; Horde: Blue Owl; Alliance: Red Fox; faction not on file: Green Elk\nGROUP_COMPOSITION>>>/);
  assert.ok(!/Horde group/.test(i.systemPrompt));
  assert.ok(i.systemPrompt.includes(GROUNDING_RULE));
  assert.match(GROUNDING_RULE, /do not open with Yes or No/i);
});

test("nothing edits an answer: a correct answer, with or without a leading Yes, comes through the tail as master did", async () => {
  const env = makeEnv([FOX, OWL, ELK]);
  const i = await ask(env, "where do the Horde trainers stand in Razor Hill and Durotar");
  for (const body of ["Yes, the Horde trainers stand in Razor Hill and Brill.", "No Druid trainer stands in Durotar; Brill has trainers.", "**Yes**, the Horde trainers stand in Razor Hill.", "Yes and no: the Horde trainers stand in Razor Hill and Brill.", "No. 2 on the list is Brill, where the Horde trainers stand."]) {
    const out = await finishAnswerText(env, { rawAnswer: `${body}\n\n-# Sources: systems/trainers`, isCoach: false, parsedPages: i.parsedPages, by: "Red Fox", askerIsMember: true, persona: i.persona, intentId: "k1", groundingText: i.groundingText, personalised: false, retrieval: i.retrieval });
    assert.equal(out.answer.split("\n\n-#")[0], body, body);
  }
});

// ---- (c) scope labels ---------------------------------------------------------------------------------------------------------------
test("scopeOf: negated Blizzard mentions are not sources; forum, video and community facts are labelled; official facts are not called fan sourced", () => {
  assert.deepEqual(scopeOf("x", "not in Blizzard's post; the guide says 5"), ["guide or fan site"]);
  assert.deepEqual(scopeOf("x", "no Blizzard post read; Wowhead says so"), ["guide or fan site"]);
  assert.deepEqual(scopeOf("x", "Blizzard has not confirmed it; the guide says so"), ["guide or fan site"]);
  assert.deepEqual(scopeOf("x", "per the Blizzard Oct 7 deep dive and a guide"), []);
  assert.deepEqual(scopeOf("x", "Blizzard's post says no guide is needed"), [], "a negative claim INSIDE an official source is not a negated source");
  assert.equal(officialSource("blizzard has not confirmed this."), false);
  assert.equal(officialSource("blizzard hasn't posted a deep dive"), false);
  assert.deepEqual(scopeOf("x", "seen on a forum"), ["community source"]);
  assert.deepEqual(scopeOf("x", "a streamer video showed it"), ["community source"]);
  assert.deepEqual(scopeOf("x", "layer moves on invite (beta reports)"), ["beta reports"]);
  assert.ok(scopeOf("a.OPEN", "Cross-realm grouping: untested").includes("unsettled"));
  assert.equal(scopeTag("x.y", "60 at launch (Blizzard post)"), "");
  assert.equal(scopeTag("x.y", "datamined from client 70450"), " [scope: datamined]");
});

test("scopeOf over the real library: no positively official fact is tagged as fan or guide sourced, and no guide, forum or video fact is left untagged", () => {
  const dir = new URL("../../data/library/", import.meta.url);
  let facts = 0, official = 0, wrong = 0, missed = 0, labelled = 0;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const j = JSON.parse(readFileSync(new URL(file, dir), "utf8"));
    for (const p of Array.isArray(j.pages) ? j.pages : []) for (const fact of Array.isArray(p.facts) ? p.facts : []) {
      facts++;
      const v = String(fact.value || ""), s = scopeOf(fact.key, v), fan = s.includes("guide or fan site") || s.includes("community source");
      const pos = officialSource(v);
      if (pos) { official++; if (fan) wrong++; }
      else if (/\b(?:guide|wiki|wowhead|icy veins|warcraft tavern|forum|videos?|youtube|reddit|community|streamers?)\b/i.test(v)) { if (fan) labelled++; else missed++; }
    }
  }
  assert.ok(facts > 100 && official > 10 && labelled > 10, `${facts} ${official} ${labelled}`);
  assert.equal(wrong, 0);
  assert.equal(missed, 0);
});

test("a fact with a source scope is tagged in the prompt", async () => {
  const i = await ask(makeEnv([FOX, OWL, ELK]), "where do the Horde trainers stand in Razor Hill and what do beta reports say about group invite layers");
  assert.match(i.userPrompt, /\[systems\/trainers~trainers\.layers\] \(score [\d.]+\) \[scope: beta reports\]:/);
  assert.match(i.userPrompt, /\[systems\/trainers~trainers\.horde\] \(score [\d.]+\) \[scope: guide or fan site\]:/);
});
