// /ask opener, faction line, build-aware retrieval and sentence-safe cut. Fictional members only. Run: node --test tests/unit/ask-opener.test.mjs
import test from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { buildOpener, factionOf, whoText, hasBuildFact, openerTopic, buildQueryExtra, pickBuildFacts, TOPIC_BANK, BUILD_BANK, isRoleQuestion } from "../../infrastructure/worker/ask-opener.js";
import { formatAnswer } from "../../infrastructure/worker/answer-format.js";
import { ABSTAIN_LINE, NUMBER_UNCONFIRMED_LINE } from "../../infrastructure/worker/self-rag.js";
import { renderAskerBuild } from "../../infrastructure/worker/ask-build.js";
import { buildAnswerInputs, finishAnswerText, invalidatePagesCache } from "../../infrastructure/worker/ai-models.js";
import { invalidatePersonaCache } from "../../infrastructure/worker/persona.js";
import { invalidateConfigCache } from "../../infrastructure/worker/config.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";

const EMOJI = /\p{Extended_Pictographic}/u;
const allLines = [...Object.values(TOPIC_BANK).flat(), ...Object.values(BUILD_BANK).flat()];
const paladin = { class: "paladin", spec: "protection", race: "human", level: "34", professions: [] };

test("every bank line is short, plain and in house voice", () => {
  assert.ok(allLines.length >= 20);
  for (const l of allLines) {
    assert.ok(l.length <= 110, l);
    assert.ok(!EMOJI.test(l), l);
    assert.ok(!/skippy|honestly|\bsteer\b|\bshould\b/i.test(l), l);
    assert.ok(!/santa|bible boi|street rat|bloise|squidward/i.test(l), l);
  }
});

test("the opener is deterministic and keyed by topic", () => {
  const a = buildOpener({ question: "how do raids reset", topPageId: "raids/overview" });
  assert.equal(a, buildOpener({ question: "how do raids reset", topPageId: "raids/overview" }));
  assert.ok(TOPIC_BANK.raids.includes(a));
  assert.ok(TOPIC_BANK.default.includes(buildOpener({ question: "x", topPageId: "ui/anything" })));
  assert.ok(TOPIC_BANK.default.includes(buildOpener({ question: "x" })));
  assert.equal(openerTopic("how many tanks for a raid", "raids/x"), "role");
  const seen = new Set();
  for (let i = 0; i < 40; i++) seen.add(buildOpener({ question: `q${i}`, topPageId: "dungeons/x" }));
  assert.ok(seen.size > 1, "the bank varies across questions");
});

test("with a build the opener names the asker's build, and says so when the library has nothing for it", () => {
  const withFact = buildOpener({ question: "how many tanks for a dungeon", topPageId: "classes/tanking", facts: paladin, shownFacts: "Protection Paladin deep dive" });
  assert.match(withFact, /your protection paladin/i);
  const noFact = buildOpener({ question: "how many tanks for a dungeon", topPageId: "classes/tanking", facts: paladin, shownFacts: "a dungeon is five players" });
  assert.match(noFact, /nothing .*specific to your protection paladin/i);
  const race = buildOpener({ question: "what does my racial do", topPageId: "races/horde-racials", facts: { class: "priest", spec: "holy", race: "undead" }, shownFacts: "priest" });
  assert.match(race, /your undead priest/i);
  assert.ok(BUILD_BANK.withFact.some((l) => l.replace("{Who}", "Your undead priest").replace("{who}", "your undead priest") === race), "the Horde racials page covers an undead");
  const wrongSide = buildOpener({ question: "what does my racial do", topPageId: "races/horde-racials", facts: { class: "mage", spec: "frost", race: "gnome" }, shownFacts: "orc racial" });
  assert.match(wrongSide, /nothing .*specific to your gnome mage/i);
  // a plain lookup (not class, race or role) never names the build
  assert.ok(!/your /i.test(buildOpener({ question: "when is the raid", topPageId: "raids/x", facts: paladin, shownFacts: "paladin" })));
  assert.equal(whoText({ class: "", spec: "x" }, "role"), "");
  assert.equal(whoText({ class: "mage", spec: "none" }, "role"), "your mage");
});

