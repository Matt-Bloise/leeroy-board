// The ONE place that decides what an anonymous reader sees of a member's build. Read time only: every writer stores the whole party document
// (race, class, spec, professions and what is derived from them), and every anonymous read passes through the functions below. Hiding a field
// therefore loses nothing, showing it again brings back the stored value, and a write that races a hide cannot leak: the stored row may hold the
// value, no read shows it. Pure: no I/O except loadPublicInputs. Imports nothing but the cycle-free sheet-match.js.
//
// Who calls what (tests/unit/public-read-paths.test.mjs lists every anonymous read path and fails when one is missing a call):
//   projectForAnonymous(partyDoc, sheets)    the party document (members, settled lines, open items)
//   projectSheets(sheets, ownerSlug)         the sheet list ({slug, name, fields}); the owner's own sheet stays whole
//   projectDataDoc(name, doc, inputs)        any /data/<name> document: party, decide, tonight carry member data; every other name passes through
//   projectBroadcast(payload, inputs)        a socket message ({type:"state", party: sheets} and {type:"data", key, data})
//   loadPublicInputs(env, opts)              reads the stored party row and the sheets once, for the callers that have neither in hand
import { sheetForDocMember } from "./sheet-match.js";

// The sheet fields a member can hide, as bits. `level`, `launch_state` and `goals` are not in the party document and derive nothing.
const BIT = { race: 1, class: 2, spec_path: 4, spec_at_40: 8, professions: 16, plan_zone: 32, level: 64, launch_state: 128, goals: 256 };
const FIELDS = Object.keys(BIT);
const SPEC = BIT.spec_path | BIT.spec_at_40;
const ALL = 511;

// The cascade: a hidden sheet field removes itself and everything derived from it, in the party document ("doc": member keys) and in the public
// sheet list ("sheet": sheet fields). `role` is NOT in any list: it is public and is not a sheet field. role_detail is the level-40 role line, so it
// follows the spec (and the class, which names the spec). role_now and role_from are the same line parsed by the page.
const SPEC_DOC = ["spec", "spec_status", "role_detail", "role_now", "role_from", "board_line", "spec_path", "spec_at_40"];
export const CASCADE = Object.freeze({
  race: { doc: ["race", "board_line", "start_zone", "plan_zone"], sheet: ["race", "plan_zone"] },
  class: { doc: ["class", "class_key", "color", ...SPEC_DOC], sheet: ["class", "spec_path", "spec_at_40"] },
  spec_path: { doc: SPEC_DOC, sheet: ["spec_path"] },
  spec_at_40: { doc: SPEC_DOC, sheet: ["spec_at_40"] },
  professions: { doc: ["professions"], sheet: ["professions"] },
  plan_zone: { doc: ["start_zone", "plan_zone"], sheet: ["plan_zone"] },
  level: { doc: [], sheet: ["level"] },
  launch_state: { doc: [], sheet: ["launch_state"] },
  goals: { doc: [], sheet: ["goals"] },
});
export const SHEET_FIELD_NAMES = Object.freeze(FIELDS.slice());

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

// Which sheet fields this sheet hides, as a bitmask (only an explicit visible:false hides; a junk row or junk fields hide nothing).
function maskOf(sheet) {
  const f = sheet && sheet.fields;
  if (!isObj(f)) return 0;
  let mask = 0;
  for (const k of FIELDS) { const v = f[k]; if (isObj(v) && v.visible === false) mask |= BIT[k]; }
  return mask;
}

// Per-call index of the sheet list: skips null and junk rows (they used to throw), and keeps sheetForDocMember's identity rules (exact lowercase
// name first, else a sheet whose name is not itself a document member and whose normalised name matches). Not an array -> null (fail closed).
function indexSheets(sheets) {
  if (!Array.isArray(sheets)) return null;
  const rows = sheets.filter((s) => isObj(s));
  return rows.length === sheets.length ? sheets : rows;
}
function matcher(rows, members) {
  // sheetForDocMember is the one identity rule (tests/unit/sheets-reconcile.test.mjs pins it to party-source.js); a lookup table keeps it O(n) for a big party.
  const exact = new Map();
  for (const s of rows) { const k = String(s.name || "").toLowerCase(); if (!exact.has(k)) exact.set(k, s); }
  return (m) => exact.get(String(m && m.name || "").toLowerCase()) || sheetForDocMember(rows, members, m) || null;
}

