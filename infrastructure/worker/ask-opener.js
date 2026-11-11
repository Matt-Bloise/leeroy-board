// =============================================================================
// Deterministic /ask opener and build-aware retrieval helpers (`worker/ask-opener.js`)
// No model call, no I/O, no private data: the only inputs are the question, the top retrieved page id, the asker's visible build
// facts (ask-build.js askerFacts) and the facts already shown in the prompt. One short hand-written line is chosen from a bank by
// topic and class with a stable hash of the question, so the same question always gets the same line and the voice is testable
// without a judge. The model is never asked to be funny: it still answers only from the library; the opener only frames it.
// =============================================================================

export const FACTION_OF_RACE = { human: "Alliance", dwarf: "Alliance", gnome: "Alliance", "night elf": "Alliance", orc: "Horde", undead: "Horde", tauren: "Horde", troll: "Horde" };

// "human" -> "Alliance". Unknown or empty race -> "" (nothing is guessed).
export function factionOf(race) {
  // Whole words only: "orcish" or "gnomeregan" is not a race on the list. Letters and single spaces only, so "night-elf" and "Night Elf" agree.
  const r = ` ${String(race || "").toLowerCase().replace(/[^a-z]+/g, " ").trim()} `;
  const key = Object.keys(FACTION_OF_RACE).find((k) => r.includes(` ${k} `) || (k === "undead" && r.includes(" forsaken ")));
  return key ? FACTION_OF_RACE[key] : "";
}

// Role questions: the library files tank, healer and damage facts under the class pages, so the class and spec are added to the retrieval query for these.
export const ROLE_RE = /\b(?:tanks?|tanking|healers?|healing|heals?|dps|damage dealers?|off[- ]?tanks?)\b/i;
export function isRoleQuestion(question) { return ROLE_RE.test(String(question || "")); }

const stable = (s) => { let h = 5381; for (const c of String(s || "").toLowerCase().trim()) h = ((h << 5) + h + c.charCodeAt(0)) >>> 0; return h; };
const pick = (list, seed) => list[seed % list.length];

// Topic lines: plain, short, friendly. No names, no emojis, no advice, never the words Skippy or honestly.
export const TOPIC_BANK = {
  role: ["Roles first, then the facts.", "Tank, healer or damage, here is what the library holds.", "A role question: here is the shelf for it."],
  classes: ["A class question, so here is the shelf.", "Class talk, straight from the library.", "Good one for the class shelf."],
  races: ["Race question, and the library has a page for it.", "Racials are on the shelf, so here they are.", "A race question, answered from the library."],
  dungeons: ["Dungeon question, and the shelf has it.", "Dungeons first, details below.", "Here is what the library says about dungeons."],
  raids: ["Raid question, so here is the raid shelf.", "Raids are on the shelf, so here is what is known.", "A raid question, answered as far as the library goes."],
  professions: ["Profession question, off the crafting shelf.", "Crafting talk, from the library.", "Here is the professions shelf."],
  leveling: ["Leveling question, so here is the road.", "Off the leveling shelf:", "The leveling shelf has this."],
  systems: ["A systems question, answered from the library.", "Game rules first, then the sources.", "Here is how the library says it works."],
  events: ["A dates question, so here is what is published.", "Off the events shelf:", "Here is what the library has on that date."],
  pvp: ["A PvP question, straight from the shelf.", "PvP first, sources below.", "Here is the PvP shelf on this."],
  default: ["Here is what the library has.", "Off the shelf:", "The library says this."],
};

// Class lines (the asker's own class, when the question is about class, race or role): {who} is "your protection paladin" built from visible build fields only.
export const BUILD_BANK = {
  withFact: ["Here is what the library holds for {who}.", "{Who}: the library has this.", "For {who}, off the shelf:"],
  noFact: ["The library has nothing specific to {who} on this yet, so here is the general picture.", "Nothing on the shelf is specific to {who} here, so this is the general picture."],
};

const CLASSES = ["warrior", "paladin", "hunter", "rogue", "priest", "shaman", "mage", "warlock", "druid"];
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const SPECIAL_SPEC = /^(?:none|unknown|undecided|tbd|\?+)$/i;

