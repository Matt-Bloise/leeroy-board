// Loads game facts from the PC into the Worker's D1 store: begin / rows / finish against POST /api/facts/load. docs/runbooks/game-facts.md.
//   node tools/facts-load.mjs --tables <dir> [--traits <traits.json>] [--facts <facts.jsonl>] [--client-facts <client-facts.jsonl>]            (dry run: the default; sends nothing, prints counts)
//   node tools/facts-load.mjs <token-file> --tables <dir> ... --apply [--base https://api.leeroy.party] [--allow-host <host>] [--state <file>] [--max-calls 100] [--scope client|curated|both]
// --tables: the client DB2 CSV export folder with MANIFEST.json {build, files:{name:{sha256,bytes,rows}}}. Every table used is checked against it first (sha256, bytes, rows; the replay harness's common.mjs does it); a mismatch refuses the run.
// Client facts (plus, for player-facing spells whose name is shared, one row per spell id and rank: deriveRankRows): the SAME kinds and uniqueness rules as tools/replay/truth-gen.mjs (its buildCandidates is imported, not copied) for spell_level, item_level_req, spell_cooldown, spell_cast_time, spell_mana_cost, plus the trait kinds
// from --traits (truth-gen's buildTraitCandidates; see deriveTraitRows). Curated facts: --facts (cid, claim, value, verdict, source_class, build, next_step) and --client-facts (cids, claim, value, verdict, ...), kind 'curated'.
// NOTHING from the tables or the facts files is written anywhere but the signed request body: no output file, nothing in the repo. The tool prints counts only, never a row's text.
// <token-file>: a file holding the Discord bot token. It is read, used to derive the FACTS-LOAD signing key (HMAC-SHA256 of the token with the label "leeroy-facts-load-v1") and never printed. Owner's machine only.
// --base: https only (http only for localhost, 127.0.0.1 or [::1]); no credentials in the URL; only api.leeroy.party or a local host unless --allow-host names the host; redirects are refused (a redirect would replay the signed body elsewhere).
// Resume: one state file for the run (per scope: load id, batches sent, finished) is kept in --state (default: the OS temp folder, outside the repo). Run the same command again after a failure: it skips begin and continues. Batches are idempotent on the Worker.
// The Worker needs each signed timestamp strictly newer than the last accepted one (whole seconds), so calls are at least one second apart; it allows 120 accepted calls an hour, and this tool stops after --max-calls (default 100) and says so.
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { factsLoadKey, signListen } from "../infrastructure/worker/listener-config.js";
import { validateRow, FACT_SOURCE_CLASSES, FACT_VERDICTS, FACT_KINDS, FACTS_MAX_ROWS, FACTS_PURPOSE, MAX } from "../infrastructure/worker/game-facts.js";
import { normName, baseName } from "../infrastructure/worker/game-facts-name.js";
import { buildCandidates, buildTraitCandidates, TRAIT_KINDS, NAME_OK } from "./replay/truth-gen.mjs";
import { sha256, assertOutsideRepo, readJsonl, loadVerifiedTable } from "./replay/common.mjs";

export const DEFAULT_BASE = "https://api.leeroy.party";
export const DEFAULT_ALLOWED_HOSTS = Object.freeze(["api.leeroy.party", "localhost", "127.0.0.1", "[::1]"]);
export const MAX_BODY_BYTES = 200 * 1024; // the Worker refuses 256 KB; stay well under
// D1 Free allows 100,000 ROWS WRITTEN a day (an index entry counts as a row). The tool counts its own writes from the accepted counts with these constants, measured on the preview D1 by
// tools/d1-facts-smoke.mjs (the step summary of the PR preview run prints the measured values; tests/unit/game-facts.test.mjs pins that the smoke and this tool use the same numbers).
export const WRITES_PER_FACT = 2; // the table row (WITHOUT ROWID: the primary key is the table) + idx_game_facts_kind_subject; a rank-suffixed name pays one more for the partial base index (counted by the rate below)
export const WRITES_PER_SUFFIXED_FACT = 1;
export const WRITES_PER_CALL = 3; // the rate-limit state row (kv_state) and the load row's counters, per signed call
export const WRITES_PER_RETIRED_FACT = 1; // finish: superseded = 1 on a retired row (not in an index)
export const DEFAULT_ROW_BUDGET = 60000; // rows written per run; the Free daily limit is 100,000
// Load order: curated first (its own load), then within the client load traits, spells, and item_level_req LAST (13,000+ of the 18,000+ facts, the part that can be chunked over days).
export const KIND_ORDER = Object.freeze(["curated", "trait_max_ranks", "trait_points_required", "trait_prereq", "spell_level", "spell_cooldown", "spell_cast_time", "spell_mana_cost", "item_level_req"]);
const baseNameOf = (subject) => baseName(normName(subject));
export const writeCost = (nFacts, nSuffixed = 0, nCalls = 1) => Math.ceil(nFacts * WRITES_PER_FACT + nSuffixed * WRITES_PER_SUFFIXED_FACT + nCalls * WRITES_PER_CALL);
const CLEAN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const clean = (s) => String(s == null ? "" : s).replace(CLEAN, " ").replace(/\s+/g, " ").trim();
const cut = (s, max) => Array.from(s).slice(0, max).join("");
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

