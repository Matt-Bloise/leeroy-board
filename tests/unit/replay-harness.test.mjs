// THE REPLAY HARNESS (tools/replay/). Synthetic, fictional CSV fixtures built in a temp dir at test time; a local stub plays the shadow route; nothing touches the network or the real tables.
//   manifest   hash, byte and row mismatches refuse; a good manifest loads
//   write      no writer here may write inside the repo checkout (truth-gen, run, grade-pack)
//   truth-gen  uniqueness filters, deterministic seed, header carries build and hashes, no talent questions, allowed_numbers
//   traits     trait kinds from a fictional traits.json: uniqueness, prerequisite edge, ambiguity skips, hash in the header, rank/points/name scoring
//   score      exact_match, unsupported_numbers, contradiction, degraded: word/number forms, invented numbers, the question's own numbers
//   run        signing and the https/redirect/token rules against a stub, resume without repeats, max-items, rate windows, answers only with --keep-answers
//   grade      blinding, the private-corpus refusal, external only for fictional, merge unblinds
//   bar        the pass numbers are pinned
// Run: node --test tests/unit/replay-harness.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { sha256, loadVerifiedTable, assertOutsideRepo, REPO_ROOT, parseCsv } from "../../tools/replay/common.mjs";
import { generate, KINDS, TRAIT_KINDS, buildTraitCandidates } from "../../tools/replay/truth-gen.mjs";
import { exact_match, unsupported_numbers, contradiction, degraded, summarize, extractNumbers } from "../../tools/replay/score.mjs";
import { PASS_BAR, WITHIN_BUDGET_MS, PAIR_RULE, evaluateBar, evaluatePairRule } from "../../tools/replay/pass-bar.mjs";
import { runReplay, waitMs, checkBase, buildBody, KNOWN_KINDS } from "../../tools/replay/run.mjs";
import { buildPackets, mergeGrades } from "../../tools/replay/grade-pack.mjs";
import { verifyListen, shadowKey } from "../../infrastructure/worker/listener-config.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TOOLS = (n) => join(ROOT, "tools", "replay", n);
const TOKEN = "FAKE-TEST-TOKEN-" + "x".repeat(40);
const letters = (i) => { let s = ""; while (i > 0) { s = String.fromCharCode(97 + ((i - 1) % 26)) + s; i = Math.floor((i - 1) / 26); } return s; };
const tmp = () => mkdtempSync(join(tmpdir(), "replay-test-"));

// ---- fixtures: same columns as the real tables, fictional names and numbers ----
function writeTables(dir, mutate = {}) {
  const csv = (header, rows) => [header.join(","), ...rows.map((r) => r.join(","))].join("\n") + "\n";
  const N = 45;
  const spellname = [], spelllevels = [], cds = [], misc = [], power = [];
  for (let i = 1; i <= N; i++) {
    const id = 1000 + i;
    spellname.push([id, `Zorbo ${letters(i)} Bolt`]);
    spelllevels.push([id, 0, 0, 0, i + 4, 0, id]); // ID,DifficultyID,MaxLevel,MaxPassiveAuraLevel,BaseLevel,SpellLevel,SpellID
    cds.push([id, 0, 0, (i + 1) * 1000, 0, 0, id]); // ID,DifficultyID,CategoryRecoveryTime,RecoveryTime,StartRecoveryTime,AuraSpellID,SpellID
    misc.push([id, 0, 1 + (i % 3), id]); // ID,DifficultyID,CastingTimeIndex,SpellID
    power.push([id, 0, 10 * i, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, id]); // ID,OrderIndex,ManaCost,ManaCostPerLevel,ManaPerSecond,PowerDisplayID,AltPowerBarID,PowerCostPct,PowerCostMaxPct,OptionalCostPct,PowerPctPerSecond,PowerType,RequiredAuraSpellID,OptionalCost,SpellID
  }
  // traps
  spellname.push([2001, "Twinname Strike"], [2002, "Twinname Strike"]); spelllevels.push([2001, 0, 0, 0, 9, 0, 2001], [2002, 0, 0, 0, 9, 0, 2002]); // duplicate name
  spellname.push([2003, "Tworow Blast"]); spelllevels.push([2003, 0, 0, 0, 11, 0, 2003], [2004, 1, 0, 0, 12, 0, 2003]); // two spelllevels rows
  spellname.push([2005, "Zerolevel Nova"]); spelllevels.push([2005, 0, 0, 0, 0, 0, 2005]); // BaseLevel 0
  spellname.push([2006, "Sharedcd Pulse"]); cds.push([2006, 0, 5000, 8000, 0, 0, 2006]); // category cooldown: excluded
  const items = [];
  const ih = ["ID", "Description_lang", "Display_lang", "ItemLevel", "RequiredLevel", "OverallQualityID"];
  for (let i = 1; i <= N; i++) items.push([5000 + i, "", `Fakeblade of ${letters(i)}`, 10 + i, 2 * i, 1]);
  items.push([6001, "", "Dupe Helm", 5, 7, 1], [6002, "", "Dupe Helm", 5, 8, 1], [6003, "", "Nolevel Cloak", 5, 0, 1]);
  const casts = [[1, 0, 0], [2, 1500, 0], [3, 2500, 0]];
  const tables = {
    "spellname.csv": csv(["ID", "Name_lang"], spellname),
    "spelllevels.csv": csv(["ID", "DifficultyID", "MaxLevel", "MaxPassiveAuraLevel", "BaseLevel", "SpellLevel", "SpellID"], spelllevels),
    "itemsparse.csv": csv(ih, items),
    "spellcooldowns.csv": csv(["ID", "DifficultyID", "CategoryRecoveryTime", "RecoveryTime", "StartRecoveryTime", "AuraSpellID", "SpellID"], cds),
    "spellmisc.csv": csv(["ID", "DifficultyID", "CastingTimeIndex", "SpellID"], misc),
    "spellcasttimes.csv": csv(["ID", "Base", "Minimum"], casts),
    "spellpower.csv": csv(["ID", "OrderIndex", "ManaCost", "ManaCostPerLevel", "ManaPerSecond", "PowerDisplayID", "AltPowerBarID", "PowerCostPct", "PowerCostMaxPct", "OptionalCostPct", "PowerPctPerSecond", "PowerType", "RequiredAuraSpellID", "OptionalCost", "SpellID"], power),
  };
  const files = {};
  for (const [name, text] of Object.entries(tables)) {
    writeFileSync(join(dir, name), text);
    files[name] = { sha256: sha256(Buffer.from(text)), bytes: Buffer.byteLength(text), rows: text.trim().split("\n").length - 1 };
  }
  writeFileSync(join(dir, "MANIFEST.json"), JSON.stringify({ build: "0.0.0.FAKE", files: { ...files, ...mutate } }, null, 1));
  return files;
}
function fixtureDir() { const d = tmp(); writeTables(d); return d; }
const records = (text) => text.trim().split("\n").map((l) => JSON.parse(l));
const resultRows = (p) => records(readFileSync(p, "utf8")).filter((x) => !x.type);

// ---- manifest ----
test("manifest: a matching table loads; a changed hash, byte count or row count refuses", () => {
  const d = tmp();
  const files = writeTables(d);
  const man = JSON.parse(readFileSync(join(d, "MANIFEST.json"), "utf8"));
  const t = loadVerifiedTable(d, man, "spellname.csv");
  assert.equal(t.rows.length, files["spellname.csv"].rows);
  for (const [field, bad] of [["sha256", "0".repeat(64)], ["bytes", files["spellname.csv"].bytes + 1], ["rows", files["spellname.csv"].rows + 5]]) {
    const m2 = JSON.parse(JSON.stringify(man)); m2.files["spellname.csv"][field] = bad;
    assert.throws(() => loadVerifiedTable(d, m2, "spellname.csv"), /MANIFEST/, field);
  }
  assert.throws(() => loadVerifiedTable(d, { files: {} }, "spellname.csv"), /not listed/);
  rmSync(d, { recursive: true, force: true });
});
test("manifest: tampering with a table after the manifest was made refuses the whole generation", () => {
  const d = fixtureDir();
  writeFileSync(join(d, "spelllevels.csv"), readFileSync(join(d, "spelllevels.csv"), "utf8").replace("1001,0,0,0,5,0,1001", "1001,0,0,0,50,0,1001"));
  assert.throws(() => generate({ dir: d }), /spelllevels\.csv: (sha256|byte)/);
  rmSync(d, { recursive: true, force: true });
});
test("csv parser: quotes, escaped quotes, embedded newline, CRLF, BOM", () => {
  const r = parseCsv('\ufeffa,b\r\n"x,y","he said ""hi"""\r\n"two\nlines",z\r\n');
  assert.deepEqual(r, [["a", "b"], ["x,y", 'he said "hi"'], ["two\nlines", "z"]]);
});

// ---- write refusal ----
test("repo-write refusal: any path inside the checkout is refused, outside is accepted", () => {
  assert.throws(() => assertOutsideRepo(join(REPO_ROOT, "x.jsonl")), /inside the repo/);
  assert.throws(() => assertOutsideRepo(join(REPO_ROOT, "tools", "replay", "new", "deep", "x.jsonl")), /inside the repo/);
  assert.throws(() => assertOutsideRepo(REPO_ROOT), /inside the repo/);
  assert.doesNotThrow(() => assertOutsideRepo(join(tmpdir(), "outside-x.jsonl")));
  const fake = tmp(); mkdirSync(join(fake, "inner"));
  assert.throws(() => assertOutsideRepo(join(fake, "inner", "a.jsonl"), fake), /inside the repo/);
  rmSync(fake, { recursive: true, force: true });
});
function runCli(script, args, { env } = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [TOOLS(script), ...args], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (b) => (out += b)); p.stderr.on("data", (b) => (err += b));
    p.on("close", (code) => resolve({ code, out, err }));
  });
}
test("repo-write refusal: truth-gen, run and grade-pack CLIs refuse a path in the repo and write nothing", async () => {
  const d = fixtureDir();
  const bad = join(REPO_ROOT, "tools", "replay", "must-not-exist.jsonl");
  let r = await runCli("truth-gen.mjs", ["--tables", d, "--out", bad]);
  assert.notEqual(r.code, 0); assert.match(r.err, /inside the repo/); assert.equal(existsSync(bad), false);
  const tf = join(d, "token"); writeFileSync(tf, TOKEN);
  writeFileSync(join(d, "in.jsonl"), JSON.stringify({ id: "a", question: "q" }) + "\n");
  r = await runCli("run.mjs", [tf, "--in", join(d, "in.jsonl"), "--max-items", "1", "--out", bad, "--base", "http://127.0.0.1:1"]);
  assert.notEqual(r.code, 0); assert.match(r.err, /inside the repo/); assert.equal(existsSync(bad), false);
  writeFileSync(join(d, "c.jsonl"), JSON.stringify({ id: "a", question: "q", local_answer: "l", fictional: true }) + "\n");
  writeFileSync(join(d, "r.jsonl"), JSON.stringify({ id: "a", answer: "w", model: "claude:x" }) + "\n");
  r = await runCli("grade-pack.mjs", ["build", "--corpus", join(d, "c.jsonl"), "--results", join(d, "r.jsonl"), "--grader", "claude", "--out", bad]);
  assert.notEqual(r.code, 0); assert.match(r.err, /inside the repo/); assert.equal(existsSync(bad), false);
  assert.equal(existsSync(bad + ".key.jsonl"), false);
  rmSync(d, { recursive: true, force: true });
});

