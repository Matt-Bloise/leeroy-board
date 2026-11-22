// THE NORMALISED RESCORER (tools/replay/score-normalised.mjs, tools/replay/rescore.mjs). Fictional names and numbers only; tables, results and truth sets are built in a temp dir at test time.
//   positives    the writing forms the strict scorer misses (thin-space groups, composite durations) and the ones both read (82,800 seconds, 15-second, **Level 18**, **18**, requires level 18)
//   near-misses  a different number, a different unit, a range, an echo of the question, another rank, another entity: all stay wrong
//   mutation     unit conversion accepted and refused, ids exempt only when bracketed, a cited row supports a figure and an uncited or unknown one does not, library facts support only the entity they mention
//   rescore      flips, anomalies, classes, both pass-bar verdicts, the strict scorer untouched
// Run: node --test tests/unit/replay-rescore.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sha256 } from "../../tools/replay/common.mjs";
import { exact_match, unsupported_numbers, scoreTruthItem } from "../../tools/replay/score.mjs";
import { PASS_BAR } from "../../tools/replay/pass-bar.mjs";
import { normalisedExact, unsupportedFigures, scoreNormalised, buildRowIndex, loadLibrary, normaliseText, rowIdsIn } from "../../tools/replay/score-normalised.mjs";
import { rescore, formatReport, loadFactRows } from "../../tools/replay/rescore.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), "rescore-test-"));

const rows = [
  { id: "spelllevels:7001", subject: "Zephyr Lance", claim: "Zephyr Lance (Rank 1) requires level 4.", value: "4", note: "rank=1;class=Fiction Mage" },
  { id: "spelllevels:7002", subject: "Zephyr Lance", claim: "Zephyr Lance (Rank 2) requires level 12.", value: "12", note: "rank=2;class=Fiction Mage" },
  { id: "spelllevels:7003", subject: "Zephyr Lance", claim: "Zephyr Lance (Rank 3) requires level 20.", value: "20", note: "rank=3;class=Fiction Mage" },
  { id: "spelllevels:7004", subject: "Zephyr Lance", claim: "Zephyr Lance (Rank 4) requires level 28.", value: "28", note: "rank=4;class=Fiction Mage" },
  { id: "spelllevels:7200", subject: "Pebblefire", claim: "Pebblefire requires level 18.", value: "18", note: "" },
  { id: "spellpower:6100", subject: "Pebblefire", claim: "Pebblefire costs 120 mana.", value: "120", note: "" },
  { id: "spelllevels:7300", subject: "Quillshard Nova", claim: "Quillshard Nova requires level 33.", value: "33", note: "" },
  { id: "spellcooldowns:9100", subject: "Quillshard Nova", claim: "Quillshard Nova has a cooldown of 82800 seconds.", value: "82800", note: "" },
];
const index = buildRowIndex(rows);
const rec = (kind, entity, question, value, unit, allowed = []) => ({ id: `${kind}-${entity}`, kind, question, expected: { value, unit }, entity_name: entity, allowed_numbers: [value, ...allowed] });
const lvl18 = rec("spell_level", "Pebblefire", "At what level does a player learn Pebblefire?", 18, "level");
const cd82800 = rec("spell_cooldown", "Quillshard Nova", "What is the cooldown of Quillshard Nova?", 82800, "seconds");
const cd14400 = rec("spell_cooldown", "Quillshard Nova", "What is the cooldown of Quillshard Nova?", 14400, "seconds");
const cd15 = rec("spell_cooldown", "Quillshard Nova", "What is the cooldown of Quillshard Nova?", 15, "seconds");
const cd5400 = rec("spell_cooldown", "Quillshard Nova", "What is the cooldown of Quillshard Nova?", 5400, "seconds");
const rank4 = rec("spell_level", "Zephyr Lance", "What level does Zephyr Lance Rank 4 require?", 28, "level");
const ok = { status: "answered", reason: null, model: "claude:fake" };
const ne = (answer, r, ctx = { index }) => normalisedExact(answer, r, ok, ctx);

