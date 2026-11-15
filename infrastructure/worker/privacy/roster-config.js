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

// Words that must never become a tokenisable key when they arrive from a sheet name, a first name or a character name (a key "light" would replace the word everywhere
// in the prompt). genericAliases is the one explicit list; these are the common English and game words it is extended with for SHEET-derived names, plus a library-text
// check (libraryWords). A multi-word name ("Light Dawnbringer") is never rejected as a whole: only a single word is tested.
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
  "starter starters trainer trainers zone area camp camping pack packs price prices macro macros keybind keybinds setting settings addon addons patch beta launch " +
  "hands hand offhand offhands spell spells wards ward " +
  "dagger mace robe cloak ring amulet trinket boots gloves helm belt bracers mount reputation talent spec level class race faction horde alliance"
).split(" ").filter(Boolean));
export const GAME_WORDS = [...COMMON_WORDS];
// Words the guard must not treat as a fragment of a name (outbound-guard.js roster.fragmentWords): the first/last 5 letters of a long name never block text when that fragment is
// one of these words (or the start/end of one). Exact, spaced, leet and reversed matches of the whole name are unaffected.
export const fragmentWords = [...COMMON_WORDS];

const WORD_RE = /[a-z][a-z'-]{1,}/g;
const libWordCache = new WeakMap();
// The set of lowercase words in the library text (titles, blurbs, fact values) for a pages array. Cached per array object.
export function libraryWords(pages) {
  if (!Array.isArray(pages)) return new Set();
  const hit = libWordCache.get(pages);
  if (hit) return hit;
  const out = new Set();
  const add = (t) => { if (typeof t === "string") for (const w of t.toLowerCase().match(WORD_RE) || []) out.add(w.replace(/^['-]+|['-]+$/g, "")); };
  for (const p of pages) {
    if (!p || typeof p !== "object") continue;
    add(p.title); add(p.blurb);
    for (const fct of Array.isArray(p.facts) ? p.facts : []) { add(fct && fct.value); add(fct && fct.key); }
  }
  libWordCache.set(pages, out);
  return out;
}

// True when a name must not be a key: it is one of genericAliases, a single common/game word, or a single word that occurs in the library text.
export function isGenericName(raw, libWords) {
  const text = String(raw ?? "").trim();
  if (!text) return false;
  const key = skeleton(text);
  if (genericAliases.some((g) => skeleton(g) === key)) return true;
  if (/\s/.test(text)) return false;
  const w = text.toLowerCase();
  if (COMMON_WORDS.has(w)) return true;
  return Boolean(libWords && typeof libWords.has === "function" && libWords.has(w));
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
  if (!cached) cached = { members: researchMembers(), genericAliases: [...genericAliases], fragmentWords };
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

const FIRST_NAME_FIELDS = ["first_name", "firstname", "real_name", "realname"];
export function researchMembersFor(sheets, libWords = null) {
  const members = researchMembers();
  const owner = new Map(); // skeleton -> member index
  const usable = (k) => [...k].length >= 2 && !RESERVED.has(k) && !/^p\d+$/.test(k);
  const okName = (n) => usable(skeleton(n)) && !isGenericName(n, libWords);
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
    // First names as the party data shows them: the first word of a multi-word sheet name ("First Last"; a one-word handle has none), and first_name / real_name fields.
    const firsts = [];
    if (typeof s.name === "string" && /\s/.test(s.name.trim())) firsts.push(s.name.trim().split(/\s+/)[0]);
    for (const k of FIRST_NAME_FIELDS) {
      const fv = f[k];
      for (const t of nameStrings(fv && typeof fv === "object" && !Array.isArray(fv) && "value" in fv ? fv.value : fv)) firsts.push(/\s/.test(t.trim()) && k.includes("real") ? t.trim().split(/\s+/)[0] : t.trim());
    }
    const all = [...own, ...chars].map((x) => x.trim().slice(0, 60)).filter(Boolean);
    let idx = -1;
    for (const n of own) { const k = skeleton(n); if (owner.has(k)) { idx = owner.get(k); break; } }
    if (idx < 0) {
      const first = all.find((n) => okName(n) && !owner.has(skeleton(n)));
      if (!first) continue;
      members.push({ display: first, aliases: [], firstNames: [] });
      idx = members.length - 1;
      owner.set(skeleton(first), idx);
    }
    for (const n of all) {
      const k = skeleton(n);
      if (!okName(n) || owner.has(k)) continue;
      owner.set(k, idx);
      (members[idx].characterNames ||= []).push(n);
    }
    for (const n of firsts.map((x) => x.slice(0, 60)).filter(Boolean)) {
      const k = skeleton(n);
      if (!okName(n) || owner.has(k)) continue;
      owner.set(k, idx);
      (members[idx].firstNames ||= []).push(n);
    }
  }
  return members;
}