// ---- truth-gen ----
test("truth-gen: only unique names, one row, positive values; traps are excluded; no talent kind", () => {
  const d = fixtureDir();
  const { header, text } = generate({ dir: d, seed: 3, perKind: 1000 });
  const recs = records(text).slice(1);
  const names = recs.map((r) => r.entity_name);
  assert.ok(!names.some((n) => /Twinname|Tworow|Zerolevel|Sharedcd|Dupe Helm|Nolevel/.test(n)), "trap entities leaked");
  assert.deepEqual(KINDS, ["spell_level", "item_level_req", "spell_cooldown", "spell_cast_time", "spell_mana_cost"]);
  assert.ok(!recs.some((r) => /talent/i.test(r.kind + r.question)));
  assert.equal(header.selected.spell_level, 45); assert.equal(header.selected.item_level_req, 45);
  assert.equal(header.selected.spell_cooldown, 45); assert.equal(header.selected.spell_mana_cost, 45);
  const lvl = recs.find((r) => r.kind === "spell_level" && r.entity_name === "Zorbo a Bolt");
  assert.deepEqual(lvl.expected, { value: 5, unit: "level" }); // BaseLevel, not SpellLevel (0)
  assert.ok(lvl.question.includes("Zorbo a Bolt"));
  assert.deepEqual(lvl.rows.map((x) => x.table), ["spellname", "spelllevels"]);
  assert.ok(lvl.allowed_numbers.includes(5) && lvl.allowed_numbers.includes(1001) && lvl.allowed_numbers.includes(0));
  const item = recs.find((r) => r.kind === "item_level_req" && r.entity_name === "Fakeblade of a");
  assert.deepEqual(item.expected, { value: 2, unit: "level" }); assert.ok(item.allowed_numbers.includes(11)); // ItemLevel is another number the row holds
  const cd = recs.find((r) => r.kind === "spell_cooldown" && r.entity_name === "Zorbo a Bolt");
  assert.deepEqual(cd.expected, { value: 2, unit: "seconds" }); assert.ok(cd.allowed_numbers.includes(2000));
  const ct = recs.find((r) => r.kind === "spell_cast_time" && r.entity_name === "Zorbo a Bolt"); // i=1 -> index 2 -> 1500 ms
  assert.deepEqual(ct.expected, { value: 1.5, unit: "seconds" });
  rmSync(d, { recursive: true, force: true });
});
test("truth-gen: instant casts (Base 0) are skipped; same seed gives identical bytes, another seed differs; header carries build and hashes", () => {
  const d = fixtureDir();
  const a = generate({ dir: d, seed: 7, perKind: 10 }), b = generate({ dir: d, seed: 7, perKind: 10 }), c = generate({ dir: d, seed: 8, perKind: 10 });
  assert.equal(a.text, b.text);
  assert.notEqual(a.text, c.text);
  assert.equal(a.header.build, "0.0.0.FAKE");
  const man = JSON.parse(readFileSync(join(d, "MANIFEST.json"), "utf8"));
  assert.equal(a.header.tables["spelllevels.csv"].sha256, man.files["spelllevels.csv"].sha256);
  assert.equal(records(a.text)[0].type, "header");
  const casts = records(generate({ dir: d, seed: 1, perKind: 1000 }).text).filter((r) => r.kind === "spell_cast_time");
  assert.ok(casts.length > 0 && casts.every((r) => r.expected.value > 0));
  assert.equal(a.header.selected.spell_level, 10);
  rmSync(d, { recursive: true, force: true });
});

// ---- score ----
test("score.exact_match: number and word forms, units, bare numbers, ids, longer numbers", () => {
  const L = { value: 20, unit: "level" };
  for (const t of ["You learn it at level 20.", "Level 20", "lvl 20", "20th level", "Requires level twenty.", "It's 20.", "20", "level of 20 or higher", "Level: 20"]) assert.equal(exact_match(t, L), true, t);
  for (const t of ["level 120", "level 2.0 maybe", "spell id 20", "It costs 20 gold", "20 mana", "Level 30", "At level 40 you get 20 stamina", "At level 40 you get 20 of them", "no idea", "", null]) assert.equal(exact_match(t, L), false, String(t));
  const S = { value: 300, unit: "seconds" };
  assert.equal(exact_match("It has a 5 minute cooldown", S), true);
  assert.equal(exact_match("cooldown is 300 sec", S), true);
  assert.equal(exact_match("5 minutes", S), true);
  assert.equal(exact_match("It is 10 minutes", S), false);
  assert.equal(exact_match("cast time 1.5s", { value: 1.5, unit: "seconds" }), true);
  assert.equal(exact_match("cast time 15 seconds", { value: 1.5, unit: "seconds" }), false);
  assert.equal(exact_match("costs 120 mana", { value: 120, unit: "mana" }), true);
  assert.equal(exact_match("120 seconds", { value: 120, unit: "mana" }), false);
});
test("score.unsupported_numbers: invented numbers flagged; expected, entity numbers, the question's numbers, small bare counters and list markers are not", () => {
  const base = { question: "What level is Zorbo 77 Bolt?", expected: { value: 20, unit: "level" }, allowed_numbers: [20, 1001, 0] };
  assert.deepEqual(unsupported_numbers("Level 20.", base), []);
  assert.deepEqual(unsupported_numbers("It is level 20, spell 1001.", base), []);
  assert.deepEqual(unsupported_numbers("Level 20 and it does 350 damage.", base), [350]);
  assert.deepEqual(unsupported_numbers("Level 20, costs 45 mana", base), [45]);
  assert.deepEqual(unsupported_numbers("Zorbo 77 Bolt is level 20", base), []); // 77 is in the question
  assert.deepEqual(unsupported_numbers("Level 20. Three tips: 1. aim 2. wait 3. fire", base), []); // list markers and small bare counters
  assert.deepEqual(unsupported_numbers("Level 20 with 3 stacks", base), [3], "a small number with a unit word is not a bare counter");
  assert.deepEqual(unsupported_numbers("Level 20, but some say level 5", base), [5], "small numbers with the level unit are checked");
  assert.deepEqual(unsupported_numbers("Level 20 after 5 seconds", base), [5]);
  assert.deepEqual(unsupported_numbers("Cooldown 5 minutes", { question: "cd?", expected: { value: 300, unit: "seconds" }, allowed_numbers: [] }), [], "5 minutes = 300 s");
  assert.deepEqual(unsupported_numbers("Level 20, in 1,500 attempts", base), [1500]);
  assert.deepEqual(unsupported_numbers("", base), []);
});
test("score.contradiction: a different number in the question's unit; not for the question's own number or a different-fact sentence", () => {
  const L = { value: 20, unit: "level" };
  assert.equal(contradiction("Level 30.", L, "q"), true);
  assert.equal(contradiction("Level 20.", L, "q"), false);
  assert.equal(contradiction("It is level 20, though some say level thirty.", L, "q"), true);
  assert.equal(contradiction("Level 20. Max level 60 though.", L, "q"), false);
  assert.equal(contradiction("Level 20 for rank 2 at level 30", L, "q"), false);
  assert.equal(contradiction("Level 20. At level 40 you get a mount.", L, "q"), true);
  assert.equal(contradiction("Level 20, I know you are level 60", L, "What at level 60?"), false); // the question's own number
  assert.equal(contradiction("It costs 99 gold", L, "q"), false);
  assert.equal(contradiction("3 seconds", { value: 2, unit: "seconds" }, "q"), true);
});
test("score.degraded: non-ok reason, +degraded label, or a status other than answered", () => {
  assert.equal(degraded({ reason: "ok", model: "claude:m+research", status: "answered" }), false);
  assert.equal(degraded({ reason: null, model: "claude:m", status: "answered" }), false);
  assert.equal(degraded({ reason: "claude:timeout@compose-16s", model: "claude:m", status: "answered" }), true);
  assert.equal(degraded({ reason: "ok", model: "claude:m+research+degraded", status: "answered" }), true);
  assert.equal(degraded({ reason: "ok", model: "x", status: "degraded" }), true);
});
test("score.summarize: rates are over scored rows; unscored rows are counted apart; by kind; percentiles", () => {
  const row = (kind, o = {}) => ({ kind, scored: true, status: "answered", reason: "ok", model: "m", latency_ms: 1000, scores: { exact: true, unsupported_count: 0 }, ...o });
  const rows = [row("a"), row("a"), row("a", { scores: { exact: false, unsupported_count: 1 } }), row("a", { scored: false, scores: null, latency_ms: null }),
    row("b", { latency_ms: 30000 }), row("b", { reason: "claude:cap", status: "degraded", scores: { exact: false, unsupported_count: 0 } })];
  const s = summarize(rows);
  assert.equal(s.by_kind.a.n, 4); assert.equal(s.by_kind.a.scored, 3); assert.equal(s.by_kind.a.unscored, 1);
  assert.ok(Math.abs(s.by_kind.a.exact_rate - 2 / 3) < 1e-9); assert.ok(Math.abs(s.by_kind.a.unsupported_rate - 1 / 3) < 1e-9);
  assert.equal(s.by_kind.b.within_budget_rate, 0.5); assert.equal(s.by_kind.b.degraded_rate, 0.5);
  assert.equal(s.by_kind.a.latency_p50_ms, 1000); assert.equal(s.by_kind.b.latency_p95_ms, 30000);
  assert.equal(summarize([{ kind: "pair", scored: true, status: "answered", reason: "ok", latency_ms: 5, scores: { degraded: false } }]).by_kind.pair.exact_rate, null);
  assert.deepEqual(extractNumbers("a 1,200 b 2.5 c 30s d 20th e x5").map((t) => t.value), [1200, 2.5, 30, 20]);
});

