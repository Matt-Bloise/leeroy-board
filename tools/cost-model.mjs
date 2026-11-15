#!/usr/bin/env node
// Per-route cost model for the Worker on the Cloudflare free plan. Zero dependencies, no network, reads the checkout only.
//
//   node tools/cost-model.mjs                      markdown report for the checkout this file lives in
//   node tools/cost-model.mjs --json               the same numbers as JSON
//   node tools/cost-model.mjs --check              only verify that every anchor (a SQL or code fragment the model is built from) is still in the code
//   node tools/cost-model.mjs --root <dir>         read another checkout (for example a worktree of a pull request)
//   node tools/cost-model.mjs --diff                master against the PR 333 overlay: the routes and the scenarios that change
//   node tools/cost-model.mjs --assume-pr333       apply the PR 333 overlay (member documents never cached) to a tree that does not have it yet
//   node tools/cost-model.mjs --model <file.json> --scenario <file.json>   use another model or scenario (the unit test does, with a hand-checked fixture)
//   node tools/cost-model.mjs --bench              also time JSON.parse and stringify of the seeded documents (a node timing, not workerd; not part of the totals)
//
// What it does: the MODEL below is a hand-read table of what each route does (D1 statements with the table and rows they touch, Durable Object
// requests, outside calls, neurons, CPU). Every statement carries an ANCHOR, a text fragment that must still exist in the named source file; --check
// and every run fail when one is gone, so the table cannot drift silently from the code. Rows WRITTEN are not typed in: they come from infrastructure/schema.sql
// (one row for the table plus one per index, plus the automatic index of a TEXT or composite primary key). Limits come from the file wrangler.toml
// (each limit has an anchor in its comments). Rows READ are the hand estimate of what D1 scans, given the index that the SQL can use (see docs/audits/cost-model.md).
// Nothing here is a measurement of production: it is arithmetic on the code, and the report lists what it could not verify.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = path.resolve(HERE, "..");

// ------------------------------------------------------------------------------------------------------------------------------------------
// Reading the checkout
// ------------------------------------------------------------------------------------------------------------------------------------------
export function makeReader(root) {
  const cache = new Map();
  const read = (rel) => {
    if (!cache.has(rel)) {
      const p = path.join(root, rel);
      cache.set(rel, fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null);
    }
    return cache.get(rel);
  };
  return { root, read, exists: (rel) => fs.existsSync(path.join(root, rel)), has: (rel, text) => { const s = read(rel); return s !== null && s.includes(text); } };
}

// schema.sql -> { table: { pk: "rowid" | "auto" , indexes: n } }. "rowid" means INTEGER PRIMARY KEY (no second b-tree); anything else with a primary key has an automatic index.
export function parseSchema(sql) {
  const tables = {};
  if (!sql) return tables;
  for (const m of sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]*?)\n\);/g)) {
    const body = m[2];
    const composite = /PRIMARY KEY\s*\(/i.test(body);
    const single = /^\s*\w+\s+(\w+)[^,\n]*PRIMARY KEY/im.exec(body);
    let pk = "none";
    if (composite) pk = "auto";
    else if (single) pk = /^INTEGER$/i.test(single[1]) ? "rowid" : "auto";
    tables[m[1]] = { pk, indexes: 0 };
  }
  for (const m of sql.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS\s+\w+\s+ON\s+(\w+)\s*\(/g)) if (tables[m[1]]) tables[m[1]].indexes += 1;
  return tables;
}

// Rows written by one statement. insert/upsert-insert: table row + every index entry. update: the table row, plus `idx` (the number of indexed columns the statement changes).
// delete: same as insert per row. replace (INSERT OR REPLACE over an existing row) is counted like an insert: the lower bound (SQLite deletes and re-inserts; whether D1 bills both is unverified).
export function writeRows(schema, table, op, rows = 1, idx = 0) {
  const t = schema[table];
  if (!t) throw new Error(`table ${table} is not in schema.sql`);
  const perInsert = 1 + t.indexes + (t.pk === "auto" ? 1 : 0);
  if (op === "update") return rows * (1 + idx);
  if (op === "insert" || op === "delete" || op === "replace") return rows * perInsert;
  throw new Error(`unknown write op ${op}`);
}

