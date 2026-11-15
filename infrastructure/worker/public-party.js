// The ONE place that decides what an anonymous reader sees of a member's build. Read time only: every writer stores the whole party document
// (race, class, spec, professions and what is derived from them), and every anonymous read passes through the functions below. Hiding a field
// therefore loses nothing, showing it again brings back the stored value, and a write that races a hide cannot leak: the stored row may hold the
// value, no read shows it. Pure: no I/O except loadPublicInputs. Imports nothing but the cycle-free sheet-match.js.
//
// Two rules, and no text matching anywhere:
//   1. A member's own fields (the party document's member keys, the public sheet list) are removed by the cascade table below when that member hides the field.
//   2. The COMPOSITES (decide, client, guided-atlas, tonight, the party document's settled/open lines, the cards' build parts, the ask prompt's party builds) are built from
//      the whole party, so they give a hidden value back directly or by elimination. While ANY member hides ANY of the nine sheet lines (or the sheets cannot be read), every
//      member-derived section of every composite is withheld whole and WITHHELD_LINE stands in its place. Sections that do not depend on the party stay.
//
// Who calls what (tests/unit/public-read-paths.test.mjs and public-read-enumerate.test.mjs list every anonymous read path and fail when one is missing a call):
//   projectForAnonymous(partyDoc, sheets)    the party document (members by the cascade; settled, settled_extra, open withheld while anyone hides)
//   projectSheets(sheets, ownerSlug)         the sheet list ({slug, name, fields}); the owner's own sheet stays whole
//   projectDataDoc(name, doc, inputs)        any /data/<name> document: party, decide, tonight, guided-atlas, client, launch carry member data; every other name passes through
//   projectBroadcast(payload, inputs)        a socket message ({type:"state", party: sheets} and {type:"data", key, data})
//   loadPublicInputs(env, opts)              reads the stored party row and the sheets once, for the callers that have neither in hand
//   anyHidden / sheetsHideAnything           the question rule 2 asks (the ask prompt has no party document in hand)
import { sheetForDocMember } from "./sheet-match.js";
import { slugify } from "./member-model.js";

// The sheet fields a member can hide, as bits: every line of the sheet has a hide switch. `level`, `launch_state` and `goals` are not in the party document and derive nothing.
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

// Which sheet fields this sheet hides, as a bitmask. Fails closed, the same rule as ask-build.js isVisible: a field is public ONLY when its entry is an object with
// visible === true. Any other entry (null, a bare value, a list, visible missing or not a boolean) is hidden, and a sheet whose `fields` is not an object hides everything.
// Every writer stores a boolean `visible` (recordSheetEventInD1, the seed, the event replay) and the production rows all carry one, so real data is unaffected.
function maskOf(sheet) {
  const f = sheet && sheet.fields;
  if (!isObj(f)) return ALL;
  let mask = 0;
  for (const k of FIELDS) if (Object.hasOwn(f, k)) { const v = f[k]; if (!(isObj(v) && v.visible === true)) mask |= BIT[k]; }
  return mask;
}