// ---- pass bar ----
test("pass bar: the numbers are pinned (change here and in docs/runbooks/replay-harness.md together)", () => {
  assert.deepEqual({ ...PASS_BAR, required_kinds: [...PASS_BAR.required_kinds] }, { exact_rate_min: 0.9, unsupported_rate_max: 0.02, degraded_rate_max: 0.05, within_budget_rate_min: 0.95, min_scored_per_kind: 30, required_kinds: ["spell_level", "item_level_req"] });
  assert.equal(WITHIN_BUDGET_MS, 22000);
  assert.deepEqual({ ...PAIR_RULE }, { min_graded: 30, dimension_margin: 0.25, groundedness_floor: 4.0, low_groundedness_max_share: 0.05, non_loss_min: 0.7 });
  const runbook = readFileSync(join(ROOT, "docs", "runbooks", "replay-harness.md"), "utf8");
  for (const needle of ["exact_rate >= 0.90", "unsupported_rate <= 0.02", "degraded_rate <= 0.05", "within_budget_rate >= 0.95", "at least 30", "22000"]) assert.ok(runbook.includes(needle), needle);
});
test("pass bar: evaluateBar needs every rate, the sample size and the required kinds", () => {
  const good = { exact_scored: 30, exact_rate: 0.9, unsupported_rate: 0.02, degraded_rate: 0.05, within_budget_rate: 0.95 };
  assert.equal(evaluateBar({ by_kind: { spell_level: good, item_level_req: good } }).pass, true);
  assert.equal(evaluateBar({ by_kind: { spell_level: good } }).pass, false); // required kind missing
  for (const bad of [{ exact_scored: 29 }, { exact_rate: 0.89 }, { unsupported_rate: 0.03 }, { degraded_rate: 0.06 }, { within_budget_rate: 0.94 }]) {
    const r = evaluateBar({ by_kind: { spell_level: { ...good, ...bad }, item_level_req: good } });
    assert.equal(r.pass, false, JSON.stringify(bad)); assert.equal(r.failures.length, 1);
  }
  assert.equal(evaluateBar({ by_kind: {} }).pass, false);
});

// ---- traits: fictional trees in a temp dir ----
const TN = (nodeId, name, maxRanks, { edgesTo = [], conds = [], entryId = nodeId + 5000 } = {}) => ({ nodeId: String(nodeId), entryId: String(entryId), spellId: String(900000 + nodeId), name, maxRanks: String(maxRanks), x: "1", y: "2", type: "0", text: "", edgesTo: edgesTo.map(String), conds });
const COND = (spent, currency = "3820", condType = "0") => ({ condType, spentAmountRequired: String(spent), currency, tab: "1" });
function traitsObject() {
  const mage = [
    TN(1, "Frobnitz Bolt", 3, { edgesTo: [2, 5, 9] }),
    TN(2, "Quuxlance", 2, { conds: [COND(5)] }),                       // single source (1): prereq; one cond: points 5
    TN(3, "Twinsong", 2, { conds: [COND(5)] }), TN(4, "Twinsong", 1),  // duplicate name: both excluded everywhere
    TN(5, "Mergepoint", 1, { conds: [COND(10)] }),                     // two incoming (1 and 6): no prereq
    TN(6, "Sidestep", 4, { edgesTo: [5] }),
    TN(7, "Doublecond", 2, { conds: [COND(5), COND(8, "0")] }),        // two conds: no points, ranks ok
    TN(8, "Zerocurr", 2, { conds: [COND(5, "0")] }),                   // currency 0 cond: no points
    TN(9, "Greater Frobnitz Bolt", 1, { conds: [COND(15)] }),          // name contains the source name: no prereq
    TN(10, "Choice Alpha", 1, { entryId: 7001 }), TN(10, "Choice Beta", 1, { entryId: 7002 }), // one nodeId, two entries
    TN(11, "Zero Rank", 0), TN(12, "?", 2), TN(13, "Cased Name", 2), TN(14, "cased name", 2),
    TN(15, "Orphan Strike", 2, { conds: [COND(0)] }),                  // requirement 0: no points
    TN(16, "Sourcedup", 2, { edgesTo: [17] }), TN(17, "Sinkone", 2, { conds: [COND(20)] }), // clean pair
    TN(18, "Twinsong", 2, { edgesTo: [19] }), TN(19, "Sinktwo", 2),    // source name is a duplicate: no prereq
  ];
  const paladin = [TN(1, "Quuxlance", 5, { edgesTo: [2] }), TN(2, "Holyfrob", 1, { conds: [COND(30)] })];
  return { build: "9.9.9.TRAITFAKE", source: "fictional", trees: { 1112: { treeId: "1112", system: "10", nodeCount: mage.length, nodes: mage }, 1100: { treeId: "1100", system: "10", nodeCount: paladin.length, nodes: paladin }, 7777: { treeId: "7777", system: "10", nodeCount: 1, nodes: [TN(1, "Notaclass Hit", 3)] } } };
}
function writeTraits(dir, obj = traitsObject(), name = "traits.json") { const p = join(dir, name); writeFileSync(p, JSON.stringify(obj)); return p; }
const ofKind = (text, kind) => records(text).slice(1).filter((r) => r.kind === kind);

