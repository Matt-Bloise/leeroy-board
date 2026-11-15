// The shape of the roster config row (kv_state 'party_roster'), ADR 0002. Pure: no imports from config.js or party-source.js, so both can use it.
//
//   { version: 1, default_admin: "<slug>", members: [ { slug, name, race, class, spec_path?, spec_at_40?, professions?, plan_zone?, aliases?, first_names? } ] }
//
// The row is private (config.js PRIVATE_EXACT) and written by PUT /api/config/party_roster with the admin token. It is the only place real names live once
// the migration in docs/adr/0002-member-roster-from-d1.md is finished. This file holds the shape, never a name.
const SLUG = /^[a-z0-9-]{1,32}$/;
const MAX_MEMBERS = 50;
const SHEET_STRINGS = ["race", "class", "spec_path", "spec_at_40", "plan_zone"];
const isStr = (v, max = 60) => typeof v === "string" && v.trim().length > 0 && v.length <= max;

// Returns an error string, or null when valid.
export function validateRosterConfig(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return "party_roster must be a JSON object";
  if (v.version !== undefined && v.version !== 1) return "party_roster version must be 1";
  if (!Array.isArray(v.members) || v.members.length < 1 || v.members.length > MAX_MEMBERS) return `party_roster needs a members array of 1 to ${MAX_MEMBERS}`;
  const slugs = new Set();
  for (const m of v.members) {
    if (!m || typeof m !== "object" || Array.isArray(m)) return "each member must be an object";
    if (typeof m.slug !== "string" || !SLUG.test(m.slug)) return "each member needs a slug of lowercase letters, digits and hyphens (1 to 32)";
    if (slugs.has(m.slug)) return "member slugs must be unique";
    slugs.add(m.slug);
    if (!isStr(m.name)) return "each member needs a non-empty name of at most 60 characters";
    for (const f of SHEET_STRINGS) if (m[f] !== undefined && !isStr(m[f])) return `member ${f} must be a non-empty string`;
    if (m.professions !== undefined && !(Array.isArray(m.professions) && m.professions.length <= 8 && m.professions.every((p) => isStr(p)))) return "member professions must be an array of strings";
    if (m.aliases !== undefined && !(Array.isArray(m.aliases) && m.aliases.length <= 16 && m.aliases.every((a) => isStr(a) && a === a.toLowerCase()))) return "member aliases must be an array of lowercase strings";
    if (m.first_names !== undefined && !(Array.isArray(m.first_names) && m.first_names.length <= 8 && m.first_names.every((a) => isStr(a)))) return "member first_names must be an array of strings";
  }
  if (typeof v.default_admin !== "string" || !slugs.has(v.default_admin)) return "default_admin must be the slug of one of the members";
  return null;
}

// The shape PARTY_MEMBERS uses (party-source.js). Aliases and first names never go into it: they are for matching and redaction only.
export function sheetMembersFromConfig(cfg) {
  return cfg.members.map((m) => {
    const out = { slug: m.slug, name: m.name };
    for (const f of SHEET_STRINGS) if (m[f] !== undefined) out[f] = m[f];
    if (m.professions !== undefined) out.professions = m.professions.slice();
    return out;
  });
}

// The shape ROSTER_DATA uses ({ display, aliases }). With no aliases the lowercase name is the only one, as discord_members does.
export function rosterDataFromConfig(cfg) {
  return cfg.members.map((m) => ({ display: m.name, aliases: Array.isArray(m.aliases) ? m.aliases.slice() : [m.name.toLowerCase()] }));
}

// The shape the privacy layer uses (privacy/roster-config.js).
export function privacyMembersFromConfig(cfg) {
  return rosterDataFromConfig(cfg).map((r, i) => ({ ...r, firstNames: Array.isArray(cfg.members[i].first_names) ? cfg.members[i].first_names.slice() : [] }));
}