test("faction follows the race and reaches the build line only when the race is on it", () => {
  assert.equal(factionOf("human"), "Alliance");
  assert.equal(factionOf("Night Elf"), "Alliance");
  assert.equal(factionOf("undead"), "Horde");
  assert.equal(factionOf("Forsaken"), "Horde");
  assert.equal(factionOf("skyborne"), "");
  assert.equal(factionOf("night-elf"), "Alliance");
  assert.equal(factionOf("  ORC "), "Horde");
  // whole words only: a longer word that merely contains a race name is not that race
  for (const notRace of ["orcish", "gnomeregan", "trolley", "humanoid", "dwarfish", "undeadly", "blood elf", ""]) assert.equal(factionOf(notRace), "", notRace);
  const f = (value, visible = true) => ({ value, visible, source: "board", at: "x" });
  const sheet = { slug: "red-fox", name: "Red Fox", fields: { class: f("paladin"), race: f("human"), spec_path: f("protection") } };
  assert.match(renderAskerBuild(sheet, {}), /race: human; faction: Alliance; spec_path: protection/);
  const hidden = { slug: "x", name: "X", fields: { class: f("mage"), race: f("gnome", false) } };
  assert.ok(!/faction/.test(renderAskerBuild(hidden, {})), "a hidden race must not leak through the faction");
  assert.match(renderAskerBuild(hidden, {}, { includeHidden: true }), /faction: Alliance/);
});

test("retrieval extras: role questions only, class and spec only, facts must name the class", () => {
  assert.ok(isRoleQuestion("how many tanks for Onyxia"));
  assert.equal(buildQueryExtra("how many tanks for Onyxia", paladin), "paladin protection");
  assert.equal(buildQueryExtra("when is the raid", paladin), "");
  assert.equal(buildQueryExtra("how many tanks", null), "");
  assert.equal(hasBuildFact("a Protection Paladin tank", paladin), true);
  assert.equal(hasBuildFact("a warrior tank", paladin), false);
  // a spec with no letters strips to nothing and must not match any text
  for (const spec of ["---", "???", "  ", "12", "--"]) assert.equal(hasBuildFact("any text at all", { class: "none", spec }), false, spec);
  assert.equal(hasBuildFact("a Protection Paladin tank", { class: "---", spec: "protection" }), true);
  const shown = [{ page: "a/b", key: "k1", value: "x", score: 9 }];
  const more = [{ page: "a/b", key: "k1", value: "paladin", score: 9 }, { page: "classes/tanking", key: "t1", value: "Paladin full tank", score: 5 }, { page: "classes/tanking", key: "t2", value: "warrior only", score: 5 }];
  assert.deepEqual(pickBuildFacts(more, shown, paladin).map((h) => h.key), ["t1"]);
});

test("a cut answer ends on a finished sentence, not mid-clause", () => {
  const body = "First sentence is here and is fairly long on purpose. Second sentence is also long enough to matter here, with more words to add. Third sentence runs on and on without any end in sight until the cap hits it hard";
  const ctx = { pages: [], asker: { name: "x", isMember: false }, boardUrl: "https://leeroy.party", maxChars: 130 };
  const out = formatAnswer(body, ctx);
  assert.ok(out.length <= 130, String(out.length));
  assert.match(out, / …$/, "a cut answer keeps a visible mark even when it ends on a full sentence");
  assert.ok(out.startsWith("First sentence is here and is fairly long on purpose."));
  const noStop = formatAnswer("word ".repeat(60).trim(), { ...ctx, maxChars: 100 });
  assert.match(noStop, /…$/, "no sentence end in range: the word cut stays");
});

// ---- integration through the production builder ----
const f = (value, visible = true) => ({ value, visible, source: "board", at: "2026-11-01T00:00:00.000Z" });
const SHEETS = [{ slug: "red-fox", name: "Red Fox", fields: { class: f("paladin"), race: f("human"), spec_path: f("protection"), level: f(34) }, updated: "x" }];
const LIB = [
  { id: "raids/tank-counts", category: "raids", title: "Raid tanks", blurb: "Raid tank counts", facts: [{ key: "raids.tank_counts", value: "how many tanks a raid needs: Blizzard has published no tank count for any raid", depth: "must", refs: [] }] },
  { id: "classes/tanking", category: "classes", title: "Tanking", blurb: "Tank classes", facts: [{ key: "tanking.full_tanks", value: "Protection Paladin has a full tank kit, a taunt and a shield", depth: "must", refs: [] }] },
];
function makeEnv() {
  invalidatePagesCache(); invalidatePersonaCache(); invalidateConfigCache();
  const DB = schemaDb();
  for (const p of LIB) DB.raw.prepare("INSERT INTO lib_pages (id, category, title, blurb, aliases_json, facts_json, updated_at) VALUES (?, ?, ?, ?, '[]', ?, '2026-11-01T00:00:00Z')").run(p.id, p.category, p.title, p.blurb, JSON.stringify(p.facts));
  DB.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES ('party_sheets', ?, 'x')").run(JSON.stringify(SHEETS));
  return { DB };
}