function strip(obj, keys) {
  let out = null;
  for (const k of keys) if (k in obj) { if (!out) out = { ...obj }; delete out[k]; }
  return out || obj;
}
function docKeysFor(mask) {
  const keys = [];
  for (const k of FIELDS) if (mask & BIT[k]) keys.push(...CASCADE[k].doc);
  return keys;
}
function sheetKeysFor(mask) {
  const keys = [];
  for (const k of FIELDS) if (mask & BIT[k]) keys.push(...CASCADE[k].sheet);
  return keys;
}

// Hidden masks of every member of a stored party document, in document order. sheets === null (unreadable) hides everything for everyone.
function masksFor(members, rows) {
  if (!rows) return members.map(() => ALL);
  const find = matcher(rows, members);
  return members.map((m) => (isObj(m) ? maskOf(find(m)) : 0));
}

const lines = (v) => (Array.isArray(v) ? v : null);
const lineText = (l) => (typeof l === "string" ? l : l && typeof l === "object" && typeof l.text === "string" ? l.text : "");

// The party document an anonymous reader may see. Non-mutating (the stored row and any cached copy are never touched); members that hide nothing are
// shared, not copied. `settled` and `settled_extra` lines that name a member who hid class or spec are dropped (they carry role words and
// "from level N"). When someone hides their professions, the open "Gap: ..." clause is dropped (it is the professions nobody has).
export function projectForAnonymous(partyDoc, sheets) {
  if (!isObj(partyDoc) || !Array.isArray(partyDoc.members)) return partyDoc;
  const st = stateOf(partyDoc, sheets);
  const masks = st.masks;
  const names = [];
  let anyPro = false;
  const members = partyDoc.members.map((m, i) => {
    const mask = masks[i];
    if (!mask) return m;
    if (mask & (BIT.class | SPEC) && isObj(m) && typeof m.name === "string" && m.name) names.push(m.name.toLowerCase());
    if (mask & BIT.professions) anyPro = true;
    return isObj(m) ? strip(m, docKeysFor(mask)) : m;
  });
  const out = { ...partyDoc, members };
  if (names.length) {
    for (const key of ["settled", "settled_extra"]) {
      const list = lines(partyDoc[key]);
      if (list) out[key] = list.filter((l) => { const t = lineText(l).toLowerCase(); return !names.some((n) => t.includes(n)); });
    }
  }
  if (anyPro && lines(partyDoc.open)) {
    out.open = partyDoc.open.map((o) => (isObj(o) && /profession/i.test(String(o.title || "")) && typeof o.text === "string" ? { ...o, text: o.text.replace(/\s*Gap:[^.]*\.?/i, "").trim() } : o));
  }
  return scrubDoc(out, st, ["members"]); // the other text of the document (open items, polls, glossary) must not carry a hiding member's value either
}

// The public sheet list. Hidden fields and what the cascade removes with them are gone; null and junk rows are dropped; the owner's own sheet is whole.
export function projectSheets(sheets, ownerSlug = null) {
  const rows = indexSheets(sheets);
  if (!rows) return [];
  return rows.map((s) => {
    if (ownerSlug && s.slug === ownerSlug) return s;
    if (!isObj(s.fields)) return { ...s, fields: {} };
    // Any field that says visible:false goes (a field this code has never heard of included), and so does what the cascade ties to a known hidden one.
    const gone = new Set(sheetKeysFor(maskOf(s)));
    let fields = null;
    for (const [k, f] of Object.entries(s.fields)) {
      if (gone.has(k) || (isObj(f) && f.visible === false)) { if (!fields) { fields = { ...s.fields }; } delete fields[k]; }
    }
    return fields ? { ...s, fields } : s;
  });
}