export function parseWrangler(text) {
  const out = { crons: [], vars: {} };
  if (!text) return out;
  const c = /^crons\s*=\s*\[([^\]]*)\]/m.exec(text);
  if (c) out.crons = [...c[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const v = text.indexOf("[vars]");
  if (v >= 0) for (const m of text.slice(v).matchAll(/^([A-Z][A-Z0-9_]*)\s*=\s*"([^"]*)"/gm)) out.vars[m[1]] = m[2];
  return out;
}

// ------------------------------------------------------------------------------------------------------------------------------------------
// The cost vector. req = Worker requests (billed), d1q = D1 queries, rr/rw = D1 rows read / written, doReq = Durable Object requests,
// ext = outside subrequests (provider APIs, Discord REST), neurons = Workers AI neurons, cpuMs = estimated CPU of the request,
// subreq = what one invocation spends against the 50-per-invocation subrequest budget (assumption: D1 queries and Durable Object fetches count; the repo says so in kv-cas.js).
// ------------------------------------------------------------------------------------------------------------------------------------------
export const ZERO = () => ({ req: 0, d1q: 0, rr: 0, rw: 0, doReq: 0, ext: 0, neurons: 0, cpuMs: 0, subreq: 0 });
const addTo = (a, b, k = 1) => { for (const key of Object.keys(a)) a[key] += (b[key] || 0) * k; return a; };

// A number, "$param" (looked up in params) or { p: "param", k: multiplier }.
export function num(x, params) {
  if (x === undefined || x === null) return 0;
  if (typeof x === "number") return x;
  if (typeof x === "string" && x[0] === "$") { const v = params[x.slice(1)]; if (!Number.isFinite(v)) throw new Error(`parameter ${x} is not a number`); return v; }
  if (typeof x === "object" && typeof x.p === "string") return num("$" + x.p, params) * (x.k === undefined ? 1 : x.k);
  throw new Error(`cannot read ${JSON.stringify(x)} as a number`);
}

export function costOf(spec, schema, params, cpuModel) {
  const c = ZERO();
  for (const s of spec.stmts || []) {
    if (s.when !== undefined && !(num(s.when, params) > 0)) continue;
    if (s.only === "pr333" && !params.pr333) continue;
    const n = s.n === undefined ? 1 : num(s.n, params);
    const rows = params.pr333 && s.rowsPr333 !== undefined ? s.rowsPr333 : s.rows === undefined ? 1 : num(s.rows, params);
    c.d1q += n;
    if (s.op === "read") c.rr += n * rows;
    else {
      c.rr += n * num(s.readRows, params);
      c.rw += n * writeRows(schema, s.table, s.op, rows, s.idx || 0);
    }
  }
  const cpu = spec.cpu || {};
  c.cpuMs = ((cpu.fixedMs || 0) + (cpu.parseKB || 0) * cpuModel.parseMsPerKB + (cpu.stringifyKB || 0) * cpuModel.stringifyMsPerKB) * (params.cpuScale === undefined ? 1 : params.cpuScale);
  c.req = spec.req || 0;
  c.doReq = num(spec.do, params);
  c.ext = num(spec.ext, params);
  c.neurons = num(spec.neurons, params);
  c.subreq = c.d1q + c.doReq + c.ext + (spec.ai || 0);
  return c;
}

const effective = (ep, pr333) => (pr333 && ep.pr333 ? { ...ep, ...ep.pr333 } : ep);
const treeHasPr333 = (rd) => rd.exists("infrastructure/worker/public-party.js");

export function anchorsOf(model, { pr333Tree = false } = {}) {
  const list = [];
  const add = (where, file, text) => { if (text) list.push({ where, file, text }); };
  for (const [id, e] of Object.entries(model.endpoints)) {
    for (const s of (e.miss && e.miss.stmts) || []) if (s.only !== "pr333" || pr333Tree) add(id, s.file || e.file, s.a);
    for (const a of (e.miss && e.miss.anchors) || []) add(id, a[0], a[1]);
    if (pr333Tree && e.pr333 && e.pr333.miss) {
      for (const s of e.pr333.miss.stmts || []) add(`${id} (PR 333)`, s.file || e.file, s.a);
      for (const a of e.pr333.miss.anchors || []) add(`${id} (PR 333)`, a[0], a[1]);
    }
  }
  for (const [id, d] of Object.entries(model.drivers)) for (const s of (d.flat && d.flat.stmts) || []) add(`driver ${id}`, s.file, s.a);
  for (const [k, l] of Object.entries(model.limits)) add(`limit ${k}`, l.file, l.a);
  for (const [k, l] of Object.entries(model.perRequest || {})) add(`per-request ${k}`, l.file, l.a);
  return list;
}

export function checkAnchors(model, rd) {
  const list = anchorsOf(model, { pr333Tree: treeHasPr333(rd) });
  return { checked: list.length, missing: list.filter((a) => !a.file || !rd.has(a.file, a.text)) };
}

// ------------------------------------------------------------------------------------------------------------------------------------------
// The scenario engine
// ------------------------------------------------------------------------------------------------------------------------------------------
// scenario = { name, spanHours (hours the traffic is spread over, drives cache hits), colos (data centres that cache separately), params?, loads: [{ driver, count }] }
// driver   = { unit, calls: [{ ep, n | everySec (+hours), purges? , only? }], flat?: cost spec added once per unit (cron), note }
export function runScenario(model, schema, scenario, { pr333 = false } = {}) {
  const params = { ...model.params, ...(scenario.params || {}), pr333: pr333 ? 1 : 0 };
  const spanSec = (scenario.spanHours || 24) * 3600;
  const colos = scenario.colos || 1;
  const demand = {}, purges = {};
  const flat = ZERO();
  for (const load of scenario.loads) {
    const d = model.drivers[load.driver];
    if (!d) throw new Error(`unknown driver ${load.driver}`);
    for (const call of d.calls || []) {
      if (call.only === "pr333" && !pr333) continue;
      if (call.only === "master" && pr333) continue;
      const ep = model.endpoints[call.ep];
      if (!ep) throw new Error(`driver ${load.driver} calls unknown endpoint ${call.ep}`);
      let n = call.n;
      if (n === undefined) n = (call.hours === undefined ? 1 : call.hours) * 3600 / Math.max(call.everySec, effective(ep, pr333).browserTtlSec || 0, 1);
      demand[call.ep] = (demand[call.ep] || 0) + n * load.count;
      for (const p of call.purges || []) purges[p] = (purges[p] || 0) + n * load.count;
    }
    if (d.flat) addTo(flat, costOf(d.flat, schema, params, model.cpuModel), load.count);
  }
  const total = ZERO();
  const byEp = {};
  let maxCpu = { id: null, ms: 0 }, maxSub = { id: null, n: 0 };
  for (const [id, dem] of Object.entries(demand)) {
    const ep = effective(model.endpoints[id], pr333);
    const miss = costOf(ep.miss || {}, schema, params, model.cpuModel);
    miss.req = ep.noReq ? 0 : 1;
    const hit = ZERO();
    hit.req = 1;
    hit.cpuMs = ep.hitCpuMs === undefined ? 0.1 : ep.hitCpuMs;
    let misses = dem;
    if (ep.cache) misses = Math.min(dem, Math.floor(spanSec / ep.cache.ttlSec) * colos * (ep.cache.keys || 1) + (purges[id] || 0));
    const hits = dem - misses;
    const c = ZERO();
    addTo(c, hit, hits);
    addTo(c, miss, misses);
    byEp[id] = { demand: dem, misses, hits, cost: c, missCost: miss, cached: Boolean(ep.cache) };
    addTo(total, c);
    if (misses > 0 && miss.cpuMs > maxCpu.ms) maxCpu = { id, ms: miss.cpuMs };
    if (misses > 0 && miss.subreq > maxSub.n) maxSub = { id, n: miss.subreq };
  }
  addTo(total, flat);
  for (const load of scenario.loads) {
    if (!(load.count > 0)) continue;
    const b = bundleOf(model, schema, load.driver, params, pr333);
    if (!b) continue;
    if (b.cpuMs > maxCpu.ms) maxCpu = { id: `${load.driver} (request + answer in one invocation)`, ms: b.cpuMs };
    if (b.subreq > maxSub.n) maxSub = { id: `${load.driver} (request + answer in one invocation)`, n: b.subreq };
  }
  return { total, byEp, flat, maxCpu, maxSub, params };
}

// A request that hands work to waitUntil (an ask) is ONE invocation: the answer's CPU and subrequests add to the request that started it.
// Returns the bundles of a driver: [{ cpuMs, subreq }] for its calls that are not separate requests, joined to the request before them.
export function bundleOf(model, schema, driverId, params, pr333) {
  const d = model.drivers[driverId];
  if (!d || !(d.calls || []).some((c) => model.endpoints[c.ep] && model.endpoints[c.ep].noReq)) return null;
  const t = { cpuMs: 0, subreq: 0 };
  let host = null;
  for (const c of d.calls) {
    const ep = effective(model.endpoints[c.ep], pr333);
    if (c.n === undefined || c.n !== 1) continue; // polls are their own requests
    const cost = costOf(ep.miss || {}, schema, params, model.cpuModel);
    if (!ep.noReq) { if (host === null) host = c.ep; else continue; }
    t.cpuMs += cost.cpuMs; t.subreq += cost.subreq;
  }
  return { host, ...t };
}

export function limitsReport(model, total) {
  return Object.entries(model.limits).map(([key, l]) => ({ key, label: l.label, field: l.field, limit: l.limit, used: total[l.field], pct: total[l.field] / l.limit * 100, soft: l.soft || null }));
}
export const firstLimit = (rep) => rep.slice().sort((a, b) => b.pct - a.pct)[0];

// The factor f by which the listed drivers' counts (as in the scenario) can be multiplied before some limit is reached (f < 1: the scenario is already over a limit).
// Bisection on a real number; null when even a million times the scenario stays under every limit.
export function solveScale(model, schema, scenario, drivers, opts) {
  const at = (f) => {
    const loads = scenario.loads.map((l) => (drivers.includes(l.driver) ? { ...l, count: l.count * f } : l));
    const rep = limitsReport(model, runScenario(model, schema, { ...scenario, loads }, opts).total);
    return rep.filter((x) => x.used >= x.limit).sort((a, b) => b.pct - a.pct)[0] || null;
  };
  if (!at(1e6)) return null;
  let lo = 0, hi = 1e6;
  for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; if (at(mid)) hi = mid; else lo = mid; }
  const hit = at(hi);
  return { factor: hi, counts: scenario.loads.filter((l) => drivers.includes(l.driver)).map((l) => ({ driver: l.driver, count: l.count * hi })), limit: hit.label, key: hit.key };
}

