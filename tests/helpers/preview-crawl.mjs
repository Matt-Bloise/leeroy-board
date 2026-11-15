// The anonymous crawl for the privacy contract. Shared by tests/api/preview-crawl.test.mjs (the real PR preview Worker, over HTTP) and
// tests/unit/preview-crawl.test.mjs (a local Worker over in-memory SQLite, plus a mutation that must turn it red).
//
// What it does: one party member hides ALL NINE sheet lines (every value kept), then every GET route of the Worker is read with no key and no cookie, plain and with
// odd query switches, every public document name is read, and a live socket collects what the room broadcasts. Every body, header and JSON key is searched for every
// value the member hid and for strings derived from it. Hits are reported by FIELD NAME only: a value is never printed. In a finally block every line is put back as it was.
//
// Nothing here is a hand list of routes: crawlPaths() reads ROUTES, the public document sets and the dispatcher's own regexes from infrastructure/worker.
import { readFileSync } from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import { ROUTES } from "../../infrastructure/worker/index.js";
import { PUBLIC_DATA_DOCS, PUBLIC_ATLAS_DOCS } from "../../infrastructure/worker/public-docs.js";
import { SHEET_VOCAB } from "../../infrastructure/worker/sheet-vocab.js";

export const SHEET_FIELDS = ["race", "class", "spec_path", "spec_at_40", "professions", "plan_zone", "level", "launch_state", "goals"];
export const ODD_QUERY = "full=1&raw=1&admin=1&debug=1&x=1";
export const FORBIDDEN_HOSTS = ["api.leeroy.party", "leeroy.party", "www.leeroy.party"];
// A canary shorter than this is too generic to mean anything (a level such as 40 is in a thousand strings). Such a value is not searched; its field is reported as "skipped".
export const MIN_CANARY_LENGTH = 3;

// ---- the route list, derived ------------------------------------------------------------------------------------------------------------------------
const INDEX_SRC = readFileSync(new URL("../../infrastructure/worker/index.js", import.meta.url), "utf8");
const DISPATCH = INDEX_SRC.slice(INDEX_SRC.indexOf("const path = url.pathname"));
const REGEX_ROUTES = [...DISPATCH.matchAll(/path\.match\((\/\^[^\n]*?\$\/)\)/g)].map((m) => m[1]);
const LIBRARY_NAMES = [...new Set([...INDEX_SRC.matchAll(/\/api\/library\/([a-z0-9-]+\.json)/g)].map((m) => m[1]).concat(["index.json", "news.json"]))];