// ---- documents derived from the party (kv_state 'decide', 'tonight', 'guided-atlas', 'client', 'launch') ----------------------------------------
// decide and tonight list people in party order, keyed by class_key. decide.people entries are dropped when the person hides race, class or spec (the entry
// says "Tauren Feral Druid" in its locked line, its spec40 and talents cards are class-specific); with professions hidden only the professions card goes.
// Dropping, not reordering: the entries carry no names, the page pairs them with members by class_key, and a dropped entry says nothing about the class.
// decide.party (roles by level, buffs, the classes and professions "nobody at this table" has) is a composition of the whole party: when anyone hides
// class, spec or professions it would give the hidden value back by elimination, so it is withheld and the page says so.
// Then every member document is scrubbed as text (scrubDoc): a line that carries a {class} token of a member who hid class, spec or professions, or a word that
// only a hiding member has (their race, class, spec, profession or zone), is dropped. "Only" = no member who shows that field has the same value.
// The hidden mask that applies to one people entry. By position when the entry and the stored member at that position agree on class_key (the documents are
// generated together, in party order); else the union over the stored members with that class_key AND over every stored member that has no class_key (an old
// row a writer stripped cannot be told apart from this entry); else (no member to pair with, or no stored party document) the union over every member,
// which is the strict choice. Unreadable sheets are everything.
function personMask(st, p, i, byIndex) {
  if (st.unreadable) return ALL;
  if (byIndex && st.members[i] && st.members[i].class_key === p.class_key) return st.masks[i];
  let m = 0, found = false;
  for (let j = 0; j < st.members.length; j++) {
    const k = isObj(st.members[j]) ? st.members[j].class_key : undefined;
    if (k === p.class_key && k !== undefined) { m |= st.masks[j]; found = true; }
    else if (k === undefined || k === null || k === "") m |= st.masks[j];
  }
  return found ? m : st.union;
}
function stateOf(partyDoc, sheets) {
  const members = isObj(partyDoc) && Array.isArray(partyDoc.members) ? partyDoc.members : [];
  const rows = indexSheets(sheets);
  const masks = masksFor(members, rows);
  let union = 0;
  for (const m of masks) union |= m;
  if (rows) for (const s of rows) union |= maskOf(s); // sheets of people the stored party document does not list
  return { members, masks, rows, unreadable: !rows, union: rows ? union : ALL };
}

