// The shape of the roster config row (kv_state 'party_roster'), ADR 0002. Pure: no imports from config.js or party-source.js, so both can use it.
//
//   { version: 1, default_admin: "<slug>", members: [ { slug, name, race, class, spec_path?, spec_at_40?, professions?, plan_zone?, aliases?, first_names? } ] }
//
// The row is private (config.js PRIVATE_EXACT) and written by PUT /api/config/party_roster with the admin token. It is the only place real names live once
// the migration in docs/adr/0002-member-roster-from-d1.md is finished. This file holds the shape, never a name.
import { skeleton, collapse, leet } from "./privacy/skeleton.js";

const SLUG = /^[a-z0-9-]{1,32}$/;
const MAX_MEMBERS = 50;
const SHEET_STRINGS = ["race", "class", "spec_path", "spec_at_40", "plan_zone"];
const isStr = (v, max = 60) => typeof v === "string" && v.trim().length > 0 && v.length <= max;

// Words that must never be a name, alias, first name or slug: the mention words the bot reacts to and the ids the tokeniser mints (P1, P2, ...).
const RESERVED = new Set(["all", "everyone", "here", "id", "guild", "invite", "someone"]);
// Object-prototype words: a roster key that is one of these can corrupt a plain-object lookup keyed by name or slug.
const PROTO_WORDS = new Set(["constructor", "prototype", "__proto__", "proto", "tostring", "valueof", "tolocalestring", "hasownproperty", "isprototypeof", "propertyisenumerable"]);
// A name is letters, digits, spaces, apostrophes and hyphens. Anything else (regex metacharacters, brackets, angle brackets, dots, slashes) is refused.
const NAME_CHARS = /^[\p{L}\p{N}][\p{L}\p{N} '\u2019-]*$/u;

// Returns an error string for a name-like value (display name, alias, first name or slug), or null.
function badNameWord(v, what) {
  const t = String(v).trim().toLowerCase();
  if ([...t].length < 2) return `${what} must be at least 2 characters`;
  if (!(what === "slug" ? SLUG.test(t) : NAME_CHARS.test(t))) return `${what} has a character that is not allowed (letters, digits, spaces, apostrophes, hyphens)`;
  if (RESERVED.has(t)) return `${what} "${t}" is a reserved word`;
  if (/^p\d+$/.test(t)) return `${what} must not look like a privacy token (P followed by digits)`;
  if (PROTO_WORDS.has(t) || PROTO_WORDS.has(t.replace(/-/g, ""))) return `${what} must not be an object-prototype word`;
  return null;
}

// Returns an error string, or null when valid. Collisions are checked on the skeleton the tokeniser uses (privacy/skeleton.js), so names that differ only in case,
// spacing, accents or look-alike characters count as the same key.
export function validateRosterConfig(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return "party_roster must be a JSON object";
  if (v.version !== 1) return "party_roster version must be 1";
  if (!Array.isArray(v.members) || v.members.length < 1 || v.members.length > MAX_MEMBERS) return `party_roster needs a members array of 1 to ${MAX_MEMBERS}`;
  const slugs = new Set();
  const owner = new Map(); // skeleton key -> member index that owns it
  const claim = (word, idx, what) => {
    const k = skeleton(String(word));
    if (!k) return `${what} has no usable characters`;
    if (owner.has(k) && owner.get(k) !== idx) return `${what} "${String(word).toLowerCase()}" collides with another member's name, alias, first name or slug`;
    owner.set(k, idx);
    return null;
  };
  let idx = -1;
  for (const m of v.members) {
    idx++;
    if (!m || typeof m !== "object" || Array.isArray(m)) return "each member must be an object";
    if (typeof m.slug !== "string" || !SLUG.test(m.slug)) return "each member needs a slug of lowercase letters, digits and hyphens (1 to 32)";
    if (slugs.has(m.slug)) return "member slugs must be unique";
    slugs.add(m.slug);
    if (!isStr(m.name)) return "each member needs a non-empty name of at most 60 characters";
    let e = badNameWord(m.slug, "slug") || badNameWord(m.name, "name");
    if (e) return e;
    e = claim(m.slug, idx, "slug") || claim(m.name, idx, "name");
    if (e) return e;
    for (const f of SHEET_STRINGS) if (m[f] !== undefined && !isStr(m[f])) return `member ${f} must be a non-empty string`;
    if (m.professions !== undefined && !(Array.isArray(m.professions) && m.professions.length <= 8 && m.professions.every((p) => isStr(p)))) return "member professions must be an array of strings";
    if (m.aliases !== undefined && !(Array.isArray(m.aliases) && m.aliases.length >= 1 && m.aliases.length <= 16 && m.aliases.every((a) => isStr(a) && a === a.toLowerCase()))) return "member aliases must be omitted or a non-empty array of lowercase strings";
    if (m.first_names !== undefined && !(Array.isArray(m.first_names) && m.first_names.length >= 1 && m.first_names.length <= 8 && m.first_names.every((a) => isStr(a)))) return "member first_names must be omitted or a non-empty array of strings";
    for (const a of m.aliases || []) { e = badNameWord(a, "alias") || claim(a, idx, "alias"); if (e) return e; }
    for (const a of m.first_names || []) { e = badNameWord(a, "first name") || claim(a, idx, "first name"); if (e) return e; }
  }
  if (typeof v.default_admin !== "string" || !slugs.has(v.default_admin)) return "default_admin must be the slug of one of the members";
  return null;
}

// ---- the built-in members as people (ADR 0002 F4) -------------------------------------------------------------------------------------------------------
// The row validator above only compares row members with each other. A row member may CHANGE a built-in member (same slug) but must not reuse a built-in person's slug,
// display name, alias or first name under another slug: two list entries for one name, and a redaction key owned by two people. builtInPeople turns the built-in lists into
// [{ id, words: string[] }] (id: the built-in slug), joining a roster entry to a sheet member by the skeleton of the display name and the name. firstNamesFor(rosterEntry, index)
// is the runtime first-name source (privacy/roster-config.js), or null. Pure; never mutates.
export function builtInPeople(partyMembers, rosterData, firstNamesFor = null) {
  const people = [];
  const byKey = new Map();
  for (const p of partyMembers || []) {
    const person = { id: String(p.slug), name: String(p.name), words: [String(p.slug), String(p.name)] };
    people.push(person);
    byKey.set(skeleton(String(p.name)), person);
  }
  (rosterData || []).forEach((r, i) => {
    let person = byKey.get(skeleton(String(r.display)));
    if (!person) { person = { id: skeleton(String(r.display)), name: String(r.display), words: [String(r.display)] }; people.push(person); byKey.set(person.id, person); }
    person.words.push(String(r.display), ...(r.aliases || []).map(String));
    if (typeof firstNamesFor === "function") { try { person.words.push(...(firstNamesFor(r, i) || []).map(String)); } catch { /* a broken source adds nothing */ } }
  });
  return people;
}

// The keys a word can be matched under by the tokeniser: its skeleton, with doubled letters collapsed, and with look-alike digits read as letters (both readings of "1"). A row word
// collides with a built-in word when any of these keys is shared, so "Sannta", "S4nta" or "5anta" cannot sit beside "Santa" (the tokeniser would give them one token).
const keysOf = (w) => {
  const sk = skeleton(String(w));
  if (!sk) return [];
  return [...new Set([sk, collapse(sk), collapse(leet(sk, "i")), collapse(leet(sk, "l"))])];
};

// -> an error string naming the row member and the word (never the built-in person), or null. A word is a slug, name, alias or first name of a row member. Two refusals:
//   - the word shares a key (keysOf) with a word of a built-in person whose id is not that row member's slug;
//   - the row member has a built-in's slug but a different name: a built-in may be changed under its own slug (build, aliases, first names) but not RENAMED, because the redaction layer
//     would then hold the old built-in name and the new name as two people sharing the slug key (privacy: duplicate name key), and every tokenised research ask would go degraded.
export function builtInCollision(cfg, people) {
  if (!cfg || !Array.isArray(cfg.members) || !Array.isArray(people)) return null;
  const owner = new Map(); // key -> Set of built-in ids that own it
  for (const p of people) for (const w of p.words) for (const k of keysOf(w)) { if (!owner.has(k)) owner.set(k, new Set()); owner.get(k).add(p.id); }
  for (const m of cfg.members) {
    if (!m || typeof m !== "object") continue;
    const own = people.find((p) => p.id === m.slug);
    if (own && typeof m.name === "string" && skeleton(m.name) !== skeleton(own.name)) return `member "${String(m.slug).slice(0, 32)}": a built-in member can be changed under its own slug but not renamed`;
    const words = [["slug", m.slug], ["name", m.name], ...(Array.isArray(m.aliases) ? m.aliases : []).map((a) => ["alias", a]), ...(Array.isArray(m.first_names) ? m.first_names : []).map((a) => ["first name", a])];
    for (const [what, w] of words) {
      if (typeof w !== "string") continue;
      for (const k of keysOf(w)) {
        const ids = owner.get(k);
        if (ids && [...ids].some((id) => id !== m.slug)) return `member "${String(m.slug).slice(0, 32)}": ${what} "${w.slice(0, 60)}" belongs to a built-in member under another slug; a row may change a built-in member only under that member's own slug`;
      }
    }
  }
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
// The slug is a redaction key too (it can appear in a prompt as a sheet slug), carried as a character name.
export function privacyMembersFromConfig(cfg) {
  return rosterDataFromConfig(cfg).map((r, i) => ({ ...r, firstNames: Array.isArray(cfg.members[i].first_names) ? cfg.members[i].first_names.slice() : [], characterNames: [cfg.members[i].slug] }));
}

// The roster a consumer works with when the D1 row is active: the row's members first, then every built-in the row does not list (matched by slug for sheet members,
// by the lowercase display name for the roster list). A built-in member the row omits therefore keeps the member match and the roster entry until step 3 removes the
// built-ins from the tree: a row can add and change members, it cannot lock a built-in member out. Pure; never mutates its arguments.
export function sheetMembersWithBuiltIns(rowMembers, builtIns) {
  const have = new Set(rowMembers.map((m) => m.slug));
  return [...rowMembers, ...builtIns.filter((b) => !have.has(b.slug))];
}
export function rosterDataWithBuiltIns(rowRoster, builtIns) {
  const have = new Set(rowRoster.map((r) => skeleton(String(r.display))));
  return [...rowRoster, ...builtIns.filter((b) => !have.has(skeleton(String(b.display))))];
}
