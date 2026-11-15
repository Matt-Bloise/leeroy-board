// The roster as the privacy layer sees it (privacy/tokenise.js, privacy/outbound-guard.js). One adapter over bot-data.js ROSTER_DATA, nothing copied.
//
// genericAliases: roster aliases that are ordinary English / game words. They are NOT tokenised and NOT guarded (a friend asking about "a mage" or "the tank"
// is not naming a person), so a reply that uses the plain word stays plain. Explicit and lowercase on purpose: the guard refuses anything else. Derived at dev
// time by reading ROSTER_DATA aliases and keeping the ones that are plain words; every other alias and every display name stays a key.
//
// First/real names do not exist in the repo (policy: never stored here). setFirstNameSource(fn) lets a later work item inject them at runtime from a secret
// store: fn(member, index) -> string[]. Until then members carry no first names. Tests inject fictional ones.
import { ROSTER_DATA } from "../bot-data.js";
import { skeleton } from "./skeleton.js";

export const genericAliases = ["mage", "rat", "tank"];

let firstNameSource = null;
export function setFirstNameSource(fn) {
  firstNameSource = typeof fn === "function" ? fn : null;
  cached = null;
}
export const getFirstNameSource = () => firstNameSource;

// ROSTER_FROM_D1 (ADR 0002): roster-source.js hands the D1 roster in here. null (the default, and always while the flag is off) means the built-in list only.
// With an override the members are the override first, then every built-in member the override does not already cover: the redaction roster is a superset
// of both while built-ins exist, so switching the flag on can never uncover a name the built-ins covered.
let rosterOverride = null;
let overrideKey = "null";
export function setRosterOverride(list) {
  const next = Array.isArray(list) && list.length ? list.map((m) => ({ display: m.display, aliases: [...(m.aliases || [])], firstNames: [...(m.firstNames || [])] })) : null;
  const key = JSON.stringify(next);
  if (key === overrideKey) return; // unchanged: keep the cached roster object (the guard caches its parse per object)
  rosterOverride = next;
  overrideKey = key;
  cached = null;
}

// [{ display, aliases, firstNames }] built from ROSTER_DATA (display and aliases only), plus the override when one is set.
export function researchMembers() {
  const base = ROSTER_DATA.map((r, i) => ({
    display: r.display,
    aliases: [...(r.aliases || [])],
    firstNames: firstNameSource ? firstNameSource(r, i) ?? [] : [],
  }));
  if (!rosterOverride) return base;
  const covered = new Set(rosterOverride.map((r) => skeleton(String(r.display))));
  return [
    ...rosterOverride.map((r, i) => ({ display: r.display, aliases: [...r.aliases], firstNames: [...r.firstNames, ...(firstNameSource ? firstNameSource(r, i) ?? [] : [])] })),
    ...base.filter((b) => !covered.has(skeleton(String(b.display)))),
  ];
}

let cached = null;
// The same object each time (the guard caches its parse per object); rebuilt when the first-name source changes.
export function researchRoster() {
  if (!cached) cached = { members: researchMembers(), genericAliases: [...genericAliases] };
  return cached;
}

// ---- the party as the Worker knows it at request time ----------------------------------------------------------------------------------------------
// ROSTER_DATA is the five known members; the party/sheet document can hold more names (a sixth sheet, a renamed member, character names). Every name the
// Worker is about to put in a prompt must be a key, or it reaches the model verbatim. So the members used for tokenising and guarding are the roster plus the
// names found on the sheets: sheet name, slug and character names. A sheet whose name or slug matches a roster member (same skeleton) adds its extra names to
// that member; otherwise it becomes a member of its own. A name that would collide with another member, is one character long or is a reserved word is
// skipped (the member that owns the colliding key already protects it).
const RESERVED = new Set(["id", "all", "guild", "invite", "everyone", "here", "someone"]);
const CHAR_FIELDS = ["character", "character_name", "main", "alts", "alt", "characters"];
const nameStrings = (v, out = []) => {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => nameStrings(x, out));
  else if (v && typeof v === "object") nameStrings(v.name, out);
  return out;
};

export function researchMembersFor(sheets) {
  const members = researchMembers();
  const owner = new Map(); // skeleton -> member index
  const usable = (k) => [...k].length >= 2 && !RESERVED.has(k) && !/^p\d+$/.test(k);
  members.forEach((m, i) => {
    for (const n of [m.display, ...m.aliases, ...m.firstNames]) { const k = skeleton(String(n)); if (k && !owner.has(k)) owner.set(k, i); }
  });
  for (const s of Array.isArray(sheets) ? sheets : []) {
    if (!s || typeof s !== "object") continue;
    const own = [s.name, s.slug].filter((x) => typeof x === "string" && x.trim());
    const chars = [];
    for (const k of ["characters", "character", "main", "alts"]) nameStrings(s[k], chars);
    const f = s.fields && typeof s.fields === "object" ? s.fields : {};
    for (const k of CHAR_FIELDS) {
      const fv = f[k];
      nameStrings(fv && typeof fv === "object" && !Array.isArray(fv) && "value" in fv ? fv.value : fv, chars);
    }
    const all = [...own, ...chars].map((x) => x.trim().slice(0, 60)).filter(Boolean);
    let idx = -1;
    for (const n of own) { const k = skeleton(n); if (owner.has(k)) { idx = owner.get(k); break; } }
    if (idx < 0) {
      const first = all.find((n) => usable(skeleton(n)) && !owner.has(skeleton(n)));
      if (!first) continue;
      members.push({ display: first, aliases: [], firstNames: [] });
      idx = members.length - 1;
      owner.set(skeleton(first), idx);
    }
    for (const n of all) {
      const k = skeleton(n);
      if (!usable(k) || owner.has(k)) continue;
      owner.set(k, idx);
      (members[idx].characterNames ||= []).push(n);
    }
  }
  return members;
}
