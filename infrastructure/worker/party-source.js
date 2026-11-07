// Where the Worker learns who is in the party. The built-in lists (PARTY_MEMBERS here, ROSTER_DATA in bot-data.js) stay as the fallback
// and win for the five people they describe, so those five behave exactly as before. Everyone else comes from D1:
// the party document (kv_state 'party') and the roster (kv_state 'discord_members'). Adding a person needs no code change.
import { slugify } from "./member-model.js";
import { ROSTER_DATA } from "./bot-data.js";
import { loadConfigKey } from "./config.js";

export const PARTY_MEMBERS = [
  { slug: "santa", name: "Santa", race: "tauren", class: "druid", spec_path: "feral-tank", professions: ["leatherworking", "skinning"], plan_zone: "mulgore" },
  { slug: "bible-boi", name: "Bible Boi", race: "undead", class: "priest", spec_path: "discipline", professions: ["mining", "engineering"], plan_zone: "tirisfal-glades" },
  { slug: "street-rat", name: "Street Rat", race: "undead", class: "paladin", spec_path: "retribution", spec_at_40: "holy", professions: ["blacksmithing", "mining"], plan_zone: "tirisfal-glades" },
  { slug: "bloise", name: "Bloise", race: "undead", class: "mage", spec_path: "frost", spec_at_40: "fire", professions: ["tailoring", "enchanting"], plan_zone: "tirisfal-glades" },
  { slug: "handsome-squidward", name: "Handsome Squidward", race: "troll", class: "warlock", spec_path: "demonology", professions: ["enchanting", "tailoring"], plan_zone: "durotar" },
];

const kebab = (v) => String(v || "").toLowerCase().replace(/[ _]+/g, "-");

// One party-document member -> the sheet shape PARTY_MEMBERS uses. No spec or professions are invented: the document only has them as free text.
export function sheetMemberFromDoc(m) {
  if (!m || typeof m.name !== "string") return null;
  const slug = slugify(m.name);
  if (!slug) return null;
  const out = { slug, name: m.name, race: kebab(m.race), class: m.class_key || kebab(m.class) };
  if (m.start_zone) out.plan_zone = slugify(m.start_zone);
  return out;
}

// Built-ins first, then any party-document member whose slug the built-ins do not have.
export function mergePartyMembers(partyDoc, builtIn = PARTY_MEMBERS) {
  const list = builtIn.slice();
  const seen = new Set(list.map((m) => m.slug));
  for (const m of partyDoc && Array.isArray(partyDoc.members) ? partyDoc.members : []) {
    const s = sheetMemberFromDoc(m);
    if (s && !seen.has(s.slug)) {
      seen.add(s.slug);
      list.push(s);
    }
  }
  return list;
}

export async function loadPartyMembers(env) {
  try {
    const row = await env.DB.prepare("SELECT json FROM kv_state WHERE key = 'party'").first();
    return mergePartyMembers(row && row.json ? JSON.parse(row.json) : null);
  } catch {
    return PARTY_MEMBERS.slice();
  }
}

// Roster in the ROSTER_DATA shape ({ display, aliases }): built-ins first, then discord_members entries they do not cover.
export function mergeRoster(members, builtIn = ROSTER_DATA) {
  const list = builtIn.slice();
  const seen = new Set(list.map((r) => slugify(r.display)));
  for (const m of Array.isArray(members) ? members : []) {
    if (!m || typeof m.name !== "string" || seen.has(slugify(m.name))) continue;
    seen.add(slugify(m.name));
    list.push({ display: m.name, aliases: Array.isArray(m.match) ? m.match.slice() : [m.name.toLowerCase()] });
  }
  return list;
}

export async function loadRoster(env) {
  try {
    return mergeRoster(await loadConfigKey(env, "discord_members"));
  } catch {
    return ROSTER_DATA.slice();
  }
}