test("traits: uniqueness filter drops duplicate (case-insensitive), repeated-nodeId, zero-rank, '?' and non-class-tree nodes; ranks come from maxRanks", () => {
  const { out, used } = buildTraitCandidates(traitsObject());
  assert.equal(used, 2);
  const names = (k) => out[k].map((r) => `${r.class_name}:${r.entity_name}`);
  const ranks = names("trait_max_ranks");
  for (const bad of ["Twinsong", "Choice Alpha", "Choice Beta", "Zero Rank", "?", "Cased Name", "cased name", "Notaclass Hit"]) assert.ok(!ranks.some((n) => n.endsWith(":" + bad)), bad);
  assert.ok(ranks.includes("Mage:Quuxlance") && ranks.includes("Paladin:Quuxlance"), "the same name in two class trees is allowed");
  assert.deepEqual(out.trait_max_ranks.find((r) => r.id === "trait_max_ranks-1112-1").expected, { value: 3, unit: "ranks" });
  assert.deepEqual(out.trait_max_ranks.find((r) => r.id === "trait_max_ranks-1100-1").expected, { value: 5, unit: "ranks" });
  assert.deepEqual(buildTraitCandidates({ ...traitsObject(), trees: Object.values(traitsObject().trees) }).out.trait_max_ranks.map((r) => r.id), out.trait_max_ranks.map((r) => r.id), "array form of trees gives the same set");
});
test("traits: points need exactly one cond with a real currency and a positive integer requirement", () => {
  const { out } = buildTraitCandidates(traitsObject());
  const got = Object.fromEntries(out.trait_points_required.map((r) => [`${r.class_name}:${r.entity_name}`, r.expected.value]));
  assert.deepEqual(got, { "Mage:Quuxlance": 5, "Mage:Mergepoint": 10, "Mage:Greater Frobnitz Bolt": 15, "Mage:Sinkone": 20, "Paladin:Holyfrob": 30 });
  assert.ok(out.trait_points_required.every((r) => r.expected.unit === "points"));
  for (const bad of ["Doublecond", "Zerocurr", "Orphan Strike", "Twinsong"]) assert.ok(!(`Mage:${bad}` in got), bad);
});
test("traits: prerequisite = the one distinct node with an edge to it; ambiguity is skipped, not guessed", () => {
  const { out } = buildTraitCandidates(traitsObject());
  const got = Object.fromEntries(out.trait_prereq.map((r) => [`${r.class_name}:${r.entity_name}`, r.expected]));
  assert.deepEqual(got, {
    "Mage:Quuxlance": { value: "Frobnitz Bolt", unit: "name" },
    "Mage:Sinkone": { value: "Sourcedup", unit: "name" },
    "Paladin:Holyfrob": { value: "Quuxlance", unit: "name" },
  });
  assert.ok(!("Mage:Mergepoint" in got), "two different incoming nodes");
  assert.ok(!("Mage:Greater Frobnitz Bolt" in got), "source name contained in the asked name");
  assert.ok(!("Mage:Sinktwo" in got), "the only source has a duplicate name");
  const rec = out.trait_prereq.find((r) => r.id === "trait_prereq-1112-2");
  assert.deepEqual(rec.rows, [{ table: "traittree", id: "1112" }, { table: "traitnode", id: "2" }, { table: "traitnode", id: "1" }]);
  assert.ok(rec.allowed_numbers.includes(1112) && rec.allowed_numbers.includes(5002) && rec.allowed_numbers.includes(5001) && rec.allowed_numbers.includes(900001));
  // a repeated edge from the same source node (two entries on the source) is still one prerequisite
  const dupEdge = traitsObject(); dupEdge.trees[1112].nodes.push(TN(20, "Sourcedup2", 2, { edgesTo: [21, 21] }), TN(21, "Sinkthree", 1));
  assert.ok(buildTraitCandidates(dupEdge).out.trait_prereq.some((r) => r.entity_name === "Sinkthree"));
});
test("traits: generate records build and sha256 of the file, names the class in the question, is deterministic; without a traits file nothing changes", () => {
  const d = fixtureDir();
  const tp = writeTraits(d);
  const a = generate({ dir: d, seed: 5, perKind: 100, traitsPath: tp }), b = generate({ dir: d, seed: 5, perKind: 100, traitsPath: tp });
  assert.equal(a.text, b.text);
  assert.equal(a.header.traits.build, "9.9.9.TRAITFAKE");
  assert.equal(a.header.traits.sha256, sha256(readFileSync(tp)));
  assert.equal(a.header.traits.bytes, readFileSync(tp).length);
  assert.equal(a.header.traits.trees_used, 2);
  assert.equal(JSON.stringify(a.header).includes(tp.replace(/\\/g, "\\\\")), false, "the file path is not recorded");
  assert.deepEqual(TRAIT_KINDS.map((k) => a.header.selected[k]), [a.header.candidates.trait_max_ranks, 5, 3]);
  const q = ofKind(a.text, "trait_prereq").find((r) => r.entity_name === "Quuxlance" && r.class_name === "Mage");
  assert.ok(q.question.includes("Quuxlance") && q.question.includes("Mage"));
  assert.ok(ofKind(a.text, "trait_max_ranks").every((r) => r.question.includes(r.entity_name) && r.question.includes(r.class_name)));
  // the file is hashed, so an edit changes the recorded hash; the DB2 tables are still verified by the manifest
  const obj = traitsObject(); obj.trees[1112].nodes[0].maxRanks = "4";
  const c = generate({ dir: d, seed: 5, perKind: 100, traitsPath: writeTraits(d, obj, "traits2.json") });
  assert.notEqual(c.header.traits.sha256, a.header.traits.sha256);
  writeFileSync(join(d, "spelllevels.csv"), readFileSync(join(d, "spelllevels.csv"), "utf8").replace("1001,0,0,0,5,0,1001", "1001,0,0,0,50,0,1001"));
  assert.throws(() => generate({ dir: d, traitsPath: tp }), /spelllevels\.csv/);
  const d2 = fixtureDir();
  const plain = generate({ dir: d2, seed: 5, perKind: 100 });
  assert.equal("traits" in plain.header, false);
  assert.ok(!records(plain.text).some((r) => String(r.kind).startsWith("trait_")));
  writeFileSync(join(d2, "bad.json"), "{}");
  assert.throws(() => generate({ dir: d2, traitsPath: join(d2, "bad.json") }), /none of the known class trees/);
  writeFileSync(join(d2, "bad2.json"), "not json");
  assert.throws(() => generate({ dir: d2, traitsPath: join(d2, "bad2.json") }), /not JSON/);
  rmSync(d, { recursive: true, force: true }); rmSync(d2, { recursive: true, force: true });
});
test("traits: the CLI refuses an output path in the repo with a traits file, a missing --traits file, and --traits with --no-traits", async () => {
  const d = fixtureDir();
  const tp = writeTraits(d);
  const bad = join(REPO_ROOT, "tools", "replay", "must-not-exist-traits.jsonl");
  let r = await runCli("truth-gen.mjs", ["--tables", d, "--traits", tp, "--out", bad]);
  assert.notEqual(r.code, 0); assert.match(r.err, /inside the repo/); assert.equal(existsSync(bad), false);
  r = await runCli("truth-gen.mjs", ["--tables", d, "--traits", join(d, "nope.json"), "--out", join(d, "o.jsonl")]);
  assert.notEqual(r.code, 0); assert.match(r.err, /not found/);
  r = await runCli("truth-gen.mjs", ["--tables", d, "--traits", tp, "--no-traits", "--out", join(d, "o.jsonl")]);
  assert.notEqual(r.code, 0);
  r = await runCli("truth-gen.mjs", ["--tables", d, "--traits", tp, "--out", join(d, "ok.jsonl"), "--per-kind", "100"]);
  assert.equal(r.code, 0); assert.match(r.out, /trait_prereq\s+candidates\s+3\s+selected\s+3/);
  assert.equal(JSON.parse(readFileSync(join(d, "ok.jsonl"), "utf8").split("\n")[0]).traits.sha256, sha256(readFileSync(tp)));
  rmSync(d, { recursive: true, force: true });
});
test("traits: with no trait flag the CLI reads no file outside the tables dir and generates no trait kinds", async () => {
  const d = fixtureDir();
  const log = join(d, "reads.log");
  const hook = join(d, "hook.cjs");
  writeFileSync(hook, `const fs=require("fs");const L=${JSON.stringify(log)};const rec=(p)=>{try{fs.appendFileSync(L,String(p)+String.fromCharCode(10))}catch{}};for(const n of ["readFileSync","openSync","existsSync","statSync"]){const o=fs[n];fs[n]=function(p,...r){if(typeof p==="string"&&p!==L)rec(p);return o.call(this,p,...r)}}`);
  const out = join(d, "o.jsonl");
  const p = spawn(process.execPath, ["--require", hook, TOOLS("truth-gen.mjs"), "--tables", d, "--out", out], { stdio: ["ignore", "pipe", "pipe"] });
  const code = await new Promise((r) => p.on("close", r));
  assert.equal(code, 0);
  const seen = readFileSync(log, "utf8").split(String.fromCharCode(10)).filter(Boolean).map((x) => x.split(String.fromCharCode(92)).join("/").toLowerCase());
  assert.ok(seen.length > 0 && seen.some((x) => x.endsWith("manifest.json")), "the hook saw the tables reads");
  assert.ok(!seen.some((x) => /traits|leeroy-ops|private/.test(x)), "a trait or private path was touched");
  const head = JSON.parse(readFileSync(out, "utf8").split(String.fromCharCode(10))[0]);
  assert.equal("traits" in head, false);
  assert.ok(!readFileSync(out, "utf8").includes('"kind":"trait_'));
  rmSync(d, { recursive: true, force: true });
});
test("traits score: rank phrasing", () => {
  const R = { value: 3, unit: "ranks" };
  for (const t of ["It has 3 ranks.", "3 rank", "Three ranks.", "You can put up to three ranks into it", "Max rank 3", "maximum ranks of 3", "Ranks: 3", "It has 3."]) assert.equal(exact_match(t, R), true, t);
  for (const t of ["It has 4 ranks.", "5 points", "It needs 3 points in the tree", "Level 3", "rank 2 of 4", "no idea", "It does not have 3 ranks", "It has 30 ranks", "13 ranks"]) assert.equal(exact_match(t, R), false, t);
  assert.equal(exact_match("It has a single rank.", { value: 1, unit: "ranks" }), true);
  assert.equal(exact_match("only one point can be spent", { value: 1, unit: "ranks" }), true);
  assert.equal(exact_match("It has a single rank.", R), false);
  assert.equal(contradiction("It has 4 ranks.", R, "q"), true, "ranks is the question's own unit, not another fact");
  assert.equal(contradiction("It has 3 ranks.", R, "q"), false);
  assert.equal(contradiction("It has 3 ranks, but 4 once upgraded", R, "q"), false, "an upgrade clause is another fact");
  assert.deepEqual(unsupported_numbers("It has 3 ranks and costs 4 ranks of nothing", { question: "q", expected: R, allowed_numbers: [3] }), [4]);
  assert.deepEqual(unsupported_numbers("It has 3 ranks. Tip: 2 gems", { question: "q", expected: R, allowed_numbers: [3] }), []);
});
test("traits score: points phrasing", () => {
  const P = { value: 5, unit: "points" };
  for (const t of ["You need 5 points spent first.", "5 talent points", "Five points", "needs 5 points in the tree", "a requirement of 5 points", "5 point"]) assert.equal(exact_match(t, P), true, t);
  for (const t of ["3 ranks", "It has 5 ranks", "needs 10 points", "50 points", "level 5", "not 5 points"]) assert.equal(exact_match(t, P), false, t);
  assert.equal(exact_match("5", P), true, "a bare number with no unit anywhere");
  assert.equal(exact_match("It has 5 ranks", { value: 5, unit: "points" }), false);
  assert.equal(contradiction("It needs 10 points.", P, "q"), true);
  assert.equal(contradiction("It needs 5 points; the tree holds 51 points in total.", P, "q"), false);
  assert.equal(contradiction("It needs 5 points and has 3 ranks.", P, "q"), false);
  assert.deepEqual(unsupported_numbers("Needs 5 points and 20 points elsewhere", { question: "q", expected: P, allowed_numbers: [5] }), [20]);
  // the new units are read only for trait items: other kinds score as before
  assert.equal(exact_match("It has 3 ranks, level 20", { value: 20, unit: "level" }), true);
  assert.deepEqual(unsupported_numbers("Level 20 with 3 ranks", { question: "q", expected: { value: 20, unit: "level" }, allowed_numbers: [] }), []);
});
test("traits score: the prerequisite name must be named, not negated, and not just the asked talent's own name", () => {
  const rec = { kind: "trait_prereq", question: "Which Mage talent do you need to take first before you can learn Frob Bolt Mastery?", entity_name: "Frob Bolt Mastery", expected: { value: "Frob Bolt", unit: "name" }, allowed_numbers: [1112, 5] };
  const ok = { reason: "ok", status: "answered", model: "m" };
  assert.equal(scoreTruthItem(rec, ok, "You need Frob Bolt first.").exact, true);
  assert.equal(scoreTruthItem(rec, ok, "Take frob  bolt before it.").exact, true);
  assert.equal(scoreTruthItem(rec, ok, "Frob Bolt Mastery requires Frob Bolt.").exact, true);
  assert.equal(scoreTruthItem(rec, ok, "Frob Bolt Mastery has no prerequisite.").exact, false, "the asked talent's own name is not the answer");
  assert.equal(scoreTruthItem(rec, ok, "It does not require Frob Bolt, it is open.").exact, false);
  assert.equal(scoreTruthItem(rec, ok, "You need Frob Boltish first.").exact, false, "word boundary");
  assert.equal(scoreTruthItem(rec, ok, "You need Other Talent first.").exact, false);
  assert.equal(scoreTruthItem(rec, ok, "").exact, false);
  assert.equal(scoreTruthItem(rec, { ...ok, status: "degraded" }, "Frob Bolt").exact, false);
  const withNum = scoreTruthItem(rec, ok, "Frob Bolt first, it costs 250 mana");
  assert.equal(withNum.unsupported_count, 1);
  assert.equal(scoreTruthItem(rec, ok, "Frob Bolt, node 1112, 5 points").unsupported_count, 0);
  assert.equal(contradiction("Frob Bolt", rec.expected, rec.question), false);
  assert.equal(exact_match("O'Brien Bolt first", { value: "O\u2019Brien Bolt", unit: "name" }), true, "apostrophe forms match");
});
test("traits bar: trait kinds are known to run.mjs, are not required, and are held to the same bar and sample size as every other kind", () => {
  for (const k of TRAIT_KINDS) assert.ok(KNOWN_KINDS.includes(k), k);
  assert.ok(!TRAIT_KINDS.some((k) => PASS_BAR.required_kinds.includes(k)));
  const good = { exact_scored: 30, exact_rate: 0.9, unsupported_rate: 0.02, degraded_rate: 0.05, within_budget_rate: 0.95 };
  const base = { spell_level: good, item_level_req: good };
  assert.equal(evaluateBar({ by_kind: { ...base, trait_prereq: good } }).pass, true);
  assert.equal(evaluateBar({ by_kind: base }).pass, true, "a run without trait items still passes on the required kinds");
  const r = evaluateBar({ by_kind: { ...base, trait_prereq: { ...good, exact_scored: 29 }, trait_max_ranks: { ...good, exact_rate: 0.5 } } });
  assert.equal(r.pass, false); assert.ok(r.failures.some((f) => f.startsWith("trait_prereq: only 29")) && r.failures.some((f) => f.startsWith("trait_max_ranks: exact_rate")));
});

