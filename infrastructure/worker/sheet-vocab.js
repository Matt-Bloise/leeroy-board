// The vocabulary of the party sheet: the values a race, class, spec, profession or plan zone line may hold. ONE source for the Worker (POST /sheet and the
// Discord /sheet command refuse anything else) and for the board (data/sheet-vocab.json is this object, pinned equal by tests/unit/sheet-vocab.test.mjs; the
// sheet page offers exactly these and no other value). These are game reference lists for every player: nothing here depends on who is in the party, so the
// sheet page works while the party's own pages are withheld (public-party.js WITHHELD_LINE). Keys are slugs (the form the board stores); values are labels.
export const SHEET_VOCAB = Object.freeze({
  race: { orc: "Orc", troll: "Troll", tauren: "Tauren", undead: "Undead", human: "Human", dwarf: "Dwarf", gnome: "Gnome", "night-elf": "Night Elf" },
  class: { warrior: "Warrior", paladin: "Paladin", hunter: "Hunter", rogue: "Rogue", priest: "Priest", shaman: "Shaman", mage: "Mage", warlock: "Warlock", druid: "Druid" },
  spec: {
    arcane: "Arcane", fire: "Fire", frost: "Frost", holy: "Holy", protection: "Protection", retribution: "Retribution", discipline: "Discipline", shadow: "Shadow",
    arms: "Arms", fury: "Fury", "beast-mastery": "Beast Mastery", marksmanship: "Marksmanship", survival: "Survival", assassination: "Assassination", combat: "Combat",
    subtlety: "Subtlety", elemental: "Elemental", enhancement: "Enhancement", restoration: "Restoration", affliction: "Affliction", demonology: "Demonology",
    destruction: "Destruction", balance: "Balance", "feral-combat": "Feral Combat",
  },
  // which specs each class has (the sheet page offers a member the specs of their own class); every entry is a key of `spec`
  spec_of: {
    warrior: ["arms", "fury", "protection"], paladin: ["holy", "protection", "retribution"], hunter: ["beast-mastery", "marksmanship", "survival"], rogue: ["assassination", "combat", "subtlety"],
    priest: ["discipline", "holy", "shadow"], shaman: ["elemental", "enhancement", "restoration"], mage: ["arcane", "fire", "frost"], warlock: ["affliction", "demonology", "destruction"], druid: ["balance", "feral-combat", "restoration"],
  },
  professions: { alchemy: "Alchemy", blacksmithing: "Blacksmithing", enchanting: "Enchanting", engineering: "Engineering", herbalism: "Herbalism", leatherworking: "Leatherworking", mining: "Mining", skinning: "Skinning", tailoring: "Tailoring" },
  plan_zone: {
    durotar: "Durotar", mulgore: "Mulgore", "tirisfal-glades": "Tirisfal Glades", "elwynn-forest": "Elwynn Forest", "coldridge-valley": "Coldridge Valley", teldrassil: "Teldrassil",
    orgrimmar: "Orgrimmar", "thunder-bluff": "Thunder Bluff", undercity: "Undercity", "stormwind-city": "Stormwind City", ironforge: "Ironforge", darnassus: "Darnassus",
    "valley-of-strength": "Valley of Strength", "the-crossroads": "The Crossroads",
  },
});
// sheet field -> the list that holds its values
export const VOCAB_LIST = Object.freeze({ race: "race", class: "class", spec_path: "spec", spec_at_40: "spec", professions: "professions", plan_zone: "plan_zone" });
export const VOCAB_FIELDS = Object.freeze(Object.keys(VOCAB_LIST));
const has = (list, slug) => Object.hasOwn(SHEET_VOCAB[list], slug);
export const vocabSlug = (v) => String(v == null ? "" : v).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/, "");

// null when the value is on the list for this field, else a short reason. Exact: the board sends slugs. `loose` (the Discord command, where a person types
// "Night Elf" or "Mining and Tailoring") reads the typed text as a slug first; canonicalVocab() gives the stored form.
export function vocabProblem(field, value, { loose = false } = {}) {
  const list = VOCAB_LIST[field];
  if (!list) return null;
  const c = canonicalVocab(field, value, { loose });
  return c === null ? `${field.replace(/_/g, " ")} is not on the board's list` : null;
}
// The stored form (a slug, or an array of 1 to 9 distinct slugs for professions), or null when any part is not on the list.
export function canonicalVocab(field, value, { loose = false } = {}) {
  const list = VOCAB_LIST[field];
  if (!list) return value;
  const one = (x) => { if (typeof x !== "string") return null; const s = loose ? vocabSlug(x) : x; return s && has(list, s) ? s : null; };
  if (field === "professions") {
    const parts = Array.isArray(value) ? value : loose && typeof value === "string" ? value.split(/\s*(?:,|;|&|\band\b)\s*/i).filter(Boolean) : null;
    if (!parts || !parts.length || parts.length > 9) return null;
    const out = parts.map(one);
    return out.every(Boolean) && new Set(out).size === out.length ? out : null;
  }
  return one(value);
}