// The stored sheets row (kv_state 'party_sheets') is written once and then only edited by sheet writes, so a person added to the party
// document afterwards (admin add, /join) had no sheet and fell out of GET /api/state `party`, /sheet and the asker's own build. This adds a
// sheet for each party-document member the stored rows do not cover and changes nothing else. A member is covered by an exact slug or
// lowercase-name match. Only a stored sheet whose own name and slug are NO LONGER in the document (a true rename) also covers a document
// member whose name is the same minus a parenthetical ("Winton" -> "Winton (alt)"), once. Two document members that differ only by a
// parenthetical ("Sam (Horde)", "Sam (Alliance)") are two people. It never invents the built-in five. Pure; returns the same array when
// nothing is missing.
export const normName = (n) => slugify(String(n || "").replace(/[(][^)]*[)]/g, " "));

export function reconcileSheetsWithDoc(sheets, partyDoc, fields = ["race", "class", "spec_path", "professions", "plan_zone"]) {
  const list = Array.isArray(sheets) ? sheets : [];
  const docMembers = partyDoc && Array.isArray(partyDoc.members) ? partyDoc.members : [];
  const docSlugs = new Set(), docNames = new Set();
  for (const m of docMembers) {
    if (m && typeof m.name === "string") { docNames.add(m.name.toLowerCase()); docSlugs.add(slugify(m.name)); }
  }
  const bySlug = new Set(list.map((s) => s.slug));
  const byName = new Set(list.map((s) => String(s.name || "").toLowerCase()));
  const renamed = new Map(); // normalised name -> true, for stored sheets that left the document
  for (const s of list) {
    if (!docSlugs.has(s.slug) && !docNames.has(String(s.name || "").toLowerCase())) renamed.set(normName(s.name), true);
  }
  const at = (partyDoc && typeof partyDoc.generated === "string" && partyDoc.generated) || new Date().toISOString();
  let out = list;
  for (const m of docMembers) {
    const s = sheetMemberFromDoc(m);
    if (!s || bySlug.has(s.slug) || byName.has(s.name.toLowerCase())) continue;
    const n = normName(s.name);
    if (renamed.get(n)) { renamed.delete(n); continue; }
    bySlug.add(s.slug);
    byName.add(s.name.toLowerCase());
    const f = {};
    for (const k of fields) if (s[k] !== undefined && s[k] !== "") f[k] = { value: s[k], visible: true, source: "board", at };
    if (out === list) out = list.slice();
    out.push({ slug: s.slug, name: s.name, fields: f, updated: at });
  }
  return out;
}

// The sheet that belongs to one party-document member: exact lowercase name, else the sheet of a true rename (same name minus a
// parenthetical, and that sheet's own name is not in the document). Used by projectPublicParty so a hide reaches a renamed person.
// The stored sheet a sheet WRITE belongs to: exact slug, else exact lowercase name, else the one sheet that has left the document and has the
// same name minus a parenthetical (a true rename, the same identity rule reconcileSheetsWithDoc uses). That last rule needs a party document and EXACTLY ONE such sheet; two candidates are ambiguous and mean a new person. Undefined means a new person.
export function sheetForWrite(sheets, partyDoc, slug, name) {
  const list = sheets || [];
  const bySlug = list.find((s) => s.slug === slug);
  if (bySlug) return bySlug;
  const want = String(name || "").toLowerCase();
  const byName = want && list.find((s) => String(s.name || "").toLowerCase() === want);
  if (byName) return byName;
  if (!want) return undefined;
  const docMembers = partyDoc && Array.isArray(partyDoc.members) ? partyDoc.members : [];
  if (!docMembers.length) return undefined;
  const inDoc = new Set(), inDocSlug = new Set();
  for (const d of docMembers) if (d && typeof d.name === "string") { inDoc.add(d.name.toLowerCase()); inDocSlug.add(slugify(d.name)); }
  const n = normName(want);
  const gone = list.filter((s) => !inDoc.has(String(s.name || "").toLowerCase()) && !inDocSlug.has(s.slug) && normName(s.name) === n);
  return gone.length === 1 ? gone[0] : undefined;
}

export function sheetForDocMember(sheets, docMembers, m) {
  const list = sheets || [];
  const want = String(m && m.name || "").toLowerCase();
  const exact = list.find((s) => String(s.name || "").toLowerCase() === want);
  if (exact) return exact;
  const names = new Set((docMembers || []).map((d) => String(d && d.name || "").toLowerCase()));
  const n = normName(want);
  return list.find((s) => !names.has(String(s.name || "").toLowerCase()) && normName(s.name) === n);
}
