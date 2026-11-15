// The glossary the board serves in the party document. It is BUNDLED here, never read from the stored 'party' row: the stored row is written by the admin PUT and by
// older deploys (kv_state is seeded only when empty), so a stored glossary can carry examples that are the table's own ("a Troll's faster attacks", "such as Undead,
// Troll or Tauren"). Serving the stored text while a member hides a field would give the hidden value back. projectForAnonymous (public-party.js) replaces `glossary`
// with servedGlossary() on every read, whatever the stored row holds, and whether or not anyone hides.
//
// Two rules for this text: it names no race, class, spec, profession or plan zone of the game's vocabulary (sheet-vocab.js) and no spell or racial ability, and it says
// nothing about how many people are at the table. namesVocabulary() is the check; entries that fail it are dropped at load (belt and braces) and
// tests/unit/glossary-party-independent.test.mjs fails the build first. data/party.json's `glossary` is a copy of GLOSSARY, pinned equal by that test: edit this file.
import { SHEET_VOCAB } from "./sheet-vocab.js";

const GLOSSARY = [
  { term:"racial", forms:["racial","racials","racial ability","racial abilities"], def:"A special ability every character of one race gets for free, such as a speed boost or a resistance to one kind of damage." },
  { term:"spec", forms:["spec","specs","specialization"], def:"The way a character focuses its class, for example one that heals rather than one that deals damage." },
  { term:"talent", forms:["talent","talents","talent tree","talent trees"], def:"Points a character earns while levelling and spends on upgrades that shape its spec." },
  { term:"cooldown", forms:["cooldown","cooldowns"], def:"The wait before a spell or ability can be used again." },
  { term:"challenge", forms:["challenge","challenges"], def:"One of 65 account-wide goals, each worth one legacy point, such as reaching level 25 with a class or 150 skill in a crafting profession." },
  { term:"tabard", forms:["tabard","tabards"], def:"A cloth worn over armor that shows a design." },
  { term:"legacy points", forms:["legacy points","legacy point","Legacy"], def:"Account-wide points earned by finishing challenges, spent on rewards for any character." },
  { term:"pack", forms:["pack","packs","Epic pack","Heroic pack"], def:"A paid bundle that includes the game time and extras, and lets its owner reserve names early." },
  { term:"Game Time", forms:["Game Time","game time","subscription"], def:"Paid time to play: a monthly subscription or a block of Game Time; the game needs one of them from launch." },
  { term:"stats", forms:["stats","Stamina","Spirit","Intellect"], def:"Numbers that shape a character: Stamina adds health, Intellect adds mana, Spirit refills health and mana faster." },
  { term:"Valley of Strength", forms:["Valley of Strength"], def:"A big open square inside the Horde's main city, where groups often meet." },
  { term:"Normal ruleset", forms:["Normal ruleset","Normal realm","ruleset"], def:"A server type where players only fight each other if they choose to." },
  { term:"class", forms:["class","classes"], def:"A character's job; it sets the spells, the armor and whether it can tank, heal or deal damage. Forever has nine." },
  { term:"race", forms:["race","races"], def:"A character's people; it sets the look, a few special abilities and which classes are open." },
  { term:"faction", forms:["faction","factions"], def:"One of the two sides, Horde or Alliance; players of different sides cannot group together, and each race belongs to one side." },
  { term:"guild", forms:["guild","guilds"], def:"A named club of players who chat and play together; in Forever its members need the same ruleset and the same side to group." },
  { term:"gold", forms:["gold","silver","copper","money"], def:"The game's money, counted in gold, silver and copper; it pays for spells from trainers, riding, repairs and items other players sell." },
  { term:"Names open", forms:["Names open","name reservation","Early Name Reservation"], def:"The name reservation window: pack holders can make up to three characters and keep their names, from Oct 27 until the end of Nov 3 Pacific (3 AM ET Nov 4)." },
  { term:"Fellowship", forms:["Fellowship"], def:"The name of the group's voice channel on its Discord server." },
  { term:"Classic habit", forms:["Classic habit","Classic habits"], def:"What players usually did in World of Warcraft Classic, the older version of the game; a habit, not a Forever rule." },
  { term:"rank cap", forms:["rank cap","rank caps"], def:"The level where one rank of a spell stops getting stronger; past it, only the next rank, learned from a trainer, hits harder." },
];