test("positives: the writing forms of the expected number are accepted", () => {
  const T = (answer, r) => assert.equal(ne(answer, r).exact, true, answer);
  T("Its cooldown is 82,800 seconds.", cd82800);
  T("Its cooldown is 82\u2009800 seconds.", cd82800); // thin-space group: the strict scorer reads two numbers
  T("Its cooldown is 82\u202f800 seconds.", cd82800);
  T("Its cooldown is 82800 seconds, which is 23 hours.", cd82800);
  T("That is 23 hours.", cd82800); // unit-consistent conversion: 23 h = 82800 s
  T("**82,800 seconds** (23 hours) [spellcooldowns:9100]", cd82800);
  T("It has a 15-second cooldown.", cd15);
  T("It has a 15\u2011second cooldown.", cd15);
  T("A 15 sec cooldown.", cd15);
  T("It is on a 240 minute cooldown (4 hours).", cd14400);
  T("About 4 hours.", cd14400);
  T("The cooldown is 1 hour 30 minutes.", cd5400); // composite duration
  T("The cooldown is 1 hour and 30 minutes.", cd5400);
  T("It requires **Level 18**.", lvl18);
  T("**18**", lvl18);
  T("Pebblefire requires level 18 [spelllevels:7200].", lvl18);
  T("Pebblefire is level-18 content.", lvl18);
  T("It is learned at 18th level.", lvl18);
  T("It is learned at level eighteen.", lvl18);
  T("Zephyr Lance (Rank 4) requires level 28 [spelllevels:7004].", rank4);
  T("Rank 3: level 20, Rank 4: level 28.", rank4);
  const m = ne("Its cooldown is 82\u2009800 seconds.", cd82800);
  assert.equal(m.matched.text, "82\u2009800 seconds");
  assert.equal(exact_match("Its cooldown is 82\u2009800 seconds.", cd82800.expected), false, "strict does not read the thin-space group");
});

test("near-misses stay wrong: a different number, a different unit, a range, an echo, another rank, another entity", () => {
  const F = (answer, r, why) => { const x = ne(answer, r); assert.equal(x.exact, false, answer); if (why) assert.equal(x.why, why, answer); return x; };
  F("Its cooldown is 82,800 seconds.", rec("spell_cooldown", "Quillshard Nova", "q", 82000, "seconds"));
  F("Its cooldown is 82 800 seconds.", cd82800); // a plain space is not a thousands separator
  F("Its cooldown is 82.800 seconds.", cd82800); // nor is a dot: that reads 82.8
  F("It is 4 minutes.", cd14400); // 240 s is not 14400 s
  F("Its cooldown is 4 hours.", cd5400);
  F("It costs 18 mana.", lvl18); // right number, wrong unit
  F("It is learned at level 18-20.", lvl18, "range");
  F("It is learned at level 18 to 20.", lvl18, "range");
  F("It is learned between level 18 and 20.", lvl18, "range");
  F("It is learned at level 18 or 20.", lvl18, "range");
  F("It is not level 18.", lvl18);
  F("Level 99 for sure.", lvl18);
  // the level of rank 3 for a rank-4 question: a different number, and the same number with the wrong rank
  F("Zephyr Lance Rank 3 requires level 20.", rank4);
  assert.equal(ne("Zephyr Lance Rank 3 requires level 20.", rank4).class, "wrong-number");
  const hypo = rec("spell_level", "Zephyr Lance", "What level does Zephyr Lance Rank 4 require?", 20, "level");
  assert.equal(exact_match("Zephyr Lance Rank 3 requires level 20.", hypo.expected, hypo.entity_name), true, "strict accepts the wrong rank");
  const wr = F("Zephyr Lance Rank 3 requires level 20.", hypo, "rank");
  assert.equal(wr.class, "right-number-wrong-entity-or-rank");
  assert.equal(F("It requires level 20 [spelllevels:7003].", hypo, "rank").class, "right-number-wrong-entity-or-rank"); // by the cited row's rank
  // an echo of the question: the number is the asked rank, not an answer
  const echo = rec("spell_level", "Zephyr Lance", "What level does Zephyr Lance Rank 4 require?", 4, "level");
  assert.equal(exact_match("Zephyr Lance Rank 4 is a spell.", echo.expected, echo.entity_name), true, "strict reads the echoed rank as the level");
  assert.equal(ne("Zephyr Lance Rank 4 is a spell.", echo).exact, false);
  // a figure for another entity: by the cited row, by a known name
  assert.equal(exact_match("Quillshard Nova requires level 18.", lvl18.expected, lvl18.entity_name), true);
  assert.equal(F("It requires level 18 [spelllevels:7300].", lvl18, "entity").class, "right-number-wrong-entity-or-rank");
  F("Quillshard Nova requires level 18.", lvl18, "entity");
  // contradiction rule is the strict one
  F("It is level 18, then level 30.", lvl18, "contradiction");
  // a degraded response is never exact
  assert.equal(normalisedExact("Level 18.", lvl18, { status: "degraded", reason: "x", model: "m" }, { index }).exact, false);
  // no answer
  assert.equal(normalisedExact(null, lvl18, ok, { index }).class, "no-figure");
});

