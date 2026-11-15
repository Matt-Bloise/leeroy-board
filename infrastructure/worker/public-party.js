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
  const rows = indexSheets(sheets);
  const masks = masksFor(partyDoc.members, rows);
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
  return out;
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

// ---- documents derived from the party (kv_state 'decide' and 'tonight') ------------------------------------------------------------------
// Both list people in party order, keyed by class_key. decide.people entries are dropped when the person hides race, class or spec (the entry says
// "Tauren Feral Druid" in its locked line, its spec40 and talents cards are class-specific); with professions hidden only the professions card goes.
// Dropping, not reordering: the entries carry no names, the page pairs them with members by class_key, and a dropped entry says nothing about the class.
// decide.party (roles by level, buffs, the classes and professions "nobody at this table" has) is a composition of the whole party: when anyone hides
// class, spec or professions it would give the hidden value back by elimination, so it is withheld and the page says so.
// The hidden mask that applies to one people entry. By position when the entry and the stored member at that position agree on class_key (the documents are
// generated together, in party order); else the union over the stored members with that class_key; else (no member to pair with, or no stored party
// document) the union over every member, which is the strict choice. Unreadable sheets are everything.
function personMask(st, p, i, byIndex) {
  if (st.unreadable) return ALL;
  if (byIndex && st.members[i] && st.members[i].class_key === p.class_key) return st.masks[i];
  let m = 0, found = false;
  for (let j = 0; j < st.members.length; j++) if (st.members[j] && st.members[j].class_key === p.class_key) { m |= st.masks[j]; found = true; }
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
export function projectDecide(doc, partyDoc, sheets) {
  if (!isObj(doc)) return doc;
  const st = stateOf(partyDoc, sheets);
  if (!st.union) return doc;
  const out = { ...doc };
  if (Array.isArray(doc.people)) {
    const byIndex = doc.people.length === st.members.length;
    out.people = doc.people.flatMap((p, i) => {
      if (!isObj(p)) return [];
      const mask = personMask(st, p, i, byIndex);
      if (mask & (BIT.race | BIT.class | SPEC)) return [];
      if (mask & BIT.professions && Array.isArray(p.decisions)) return [{ ...p, decisions: p.decisions.filter((d) => !(isObj(d) && d.key === "professions")) }];
      return [p];
    });
  }
  if (st.union & (BIT.class | SPEC | BIT.professions) && isObj(doc.party)) out.party = { withheld: true, brackets: [], role_lines: [], buffs: [], nobody: { classes: [], professions: [], secondaries: [], buffs: [] }, lines: Array.isArray(doc.party.lines) ? doc.party.lines : [] }; // same shape, so the page never reads a missing key
  return out;
}

// tonight.people: { member: index into the party members, class_key, step }. A hidden class loses class_key; a step ("Choose your spec", "Choose
// Enchanting or Alchemy") is dropped when the class, spec or professions are hidden. week_one.trainers is keyed by class: a class only a hiding member has is dropped.
export function projectTonight(doc, partyDoc, sheets) {
  if (!isObj(doc)) return doc;
  const st = stateOf(partyDoc, sheets);
  if (!(st.union & (BIT.class | SPEC | BIT.professions))) return doc;
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
  if (isObj(trainers)) {
    const kept = {};
    for (const [k, v] of Object.entries(trainers)) if (shown.has(k)) kept[k] = v;
    out.week_one = { ...doc.week_one, trainers: kept };
  }
  return out;
}

// Names of the public documents that carry member data. Every /data/<name> read goes through projectDataDoc; any other name passes unchanged.
export const MEMBER_DOCS = Object.freeze(["party", "decide", "tonight"]);
// inputs: { partyDoc (the STORED party document), sheets (array, or null when unreadable) }
export function projectDataDoc(name, doc, inputs) {
  const i = inputs || {};
  if (name === "party") return projectForAnonymous(doc, i.sheets);
  if (name === "decide") return projectDecide(doc, i.partyDoc, i.sheets);
  if (name === "tonight") return projectTonight(doc, i.partyDoc, i.sheets);
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
  let parsed = null;
  try {
    const row = await env.DB.prepare("SELECT json FROM kv_state WHERE key = 'party_sheets'").first();
    if (row && row.json) { try { parsed = JSON.parse(row.json); } catch { parsed = null; } }
  } catch { return { partyDoc: doc, sheets: null }; }
  try {
    if (Array.isArray(parsed) && parsed.length > 0) {
      const { reconcileSheetsWithDoc } = await import("./party-source.js"); // dynamic: party-source imports config.js, which imports cards.js, which imports this module
      return { partyDoc: doc, sheets: isObj(doc) ? reconcileSheetsWithDoc(parsed, doc) : parsed };
    }
    const { buildPartySheetsFromD1 } = await import("./index.js"); // no usable row yet: rebuilt from base + sheet_events, exactly as GET /state does
    return { partyDoc: doc, sheets: (await buildPartySheetsFromD1(env, { persist: false, partyDoc: doc })).party };
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
