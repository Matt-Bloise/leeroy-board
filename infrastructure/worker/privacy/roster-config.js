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

// Words that must never become a tokenisable key when they arrive from a SHEET (never from the roster): a key "light" would replace the word everywhere in the prompt.
// genericAliases is the explicit list; COMMON_WORDS extends it with ordinary English and game vocabulary. A multi-word name ("Light Dawnbringer") is never rejected as a
// whole: only a single word is tested. Where each list applies is in researchMembersFor.
const COMMON_WORDS = new Set((
  "light heavy dark red blue green black white gold silver big small old new fast slow high low east west north south sun moon star fire ice frost storm wind rain snow earth stone " +
  "iron steel wolf bear cat dog fox hawk owl crow raven eagle lion tiger drake dragon king queen lord lady prince knight baron duke earl bishop monk priest cleric healer " +
  "mage wizard witch warlock druid shaman hunter ranger rogue thief paladin warrior tank dps heal damage melee caster pet bank guild raid party group dungeon quest boss mob " +
  "street road tower castle forest river hill field night day dawn dusk shadow ghost blade sword axe bow staff wand shield armor armour cloth leather mail plate gear loot " +
  "potion elixir flask food water bread meat fish herb ore leaf root bone skin cold hot warm cool sharp swift quick brave bold calm wild free lone lucky happy angry sad dead " +
  "you me us them him her they it one two three four five six seven eight nine ten zero none all any some many few more less most best worst good bad nice cute rat bat " +
  // professions, specs, zones, items (game vocabulary that appears in ordinary questions and sheet fields)
  "skinning leatherworking blacksmithing enchanting engineering alchemy herbalism mining tailoring fishing cooking first aid bandage smith smithing " +
  "retribution protection holy restoration feral elemental enhancement balance guardian discipline assassination combat subtlety arms fury beast marksmanship survival destruction affliction demonology arcane " +
  "stormwind orgrimmar ironforge darnassus undercity thunder bluff elwynn durotar barrens westfall duskwood stranglethorn tanaris ungoro winterspring silithus felwood ashenvale darkshore teldrassil dun morogh loch modan redridge badlands blasted swamp hinterlands plaguelands " +
  "dagger mace robe cloak ring amulet trinket boots gloves helm belt bracers mount reputation talent spec level class race faction horde alliance"
).split(" ").filter(Boolean));
export const GAME_WORDS = [...COMMON_WORDS];

// ---- library words (lazy, cached) ---------------------------------------------------------------------------------------------------------------------
// Only a word that the library text uses in LOWERCASE counts as an ordinary word: a name the facts mention ("Testbard heals well") is written capitalised and stays a key.
// Fact keys are identifiers, not prose. The set is built on the first has() call (most parties have no first or alt name to test, so most asks never pay for it) and cached
// by a cheap signature (page count, ids, fact count, total fact characters), so a refreshed pages array with the same content reuses it.
const WORD_RE = /[A-Za-z][A-Za-z'-]{1,}/g;
const EMPTY_LIB = { has: () => false };
const libByArray = new WeakMap();
const libBySignature = new Map();
function pagesSignature(pages) {
  let facts = 0;
  let chars = 0;
  let h = 5381;
  for (const p of pages) {
    const id = p && typeof p === "object" && typeof p.id === "string" ? p.id : "";
    for (let i = 0; i < id.length; i++) h = ((h << 5) + h + id.charCodeAt(i)) | 0;
    const fl = p && Array.isArray(p.facts) ? p.facts : [];
    facts += fl.length;
    for (const x of fl) { const v = x && x.value; chars += typeof v === "string" ? v.length : 0; }
  }
  return `${pages.length}:${facts}:${chars}:${h}`;
}
export function libraryWords(pages) {
  if (!Array.isArray(pages)) return EMPTY_LIB;
  const known = libByArray.get(pages);
  if (known) return known;
  const sig = pagesSignature(pages);
  let lib = libBySignature.get(sig);
  if (!lib) {
    let set = null;
    lib = {
      has(w) {
        if (!set) {
          set = new Set();
          const add = (t) => { if (typeof t === "string") for (const x of t.match(WORD_RE) || []) if (x === x.toLowerCase()) set.add(x.replace(/^['-]+|['-]+$/g, "")); };
          for (const p of pages) {
            if (!p || typeof p !== "object") continue;
            add(p.title); add(p.blurb);
            for (const fct of Array.isArray(p.facts) ? p.facts : []) add(fct && fct.value);
          }
        }
        return set.has(w);
      },
    };
    if (libBySignature.size >= 4) libBySignature.clear();
    libBySignature.set(sig, lib);
  }
  libByArray.set(pages, lib);
  return lib;
}

const LEET_FOLD_I = { 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 7: "t" };
const LEET_FOLD_L = { 0: "o", 1: "l", 3: "e", 4: "a", 5: "s", 7: "t" };
// The word forms a single-word name takes after the same normalisation the guard uses (case, punctuation, lookalikes) and with leet digits folded ("L1ght", "Light.").
function wordForms(text) {
  const k = skeleton(text);
  return [...new Set([k, k.replace(/[013457]/g, (d) => LEET_FOLD_I[d]), k.replace(/[013457]/g, (d) => LEET_FOLD_L[d])])];
}

// True when a name must not be a key: it is one of genericAliases, or a single word that is common/game vocabulary, or (only when libWords is given) a single word the
// library text uses in lowercase. A multi-word name is never rejected whole.
export function isGenericName(raw, libWords) {
  const text = String(raw ?? "").trim();
  if (!text) return false;
  const forms = wordForms(text);
  if (genericAliases.some((g) => forms.includes(skeleton(g)))) return true;
  if (/\s/.test(text)) return false;
  if (forms.some((w) => COMMON_WORDS.has(w))) return true;
  return Boolean(libWords && typeof libWords.has === "function" && forms.some((w) => libWords.has(w)));
}

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

// ---- the party as the Worker knows it at request time ----------------------------------------------------------------------------------------------
// ROSTER_DATA is the five known members; the party/sheet document can hold more names (a sixth sheet, a renamed member, character names). Every name the
// Worker is about to put in a prompt must be a key, or it reaches the model verbatim. So the members used for tokenising and guarding are the roster plus the
// names found on the sheets: sheet name, slug, character/alt names and first names. A sheet whose name or slug matches a roster member (same skeleton) adds its extra
// names to that member; otherwise it becomes a member of its own. A name that would collide with another member, is one character long or is a reserved word is
// skipped (the member that owns the colliding key already protects it).
//
// Which names are dropped as "ordinary words" (never for roster members, never for a multi-word name):
//   sheet name / slug         genericAliases and the common/game list only. A library word never drops a sheet's own name: a party member's name that a fact mentions must be a key.
//   alt / character names     genericAliases, the common/game list, and words the library text uses in lowercase.
//   first names derived from  the same as alt names (a "Light" in "Light Dawnbringer" is not a person).
//     the first word of a multi-word sheet name
//   explicit first_name /     every word is a key unless it is in genericAliases: a sheet that states a first name is naming a person, so a common word is still keyed.
//     real_name fields
const RESERVED = new Set(["id", "all", "guild", "invite", "everyone", "here", "someone"]);
const CHAR_FIELDS = ["character", "character_name", "main", "alts", "alt", "characters"];
const TITLES = new Set(["dr", "mr", "mrs", "ms", "mx", "sir", "lady", "lord", "jr", "sr", "the", "of", "de", "van", "von", "la", "el"]); // not names: skipped when a real_name is split into words
const FIRST_NAME_FIELDS =["first_name", "firstname", "real_name", "realname"];
const nameStrings = (v, out = []) => {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => nameStrings(x, out));
  else if (v && typeof v === "object") nameStrings(v.name, out);
  return out;
};
const fieldValue = (fv) => (fv && typeof fv === "object" && !Array.isArray(fv) && "value" in fv ? fv.value : fv);