// For every non-baseline driver: what one unit costs, and how many units a day (alone, on the standing baseline) reach each limit.
export function aloneTable(model, schema, base, opts) {
  const out = [];
  for (const [id, d] of Object.entries(model.drivers)) {
    if (d.baseline) continue;
    const run = (n) => runScenario(model, schema, { ...base, loads: [...base.loads, { driver: id, count: n }] }, opts).total;
    const floor = run(0), one = run(1);
    const unit = ZERO();
    for (const k of Object.keys(unit)) unit[k] = one[k] - floor[k];
    const reach = {};
    for (const [key, l] of Object.entries(model.limits)) {
      if (!(run(1e7)[l.field] >= l.limit)) { reach[key] = null; continue; }
      let lo = 0, hi = 1e7;
      while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (run(mid)[l.field] >= l.limit) hi = mid; else lo = mid; }
      reach[key] = hi;
    }
    out.push({ id, unitLabel: d.unit, unit, reach });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------------------------------------------------
// THE MODEL. Read this with the code open: every statement names the file and a fragment of its SQL (the anchor).
// rows = rows D1 reads for that statement given the index its WHERE can use (schema.sql); a PRIMARY KEY or UNIQUE lookup reads 1 row. Writes are derived from schema.sql.
// "when" lines only count in the case named (for example a party member without a stored sheet row).
// ------------------------------------------------------------------------------------------------------------------------------------------
const IDX = "infrastructure/worker/index.js", KVC = "infrastructure/worker/kv-cas.js", AUTH = "infrastructure/worker/auth.js", AIM = "infrastructure/worker/ai-models.js";
const BUD = "infrastructure/worker/budget.js", UX = "infrastructure/worker/answer-ux.js", DIS = "infrastructure/worker/discord.js", REP = "infrastructure/worker/replay.js";
const SCR = "infrastructure/worker/scraper.js", VOT = "infrastructure/worker/votes.js", PP = "infrastructure/worker/public-party.js", ROOM = "infrastructure/worker/room.js";
const r = (file, a, table, rows = 1, more = {}) => ({ file, a, table, op: "read", rows, ...more });
const w = (file, a, table, op, more = {}) => ({ file, a, table, op, ...more });

const Q_KV8 = r(IDX, "key IN ('party','timeline','stats','signups','tonight','launch','marks','decide')", "kv_state", 8);
const Q_KV7 = r(IDX, "key IN ('party','timeline','stats','signups','tonight','launch','decide')", "kv_state", 7);
const Q_SHEETS = r(IDX, "SELECT json FROM kv_state WHERE key = 'party_sheets'", "kv_state", 1);
const Q_PARTY = r(IDX, "SELECT json FROM kv_state WHERE key = 'party'", "kv_state", 1);
const Q_KVDOC = r(IDX, "SELECT json, updated_at FROM kv_state WHERE key = ?", "kv_state", 1);
const Q_MEMBERS = r(AUTH, "SELECT slug, key_hash FROM members", "members", "$members");
const Q_EVENTS_KEY = r(IDX, "SELECT MAX(id) AS m, COUNT(*) AS c FROM sheet_events", "sheet_events", "$sheetEventRows", { when: "$sheetlessMembers" });
const Q_EVENTS_PR = { ...Q_EVENTS_KEY, only: "pr333" }; // the sheet_events key read PR 333 adds when a party member has no stored sheet
const W_INTENT = w(IDX, "INSERT INTO intents (at, slug, kind, body, ver) VALUES (?, ?, ?, ?, ?)", "intents", "insert");
// commitSheetWrite (kv-cas.js): one read of two rows, then one batch of UPDATE sheets, UPDATE party, INSERT event, SELECT verdict.
const SHEET_COMMIT = [
  r(KVC, "SELECT key, json FROM kv_state WHERE key IN ('party_sheets', 'party')", "kv_state", 2),
  w(KVC, "UPDATE kv_state SET json = ?, updated_at = ? WHERE key = 'party_sheets' AND json = ?", "kv_state", "update", { readRows: 3 }),
  w(KVC, "UPDATE kv_state SET json = ?, updated_at = ? WHERE key = 'party' AND json = ?", "kv_state", "update", { readRows: 2 }),
  w(KVC, "INSERT INTO sheet_events (slug, name, field, value_json, visible, source, created_at) SELECT", "sheet_events", "insert", { readRows: 1 }),
  r(KVC, "SELECT 1 AS ok FROM kv_state WHERE key = 'party_sheets' AND updated_at = ?", "kv_state", 1),
];
const FLOOR = [ // every signed Discord interaction except PING: the replay row, and one amortised purge (a row is deleted once for every row inserted)
  w(REP, "INSERT OR IGNORE INTO discord_events (id, tenant_id, kind, payload_hash, created_at) ", "discord_events", "insert", { readRows: 2 }),
  w(REP, "DELETE FROM discord_events WHERE created_at < ?", "discord_events", "delete", { n: 0.1, rows: 10, readRows: 10 }),
];
const BUDGET_READ = r(BUD, "SELECT json FROM kv_state WHERE key = ?", "kv_state", 1);
const RECORD_ATTRIBUTED = [ // user row and tenant row: a read and an INSERT OR REPLACE each (budget.js recordAttributed)
  { ...BUDGET_READ, n: 2 },
  w(BUD, "INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES (?, ?, ?)", "kv_state", "replace", { n: 2 }),
];
const ANSWER_COMMON = (extra = []) => [
  r(AIM, "FROM ask_turns t JOIN ask_turn_askers a2", "ask_turns", "$findRecentRows"),
  r(AIM, "SELECT id, category, title, as_of, blurb, aliases_json, facts_json, open_json FROM lib_pages", "lib_pages", "$libPages"),
  r(AIM, "'signups', 'timeline', 'tonight')", "kv_state", 4, { rowsPr333: 3 }), // PR 333 leaves the party row to the sheets read below
  Q_SHEETS, Q_PARTY, Q_EVENTS_PR,
  r(AIM, "SELECT stamp FROM lib_blobs WHERE name = 'index.json'", "lib_blobs", 1),
  ...extra,
];
const ANSWER_TAIL = [
  w(AIM, "UPDATE ask_turns SET answer = ?, cites_json = ?, model = ?, status = 'answered'", "ask_turns", "update", { readRows: 1 }),
  r(AIM, "SELECT json FROM kv_state WHERE key = 'stats'", "kv_state", 1),
  w(AIM, "UPDATE kv_state SET json = ?, updated_at = ? WHERE key = 'stats'", "kv_state", "update"),
];
const WAI_RESERVE = [ // Workers AI only: the global neuron record is read, a reservation is added, the real cost is reconciled
  { ...BUDGET_READ },
  w(BUD, "INSERT INTO kv_state (key, json, updated_at) VALUES (?1, ?2, ?3) ", "kv_state", "update", { readRows: 1 }),
  w(BUD, "UPDATE kv_state SET json = json_set(json, '$.neurons', MAX(0", "kv_state", "update"),
];
const ANSWER_CPU = { fixedMs: 5, parseKB: 625 }; // lib_pages parsed three JSON columns a page (625 KB measured in the seed data) plus up to 4 ranking passes and the text clean-up (the fixed part is a guess)

export const MODEL = {
  flagsOff: ["MOMENTS_ENABLED", "MOMENTS_SHADOW", "MOMENTS_DRY_RUN", "CARDS_ENABLED", "CARDS_SHADOW", "BOARD_LINES_ENABLED", "ANSWER_UX", "ASK_OPENER", "ASK_RESEARCH", "INTEREST_NUDGES", "D1_FEED", "WEB_LOGIN", "REQUEST_GAUGE", "BUILD_MODAL", "BUILD_PROJECT", "JOIN_PROMPT", "SETUP_COMMAND", "EVENTS_ENABLED"], // the model prices the defaults: every one of these "off"
  expectedCrons: ["0 */6 * * *", "* * * * *"],
  params: {
    members: 5,               // rows of the members table (the five)
    sheetEventRows: 300,      // sheet_events rows (assumption: not knowable from the code; each hide, show or edit adds one)
    sheetlessMembers: 0,      // party-document members with no stored sheet row (0 normally; a newly added person is 1 until their first write)
    votes: 3, voteBallots: 15, // open and recent votes in the index (max 50) and ballot rows over them
    memberAskHistory: 30, findRecentRows: 61, // a member's lifetime asks; the reuse check reads 1 + 2N rows (2N+1)
    libPages: 71,             // lib_pages rows (seed data: 71 pages)
    intentsPending: 50,       // rows in the intents mailbox nobody has acknowledged
    libSources: 12,           // sources one sweep checks (LIMIT 12)
    proposalRows: 100,        // wiki_proposals rows scanned by a duplicate check (no index on the filtered columns)
    neuronsPerAsk: 105,       // Workers AI neurons one answer reserves: about 72 for 350 output tokens plus about 33 for a 5k-character prompt (budget.js rates)
    cronNeurons: 0,           // neurons one changed source costs in the sweep: 0 while AI_PROVIDER is claude, about 155 on Workers AI
    cpuScale: 1,              // ratio of a Cloudflare isolate to the node timings measured here (not verifiable here; 1 = same speed; see the CPU headroom column)
  },
  cpuModel: { parseMsPerKB: 0.003, stringifyMsPerKB: 0.0016 }, // node 22 on the build container: decide.json 152 KB parses in 0.36 ms and stringifies in 0.19 ms (tools/cost-model.mjs --bench)
  limits: {
    requests: { label: "Worker requests (100,000/day)", field: "req", limit: 100000, file: "docs/runbooks/cloudflare-requests.md", a: "100,000 requests per UTC day" },
    d1Reads: { label: "D1 rows read (5M/day)", field: "rr", limit: 5000000, file: "infrastructure/wrangler.toml", a: "5M reads/day, 100k writes/day" },
    d1Writes: { label: "D1 rows written (100k/day)", field: "rw", limit: 100000, file: "infrastructure/wrangler.toml", a: "5M reads/day, 100k writes/day" },
    neurons: { label: "Workers AI neurons (10,000/day; soft cap 8,000)", field: "neurons", limit: 10000, soft: 8000, file: "infrastructure/wrangler.toml", a: "10,000 Neurons/day" },
    doRequests: { label: "Durable Object requests (100k/day)", field: "doReq", limit: 100000, file: "infrastructure/wrangler.toml", a: "100k req/day" },
  },
  perRequest: {
    cpu: { label: "CPU per request (10 ms)", limit: 10, file: "infrastructure/worker/ai-models.js", a: "Free plan: 10 ms CPU" },
    subrequests: { label: "Subrequests per invocation (50)", limit: 50, file: "docs/roadmap/research/notes-R2-discord-platform.md", a: "50 subrequests per invocation" },
  },
  endpoints: {
    "GET /api/bootstrap": {
      file: IDX, cache: { ttlSec: 60 }, browserTtlSec: 15, note: "edge 60 s (s-maxage), browser max-age 15",
      miss: { stmts: [Q_KV8, Q_SHEETS], cpu: { fixedMs: 0.6, parseKB: 250, stringifyKB: 250 } },
      pr333: { cache: null, browserTtlSec: 0, miss: { stmts: [Q_KV8, Q_SHEETS, Q_EVENTS_KEY], cpu: { fixedMs: 1.6, parseKB: 250, stringifyKB: 250 } } },
    },
    "GET /api/state": {
      file: IDX, cache: { ttlSec: 30 }, browserTtlSec: 10, note: "edge 30 s, browser max-age 10",
      miss: { stmts: [Q_KV7, Q_SHEETS], cpu: { fixedMs: 0.6, parseKB: 190, stringifyKB: 190 } },
      pr333: { cache: null, browserTtlSec: 0, miss: { stmts: [Q_KV7, Q_SHEETS, Q_EVENTS_KEY], cpu: { fixedMs: 1.4, parseKB: 190, stringifyKB: 190 } } },
    },
    "GET /api/data/party": {
      file: IDX, cache: { ttlSec: 60 }, browserTtlSec: 15, note: "9.5 KB document",
      miss: { stmts: [Q_KVDOC], cpu: { fixedMs: 0.3, parseKB: 10, stringifyKB: 10 } },
      pr333: { cache: null, browserTtlSec: 0, miss: { stmts: [Q_KVDOC, Q_SHEETS, Q_EVENTS_KEY], cpu: { fixedMs: 0.8, parseKB: 10, stringifyKB: 10 } } },
    },
    "GET /api/data/decide": {
      file: IDX, cache: { ttlSec: 60 }, browserTtlSec: 15, note: "151 KB document",
      miss: { stmts: [Q_KVDOC], cpu: { fixedMs: 0.3, parseKB: 152, stringifyKB: 152 } },
      pr333: { cache: null, browserTtlSec: 0, miss: { stmts: [Q_KVDOC, Q_PARTY, Q_SHEETS, Q_EVENTS_KEY], cpu: { fixedMs: 1.5, parseKB: 162, stringifyKB: 152 } } },
    },
    "GET /api/data/client": {
      file: IDX, cache: { ttlSec: 60 }, browserTtlSec: 15, note: "226 KB document; at master the page reads the static file (not a Worker request), PR 333 reads it from the Worker",
      miss: { stmts: [Q_KVDOC], cpu: { fixedMs: 0.3, parseKB: 226, stringifyKB: 226 } },
      pr333: { cache: null, browserTtlSec: 0, miss: { stmts: [Q_KVDOC, Q_PARTY, Q_SHEETS, Q_EVENTS_KEY], cpu: { fixedMs: 1.8, parseKB: 236, stringifyKB: 226 } } },
    },
    "GET /api/data/guided-atlas": {
      file: IDX, cache: { ttlSec: 60 }, browserTtlSec: 15, note: "3.7 KB document, one scene",
      miss: { stmts: [Q_KVDOC], cpu: { fixedMs: 0.3, parseKB: 4, stringifyKB: 4 } },
      pr333: { cache: null, browserTtlSec: 0, miss: { stmts: [Q_KVDOC, Q_PARTY, Q_SHEETS, Q_EVENTS_KEY], cpu: { fixedMs: 0.8, parseKB: 14, stringifyKB: 4 } } },
    },
    "GET /api/signups": { file: IDX, cache: { ttlSec: 15 }, browserTtlSec: 15, miss: { stmts: [r(IDX, "SELECT json FROM kv_state WHERE key = 'signups'", "kv_state", 1)], cpu: { fixedMs: 0.3, parseKB: 2, stringifyKB: 2 } } },
    "GET /api/votes": {
      file: IDX, cache: { ttlSec: 10 }, browserTtlSec: 10, note: "1 + V + 1 queries for V votes (V up to 50: more than the 50 queries a free invocation may issue, if that limit applies)",
      miss: { stmts: [r(VOT, "SELECT json FROM kv_state WHERE key = 'votes:index'", "kv_state", 1), r(VOT, "SELECT json FROM kv_state WHERE key = ?", "kv_state", 1, { n: "$votes" }),
        r(VOT, "FROM vote_ballots WHERE vote_id IN", "vote_ballots", "$voteBallots")], cpu: { fixedMs: 0.4 } },
    },
    "GET /api/library/index.json": { file: IDX, cache: { ttlSec: 120 }, browserTtlSec: 30, note: "edge s-maxage 4 x 30 s; 59 KB served as text", miss: { stmts: [r(IDX, "SELECT json, stamp FROM lib_blobs WHERE name = ?", "lib_blobs", 1)], cpu: { fixedMs: 0.3 } } },
    "GET /api/library/<other blob>": { file: IDX, cache: { ttlSec: 14400, keys: 12 }, browserTtlSec: 3600, note: "11 category files and search.json, edge s-maxage 4 x 3600 s", miss: { stmts: [r(IDX, "SELECT json, stamp FROM lib_blobs WHERE name = ?", "lib_blobs", 1)], cpu: { fixedMs: 0.3 } } },
    "GET /api/me": { file: IDX, miss: { stmts: [], cpu: { fixedMs: 0.4 } }, note: "the members table is cached 15 min per isolate (counted in the standing baseline)" },
    "GET /api/sheet": { file: IDX, miss: { stmts: [Q_SHEETS, Q_PARTY, Q_EVENTS_PR], cpu: { fixedMs: 0.5, parseKB: 20, stringifyKB: 20 } } },
    "GET /api/ask?id= (member poll)": { file: IDX, miss: { stmts: [r(IDX, "SELECT * FROM ask_turns WHERE id = ?", "ask_turns", 1)], cpu: { fixedMs: 0.4 } } },
    "GET /api/ask?id= (guest poll)": { file: IDX, miss: { stmts: [r(IDX, "SELECT * FROM ask_turns WHERE id = ?", "ask_turns", 1),
      r(IDX, "SELECT COUNT(*) AS count FROM guest_rate_limits WHERE ip_hash = ? AND created_at > ?", "guest_rate_limits", 2)], cpu: { fixedMs: 0.6 } } },
    "GET /api/live (WebSocket upgrade)": { file: ROOM, miss: { stmts: [], do: 1, cpu: { fixedMs: 0.5 }, anchors: [[ROOM, "acceptWebSocket"]] } },
    "GET /api/health": { file: IDX, miss: { stmts: [r(IDX, 'prepare("SELECT 1")', "kv_state", 0)], cpu: { fixedMs: 0.2 } } },
    "POST /api/sheet (write)": {
      file: IDX, miss: { stmts: [Q_MEMBERS, ...SHEET_COMMIT, W_INTENT], do: 1, cpu: { fixedMs: 1.2, parseKB: 30, stringifyKB: 30 } }, note: "also purges /api/bootstrap, /api/state, /api/data/party",
      pr333: { miss: { stmts: [Q_MEMBERS, ...SHEET_COMMIT, W_INTENT, Q_EVENTS_KEY], do: 1, cpu: { fixedMs: 2, parseKB: 30, stringifyKB: 30 } } },
    },
    "POST /api/signups (write)": { file: IDX, miss: { stmts: [Q_MEMBERS, r(KVC, "SELECT json FROM kv_state WHERE key = ?", "kv_state", 1),
      w(KVC, "UPDATE kv_state SET json = ?, updated_at = ? WHERE key = ? AND json = ? RETURNING key", "kv_state", "update"), W_INTENT], do: 1, cpu: { fixedMs: 0.8, parseKB: 4, stringifyKB: 4 } }, note: "a lost race repeats the read and update (up to 8 tries); one try counted" },
    "POST /api/intent launch": { file: IDX, miss: { stmts: [Q_MEMBERS, r(IDX, "SELECT json FROM kv_state WHERE key = 'launch'", "kv_state", 1),
      w(IDX, "INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES ('launch', ?, ?)", "kv_state", "replace"),
      ...SHEET_COMMIT, W_INTENT], do: 2, cpu: { fixedMs: 1.5, parseKB: 30, stringifyKB: 30 } },
      pr333: { miss: { stmts: [Q_MEMBERS, r(IDX, "SELECT json FROM kv_state WHERE key = 'launch'", "kv_state", 1), w(IDX, "INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES ('launch', ?, ?)", "kv_state", "replace"),
        ...SHEET_COMMIT, W_INTENT, Q_PARTY, Q_SHEETS, Q_EVENTS_KEY], do: 2, cpu: { fixedMs: 2.5, parseKB: 30, stringifyKB: 30 } } } },
    "POST /api/intent journey": { file: IDX, miss: { stmts: [Q_MEMBERS, r(KVC, "SELECT json FROM kv_state WHERE key = ?", "kv_state", 1),
      w(KVC, "UPDATE kv_state SET json = ?, updated_at = ? WHERE key = ? AND json = ? RETURNING key", "kv_state", "update"), W_INTENT], cpu: { fixedMs: 0.6, parseKB: 4, stringifyKB: 4 } } },
    "POST /api/intent ask (member)": { file: IDX, miss: { stmts: [Q_MEMBERS,
      w(UX, "INSERT INTO ask_turns (id, by_name, question, model, status, share, created_at)", "ask_turns", "insert"),
      w(UX, "INSERT OR IGNORE INTO ask_turn_askers (intent_id, asker_hash) VALUES (?, ?)", "ask_turn_askers", "insert"), W_INTENT], do: 1, cpu: { fixedMs: 1.2 } } },
    "POST /api/intent ask (guest)": { file: IDX, miss: { stmts: [
      r(IDX, "SELECT COUNT(*) AS count, MIN(created_at) AS oldest FROM guest_rate_limits WHERE ip_hash = ? AND created_at > ?", "guest_rate_limits", 2),
      w(IDX, "INSERT INTO guest_rate_limits (ip_hash, created_at) VALUES (?, ?)", "guest_rate_limits", "insert"),
      r(IDX, "AND rowid <= ?", "guest_rate_limits", 3),
      w(IDX, "DELETE FROM guest_rate_limits WHERE created_at < ?", "guest_rate_limits", "delete", { readRows: 2 }),
      w(UX, "INSERT INTO ask_turns (id, by_name, question, model, status, share, created_at)", "ask_turns", "insert"),
      w(UX, "INSERT OR IGNORE INTO ask_turn_askers (intent_id, asker_hash) VALUES (?, ?)", "ask_turn_askers", "insert"), W_INTENT], do: 1, cpu: { fixedMs: 1.4 } } },
    "POST /api/intent ask (guest, refused 429)": { file: IDX, miss: { stmts: [r(IDX, "SELECT COUNT(*) AS count, MIN(created_at) AS oldest FROM guest_rate_limits WHERE ip_hash = ? AND created_at > ?", "guest_rate_limits", 2)], cpu: { fixedMs: 0.8 } } },
    "answer: member on Claude (shared)": { file: AIM, noReq: true, note: "runs inside the ask request (waitUntil); the shared answer posts 2 broadcasts", miss: { stmts: [...ANSWER_COMMON([{ ...BUDGET_READ, n: 2 }]), ...RECORD_ATTRIBUTED, ...ANSWER_TAIL], do: 2, ext: 1, cpu: ANSWER_CPU } },
    "answer: member on Workers AI (shared)": { file: AIM, noReq: true, miss: { stmts: [...ANSWER_COMMON([{ ...BUDGET_READ, n: 2 }, ...WAI_RESERVE]), ...RECORD_ATTRIBUTED, ...ANSWER_TAIL], do: 2, ai: 1, neurons: "$neuronsPerAsk", cpu: ANSWER_CPU } },
    "answer: guest on Workers AI (private)": { file: AIM, noReq: true, miss: { stmts: [...ANSWER_COMMON([{ ...BUDGET_READ, n: 1 }, ...WAI_RESERVE]), ...RECORD_ATTRIBUTED, ...ANSWER_TAIL].map((s) => (s.a && s.a.startsWith("FROM ask_turns t JOIN") ? { ...s, rows: 3 } : s)), do: 1, ai: 1, neurons: "$neuronsPerAsk", cpu: ANSWER_CPU } },
    "answer: abstain from the library (no model)": { file: AIM, noReq: true, miss: { stmts: [...ANSWER_COMMON(), ...ANSWER_TAIL], do: 2, cpu: { fixedMs: 3, parseKB: 625 } } },
    "answer: refused by the budget": { file: AIM, noReq: true, miss: { stmts: [...ANSWER_COMMON([{ ...BUDGET_READ, n: 3 }]), w(AIM, "UPDATE ask_turns SET answer = ?, cites_json = ?, model = ?, status = 'answered'", "ask_turns", "update", { readRows: 1 })], do: 1, cpu: { fixedMs: 3, parseKB: 625 } }, note: "the library read and the ranking happen before the budget check" },
    "POST /api/intent refresh (accepted)": { file: IDX, miss: { stmts: [Q_MEMBERS, w(SCR, "ON CONFLICT(key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at WHERE kv_state.updated_at <= ?4", "kv_state", "update", { readRows: 1 }), W_INTENT], do: 1, cpu: { fixedMs: 0.8 } }, note: "then runs one sweep in waitUntil (driver sweep_changed)" },
    "POST /api/intent refresh (cooldown 429)": { file: IDX, miss: { stmts: [Q_MEMBERS, w(SCR, "ON CONFLICT(key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at WHERE kv_state.updated_at <= ?4", "kv_state", "update", { rows: 0, readRows: 1 }), r(SCR, "SELECT updated_at FROM kv_state WHERE key = ?", "kv_state", 1)], cpu: { fixedMs: 0.6 } } },
    "PUT /api/data/<doc> (admin)": { file: IDX, miss: { stmts: [w(IDX, "INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES (?, ?, ?)", "kv_state", "replace")], do: 1, cpu: { fixedMs: 0.8, parseKB: 150, stringifyKB: 300 } },
      pr333: { miss: { stmts: [w(IDX, "INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES (?, ?, ?)", "kv_state", "replace"), Q_PARTY, Q_SHEETS, Q_EVENTS_KEY], do: 1, cpu: { fixedMs: 1.6, parseKB: 300, stringifyKB: 300 } } } },
    "GET /api/intents (the PC bot's poll, admin)": { file: IDX, miss: { stmts: [r(IDX, "SELECT seq, at, slug, kind, body, ver FROM intents WHERE seq > ? ORDER BY seq ASC LIMIT ?", "intents", { p: "intentsPending" }),
      r(IDX, "SELECT COUNT(*) AS count FROM intents", "intents", "$intentsPending")], cpu: { fixedMs: 0.5, parseKB: 10 } }, note: "COUNT(*) scans every pending row on every poll; rows leave only through POST /api/ack" },
    "POST /api/discord (bad signature or stale)": { file: DIS, miss: { stmts: [], cpu: { fixedMs: 0.8 }, anchors: [[DIS, "verify"]] } },
    "POST /api/discord PING": { file: DIS, miss: { stmts: [], cpu: { fixedMs: 1.2 } } },
    "POST /api/discord static command": { file: DIS, miss: { stmts: [...FLOOR], cpu: { fixedMs: 1.6 } }, note: "/start /map /countdown /dates /help /quiz /leeroy ...: the replay row is the whole D1 cost" },
    "POST /api/discord autocomplete /tooltip": { file: DIS, miss: { stmts: [...FLOOR, r(DIS, "FROM lib_pages WHERE title LIKE ? ESCAPE", "lib_pages", "$libPages")], cpu: { fixedMs: 2.5, parseKB: 0 } }, note: "a leading % LIKE over three text columns: a full table scan on every keystroke" },
    "POST /api/discord /page or /tooltip": { file: DIS, miss: { stmts: [...FLOOR, r(DIS, "FROM lib_pages WHERE id = ? OR title LIKE ? ESCAPE", "lib_pages", "$libPages")], cpu: { fixedMs: 2.5 } } },
    "POST /api/discord /sheet view": { file: DIS, miss: { stmts: [...FLOOR, Q_SHEETS, Q_PARTY, Q_EVENTS_PR], cpu: { fixedMs: 2, parseKB: 20, stringifyKB: 5 } } },
    "POST /api/discord /sheet write": { file: DIS, miss: { stmts: [...FLOOR, ...SHEET_COMMIT, W_INTENT], do: 1, cpu: { fixedMs: 3, parseKB: 30, stringifyKB: 30 } }, note: "+ purge of 4 cached paths" },
    "POST /api/discord /signup write": { file: DIS, miss: { stmts: [...FLOOR, r(KVC, "SELECT json FROM kv_state WHERE key = ?", "kv_state", 1),
      w(KVC, "UPDATE kv_state SET json = ?, updated_at = ? WHERE key = ? AND json = ? RETURNING key", "kv_state", "update"), W_INTENT], do: 1, cpu: { fixedMs: 2.2, parseKB: 4, stringifyKB: 4 } } },
    "POST /api/discord vote button": { file: DIS, miss: { stmts: [...FLOOR, r(VOT, "SELECT json FROM kv_state WHERE key = ?", "kv_state", 1, { n: 2 }), r(VOT, "FROM vote_ballots WHERE vote_id IN", "vote_ballots", 5, { n: 2 }),
      w(VOT, "INSERT INTO vote_ballots (vote_id, voter_hash, choice, cast_at)", "vote_ballots", "insert")], ext: 1, cpu: { fixedMs: 2.5 } }, note: "no member check and no per-voter cap; loadVote runs twice per click" },
    "POST /api/discord Fix this fact (any user)": { file: DIS, miss: { stmts: [...FLOOR, w(DIS, "INSERT INTO fact_fixes (id, page_id, fact_key, old_value, new_value, note, by_name, created_at)", "fact_fixes", "insert"), W_INTENT], cpu: { fixedMs: 1.8 } }, note: "no member check" },
    "POST /api/discord /ask (inline part)": { file: DIS, miss: { stmts: [...FLOOR, { ...BUDGET_READ, n: 2 },
      w(UX, "INSERT INTO ask_turns (id, by_name, question, model, status, share, created_at)", "ask_turns", "insert"),
      w(UX, "INSERT OR IGNORE INTO ask_turn_askers (intent_id, asker_hash) VALUES (?, ?)", "ask_turn_askers", "insert", { n: 2 }), W_INTENT,
      r(DIS, "SELECT", "ask_turns", 1)], ext: 2, cpu: { fixedMs: 3 } }, note: "plus the answer (answer: member ...) and 1 to 3 Discord PATCH calls (2 counted)" },
    "POST /api/discord /intents": { file: DIS, miss: { stmts: [...FLOOR, r(DIS, "FROM intents WHERE seq > ?", "intents", 50), r(DIS, "SELECT COUNT(*) AS count FROM intents", "intents", "$intentsPending")], cpu: { fixedMs: 2.2 } } },
    "GET /api/library/<unknown name> (404)": { file: IDX, miss: { stmts: [r(IDX, "SELECT json, stamp FROM lib_blobs WHERE name = ?", "lib_blobs", 0)], cpu: { fixedMs: 0.3 } }, note: "a 404 is not cached, so every guess is a D1 query" },
    "GET /api/<anything else> (404, no D1)": { file: IDX, miss: { stmts: [], cpu: { fixedMs: 0.1 } } },
    "cron: every minute (flags off)": { file: IDX, noReq: false, miss: { stmts: [], cpu: { fixedMs: 0.1 }, anchors: [["infrastructure/worker/moments.js", "disabled"]] }, note: "no D1 while MOMENTS_ENABLED, MOMENTS_SHADOW and MOMENTS_DRY_RUN are off" },
  },
  drivers: {
    // --- standing load every day -----------------------------------------------------------------------------------------------------
    cron_minute: { unit: "tick", baseline: true, calls: [{ ep: "cron: every minute (flags off)", n: 1 }] },
    cron_6h: { unit: "sweep (nothing changed)", baseline: true, calls: [], flat: { req: 1, stmts: [
      r(SCR, "SELECT * FROM lib_sources ORDER BY checked_at ASC LIMIT 12", "lib_sources", "$libSources"),
      w(SCR, "UPDATE lib_sources SET checked_at = ?, status = '304' WHERE id = ?", "lib_sources", "update", { n: "$libSources", idx: 1 }),
      r(SCR, "SELECT json FROM lib_blobs WHERE name = 'refresh.json'", "lib_blobs", 1),
      w(SCR, "UPDATE lib_blobs SET stamp = ?, json = ?, updated_at = ? WHERE name = 'refresh.json'", "lib_blobs", "update"),
      w(UX, "DELETE FROM answer_details WHERE created_at < ?", "answer_details", "delete", { rows: 0 }),
      w(UX, "DELETE FROM answer_feedback WHERE created_at < ?", "answer_feedback", "delete", { rows: 0 }),
    ], ext: "$libSources", do: 1, cpu: { fixedMs: 8 } }, note: "12 outside fetches; cron CPU 10 ms; the fixed CPU is a guess (HTML stripping of up to 256 KB a source)" },
    members_refresh: { unit: "isolate cache refill", baseline: true, calls: [], flat: { stmts: [Q_MEMBERS] }, note: "auth.js caches the members table 15 min per isolate: 96 refills a day per isolate" },
    // --- the page ----------------------------------------------------------------------------------------------------------------------
    tab_load: { unit: "page load", calls: [{ ep: "GET /api/bootstrap", n: 1 }, { ep: "GET /api/state", n: 1 }, { ep: "GET /api/library/index.json", n: 1 }, { ep: "GET /api/votes", n: 1 }, { ep: "GET /api/live (WebSocket upgrade)", n: 1 },
      { ep: "GET /api/data/client", n: 1, only: "pr333" }, { ep: "GET /api/data/guided-atlas", n: 0.5, only: "pr333" }, { ep: "GET /api/data/decide", n: 0.5, only: "pr333" }], note: "PR 333 adds the client document (and, half the time, the decide and guided-atlas scenes) to the Worker's reads" },
    member_tab_load: { unit: "signed-in extras on a page load", calls: [{ ep: "GET /api/me", n: 1 }, { ep: "GET /api/sheet", n: 1 }, { ep: "GET /api/ask?id= (member poll)", n: 1 }] },
    tab_hour_ws: { unit: "tab-hour, socket up, Tonight or Decide panel showing", calls: [{ ep: "GET /api/votes", everySec: 60 }], note: "pings are auto-answered by the Durable Object and not billed; with no votes panel showing the tab makes no HTTP request" },
    tab_hour_poll: { unit: "tab-hour, socket failed (polling fallback)", calls: [{ ep: "GET /api/state", everySec: 15 }, { ep: "GET /api/votes", everySec: 60 }, { ep: "GET /api/live (WebSocket upgrade)", everySec: 120 }] },
    library_open: { unit: "Library opened (13 files)", calls: [{ ep: "GET /api/library/index.json", n: 1 }, { ep: "GET /api/library/<other blob>", n: 12 }] },
    // --- member writes -----------------------------------------------------------------------------------------------------------------
    sheet_write: { unit: "web sheet edit", calls: [{ ep: "POST /api/sheet (write)", n: 1, purges: ["GET /api/bootstrap", "GET /api/state", "GET /api/data/party"] }] },
    signup_write: { unit: "web sign-up change", calls: [{ ep: "POST /api/signups (write)", n: 1, purges: ["GET /api/bootstrap", "GET /api/state", "GET /api/signups"] }] },
    launch_write: { unit: "web launch-state change", calls: [{ ep: "POST /api/intent launch", n: 1, purges: ["GET /api/bootstrap", "GET /api/state", "GET /api/data/party"] }] },
    journey_write: { unit: "journey choice", calls: [{ ep: "POST /api/intent journey", n: 1 }] },
    ask_member_claude: { unit: "web /ask by a member, default provider Claude", calls: [{ ep: "POST /api/intent ask (member)", n: 1 }, { ep: "answer: member on Claude (shared)", n: 1, purges: ["GET /api/bootstrap", "GET /api/state"] }, { ep: "GET /api/ask?id= (member poll)", n: 2 }] },
    ask_member_wai: { unit: "web /ask by a member on Workers AI", calls: [{ ep: "POST /api/intent ask (member)", n: 1 }, { ep: "answer: member on Workers AI (shared)", n: 1, purges: ["GET /api/bootstrap", "GET /api/state"] }, { ep: "GET /api/ask?id= (member poll)", n: 2 }] },
    ask_guest: { unit: "web /ask by a visitor (always Workers AI)", calls: [{ ep: "POST /api/intent ask (guest)", n: 1 }, { ep: "answer: guest on Workers AI (private)", n: 1, purges: ["GET /api/bootstrap", "GET /api/state"] }, { ep: "GET /api/ask?id= (guest poll)", n: 2 }] },
    ask_guest_refused: { unit: "visitor over 2 an hour (429)", calls: [{ ep: "POST /api/intent ask (guest, refused 429)", n: 1 }] },
    ask_budget_refused: { unit: "member /ask after the day's cap", calls: [{ ep: "POST /api/intent ask (member)", n: 1 }, { ep: "answer: refused by the budget", n: 1, purges: [] }, { ep: "GET /api/ask?id= (member poll)", n: 1 }] },
    refresh_accepted: { unit: "manual refresh (one per 15 min at most)", calls: [{ ep: "POST /api/intent refresh (accepted)", n: 1 }], flat: { stmts: [], ext: "$libSources", do: 1, cpu: { fixedMs: 0 }, req: 0 } },
    refresh_cooldown: { unit: "refresh inside the cooldown (429)", calls: [{ ep: "POST /api/intent refresh (cooldown 429)", n: 1 }] },
    admin_put_doc: { unit: "admin PUT of a document", calls: [{ ep: "PUT /api/data/<doc> (admin)", n: 1, purges: ["GET /api/bootstrap", "GET /api/state", "GET /api/data/party", "GET /api/data/decide", "GET /api/data/client"] }] },
    bot_intents_poll: { unit: "PC-bot poll of the mailbox", calls: [{ ep: "GET /api/intents (the PC bot's poll, admin)", n: 1 }], note: "the bot lives in another repository: its poll rate is not known" },
    // --- the sweep, per changed source -----------------------------------------------------------------------------------------------
    sweep_changed_source: { unit: "source that changed in a sweep", calls: [], flat: { stmts: [
      w(SCR, "INSERT OR REPLACE INTO lib_source_snapshots (id, source_id, url, sha8, body_text, fetched_at) VALUES (?, ?, ?, ?, ?, ?)", "lib_source_snapshots", "replace"),
      r(AIM, "SELECT id, category, title, facts_json, history_json FROM lib_pages", "lib_pages", "$libPages"),
      r(AIM, "SELECT id FROM wiki_proposals WHERE status = 'pending' AND page_id = ? AND fact_key = ? AND proposed_value = ? LIMIT 1", "wiki_proposals", "$proposalRows", { n: 3 }),
      w(AIM, "INSERT INTO wiki_proposals (id, source_id, page_id, fact_key, old_value, proposed_value, confidence, status, created_at)", "wiki_proposals", "insert", { n: 3 }),
    ], ext: 1, ai: 1, neurons: "$cronNeurons", cpu: { fixedMs: 3 } }, note: "3 proposals assumed (at most 5); one AI call; neurons only when the sweep runs on Workers AI" },
    // --- Discord ---------------------------------------------------------------------------------------------------------------------
    discord_ping: { unit: "PING", calls: [{ ep: "POST /api/discord PING", n: 1 }] },
    discord_bad_signature: { unit: "unsigned or stale POST", calls: [{ ep: "POST /api/discord (bad signature or stale)", n: 1 }] },
    discord_static: { unit: "static command", calls: [{ ep: "POST /api/discord static command", n: 1 }] },
    discord_autocomplete: { unit: "/tooltip autocomplete keystroke", calls: [{ ep: "POST /api/discord autocomplete /tooltip", n: 1 }] },
    discord_page: { unit: "/page or /tooltip", calls: [{ ep: "POST /api/discord /page or /tooltip", n: 1 }] },
    discord_sheet_view: { unit: "/sheet view", calls: [{ ep: "POST /api/discord /sheet view", n: 1 }] },
    discord_sheet_write: { unit: "/sheet write", calls: [{ ep: "POST /api/discord /sheet write", n: 1, purges: ["GET /api/bootstrap", "GET /api/state", "GET /api/data/party"] }] },
    discord_signup: { unit: "/signup change", calls: [{ ep: "POST /api/discord /signup write", n: 1, purges: ["GET /api/bootstrap", "GET /api/state", "GET /api/signups"] }] },
    discord_vote_click: { unit: "vote button press", calls: [{ ep: "POST /api/discord vote button", n: 1, purges: ["GET /api/votes"] }] },
    discord_fix_click: { unit: "Fix this fact press", calls: [{ ep: "POST /api/discord Fix this fact (any user)", n: 1 }] },
    discord_intents: { unit: "/intents", calls: [{ ep: "POST /api/discord /intents", n: 1 }] },
    discord_ask_claude: { unit: "/ask in Discord (Claude)", calls: [{ ep: "POST /api/discord /ask (inline part)", n: 1 }, { ep: "answer: member on Claude (shared)", n: 1, purges: ["GET /api/bootstrap", "GET /api/state"] }] },
    discord_ask_wai: { unit: "/ask in Discord (Workers AI)", calls: [{ ep: "POST /api/discord /ask (inline part)", n: 1 }, { ep: "answer: member on Workers AI (shared)", n: 1, purges: ["GET /api/bootstrap", "GET /api/state"] }] },
    // --- hostile or accidental ---------------------------------------------------------------------------------------------------------
    anon_bootstrap: { unit: "anonymous GET /api/bootstrap", calls: [{ ep: "GET /api/bootstrap", n: 1 }] },
    anon_library_guess: { unit: "anonymous GET /api/library/<random>", calls: [{ ep: "GET /api/library/<unknown name> (404)", n: 1 }] },
    anon_404: { unit: "anonymous GET of an unknown path", calls: [{ ep: "GET /api/<anything else> (404, no D1)", n: 1 }] },
  },
  scenarios: [
    { name: "Realistic day", lever: { drivers: ["tab_hour_ws"], what: "tab-hours with the socket up and the votes panel showing" }, note: "5 members, one tab each open 3 h with the socket up and the Tonight panel showing, 2 page loads each, a handful of writes, 15 asks, 40 Discord interactions", spanHours: 6, colos: 2, loads: [
      { driver: "cron_minute", count: 1440 }, { driver: "cron_6h", count: 4 }, { driver: "members_refresh", count: 192 },
      { driver: "tab_load", count: 10 }, { driver: "member_tab_load", count: 10 }, { driver: "tab_hour_ws", count: 15 }, { driver: "library_open", count: 3 },
      { driver: "sheet_write", count: 8 }, { driver: "signup_write", count: 5 }, { driver: "journey_write", count: 2 },
      { driver: "ask_member_claude", count: 15 }, { driver: "ask_guest", count: 2 },
      { driver: "discord_static", count: 10 }, { driver: "discord_autocomplete", count: 6 }, { driver: "discord_page", count: 4 }, { driver: "discord_sheet_view", count: 8 },
      { driver: "discord_sheet_write", count: 4 }, { driver: "discord_signup", count: 3 }, { driver: "discord_vote_click", count: 3 }, { driver: "discord_ask_claude", count: 2 } ] },
    { name: "Ten polling tabs", lever: { drivers: ["tab_hour_poll"], what: "tab-hours of polling; 24 = one tab for a day" }, note: "the realistic day, but 10 tabs sit visible for 24 h with the socket failed (15 s /state polling, 60 s /votes)", spanHours: 24, colos: 2, loads: [
      { driver: "cron_minute", count: 1440 }, { driver: "cron_6h", count: 4 }, { driver: "members_refresh", count: 192 },
      { driver: "tab_load", count: 10 }, { driver: "member_tab_load", count: 10 }, { driver: "tab_hour_poll", count: 240 }, { driver: "library_open", count: 3 },
      { driver: "sheet_write", count: 8 }, { driver: "signup_write", count: 5 }, { driver: "ask_member_claude", count: 15 }, { driver: "discord_static", count: 10 }, { driver: "discord_sheet_view", count: 8 } ] },
    { name: "Ask burst", lever: { drivers: ["ask_member_wai", "ask_guest"], what: "asks that reach Workers AI" }, note: "every member spends the daily cap of 40 on Workers AI (200), 100 visitors from distinct addresses ask once, on top of the realistic day", spanHours: 6, colos: 2, loads: [
      { driver: "cron_minute", count: 1440 }, { driver: "cron_6h", count: 4 }, { driver: "members_refresh", count: 192 }, { driver: "tab_load", count: 10 }, { driver: "tab_hour_ws", count: 15 },
      { driver: "ask_member_wai", count: 200 }, { driver: "ask_guest", count: 100 }, { driver: "ask_guest_refused", count: 100 } ] },
    { name: "Discord interaction storm", lever: { drivers: ["discord_autocomplete", "discord_vote_click", "discord_static", "discord_sheet_view", "discord_sheet_write", "discord_ask_claude"], what: "the storm scaled as a whole" }, note: "5,000 valid signed interactions in one day on top of the realistic day: 2,000 autocomplete keystrokes, 1,000 vote presses, 1,000 static commands, 600 /sheet views, 200 /sheet writes, 200 /ask", spanHours: 6, colos: 2, loads: [
      { driver: "cron_minute", count: 1440 }, { driver: "cron_6h", count: 4 }, { driver: "members_refresh", count: 192 }, { driver: "tab_load", count: 10 }, { driver: "tab_hour_ws", count: 15 },
      { driver: "discord_autocomplete", count: 2000 }, { driver: "discord_vote_click", count: 1000 }, { driver: "discord_static", count: 1000 }, { driver: "discord_sheet_view", count: 600 },
      { driver: "discord_sheet_write", count: 200 }, { driver: "discord_ask_claude", count: 200 } ] },
    { name: "Everything at once", lever: { drivers: ["anon_bootstrap"], what: "hostile requests" }, note: "ten polling tabs, the ask burst, the Discord storm, a hostile 10,000-request flood of GET /api/bootstrap, a refresh every 15 minutes", spanHours: 24, colos: 2, loads: [
      { driver: "cron_minute", count: 1440 }, { driver: "cron_6h", count: 4 }, { driver: "members_refresh", count: 192 }, { driver: "tab_load", count: 10 }, { driver: "tab_hour_poll", count: 240 },
      { driver: "ask_member_wai", count: 200 }, { driver: "ask_guest", count: 100 }, { driver: "ask_guest_refused", count: 100 },
      { driver: "discord_autocomplete", count: 2000 }, { driver: "discord_vote_click", count: 1000 }, { driver: "discord_static", count: 1000 }, { driver: "discord_sheet_view", count: 600 }, { driver: "discord_sheet_write", count: 200 }, { driver: "discord_ask_claude", count: 200 },
      { driver: "anon_bootstrap", count: 10000 }, { driver: "refresh_accepted", count: 96 }, { driver: "sweep_changed_source", count: 48 } ] },
    { name: "Ten tabs, socket up, 24 h", lever: { drivers: ["tab_hour_ws"], what: "tab-hours with the socket up and the votes panel showing" }, note: "calibration: ten tabs left open all day with the Tonight panel showing and the socket connected (the runbook measured about 15,600 production requests on 2 November)", spanHours: 24, colos: 2, loads: [
      { driver: "cron_minute", count: 1440 }, { driver: "cron_6h", count: 4 }, { driver: "members_refresh", count: 192 }, { driver: "tab_load", count: 10 }, { driver: "tab_hour_ws", count: 240 } ] },
    { name: "Ten polling tabs, one member without a stored sheet", lever: { drivers: ["tab_hour_poll"], what: "tab-hours of polling" }, params: { sheetlessMembers: 1 }, note: "as Ten polling tabs, with one party member who has no stored sheet row yet (a newly added person): only PR 333 reads the sheet_events log for them on every uncached read", spanHours: 24, colos: 2, loads: [
      { driver: "cron_minute", count: 1440 }, { driver: "cron_6h", count: 4 }, { driver: "members_refresh", count: 192 }, { driver: "tab_load", count: 10 }, { driver: "tab_hour_poll", count: 240 } ] },
  ],
};

// ------------------------------------------------------------------------------------------------------------------------------------------
// Report
// ------------------------------------------------------------------------------------------------------------------------------------------
const f0 = (x) => (Math.abs(x) >= 100 ? Math.round(x).toLocaleString("en-US") : Number(x.toFixed(x < 10 ? 2 : 1)).toLocaleString("en-US"));
const pct = (x) => (x >= 100 ? `${f0(x)}%` : x >= 1 ? `${x.toFixed(1)}%` : `${x.toFixed(2)}%`);
const row = (cells) => `| ${cells.join(" | ")} |`;

export function buildReport(model, schema, rd, { pr333 }) {
  const out = { pr333, routes: [], scenarios: [], alone: [], baseline: null };
  const params = { ...model.params, pr333: pr333 ? 1 : 0 };
  for (const [id, ep0] of Object.entries(model.endpoints)) {
    const ep = effective(ep0, pr333);
    const c = costOf(ep.miss || {}, schema, params, model.cpuModel);
    out.routes.push({ id, cached: Boolean(ep.cache), ttlSec: ep.cache ? ep.cache.ttlSec : null, browserTtlSec: ep.browserTtlSec || 0, noReq: Boolean(ep.noReq), cost: c, note: ep0.note || "" });
  }
  for (const sc of model.scenarios) {
    const res = runScenario(model, schema, sc, { pr333 });
    const rep = limitsReport(model, res.total);
    const first = firstLimit(rep);
    const solve = sc.lever ? solveScale(model, schema, sc, sc.lever.drivers, { pr333 }) : null;
    out.scenarios.push({ name: sc.name, note: sc.note, lever: sc.lever, total: res.total, rep, first, maxCpu: res.maxCpu, maxSub: res.maxSub, solve: solve, byEp: res.byEp });
  }
  out.bundles = Object.keys(model.drivers).map((id) => ({ id, b: bundleOf(model, schema, id, params, pr333) })).filter((x) => x.b);
  const base = { spanHours: 24, colos: 2, loads: model.scenarios[0].loads.filter((l) => model.drivers[l.driver].baseline) };
  out.alone = aloneTable(model, schema, base, { pr333 });
  out.baseline = runScenario(model, schema, base, { pr333 }).total;
  return out;
}

export function renderMarkdown(model, rep, rd, meta) {
  const L = [];
  const mode = rep.pr333 ? `PR 333 overlay (${meta.pr333Tree ? "the tree contains public-party.js" : "assumed with --assume-pr333, not read from the code"})` : "master as read";
  L.push(`Tree: \`${meta.root}\` · mode: ${mode} · anchors checked: ${meta.anchors.checked}, missing: ${meta.anchors.missing.length}`, "");
  L.push(`wrangler.toml crons: ${meta.crons.map((c) => `\`${c}\``).join(", ") || "none"}. ${meta.warnings.length ? `**Warnings:** ${meta.warnings.join("; ")}.` : "Every flag the model prices as off is off in wrangler.toml."}`, "");
  L.push("### Limits used", "", row(["Limit", "Value", "Source in the repo"]), row(["---", "---:", "---"]));
  for (const l of Object.values(model.limits)) L.push(row([l.label, f0(l.limit), `\`${l.file}\`: "${l.a}"`]));
  for (const l of Object.values(model.perRequest)) L.push(row([l.label, f0(l.limit), `\`${l.file}\`: "${l.a}"`]));
  L.push("", "### Cost of one request, per route (a cache miss, or an uncached route)", "",
    row(["Route", "D1 queries", "Rows read", "Rows written", "DO requests", "Outside calls", "Neurons", "CPU est. (ms)", "Slowdown that reaches 10 ms", "Subrequests", "Edge cache (browser)"]), row(["---", "---:", "---:", "---:", "---:", "---:", "---:", "---:", "---:", "---:", "---"]));
  for (const x of rep.routes) {
    const c = x.cost;
    L.push(row([`${x.id}${x.noReq ? " *(inside another request)*" : ""}`, f0(c.d1q), f0(c.rr), f0(c.rw), f0(c.doReq), f0(c.ext), f0(c.neurons), f0(c.cpuMs), `${f0(10 / Math.max(c.cpuMs, 0.01))}x`, f0(c.subreq), x.cached ? `${x.ttlSec} s (${x.browserTtlSec} s)` : "none"]));
  }
  L.push("", "### Heaviest single invocations (a request plus the answer it hands to waitUntil)", "", row(["Flow", "CPU est. (ms)", "Slowdown that reaches 10 ms", "Subrequests (of 50)"]), row(["---", "---:", "---:", "---:"]));
  for (const x of rep.bundles) L.push(row([`${x.id} (${model.drivers[x.id].unit})`, f0(x.b.cpuMs), `${f0(10 / Math.max(x.b.cpuMs, 0.01))}x`, f0(x.b.subreq)]));
  L.push("", "### Standing load (cron, per day)", "", `Worker requests ${f0(rep.baseline.req)} (the two crons, if cron invocations count as requests: unverified), D1 queries ${f0(rep.baseline.d1q)}, rows read ${f0(rep.baseline.rr)}, rows written ${f0(rep.baseline.rw)}, outside calls ${f0(rep.baseline.ext)}, Durable Object requests ${f0(rep.baseline.doReq)}.`, "");
  L.push("### Scenarios (a day each)", "");
  for (const s of rep.scenarios) {
    L.push(`#### ${s.name}`, "", s.note, "", row(["Limit", "Used", "Limit", "Share"]), row(["---", "---:", "---:", "---:"]));
    for (const x of s.rep) L.push(row([x.label, f0(x.used), f0(x.limit), pct(x.pct)]));
    L.push("", `First limit: **${s.first.label}** at ${pct(s.first.pct)}. Heaviest request CPU est.: ${f0(s.maxCpu.ms)} ms (${s.maxCpu.id}); most subrequests in one invocation: ${f0(s.maxSub.n)} (${s.maxSub.id}). D1 queries ${f0(s.total.d1q)}, outside calls ${f0(s.total.ext)}.`);
    if (s.lever) L.push(s.solve ? `Lever (${s.lever.what}): the first limit, ${s.solve.limit}, is reached at ${s.solve.counts.map((c) => `${f0(c.count)} ${c.driver}`).join(" + ")}${s.solve.factor < 1 ? " (the scenario is already past it)" : ""}.` : `Lever (${s.lever.what}): no limit is reached below a million times this size.`, "");
    L.push("");
  }
  L.push("### What alone exhausts each limit (units a day, on the standing load)", "", row(["Driver (unit)", ...Object.values(model.limits).map((l) => l.label.replace(/ \(.*/, "")), "Per-unit req / rows read / rows written / neurons"]), row(["---", ...Object.keys(model.limits).map(() => "---:"), "---"]));
  for (const a of rep.alone) L.push(row([`${a.id} (${a.unitLabel})`, ...Object.keys(model.limits).map((k) => (a.reach[k] === null ? "never" : f0(a.reach[k]))), `${f0(a.unit.req)} / ${f0(a.unit.rr)} / ${f0(a.unit.rw)} / ${f0(a.unit.neurons)}`]));
  return L.join("\n");
}