// /^\/config\/([^/]+)$/ -> ["/config/1"]; an optional alternation group "(\/approve|\/reject)?" becomes "", "/approve", "/reject" (same expansion as tests/unit/public-read-enumerate.test.mjs)
function expandRegex(src) {
  const body = src.slice(2, -2).replace(/\\\//g, "/");
  let outs = [""];
  for (let i = 0; i < body.length;) {
    const g = /^\(((?:[^()\\[]|\\.|\[[^\]]*\](?:\{[^}]*\})?)*)\)(\?)?/.exec(body.slice(i));
    if (g) { const inner = g[1]; const alts = inner.startsWith("[") || !inner.includes("|") ? ["1"] : inner.split("|").map((a) => a.replace(/\\\//g, "/")).concat(g[2] ? [""] : []); outs = outs.flatMap((o) => alts.map((a) => o + a)); i += g[0].length; }
    else { outs = outs.map((o) => o + body[i]); i++; }
  }
  return outs;
}

// Every GET path an anonymous caller can try: each ROUTES entry whose method is GET or ANY, each wildcard spelled with every public document name, every path the
// dispatcher's regexes accept. Each one plain and again with the odd query switches. Returns [{ route, path }].
export function crawlPaths() {
  const base = [];
  for (const entry of ROUTES) {
    const [method, pattern] = entry.split(" ");
    if (method !== "GET" && method !== "ANY") continue;
    if (pattern === "/data/*") for (const n of PUBLIC_DATA_DOCS) { base.push([entry, `/data/${n}`], [entry, `/data/${n}.json`]); }
    else if (pattern === "/atlas/*") for (const n of PUBLIC_ATLAS_DOCS) base.push([entry, `/atlas/${n}`]);
    else if (pattern === "/library/*") for (const n of LIBRARY_NAMES) base.push([entry, `/library/${n}`]);
    else base.push([entry, pattern.replace(":doc", "party").replace(/:[a-z]+/g, "1")]);
  }
  for (const src of REGEX_ROUTES) for (const p of expandRegex(src)) base.push([`regex ${src}`, p]);
  const seen = new Set(), out = [];
  for (const [route, path] of base) for (const q of ["", ODD_QUERY]) {
    const full = q ? `${path}?${q}` : path;
    if (seen.has(full)) continue;
    seen.add(full);
    out.push({ route, path: full });
  }
  return out;
}

// ---- the search -------------------------------------------------------------------------------------------------------------------------------------
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// case-insensitive, on word boundaries, with a plural ("s", "es") allowed: "mage" finds "Mages" and not "image"
export const canaryRegex = (c) => new RegExp(`(?<![a-z0-9])${esc(c)}(?:s|es)?(?![a-z0-9])`, "i");

function flatten(v, into) {
  if (Array.isArray(v)) for (const x of v) flatten(x, into);
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { into.push(k); flatten(x, into); }
  else if (typeof v === "string") into.push(v);
  else if (typeof v === "number" || typeof v === "boolean") into.push(String(v));
  return into;
}
// everything one answer can show: the raw body, every JSON key and string (decoded, so an escaped character cannot hide a value), every header name and value
export function haystackOf({ text, headers }) {
  const parts = [text];
  try { parts.push(...flatten(JSON.parse(text), [])); } catch { /* not JSON */ }
  for (const [k, v] of headers) parts.push(k, v);
  return parts.join("\n");
}

// A "generic" canary is a value of the board's own game vocabulary (a class, race, spec, profession or zone: sheet-vocab.js). The Worker serves game text to everyone by
// design (a command description that names Tirisfal Glades as an example, the sheet page's options), so seeing "Mage" in an answer is not a leak by itself. Such a value
// counts as a hit only where it is attributed to the target: inside a JSON object that carries the target's name or slug, or inside a string or line that names the target.
// Every other canary (the colour, the board line, the spec text, the planted words) counts wherever it appears. What this cannot see: a generic value that stands with no name
// beside it (a positional row). tests/unit/public-read-enumerate.test.mjs covers those with canaries that are not game words.
const attributable = (text, identity) => {
  const ids = identity.map(norm).filter(Boolean);
  const idRx = ids.map((i) => canaryRegex(i));
  const named = (s) => idRx.some((r) => r.test(s));
  let root;
  try { root = JSON.parse(text); } catch { return text.split("\n").filter(named).join("\n").toLowerCase(); }
  const out = [];
  const walk = (v) => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (typeof v === "string") { if (named(v)) out.push(v); return; }
    if (!v || typeof v !== "object") return;
    if (Object.values(v).some((x) => typeof x === "string" && ids.includes(norm(x)))) out.push(JSON.stringify(v));
    Object.values(v).forEach(walk);
  };
  walk(root);
  return out.join("\n").toLowerCase();
};

// The target's class and class key are asserted unique in the party (runPreviewCrawl refuses a target whose class another member shares), so they are searched UNCONDITIONALLY:
// any appearance anywhere, named or not, is a leak (an unnamed class-key list, a name-keyed object, a whole-document pass-through). The one exception is an answer that lists the game's
// whole class vocabulary (the sheet page's options): there the class is game text, and it counts only where it is attributed to the target, as for every other game word.
// A COMPOSITE answer (compositeDocsOf) never gets that exception: the bundled client document names most class labels by design, and a projection that passes it through would hide
// behind the exemption. Composites are searched unconditionally and checked structurally (compositeHits) instead.
export const UNCONDITIONAL_FIELDS = new Set(["class", "class_key"]);
const listsClassVocab = (hay) => {
  const labels = Object.values(SHEET_VOCAB.class).map((l) => String(l).toLowerCase());
  return labels.filter((l) => canaryRegex(l).test(hay)).length >= Math.ceil(labels.length * 0.8);
};

// The composites: documents built from the whole party. While anything is hidden, each must say `withheld` and carry its member-derived sections empty or absent (public-party.js).
export const COMPOSITE_SECTIONS = {
  client: [["classes"], ["racials"], ["synergy"], ["buffs", "list"], ["buffs", "rules"]],
  decide: [["people"], ["party"]],
  "guided-atlas": [["classes"]],
  tonight: [["people"], ["week_one", "trainers"]],
  party: [["settled"], ["settled_extra"], ["open"], ["glossary"]],
};
const emptyDeep = (v) => v === null || v === undefined || (Array.isArray(v) ? v.every(emptyDeep) : typeof v === "object" ? Object.values(v).every(emptyDeep) : v === "");
// [[name, doc], ...] for the composite documents inside one anonymous answer: /data/<name>, /state, /bootstrap (path without /api), or a live "data" message (no path)
export function compositeDocsOf(path, text) {
  let j; try { j = JSON.parse(text); } catch { return []; }
  if (!j || typeof j !== "object") return [];
  const p = path ? String(path).split("?")[0] : "";
  const m = /^\/data\/([a-z-]+?)(?:\.json)?$/.exec(p);
  let out = [];
  if (m && COMPOSITE_SECTIONS[m[1]]) out = [[m[1], j]];
  else if (p === "/state") out = [["party", j.partyDoc], ["tonight", j.tonight], ["decide", j.decide]];
  else if (p === "/bootstrap") out = [["party", j.party], ["tonight", j.tonight], ["decide", j.decide]];
  else if (!p && j.type === "data" && COMPOSITE_SECTIONS[j.key]) out = [[j.key, j.data]];
  return out.filter(([, d]) => d !== null && d !== undefined);
}
// Field names (never values) of what a composite shows while everything is hidden: "composite:<name>" when `withheld` is not set, "composite:<name>.<section>" for a section that is not empty.
export function compositeHits(path, text) {
  const hits = [];
  for (const [name, doc] of compositeDocsOf(path, text)) {
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) { hits.push(`composite:${name}`); continue; }
    if (!doc.withheld || typeof doc.withheld !== "string") hits.push(`composite:${name}`);
    for (const sec of COMPOSITE_SECTIONS[name]) {
      const v = sec.reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), doc);
      if (!emptyDeep(v)) hits.push(`composite:${name}.${sec.join(".")}`);
    }
  }
  return hits;
}