test("classes: abstained, wrong-number, no-figure", () => {
  assert.equal(ne("Pebblefire's level is not in the client table or the library yet; it will be known once the client table load covers it.", lvl18).class, "abstained");
  assert.equal(ne("It is a nice spell.", lvl18).class, "no-figure");
  assert.equal(ne("It costs 18 mana.", lvl18).class, "no-figure"); // states no level at all
  assert.equal(ne("It is level 25.", lvl18).class, "wrong-number");
  assert.equal(ne("It is level 18-20.", lvl18).class, "wrong-number");
});

test("mutation: unit conversion is accepted only when the quantity is the same", () => {
  assert.equal(ne("4 hours", cd14400).exact, true);
  assert.equal(ne("4 minutes", cd14400).exact, false);
  assert.equal(ne("240 minutes", cd14400).exact, true);
  assert.equal(ne("14400 seconds or 4 hours", cd14400).exact, true);
  assert.equal(ne("14400 seconds or 4 minutes", cd14400).exact, false); // an inconsistent second figure is a contradiction
  assert.equal(ne("1 minute 30 seconds", rec("spell_cooldown", "Quillshard Nova", "q", 90, "seconds")).exact, true);
  assert.equal(ne("1 minute 30 seconds", rec("spell_cooldown", "Quillshard Nova", "q", 60, "seconds")).exact, false);
  assert.equal(ne("2 hours", lvl18).exact, false); // a level question never takes a duration
});

test("mutation: row ids are exempt only when bracketed; the strict scorer counts them", () => {
  const r = rec("spell_level", "Pebblefire", "At what level does a player learn Pebblefire?", 18, "level");
  const a = "Pebblefire requires level 18 [spelllevels:98572].";
  assert.ok(unsupported_numbers(a, { question: r.question, expected: r.expected, allowed_numbers: r.allowed_numbers }).includes(98572), "strict counts the id");
  assert.deepEqual(unsupportedFigures(a, r, {}), []);
  assert.equal(unsupportedFigures("Pebblefire requires level 18 (spelllevels:98572).", r, {}).length, 1);
  assert.equal(unsupportedFigures("Pebblefire requires level 18 spelllevels:98572.", r, {}).length, 1);
  assert.deepEqual(rowIdsIn("x [spelllevels:12] y [a_b:3.4] [not an id] [spelllevels:12]"), ["spelllevels:12", "a_b:3.4"]);
  assert.equal(normaliseText("a [spelllevels:98572] b").text.length, "a [spelllevels:98572] b".length, "cleaning keeps every index");
});