// ---- what is hidden, as text ------------------------------------------------------------------------------------------------------------------
const NEEDLE_DOC_KEYS = ["race", "class", "class_key", "color", "spec", "start_zone", "board_line", "role_detail", "plan_zone"];
const lc = (v) => String(v).trim().toLowerCase();
const named = (x) => (typeof x === "string" ? x : isObj(x) ? x.name : null);
function valuesOf(obj, keys) {
  const out = [];
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim().length >= 3) out.push(lc(v));
    else if (k === "professions" && Array.isArray(v)) for (const x of v) { const n = named(x); if (typeof n === "string" && n.trim().length >= 3) out.push(lc(n)); }
  }
  return out;
}
function sheetValues(s, fieldNames) {
  const out = [];
  if (!isObj(s) || !isObj(s.fields)) return out;
  for (const k of fieldNames) {
    const f = s.fields[k];
    const v = isObj(f) ? f.value : undefined;
    if (typeof v === "string" && v.trim().length >= 3) out.push(lc(v));
    else if (Array.isArray(v)) for (const x of v) { const n = named(x); if (typeof n === "string" && n.trim().length >= 3) out.push(lc(n)); }
  }
  return out;
}
// Everything a reader could learn from a text line: the words and phrases only hiding members have, and the class_keys whose {token} must not appear.
function exposureOf(st) {
  if (st.exposure) return st.exposure;
  const hide = new Set(), show = new Set();
  const restricted = new Set(), shownKeys = new Set(), allKeys = new Set();
  st.members.forEach((m, i) => {
    if (!isObj(m)) return;
    const mask = st.unreadable ? ALL : st.masks[i];
    const gone = new Set(docKeysFor(mask));
    const key = typeof m.class_key === "string" && m.class_key ? lc(m.class_key) : null;
    if (key) { allKeys.add(key); if (mask & (BIT.class | SPEC | BIT.professions)) restricted.add(key); if (!(mask & BIT.class)) shownKeys.add(key); }
    const goneKeys = NEEDLE_DOC_KEYS.filter((k) => gone.has(k)), keptKeys = NEEDLE_DOC_KEYS.filter((k) => !gone.has(k));
    for (const v of valuesOf(m, goneKeys)) hide.add(v);
    for (const v of valuesOf(m, keptKeys)) show.add(v);
    for (const v of valuesOf(m, ["professions"])) (gone.has("professions") ? hide : show).add(v);
  });
  if (st.rows) for (const s of st.rows) {
    const goneS = new Set(sheetKeysFor(maskOf(s)));
    const all = ["race", "class", "spec_path", "spec_at_40", "professions", "plan_zone"];
    for (const v of sheetValues(s, all.filter((k) => goneS.has(k)))) hide.add(v);
    for (const v of sheetValues(s, all.filter((k) => !goneS.has(k)))) show.add(v);
  }
  const words = new Set(), phrases = [];
  for (const v of hide) {
    if (show.has(v)) continue;
    if (/^[\p{L}\p{N}_]+$/u.test(v)) words.add(v); else phrases.push(v);
  }
  st.exposure = { memo: new Map(), words, phrases, restricted, shownKeys, allKeys, anyClassHidden: st.unreadable || !!(st.union & BIT.class), unreadable: st.unreadable };
  return st.exposure;
}
function lineIsBad(s, ex) {
  if (typeof s !== "string" || !s) return false;
  let r = ex.memo.get(s); // a document repeats its phrases (every people entry carries the same lines): each distinct string is judged once per read
  if (r === undefined) { r = judge(s, ex); ex.memo.set(s, r); }
  return r;
}
function judge(s, ex) {
  const low = s.toLowerCase();
  if (low.includes("{")) for (const m of low.matchAll(/\{([a-z0-9_-]+)\}/g)) {
    const k = m[1];
    if (ex.unreadable || ex.restricted.has(k) || (ex.allKeys.has(k) && ex.anyClassHidden && !ex.shownKeys.has(k))) return true;
  }
  if (ex.words.size) for (const w of low.split(/[^\p{L}\p{N}_]+/u)) if (w && ex.words.has(w)) return true;
  for (const p of ex.phrases) if (low.includes(p)) return true;
  return false;
}
// True when one of the object's own strings (or a list of strings it holds) is bad. No allocation: this runs once per array element of a document that can be a megabyte.
function ownTextIsBad(o, ex) {
  for (const k in o) {
    if (k === "src") continue;
    const v = o[k];
    if (typeof v === "string") { if (lineIsBad(v, ex)) return true; }
    else if (Array.isArray(v)) for (let i = 0; i < v.length; i++) if (typeof v[i] === "string" && lineIsBad(v[i], ex)) return true;
  }
  return false;
}
// Walks a document and drops every array element, and every object key, whose own text is bad. `src` objects (citations) are left alone. Never mutates.
function scrubNode(node, ex, depth = 0) {
  if (depth > 12) return node;
  if (Array.isArray(node)) {
    let out = null;
    node.forEach((it, i) => {
      let next = it, drop = false;
      if (typeof it === "string") drop = lineIsBad(it, ex);
      else if (isObj(it)) drop = ownTextIsBad(it, ex);
      if (!drop && (isObj(it) || Array.isArray(it))) next = scrubNode(it, ex, depth + 1);
      if ((drop || next !== it) && !out) out = node.slice(0, i);
      if (out && !drop) out.push(next);
    });
    return out || node;
  }
  if (isObj(node)) {
    let out = null;
    for (const k in node) {
      if (k === "src") continue;
      const v = node[k];
      let next = v, drop = false;
      if (typeof v === "string") drop = lineIsBad(v, ex);
      else if (isObj(v) || Array.isArray(v)) next = scrubNode(v, ex, depth + 1);
      if (drop || next !== v) { if (!out) out = { ...node }; if (drop) delete out[k]; else out[k] = next; }
    }
    return out || node;
  }
  return node;
}
function scrubDoc(doc, st, skip = []) {
  const ex = exposureOf(st);
  if (!ex.words.size && !ex.phrases.length && !ex.restricted.size && !(ex.anyClassHidden && ex.allKeys.size)) return doc;
  const out = { ...doc };
  for (const k of Object.keys(doc)) {
    if (skip.includes(k)) continue;
    if (typeof doc[k] === "string") { if (lineIsBad(doc[k], ex)) delete out[k]; } // a top-level text (tonight.launch, party.party) goes whole
    else out[k] = scrubNode(doc[k], ex);
  }
  return out;
}

