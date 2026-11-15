// The roster as the privacy layer sees it (privacy/tokenise.js, privacy/outbound-guard.js). One adapter over bot-data.js ROSTER_DATA, nothing copied.
//
// genericAliases: roster aliases that are ordinary English / game words. They are NOT tokenised and NOT guarded (a friend asking about "a mage" or "the tank"
// is not naming a person), so a reply that uses the plain word stays plain. Explicit and lowercase on purpose: the guard refuses anything else. Derived at dev
// time by reading ROSTER_DATA aliases and keeping the ones that are plain words; every other alias and every display name stays a key.
//
// First/real names do not exist in the repo (policy: never stored here). setFirstNameSource(fn) lets a later work item inject them at runtime from a secret
// store: fn(member, index) -> string[]. Until then members carry no first names. Tests inject fictional ones.
import { ROSTER_DATA } from "../bot-data.js";

export const genericAliases = ["mage", "rat", "tank"];

let firstNameSource = null;
export function setFirstNameSource(fn) {
  firstNameSource = typeof fn === "function" ? fn : null;
  cached = null;
}
export const getFirstNameSource = () => firstNameSource;

// [{ display, aliases, firstNames }] built from ROSTER_DATA (display and aliases only).
export function researchMembers() {
  return ROSTER_DATA.map((r, i) => ({
    display: r.display,
    aliases: [...(r.aliases || [])],
    firstNames: firstNameSource ? firstNameSource(r, i) ?? [] : [],
  }));
}

let cached = null;
// The same object each time (the guard caches its parse per object); rebuilt when the first-name source changes.
export function researchRoster() {
  if (!cached) cached = { members: researchMembers(), genericAliases: [...genericAliases] };
  return cached;
}
