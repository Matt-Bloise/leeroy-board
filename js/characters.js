/* Q37 character switcher (flag chars.v1). Pure: no DOM, no fetch, no clock, no globals, so Node can import it and the unit test can cover it.
   list(raw)       the viewer's characters from the "characters" array of the /me answer: at most MAX, each { id, name, class, race, ruleset, faction, region }, no duplicates, nothing else kept.
   validate(form, opts)  the manual character form: { ok, value, errors } where errors maps field to a short message. opts: { classes: [labels], races: [labels], existing: [characters] }.
   Identity is region + ruleset + name (no realm). Faction is Alliance or Horde; regions are the five the game ships in. Every string is trimmed, collapsed and cut. */
export const MAX = 12;
export const FACTIONS = Object.freeze(["Alliance", "Horde"]);
export const REGIONS = Object.freeze(["Americas", "EU", "KR", "TW", "ANZ"]);
export const FIELDS = Object.freeze(["name", "class", "race", "ruleset", "faction", "region"]);
export const LIMITS = Object.freeze({ name: 40, class: 24, race: 24, ruleset: 24 });
const NAME_OK = /^[\p{L}][\p{L}\p{M}' -]*$/u;
const str = (v, max) => (typeof v === "string" ? v.replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");
const pick = (v, list) => { const s = str(v, 24).toLowerCase(); return list.find((x) => x.toLowerCase() === s) || ""; };
export const keyOf = (c) => `${String(c.region).toLowerCase()}|${String(c.ruleset).toLowerCase()}|${String(c.name).toLowerCase()}`;
export function one(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const name = str(raw.name, LIMITS.name);
  if (name.length < 2 || !NAME_OK.test(name)) return null;
  return { id: str(raw.id, 40) || null, name, class: str(raw.class, LIMITS.class), race: str(raw.race, LIMITS.race), ruleset: str(raw.ruleset, LIMITS.ruleset), faction: pick(raw.faction, FACTIONS), region: pick(raw.region, REGIONS) };
}
export function list(raw) {
  const src = raw && Array.isArray(raw.characters) ? raw.characters : Array.isArray(raw) ? raw : [];
  const seen = new Set(), out = [];
  for (const r of src) {
    const c = one(r); if (!c) continue;
    const k = c.id ? `id|${c.id}` : keyOf(c);
    if (seen.has(k) || seen.has(keyOf(c))) continue;
    seen.add(k); seen.add(keyOf(c)); out.push(c);
    if (out.length >= MAX) break;
  }
  return out;
}
export function validate(form, opts = {}) {
  const f = form && typeof form === "object" && !Array.isArray(form) ? form : {}, errors = {};
  const v = { name: str(f.name, LIMITS.name), class: str(f.class, LIMITS.class), race: str(f.race, LIMITS.race), ruleset: str(f.ruleset, LIMITS.ruleset), faction: pick(f.faction, FACTIONS), region: pick(f.region, REGIONS) };
  if (v.name.length < 2) errors.name = "Type a name of at least 2 characters.";
  else if (!NAME_OK.test(v.name)) errors.name = "Use letters, spaces, hyphens and apostrophes only.";
  const inList = (val, l) => !Array.isArray(l) || !l.length || l.includes(val);
  if (!v.class || !inList(v.class, opts.classes)) errors.class = "Choose a class.";
  if (!v.race || !inList(v.race, opts.races)) errors.race = "Choose a race.";
  if (!v.ruleset) errors.ruleset = "Type the ruleset, for example the one your group plays.";
  if (!v.faction) errors.faction = "Choose Alliance or Horde.";
  if (!v.region) errors.region = "Choose a region.";
  const ex = Array.isArray(opts.existing) ? opts.existing : [];
  if (!errors.name && !errors.ruleset && !errors.region && ex.length >= MAX) errors.name = `You can keep up to ${MAX} characters here.`;
  else if (!errors.name && !errors.ruleset && !errors.region && ex.some((c) => keyOf(c) === keyOf(v))) errors.name = "You already have a character with that name in this region and ruleset.";
  return { ok: Object.keys(errors).length === 0, value: v, errors };
}
export const youHave = (n) => `You have ${n}`;
export const summary = (c) => [[c.race, c.class].filter(Boolean).join(" "), c.ruleset, c.faction, c.region].filter(Boolean).join(", ");
export const nextIndex = (i, n, key) => (n < 1 ? -1 : key === "Home" ? 0 : key === "End" ? n - 1 : key === "ArrowRight" || key === "ArrowDown" ? (i + 1) % n : key === "ArrowLeft" || key === "ArrowUp" ? (i - 1 + n) % n : i);