export function renderDiff(model, schema, rd) {
  const a = buildReport(model, schema, rd, { pr333: false }), b = buildReport(model, schema, rd, { pr333: true });
  const L = ["### PR 333 against master: routes whose cost or caching changes (one request that reaches the code)", "",
    row(["Route", "Cache before", "Cache after", "D1 queries before / after", "Rows read before / after", "CPU est. ms before / after"]), row(["---", "---", "---", "---:", "---:", "---:"])];
  for (let i = 0; i < a.routes.length; i++) {
    const x = a.routes[i], y = b.routes[i];
    const same = x.cached === y.cached && x.cost.d1q === y.cost.d1q && x.cost.rr === y.cost.rr && x.cost.cpuMs === y.cost.cpuMs && x.browserTtlSec === y.browserTtlSec;
    if (same) continue;
    L.push(row([x.id, x.cached ? `${x.ttlSec} s edge, ${x.browserTtlSec} s browser` : "none", y.cached ? `${y.ttlSec} s edge, ${y.browserTtlSec} s browser` : x.cached ? "none (no-store)" : "none", `${f0(x.cost.d1q)} / ${f0(y.cost.d1q)}`, `${f0(x.cost.rr)} / ${f0(y.cost.rr)}`, `${f0(x.cost.cpuMs)} / ${f0(y.cost.cpuMs)}`]));
  }
  L.push("", "### PR 333 against master: a day each", "", row(["Scenario", "Requests", "D1 queries", "Rows read", "Rows written", "CPU est. of the heaviest request (ms)", "First limit (master → PR 333)"]), row(["---", "---:", "---:", "---:", "---:", "---:", "---"]));
  for (let i = 0; i < a.scenarios.length; i++) {
    const x = a.scenarios[i], y = b.scenarios[i];
    const d = (k) => `${f0(x.total[k])} → ${f0(y.total[k])}`;
    L.push(row([x.name, d("req"), d("d1q"), d("rr"), d("rw"), `${f0(x.maxCpu.ms)} → ${f0(y.maxCpu.ms)}`, `${x.first.label.replace(/ \(.*/, "")} ${pct(x.first.pct)} → ${y.first.label.replace(/ \(.*/, "")} ${pct(y.first.pct)}`]));
  }
  return L.join("\n");
}