// ---- run: stub of the shadow route ----
async function stub(handler) {
  const seen = [];
  const key = await shadowKey(TOKEN);
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const ok = await verifyListen(key, req.headers["x-listen-timestamp"], raw, req.headers["x-listen-signature"], Math.floor(Date.now() / 1000));
    seen.push({ url: req.url, method: req.method, ok, body: ok ? JSON.parse(raw) : null });
    if (!ok) { res.writeHead(401).end("{}"); return; }
    const r = handler(JSON.parse(raw), seen.length, res);
    if (r === undefined) return;
    res.writeHead(r.status || 200, { "Content-Type": "application/json", ...(r.headers || {}) }).end(JSON.stringify(r.json));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, seen, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}
const answerFor = (rec, good) => `It is level ${good ? rec.expected.value : rec.expected.value + 7}.`;
function truthFile(dir, n = 5, limit = 6) {
  const d = fixtureDir();
  const recs = records(generate({ dir: d, seed: 1, perKind: n }).text).filter((r) => r.kind === "spell_level" || r.kind === "item_level_req").slice(0, limit);
  const file = join(dir, "truth.jsonl");
  writeFileSync(file, [JSON.stringify({ type: "header" }), ...recs.map((r) => JSON.stringify(r))].join("\n") + "\n");
  rmSync(d, { recursive: true, force: true });
  return { file, recs };
}
const opts = (dir, extra = {}) => ({ tokenFile: join(dir, "token"), input: join(dir, "truth.jsonl"), outPath: join(dir, "results.jsonl"), maxItems: 20, delayMs: 0, base: "http://127.0.0.1:1", ...extra });
const instant = { sleep: async () => {} };

test("run: signed calls, scored results, answers NOT retained without --keep-answers, retained with it", async () => {
  const dir = tmp(); writeFileSync(join(dir, "token"), TOKEN + "\n");
  const { recs } = truthFile(dir, 5);
  const byQ = new Map(recs.map((r) => [r.question, r]));
  const s = await stub((body) => ({ json: { id: "i", ok: true, status: "answered", model: "claude:m+research", latency_ms: 4000, reason: "ok", answer: answerFor(byQ.get(body.question), true) } }));
  const r = await runReplay(opts(dir, { base: s.base }), instant);
  assert.equal(r.stop, "done"); assert.equal(r.sent, recs.length);
  assert.ok(s.seen.every((x) => x.ok && x.method === "POST" && x.url === "/api/shadow/ask" && x.body.purpose === "shadow-ask" && Object.keys(x.body).every((k) => ["purpose", "question", "as", "local_answer"].includes(k))));
  const text = readFileSync(join(dir, "results.jsonl"), "utf8");
  const lines = records(text);
  assert.equal(lines[0].type, "header"); assert.match(lines[0].input_sha256, /^[0-9a-f]{64}$/);
  assert.equal(lines.filter((x) => x.type === "sent").length, recs.length, "one sent marker per call");
  const rows = lines.filter((x) => !x.type);
  assert.ok(rows.every((x) => /^[0-9a-f]{64}$/.test(x.question_sha256) && x.fictional === false));
  assert.ok(rows.every((x) => x.scored && x.ok && x.within_budget && x.scores.exact === true && x.answer_length > 0 && /^[0-9a-f]{64}$/.test(x.answer_sha256) && x.answer === undefined));
  assert.ok(!text.includes("It is level"), "answer text retained without --keep-answers");
  assert.ok(!text.includes(TOKEN) && !text.includes(recs[0].question), "token or question leaked into results");
  const dir2 = join(dir, "k"); mkdirSync(dir2);
  const r2 = await runReplay(opts(dir, { base: s.base, outPath: join(dir2, "r.jsonl"), keepAnswers: true }), instant);
  assert.ok(resultRows(join(dir2, "r.jsonl")).every((x) => /^It is level/.test(x.answer)));
  assert.equal(r2.sent, recs.length);
  await s.close(); rmSync(dir, { recursive: true, force: true });
});
test("run: wrong, invented and degraded answers are scored as such", async () => {
  const dir = tmp(); writeFileSync(join(dir, "token"), TOKEN);
  const { recs } = truthFile(dir, 3);
  const byQ = new Map(recs.map((r) => [r.question, r]));
  let n = 0;
  const s = await stub((body) => {
    n++;
    const rec = byQ.get(body.question);
    if (n === 1) return { json: { id: "i", ok: true, status: "answered", model: "m", latency_ms: 30000, reason: "ok", answer: answerFor(rec, false) } };
    if (n === 2) return { json: { id: "i", ok: true, status: "answered", model: "m", latency_ms: 100, reason: "ok", answer: `Level ${rec.expected.value}, dealing 987654 damage.` } };
    if (n === 3) return { json: { id: "i", ok: false, status: "degraded", model: "m+degraded", latency_ms: 100, reason: "claude:cap", answer: "library fact" } };
    return { status: 400, json: { error: "bad" } };
  });
  const r = await runReplay(opts(dir, { base: s.base }), instant);
  const rows = r.results;
  assert.equal(rows[0].scores.exact, false); assert.equal(rows[0].within_budget, false);
  assert.equal(rows[1].scores.exact, true); assert.equal(rows[1].scores.unsupported_count, 1);
  assert.equal(rows[2].scores.degraded, true); assert.equal(rows[2].scores.exact, false);
  if (rows[3]) { assert.equal(rows[3].scored, false); assert.equal(rows[3].scores, null); }
  await s.close(); rmSync(dir, { recursive: true, force: true });
});
test("run: --max-items stops cleanly; --resume continues without repeating ids and never exceeds the cap", async () => {
  const dir = tmp(); writeFileSync(join(dir, "token"), TOKEN);
  const { recs } = truthFile(dir, 5);
  const byQ = new Map(recs.map((r) => [r.question, r]));
  const s = await stub((body) => ({ json: { id: "i", ok: true, status: "answered", model: "m", latency_ms: 10, reason: "ok", answer: answerFor(byQ.get(body.question), true) } }));
  let r = await runReplay(opts(dir, { base: s.base, maxItems: 3 }), instant);
  assert.equal(r.stop, "max-items"); assert.equal(r.sent, 3); assert.equal(s.seen.length, 3);
  const firstIds = r.results.map((x) => x.id);
  r = await runReplay(opts(dir, { base: s.base, maxItems: 2 }), instant);
  assert.equal(r.sent, 2); assert.equal(s.seen.length, 5);
  const all = resultRows(join(dir, "results.jsonl")).map((x) => x.id);
  assert.equal(new Set(all).size, all.length, "an id was run twice");
  assert.ok(firstIds.every((id) => all.includes(id)));
  assert.equal(all.length, 5);
  r = await runReplay(opts(dir, { base: s.base, maxItems: 20 }), instant);
  assert.equal(r.sent, recs.length - 5); assert.equal(s.seen.length, recs.length);
  r = await runReplay(opts(dir, { base: s.base, maxItems: 20 }), instant);
  assert.equal(r.sent, 0); assert.equal(r.stop, "done"); assert.equal(s.seen.length, recs.length);
  await assert.rejects(runReplay(opts(dir, { base: s.base, maxItems: 21 }), instant), /--max-items/);
  await assert.rejects(runReplay(opts(dir, { base: s.base, maxItems: 0 }), instant), /--max-items/);
  await s.close(); rmSync(dir, { recursive: true, force: true });
});
test("run: rate windows (6/hour, 20/day) stop the run cleanly and resumably; a 429 stops it and the item is retried on resume", async () => {
  assert.equal(waitMs([], 1000), 0);
  const t0 = 1_000_000_000_000;
  const six = [0, 1, 2, 3, 4, 5].map((i) => t0 + i * 1000);
  assert.equal(waitMs(six, t0 + 10_000), 3600_000 - 10_000); // the oldest of the last six frees up an hour after it
  assert.equal(waitMs(six, t0 + 3600_000), 0);
  const day = Array.from({ length: 20 }, (_, i) => t0 + i * 3600_000 * 1.1);
  assert.ok(waitMs(day, t0 + 24 * 3600_000 - 1) > 0);
  const dir = tmp(); writeFileSync(join(dir, "token"), TOKEN);
  const { recs } = truthFile(dir, 5, 10);
  assert.ok(recs.length >= 7);
  const byQ = new Map(recs.map((r) => [r.question, r]));
  let limited = false;
  const s = await stub((body) => (limited ? { status: 429, headers: { "Retry-After": "120" }, json: { error: "rate limited" } } : { json: { id: "i", ok: true, status: "answered", model: "m", latency_ms: 10, reason: "ok", answer: answerFor(byQ.get(body.question), true) } }));
  let r = await runReplay(opts(dir, { base: s.base, maxWaitMs: 1000 }), instant);
  assert.equal(r.stop, "rate-window"); assert.equal(r.sent, 6); assert.equal(s.seen.length, 6); // the 7th is held back: the hour window is full
  rmSync(join(dir, "results.jsonl"));
  limited = true;
  r = await runReplay(opts(dir, { base: s.base }), instant);
  assert.equal(r.stop, "rate-limited"); assert.equal(resultRows(join(dir, "results.jsonl")).length, 0, "a 429 must not record a result for the item");
  limited = false;
  r = await runReplay(opts(dir, { base: s.base, maxItems: 1 }), instant);
  assert.equal(r.results[0].id, recs[0].id);
  await s.close(); rmSync(dir, { recursive: true, force: true });
});
test("run: 401 and 404 stop with an error; a redirect is refused and never followed; the token never appears in output", async () => {
  const dir = tmp(); writeFileSync(join(dir, "token"), TOKEN);
  truthFile(dir, 2);
  const target = await stub(() => ({ json: { ok: true } }));
  const redir = await stub((b, n, res) => { res.writeHead(302, { Location: target.base + "/api/shadow/ask" }).end(); });
  let r = await runReplay(opts(dir, { base: redir.base }), instant);
  assert.equal(r.stop, "error:request-failed"); assert.equal(target.seen.length, 0, "the redirect was followed");
  assert.equal(resultRows(join(dir, "results.jsonl")).length, 0);
  const s404 = await stub(() => ({ status: 404, json: { error: "not found" } }));
  r = await runReplay(opts(dir, { base: s404.base }), instant);
  assert.equal(r.stop, "error:http-404");
  // wrong token: the stub verifies with the real key, so a different token file gets 401
  writeFileSync(join(dir, "token2"), "another-token-" + "y".repeat(40));
  r = await runReplay(opts(dir, { base: target.base, tokenFile: join(dir, "token2") }), instant);
  assert.equal(r.stop, "error:http-401");
  for (const x of [target, redir, s404]) await x.close();
  rmSync(dir, { recursive: true, force: true });
});
test("run: https only except localhost and 127.0.0.1, no credentials; a missing or short token refuses", async () => {
  assert.doesNotThrow(() => checkBase("https://api.leeroy.party"));
  assert.doesNotThrow(() => checkBase("http://localhost:8787"));
  assert.doesNotThrow(() => checkBase("http://127.0.0.1:8787"));
  for (const bad of ["http://api.leeroy.party", "http://evil.example", "https://u:p@api.leeroy.party", "ftp://localhost", "not a url", "http://127.0.0.1.evil.example"]) assert.throws(() => checkBase(bad), /refusing/, bad);
  const dir = tmp(); truthFile(dir, 1);
  await assert.rejects(runReplay(opts(dir, { tokenFile: join(dir, "nope"), base: "https://api.leeroy.party" }), instant), /token file/);
  writeFileSync(join(dir, "short"), "abc");
  await assert.rejects(runReplay(opts(dir, { tokenFile: join(dir, "short"), base: "https://api.leeroy.party" }), instant), /usable token/);
  await assert.rejects(runReplay(opts(dir, { tokenFile: join(dir, "short"), base: "http://api.leeroy.party" }), instant), /https/);
  rmSync(dir, { recursive: true, force: true });
});
test("run CLI: prints a summary, never a question, an answer or the token; --summarize needs no network", async () => {
  const dir = tmp(); writeFileSync(join(dir, "token"), TOKEN);
  const { recs } = truthFile(dir, 3);
  const byQ = new Map(recs.map((r) => [r.question, r]));
  const s = await stub((body) => ({ json: { id: "i", ok: true, status: "answered", model: "m", latency_ms: 10, reason: "ok", answer: answerFor(byQ.get(body.question), true) } }));
  const out = join(dir, "cli-results.jsonl");
  const r = await runCli("run.mjs", [join(dir, "token"), "--in", join(dir, "truth.jsonl"), "--max-items", "4", "--delay-s", "0", "--out", out, "--base", s.base]);
  assert.equal(r.code, 0, r.err);
  const all = r.out + r.err;
  assert.match(r.out, /stopped: max-items; sent 4/); assert.match(r.out, /spell_level|item_level_req/); assert.match(r.out, /pass bar: FAIL/);
  assert.ok(!all.includes(TOKEN)); for (const rec of recs) assert.ok(!all.includes(rec.question) && !all.includes(rec.entity_name));
  assert.ok(!all.includes("It is level"));
  const sm = await runCli("run.mjs", ["--summarize", out]);
  assert.equal(sm.code, 0); assert.match(sm.out, /ALL/);
  const missing = await runCli("run.mjs", [join(dir, "token"), "--in", join(dir, "truth.jsonl")]);
  assert.equal(missing.code, 2);
  const redo = await runCli("run.mjs", [join(dir, "token"), "--in", join(dir, "truth.jsonl"), "--max-items", "2", "--delay-s", "0", "--resume", out, "--base", s.base]);
  assert.match(redo.out, /sent 2/);
  assert.equal(resultRows(out).length, 6);
  await s.close(); rmSync(dir, { recursive: true, force: true });
});
test("run: a pair corpus sends as/local_answer when they fit 4 KB, leaves the local answer out when not, and is never printed", () => {
  const a = buildBody({ question: "q", asker_slug: "pat", local_answer: "hello" });
  assert.deepEqual(JSON.parse(a.body), { purpose: "shadow-ask", question: "q", as: "pat", local_answer: "hello" });
  const b = buildBody({ question: "q", local_answer: "x".repeat(5000) });
  assert.equal(b.localOmitted, true); assert.deepEqual(JSON.parse(b.body), { purpose: "shadow-ask", question: "q" });
});