// Per-call index of the sheet list: skips null and junk rows (they used to throw), and keeps sheetForDocMember's identity rules (exact lowercase
// name first, else a sheet whose name is not itself a document member and whose normalised name matches). Not an array -> null (fail closed).
function indexSheets(sheets) {
  if (!Array.isArray(sheets)) return null;
  const rows = sheets.filter((s) => isObj(s));
  return rows.length === sheets.length ? sheets : rows;
}
// Which sheets belong to a party-document member: those with their slug (the document has no slug key, so it is the slug of the name, as party-source.js sheetMemberFromDoc
// and reconcile derive it); else those with the same name (case-insensitive); else the one sheetForDocMember finds by normalised name. Every sheet of the winning tier counts
// (masksFor ORs them, so a second sheet of one person cannot unhide the first). No sheet at all: the empty list, which masksFor reads as hide everything.
function matcher(rows, members) {
  const bySlug = new Map(), byName = new Map();
  const add = (map, k, s) => { if (!k) return; const l = map.get(k); if (l) l.push(s); else map.set(k, [s]); };
  for (const s of rows) { add(bySlug, typeof s.slug === "string" ? s.slug : "", s); add(byName, String(s.name || "").toLowerCase(), s); }
  return (m) => {
    if (!isObj(m)) return [];
    const slug = typeof m.slug === "string" && m.slug ? m.slug : typeof m.name === "string" ? slugify(m.name) : "";
    const a = bySlug.get(slug);
    if (a) return a;
    const b = byName.get(String(m.name || "").toLowerCase());
    if (b) return b;
    const c = sheetForDocMember(rows, members, m);
    return c ? [c] : [];
  };
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
  return members.map((m) => {
    if (!isObj(m)) return ALL; // a member row that is not an object cannot be matched to a sheet: fail closed
    const own = find(m);
    if (!own.length) return ALL; // a document member no sheet can be matched to: their visibility is unknown, so nothing of theirs is shown
    let mask = 0;
    for (const s of own) mask |= maskOf(s);
    return mask;
  });
}

// The party document an anonymous reader may see. Non-mutating (the stored row and any cached copy are never touched); members that hide nothing are
// shared, not copied. Each member loses the keys their hidden fields and the cascade name. Whenever ANY member hides ANY field, the lines that summarise the table
// (settled, settled_extra, open: "Tank: ... Healers: ...", "Gap: Alchemy", "Three starting zones, one square")
// are withheld whole and `withheld` carries the one plain line. polls, play and the links hold nothing of a member and stay.
export function projectForAnonymous(partyDoc, sheets) {
  // A document that is not an object, or whose `members` is not a list, cannot be filtered member by member: it is withheld whole (fail closed), never returned as stored.
  if (!isObj(partyDoc)) return withhold({}, { members: [], settled: [], settled_extra: [], open: [] });
  if (!Array.isArray(partyDoc.members)) return withhold({ ...partyDoc }, { members: [], settled: [], settled_extra: [], open: [] });
  const st = stateOf(partyDoc, sheets);
  // a member row that is not an object is dropped: there is nothing to strip, and nothing of it is shown
  const members = partyDoc.members.flatMap((m, i) => (!isObj(m) ? [] : st.masks[i] ? [strip(m, docKeysFor(st.masks[i]))] : [m]));
  const out = { ...partyDoc, members };
  if (st.union) return withhold(out, { settled: [], settled_extra: [], open: [] });
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
      if (gone.has(k) || !(isObj(f) && f.visible === true)) { if (!fields) { fields = { ...s.fields }; } delete fields[k]; }
    }
    return fields ? { ...s, fields } : s;
  });
}

// ---- documents derived from the party (kv_state 'decide', 'tonight', 'guided-atlas', 'client', 'launch') ----------------------------------------
// Design (fail closed): decide, client, guided-atlas, tonight and the open/settled lines of the party document are COMPOSITES. Each is built from the whole party
// (which classes, races, specs and professions the table has, and so which ones it does not), so any section of them that depends on a member gives a hidden value
// back, directly or by elimination. This code does not try to find the words: whenever ANY member hides ANY field, every member-derived section of every composite is
// withheld whole and the one plain line WITHHELD_LINE stands in its place. Sections that do not depend on the party (dates, labels, the launch
// event, the dungeon, the meeting place, the level cap, the legacy challenges, the glossary) stay. Nothing here reads or matches text.
export const WITHHELD_LINE = "Part of this is hidden because a member keeps their build private.";
function stateOf(partyDoc, sheets) {
  const members = isObj(partyDoc) && Array.isArray(partyDoc.members) ? partyDoc.members : [];
  const rows = indexSheets(sheets);
  const masks = masksFor(members, rows);
  let union = 0;
  for (const m of masks) union |= m;
  if (rows) for (const s of rows) union |= maskOf(s); // sheets of people the stored party document does not list
  return { members, masks, rows, unreadable: !rows, union: rows ? union : ALL };
}
// True when any member hides any hideable field (all nine), or the sheets could not be read.
export function anyHidden(partyDoc, sheets) { return stateOf(partyDoc, sheets).union !== 0; }
// The same question for the sheet list alone (the ask prompt has no party document in hand).
export function sheetsHideAnything(sheets) {
  const rows = indexSheets(sheets);
  if (!rows) return true;
  for (const s of rows) if (maskOf(s)) return true;
  return false;
}
const withhold = (doc, replace) => ({ ...doc, ...replace, withheld: WITHHELD_LINE });