// The structural rule: no object that NAMES the target (its name or slug as a value, or as a key) carries a private field key or a hidden value anywhere beneath it.
// This catches what a value search cannot: a level or race that is too short or shared with another member, in whatever shape the answer puts it.
// An object that names the target by key is read through that key's value. Returns the private key names found, or a canary field name for a hidden value.
export const PRIVATE_KEYS = new Set([...SHEET_FIELDS, "class_key", "color", "spec", "spec_status", "role_detail", "role_now", "role_from", "board_line", "start_zone"]);
export function structuralHits(text, identity, canaries = []) {
  let root;
  try { root = JSON.parse(text); } catch { return []; }
  const ids = new Set(identity.map(norm).filter(Boolean)), hits = new Set();
  const values = canaries.map((c) => ({ field: c.field, v: c.value }));
  const scan = (v) => {
    if (Array.isArray(v)) { v.forEach(scan); return; }
    if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (PRIVATE_KEYS.has(k)) hits.add(k);
        scan(x);
      }
      return;
    }
    if (v === null || v === undefined) return;
    const s = norm(v);
    for (const c of values) if (s === c.v) hits.add(c.field);
  };
  const walk = (v) => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!v || typeof v !== "object") return;
    if (Object.values(v).some((x) => (typeof x === "string" || typeof x === "number") && ids.has(norm(x)))) scan(v);
    for (const [k, x] of Object.entries(v)) { if (ids.has(norm(k))) scan(x); walk(x); }
  };
  walk(root);
  return [...hits];
}

