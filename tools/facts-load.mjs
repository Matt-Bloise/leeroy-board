// Loads game facts from the PC into the Worker's D1 store: begin / rows / finish against POST /api/facts/load. docs/runbooks/game-facts.md.
//   node tools/facts-load.mjs --tables <dir> [--traits <traits.json>] [--facts <facts.jsonl>] [--client-facts <client-facts.jsonl>]            (dry run: the default; sends nothing, prints counts)
//   node tools/facts-load.mjs <token-file> --tables <dir> ... --apply [--base https://api.leeroy.party] [--allow-host <host>] [--state <file>] [--max-calls 100] [--scope client|curated|both]
// --tables: the client DB2 CSV export folder with MANIFEST.json {build, files:{name:{sha256,bytes,rows}}}. Every table used is checked against it first (sha256, bytes, rows; the replay harness's common.mjs does it); a mismatch refuses the run.
// Client facts: the SAME kinds and uniqueness rules as tools/replay/truth-gen.mjs (its buildCandidates is imported, not copied) for spell_level, item_level_req, spell_cooldown, spell_cast_time, spell_mana_cost, plus the trait kinds
// from --traits (the same rules as the replay harness's trait kinds; see deriveTraitRows). Curated facts: --facts (cid, claim, value, verdict, source_class, build, next_step) and --client-facts (cids, claim, value, verdict, ...), kind 'curated'.
// NOTHING from the tables or the facts files is written anywhere but the signed request body: no output file, nothing in the repo. The tool prints counts only, never a row's text.
// <token-file>: a file holding the Discord bot token. It is read, used to derive the FACTS-LOAD signing key (HMAC-SHA256 of the token with the label "leeroy-facts-load-v1") and never printed. Owner's machine only.
// --base: https only (http only for localhost, 127.0.0.1 or [::1]); no credentials in the URL; only api.leeroy.party or a local host unless --allow-host names the host; redirects are refused (a redirect would replay the signed body elsewhere).
// Resume: the load id and the number of batches sent are kept in --state (default: the OS temp folder, outside the repo). Run the same command again after a failure: it skips begin and continues. Batches are idempotent on the Worker.
// The Worker needs each signed timestamp strictly newer than the last accepted one (whole seconds), so calls are at least one second apart; it allows 120 accepted calls an hour, and this tool stops after --max-calls (default 100) and says so.
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { factsLoadKey, signListen } from "../infrastructure/worker/listener-config.js";
import { validateRow, FACT_SOURCE_CLASSES, FACT_VERDICTS, FACTS_MAX_ROWS, FACTS_PURPOSE, MAX } from "../infrastructure/worker/game-facts.js";
import { buildCandidates } from "./replay/truth-gen.mjs";
import { sha256, assertOutsideRepo, readJsonl } from "./replay/common.mjs";

export const DEFAULT_BASE = "https://api.leeroy.party";
export const DEFAULT_ALLOWED_HOSTS = Object.freeze(["api.leeroy.party", "localhost", "127.0.0.1", "[::1]"]);
export const MAX_BODY_BYTES = 200 * 1024; // the Worker refuses 256 KB; stay well under
// treeId -> class, the same eight class trees the replay harness uses (README beside traits.json).
export const TRAIT_CLASSES = Object.freeze({ 1112: "Mage", 1100: "Paladin", 1114: "Priest", 1116: "Warlock", 1083: "Druid", 1111: "Rogue", 1117: "Warrior", 1091: "Hunter" });
const NAME_OK = (n) => typeof n === "string" && n.length >= 3 && n.length <= 60 && /^[\p{L}\p{N} '\-:,.!]+$/u.test(n) && n.trim() === n;
const key = (n) => n.toLowerCase();
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
  const files = {};
  for (const n of Object.keys(used).sort()) files[n] = { sha256: manifest.files[n].sha256, bytes: manifest.files[n].bytes, rows: manifest.files[n].rows };
  return { rows, files };
}