// ---- client facts --------------------------------------------------------------------------------------------------------------------------------
const CLAIM = {
  spell_level: (n, v) => `${n} requires level ${v}.`,
  item_level_req: (n, v) => `${n} has a required level of ${v}.`,
  spell_cooldown: (n, v) => `${n} has a cooldown of ${v} seconds.`,
  spell_cast_time: (n, v) => `${n} has a cast time of ${v} seconds.`,
  spell_mana_cost: (n, v) => `${n} costs ${v} mana.`,
};
// Which of a candidate's {table, id} refs is the fact's own row (the first is spellname for the spell kinds).
const OWN_REF = { spell_level: 1, item_level_req: 0, spell_cooldown: 1, spell_cast_time: 1, spell_mana_cost: 1 };

// -> { rows, skipped: {reason: n}, used: {fileName: {sha256, bytes, rows}} }. Verifies every table it reads against the manifest (buildCandidates -> loadVerifiedTable) before parsing.
export function deriveTableRows(dir, manifest) {
  const { out, used } = buildCandidates(dir, manifest);
  const build = manifest.build;
  const rows = [];
  for (const kind of Object.keys(CLAIM)) {
    for (const rec of out[kind]) {
      const ref = rec.rows[OWN_REF[kind]];
      rows.push({ id: `${ref.table}:${ref.id}`, kind, subject: rec.entity_name, claim: CLAIM[kind](rec.entity_name, rec.expected.value), value: String(rec.expected.value), unit: rec.expected.unit, source_table: ref.table, row_id: String(ref.id), build, verdict: "holds", source_class: "client-db2", note: "" });
    }
  }
  const ranked = deriveRankRows(dir, manifest);
  rows.push(...ranked.rows);
  Object.assign(used, ranked.used);
  const files = {};
  for (const n of Object.keys(used).sort()) files[n] = { sha256: manifest.files[n].sha256, bytes: manifest.files[n].bytes, rows: manifest.files[n].rows };
  return { rows, files, rankIds: new Set(ranked.rows.map((r) => r.id)) };
}