test("mutation: a cited row supports its figures; an uncited, unknown or empty-index row does not", () => {
  const a = "Pebblefire requires level 18 [spelllevels:7200] and costs 120 mana [spellpower:6100].";
  assert.deepEqual(unsupportedFigures(a, lvl18, { index }), []); // 120 is held by the cited row
  const noRows = unsupportedFigures(a, lvl18, {});
  assert.deepEqual(noRows.map((u) => u.value), [120]); // no tables: only ids are exempt
  assert.deepEqual(unsupportedFigures("Pebblefire requires level 18 and costs 120 mana.", lvl18, { index }).map((u) => u.value), [120]); // not cited
  assert.deepEqual(unsupportedFigures("It costs 120 mana [spellpower:9999].", lvl18, { index }).map((u) => u.value), [120]); // unknown id
  assert.deepEqual(unsupportedFigures("It costs 77 mana [spellpower:6100].", lvl18, { index }).map((u) => u.value), [77]); // a figure the row does not hold
  assert.deepEqual(unsupportedFigures("Pebblefire requires level 18.", lvl18, { index }), []); // the expected value
  const sc = scoreNormalised(lvl18, ok, a, { index });
  assert.equal(sc.exact, true);
  assert.equal(sc.unsupported_count, 0);
});

test("unsupported: ranks, versions, build tokens, years, list markers, the question's numbers, conversions", () => {
  const r = rec("spell_level", "Zephyr Lance", "What level does Zephyr Lance Rank 4 require?", 28, "level");
  const U = (a, c = { index }) => unsupportedFigures(a, r, c).map((u) => u.value);
  assert.deepEqual(U("Zephyr Lance (Rank 4) needs level 28 [spelllevels:7004]."), []);
  assert.deepEqual(U("Rank 3 needs level 20 [spelllevels:7003] and rank 2 needs level 12 [spelllevels:7002]."), []);
  assert.deepEqual(U("Rank 2 is out there."), []); // a rank the entity's rows carry
  assert.deepEqual(U("Rank 9 is out there."), [9]); // not one of its ranks
  assert.deepEqual(U("Client build 1.60.1.70959 (build 70450) in 2026: level 28."), []);
  assert.deepEqual(U("1. Level 28\n2. Done"), []);
  assert.deepEqual(U("Level 28 and 37 yards."), [37]);
  const cd = rec("spell_cooldown", "Quillshard Nova", "q", 82800, "seconds", [82800, 82800000]);
  assert.deepEqual(unsupportedFigures("It is 23 hours, 82,800 seconds.", cd, {}), []);
  assert.deepEqual(unsupportedFigures("It is 24 hours.", cd, {}).map((u) => u.value), [24]);
  // the small-counter exemption of the strict scorer is not used here
  assert.equal(unsupported_numbers("Level 28 and 3 tips.", { question: r.question, expected: r.expected }).length, 0);
  assert.deepEqual(U("Level 28 and 3 tips."), [3]);
});

test("mutation: library facts support only figures of pages that mention the entity", () => {
  const dir = tmp();
  writeFileSync(join(dir, "pages.json"), JSON.stringify({ generated: "x", pages: [
    { id: "p/a", title: "Pebblefire guide", facts: [{ key: "k1", value: "Learned at level 18, 9 second recharge", depth: "must" }, { key: "k2", value: "Costs 150 mana" }] },
    { id: "p/b", title: "Other page", facts: [{ key: "k3", value: "Quillshard Nova has a 60 second timer" }, { key: "k4", value: "Unrelated 777" }] },
    { id: "p/c", title: "No facts", facts: 5 },
  ] }));
  writeFileSync(join(dir, "index.json"), JSON.stringify({ pages: [{ id: "x", title: "Pebblefire", facts: 3 }] }));
  writeFileSync(join(dir, "broken.json"), "{ not json");
  const lib = loadLibrary(dir);
  assert.deepEqual(lib.numbersFor("Pebblefire").sort((a, b) => a - b), [9, 18, 150]);
  assert.deepEqual(lib.numbersFor("Quillshard Nova"), [60]);
  assert.deepEqual(lib.numbersFor("Nobody Here"), []);
  assert.deepEqual(unsupportedFigures("Level 18 with a 9 second recharge and 60 seconds.", lvl18, { library: lib }).map((u) => u.value), [60]);
  assert.deepEqual(unsupportedFigures("Level 18 with a 9 second recharge.", lvl18, {}).map((u) => u.value), [9]);
});