// ---- grade-pack ----
const pairs = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, question: `Q${i}?`, local_answer: `LOCAL-${i}`, ...extra }));
const SHA = "f".repeat(64);
const workerResults = (n, fictional = false, sha = SHA) => [{ type: "header", input_sha256: sha }, ...Array.from({ length: n }, (_, i) => ({ id: `c${i}`, answer: `WORKER-${i}`, model: "claude:claude-sonnet-5-5+research", question_sha256: sha256(`Q${i}?`), fictional }))];
const bp = (o) => buildPackets({ corpusSha256: SHA, ...o });
test("grade-pack: packets are blinded (no labels, no ids), A/B order varies, the key unblinds", () => {
  const r = bp({ corpus: pairs(60, { fictional: true }), results: workerResults(60, true), grader: "claude", seed: 5 });
  const lines = r.packetText.trim().split("\n").map((l) => JSON.parse(l));
  const packets = lines.slice(1);
  assert.equal(lines[0].type, "header"); assert.equal(packets.length, 60);
  for (const p of packets) {
    assert.deepEqual(Object.keys(p).sort(), ["A", "B", "packet_id", "question"]);
    assert.ok(/(WORKER|LOCAL)-\d+/.test(p.A) && /(WORKER|LOCAL)-\d+/.test(p.B));
    assert.ok(!/^c\d+$/.test(p.packet_id));
  }
  const body = packets.map((p) => JSON.stringify(p)).join(" ").replace(/(WORKER|LOCAL)-\d+/g, "");
  assert.ok(!/worker|local|claude|\bc\d+\b/i.test(body), "a label leaked into the packet");
  const key = r.keyText.trim().split("\n").map((l) => JSON.parse(l));
  const workerFirst = key.filter((k) => k.A === "worker").length;
  assert.ok(workerFirst > 10 && workerFirst < 50, `A/B not randomised: ${workerFirst}/60`);
  for (const k of key) { const p = packets.find((x) => x.packet_id === k.packet_id); assert.ok((k.A === "worker" ? p.A : p.B).startsWith("WORKER-")); assert.ok((k.A === "local" ? p.A : p.B).startsWith("LOCAL-")); }
  assert.notEqual(bp({ corpus: pairs(60, { fictional: true }), results: workerResults(60, true), grader: "claude", seed: 6 }).keyText, r.keyText);
  assert.equal(r.header.private, false); assert.equal(r.header.same_family_warning, true);
  assert.deepEqual(packets.map((p) => p.packet_id), [...new Set(packets.map((p) => p.packet_id))]);
});
test("grade-pack: a private corpus is refused unless --grader claude, and is marked private; external needs every record fictional", () => {
  const priv = pairs(4), res = workerResults(4, true);
  assert.throws(() => bp({ corpus: priv, results: res, grader: "external" }), /private/);
  assert.throws(() => bp({ corpus: [...pairs(3, { fictional: true }), { ...pairs(1)[0], id: "c3" }], results: res, grader: "external" }), /private/); // one unflagged record makes it private
  assert.throws(() => bp({ corpus: priv, results: res, grader: "gemini" }), /--grader/);
  const ok = bp({ corpus: priv, results: res, grader: "claude" });
  assert.equal(ok.header.private, true); assert.match(ok.header.note, /PRIVATE/);
  const fict = bp({ corpus: pairs(4, { fictional: true }), results: res, grader: "external" });
  assert.equal(fict.header.private, false); assert.equal(fict.header.same_family_warning, false);
  assert.throws(() => bp({ corpus: pairs(4, { fictional: "true" }), results: res, grader: "external" }), /private/); // only the boolean true counts
  assert.equal(bp({ corpus: priv, results: [{ type: "header", input_sha256: SHA }], grader: "claude" }).n, 0); // no kept answers: nothing to grade
});
test("grade-pack merge: unblinds, validates 1-5 integers, applies the decision rule", () => {
  const r = bp({ corpus: pairs(40, { fictional: true }), results: workerResults(40, true), grader: "claude", seed: 1 });
  const key = r.keyText.trim().split("\n").map((l) => JSON.parse(l));
  const g = (t, h, gr) => ({ tone: t, helpfulness: h, groundedness: gr });
  const grades = key.map((k) => ({ packet_id: k.packet_id, [k.A === "worker" ? "A" : "B"]: g(4, 4, 5), [k.A === "worker" ? "B" : "A"]: g(4, 4, 4) }));
  const m = mergeGrades({ key, grades });
  assert.equal(m.merged.length, 40); assert.deepEqual(m.merged[0].worker, g(4, 4, 5)); assert.deepEqual(m.merged[0].local, g(4, 4, 4));
  assert.equal(m.verdict.pass, true);
  const bad = mergeGrades({ key, grades: [{ ...grades[0], A: g(6, 1, 1) }, { ...grades[1], B: { tone: 3.5, helpfulness: 3, groundedness: 3 } }, { packet_id: "nope", A: g(1, 1, 1), B: g(1, 1, 1) }, grades[2], grades[2]] });
  assert.equal(bad.merged.length, 1); assert.equal(bad.invalid, 3); assert.equal(bad.unknown, 1); assert.equal(bad.missing, 39);
  const worse = mergeGrades({ key, grades: key.map((k) => ({ packet_id: k.packet_id, [k.A === "worker" ? "A" : "B"]: g(2, 2, 2), [k.A === "worker" ? "B" : "A"]: g(4, 4, 4) })) });
  assert.equal(worse.verdict.pass, false); assert.ok(worse.verdict.failures.length >= 3);
  assert.equal(evaluatePairRule(m.merged.slice(0, 10)).pass, false); // under the sample size
});
test("grade-pack CLI: writes the packet and a separate key file outside the repo; a private corpus with --grader external exits non-zero and writes nothing", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "c.jsonl"), pairs(3).map((x) => JSON.stringify(x)).join("\n") + "\n");
  writeFileSync(join(dir, "r.jsonl"), workerResults(3, false, sha256(readFileSync(join(dir, "c.jsonl")))).map((x) => JSON.stringify(x)).join("\n") + "\n");
  const outp = join(dir, "packet.jsonl");
  let r = await runCli("grade-pack.mjs", ["build", "--corpus", join(dir, "c.jsonl"), "--results", join(dir, "r.jsonl"), "--grader", "external", "--out", outp]);
  assert.notEqual(r.code, 0); assert.match(r.err, /private/); assert.equal(existsSync(outp), false); assert.equal(existsSync(outp + ".key.jsonl"), false);
  r = await runCli("grade-pack.mjs", ["build", "--corpus", join(dir, "c.jsonl"), "--results", join(dir, "r.jsonl"), "--grader", "claude", "--out", outp, "--seed", "2"]);
  assert.equal(r.code, 0, r.err); assert.ok(existsSync(outp) && existsSync(outp + ".key.jsonl"));
  assert.ok(!readFileSync(outp, "utf8").includes('"worker"')); assert.match(readFileSync(outp, "utf8"), /"private":true/);
  assert.ok(!r.out.includes("LOCAL-") && !r.out.includes("WORKER-") && !r.out.includes("Q0"));
  rmSync(dir, { recursive: true, force: true });
});