// GAME REFERENCE, no member data (decision of the crawl red at f5a26af6: class and class_key found in GET /bootstrap and GET /library/news.json, plain and with the odd query).
// The target's class word is a common game word, and two public documents are static game text that every visitor gets and no member's build shapes:
//   - /library/<doc>: the library pages (data/library/*.json: news, classes, glossary ...). They name classes by design (a news item about "class fixes" lists them).
//   - the `marks` section of /bootstrap: the atlas place-mark index (data/atlas/marks.json, one of PUBLIC_ATLAS_DOCS): keys such as "systems/class-trainers~trainers.<class>.capital".
// For these two only, the class and class_key VALUE search is skipped (classHaystackOf returns null for a library document and the answer without `marks` for /bootstrap). Every other
// canary, the structural check (a private key, or a canary value inside an object that names the target) and the composite check still run over the WHOLE answer, and the rest of
// /bootstrap (partySheets, decide, party, tonight, launch, signups ...) is searched as before. A projection that passes member data through is still caught by those.
export const GAME_REFERENCE_SECTIONS = { "/bootstrap": ["marks"] };
const pathOnly = (p) => String(p || "").split("?")[0];
export function classHaystackOf(a, full) {
  const p = pathOnly(a.path);
  if (/^\/library\/[^/]+$/.test(p)) return null;
  const skip = GAME_REFERENCE_SECTIONS[p];
  if (!skip) return full;
  let j; try { j = JSON.parse(a.text); } catch { return full; }
  if (!j || typeof j !== "object" || Array.isArray(j)) return full;
  for (const k of skip) delete j[k];
  return haystackOf({ text: JSON.stringify(j), headers: a.headers });
}
// canaries: [{ field, value, generic?, unconditional? }]; answers: [{ text, headers }]; ctx: { identity: [name, slug] }
// returns the sorted field names with at least one value found
export function findHits(canaries, answers, ctx = { identity: [] }) {
  const hit = new Set();
  for (const a of answers) {
    const hay = haystackOf(a);
    const classHay = classHaystackOf(a, hay);
    let attr = null, vocab = null;
    const composite = compositeDocsOf(a.path, a.text).length > 0;
    for (const h of structuralHits(a.text, ctx.identity, canaries)) hit.add(h);
    for (const h of compositeHits(a.path, a.text)) hit.add(h);
    for (const c of canaries) {
      const h = c.unconditional ? classHay : hay;
      if (hit.has(c.field) || h === null || !canaryRegex(c.value).test(h)) continue;
      if (c.unconditional && vocab === null) vocab = !composite && listsClassVocab(h);
      if (c.generic || (c.unconditional && vocab)) {
        if (attr === null) attr = attributable(a.text, ctx.identity);
        if (!canaryRegex(c.value).test(attr)) continue;
      }
      hit.add(c.field);
    }
  }
  return [...hit].sort();
}

// ---- the canaries -----------------------------------------------------------------------------------------------------------------------------------
const norm = (v) => String(v).trim().toLowerCase();
// sheet line (or party-document key) -> the vocabulary list its values come from
const FIELD_LIST = { race: "race", class: "class", class_key: "class", spec_path: "spec", spec_at_40: "spec", professions: "professions", plan_zone: "plan_zone", start_zone: "plan_zone" };
const vocabValues = (list) => new Set(Object.entries(SHEET_VOCAB[list]).flatMap(([slug, label]) => [slug, slug.replace(/-/g, " "), label.toLowerCase()]));
function variants(v) {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v.flatMap(variants);
  if (typeof v === "object") return variants(v.name ?? v.label ?? null);
  const s = String(v).trim();
  return s ? [s, s.replace(/-/g, " ")] : [];
}

