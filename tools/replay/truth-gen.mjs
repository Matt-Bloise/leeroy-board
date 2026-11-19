// Builds a deterministic (seeded) question set from the Forever client's exported data tables. docs/runbooks/replay-harness.md.
//   node tools/replay/truth-gen.mjs --tables <dir> [--out <file.jsonl>] [--seed 1] [--per-kind 40] [--manifest-sha256 <hex>] [--traits <traits.json>]
// --tables: directory of CSV exports (header row) plus MANIFEST.json {build, files:{name:{sha256,bytes,rows}}}. Every table used is checked against the manifest first; a mismatch refuses the run.
// --out: default <os tmp>/leeroy-replay/truth-<build>-s<seed>.jsonl. Writing inside this repo checkout is refused: neither the tables nor a generated set may ever enter the repo.
// Output line 1 is a header {type:"header", ...build, seed, per-kind, table hashes, columns chosen}; then one record per question:
//   {id, kind, question, expected:{value, unit}, rows:[{table, id}], entity_name, allowed_numbers:[...]}
// Prints counts only, never row data.
//
// Kinds and the column choices (also in the runbook):
//   spell_level      spelllevels.BaseLevel. BaseLevel is the minimum caster level the client requires to learn/use the spell (the "Requires level" a player sees); SpellLevel is the level the spell's own scaling
//                    (rank and effect points) is computed at and is often 0 or different, so it is NOT the question's fact. Spell chosen only if its name is unique in spellname.Name_lang, it has exactly one
//                    spelllevels row (any difficulty) and BaseLevel > 0.
//   item_level_req   itemsparse.RequiredLevel, items whose Display_lang name is unique in itemsparse, RequiredLevel > 0.
//   spell_cooldown   spellcooldowns.RecoveryTime (ms -> whole seconds). Unique spell name, exactly one spellcooldowns row, RecoveryTime > 0 and a whole number of seconds, CategoryRecoveryTime = 0 and
//                    StartRecoveryTime = 0 (so no shared category or global cooldown muddies "the cooldown").
//   spell_cast_time  spellmisc.CastingTimeIndex -> spellcasttimes.Base (ms -> seconds). Unique spell name, exactly one spellmisc row, the index exists exactly once, Base > 0.
//   spell_mana_cost  spellpower.ManaCost, unique spell name, exactly one spellpower row, PowerType = 0 (mana), ManaCost > 0, ManaCostPerLevel = 0, PowerCostPct = 0, OptionalCost = 0.
// NO questions from the legacy talent table: it lacks Forever's added talents and is the vanilla layout.
// TRAIT kinds (Forever's real talent trees) come from a derived file kept outside the repo, traits.json {build, source, trees:{<treeId>:{treeId, system, nodeCount, nodes:[{nodeId, entryId, spellId, name, maxRanks, x, y, type, text, edgesTo, conds}]}}}
// (trees may also be an array). It has no MANIFEST: the header records its build and sha256. Only the eight class trees in TRAIT_CLASSES are used. A node is eligible only if its nodeId occurs once in the tree and its name is unique
// (case-insensitive) in that tree, well-formed, and not the "?" fallback; anything else is skipped, never guessed.
//   trait_max_ranks        maxRanks (integer > 0) of an eligible node.
//   trait_points_required  the node has exactly one cond, condType 0, currency id > 0, spentAmountRequired an integer > 0 (nodes with no cond, several conds or a currency-0 cond are skipped).
//   trait_prereq           exactly one distinct node in the tree has an edge to the node (edgesTo: left -> right, left is the prerequisite), that source node is itself eligible, and neither name contains the other.
//                          expected.value is the prerequisite's NAME (unit "name"); score.mjs matches the name after removing the asked talent's own name from the answer.
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadVerifiedTable, writeOut, rng, shuffle, parseArgs, die, sha256, DEFAULT_OUT_DIR } from "./common.mjs";