// ================= review round: binding, guard, hosts, vocabulary, lock, resume, negation, manifest =================
import { linkSync, symlinkSync } from "node:fs";
import { isInside, writeOut, withLock } from "../../tools/replay/common.mjs";
import { scoreTruthItem } from "../../tools/replay/score.mjs";
import { safeStatus, safeKind, safeModel, safeReason, DEFAULT_HOSTS } from "../../tools/replay/run.mjs";

const resultsOf = (p) => resultRows(p);
function writeInput(dir, recs) { const f = join(dir, "in.jsonl"); writeFileSync(f, recs.map((r) => JSON.stringify(r)).join("\n") + "\n"); return f; }
const rec1 = (i, extra = {}) => ({ id: `r${i}`, question: `Fictional question ${i}?`, ...extra });
const okReply = (o = {}) => ({ json: { id: "i", ok: true, status: "answered", model: "m", latency_ms: 10, reason: "ok", answer: "fine", ...o } });

test("guard: separator boundary (a child named ..replay is inside), hard links refused, exclusive create, symlink into the root resolved", () => {
  const fake = tmp(); const root = join(fake, "repo"); mkdirSync(root);
  assert.equal(isInside(root, join(root, "..replay", "x")), true, "a child named ..replay must count as inside");
  assert.equal(isInside(root, join(root, "..", "x")), false);
  assert.equal(isInside(root, join(root, "..")), false);
  assert.equal(isInside(root, root), true);
  assert.throws(() => assertOutsideRepo(join(root, "..replay", "a.jsonl"), root), /inside the repo/);
  assert.doesNotThrow(() => assertOutsideRepo(join(fake, "elsewhere", "a.jsonl"), root));
  // hard link: a second name outside the root for a file inside it
  writeFileSync(join(root, "tracked.txt"), "x");
  linkSync(join(root, "tracked.txt"), join(fake, "alias.txt"));
  assert.throws(() => assertOutsideRepo(join(fake, "alias.txt"), root), /hard-linked/);
  // exclusive create: an existing file is never overwritten
  writeFileSync(join(fake, "exists.jsonl"), "keep");
  assert.throws(() => writeOut(join(fake, "exists.jsonl"), "new", root), /overwrite/);
  assert.equal(readFileSync(join(fake, "exists.jsonl"), "utf8"), "keep");
  writeOut(join(fake, "fresh.jsonl"), "ok", root); assert.equal(readFileSync(join(fake, "fresh.jsonl"), "utf8"), "ok");
  try { symlinkSync(root, join(fake, "link"), "junction"); assert.throws(() => assertOutsideRepo(join(fake, "link", "a.jsonl"), root), /inside the repo/); } catch (e) { if (e.code !== "EPERM" && e.code !== "EEXIST" && !/inside/.test(String(e.message))) throw e; }
  rmSync(fake, { recursive: true, force: true });
});

test("base host: only api.leeroy.party, localhost and 127.0.0.1 by default; anything else needs --allow-host; the host is printed before sending", async () => {
  assert.deepEqual([...DEFAULT_HOSTS], ["api.leeroy.party", "localhost", "127.0.0.1"]);
  assert.doesNotThrow(() => checkBase("https://api.leeroy.party"));
  assert.throws(() => checkBase("https://staging.leeroy.party"), /--allow-host staging\.leeroy\.party/);
  assert.throws(() => checkBase("https://api.leeroy.party.evil.example"), /not allowed/);
  assert.doesNotThrow(() => checkBase("https://staging.leeroy.party", ["staging.leeroy.party"]));
  assert.throws(() => checkBase("http://staging.leeroy.party", ["staging.leeroy.party"]), /https/); // the allow flag never relaxes https
  const dir = tmp(); writeFileSync(join(dir, "token"), TOKEN);
  const s = await stub(() => okReply());
  const logs = [];
  await runReplay({ tokenFile: join(dir, "token"), input: writeInput(dir, [rec1(1)]), outPath: join(dir, "o.jsonl"), maxItems: 1, delayMs: 0, base: s.base + "/some/secret/path?x=1", log: (m) => logs.push(m) }, instant);
  assert.ok(logs.some((l) => l === `sending to host 127.0.0.1:${new URL(s.base).port}`), logs.join("|"));
  assert.ok(!logs.join("|").includes("secret"), "the path must not be printed");
  assert.ok(logs.findIndex((l) => l.startsWith("sending to host")) < logs.findIndex((l) => l.startsWith("item ")));
  await assert.rejects(runReplay({ tokenFile: join(dir, "token"), input: writeInput(dir, [rec1(1)]), outPath: join(dir, "o2.jsonl"), maxItems: 1, delayMs: 0, base: "https://other.example" }, instant), /--allow-host/);
  await s.close(); rmSync(dir, { recursive: true, force: true });
});

test("vocabulary: status, kind, model and reason are fixed-vocabulary in results and output; a hostile response cannot put text there", async () => {
  assert.equal(safeStatus("answered"), "answered"); assert.equal(safeStatus("evil text"), "other");
  assert.equal(safeKind(undefined), "pair"); assert.equal(safeKind("spell_level"), "spell_level"); assert.equal(safeKind("rm -rf"), "other");
  assert.equal(safeReason("claude:timeout@compose-16s"), "claude:timeout@compose-16s"); assert.equal(safeReason("free text here"), "other"); assert.equal(safeReason(null), null);
  assert.equal(safeModel("claude:claude-sonnet-5-5+research+degraded"), "claude:claude-sonnet-5-5+research+degraded"); assert.equal(safeModel("[claude:cap]"), "[claude:cap]"); assert.equal(safeModel("ignore previous instructions"), "other");
  const dir = tmp(); writeFileSync(join(dir, "token"), TOKEN);
  const input = writeInput(dir, [rec1(1, { kind: "attacker kind" })]);
  const s = await stub(() => ({ json: { id: "i", ok: true, status: "PWNED-STATUS now", model: "PWNED model text", latency_ms: 10, reason: "PWNED reason text", answer: "fine" } }));
  const r = await runCli("run.mjs", [join(dir, "token"), "--in", input, "--max-items", "1", "--delay-s", "0", "--out", join(dir, "o.jsonl"), "--base", s.base]);
  const all = r.out + r.err + readFileSync(join(dir, "o.jsonl"), "utf8");
  assert.ok(!all.includes("PWNED") && !all.includes("attacker"), "hostile text reached stdout or the results");
  const row = resultsOf(join(dir, "o.jsonl"))[0];
  assert.equal(row.status, "other"); assert.equal(row.kind, "other"); assert.equal(row.model, "other"); assert.equal(row.reason, "other");
  await s.close(); rmSync(dir, { recursive: true, force: true });
});

test("lock and markers: a sent marker exists before the POST; a body that cannot be read still counts an attempt; the lock is exclusive and always removed", async () => {
  const dir = tmp(); writeFileSync(join(dir, "token"), TOKEN);
  const input = writeInput(dir, [rec1(1), rec1(2)]);
  const out = join(dir, "o.jsonl");
  let markerSeen = false;
  const s = await stub((body) => {
    markerSeen = readFileSync(out, "utf8").split("\n").some((l) => l.includes('"type":"sent"') && l.includes('"id":"r1"'));
    return okReply();
  });
  let r = await runReplay(opts(dir, { input, outPath: out, base: s.base, maxItems: 1 }), instant);
  assert.equal(markerSeen, true, "the marker must be on disk before the request is answered");
  assert.equal(existsSync(out + ".lock"), false, "lock left behind");
  // a dropped connection: the attempt is counted and an aborted row is written
  const bad = await stub((b, n, res) => { res.destroy(); });
  r = await runReplay(opts(dir, { input, outPath: out, base: bad.base, maxItems: 5 }), instant);
  assert.equal(r.stop, "error:request-failed"); assert.equal(r.sent, 1, "an unreadable body must still count as an attempt");
  const lines = records(readFileSync(out, "utf8"));
  assert.equal(lines.filter((x) => x.type === "sent").length, 2); assert.equal(lines.filter((x) => x.type === "aborted").length, 1);
  assert.equal(existsSync(out + ".lock"), false, "lock left behind after a failure");
  // the aborted item is retried on resume and the failed attempt still counts in the rate windows
  r = await runReplay(opts(dir, { input, outPath: out, base: s.base, maxItems: 5 }), instant);
  assert.equal(r.sent, 1); assert.equal(r.unresolved, 1);
  assert.deepEqual(resultsOf(out).map((x) => x.id), ["r1", "r2"]);
  // exclusive lock
  writeFileSync(out + ".lock", "123");
  await assert.rejects(runReplay(opts(dir, { input, outPath: out, base: s.base }), instant), /locked/);
  assert.equal(existsSync(out + ".lock"), true, "a lock that is not ours must not be removed");
  rmSync(out + ".lock");
  await assert.rejects(withLock(join(dir, "x.jsonl"), async () => { await assert.rejects(withLock(join(dir, "x.jsonl"), async () => {}), /locked/); throw new Error("boom"); }), /boom/);
  assert.equal(existsSync(join(dir, "x.jsonl.lock")), false);
  await s.close(); await bad.close(); rmSync(dir, { recursive: true, force: true });
});