export function projectDecide(doc, partyDoc, sheets) {
  if (!isObj(doc)) return doc;
  const st = stateOf(partyDoc, sheets);
  if (!st.union) return doc;
  const out = { ...doc };
  if (Array.isArray(doc.people)) {
    const byIndex = doc.people.length === st.members.length;
    const noGroup = !!(st.union & BIT.professions); // "also {class}'s" lines under a decision name the profession of someone who hid it
    out.people = doc.people.flatMap((p, i) => {
      if (!isObj(p)) return [];
      const mask = personMask(st, p, i, byIndex);
      if (mask & (BIT.race | BIT.class | SPEC)) return [];
      if (!Array.isArray(p.decisions)) return [p];
      const decisions = p.decisions
        .filter((d) => !(mask & BIT.professions && isObj(d) && d.key === "professions"))
        .map((d) => { if (!(noGroup && isObj(d) && "group" in d)) return d; const { group, ...rest } = d; return rest; });
      return [{ ...p, decisions }];
    });
  }
  if (st.union & (BIT.class | SPEC | BIT.professions) && isObj(doc.party)) out.party = { withheld: true, brackets: [], role_lines: [], buffs: [], nobody: { classes: [], professions: [], secondaries: [], buffs: [] }, lines: Array.isArray(doc.party.lines) ? doc.party.lines : [] }; // same shape, so the page never reads a missing key
  return scrubDoc(out, st);
}

// tonight.people: { member: index into the party members, class_key, step }. A hidden class loses class_key; a step ("Choose your spec", "Choose
// Enchanting or Alchemy") is dropped when the class, spec or professions are hidden. week_one.trainers is keyed by class: a class only a hiding member has is dropped.
export function projectTonight(doc, partyDoc, sheets) {
  if (!isObj(doc)) return doc;
  const st = stateOf(partyDoc, sheets);
  if (!(st.union & (BIT.class | SPEC | BIT.professions | BIT.race | BIT.plan_zone))) return doc;
  const out = { ...doc };
  const shown = new Set();
  if (!st.unreadable) st.members.forEach((m, i) => { if (isObj(m) && m.class_key && !(st.masks[i] & BIT.class)) shown.add(m.class_key); });
  if (Array.isArray(doc.people)) {
    out.people = doc.people.map((p) => {
      if (!isObj(p)) return p;
      const mask = Number.isInteger(p.member) && p.member >= 0 && p.member < st.members.length && !st.unreadable ? st.masks[p.member] : personMask(st, p, -1, false);
      if (!(mask & (BIT.class | SPEC | BIT.professions))) return p;
      const q = { ...p, step: null };
      if (mask & BIT.class) delete q.class_key;
      return q;
    });
  }
  const trainers = doc.week_one && doc.week_one.trainers;
  if (isObj(trainers) && st.union & BIT.class) {
    const kept = {};
    for (const [k, v] of Object.entries(trainers)) if (shown.has(k)) kept[k] = v;
    out.week_one = { ...doc.week_one, trainers: kept };
  }
  return scrubDoc(out, st);
}