// ---- the report ----
const rrow = (id, kind, answer, over = {}) => ({ id, kind, question_sha256: "x", fictional: true, ok: true, status: "answered", model: "claude:fake", latency_ms: 1000, reason: null, within_budget: true, degraded: false, answer_length: (answer || "").length, answer_sha256: null, http_status: 200, scored: true, sent_at: 1, scores: { exact: false, unsupported_count: 0 }, answer, ...over });
const trec = (id, kind, entity, question, value, unit, allowed) => ({ id, kind, question, expected: { value, unit }, rows: [], entity_name: entity, allowed_numbers: allowed || [value] });

test("rescore: flips carry the matched text, anomalies are listed, classes and both verdicts print; strict is the unchanged scorer", () => {
  const truth = [
    trec("t1", "spell_cooldown", "Quillshard Nova", "What is the cooldown of Quillshard Nova?", 82800, "seconds"),
    trec("t2", "spell_level", "Pebblefire", "At what level does a player learn Pebblefire?", 18, "level"),
    trec("t3", "spell_level", "Pebblefire", "At what level does a player learn Pebblefire?", 18, "level"),
    trec("t4", "spell_level", "Pebblefire", "At what level does a player learn Pebblefire?", 18, "level"),
    trec("t5", "spell_cooldown", "Quillshard Nova", "What is the cooldown of Quillshard Nova?", 15, "seconds"),
  ];
  const results = [
    rrow("t1", "spell_cooldown", "Its cooldown is 82\u2009800 seconds, long indeed [spellcooldowns:9100]."), // flip: thin-space group
    rrow("t2", "spell_level", "Pebblefire is learned at level 18 [spelllevels:98572]."), // strict exact, strict unsupported (the id); normalised exact and supported
    rrow("t3", "spell_level", "Pebblefire is learned at level 18-20."), // anomaly: strict exact, normalised not (a range)
    rrow("t4", "spell_level", "Pebblefire's level is not in the client table or the library yet; it will be known once the client table load covers it."),
    rrow("t5", "spell_cooldown", "A 15-second cooldown.", { scored: false }), // unscored: excluded
    rrow("zz", "spell_level", "Level 5.", {}), // no truth record
  ];
  const rep = rescore(results, truth, { index });
  assert.equal(rep.notes.no_truth_record, 1);
  assert.equal(rep.notes.scored_rows, 5);
  assert.deepEqual(rep.flips.map((d) => d.id), ["t1"]);
  assert.deepEqual(rep.anomalies.map((d) => d.id), ["t3"]);
  assert.equal(rep.per_kind.spell_level.strict_exact, 2);
  assert.equal(rep.per_kind.spell_level.norm_exact, 1);
  assert.equal(rep.per_kind.spell_level.strict_unsup_answers, 2); // the id of t2 and the 20 of t3
  assert.equal(rep.per_kind.spell_level.norm_unsup_answers, 1); // only the 20 of t3
  assert.deepEqual(rep.per_kind.spell_level.classes, { abstained: 1, "wrong-number": 1 });
  const text = formatReport(rep);
  assert.match(text, /FLIPS not exact \(strict\) -> exact \(normalised\): 1/);
  assert.match(text, /t1 \| spell_cooldown \| expected 82800 seconds \| .*\[\[82\s800 seconds\]\]/);
  assert.match(text, /ANOMALIES exact \(strict\) -> not exact \(normalised\): 1\n  t3 \| spell_level \| expected 18 level \| why range/);
  assert.match(text, /pass bar STRICT .*: FAIL/);
  assert.match(text, /pass bar NORMALISED .*: FAIL/);
  assert.match(text, /abstained/);
  assert.ok(!/\bPASS\b/.test(text));
  // the strict side is score.mjs exactly
  const strict = scoreTruthItem(truth[1], ok, results[1].answer);
  assert.equal(strict.exact, true);
  assert.ok(strict.unsupported_count > 0);
});