export const KINDS = Object.freeze(["spell_level", "item_level_req", "spell_cooldown", "spell_cast_time", "spell_mana_cost"]);
export const TRAIT_KINDS = Object.freeze(["trait_max_ranks", "trait_points_required", "trait_prereq"]);
// treeId -> class. Source: the README beside traits.json. Trees not listed there are never used.
export const TRAIT_CLASSES = Object.freeze({ 1112: "Mage", 1100: "Paladin", 1114: "Priest", 1116: "Warlock", 1083: "Druid", 1111: "Rogue", 1117: "Warrior", 1091: "Hunter" });
const NAME_OK =(n) => typeof n === "string" && n.length >= 3 && n.length <= 60 && /^[\p{L}\p{N} '\-:,.!]+$/u.test(n) && n.trim() === n;
const numCell = (v) => (v !== "" && v !== undefined && Number.isFinite(Number(v)) ? Number(v) : null);
const key = (n) => n.toLowerCase();

const TEMPLATES = {
  spell_level: [
    (n) => `At what level does a player learn ${n}?`,
    (n) => `What level do I need to be to get ${n}?`,
    (n) => `${n}: what level is it available from?`,
  ],
  item_level_req: [
    (n) => `What level do you need to be to equip ${n}?`,
    (n) => `What is the required level for ${n}?`,
    (n) => `Can you tell me the level requirement of ${n}?`,
  ],
  spell_cooldown: [
    (n) => `What is the cooldown of ${n}, in seconds?`,
    (n) => `How many seconds is the cooldown on ${n}?`,
    (n) => `${n}: how long is its cooldown (in seconds)?`,
  ],
  spell_cast_time: [
    (n) => `What is the cast time of ${n}, in seconds?`,
    (n) => `How many seconds does ${n} take to cast?`,
    (n) => `${n}: how long is the cast, in seconds?`,
  ],
  spell_mana_cost: [
    (n) => `How much mana does ${n} cost?`,
    (n) => `What is the mana cost of ${n}?`,
    (n) => `${n}: what does it cost in mana?`,
  ],
};
const UNIT = { spell_level: "level", item_level_req: "level", spell_cooldown: "seconds", spell_cast_time: "seconds", spell_mana_cost: "mana", trait_max_ranks: "ranks", trait_points_required: "points", trait_prereq: "name" };
TEMPLATES.trait_max_ranks = [
  (n, c) => `In the ${c} talent tree, how many ranks does ${n} have?`,
  (n, c) => `How many ranks can you put into the ${c} talent ${n}?`,
  (n, c) => `${c} talent ${n}: how many ranks does it have?`,
];
TEMPLATES.trait_points_required = [
  (n, c) => `How many talent points must be spent in the ${c} tree before ${n} can be learned?`,
  (n, c) => `What is the points requirement in the ${c} talent tree for ${n}?`,
  (n, c) => `${c} talent ${n}: how many points do you need to have spent in the tree first?`,
];
TEMPLATES.trait_prereq = [
  (n, c) => `Which ${c} talent do you need to take first before you can learn ${n}?`,
  (n, c) => `In the ${c} talent tree, what is the prerequisite talent for ${n}?`,
  (n, c) => `${c} talent ${n}: which talent has to be taken before it?`,
];

const countBy = (rows, idx) => { const m = new Map(); for (const r of rows) m.set(r[idx], (m.get(r[idx]) || 0) + 1); return m; };
const rowNumbers = (header, row) => header.map((_, i) => numCell(row[i])).filter((v) => v !== null);

// Returns {header, records (all candidates, unsampled, per kind), counts}. Pure over the verified tables.
export function buildCandidates(dir, manifest) {
  const load = (n) => loadVerifiedTable(dir, manifest, n);
  const spellname = load("spellname.csv");
  const sn = { id: spellname.col("ID"), name: spellname.col("Name_lang") };
  const nameCount = new Map();
  for (const r of spellname.rows) nameCount.set(key(r[sn.name]), (nameCount.get(key(r[sn.name])) || 0) + 1);
  const spellIds = new Map(); // SpellID -> {name, row} for unique, well-formed names whose id is also unique
  const idCount = countBy(spellname.rows, sn.id);
  for (const r of spellname.rows) {
    const nm = r[sn.name];
    if (NAME_OK(nm) && nameCount.get(key(nm)) === 1 && idCount.get(r[sn.id]) === 1) spellIds.set(r[sn.id], { name: nm, row: r });
  }
  const out = Object.fromEntries(KINDS.map((k) => [k, []]));
  const used = { "spellname.csv": spellname };
  const entity = (kind, id, name, value, rowsRef, nums, extraAllowed = []) => ({
    id: `${kind}-${id}`,
    kind,
    question: null,
    expected: { value, unit: UNIT[kind] },
    rows: rowsRef,
    entity_name: name,
    allowed_numbers: [...new Set([...nums, ...extraAllowed, value])].sort((a, b) => a - b),
  });

  // spell_level
  {
    const t = load("spelllevels.csv"); used["spelllevels.csv"] = t;
    const iSpell = t.col("SpellID"), iBase = t.col("BaseLevel");
    const per = countBy(t.rows, iSpell);
    for (const r of t.rows) {
      const sp = spellIds.get(r[iSpell]);
      if (!sp || per.get(r[iSpell]) !== 1) continue;
      const v = numCell(r[iBase]);
      if (v === null || v <= 0) continue;
      out.spell_level.push(entity("spell_level", r[iSpell], sp.name, v, [{ table: "spellname", id: r[iSpell] }, { table: "spelllevels", id: r[t.col("ID")] }], [...rowNumbers(t.header, r), ...rowNumbers(spellname.header, sp.row)]));
    }
  }
  // item_level_req
  {
    const t = load("itemsparse.csv"); used["itemsparse.csv"] = t;
    const iId = t.col("ID"), iName = t.col("Display_lang"), iReq = t.col("RequiredLevel");
    const nc = new Map();
    for (const r of t.rows) nc.set(key(r[iName]), (nc.get(key(r[iName])) || 0) + 1);
    for (const r of t.rows) {
      const nm = r[iName];
      if (!NAME_OK(nm) || nc.get(key(nm)) !== 1) continue;
      const v = numCell(r[iReq]);
      if (v === null || v <= 0) continue;
      out.item_level_req.push(entity("item_level_req", r[iId], nm, v, [{ table: "itemsparse", id: r[iId] }], rowNumbers(t.header, r)));
    }
  }
  // spell_cooldown
  {
    const t = load("spellcooldowns.csv"); used["spellcooldowns.csv"] = t;
    const iSpell = t.col("SpellID"), iRec = t.col("RecoveryTime"), iCat = t.col("CategoryRecoveryTime"), iStart = t.col("StartRecoveryTime");
    const per = countBy(t.rows, iSpell);
    for (const r of t.rows) {
      const sp = spellIds.get(r[iSpell]);
      if (!sp || per.get(r[iSpell]) !== 1) continue;
      const ms = numCell(r[iRec]);
      if (ms === null || ms <= 0 || ms % 1000 !== 0 || numCell(r[iCat]) !== 0 || numCell(r[iStart]) !== 0) continue;
      const sec = ms / 1000;
      out.spell_cooldown.push(entity("spell_cooldown", r[iSpell], sp.name, sec, [{ table: "spellname", id: r[iSpell] }, { table: "spellcooldowns", id: r[t.col("ID")] }], [...rowNumbers(t.header, r), ...rowNumbers(spellname.header, sp.row)], [ms, sec / 60].filter((x) => Number.isFinite(x))));
    }
  }
  // spell_cast_time
  {
    const m = load("spellmisc.csv"), c = load("spellcasttimes.csv"); used["spellmisc.csv"] = m; used["spellcasttimes.csv"] = c;
    const iSpell = m.col("SpellID"), iIdx = m.col("CastingTimeIndex");
    const per = countBy(m.rows, iSpell);
    const cIdCount = countBy(c.rows, c.col("ID"));
    const cById = new Map(c.rows.map((r) => [r[c.col("ID")], r]));
    for (const r of m.rows) {
      const sp = spellIds.get(r[iSpell]);
      if (!sp || per.get(r[iSpell]) !== 1) continue;
      const cr = cById.get(r[iIdx]);
      if (!cr || cIdCount.get(r[iIdx]) !== 1) continue;
      const ms = numCell(cr[c.col("Base")]);
      if (ms === null || ms <= 0 || ms % 100 !== 0) continue;
      const sec = ms / 1000;
      out.spell_cast_time.push(entity("spell_cast_time", r[iSpell], sp.name, sec, [{ table: "spellname", id: r[iSpell] }, { table: "spellmisc", id: r[m.col("ID")] }, { table: "spellcasttimes", id: r[iIdx] }], [...rowNumbers(c.header, cr), ...rowNumbers(spellname.header, sp.row), numCell(r[iIdx])].filter((x) => x !== null), [ms]));
    }
  }
  // spell_mana_cost
  {
    const t = load("spellpower.csv"); used["spellpower.csv"] = t;
    const iSpell = t.col("SpellID"), iCost = t.col("ManaCost"), iType = t.col("PowerType"), iPerLvl = t.col("ManaCostPerLevel"), iPct = t.col("PowerCostPct"), iOpt = t.col("OptionalCost");
    const per = countBy(t.rows, iSpell);
    for (const r of t.rows) {
      const sp = spellIds.get(r[iSpell]);
      if (!sp || per.get(r[iSpell]) !== 1) continue;
      const v = numCell(r[iCost]);
      if (v === null || v <= 0 || numCell(r[iType]) !== 0 || numCell(r[iPerLvl]) !== 0 || numCell(r[iPct]) !== 0 || numCell(r[iOpt]) !== 0) continue;
      out.spell_mana_cost.push(entity("spell_mana_cost", r[iSpell], sp.name, v, [{ table: "spellname", id: r[iSpell] }, { table: "spellpower", id: r[t.col("ID")] }], [...rowNumbers(t.header, r), ...rowNumbers(spellname.header, sp.row)]));
    }
  }
  return { out, used };
}

const uniqSorted = (a) => [...new Set(a.filter((v) => Number.isFinite(v)))].sort((x, y) => x - y);
// Pure over the parsed traits object. Returns {out: {kind: [record]}, used: number of class trees used}.
export function buildTraitCandidates(traits) {
  const out = Object.fromEntries(TRAIT_KINDS.map((k) => [k, []]));
  const rawTrees = traits && traits.trees ? (Array.isArray(traits.trees) ? traits.trees : Object.values(traits.trees)) : [];
  const seenTree = new Set();
  let used = 0;
  for (const tr of rawTrees) {
    const treeId = Number(tr && tr.treeId);
    const cls = TRAIT_CLASSES[treeId];
    if (!cls || seenTree.has(treeId) || !Array.isArray(tr.nodes)) continue;
    seenTree.add(treeId); used++;
    const nodes = tr.nodes;
    const idCount = new Map(), nameCount = new Map();
    for (const n of nodes) {
      idCount.set(String(n.nodeId), (idCount.get(String(n.nodeId)) || 0) + 1);
      const k = typeof n.name === "string" ? key(n.name) : "";
      nameCount.set(k, (nameCount.get(k) || 0) + 1);
    }
    const eligible = (n) => n && idCount.get(String(n.nodeId)) === 1 && NAME_OK(n.name) && nameCount.get(key(n.name)) === 1 && Number.isInteger(Number(n.maxRanks)) && Number(n.maxRanks) > 0;
    const byId = new Map(nodes.filter((n) => idCount.get(String(n.nodeId)) === 1).map((n) => [String(n.nodeId), n]));
    const incoming = new Map(); // right node id -> Set of distinct left node ids
    for (const n of byId.values()) for (const r of Array.isArray(n.edgesTo) ? n.edgesTo : []) { if (!incoming.has(String(r))) incoming.set(String(r), new Set()); incoming.get(String(r)).add(String(n.nodeId)); }
    const nodeNums = (n) => [treeId, Number(n.nodeId), Number(n.entryId), Number(n.spellId), Number(n.maxRanks)];
    const mk = (kind, n, value, extraRows, nums) => ({
      id: `${kind}-${treeId}-${n.nodeId}`, kind, question: null, expected: { value, unit: UNIT[kind] },
      rows: [{ table: "traittree", id: String(treeId) }, { table: "traitnode", id: String(n.nodeId) }, ...extraRows],
      entity_name: n.name, class_name: cls, allowed_numbers: uniqSorted([...nums, ...(typeof value === "number" ? [value] : [])]),
    });
    for (const n of nodes) {
      if (!eligible(n)) continue;
      out.trait_max_ranks.push(mk("trait_max_ranks", n, Number(n.maxRanks), [], nodeNums(n)));
      const cs = Array.isArray(n.conds) ? n.conds : [];
      if (cs.length === 1 && String(cs[0].condType) === "0" && Number(cs[0].currency) > 0 && Number.isInteger(Number(cs[0].spentAmountRequired)) && Number(cs[0].spentAmountRequired) > 0) {
        const need = Number(cs[0].spentAmountRequired);
        out.trait_points_required.push(mk("trait_points_required", n, need, [], [...nodeNums(n), need, Number(cs[0].currency)]));
      }
      const inc = incoming.get(String(n.nodeId));
      if (inc && inc.size === 1) {
        const src = byId.get([...inc][0]);
        if (!src || src === n || !eligible(src)) continue;
        const a = key(n.name), b = key(src.name);
        if (a.includes(b) || b.includes(a)) continue;
        out.trait_prereq.push(mk("trait_prereq", n, src.name, [{ table: "traitnode", id: String(src.nodeId) }], [...nodeNums(n), ...nodeNums(src)]));
      }
    }
  }
  return { out, used };
}

// Pure and deterministic: same tables + seed + perKind -> byte-identical output (no clock, no randomness beyond the seed).
// manifestSha256: optional pin of MANIFEST.json itself. Without it the manifest is the trust root: a table and a manifest edited together pass every check, so keep the pin where the tables are not.
export function generate({ dir, seed = 1, perKind = 40, manifestSha256 = null, traitsPath = null }) {
  const manifestBytes = readFileSync(path.join(dir, "MANIFEST.json"));
  const manifestHash = sha256(manifestBytes);
  if (manifestSha256 && String(manifestSha256).toLowerCase() !== manifestHash) throw new Error("MANIFEST.json sha256 differs from --manifest-sha256");
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const { out, used } = buildCandidates(dir, manifest);
  let traitInfo = null;
  if (traitsPath) {
    const tb = readFileSync(traitsPath);
    let parsed;
    try { parsed = JSON.parse(tb.toString("utf8")); } catch { throw new Error("traits file is not JSON"); }
    const t = buildTraitCandidates(parsed);
    if (!t.used) throw new Error("traits file holds none of the known class trees");
    Object.assign(out, t.out);
    traitInfo = { build: parsed.build ?? null, sha256: sha256(tb), bytes: tb.length, trees_used: t.used };
  }
  const kinds = traitInfo ? [...KINDS, ...TRAIT_KINDS] : KINDS;
  const rand = rng(seed);
  const header = {
    type: "header", generator: "tools/replay/truth-gen.mjs", build: manifest.build ?? null, manifest_sha256: manifestHash, manifest_pinned: Boolean(manifestSha256), seed: Number(seed), per_kind: Number(perKind),
    tables: Object.fromEntries(Object.keys(used).sort().map((n) => [n, { sha256: used[n].sha256, bytes: used[n].bytes }])),
    columns: { spell_level: "spelllevels.BaseLevel", item_level_req: "itemsparse.RequiredLevel", spell_cooldown: "spellcooldowns.RecoveryTime/1000", spell_cast_time: "spellcasttimes.Base/1000 via spellmisc.CastingTimeIndex", spell_mana_cost: "spellpower.ManaCost" },
    candidates: {}, selected: {},
  };
  if (traitInfo) {
    header.traits = traitInfo;
    header.columns.trait_max_ranks = "traits.json node.maxRanks (unique name in the class tree)";
    header.columns.trait_points_required = "traits.json node.conds[0].spentAmountRequired (exactly one cond)";
    header.columns.trait_prereq = "traits.json: the single node whose edgesTo holds the asked node (left is the prerequisite)";
  }
  const lines = [];
  for (const kind of kinds) {
    const cands = out[kind].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    header.candidates[kind] = cands.length;
    const pick = shuffle(cands, rand).slice(0, Number(perKind)).sort((a, b) => (a.id < b.id ? -1 : 1));
    header.selected[kind] = pick.length;
    for (const rec of pick) {
      const tpl = TEMPLATES[kind];
      rec.question = tpl[Math.floor(rand() * tpl.length)](rec.entity_name, rec.class_name);
      lines.push(JSON.stringify(rec));
    }
  }
  return { header, text: [JSON.stringify(header), ...lines].join("\n") + "\n" };
}

async function main() {
  const a = parseArgs(process.argv.slice(2), { tables: "value", out: "value", seed: "value", "per-kind": "value", "manifest-sha256": "value", traits: "value", "no-traits": "bool" });
  if (!a.tables) die("usage: node tools/replay/truth-gen.mjs --tables <dir> [--out file.jsonl] [--seed N] [--per-kind N]");
  const seed = a.seed === undefined ? 1 : Number(a.seed);
  const perKind = a["per-kind"] === undefined ? 40 : Number(a["per-kind"]);
  if (!Number.isInteger(seed) || !Number.isInteger(perKind) || perKind < 1) die("--seed and --per-kind must be integers (per-kind >= 1)");
  if (a.traits && a["no-traits"]) die("--traits and --no-traits together");
  if (a.traits && !existsSync(a.traits)) die("refusing: --traits file not found");
  const traitsPath = a["no-traits"] ? null : a.traits || null; // no flag: no trait kinds, and no file outside --tables is read
  let res;
  try { res = generate({ dir: a.tables, seed, perKind, manifestSha256: a["manifest-sha256"], traitsPath }); } catch (e) { die(`refusing: ${e.message}`); }
  const out = a.out || path.join(DEFAULT_OUT_DIR, `truth-${res.header.build || "unknown"}-s${seed}.jsonl`);
  try { writeOut(out, res.text); } catch (e) { die(e.message); }
  console.log(`build ${res.header.build}, seed ${seed}, per-kind ${perKind}`);
  for (const k of traitsPath ? [...KINDS, ...TRAIT_KINDS] : KINDS) console.log(`${k.padEnd(22)} candidates ${String(res.header.candidates[k]).padStart(6)}  selected ${String(res.header.selected[k]).padStart(4)}`);
  console.log(`written: ${path.resolve(out)}`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
