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

// ROSTER_FROM_D1 (ADR 0002 step 2): there is NO module-level roster state here. The D1 roster reaches the redaction layer as an explicit argument (`extra`: the
// privacy members of one operation's roster snapshot, roster-source.js), so two requests in one isolate can never see each other's roster and the flag or the row cannot change
// between building the party and tokenising within one operation. With `extra` the redaction roster is the UNION, per redaction key (display name, aliases, first names,
// character names and the slug), of the D1 roster and the built-ins: a key is covered if ANY source covers it. A D1 member whose display name matches a built-in (same
// skeleton) gets that built-in's aliases and first names merged in, so a D1 row that omits or changes aliases never uncovers a built-in alias. A built-in with no D1 match is
// kept whole. D1 members come first. Switching the flag on can therefore never uncover a key the built-ins covered.
const normaliseExtra = (list) => (Array.isArray(list) && list.length ? list.map((m) => ({ display: m.display, aliases: [...(m.aliases || [])], firstNames: [...(m.firstNames || [])], characterNames: [...(m.characterNames || [])] })) : null);

const dedupe = (names) => {
  const seen = new Set();
  const out = [];
  for (const n of names) {
    const k = skeleton(String(n));
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(n);
  }
  return out;
};

// [{ display, aliases, firstNames, characterNames? }] built from ROSTER_DATA (display and aliases only), plus `extra` (one operation's D1 privacy members) when given.
export function researchMembers(extra = null) {
  const rosterOverride = normaliseExtra(extra);
  const base = ROSTER_DATA.map((r, i) => ({
    display: r.display,
    aliases: [...(r.aliases || [])],
    firstNames: firstNameSource ? firstNameSource(r, i) ?? [] : [],
  }));
  if (!rosterOverride) return base;
  const matched = new Set();
  const merged = rosterOverride.map((r) => {
    const key = skeleton(String(r.display));
    const peers = base.filter((b, j) => skeleton(String(b.display)) === key && (matched.add(j), true));
    const out = {
      display: r.display,
      aliases: dedupe([...r.aliases, ...peers.flatMap((p) => p.aliases)]),
      // the first-name source is keyed by built-in position, so it is applied to built-ins only (via peers), never to a D1 member by its own index
      firstNames: dedupe([...r.firstNames, ...peers.flatMap((p) => p.firstNames)]),
    };
    if (r.characterNames.length) out.characterNames = dedupe(r.characterNames);
    return out;
  });
  return [...merged, ...base.filter((_, j) => !matched.has(j))];
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

export function researchMembersFor(sheets, extra = null) {
  const members = researchMembers(extra);
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