test("rescore: the normalised bar can pass where the strict one fails (row ids counted as numbers); PASS_BAR numbers are not touched", () => {
  const truth = [], results = [];
  for (const kind of ["spell_level", "item_level_req"]) for (let i = 0; i < 30; i++) {
    const id = `${kind}-${i}`;
    truth.push(trec(id, kind, "Pebblefire", "At what level does a player learn Pebblefire?", 18, "level"));
    results.push(rrow(id, kind, `Pebblefire is learned at level 18 [spelllevels:${98000 + i}].`));
  }
  const rep = rescore(results, truth, { index });
  assert.equal(rep.strict.bar.pass, false);
  assert.ok(rep.strict.bar.failures.some((f) => /unsupported_rate/.test(f)));
  assert.equal(rep.normalised.bar.pass, true, rep.normalised.bar.failures.join("; "));
  assert.equal(rep.flips.length, 0);
  assert.equal(PASS_BAR.exact_rate_min, 0.9);
  assert.equal(PASS_BAR.unsupported_rate_max, 0.02);
});

// ---- tables and the CLI ----
function writeTables(dir) {
  const csv = (header, rs) => [header.join(","), ...rs.map((r) => r.join(","))].join("\n") + "\n";
  const spellname = [], spelllevels = [], spell = [], sco = [], cds = [], misc = [], power = [];
  [[3001, 4], [3002, 12], [3003, 20], [3004, 28]].forEach(([id, lv], k) => {
    spellname.push([id, "Zephyr Lance"]); spell.push([id, `Rank ${k + 1}`, "", ""]); spelllevels.push([7000 + id, 0, 0, 0, lv, 0, id]);
    cds.push([9000 + id, 0, 0, 8000, 0, 0, id]); misc.push([8000 + id, 0, 2, id]); power.push([6000 + id, 0, 10 * (k + 1), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, id]); sco.push([id, id, 8]);
  });
  spellname.push([1001, "Pebblefire"]); spelllevels.push([1001, 0, 0, 0, 18, 0, 1001]); spell.push([1001, "", "", ""]);
  const tables = {
    "spellname.csv": csv(["ID", "Name_lang"], spellname),
    "spelllevels.csv": csv(["ID", "DifficultyID", "MaxLevel", "MaxPassiveAuraLevel", "BaseLevel", "SpellLevel", "SpellID"], spelllevels),
    "itemsparse.csv": csv(["ID", "Description_lang", "Display_lang", "ItemLevel", "RequiredLevel", "OverallQualityID"], [[5001, "", "Fakeblade of A", 11, 2, 1]]),
    "spellcooldowns.csv": csv(["ID", "DifficultyID", "CategoryRecoveryTime", "RecoveryTime", "StartRecoveryTime", "AuraSpellID", "SpellID"], cds),
    "spellmisc.csv": csv(["ID", "DifficultyID", "CastingTimeIndex", "SpellID"], misc),
    "spellcasttimes.csv": csv(["ID", "Base", "Minimum"], [[1, 0, 0], [2, 1500, 0]]),
    "spell.csv": csv(["ID", "NameSubtext_lang", "Description_lang", "AuraDescription_lang"], spell),
    "spellclassoptions.csv": csv(["ID", "SpellID", "SpellClassSet"], sco),
    "chrclasses.csv": csv(["Name_lang", "ID", "SpellClassSet"], [["Fiction Mage", 8, 8]]),
    "spellpower.csv": csv(["ID", "OrderIndex", "ManaCost", "ManaCostPerLevel", "ManaPerSecond", "PowerDisplayID", "AltPowerBarID", "PowerCostPct", "PowerCostMaxPct", "OptionalCostPct", "PowerPctPerSecond", "PowerType", "RequiredAuraSpellID", "OptionalCost", "SpellID"], power),
  };
  const files = {};
  for (const [name, text] of Object.entries(tables)) { writeFileSync(join(dir, name), text); files[name] = { sha256: sha256(Buffer.from(text)), bytes: Buffer.byteLength(text), rows: text.trim().split("\n").length - 1 }; }
  writeFileSync(join(dir, "MANIFEST.json"), JSON.stringify({ build: "0.0.0.FAKE", files }, null, 1));
}