function bench(rd) {
  const lines = ["", "### Timing of the seeded documents (node, this machine; not workerd and not part of any total)", "", row(["Document", "KB", "JSON.parse ms", "JSON.stringify ms"]), row(["---", "---:", "---:", "---:"])];
  for (const f of ["data/party.json", "data/decide.json", "data/client.json", "data/guided-atlas.json"]) {
    const s = rd.read(f);
    if (s === null) continue;
    const n = 20;
    let t0 = process.hrtime.bigint(), o;
    for (let i = 0; i < n; i++) o = JSON.parse(s);
    const t1 = process.hrtime.bigint();
    for (let i = 0; i < n; i++) JSON.stringify(o);
    const t2 = process.hrtime.bigint();
    lines.push(row([f, f0(s.length / 1024), f0(Number(t1 - t0) / 1e6 / n), f0(Number(t2 - t1) / 1e6 / n)]));
  }
  return lines.join("\n");
}

// ------------------------------------------------------------------------------------------------------------------------------------------
// Command line
// ------------------------------------------------------------------------------------------------------------------------------------------
export function run(argv, out = (s) => process.stdout.write(s + "\n")) {
  const opt = { root: DEFAULT_ROOT, json: false, check: false, pr333: false, bench: false, model: null, scenario: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") opt.root = path.resolve(argv[++i]);
    else if (a === "--json") opt.json = true;
    else if (a === "--check") opt.check = true;
    else if (a === "--assume-pr333") opt.pr333 = true;
    else if (a === "--bench") opt.bench = true;
    else if (a === "--diff") opt.diff = true;
    else if (a === "--model") opt.model = argv[++i];
    else if (a === "--scenario") opt.scenario = argv[++i];
    else if (a === "--md") { /* default */ }
    else throw new Error(`unknown argument ${a}`);
  }
  const rd = makeReader(opt.root);
  const model = opt.model ? JSON.parse(fs.readFileSync(opt.model, "utf8")) : MODEL;
  if (opt.scenario) model.scenarios = JSON.parse(fs.readFileSync(opt.scenario, "utf8"));
  const schema = parseSchema(rd.read("infrastructure/schema.sql"));
  const anchors = checkAnchors(model, rd);
  const wr = parseWrangler(rd.read("infrastructure/wrangler.toml"));
  const warnings = [];
  for (const f of model.flagsOff || []) if (wr.vars[f] !== undefined && wr.vars[f].toLowerCase() !== "off") warnings.push(`wrangler.toml sets ${f} = "${wr.vars[f]}" but the model prices it off`);
  if (model.expectedCrons && JSON.stringify(wr.crons) !== JSON.stringify(model.expectedCrons)) warnings.push(`wrangler.toml crons are ${JSON.stringify(wr.crons)}, the model assumes ${JSON.stringify(model.expectedCrons)}`);
  const pr333Tree = treeHasPr333(rd);
  const pr333 = opt.pr333 || pr333Tree;
  if (anchors.missing.length) {
    out(`${anchors.missing.length} anchor(s) are no longer in the code (the model needs a re-read):`);
    for (const m of anchors.missing) out(`  ${m.where}: ${m.file} no longer contains ${JSON.stringify(m.text)}`);
    return 1;
  }
  if (opt.diff) { out(renderDiff(model, schema, rd)); return 0; }
  if (opt.check) { out(`ok: ${anchors.checked} anchors found in ${opt.root}`); return 0; }
  const rep = buildReport(model, schema, rd, { pr333 });
  if (opt.json) {
    out(JSON.stringify({ root: path.relative(process.cwd(), opt.root) || ".", pr333, anchorsChecked: anchors.checked, warnings, scenarios: rep.scenarios.map((s) => ({ name: s.name, total: s.total, first: s.first.key, maxCpu: s.maxCpu, maxSub: s.maxSub })), baseline: rep.baseline }, null, 1));
  } else {
    out(renderMarkdown(model, rep, rd, { root: path.relative(process.cwd(), opt.root) || ".", anchors, pr333Tree, warnings, crons: wr.crons }));
    if (opt.bench) out(bench(rd));
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = run(process.argv.slice(2)); } catch (e) { console.error(String((e && e.message) || e)); process.exitCode = 2; }
}