// "your protection paladin", "your gnome mage" (race topic), or "" when the build holds no class.
export function whoText(facts, topic) {
  const cls = String((facts && facts.class) || "").toLowerCase().split(/[^a-z]+/).find((w) => CLASSES.includes(w)) || "";
  if (!cls) return "";
  const spec = String((facts && facts.spec) || "").toLowerCase().replace(/[^a-z ]+/g, " ").trim();
  const race = String((facts && facts.race) || "").toLowerCase().replace(/[^a-z ]+/g, " ").trim();
  const mid = topic === "races" && race ? race : spec && !SPECIAL_SPEC.test(spec) && spec !== cls ? spec : "";
  return `your ${mid ? `${mid} ` : ""}${cls}`;
}

// Does the library text shown in the prompt mention the asker's class or spec?
export function hasBuildFact(shownFacts, facts) {
  const text = String(shownFacts || "").toLowerCase();
  // Strip to letters first, then judge the length: a spec such as "---" must become nothing, not an empty pattern that matches any text.
  const words = [facts && facts.class, facts && facts.spec].map((w) => String(w || "").toLowerCase().replace(/[^a-z ]/g, "").replace(/ +/g, " ").trim()).filter((w) => w.length > 2 && !SPECIAL_SPEC.test(w));
  return words.some((w) => new RegExp("\\b" + w + "\\b").test(text));
}

// The topic key: a role question, else the category of the best retrieved page, else default.
export function openerTopic(question, topPageId) {
  if (isRoleQuestion(question)) return "role";
  const cat = String(topPageId || "").split("/")[0];
  return Object.prototype.hasOwnProperty.call(TOPIC_BANK, cat) ? cat : "default";
}

// The opener line, or "" when there is nothing to say. facts: the asker's visible build (null when the build is not relevant, hidden or absent).
export function buildOpener({ question, topPageId, facts = null, shownFacts = "" } = {}) {
  const topic = openerTopic(question, topPageId);
  const seed = stable(question);
  const buildTopic = topic === "role" || topic === "classes" || topic === "races";
  const who = facts && buildTopic ? whoText(facts, topic) : "";
  if (who) {
    // A race question counts as covered when a retrieved fact names the race or the top page is the asker's faction racials page (races/horde-racials for an undead).
    const raceCovered = topic === "races" && facts && (hasBuildFact(shownFacts, { class: facts.race }) || (factionOf(facts.race) && String(topPageId || "").toLowerCase().includes(factionOf(facts.race).toLowerCase())));
    const bank = raceCovered || hasBuildFact(shownFacts, facts) ? BUILD_BANK.withFact : BUILD_BANK.noFact;
    return pick(bank, seed).replace("{Who}", cap(who)).replace("{who}", who);
  }
  return pick(TOPIC_BANK[topic], seed);
}

// The extra retrieval words for a role question from a member with a build: class and spec only (never race, level or professions: they drift the ranking).
export function buildQueryExtra(question, facts) {
  if (!facts || !isRoleQuestion(question)) return "";
  const cls = String(facts.class || "").toLowerCase().split(/[^a-z]+/).find((w) => CLASSES.includes(w)) || "";
  if (!cls) return "";
  const spec = String(facts.spec || "").toLowerCase().replace(/[^a-z ]+/g, " ").trim();
  return spec && !SPECIAL_SPEC.test(spec) && spec !== cls ? `${cls} ${spec}` : cls;
}

// Facts from a build-augmented rank pass worth adding: they must name the asker's class (word match) and not already be shown. At most `max`.
export function pickBuildFacts(extraHits, shownHits, facts, max = 2) {
  const cls = String((facts && facts.class) || "").toLowerCase().split(/[^a-z]+/).find((w) => CLASSES.includes(w)) || "";
  if (!cls) return [];
  const re = new RegExp("\\b" + cls + "s?\\b", "i");
  const have = new Set((shownHits || []).map((h) => `${h.page}~${h.key}`));
  const out = [];
  for (const h of extraHits || []) {
    if (out.length >= max) break;
    const id = `${h.page}~${h.key}`;
    if (have.has(id) || !re.test(String(h.value || ""))) continue;
    out.push(h);
  }
  return out;
}