// sheetFields: the member's sheet fields as the admin reads them (value, visible); docMember: the member's entry in the stored party document; others: every other member of it.
// planted: { goals, launch_state } values written for this run. Returns { canaries, skipped, shared } where
//   canaries: [{ field, value }] searched; skipped: field names whose every value is too generic (shorter than MIN_CANARY_LENGTH);
//   shared: field names with a value that another member's stored record also carries (that value is attributable to the other member, so it is not searched).
export function buildCanaries({ sheetFields, docMember, others, planted }) {
  const raw = { race: [], class: [], class_key: [], color: [], spec: [], spec_path: [], spec_at_40: [], professions: [], plan_zone: [], start_zone: [], board_line: [], level: [], goals: [], launch_state: [] };
  const m = docMember || {};
  const f = (k) => (sheetFields && sheetFields[k] ? sheetFields[k].value : null);
  raw.race.push(...variants(m.race), ...variants(f("race")));
  raw.class.push(...variants(m.class), ...variants(f("class")));
  raw.class_key.push(...variants(m.class_key));
  raw.color.push(...variants(m.color));
  raw.spec.push(...variants(m.spec));
  raw.spec_path.push(...variants(f("spec_path")));
  raw.spec_at_40.push(...variants(f("spec_at_40")));
  raw.professions.push(...variants(f("professions")), ...variants(m.professions));
  raw.plan_zone.push(...variants(f("plan_zone")));
  raw.start_zone.push(...variants(m.start_zone));
  raw.board_line.push(...variants(m.board_line));
  raw.level.push(...variants(f("level")), ...variants(m.level));
  raw.goals.push(...variants(f("goals")), ...variants(planted.goals));
  raw.launch_state.push(...variants(f("launch_state")), ...variants(planted.launch_state));
  const othersText = (others || []).map((o) => JSON.stringify(o)).join("\n").toLowerCase();
  const canaries = [], skipped = new Set(), shared = new Set();
  for (const [field, list] of Object.entries(raw)) {
    for (const value of new Set(list.map(norm))) {
      if (value.length < MIN_CANARY_LENGTH) { skipped.add(field); continue; }
      if (canaryRegex(value).test(othersText)) { shared.add(field); continue; }
      const list = FIELD_LIST[field];
      const unconditional = UNCONDITIONAL_FIELDS.has(field);
      canaries.push({ field, value, unconditional, generic: !unconditional && Boolean(list) && vocabValues(list).has(value) });
    }
  }
  return { canaries, skipped: [...skipped].sort(), shared: [...shared].sort() };
}

// ---- the live socket (Node 22 has a global WebSocket) ------------------------------------------------------------------------------------------------------
export async function collectLiveMessages(wsUrl, trigger, ms = 8000) {
  if (typeof WebSocket !== "function") throw new Error("this Node has no global WebSocket");
  const messages = [];
  const ws = new WebSocket(wsUrl);
  ws.addEventListener("message", (e) => messages.push(typeof e.data === "string" ? e.data : String(e.data)));
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("the live socket did not open in 15 s")), 15000);
    ws.addEventListener("open", () => { clearTimeout(t); resolve(); });
    ws.addEventListener("error", () => { clearTimeout(t); reject(new Error("the live socket failed to open")); });
  });
  await new Promise((r) => setTimeout(r, 1000)); // the greeting
  await trigger();
  await new Promise((r) => setTimeout(r, ms));
  try { ws.close(); } catch { /* closed */ }
  return messages;
}

export function assertPreviewBase(base) {
  const host = new URL(base).hostname.toLowerCase();
  if (FORBIDDEN_HOSTS.includes(host)) throw new Error(`refusing to run against ${host}: this test writes to the sheet and only runs against a PR preview`);
}