export function researchMembersFor(sheets, libWords = null) {
  const members = researchMembers();
  const owner = new Map(); // skeleton -> member index
  const usable = (k) => [...k].length >= 2 && !RESERVED.has(k) && !/^p\d+$/.test(k);
  const okOwn = (n) => usable(skeleton(n)) && !isGenericName(n, null);
  const okAlt = (n) => usable(skeleton(n)) && !isGenericName(n, libWords);
  const okExplicit = (n) => usable(skeleton(n)) && !genericAliases.some((g) => skeleton(g) === skeleton(n));
  members.forEach((m, i) => {
    for (const n of [m.display, ...m.aliases, ...m.firstNames]) { const k = skeleton(String(n)); if (k && !owner.has(k)) owner.set(k, i); }
  });
  for (const s of Array.isArray(sheets) ? sheets : []) {
    if (!s || typeof s !== "object") continue;
    const clip = (x) => x.trim().slice(0, 60);
    const own = [s.name, s.slug].filter((x) => typeof x === "string" && x.trim()).map(clip);
    const chars = [];
    for (const k of ["characters", "character", "main", "alts"]) nameStrings(s[k], chars);
    const f = s.fields && typeof s.fields === "object" ? s.fields : {};
    for (const k of CHAR_FIELDS) nameStrings(fieldValue(f[k]), chars);
    const alts = chars.map(clip).filter(Boolean);
    // First names as the party data shows them. Explicit: every word of a first_name / real_name field. Derived: the first word of a multi-word sheet name.
    const explicit = [];
    for (const k of FIRST_NAME_FIELDS) for (const t of nameStrings(fieldValue(f[k]))) for (const w of t.split(/\s+/)) if (w.trim() && !TITLES.has(w.trim().toLowerCase().replace(/\.$/, ""))) explicit.push(clip(w));
    const derived = typeof s.name === "string" && /\s/.test(s.name.trim()) ? [clip(s.name.trim().split(/\s+/)[0])] : [];
    let idx = -1;
    for (const n of own) { const k = skeleton(n); if (owner.has(k)) { idx = owner.get(k); break; } }
    if (idx < 0) {
      const display = [...own.filter(okOwn), ...alts.filter(okAlt), ...explicit.filter(okExplicit), ...derived.filter(okAlt)].find((n) => !owner.has(skeleton(n)));
      if (!display) continue;
      members.push({ display, aliases: [], firstNames: [] });
      idx = members.length - 1;
      owner.set(skeleton(display), idx);
    }
    const add = (n, field) => {
      const k = skeleton(n);
      if (owner.has(k)) return;
      owner.set(k, idx);
      (members[idx][field] ||= []).push(n);
    };
    for (const n of own) if (okOwn(n)) add(n, "characterNames");
    for (const n of alts) if (okAlt(n)) add(n, "characterNames");
    for (const n of explicit) if (okExplicit(n)) add(n, "firstNames");
    for (const n of derived) if (okAlt(n)) add(n, "firstNames");
  }
  return members;
}