// ---- the check -------------------------------------------------------------------------------------------------------------------------------------------------
// Text is normalised before matching: accents and compatibility forms folded (NFKD), every format character removed (zero-width space and joiners, word joiner, BOM,
// soft hyphen: "Und​ead" becomes "undead"), lower case, every other non-alphanumeric run read as one space. A term then matches as whole words, with the endings a
// derived word takes ("Druidic", "Mages", "Shamanism" is not matched on purpose: only the listed endings).
export const normaliseText = (s) => String(s == null ? "" : s).normalize("NFKD").replace(/[\p{Cf}\p{M}]/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const ENDINGS = "(?:s|es|ic|ish|ical|ing|ed|al|ism|ist)?";

// What the vocabulary list does not carry but names the same thing: race synonyms and tribes, spec abbreviations and nicknames, the spells and racial abilities of the nine classes
// and eight races that are distinctive enough to match as words. (The test adds every spell and racial in data/client.json to this.)
export const EXTRA_TERMS = Object.freeze([
  "forsaken", "darkspear", "kaldorei", "sin dorei", "orcish", "gnomish", "dwarven", "elven", "tauren",
  "ret", "disc", "demo", "prot", "resto", "bm", "mm", "sv", "assa", "enh", "ele", "aff", "destro", "feral", "boomkin", "moonkin", "bear form", "cat form",
  "fireball", "frostbolt", "pyroblast", "polymorph", "arcane missiles", "arcane explosion", "ice lance", "ice block", "frost nova", "shadow bolt", "mind blast", "power word", "smite",
  "lightning bolt", "chain lightning", "earth shock", "flame shock", "rejuvenation", "moonfire", "starfire", "backstab", "sinister strike", "eviscerate", "heroic strike",
  "mortal strike", "whirlwind", "shield slam", "consecration", "hammer of justice", "holy light", "lay on hands", "multi shot", "aimed shot", "arcane shot", "serpent sting",
  "immolate", "corruption", "drain life", "soul fire", "life tap", "healing wave", "lesser healing wave", "flash heal", "renew", "mind control",
  "war stomp", "berserking", "blood fury", "cannibalize", "will of the forsaken", "shadowmeld", "stoneform", "escape artist", "war stomp", "hardiness", "cultivation",
]);

function vocabularyTerms() {
  const out = new Set();
  for (const list of Object.values({ race: SHEET_VOCAB.race, class: SHEET_VOCAB.class, spec: SHEET_VOCAB.spec, professions: SHEET_VOCAB.professions, plan_zone: SHEET_VOCAB.plan_zone })) {
    for (const [slug, label] of Object.entries(list)) { out.add(normaliseText(slug)); out.add(normaliseText(label)); }
  }
  for (const t of EXTRA_TERMS) out.add(normaliseText(t));
  out.delete("");
  return [...out];
}
const TERMS = vocabularyTerms();
const termRe = (t) => new RegExp(`(?:^| )${t}${ENDINGS}(?: |$)`);
const MATCHERS = TERMS.map((t) => [t, termRe(t)]);

// The vocabulary values (and extras) a text names. `allow` lists normalised terms this text may name (the meeting place is public: see ALLOWED).
export function namesVocabulary(text, extra = [], allow = []) {
  const n = normaliseText(text);
  const hits = [];
  for (const [t, re] of MATCHERS) if (!allow.includes(t) && re.test(n)) hits.push(t);
  for (const e of extra) { const t = normaliseText(e); if (t && !allow.includes(t) && termRe(t).test(n)) hits.push(t); }
  return hits;
}

// "Valley of Strength" is the meeting place: guided-atlas keeps it public whatever a member hides (public-party.js projectGuidedAtlas), and it is not a member's own value.
export const ALLOWED = Object.freeze(["valley of strength"]);
const entryText = (g) => [g.term, ...(Array.isArray(g.forms) ? g.forms : []), g.def].join(" \n ");
export const entryNamesVocabulary = (g, extra = []) => namesVocabulary(entryText(g), extra, ALLOWED);

// Entries that name nothing of the vocabulary; an entry that does is withheld (dropped), never served.
export const filterGlossary = (list) => (Array.isArray(list) ? list : []).filter((g) => g && typeof g === "object" && entryNamesVocabulary(g).length === 0);
// The glossary as served: the bundled entries minus any that name the vocabulary (none today), as fresh copies so a caller cannot change the bundle.
export const SERVED = Object.freeze(filterGlossary(GLOSSARY));
export const bundledGlossary = () => GLOSSARY.map((g) => ({ ...g, forms: [...g.forms] }));
export const servedGlossary = () => SERVED.map((g) => ({ ...g, forms: [...g.forms] }));