// Pure over the parsed traits object. Same eligibility as the replay harness's trait kinds: a node counts only if its nodeId occurs once in its tree, its name is well formed and unique (case-insensitive) in the tree and its maxRanks is a positive integer;
// points_required needs exactly one cond (condType 0, currency > 0, spentAmountRequired a positive integer); prereq needs exactly one distinct entry in the node's own `requires`, itself eligible, with neither name containing the other.
export function deriveTraitRows(traits, build) {
  const rows = [];
  const rawTrees = traits && traits.trees ? (Array.isArray(traits.trees) ? traits.trees : Object.values(traits.trees)) : [];
  const seenTree = new Set();
  let used = 0;
  for (const tr of rawTrees) {
    const treeId = Number(tr && tr.treeId);
    const cls = TRAIT_CLASSES[treeId];
    if (!cls || seenTree.has(treeId) || !Array.isArray(tr.nodes)) continue;
    seenTree.add(treeId); used++;
    const idCount = new Map(), nameCount = new Map();
    for (const n of tr.nodes) {
      idCount.set(String(n.nodeId), (idCount.get(String(n.nodeId)) || 0) + 1);
      const k = typeof n.name === "string" ? key(n.name) : "";
      nameCount.set(k, (nameCount.get(k) || 0) + 1);
    }
    const eligible = (n) => n && idCount.get(String(n.nodeId)) === 1 && NAME_OK(n.name) && nameCount.get(key(n.name)) === 1 && Number.isInteger(Number(n.maxRanks)) && Number(n.maxRanks) > 0;
    const byId = new Map(tr.nodes.filter((n) => idCount.get(String(n.nodeId)) === 1).map((n) => [String(n.nodeId), n]));
    const base = (kind, n) => ({ id: `${kind}:${treeId}-${n.nodeId}`, kind, subject: n.name, source_table: "traitnode", row_id: String(n.nodeId), build, verdict: "holds", source_class: "client-db2", note: "" });
    for (const n of tr.nodes) {
      if (!eligible(n)) continue;
      const ranks = Number(n.maxRanks);
      rows.push({ ...base("trait_max_ranks", n), claim: `${n.name} is a ${cls} talent with ${plural(ranks, "rank")}.`, value: String(ranks), unit: "ranks" });
      const cs = Array.isArray(n.conds) ? n.conds : [];
      if (cs.length === 1 && String(cs[0].condType) === "0" && Number(cs[0].currency) > 0 && Number.isInteger(Number(cs[0].spentAmountRequired)) && Number(cs[0].spentAmountRequired) > 0) {
        const need = Number(cs[0].spentAmountRequired);
        rows.push({ ...base("trait_points_required", n), claim: `${n.name} (${cls} talent) needs ${plural(need, "point")} spent in its tree before it can be learned.`, value: String(need), unit: "points" });
      }
      const req = [...new Set((Array.isArray(n.requires) ? n.requires : []).map((r) => String(r && typeof r === "object" ? r.nodeId : r)))];
      if (req.length === 1) {
        const src = byId.get(req[0]);
        if (!src || src === n || !eligible(src)) continue;
        const a = key(n.name), b = key(src.name);
        if (a.includes(b) || b.includes(a)) continue;
        rows.push({ ...base("trait_prereq", n), claim: `${n.name} (${cls} talent) has ${src.name} as its prerequisite talent.`, value: src.name, unit: "" });
      }
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
  if (Array.from(value).length > MAX.value) {
    const joined = `${claim} (${value})`;
    if (Array.from(joined).length > MAX.claim) return { skip: "too_long" };
    claim = joined; value = "";
  }
  const b = curatedBuild(o.build, loadBuild);
  const sc = FACT_SOURCE_CLASSES.includes(o.source_class) ? o.source_class : "none";
  const verdict = FACT_VERDICTS.includes(o.verdict) ? o.verdict : null;
  if (!verdict) return { skip: "bad_verdict" };
  return { row: { id, kind: "curated", subject: "", claim, value, unit: "", source_table: extra.source_table || "", row_id: extra.row_id || "", build: b.build, verdict, source_class: sc, note: cut(clean(extra.note), MAX.note) }, buildFallback: b.fallback, classFallback: sc !== o.source_class };
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
    take(curatedRow(o, `curated:${cid}`, loadBuild, { note: o.next_step }));
  }
  for (const o of clientFactsLines || []) {
    const tag = sha256(`${clean(o && o.claim)}|${clean(o && o.table)}|${clean(o && o.row_id)}`).slice(0, 12);
    const table = clean(o && o.table).toLowerCase();
    const rid = clean(o && o.row_id);
    take(curatedRow(o, `curated:cf-${tag}`, loadBuild, { note: o.note, source_table: /^[a-z0-9_]{1,40}$/.test(table) ? table : "", row_id: /^[A-Za-z0-9_.:-]{1,40}$/.test(rid) ? rid : "" }));
  }
  return { rows, skipped, notes };
}

// ---- the plan ------------------------------------------------------------------------------------------------------------------------------------
const count = (rows) => rows.reduce((m, r) => (m[r.kind] = (m[r.kind] || 0) + 1, m), {});
const fileMeta = (p) => { const b = readFileSync(p); return { sha256: sha256(b), bytes: b.length, rows: b.toString("utf8").split("\n").filter((l) => l.trim()).length }; };

// Everything the run will do, with no network. -> { build, manifest_sha256, loads: [{kind, files, rows, batches}], skipped, counts }. Throws (no row text in the message) when a table fails its manifest check.
export function buildPlan({ tables, traits = null, facts = null, clientFacts = null, scope = "both" }) {
  const manifestBytes = readFileSync(path.join(tables, "MANIFEST.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (typeof manifest.build !== "string" || !/^[0-9.]{3,32}$/.test(manifest.build)) throw new Error("MANIFEST.json has no usable build");
  const manifestHash = sha256(manifestBytes);
  const skipped = { client: {}, curated: {} };
  const reject = (bucket, rows) => rows.filter((r) => { const v = validateRow(r, bucket === "client" ? "client" : "curated"); if (v.error) { skipped[bucket][v.error] = (skipped[bucket][v.error] || 0) + 1; return false; } return true; });
  const loads = [];
  if (scope !== "curated") {
    const t = deriveTableRows(tables, manifest);
    let rows = t.rows;
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
    loads.push({ kind: "client", build: manifest.build, files, rows: dedupe(reject("client", rows), skipped.client) });
  }
  let notes = null;
  if (scope !== "client") {
    const files = {};
    if (facts) files["facts.jsonl"] = fileMeta(facts);
    if (clientFacts) files["client-facts.jsonl"] = fileMeta(clientFacts);
    if (!Object.keys(files).length) throw new Error("no curated input: pass --facts and/or --client-facts, or --scope client");
    const c = deriveCuratedRows(facts ? readJsonl(facts) : [], clientFacts ? readJsonl(clientFacts) : [], manifest.build);
    for (const [k, n] of Object.entries(c.skipped)) skipped.curated[k] = (skipped.curated[k] || 0) + n;
    notes = c.notes;
    loads.push({ kind: "curated", build: manifest.build, files, rows: dedupe(reject("curated", c.rows), skipped.curated) });
  }
  for (const l of loads) {
    l.batches = batch(l.rows);
    l.counts = count(l.rows);
  }
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
  const o = { apply: false, base: DEFAULT_BASE, maxCalls: 100, scope: "both" };
  let tokenFile = null;
  const val = (i, a) => { if (i + 1 >= argv.length) throw new Error(`missing value for ${a}`); return argv[i + 1]; };
  try {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === "--apply") o.apply = true;
      else if (a === "--dry-run") o.apply = false;
      else if (["--tables", "--traits", "--facts", "--client-facts", "--base", "--allow-host", "--state", "--max-calls", "--scope"].includes(a)) { o[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = val(i, a); i++; }
      else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
      else if (tokenFile === null) tokenFile = a;
      else throw new Error("only one token file");
    }
    if (!o.tables) throw new Error("usage: node tools/facts-load.mjs [<token-file>] --tables <dir> [--traits f] [--facts f] [--client-facts f] [--apply] [--base url] [--allow-host h] [--state f] [--max-calls n] [--scope client|curated|both]");
    if (!["client", "curated", "both"].includes(o.scope)) throw new Error("--scope is client, curated or both");
    o.maxCalls = Number(o.maxCalls);
    if (!Number.isInteger(o.maxCalls) || o.maxCalls < 1 || o.maxCalls > 118) throw new Error("--max-calls is a whole number from 1 to 118");
  } catch (e) { err(e.message); return 2; }

  let plan;
  try { plan = buildPlan({ tables: o.tables, traits: o.traits, facts: o.facts, clientFacts: o.clientFacts, scope: o.scope }); } catch (e) { err(`refusing: ${e.message}`); return 2; }
  log(`build ${plan.build}`);
  log(`manifest_sha256 ${plan.manifest_sha256}`);
  for (const l of plan.loads) {
    log(`load ${l.kind}: ${l.rows.length} rows in ${l.batches.length} batches, ${callsFor(l)} calls (begin, ${l.batches.length} rows, finish)`);
    for (const [k, n] of Object.entries(l.counts).sort()) log(`  ${k.padEnd(22)} ${String(n).padStart(6)}`);
    const sk = plan.skipped[l.kind];
    if (Object.keys(sk).length) log(`  skipped: ${Object.entries(sk).sort().map(([k, n]) => `${k} ${n}`).join(", ")}`);
  }
  if (plan.notes && (plan.notes.build_fallback || plan.notes.class_fallback)) log(`curated: build taken from the load for ${plan.notes.build_fallback} rows, source_class set to none for ${plan.notes.class_fallback} rows`);
  const totalCalls = plan.loads.reduce((s, l) => s + callsFor(l), 0);
  log(`total calls ${totalCalls}`);
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

  let lastTs = 0, calls = 0;
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
  const stateFor = (l) => {
    const p = o.state ? path.resolve(o.state) : path.join(os.tmpdir(), "leeroy-facts", `state-${l.kind}-${l.build}.json`);
    return assertOutsideRepo(p);
  };
  for (const l of plan.loads) {
    let sp;
    try { sp = stateFor(l); } catch (e) { err(`refusing: ${e.message}`); return 2; }
    const sha = planSha(l, plan.manifest_sha256);
    let st = null;
    try { st = existsSync(sp) ? JSON.parse(readFileSync(sp, "utf8")) : null; } catch { st = null; }
    if (st && (st.plan_sha !== sha || st.kind !== l.kind)) st = null; // a different plan: start over (the Worker marks the old open load failed after 30 minutes)
    const save = () => { mkdirSync(path.dirname(sp), { recursive: true }); writeFileSync(sp, JSON.stringify(st)); };
    const stop = (why, r) => { log(`stopped (${why}${r ? `: HTTP ${r.status}, reason ${okReason(r.json)}` : ""}); run the same command again to resume`); return 1; };
    if (!st) {
      if (calls >= o.maxCalls) return stop("call budget used up");
      const r = await send({ op: "begin", build: l.build, manifest_sha256: plan.manifest_sha256, files: l.files, kind: l.kind, expected: l.rows.length });
      if (r.status !== 200 || !r.json || r.json.ok !== true || typeof r.json.load_id !== "string") return stop(`begin ${l.kind} failed`, r);
      st = { plan_sha: sha, kind: l.kind, load_id: r.json.load_id, next: 0 };
      save();
      log(`begin ${l.kind}: load opened`);
    } else log(`resume ${l.kind}: ${st.next} of ${l.batches.length} batches already sent`);
    while (st.next < l.batches.length) {
      if (calls >= o.maxCalls) return stop("call budget used up");
      const r = await send({ op: "rows", load_id: st.load_id, rows: l.batches[st.next] });
      if (r.status !== 200 || !r.json || r.json.ok !== true) return stop(`rows batch ${st.next + 1} failed`, r);
      st.next++;
      save();
    }
    log(`rows ${l.kind}: ${l.batches.length} batches sent`);
    if (calls >= o.maxCalls) return stop("call budget used up");
    const f = await send({ op: "finish", load_id: st.load_id });
    if (f.status !== 200 || !f.json || f.json.ok !== true) return stop(`finish ${l.kind} failed`, f);
    const c = f.json.counts || {};
    log(`finish ${l.kind}: total ${c.total}, added ${c.added}, changed ${c.changed}, unchanged ${c.unchanged}, removed ${c.removed}`);
    try { unlinkSync(sp); } catch { /* already gone */ }
  }
  log(`done: ${calls} calls`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await run(process.argv.slice(2)));