// ---- recovery of an earlier cancelled or killed run --------------------------------------------------------------------------------------------------
// The crawl hides all nine lines of the admin's member and plants a value in goals and launch_state. A run that is cancelled or killed after that leaves the member hidden for every
// other test that reads the preview. A preview's seed has every line visible and no goals or launch_state, so the original is derived from the seed: the planted lines go back to
// empty and every line back to visible. A member with no planted marker is left alone (nothing is written). Used at the start of the crawl and at the start of the api job (tests/api/recover-preview.mjs).
export const PLANTED_MARKER = /^qz(goal|launch)/i;
const leftover = (f) => ["goals", "launch_state"].some((k) => f && f[k] && typeof f[k].value === "string" && PLANTED_MARKER.test(f[k].value));
export async function assertIsPreview(call) {
  let health;
  try { health = JSON.parse((await call("GET", "/api/health", {})).text); } catch { throw new Error("GET /api/health: not JSON"); }
  if (health.isPrPreview !== true) throw new Error("GET /api/health does not say isPrPreview:true: this crawl writes to a member's sheet and only runs against a PR preview");
}
// adminCall(method, path, body) -> { status, text, headers }. Returns { mine, recovered } where mine is the admin sheet read as the original of this run.
export async function recoverTarget({ adminCall, say = () => {} }) {
  const read = async () => {
    const r = await adminCall("GET", "/api/sheet");
    if (r.status !== 200) throw new Error(`GET /api/sheet (admin): HTTP ${r.status}`);
    try { return JSON.parse(r.text); } catch { throw new Error(`GET /api/sheet: not JSON (HTTP ${r.status})`); }
  };
  let mine = await read();
  if (!mine.slug) throw new Error("the admin sheet read names no member");
  let recovered = false;
  if (leftover(mine.sheet && mine.sheet.fields)) {
    for (const k of SHEET_FIELDS) {
      const r = k === "goals" || k === "launch_state" ? await adminCall("POST", "/api/sheet", { field: k, value: null, visible: true }) : await adminCall("POST", "/api/sheet", { field: k, visible: true });
      if (r.status !== 200) throw new Error(`recovery of an earlier killed run: POST /api/sheet ${k}: HTTP ${r.status}`);
    }
    mine = await read();
    if (leftover(mine.sheet && mine.sheet.fields)) throw new Error("recovery of an earlier killed run did not clear the planted values");
    recovered = true;
    say("recovered the target's sheet from an earlier run that was cancelled or killed (planted lines emptied, every line visible, as the preview's seed has them)");
  }
  return { mine, recovered };
}