// ---- player-facing spells whose NAME is shared (ranks, or unrelated spells with one name) -----------------------------------------------------------------
// The unique-name rules above leave out every spell whose name occurs in more than one spellname row, which is every spell that has ranks. deriveRankRows covers exactly those spells and only the player-facing ones:
//   player-facing = the spell has exactly one spelllevels row with BaseLevel > 0 (the client's learn-level of a class spell; the column and rule of spell_level) and a well-formed name (truth-gen's NAME_OK).
//   The PARTITION with the legacy rules is by name: a spell whose name is unique in spellname.Name_lang is produced by buildCandidates (unchanged ids, claims and values); a spell whose name is shared is produced here. No spell is in both.
//   Each spell is its own fact row per kind, id = <own table>:<that table's row id>, the legacy convention (spelllevels:<spelllevels.ID>). It is NOT the SpellID: in the real export spelllevels.ID differs from SpellID on every row,
//   so a SpellID-keyed id would collide in name with the legacy ids of other spells. Each spell has exactly one spelllevels row, so the id is unique per spell.
//   The per-kind rules are truth-gen's (spell_cooldown: one spellcooldowns row, RecoveryTime a whole number of seconds, no category or start cooldown; spell_cast_time: one spellmisc row, spellcasttimes.Base > 0 in 100 ms steps;
//   spell_mana_cost: one spellpower row, PowerType 0, no per-level, percent or optional cost) minus the name-uniqueness test. tests/unit/game-facts.test.mjs pins that both paths agree on a unique name.
//   Rank: spell.NameSubtext_lang 'Rank <n>' (the rank line of the spellbook). spellname has only Name_lang. Any other subtext (a title, 'Passive', empty) is no rank.
//   Class hint: spellclassoptions.SpellClassSet (one row per spell) matched to chrclasses.SpellClassSet (a non-zero set held by exactly one class) gives chrclasses.Name_lang. Not every spell has one.
//   Both go into `note` as 'rank=4;class=Mage' (machine readable, no schema change); the rank is also in the claim: 'Fireball (Rank 4) requires level 18.'
const RANK_RE = /^Rank ([0-9]{1,3})$/;
export const rankNote = (rank, cls) => [rank ? `rank=${rank}` : "", cls ? `class=${cls}` : ""].filter(Boolean).join(";");
export function deriveRankRows(dir, manifest, { includeUnique = false } = {}) {
  const load = (n) => loadVerifiedTable(dir, manifest, n);
  const spellname = load("spellname.csv"), spell = load("spell.csv"), levels = load("spelllevels.csv"), sco = load("spellclassoptions.csv"), cls = load("chrclasses.csv");
  const cd = load("spellcooldowns.csv"), misc = load("spellmisc.csv"), casts = load("spellcasttimes.csv"), power = load("spellpower.csv");
  const used = { "spellname.csv": spellname, "spell.csv": spell, "spelllevels.csv": levels, "spellclassoptions.csv": sco, "chrclasses.csv": cls, "spellcooldowns.csv": cd, "spellmisc.csv": misc, "spellcasttimes.csv": casts, "spellpower.csv": power };
  const num = (v) => (v !== "" && v !== undefined && Number.isFinite(Number(v)) ? Number(v) : null);
  const countBy = (rs, i) => rs.reduce((m, r) => m.set(r[i], (m.get(r[i]) || 0) + 1), new Map());
  const lc = (s) => s.toLowerCase();
  const sn = { id: spellname.col("ID"), name: spellname.col("Name_lang") };
  const nameCount = new Map(), idCount = countBy(spellname.rows, sn.id);
  for (const r of spellname.rows) nameCount.set(lc(r[sn.name]), (nameCount.get(lc(r[sn.name])) || 0) + 1);
  const nameOf = new Map(spellname.rows.filter((r) => idCount.get(r[sn.id]) === 1).map((r) => [r[sn.id], r[sn.name]]));
  const subId = spell.col("ID"), subCol = spell.col("NameSubtext_lang");
  const spellCount = countBy(spell.rows, subId);
  const rankOf = new Map();
  for (const r of spell.rows) { const m = RANK_RE.exec(r[subCol]); if (m && spellCount.get(r[subId]) === 1) rankOf.set(r[subId], Number(m[1])); }
  const setToClass = new Map(); // SpellClassSet -> class name, only when exactly one class holds the (non-zero) set
  const ccSet = cls.col("SpellClassSet"), ccName = cls.col("Name_lang"), ccSetCount = countBy(cls.rows, ccSet);
  for (const r of cls.rows) { const s = num(r[ccSet]); if (s !== null && s > 0 && ccSetCount.get(r[ccSet]) === 1 && /^[\p{L} '-]{2,30}$/u.test(r[ccName])) setToClass.set(r[ccSet], r[ccName]); }
  const scoSpell = sco.col("SpellID"), scoSet = sco.col("SpellClassSet"), scoCount = countBy(sco.rows, scoSpell);
  const classOf = new Map();
  for (const r of sco.rows) if (scoCount.get(r[scoSpell]) === 1 && setToClass.has(r[scoSet])) classOf.set(r[scoSpell], setToClass.get(r[scoSet]));

  const lvSpell = levels.col("SpellID"), lvBase = levels.col("BaseLevel"), lvId = levels.col("ID");
  const lvCount = countBy(levels.rows, lvSpell);
  const player = new Map(); // SpellID -> { name, levelRow }
  for (const r of levels.rows) {
    const id = r[lvSpell], nm = nameOf.get(id), b = num(r[lvBase]);
    if (!nm || !NAME_OK(nm) || lvCount.get(id) !== 1 || b === null || b <= 0) continue;
    if (!includeUnique && nameCount.get(lc(nm)) === 1) continue; // unique names belong to the legacy rules
    player.set(id, { name: nm, levelRow: r });
  }
  const rows = [];
  const push = (kind, spellId, ownTable, ownId, value, unit) => {
    const sp = player.get(spellId);
    const rank = rankOf.get(spellId) || 0;
    const label = rank ? `${sp.name} (Rank ${rank})` : sp.name;
    rows.push({ id: `${ownTable}:${ownId}`, kind, subject: sp.name, claim: CLAIM[kind](label, value), value: String(value), unit, source_table: ownTable, row_id: String(ownId), build: manifest.build, verdict: "holds", source_class: "client-db2", note: rankNote(rank, classOf.get(spellId)) });
  };
  for (const [id, sp] of player) push("spell_level", id, "spelllevels", sp.levelRow[lvId], num(sp.levelRow[lvBase]), "level");
  { // spell_cooldown
    const iS = cd.col("SpellID"), iRec = cd.col("RecoveryTime"), iCat = cd.col("CategoryRecoveryTime"), iSt = cd.col("StartRecoveryTime"), iId = cd.col("ID");
    const per = countBy(cd.rows, iS);
    for (const r of cd.rows) {
      if (!player.has(r[iS]) || per.get(r[iS]) !== 1) continue;
      const ms = num(r[iRec]);
      if (ms === null || ms <= 0 || ms % 1000 !== 0 || num(r[iCat]) !== 0 || num(r[iSt]) !== 0) continue;
      push("spell_cooldown", r[iS], "spellcooldowns", r[iId], ms / 1000, "seconds");
    }
  }
  { // spell_cast_time
    const iS = misc.col("SpellID"), iIdx = misc.col("CastingTimeIndex"), iId = misc.col("ID");
    const per = countBy(misc.rows, iS), cIdCount = countBy(casts.rows, casts.col("ID"));
    const cById = new Map(casts.rows.map((r) => [r[casts.col("ID")], r]));
    for (const r of misc.rows) {
      if (!player.has(r[iS]) || per.get(r[iS]) !== 1) continue;
      const cr = cById.get(r[iIdx]);
      if (!cr || cIdCount.get(r[iIdx]) !== 1) continue;
      const ms = num(cr[casts.col("Base")]);
      if (ms === null || ms <= 0 || ms % 100 !== 0) continue;
      push("spell_cast_time", r[iS], "spellmisc", r[iId], ms / 1000, "seconds");
    }
  }
  { // spell_mana_cost
    const iS = power.col("SpellID"), iCost = power.col("ManaCost"), iType = power.col("PowerType"), iPer = power.col("ManaCostPerLevel"), iPct = power.col("PowerCostPct"), iOpt = power.col("OptionalCost"), iId = power.col("ID");
    const per = countBy(power.rows, iS);
    for (const r of power.rows) {
      if (!player.has(r[iS]) || per.get(r[iS]) !== 1) continue;
      const v = num(r[iCost]);
      if (v === null || v <= 0 || num(r[iType]) !== 0 || num(r[iPer]) !== 0 || num(r[iPct]) !== 0 || num(r[iOpt]) !== 0) continue;
      push("spell_mana_cost", r[iS], "spellpower", r[iId], v, "mana");
    }
  }
  return { rows, used };
}

// The trait kinds come from truth-gen's buildTraitCandidates (the same eligibility rules as the replay harness: a node counts only if its nodeId occurs once in its tree, its name is well formed and unique in the tree and
// maxRanks is a positive integer; points_required needs exactly one cond; prereq needs exactly one distinct entry in the node's own requires, itself eligible, neither name containing the other), turned into claim rows.
const TRAIT_CLAIM = {
  trait_max_ranks: (r) => `${r.entity_name} is a ${r.class_name} talent with ${plural(r.expected.value, "rank")}.`,
  trait_points_required: (r) => `${r.entity_name} (${r.class_name} talent) needs ${plural(r.expected.value, "point")} spent in its tree before it can be learned.`,
  trait_prereq: (r) => `${r.entity_name} (${r.class_name} talent) has ${r.expected.value} as its prerequisite talent.`,
};
export function deriveTraitRows(traits, build) {
  const { out, used } = buildTraitCandidates(traits);
  const rows = [];
  for (const kind of TRAIT_KINDS) {
    for (const r of out[kind]) {
      rows.push({ id: `${kind}:${r.rows[0].id}-${r.rows[1].id}`, kind, subject: r.entity_name, claim: TRAIT_CLAIM[kind](r), value: String(r.expected.value), unit: kind === "trait_max_ranks" ? "ranks" : kind === "trait_points_required" ? "points" : "", source_table: "traitnode", row_id: String(r.rows[1].id), build, verdict: "holds", source_class: "client-db2", note: "" });
    }
  }
  return { rows, treesUsed: used };
}

// ---- curated facts -------------------------------------------------------------------------------------------------------------------------------
const BUILD_OK = /^[0-9.]{3,32}$/;
// A free-text build ("web notes as of 2026-11-19") becomes the date as 2026.11.19; anything else takes the load's build. -> {build, fallback}
export function curatedBuild(b, loadBuild) {
  const s = clean(b);
  if (BUILD_OK.test(s)) return { build: s, fallback: false };
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return { build: `${m[1]}.${m[2]}.${m[3]}`, fallback: false };
  return { build: loadBuild, fallback: true };
}
// One curated line -> a row, or null with a reason. A value longer than the Worker's 80 characters moves into the claim (the claim then carries it) when that fits, otherwise the line is skipped, never cut.
export function curatedRow(o, id, loadBuild, extra = {}) {
  let claim = clean(o.claim), value = clean(o.value);
  if (!claim) return { skip: "no_claim" };
  const subject = cut(claim, 80).trim(); // the claim's head: every curated fact has a real subject, so no two collapse
  if (Array.from(value).length > MAX.value) {
    const joined = `${claim} (${value})`;
    if (Array.from(joined).length > MAX.claim) return { skip: "too_long" };
    claim = joined; value = "";
  }
  const b = curatedBuild(o.build, loadBuild);
  const sc = FACT_SOURCE_CLASSES.includes(o.source_class) ? o.source_class : "none";
  const verdict = FACT_VERDICTS.includes(o.verdict) ? o.verdict : null;
  if (!verdict) return { skip: "bad_verdict" };
  return { row: { id, kind: "curated", subject, claim, value, unit: "", source_table: extra.source_table || "curated", row_id: extra.row_id || id.slice(id.indexOf(":") + 1), build: b.build, verdict, source_class: sc, note: cut(clean(extra.note), MAX.note) }, buildFallback: b.fallback, classFallback: sc !== o.source_class };
}

export function deriveCuratedRows(factsLines, clientFactsLines, loadBuild) {
  const rows = [], skipped = {}, notes = { build_fallback: 0, class_fallback: 0 };
  const skip = (r) => { skipped[r] = (skipped[r] || 0) + 1; };
  const seen = new Set();
  const take = (res) => {
    if (res.skip) return skip(res.skip);
    if (seen.has(res.row.id)) return skip("duplicate_id");
    seen.add(res.row.id);
    if (res.buildFallback) notes.build_fallback++;
    if (res.classFallback) notes.class_fallback++;
    rows.push(res.row);
  };
  for (const o of factsLines || []) {
    const cid = clean(o && o.cid);
    if (!/^[A-Za-z0-9_.-]{1,40}$/.test(cid)) { skip("bad_cid"); continue; }
    take(curatedRow(o, `curated:${cid}`, loadBuild, { note: o.next_step, source_table: "facts", row_id: cid }));
  }
  for (const o of clientFactsLines || []) {
    const tag = sha256(`${clean(o && o.claim)}|${clean(o && o.table)}|${clean(o && o.row_id)}`).slice(0, 12);
    const table = clean(o && o.table).toLowerCase();
    const rid = clean(o && o.row_id);
    take(curatedRow(o, `curated:cf-${tag}`, loadBuild, { note: o.note, source_table: /^[a-z0-9_]{1,40}$/.test(table) ? table : "client_facts", row_id: /^[A-Za-z0-9_.:-]{1,40}$/.test(rid) ? rid : `cf-${tag}` }));
  }
  return { rows, skipped, notes };
}

// ---- the plan ------------------------------------------------------------------------------------------------------------------------------------
const count = (rows) => rows.reduce((m, r) => (m[r.kind] = (m[r.kind] || 0) + 1, m), {});
const fileMeta = (p) => { const b = readFileSync(p); return { sha256: sha256(b), bytes: b.length, rows: b.toString("utf8").split("\n").filter((l) => l.trim()).length }; };

// Everything the run will do, with no network. -> { build, manifest_sha256, loads: [{kind, files, rows, batches}], skipped, counts }. Throws (no row text in the message) when a table fails its manifest check.
export function buildPlan({ tables, traits = null, facts = null, clientFacts = null, scope = "both", kinds = null }) {
  if (kinds && (!Array.isArray(kinds) || !kinds.length || kinds.some((k) => !FACT_KINDS.includes(k)))) throw new Error("--kinds names fact kinds: " + FACT_KINDS.join(", "));
  const manifestBytes = readFileSync(path.join(tables, "MANIFEST.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (typeof manifest.build !== "string" || !/^[0-9.]{3,32}$/.test(manifest.build)) throw new Error("MANIFEST.json has no usable build");
  const manifestHash = sha256(manifestBytes);
  const skipped = { client: {}, curated: {} };
  const reject = (bucket, rows) => rows.filter((r) => { const v = validateRow(r, bucket === "client" ? "client" : "curated"); if (v.error) { skipped[bucket][v.error] = (skipped[bucket][v.error] || 0) + 1; return false; } return true; });
  const loads = [];
  let rankIds = new Set();
  if (scope !== "curated") {
    const t = deriveTableRows(tables, manifest);
    let rows = t.rows;
    rankIds = t.rankIds;
    const files = { ...t.files };
    if (traits) {
      const tb = readFileSync(traits);
      let parsed;
      try { parsed = JSON.parse(tb.toString("utf8")); } catch { throw new Error("the traits file is not JSON"); }
      if (parsed.build !== manifest.build) throw new Error("the traits file build differs from the MANIFEST build");
      const d = deriveTraitRows(parsed, manifest.build);
      if (!d.treesUsed) throw new Error("the traits file holds none of the known class trees");
      rows = rows.concat(d.rows);
      files["traits.json"] = { sha256: sha256(tb), bytes: tb.length, rows: d.rows.length };
    }
    rows = dedupe(reject("client", rows), skipped.client).filter((r) => !kinds || kinds.includes(r.kind));
    rows = rows.map((r, i) => [r, i]).sort((a, b) => KIND_ORDER.indexOf(a[0].kind) - KIND_ORDER.indexOf(b[0].kind) || a[1] - b[1]).map((x) => x[0]); // item_level_req last
    if (rows.length) loads.push({ kind: "client", build: manifest.build, files, rows });
  }
  let notes = null;
  if (scope !== "client") {
    const files = {};
    if (facts) files["facts.jsonl"] = fileMeta(facts);
    if (clientFacts) files["client-facts.jsonl"] = fileMeta(clientFacts);
    if (!facts || !clientFacts) throw new Error("a curated load replaces ALL curated rows: pass both --facts and --client-facts, or --scope client");
    const c = deriveCuratedRows(facts ? readJsonl(facts) : [], clientFacts ? readJsonl(clientFacts) : [], manifest.build);
    for (const [k, n] of Object.entries(c.skipped)) skipped.curated[k] = (skipped.curated[k] || 0) + n;
    notes = c.notes;
    const crows = dedupe(reject("curated", c.rows), skipped.curated).filter((r) => !kinds || kinds.includes(r.kind));
    if (crows.length) loads.unshift({ kind: "curated", build: manifest.build, files, rows: crows }); // curated first
  }
  for (const l of loads) {
    l.batches = batch(l.rows);
    l.counts = count(l.rows);
    l.suffixed = l.rows.filter((r) => baseNameOf(r.subject)).length;
    l.names = nameStats(l.rows);
    l.ranked = l.kind === "client" ? rankStats(l.rows, rankIds) : null;
  }
  if (!loads.length) throw new Error("nothing to load for those kinds and scope");
  return { build: manifest.build, manifest_sha256: manifestHash, loads, skipped, notes };
}
function dedupe(rows, skipped) {
  const seen = new Set();
  return rows.filter((r) => { if (seen.has(r.id)) { skipped.duplicate_id = (skipped.duplicate_id || 0) + 1; return false; } seen.add(r.id); return true; });
}
// Batches of at most FACTS_MAX_ROWS rows whose request body stays under MAX_BODY_BYTES.
export function batch(rows) {
  const out = [];
  let cur = [], bytes = 0;
  for (const r of rows) {
    const b = Buffer.byteLength(JSON.stringify(r)) + 1;
    if (cur.length && (cur.length >= FACTS_MAX_ROWS || bytes + b > MAX_BODY_BYTES - 1024)) { out.push(cur); cur = []; bytes = 0; }
    cur.push(r); bytes += b;
  }
  if (cur.length) out.push(cur);
  return out;
}
// Per kind: how many distinct names (normalised) have exactly one row, and how many are shared by several rows (ambiguous for a lookup). Counts only.
export function nameStats(rows) {
  const byKind = {};
  for (const r of rows) {
    if (r.kind === "curated") continue;
    const m = byKind[r.kind] || (byKind[r.kind] = new Map());
    const k = normName(r.subject);
    m.set(k, (m.get(k) || 0) + 1);
  }
  return Object.fromEntries(Object.entries(byKind).map(([k, m]) => [k, { names: m.size, unique: [...m.values()].filter((c) => c === 1).length, ambiguous: [...m.values()].filter((c) => c > 1).length }]));
}
// The player-facing shared-name spells (deriveRankRows), counted per kind from their ids, and for spell_level how their names split: a name whose rows all carry a distinct rank is the ranks of ONE spell; any other shared name
// (a repeated rank, or a spell without a rank line) is several different spells. Counts only.
export function rankStats(rows, rankIds) {
  const mine = rows.filter((r) => rankIds.has(r.id));
  const perKind = count(mine);
  const byName = new Map();
  for (const r of mine) if (r.kind === "spell_level") { const k = normName(r.subject); if (!byName.has(k)) byName.set(k, []); byName.get(k).push(r); }
  let ranksOfOne = 0, differentSpells = 0, single = 0;
  for (const rs of byName.values()) {
    if (rs.length === 1) { single++; continue; }
    const rk = rs.map((r) => /rank=([0-9]+)/.exec(r.note)?.[1] || "");
    if (rk.every(Boolean) && new Set(rk).size === rk.length) ranksOfOne++; else differentSpells++;
  }
  return { rows: mine.length, perKind, names: byName.size, single, ranksOfOne, differentSpells, suffixed: mine.filter((r) => baseNameOf(r.subject)).length };
}
const planSha = (load, manifestHash) => sha256(JSON.stringify([manifestHash, load.kind, load.build, load.files, load.rows]));
export const callsFor = (load) => 2 + load.batches.length;

// ---- network -------------------------------------------------------------------------------------------------------------------------------------
export function checkBase(base, allowHost) {
  let u;
  try { u = new URL(base); } catch { return { error: "the base URL is not a URL" }; }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.username || u.password) return { error: "the base URL must carry no credentials" };
  if (!(u.protocol === "https:" || (u.protocol === "http:" && local))) return { error: "the base URL must be https (http only for localhost, 127.0.0.1 or [::1])" };
  const allowed = new Set([...DEFAULT_ALLOWED_HOSTS, ...(allowHost ? [String(allowHost).toLowerCase()] : [])]);
  if (!allowed.has(u.hostname.toLowerCase())) return { error: "that host is not allowed; pass --allow-host <host> to name it" };
  return { url: `${u.origin}/api/facts/load` };
}

const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));
const okReason = (j) => (j && typeof j.reason === "string" && /^[a-z_]{1,30}$/.test(j.reason) ? j.reason : "other");

// deps: { fetchImpl, now: () => ms, sleep: (ms) => Promise, log: (line) => void }. -> exit code. Prints counts and fixed words only.
export async function run(argv, deps = {}) {
  const log = deps.log || ((l) => console.log(l));
  const err = deps.err || ((l) => console.error(l));
  const now = deps.now || (() => Date.now());
  const sleep = deps.sleep || sleepReal;
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const o = { apply: false, base: DEFAULT_BASE, maxCalls: 100, scope: "both", maxRowsPerRun: DEFAULT_ROW_BUDGET };
  let tokenFile = null;
  const val = (i, a) => { if (i + 1 >= argv.length) throw new Error(`missing value for ${a}`); return argv[i + 1]; };
  try {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === "--apply") o.apply = true;
      else if (a === "--dry-run") o.apply = false;
      else if (["--tables", "--traits", "--facts", "--client-facts", "--base", "--allow-host", "--state", "--max-calls", "--scope", "--kinds", "--max-rows-per-run"].includes(a)) { o[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = val(i, a); i++; }
      else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
      else if (tokenFile === null) tokenFile = a;
      else throw new Error("only one token file");
    }
    if (!o.tables) throw new Error("usage: node tools/facts-load.mjs [<token-file>] --tables <dir> [--traits f] [--facts f] [--client-facts f] [--apply] [--base url] [--allow-host h] [--state f] [--max-calls n] [--scope client|curated|both]");
    if (!["client", "curated", "both"].includes(o.scope)) throw new Error("--scope is client, curated or both");
    o.kindList = o.kinds ? String(o.kinds).split(",").map((k) => k.trim()).filter(Boolean) : null;
    o.maxRowsPerRun = Number(o.maxRowsPerRun);
    if (!Number.isInteger(o.maxRowsPerRun) || o.maxRowsPerRun < 100 || o.maxRowsPerRun > 90000) throw new Error("--max-rows-per-run is a whole number of D1 rows written from 100 to 90000 (the Free plan allows 100000 a day)");
    o.maxCalls = Number(o.maxCalls);
    if (!Number.isInteger(o.maxCalls) || o.maxCalls < 1 || o.maxCalls > 118) throw new Error("--max-calls is a whole number from 1 to 118");
  } catch (e) { err(e.message); return 2; }

  let plan;
  try { plan = buildPlan({ tables: o.tables, traits: o.traits, facts: o.facts, clientFacts: o.clientFacts, scope: o.scope, kinds: o.kindList }); } catch (e) { err(`refusing: ${e.message}`); return 2; }
  log(`build ${plan.build}`);
  log(`manifest_sha256 ${plan.manifest_sha256}`);
  for (const l of plan.loads) {
    log(`load ${l.kind}: ${l.rows.length} rows in ${l.batches.length} batches, ${callsFor(l)} calls (begin, ${l.batches.length} rows, finish)`);
    for (const [k, n] of KIND_ORDER.filter((x) => l.counts[x]).map((x) => [x, l.counts[x]])) { const ns = l.names[k]; log(`  ${k.padEnd(22)} ${String(n).padStart(6)}${ns ? `   names ${ns.names}: unique ${ns.unique}, ambiguous ${ns.ambiguous}` : ""}`); }
    if (l.ranked && l.ranked.rows) log(`  shared-name player spells (ranks): ${l.ranked.rows} rows (${Object.entries(l.ranked.perKind).map(([k, n]) => `${k} ${n}`).join(", ")}); spell_level names ${l.ranked.names}: ${l.ranked.single} with one spell, ${l.ranked.ranksOfOne} with the ranks of one spell, ${l.ranked.differentSpells} shared by different spells`);
    log(`  estimated D1 rows written: ${writeCost(l.rows.length, l.suffixed, callsFor(l))} (${WRITES_PER_FACT} per fact, +${WRITES_PER_SUFFIXED_FACT} for ${l.suffixed} rank-suffixed names, ${WRITES_PER_CALL} per call)`);
    const sk = plan.skipped[l.kind];
    if (Object.keys(sk).length) log(`  skipped: ${Object.entries(sk).sort().map(([k, n]) => `${k} ${n}`).join(", ")}`);
  }
  if (plan.notes && (plan.notes.build_fallback || plan.notes.class_fallback)) log(`curated: build taken from the load for ${plan.notes.build_fallback} rows, source_class set to none for ${plan.notes.class_fallback} rows`);
  const totalCalls = plan.loads.reduce((s, l) => s + callsFor(l), 0);
  const totalWrites = plan.loads.reduce((sum, l) => sum + writeCost(l.rows.length, l.suffixed, callsFor(l)), 0);
  log(`total calls ${totalCalls}, estimated rows written ${totalWrites}; budget per run ${o.maxRowsPerRun} (D1 Free: 100000 a day), so ${Math.ceil(totalWrites / o.maxRowsPerRun)} run(s)`);
  if (!o.apply) { log("dry run: nothing was sent (add --apply and a token file to load)"); return 0; }

  // ---- apply
  if (!tokenFile) { err("--apply needs a token file"); return 2; }
  const target = checkBase(o.base, o.allowHost);
  if (target.error) { err(`refusing: ${target.error}`); return 2; }
  let token = "";
  try { token = readFileSync(tokenFile, "utf8").trim(); } catch { err("cannot read the token file"); return 2; }
  const signKey = await factsLoadKey(token);
  token = "";
  if (!signKey) { err("the token file does not hold a usable token"); return 2; }

  let lastTs = 0, calls = 0, spent = 0; // spent: D1 rows written by this run, counted from the accepted batches with the measured constants
  const send = async (body) => {
    let ts;
    for (;;) { ts = Math.floor(now() / 1000); if (ts > lastTs) break; await sleep(150); } // the Worker needs a strictly newer signed second each time
    lastTs = ts;
    calls++;
    const raw = JSON.stringify({ purpose: FACTS_PURPOSE, ...body });
    try {
      const res = await fetchImpl(target.url, { method: "POST", headers: { "Content-Type": "application/json", "X-Listen-Timestamp": String(ts), "X-Listen-Signature": await signListen(signKey, String(ts), raw) }, body: raw, redirect: "error" });
      let j = null;
      try { j = JSON.parse(await res.text()); } catch { j = null; }
      return { status: res.status, json: j };
    } catch { return { status: 0, json: null }; }
  };
  // One state file for the run, with progress per scope: {scopes: {client: {plan_sha, load_id, next, done}, curated: {...}}}. It is removed only when EVERY planned scope is finished.
  let sp;
  try { sp = assertOutsideRepo(o.state ? path.resolve(o.state) : path.join(os.tmpdir(), "leeroy-facts", `state-${plan.build}.json`)); } catch (e) { err(`refusing: ${e.message}`); return 2; }
  let state = { scopes: {} };
  try { const j = existsSync(sp) ? JSON.parse(readFileSync(sp, "utf8")) : null; if (j && j.scopes && typeof j.scopes === "object") state = j; } catch { state = { scopes: {} }; }
  const save = () => { mkdirSync(path.dirname(sp), { recursive: true }); writeFileSync(sp, JSON.stringify(state)); };
  const stop = (why, r) => { log(`stopped (${why}${r ? `: HTTP ${r.status}, reason ${okReason(r.json)}` : ""}); run the same command again to resume (the budget is per run: after 00:00 UTC for the daily D1 limit)`); return 1; };
  for (const l of plan.loads) {
    const sha = planSha(l, plan.manifest_sha256);
    const scopeKey = `${l.kind}:${sha.slice(0, 12)}`; // one state per plan: a run with other --kinds has its own
    let st = state.scopes[scopeKey];
    if (st && st.done) { log(`${l.kind}: already finished in an earlier run`); continue; }
    if (!st) {
      if (calls >= o.maxCalls) return stop("call budget used up");
      if (spent + writeCost(0, 0, 2) > o.maxRowsPerRun) return stop("daily rows-written budget reached");
      const r = await send({ op: "begin", build: l.build, manifest_sha256: plan.manifest_sha256, files: l.files, kind: l.kind, kinds: l.counts });
      if (r.status !== 200 || !r.json || r.json.ok !== true || typeof r.json.load_id !== "string") return stop(`begin ${l.kind} failed`, r);
      st = { plan_sha: sha, load_id: r.json.load_id, next: 0, done: false };
      state.scopes[scopeKey] = st;
      save();
      log(`begin ${l.kind}: load opened`);
    } else log(`resume ${l.kind}: ${st.next} of ${l.batches.length} batches already sent`);
    while (st.next < l.batches.length) {
      if (calls >= o.maxCalls) return stop("call budget used up");
      const batchRows = l.batches[st.next];
      const cost = writeCost(batchRows.length, batchRows.filter((x) => baseNameOf(x.subject)).length, 1);
      if (spent + cost > o.maxRowsPerRun) return stop(`daily rows-written budget reached (${spent} of ${o.maxRowsPerRun} counted)`);
      const r = await send({ op: "rows", load_id: st.load_id, rows: l.batches[st.next] });
      if (r.status !== 200 || !r.json || r.json.ok !== true) return stop(`rows batch ${st.next + 1} failed`, r);
      spent += cost;
      st.next++;
      save();
    }
    log(`rows ${l.kind}: ${l.batches.length} batches sent`);
    if (calls >= o.maxCalls) return stop("call budget used up");
    const f = await send({ op: "finish", load_id: st.load_id }); // idempotent on the Worker: a lost response is retried by running the command again
    if (f.status !== 200 || !f.json || f.json.ok !== true) return stop(`finish ${l.kind} failed`, f);
    const c = f.json.counts || {};
    spent += writeCost(0, 0, 1) + (Number(c.removed) || 0) * WRITES_PER_RETIRED_FACT;
    log(`finish ${l.kind}: total ${c.total}, added ${c.added}, changed ${c.changed}, unchanged ${c.unchanged}, removed ${c.removed}`);
    st.done = true;
    save();
  }
  if (plan.loads.every((l) => { const e = state.scopes[`${l.kind}:${planSha(l, plan.manifest_sha256).slice(0, 12)}`]; return e && e.done; })) { try { unlinkSync(sp); } catch { /* already gone */ } }
  log(`done: ${calls} calls, about ${spent} D1 rows written`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await run(process.argv.slice(2)));
