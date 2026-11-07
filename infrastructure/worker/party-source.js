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
// sheet for each party-document member the stored rows do not cover (matched by slug or by name, lowercase) and changes nothing else.
// It never invents the built-in five: only people the document names. Pure; returns the same array when nothing is missing.
export function reconcileSheetsWithDoc(sheets, partyDoc, fields = ["race", "class", "spec_path", "professions", "plan_zone"]) {
  const list = Array.isArray(sheets) ? sheets : [];
  const docMembers = partyDoc && Array.isArray(partyDoc.members) ? partyDoc.members : [];
  const bySlug = new Set(list.map((s) => s.slug));
  const byName = new Set(list.map((s) => String(s.name || "").toLowerCase()));
  const at = (partyDoc && typeof partyDoc.generated === "string" && partyDoc.generated) || new Date().toISOString();
  let out = list;
  for (const m of docMembers) {
    const s = sheetMemberFromDoc(m);
    if (!s || bySlug.has(s.slug) || byName.has(s.name.toLowerCase())) continue;
    bySlug.add(s.slug);
    byName.add(s.name.toLowerCase());
    const f = {};
    for (const k of fields) if (s[k] !== undefined && s[k] !== "") f[k] = { value: s[k], visible: true, source: "board", at };
    if (out === list) out = list.slice();
    out.push({ slug: s.slug, name: s.name, fields: f, updated: at });
  }
  return out;
}
