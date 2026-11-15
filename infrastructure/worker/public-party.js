// The public party document: what a member hides on their sheet is removed from it, together with everything derived from it. Pure, no I/O.
import { CLASSES, RACES } from "./member-model.js";
import { sheetForDocMember } from "./sheet-match.js";

// The three public keys of the party document that come from a member's sheet (a visible value is copied only for these).
const PUBLIC_KEY = { race: "race", class: "class", spec_path: "spec" };

// Every party-document member field that shows, or lets a reader work out, a sheet field. Hiding a sheet field removes all of them, not only the
// field with the same name: board_line is "<Race> <Class> <spec>", color and class_key are the class, the spec names the class, role follows class and
// spec (and the level-40 spec), start_zone defaults to the race's zone (member-model.js partyEntry). level, launch_state and goals are not in the document.
export const DERIVED_FROM_SHEET = {
  race: ["race", "board_line", "start_zone"],
  class: ["class", "class_key", "color", "board_line", "spec", "spec_status", "role", "role_detail"],
  spec_path: ["spec", "spec_status", "role", "role_detail", "board_line"],
  spec_at_40: ["role_detail", "role"],
  professions: ["professions"],
  plan_zone: ["start_zone"],
  level: [],
  launch_state: [],
  goals: [],
};

// The public party document, re-derived from the final sheet state (never from the request that just arrived), so concurrent visible and hide
// writes in any order end in the same place: a hidden field, and everything derived from it, is absent from the document. Hidden fields are removed
// for every member (self-healing); a visible value is copied only for the member and field written, as before. Mutates and returns partyDoc.
export function projectPublicParty(partyDoc, sheets, slug, field) {
  if (!partyDoc || !Array.isArray(partyDoc.members)) return partyDoc;
  for (const m of partyDoc.members) {
    if (!m || typeof m !== "object") continue;
    const sheet = sheetForDocMember(sheets, partyDoc.members, m);
    if (!sheet) continue;
    for (const [sheetField, key] of Object.entries(PUBLIC_KEY)) {
      const f = sheet.fields && sheet.fields[sheetField];
      if (f && f.visible !== false && sheet.slug === slug && sheetField === field && f.value !== undefined && f.value !== null) m[key] = String(f.value);
    }
    if (sheet.slug === slug) restoreDerived(m, sheet);
    for (const [sheetField, keys] of Object.entries(DERIVED_FROM_SHEET)) {
      const f = sheet.fields && sheet.fields[sheetField];
      if (f && f.visible === false) for (const k of keys) delete m[k];
    }
  }
  return partyDoc;
}

// The stored party document is the projected one, so a field hidden and then shown again would come back without what was derived from it.
// For the member just written, fill back what the visible sheet fields can rebuild (never over a value that is there; the hides run after this).
const isShown = (sheet, k) => { const f = sheet.fields && sheet.fields[k]; return !!f && f.visible !== false && f.value !== undefined && f.value !== null && f.value !== ""; };
function restoreDerived(m, sheet) {
  const cls = isShown(sheet, "class") ? CLASSES[String(sheet.fields.class.value).toLowerCase()] : null;
  const race = isShown(sheet, "race") ? RACES[String(sheet.fields.race.value).toLowerCase()] : null;
  if (cls) {
    if (m.class_key === undefined) m.class_key = String(sheet.fields.class.value).toLowerCase();
    if (m.color === undefined) m.color = cls.color;
    if (m.role === undefined && !sheet.fields.spec_path && !sheet.fields.spec_at_40) m.role = cls.role;
  }
  if (race && cls && m.board_line === undefined) m.board_line = race.label + " " + cls.label;
  if (m.start_zone === undefined) {
    const planned = isShown(sheet, "plan_zone") ? Object.values(RACES).find((r) => r.zone.toLowerCase().replace(/ /g, "-") === String(sheet.fields.plan_zone.value).toLowerCase()) : null;
    if (planned) m.start_zone = planned.zone;
    else if (race && !sheet.fields.plan_zone) m.start_zone = race.zone;
  }
  if (isShown(sheet, "spec_path") && m.spec_status === undefined) m.spec_status = { status: "declared", source: "board" };
  if (isShown(sheet, "professions") && m.professions === undefined && Array.isArray(sheet.fields.professions.value)) {
    m.professions = sheet.fields.professions.value.map((p) => ({ name: String(p).replace(/(^|-)([a-z])/g, (x, a, c) => (a ? " " : "") + c.toUpperCase()), source: "board" }));
  }
}


// Project a party document against the stored sheets row (kv_state 'party_sheets'), for readers that take the stored document directly
// (Discord /tonight and the cards, the ask prompt). An unreadable sheets row changes nothing here: the writers already projected the document.
export async function projectWithStoredSheets(env, partyDoc) {
  if (!partyDoc || !Array.isArray(partyDoc.members)) return partyDoc;
  try {
    const row = await env.DB.prepare("SELECT json FROM kv_state WHERE key = 'party_sheets'").first();
    const sheets = row && row.json ? JSON.parse(row.json) : [];
    if (Array.isArray(sheets)) projectPublicParty(partyDoc, sheets, null, null);
  } catch { /* keep the document as stored */ }
  return partyDoc;
}