test("production builder: faction on the build line, a role question pulls the class fact and returns an opener", async () => {
  const r = await buildAnswerInputs(makeEnv(), { question: "how many tanks for a raid", by: "Red Fox", memberSlug: "red-fox", journey: "curious", share: true });
  assert.match(r.userPrompt, /faction: Alliance/);
  assert.match(r.userPrompt, /tanking~tanking\.full_tanks/);
  assert.ok(r.opener && /your protection paladin/i.test(r.opener), r.opener);
  assert.ok(r.rankPasses <= 4);
  const plain = await buildAnswerInputs(makeEnv(), { question: "how many tanks for a raid", by: "Visitor", isMember: false, journey: "curious", share: true });
  assert.ok(!/your /i.test(plain.opener || ""), "a visitor's opener never names a build");
});

const CITED = "Blizzard has published no tank count for any raid. [raids/tank-counts~raids.tank_counts]";
const PAGES = [{ id: "raids/tank-counts", category: "raids", title: "Raid tanks" }];
const OPENER = "Here is what the library holds for your protection paladin.";
const finishEnv = (extra = {}) => ({ DB: makeEnv().DB, BOARD_PUBLIC_URL: "https://leeroy.party", ...extra });
const finishBase = { rawAnswer: CITED, isCoach: false, parsedPages: PAGES, by: "Red Fox", askerIsMember: true, persona: null, intentId: "t", groundingText: "Blizzard has published no tank count for any raid.", personalised: true, trusted: false, question: "q", opener: OPENER };
const gotOpener = (r) => r.answer.includes("your protection paladin");

test("finishAnswerText puts the opener first when ASK_OPENER is on and a valid citation survives", async () => {
  const on = await finishAnswerText(finishEnv({ ASK_OPENER: "on" }), finishBase);
  assert.ok(on.answer.startsWith(OPENER), on.answer);
  assert.deepEqual(on.cites, ["raids/tank-counts"]);
});

test("ASK_OPENER off, unset or any other value adds no opener", async () => {
  for (const v of ["off", "OFF", "", "0", undefined]) {
    const env = finishEnv(v === undefined ? {} : { ASK_OPENER: v });
    assert.ok(!gotOpener(await finishAnswerText(env, finishBase)), String(v));
  }
});

test("the opener needs a valid citation: none cited, or only an unknown page cited, means no opener", async () => {
  const env = finishEnv({ ASK_OPENER: "on" });
  const plain = await finishAnswerText(env, { ...finishBase, rawAnswer: "Blizzard has published no tank count for any raid." });
  assert.deepEqual(plain.cites, []);
  assert.ok(!gotOpener(plain));
  const unknown = await finishAnswerText(env, { ...finishBase, rawAnswer: "Blizzard has published no tank count. [made/up-page~x.y]" });
  assert.deepEqual(unknown.cites, []);
  assert.ok(!gotOpener(unknown));
});

test("an abstaining or figure-unconfirmed answer never gets an opener, even with a citation in it", async () => {
  const env = finishEnv({ ASK_OPENER: "on" });
  const cites = ` [raids/tank-counts~raids.tank_counts]`;
  const declines = [
    ABSTAIN_LINE + cites,
    `**The Library does not cover that yet, so I won't guess.**
What would settle it: an official Blizzard post.${cites}`,
    NUMBER_UNCONFIRMED_LINE + cites,
    `${NUMBER_UNCONFIRMED_LINE}
-# Sources: raids/tank-counts`,
    `Raids reset weekly. ${NUMBER_UNCONFIRMED_LINE}${cites}`,
    `The library does not have that yet.${cites}`,
  ];
  for (const rawAnswer of declines) {
    const r = await finishAnswerText(env, { ...finishBase, rawAnswer, groundingText: "x" });
    assert.ok(!gotOpener(r), rawAnswer);
  }
});

test("no opener on trusted (code-written) or coach answers", async () => {
  const env = finishEnv({ ASK_OPENER: "on" });
  assert.ok(!gotOpener(await finishAnswerText(env, { ...finishBase, trusted: true })), "trusted");
  assert.ok(!gotOpener(await finishAnswerText(env, { ...finishBase, isCoach: true })), "coach");
  assert.ok(!gotOpener(await finishAnswerText(env, { ...finishBase, opener: "" })), "empty opener");
});

test("wrangler.toml ships ASK_OPENER off", () => {
  const toml = readFileSync(new URL("../../infrastructure/wrangler.toml", import.meta.url), "utf8");
  const m = toml.match(/^ASK_OPENER\s*=\s*"([^"]*)"/m);
  assert.ok(m, "ASK_OPENER is declared");
  assert.equal(m[1], "off");
});