export function projectDecide(doc, partyDoc, sheets) {
  if (isObj(doc) && !stateOf(partyDoc, sheets).union) return doc;
  doc = isObj(doc) ? doc : {}; // not an object: withheld, never passed on
  // people (every entry is one member's choices), party (roles, buffs, what nobody has): all member-derived. Same shapes, empty, so the page never reads a missing key.
  return withhold(doc, { people: [], party: { brackets: [], role_lines: [], buffs: [], nobody: { classes: [], professions: [], secondaries: [], buffs: [] }, lines: [] } });
}

export function projectTonight(doc, partyDoc, sheets) {
  if (isObj(doc) && !stateOf(partyDoc, sheets).union) return doc;
  doc = isObj(doc) ? doc : {};
  // people (member, class_key, step) and week_one.trainers (keyed by the party's classes) are member-derived.
  return withhold(doc, { people: [], week_one: isObj(doc.week_one) ? { ...doc.week_one, trainers: {} } : doc.week_one });
}

export function projectGuidedAtlas(doc, partyDoc, sheets) {
  if (isObj(doc) && !stateOf(partyDoc, sheets).union) return doc;
  doc = isObj(doc) ? doc : {};
  // classes (one entry per class at the table: the start zone, the trainer, the town) is member-derived; the dungeon, the meeting place and the level cap are not.
  return withhold(doc, { classes: {} });
}

export function projectClient(doc, partyDoc, sheets) {
  if (isObj(doc) && !stateOf(partyDoc, sheets).union) return doc;
  doc = isObj(doc) ? doc : {};
  // classes (spell tables of the classes at the table), racials (races at the table), synergy and buffs.list / buffs.rules (what the table's classes give each other)
  // are member-derived. The level cap, the build, the legacy challenges, the flags and the buff levels and marks are not.
  return withhold(doc, { classes: {}, racials: {}, synergy: [], buffs: isObj(doc.buffs) ? { ...doc.buffs, list: [], rules: [] } : doc.buffs });
}

// launch: the stored document is a list of {slug, name, state, at} rows, or {rows: [...], voice, checklist, ...}. A member who hid launch_state loses `state`.
// ownerSlug (the member asking in Discord) sees their own row whole. Unreadable sheets: no state for anyone.
export function projectLaunch(doc, sheets, ownerSlug = null) {
  const rows = indexSheets(sheets);
  const hides = (r) => {
    if (!rows) return true;
    if (ownerSlug && r.slug === ownerSlug) return false;
    // every sheet of the matching tier counts, as masksFor does: a second sheet of one person cannot unhide the first
    const bySlug = r.slug ? rows.filter((x) => x.slug === r.slug) : [];
    const own = bySlug.length ? bySlug : r.name ? rows.filter((x) => String(x.name || "").toLowerCase() === String(r.name).toLowerCase()) : [];
    return own.some((s) => !!(maskOf(s) & BIT.launch_state));
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
  for (const m of partyDoc.members) if (isObj(m) && find(m).includes(sheet) && (!same || m[key] === undefined)) m[key] = String(value);
  return partyDoc;
}

// For tests and benchmarks: the member keys and sheet fields a hidden field removes.
export const cascadeOf = (field) => CASCADE[field];