// guided-atlas: classes is keyed by class_key and each entry names the start zone, the trainer town and the route (race and plan_zone decide the start).
// A class key survives only when some member who shows their class has it; its start and town survive only when some such member shows race and plan_zone.
// Applied whenever anyone hides class, race or plan_zone (and always when the sheets are unreadable).
export function projectGuidedAtlas(doc, partyDoc, sheets) {
  if (!isObj(doc)) return doc;
  const st = stateOf(partyDoc, sheets);
  if (!(st.union & (BIT.class | BIT.race | BIT.plan_zone))) return doc;
  const out = { ...doc };
  if (isObj(doc.classes)) {
    const classes = {};
    for (const [key, v] of Object.entries(doc.classes)) {
      const showers = st.unreadable ? [] : st.members.map((m, i) => ({ m, mask: st.masks[i] })).filter(({ m, mask }) => isObj(m) && typeof m.class_key === "string" && lc(m.class_key) === lc(key) && !(mask & BIT.class));
      if (!showers.length) continue;
      const startOk = showers.some(({ mask }) => !(mask & (BIT.race | BIT.plan_zone)));
      if (!isObj(v) || startOk) { classes[key] = v; continue; }
      const { start, town, ...rest } = v;
      classes[key] = rest;
    }
    out.classes = classes;
  }
  return scrubDoc(out, st);
}

// client: classes keyed by the class name ("Mage"), racials keyed by the race name, synergy lists class_keys in from and to.
export function projectClient(doc, partyDoc, sheets) {
  if (!isObj(doc)) return doc;
  const st = stateOf(partyDoc, sheets);
  if (!(st.union & (BIT.class | BIT.race))) return doc;
  const out = { ...doc };
  const names = new Set(), keys = new Set(), races = new Set();
  if (!st.unreadable) st.members.forEach((m, i) => {
    if (!isObj(m)) return;
    if (!(st.masks[i] & BIT.class)) { if (typeof m.class === "string") names.add(lc(m.class)); if (typeof m.class_key === "string") { keys.add(lc(m.class_key)); names.add(lc(m.class_key)); } }
    if (!(st.masks[i] & BIT.race) && typeof m.race === "string") races.add(lc(m.race));
  });
  const keep = (obj, set) => Object.fromEntries(Object.entries(obj).filter(([k]) => set.has(lc(k))));
  if (st.union & BIT.class) {
    if (isObj(doc.classes)) out.classes = keep(doc.classes, names);
    if (Array.isArray(doc.synergy)) out.synergy = doc.synergy.filter((s) => isObj(s) && keys.has(lc(s.from))).map((s) => (Array.isArray(s.to) ? { ...s, to: s.to.filter((t) => keys.has(lc(t))) } : s));
  }
  if (st.union & BIT.race && isObj(doc.racials)) out.racials = keep(doc.racials, races);
  return scrubDoc(out, st, ["classes", "racials", "legacy", "buffs", "flags"]); // the spell and racial tables hold no member text; the keys were filtered above
}

// launch: the stored document is a list of {slug, name, state, at} rows, or {rows: [...], voice, checklist, ...}. A member who hid launch_state loses `state`.
// ownerSlug (the member asking in Discord) sees their own row whole. Unreadable sheets: no state for anyone.
export function projectLaunch(doc, sheets, ownerSlug = null) {
  const rows = indexSheets(sheets);
  const hides = (r) => {
    if (!rows) return true;
    if (ownerSlug && r.slug === ownerSlug) return false;
    const s = rows.find((x) => r.slug && x.slug === r.slug) || rows.find((x) => r.name && String(x.name || "").toLowerCase() === String(r.name).toLowerCase());
    return !!s && !!(maskOf(s) & BIT.launch_state);
  };
  const fix = (list) => list.map((r) => { if (!(isObj(r) && "state" in r && hides(r))) return r; const { state, ...rest } = r; return rest; });
  if (Array.isArray(doc)) return fix(doc);
  if (isObj(doc) && Array.isArray(doc.rows)) return { ...doc, rows: fix(doc.rows) };
  return doc;
}