// ---- the crawl --------------------------------------------------------------------------------------------------------------------------------------
// call(method, path, { headers, body }) -> { status, text, headers: [[name, value], ...] }   path starts with /api
// live(trigger) -> Promise<string[]>   opens an anonymous socket, awaits trigger(), returns what the room sent
// admin: { Authorization: "Bearer ..." } (the preview's admin token; never printed)
// Returns the report object; throws when anything is found or could not be checked.
export async function runPreviewCrawl({ call, live, admin, say = () => {}, concurrency = 4 }) {
  const json = (r, what) => { try { return JSON.parse(r.text); } catch { throw new Error(`${what}: not JSON (HTTP ${r.status})`); } };
  const adminCall = (method, path, body) => call(method, path, { headers: { ...admin }, body });
  const expect200 = (r, what) => { if (r.status !== 200) throw new Error(`${what}: HTTP ${r.status}`); return r; };

  // 1. preview only
  await assertIsPreview(call);

  // 2. the target. The admin token writes as the Worker's default admin member (POST /api/sheet), so that is the member whose nine lines can be hidden here.
  // A run that was cancelled or killed leaves the nine lines hidden and a planted value behind: recoverTarget puts them back first (the api job runs the same recovery before any other test).
  const { mine } = await recoverTarget({ adminCall, say });
  const slug = mine.slug, name = String(mine.name || "");
  const original = {};
  for (const k of SHEET_FIELDS) {
    const e = mine.sheet && mine.sheet.fields ? mine.sheet.fields[k] : undefined;
    original[k] = { value: e && e.value !== undefined ? e.value : null, visible: !e || e.visible !== false };
  }
  const stored = json(expect200(await adminCall("GET", "/api/data/party?stored=1"), "GET /api/data/party?stored=1 (admin)"), "stored party");
  const members = Array.isArray(stored.members) ? stored.members : [];
  const docMember = members.find((x) => norm(x.name) === norm(name));
  // the log and the artifact name the target by position and a salted hash, never by name or slug
  const label = `member #${members.indexOf(docMember) + 1} (${createHash("sha256").update(`${randomBytes(4).toString("hex")}${slug}`).digest("hex").slice(0, 8)})`;
  if (!docMember) throw new Error("the target is not in the stored party document");
  const others = members.filter((x) => x !== docMember);
  const salt = randomBytes(4).toString("hex");
  const planted = { goals: `qzgoal${salt} for the crawl`, launch_state: `qzlaunch${salt}` };
  const plantedB = `qzgoalb${salt} second write`;
  const ctx = { identity: [name, slug] };
  const built = buildCanaries({ sheetFields: original, docMember, others, planted: { ...planted } });
  // the target must be told apart from the rest of the party: its class and its class key belong to nobody else
  for (const k of ["class", "class_key"]) {
    const vals = new Set(variants(docMember[k]).map(norm));
    if (!vals.size) throw new Error(`the target has no ${k}`);
    if (built.shared.includes(k)) throw new Error(`the target's ${k} is also another member's: pick a target whose class is unique in the party`);
  }
  const fieldsWithCanary = new Set(built.canaries.map((c) => c.field));
  for (const k of ["class", "class_key", "color", "spec", "board_line", "goals", "launch_state"]) if (!fieldsWithCanary.has(k)) throw new Error(`no searchable canary for ${k}`);

  const writeSheet = async (body) => {
    const r = await adminCall("POST", "/api/sheet", body);
    if (r.status !== 200) throw new Error(`POST /api/sheet ${body.field}: HTTP ${r.status}`);
    return r;
  };
  const readSheet = async () => json(expect200(await adminCall("GET", "/api/sheet"), "GET /api/sheet (admin)"), "GET /api/sheet").sheet.fields || {};
  const state = { restoreAttempted: false };
  let main = null;
  const answers = [];
  const report = { at: new Date().toISOString(), target: label, routes: [], live: null, canaries: { searched: {}, skipped: built.skipped, shared: built.shared }, hits: [], restored: false };
  for (const c of built.canaries) report.canaries.searched[c.field] = (report.canaries.searched[c.field] || 0) + 1;

  try {
    // 3. hide all nine lines, every value kept. The two free-text lines get a planted value first (a value that cannot be a game word), written already hidden.
    await writeSheet({ field: "goals", value: planted.goals, visible: false });
    await writeSheet({ field: "launch_state", value: planted.launch_state, visible: false });
    for (const k of SHEET_FIELDS) if (k !== "goals" && k !== "launch_state") await writeSheet({ field: k, visible: false });
    const hidden = await readSheet();
    for (const k of SHEET_FIELDS) if (!hidden[k] || hidden[k].visible !== false) throw new Error(`could not hide ${k}`);
    say(`hidden: all ${SHEET_FIELDS.length} lines of the target; canary fields searched: ${Object.keys(report.canaries.searched).join(", ")}; skipped (too short): ${built.skipped.join(", ") || "none"}; shared with another member (not searched): ${built.shared.join(", ") || "none"}`);

    // positive control: the admin's own reads still hold the values, so the search below can find them. A search that cannot find them proves nothing.
    const control = findHits(built.canaries, [expect200(await adminCall("GET", "/api/sheet"), "control read"), expect200(await adminCall("GET", "/api/data/party?stored=1"), "control read")], ctx);
    for (const k of ["class", "class_key", "goals", "launch_state"]) if (!control.includes(k)) throw new Error(`the search does not find ${k} in the admin's own read: the test cannot see`);

    // 4. crawl, anonymous: no Authorization, no cookie
    const list = crawlPaths();
    if (list.length < 20) throw new Error(`only ${list.length} paths derived from ROUTES`);
    let next = 0;
    const one = async () => {
      for (;;) {
        const i = next++;
        if (i >= list.length) return;
        const { route, path } = list[i];
        let r = null;
        for (let attempt = 0; attempt < 4; attempt++) {
          r = await call("GET", `/api${path}`, {});
          if (r.status !== 429) break;
          await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
        }
        if (r.status === 429) throw new Error(`GET /api${path}: still rate limited after 4 tries: the crawl is incomplete`);
        answers.push({ route, path, status: r.status, hits: findHits(built.canaries, [{ ...r, path }], ctx) });
      }
    };
    await Promise.all(Array.from({ length: concurrency }, one));
    report.routes = answers.sort((a, b) => (a.path < b.path ? -1 : 1)).map((a) => ({ route: a.route, path: a.path, status: a.status, hits: a.hits }));

    // the live socket, with one harmless admin write that must broadcast: the hidden line gets a different hidden value
    const messages = await live(async () => { await writeSheet({ field: "goals", value: plantedB, visible: false }); });
    const liveCanaries = [...built.canaries, { field: "goals", value: plantedB.toLowerCase() }];
    report.live = { messages: messages.length, hits: findHits(liveCanaries, messages.map((m) => ({ text: m, headers: [] })), ctx) };
    if (!messages.length) throw new Error("the live socket delivered no message (not even the greeting): nothing was checked");
    for (const a of report.routes) for (const h of a.hits) if (!report.hits.includes(h)) report.hits.push(h);
    for (const h of report.live.hits) if (!report.hits.includes(h)) report.hits.push(h);
    report.hits.sort();
  } catch (e) {
    main = e;
    e.report = report; // the partial table and artifact are still written (tests/api/preview-crawl.test.mjs)
    throw e;
  } finally {
    if (!report.routes.length && answers.length) report.routes = answers.sort((a, b) => (a.path < b.path ? -1 : 1)).map((a) => ({ route: a.route, path: a.path, status: a.status, hits: a.hits }));
    // 7. put every line back: value and visibility as they were, then read it back
    state.restoreAttempted = true;
    try {
      for (const k of SHEET_FIELDS) {
        const o = original[k];
        if (k === "goals" || k === "launch_state") await writeSheet({ field: k, value: o.value, visible: o.visible });
        else await writeSheet({ field: k, visible: o.visible });
      }
      const now = await readSheet();
      const bad = [];
      for (const k of SHEET_FIELDS) {
        const got = now[k] || { value: null };
        const gotVisible = got.visible !== false, gotValue = got.value === undefined ? null : got.value;
        if (gotVisible !== original[k].visible || JSON.stringify(gotValue) !== JSON.stringify(original[k].value)) bad.push(k);
      }
      if (bad.length) throw new Error(`the sheet was not restored for: ${bad.join(", ")}`);
      report.restored = true;
    } catch (e) {
      if (main) say(`ALSO: the restore failed: ${e.message}`);
      else { e.report = report; throw e; }
    }
  }
  return report;
}

// the table for stdout: route, status, hits as field names
export function formatTable(report) {
  const rows = report.routes.map((r) => `${String(r.status).padEnd(4)} ${(r.hits.length ? r.hits.join(",") : "-").padEnd(14)} GET ${r.path}`);
  return [`preview crawl: ${report.routes.length} anonymous GET paths, target ${report.target}`, "status hits           route", ...rows, `live socket: ${report.live ? report.live.messages : 0} messages, hits: ${report.live && report.live.hits.length ? report.live.hits.join(",") : "-"}`, `restored: ${report.restored}`].join("\n");
}