test("rescore: the facts rows are rebuilt from the tables with the loader's derivation; a cited id maps to its claim", async () => {
  const dir = tmp();
  writeTables(dir);
  const fr = await loadFactRows(dir);
  const idx = buildRowIndex(fr);
  assert.ok(idx.byId.has("spelllevels:1001"), "the unique-name spell row id is spelllevels:<row id>");
  assert.equal(idx.byId.get("spelllevels:1001").claim, "Pebblefire requires level 18.");
  assert.equal(idx.byId.get("spelllevels:10004").rank, 4);
  assert.equal(idx.byId.get("spelllevels:10004").claim, "Zephyr Lance (Rank 4) requires level 28.");
  const r = rec("spell_level", "Zephyr Lance", "What level does Zephyr Lance Rank 4 require?", 28, "level");
  assert.equal(normalisedExact("Rank 4 needs level 28 [spelllevels:10004].", r, ok, { index: idx }).exact, true);
  assert.equal(normalisedExact("It needs level 28 [spelllevels:10003].", r, ok, { index: idx }).why, "rank");
  assert.deepEqual(unsupportedFigures("Rank 4 needs level 28 [spelllevels:10004]; rank 3 needs level 20 [spelllevels:10003].", r, { index: idx }), []);
});

test("rescore CLI: reads results, truth, tables and the library; prints both reports; writes nothing", () => {
  const dir = tmp();
  const tables = join(dir, "tables");
  mkdirSync(tables);
  writeTables(tables);
  const truth = [
    { type: "header", build: "0.0.0.FAKE" },
    trec("a1", "spell_level", "Zephyr Lance", "What level does Zephyr Lance Rank 4 require?", 28, "level"),
    trec("a2", "spell_level", "Pebblefire", "At what level does a player learn Pebblefire?", 18, "level"),
  ];
  const results = [
    { type: "header", input_sha256: "x" },
    rrow("a1", "spell_level", "Zephyr Lance (Rank 4) requires **level 28** [spelllevels:10004]."),
    rrow("a2", "spell_level", "It is level 18-20."),
  ];
  const w = (n, ls) => { const p = join(dir, n); writeFileSync(p, ls.map((l) => JSON.stringify(l)).join("\n") + "\n"); return p; };
  const run = spawnSync(process.execPath, [join(ROOT, "tools", "replay", "rescore.mjs"), w("results.jsonl", results), "--truth", w("truth.jsonl", truth), "--tables", tables, "--library", join(ROOT, "data", "library")], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /facts rows: \d+; library pages: \d+/);
  assert.match(run.stdout, /pass bar STRICT/);
  assert.match(run.stdout, /pass bar NORMALISED/);
  assert.match(run.stdout, /ANOMALIES exact \(strict\) -> not exact \(normalised\): 1/);
  assert.match(run.stdout, /a2 \| spell_level \| Pebblefire \| expected 18 level \| cited - \| wrong-number \(range\)/);
  const noAnswers = spawnSync(process.execPath, [join(ROOT, "tools", "replay", "rescore.mjs"), w("r2.jsonl", [{ type: "header", input_sha256: "x" }, rrow("a1", "spell_level", undefined)]), "--truth", join(dir, "truth.jsonl")], { encoding: "utf8" });
  assert.notEqual(noAnswers.status, 0);
  assert.match(noAnswers.stderr, /--keep-answers/);
});