test("resume: the results header binds the input hash; a different input, a missing header, or duplicate ids refuse", async () => {
  const dir = tmp(); writeFileSync(join(dir, "token"), TOKEN);
  const s = await stub(() => okReply());
  const out = join(dir, "o.jsonl");
  const inputA = writeInput(dir, [rec1(1), rec1(2), rec1(3)]);
  await runReplay(opts(dir, { input: inputA, outPath: out, base: s.base, maxItems: 1 }), instant);
  const inputB = join(dir, "b.jsonl"); writeFileSync(inputB, [rec1(1), rec1(2), rec1(3, { question: "changed text" })].map((r) => JSON.stringify(r)).join("\n") + "\n");
  await assert.rejects(runReplay(opts(dir, { input: inputB, outPath: out, base: s.base }), instant), /different input/);
  assert.equal(s.seen.length, 1, "nothing may be sent for a refused resume");
  await runReplay(opts(dir, { input: inputA, outPath: out, base: s.base, maxItems: 1 }), instant); // same input resumes
  assert.equal(s.seen.length, 2);
  const noHeader = join(dir, "nh.jsonl"); writeFileSync(noHeader, JSON.stringify({ id: "r1", ok: true }) + "\n");
  await assert.rejects(runReplay(opts(dir, { input: inputA, outPath: noHeader, base: s.base }), instant), /no header/);
  const dupIn = join(dir, "dup.jsonl"); writeFileSync(dupIn, [rec1(1), rec1(1)].map((r) => JSON.stringify(r)).join("\n") + "\n");
  await assert.rejects(runReplay(opts(dir, { input: dupIn, outPath: join(dir, "d.jsonl"), base: s.base }), instant), /duplicate id/);
  const lines = readFileSync(out, "utf8").split("\n").filter(Boolean);
  const dupRes = join(dir, "dr.jsonl"); writeFileSync(dupRes, [lines[0], ...lines.filter((l) => !l.includes('"type"')), ...lines.filter((l) => !l.includes('"type"'))].join("\n") + "\n");
  await assert.rejects(runReplay(opts(dir, { input: inputA, outPath: dupRes, base: s.base }), instant), /duplicate id/);
  assert.equal(s.seen.length, 2);
  await s.close(); rmSync(dir, { recursive: true, force: true });
});

test("score: negated statements are not exact; a degraded response is never exact", () => {
  const L = { value: 20, unit: "level" };
  for (const t of ["It is not level 20.", "That isn't level 20", "The spell is no longer level 20", "It is not 20", "Never level 20", "it's not at level 20"]) assert.equal(exact_match(t, L), false, t);
  for (const t of ["It's not level 30, it is level 20.", "Not sure, but level 20.", "It is level 20, not 30"]) assert.equal(exact_match(t, L), true, t);
  assert.equal(exact_match("It is not level 20, it is level 30.", L), false);
  assert.equal(contradiction("It is level 20, not level 30.", L, "q"), false); // a negated different number is not a claim
  const rec = { question: "What level is Zorbo?", expected: L, allowed_numbers: [20] };
  assert.equal(scoreTruthItem(rec, { reason: "ok", model: "m", status: "answered" }, "Level 20.").exact, true);
  assert.equal(scoreTruthItem(rec, { reason: "claude:cap", model: "m+degraded", status: "degraded" }, "Level 20.").exact, false);
  assert.equal(scoreTruthItem(rec, { reason: "ok", model: "m+degraded", status: "answered" }, "Level 20.").exact, false);
});
test("score: contradiction is checked per clause", () => {
  const L = { value: 20, unit: "level" };
  assert.equal(contradiction("It is level 30 until the next update, then level 20.", L, "q"), true);
  assert.equal(exact_match("It is level 30 until the next update, then level 20.", L), true); // the number is there; exact is cut by the contradiction, not by exact_match
  assert.equal(scoreTruthItem({ question: "q", expected: L, allowed_numbers: [] }, { reason: "ok", model: "m", status: "answered" }, "It is level 30 until the next update, then level 20.").exact, false);
  assert.equal(contradiction("Level 20; at level 40 you also get a mount", L, "q"), true);
  assert.equal(contradiction("Level 20, and the max level is 60", L, "q"), false);
  assert.equal(contradiction("Rank 2 is the one you want, and it is level 30.", L, "q"), true); // the rank word must not hide the other clause
  assert.equal(contradiction("Level 20 but rank 2 needs level 30", L, "q"), false);
  assert.equal(contradiction("Level 20 for 1,200 gold", L, "q"), false);
});

test("manifest rows: a physical-line count is accepted only when a quoted field really spans lines; the manifest itself can be pinned", () => {
  const d = tmp();
  const multi = 'ID,Name_lang\n1,"two\nlines"\n2,plain\n';
  writeFileSync(join(d, "m.csv"), multi);
  const entry = (text, rows) => ({ sha256: sha256(Buffer.from(text)), bytes: Buffer.byteLength(text), rows });
  assert.equal(loadVerifiedTable(d, { files: { "m.csv": entry(multi, 2) } }, "m.csv").rows.length, 2); // record count
  assert.equal(loadVerifiedTable(d, { files: { "m.csv": entry(multi, 3) } }, "m.csv").rows.length, 2); // physical lines, and the table has a multi-line field
  const plain = "ID,Name_lang\n1,a\n2,b\n";
  writeFileSync(join(d, "p.csv"), plain);
  assert.throws(() => loadVerifiedTable(d, { files: { "p.csv": entry(plain, 3) } }, "p.csv"), /row count/); // 3 is neither the records nor a multi-line table
  assert.equal(loadVerifiedTable(d, { files: { "p.csv": entry(plain, 2) } }, "p.csv").rows.length, 2);
  const blank = "ID,Name_lang\n1,a\n\n2,b\n"; // a blank line: 3 physical lines, 2 records, no multi-line field
  writeFileSync(join(d, "b.csv"), blank);
  assert.throws(() => loadVerifiedTable(d, { files: { "b.csv": entry(blank, 3) } }, "b.csv"), /row count/);
  rmSync(d, { recursive: true, force: true });
  const f = fixtureDir();
  const manifestHash = sha256(readFileSync(join(f, "MANIFEST.json")));
  const pinned = generate({ dir: f, seed: 1, perKind: 3, manifestSha256: manifestHash });
  assert.equal(pinned.header.manifest_sha256, manifestHash); assert.equal(pinned.header.manifest_pinned, true);
  assert.equal(generate({ dir: f, seed: 1, perKind: 3 }).header.manifest_pinned, false);
  assert.throws(() => generate({ dir: f, manifestSha256: "0".repeat(64) }), /MANIFEST\.json sha256/);
  writeFileSync(join(f, "MANIFEST.json"), readFileSync(join(f, "MANIFEST.json"), "utf8").replace("0.0.0.FAKE", "9.9.9.EDITED"));
  assert.throws(() => generate({ dir: f, manifestSha256: manifestHash }), /MANIFEST\.json sha256/); // an edited manifest no longer matches the pin
  rmSync(f, { recursive: true, force: true });
});

test("grade-pack binding: results must come from this corpus file and these questions; private:false needs corpus AND results flagged fictional", () => {
  const corpus = pairs(5, { fictional: true });
  assert.throws(() => buildPackets({ corpus, corpusSha256: SHA, results: workerResults(5, true, "a".repeat(64)), grader: "claude" }), /not produced from this corpus file/);
  assert.throws(() => buildPackets({ corpus, corpusSha256: SHA, results: workerResults(5, true).slice(1), grader: "claude" }), /not produced from this corpus file/); // no header
  const swapped = pairs(5, { fictional: true }).map((r, i) => (i === 2 ? { ...r, question: "A different question than the one that was run?" } : r));
  assert.throws(() => bp({ corpus: swapped, results: workerResults(5, true), grader: "claude" }), /question text/);
  const tampered = workerResults(5, true); tampered[3] = { ...tampered[3], question_sha256: "0".repeat(64) };
  assert.throws(() => bp({ corpus, results: tampered, grader: "claude" }), /question text/);
  assert.throws(() => bp({ corpus, results: [...workerResults(5, true), { id: "c1", answer: "x", question_sha256: sha256("Q1?"), fictional: true }], grader: "claude" }), /duplicate id/);
  assert.throws(() => bp({ corpus: [...corpus, corpus[0]], results: workerResults(5, true), grader: "claude" }), /duplicate id/);
  // fictional corpus but one non-fictional results row: private, external refused
  const mixed = workerResults(5, true); mixed[2] = { ...mixed[2], fictional: false };
  assert.throws(() => bp({ corpus, results: mixed, grader: "external" }), /private/);
  assert.equal(bp({ corpus, results: mixed, grader: "claude" }).header.private, true);
  // fictional results but one non-fictional corpus record
  const corpus2 = pairs(5, { fictional: true }); corpus2[1] = { ...corpus2[1], fictional: false };
  assert.throws(() => bp({ corpus: corpus2, results: workerResults(5, true), grader: "external" }), /private/);
  assert.equal(bp({ corpus, results: workerResults(5, true), grader: "external" }).header.private, false);
});