// Names of the public documents that carry member data. Every /data/<name> read goes through projectDataDoc; any other name passes unchanged.
export const MEMBER_DOCS = Object.freeze(["party", "decide", "tonight", "guided-atlas", "client", "launch"]);
// inputs: { partyDoc (the STORED party document), sheets (array, or null when unreadable) }
export function projectDataDoc(name, doc, inputs) {
  const i = inputs || {};
  if (name === "party") return projectForAnonymous(doc, i.sheets);
  if (name === "decide") return projectDecide(doc, i.partyDoc, i.sheets);
  if (name === "tonight") return projectTonight(doc, i.partyDoc, i.sheets);
  if (name === "guided-atlas") return projectGuidedAtlas(doc, i.partyDoc, i.sheets);
  if (name === "client") return projectClient(doc, i.partyDoc, i.sheets);
  if (name === "launch") return projectLaunch(doc, i.sheets);
  return doc;
}

// A socket message. {type:"state", party:[sheets]} and {type:"data", key, data}; any other message carries no member data.
export function projectBroadcast(payload, inputs) {
  if (!isObj(payload)) return payload;
  if (payload.type === "state" && "party" in payload) return { ...payload, party: projectSheets(payload.party) };
  if (payload.type === "data" && MEMBER_DOCS.includes(payload.key) && payload.data !== undefined) return { ...payload, data: projectDataDoc(payload.key, payload.data, inputs) };
  return payload;
}

// Reads what the projections need: the stored party document and the sheet list (the same reconciled list GET /state uses). Never throws: a read that
// fails comes back as null, which every projection treats as "everything hidden" (fail closed). The sheets row is read here first, because
// buildPartySheetsFromD1 swallows a failed read and falls back to its visible-everything seed. Pass what the caller already read to skip a read.
export async function loadPublicInputs(env, { partyDoc, sheets } = {}) {
  let doc = partyDoc;
  if (doc === undefined) {
    try {
      const row = await env.DB.prepare("SELECT json FROM kv_state WHERE key = 'party'").first();
      doc = row && row.json ? JSON.parse(row.json) : null;
    } catch { return { partyDoc: null, sheets: null }; }
  }
  if (sheets !== undefined) return { partyDoc: doc, sheets: Array.isArray(sheets) ? sheets : null };
  try {
    const { buildPartySheetsFromD1 } = await import("./index.js"); // dynamic: index.js imports this module. strict: a read that fails throws, and that is null here
    return { partyDoc: doc, sheets: (await buildPartySheetsFromD1(env, { persist: false, partyDoc: doc, strict: true })).party };
  } catch { return { partyDoc: doc, sheets: null }; }
}

// What the writers do with the party document: copy a written value into the matching key, for the member whose sheet it is. The document stays whole
// (a hidden value is stored too); the value is copied only when it differs from the sheet's previous value, so hiding and showing a field again
// changes nothing in the stored row. Mutates partyDoc (the commit's own freshly parsed copy). Returns it.
const PUBLIC_KEY = { race: "race", class: "class", spec_path: "spec" };
export function writeSheetValueToDoc(partyDoc, sheets, sheet, field, value, prior) {
  const key = PUBLIC_KEY[field];
  if (!key || !isObj(partyDoc) || !Array.isArray(partyDoc.members) || value === undefined || value === null) return partyDoc;
  const same = prior && prior.value !== undefined && JSON.stringify(prior.value) === JSON.stringify(value);
  const rows = indexSheets(sheets) || [];
  const find = matcher(rows, partyDoc.members);
  // An unchanged value is not copied again, except into a card that lacks the key (a row an older version stripped when the field was hidden heals on the next write).
  for (const m of partyDoc.members) if (isObj(m) && find(m) === sheet && (!same || m[key] === undefined)) m[key] = String(value);
  return partyDoc;
}

// For tests and benchmarks: the member keys and sheet fields a hidden field removes.
export const cascadeOf = (field) => CASCADE[field];
