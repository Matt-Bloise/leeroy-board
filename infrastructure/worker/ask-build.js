// Personalisation for /ask: who is asking, their own build (YOUR_BUILD), the others' published builds (PARTY_BUILDS, visible fields
// only), and a cheap grounding check that replaces an answer naming things the library never gave. Pure functions; no I/O.
import { slugify } from "./member-model.js";
import { ROSTER_DATA } from "./bot-data.js";
import { stripFence } from "./prompt-fence.js";

export const NOT_PUBLISHED_LINE = "The library does not have that yet.";
export const EMPTY_BUILD_LINE = "No build on file for the asker yet. Say so once and ask them to fill in their sheet on the board.";
export const VISITOR_BUILD_LINE = "Visitor: no build; do not mention sheets.";
// The member has data, but none of it may appear in this (public) ask: say nothing about sheets or missing data.
export const HIDDEN_BUILD_LINE = "Build is private for this ask; do not mention sheets or missing data.";
export const hasBuildText = (t) => !/^(No build on file|Visitor: no build|Build is private)/.test(String(t));

// Sheet fields shown to the model, in order. Mirrors SHEET_FIELDS in index.js plus role if a sheet carries one.
const FIELD_ORDER = ["class", "race", "spec_path", "spec_at_40", "level", "role", "professions", "launch_state", "plan_zone", "goals"];

// Fails closed: a field is public only when it says visible === true. Missing, null or a bare value counts as hidden.
const isVisible = (f) => Boolean(f) && typeof f === "object" && !Array.isArray(f) && f.visible === true;

const clip = (s, n) => String(s).replace(/\s+/g, " ").trim().slice(0, n);

function fieldText(f) {
  const v = f && typeof f === "object" && !Array.isArray(f) && "value" in f ? f.value : f;
  if (v === null || v === undefined || v === "") return "";
  return clip(stripFence(Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : v, { oneLine: true }), 120);
}

// The asker's sheet. The authenticated member slug decides on its own; the display name is a fallback only when there is no slug, and
// a name-only match is never trusted with hidden fields (bySlug false). Visitors never match.
export function findAsker(sheets, { by, memberSlug, isMember = true } = {}) {
  if (!isMember || !Array.isArray(sheets)) return { sheet: null, bySlug: false };
  const slug = memberSlug && memberSlug !== "guest" ? slugify(memberSlug) : "";
  if (slug) {
    const hit = sheets.find((s) => s && slugify(s.slug || "") === slug);
    if (hit) return { sheet: hit, bySlug: true };
    return { sheet: null, bySlug: false };
  }
  const want = new Set();
  if (by && String(by).trim().toLowerCase() !== "visitor") {
    want.add(slugify(by));
    const lower = String(by).trim().toLowerCase();
    for (const r of ROSTER_DATA) if (r.display.toLowerCase() === lower || (r.aliases || []).includes(lower)) want.add(slugify(r.display));
  }
  want.delete("");
  const hit = sheets.find((s) => s && (want.has(slugify(s.slug || "")) || want.has(slugify(s.name || ""))));
  return { sheet: hit || null, bySlug: false };
}

export const findAskerSheet = (sheets, o) => findAsker(sheets, o).sheet;

function stateFor(sheet, stateMap) {
  const out = [];
  const roster = stateMap && stateMap.signups && stateMap.signups.roster;
  if (roster && typeof roster === "object") {
    for (const [k, v] of Object.entries(roster)) if (slugify(k) === slugify(sheet.slug || sheet.name || "")) out.push(`signup: ${clip(stripFence(v, { oneLine: true }), 40)}`);
  }
  const t = stateMap && stateMap.tonight;
  if (t) {
    const label = typeof t === "object" ? t.title || t.status || "" : t;
    if (label) out.push(`tonight: ${clip(stripFence(label, { oneLine: true }), 60)}`);
  }
  return out;
}

// The asker's own fields. A hidden field is included only for a private ask (includeHidden): a public ask is posted in the channel,
// where the model could repeat it to everyone.
export function renderAskerBuild(sheet, stateMap, { includeHidden = false } = {}) {
  if (!sheet) return EMPTY_BUILD_LINE;
  const fields = sheet.fields || {};
  const parts = [];
  for (const k of FIELD_ORDER) {
    if (!includeHidden && !isVisible(fields[k])) continue;
    const t = fieldText(fields[k]);
    if (t) parts.push(`${k}: ${t}`);
  }
  if (!parts.length) return Object.values(fields).some((f) => fieldText(f)) ? HIDDEN_BUILD_LINE : EMPTY_BUILD_LINE;
  return [`${clip(stripFence(sheet.name || sheet.slug, { oneLine: true }), 40)} (the asker)`, ...parts, ...stateFor(sheet, stateMap)].join("; ");
}

// The asker's class, spec, level, race and professions as plain values, for the code-written abstain answer. Same visibility rule as renderAskerBuild.
export function askerFacts(sheet, { includeHidden = false } = {}) {
  if (!sheet) return null;
  const fields = sheet.fields || {};
  const get = (k) => (!includeHidden && !isVisible(fields[k]) ? "" : fieldText(fields[k]));
  const out = { class: get("class"), spec: get("spec_path"), level: get("level"), race: get("race"), professions: get("professions").split(/[,;]+/).map((x) => x.trim()).filter(Boolean) };
  return out.class || out.spec || out.level || out.professions.length ? out : null;
}

// ---- relevance -------------------------------------------------------------------------------------------------------------
// The stored build is in the prompt BY DEFAULT; the model decides whether it changes the answer (PERSONALISE_RULE). Third-person mentions of a class or race
// ("how do I beat a rogue", "where are the rogue trainers", "how do I open this lock") never suppress it: regex cannot tell those apart. Code suppresses only on SELF-IDENTIFICATION:
//  0. A pure "my build" question (skip === "build"): kept.
//  1. An explicit phrase (my build/class/character/spec/race/level/profession/talents/sheet/main/gear, my party/group, our party/group/build/comp/team): kept.
//  2. The asker says they are a class or race ("I am a hunter", "I'm a dwarf", "as an undead", "I play / I main a ...", "my hunter") and it is the stored class or race: kept.
//  3. The asker says they are a class or race that is NOT the stored one: suppressed.
//  4. A follow-up whose previous question was suppressed under 3, and which itself self-identifies as nothing: suppressed (it inherits that decision).
//  Everything else: kept. Full class names and plain plurals only, no nicknames. No class or race on file means nothing to contradict, so kept.
export const BUILD_NOT_RELEVANT_LINE = "The asker's stored build is not relevant to this question: do not mention it.";
const CLASSES = ["warrior", "paladin", "hunter", "rogue", "priest", "shaman", "mage", "warlock", "druid"];
const RACE_FORMS = { human: ["human"], dwarf: ["dwarf", "dwarves"], gnome: ["gnome"], "night elf": ["night elf", "night elves"], orc: ["orc"], undead: ["undead", "forsaken"], tauren: ["tauren"], troll: ["troll"] };
const SELF_RE = /\b(?:my\s+(?:build|character|char|class|spec|specs|race|level|profession|professions|talents|sheet|main|gear|party|group)|our\s+(?:party|group|build|comp|team))\b/i;
const wordsOf = (t) => String(t || "").toLowerCase().split(/[^a-z0-9']+/).filter(Boolean);
const singular = (w) => w.replace(/(?<=[a-z]{3})s$/, "");
// The classes and races the question says the ASKER is: only the words IMMEDIATELY after a self-identification opener (articles allowed, then race and class words,
// e.g. "I am a night elf hunter"). "I am fighting a rogue" and "my friend is a hunter" name no identity: the first word after the opener must be an article, race or class.
const RACE_WORDS = new Set(Object.values(RACE_FORMS).flat().flatMap((f) => f.split(" ")));
function selfIdentified(q) {
  const classes = new Set(), races = new Set();
  const text = String(q || "").toLowerCase();
  for (const m of text.matchAll(/\b(?:i\s*am|i'm|im|i\s+play|i\s+main|as\s+an?|my)\b([^.,;!?]*)/g)) {
    const ws = wordsOf(m[1]);
    let i = 0;
    while (i < ws.length && ["a", "an", "the"].includes(ws[i]) && i < 1) i++;
    const taken = [];
    for (; i < ws.length && taken.length < 3; i++) {
      const w = ws[i];
      if (CLASSES.some((k) => k === w || `${k}s` === w) || RACE_WORDS.has(w) || RACE_WORDS.has(w.replace(/s$/, ""))) taken.push(w); else break;
    }
    const span = ` ${taken.join(" ")} `;
    for (const w of taken) { const c = CLASSES.find((k) => k === w || `${k}s` === w); if (c) classes.add(c); }
    for (const [k, forms] of Object.entries(RACE_FORMS)) if (forms.some((f) => span.includes(` ${f} `) || span.includes(` ${f}s `))) races.add(k);
  }
  return { classes, races };
}
export function buildRelevant(question, facts, { skip = null, previousQuestion = "" } = {}) {
  if (skip === "build") return { relevant: true, reason: "build question" };
  const q = String(question || "");
  if (SELF_RE.test(q)) return { relevant: true, reason: "explicit build phrase" };
  const myClass = facts && facts.class ? wordsOf(facts.class).map(singular).find((w) => CLASSES.includes(w)) : "";
  const myRace = facts && facts.race ? String(facts.race).toLowerCase() : "";
  const myKey = Object.keys(RACE_FORMS).find((k) => myRace.includes(k) || RACE_FORMS[k].some((f) => myRace.includes(f)));
  const verdict = (text) => {
    const id = selfIdentified(text);
    const badC = myClass && id.classes.size && !id.classes.has(myClass), badR = myKey && id.races.size && !id.races.has(myKey);
    if (badC || badR) return "different"; // any identity that contradicts the stored build wins ("I am a night elf hunter" with a night elf druid)
    return (myClass && id.classes.has(myClass)) || (myKey && id.races.has(myKey)) ? "own" : "none";
  };
  const cur = verdict(q);
  if (cur === "different") return { relevant: false, reason: "asker says they are another class or race" };
  if (cur === "none" && previousQuestion && !SELF_RE.test(String(previousQuestion)) && verdict(previousQuestion) === "different") return { relevant: false, reason: "follow-up of a suppressed question" };
  return { relevant: true, reason: cur === "own" ? "asker names own class or race" : "default" };
}

// Other members: ONLY fields marked visible. A hidden field's value must never reach the prompt.
export function renderPartyBuilds(sheets, askerSheet) {
  const lines = [];
  for (const s of Array.isArray(sheets) ? sheets : []) {
    if (!s || s === askerSheet) continue;
    const parts = [];
    for (const k of FIELD_ORDER) {
      const f = (s.fields || {})[k];
      if (!isVisible(f)) continue;
      const t = fieldText(f);
      if (t) parts.push(`${k} ${t}`);
    }
    lines.push(`${clip(stripFence(s.name || s.slug, { oneLine: true }), 40)}: ${parts.join(", ") || "no public build yet"}`);
  }
  return lines.join("\n");
}

// ---- grounding check -------------------------------------------------------------------------------------------------------
// A Title Case phrase of two or more words that appears nowhere in the retrieved library text, the asker's build, the party state, the
// party names or the question is an invented spell, place or item. Conservative: single capitalised words, house names, generic prose
// words ("Recommended Next Steps"), headings and leading connector words never trigger it. A hit removes only the sentence or bullet that
// holds the name; the whole answer falls back to the not-published line only when nothing substantive is left.
const PHRASE_RE = /\b[A-Z][a-z]+(?:'s)?(?:\s+(?:of|the|in|for|to)\s+[A-Z][a-z]+(?:'s)?|\s+[A-Z][a-z]+(?:'s)?)+/g;
// A possessive of a name is the name: "Bible Boi's" is checked as "Bible Boi".
const unpossess = (w) => w.replace(/'s?$/i, "");
const HOUSE = [...ROSTER_DATA.map((r) => r.display), "leeroy", "leeroy jenkins", "dungeons and drinking", "wow classic", "classic forever", "world of warcraft"];
const CONNECTORS = new Set(["of", "the", "in", "for", "to", "and", "a", "an", "at", "on", "with"]);
// Words that make ordinary prose look like a name: sentence openers, heading words, filler.
const GENERIC = new Set((
  "a an and any as at also all be best both but by can check consider choose do does each either even every first for from get good great " +
  "have here how if in is it its just key last later less let like luck look make many more most much next no not now of on one only open " +
  "option options or other our overview point points quick recommended remember same see second set should since so some start step steps " +
  "summary take tell tip tips that the their then there these they third this those though three tonight today too try two up use want was " +
  "way we well what when where which while who why will with without worth would yes you your meet pick keep give note notes plan " +
  "reminder reminders also still once before after during until across about above below over under basics guide info details rundown breakdown comparison pros cons requirements talent tree trees side horde alliance build builds spec specs role roles class classes profession professions gear zone zones dungeon dungeons quest quests level levels leveling rotation stats priority reward rewards requirements location locations route schedule per via ask answer answers question " +
  "questions party board library sign signup signups ups trade offs long short high low early late new old big small full half"
).split(/\s+/));

const words = (t) => t.split(/\s+/).filter(Boolean);

// After a sentence is cut out of a bold line, an unpaired ** would bold the rest of the message: drop the markers if they are odd.
function balanceBold(line) {
  return (line.match(/\*\*/g) || []).length % 2 ? line.replace(/\*\*/g, "") : line;
}

function trimPhrase(phrase, opens) {
  let w = words(phrase);
  // Leading connectors and generic filler are not part of a name ("Meet in Deadmines" -> "Deadmines").
  while (w.length && (CONNECTORS.has(w[0].toLowerCase()) || (GENERIC.has(w[0].toLowerCase()) && (opens || w.length > 2)))) w.shift();
  while (w.length && (CONNECTORS.has(w[w.length - 1].toLowerCase()) || GENERIC.has(w[w.length - 1].toLowerCase()))) w.pop();
  return w;
}

const tokenCache = new Map();
function tokens(allowed) {
  let t = tokenCache.get(allowed);
  if (!t) {
    t = new Set();
    for (const w of allowed.match(/[a-z]+(?:'s)?/g) || []) { t.add(w); t.add(unpossess(w)); }
    if (tokenCache.size > 20) tokenCache.clear();
    tokenCache.set(allowed, t);
  }
  return t;
}

function badPhrases(text, allowed) {
  const bad = [];
  for (const m of text.replace(/[*_`]/g, "").matchAll(PHRASE_RE)) {
    const whole = m[0].replace(/'s\b/g, "'s");
    if (allowed.includes(unpossess(whole).toLowerCase()) || allowed.includes(whole.toLowerCase())) continue;
    // A possessive ends a name: "Street Rat's Holy Shield" is two names, each checked on its own.
    for (const seg of whole.split(/'s\b\s*/).filter(Boolean)) {
      const full = words(seg).map((w, i, a) => (i === a.length - 1 ? unpossess(w) : w)).join(" ");
      if (allowed.includes(full.toLowerCase())) continue;
      const core = trimPhrase(full, true).map(unpossess);
      if (core.length < 2) continue;
      if (allowed.includes(core.join(" ").toLowerCase())) continue;
      // Every word of the name is individually grounded and the phrase is just grounded things side by side ("Paladin Deadmines").
      const sig = core.filter((x) => !CONNECTORS.has(x.toLowerCase()));
      if (sig.every((x) => tokens(allowed).has(x.toLowerCase())) && sig.length <= 3) continue;
      bad.push(full);
    }
  }
  return bad;
}

export function unknownNames(answer, allowedText) {
  const body = String(answer || "").split(/\n-#\s*Sources?:/i)[0];
  const allowed = `${allowedText || ""} ${HOUSE.join(" ")}`.toLowerCase();
  const bad = [];
  for (const line of body.split("\n")) {
    bad.push(...badPhrases(line, allowed));
  }
  return bad;
}

// Remove only the sentences/bullets that hold an unknown name; keep everything else, the headline and the Sources line.
export function groundedOrNotPublished(answer, allowedText) {
  const text = String(answer || "");
  const cut = text.search(/\n-#\s*Sources?:/i);
  const body = cut >= 0 ? text.slice(0, cut) : text;
  const tail = cut >= 0 ? text.slice(cut) : "";
  const allowed = `${allowedText || ""} ${HOUSE.join(" ")}`.toLowerCase();
  const bad = [];
  const kept = [];
  for (const line of body.split("\n")) {
    const parts = line.split(/(?<=[.!?])\s+/);
    const ok = parts.filter((sent) => {
      const b = badPhrases(sent, allowed);
      bad.push(...b);
      return b.length === 0;
    });
    if (ok.length === parts.length) kept.push(line);
    else if (ok.length) kept.push(balanceBold(ok.join(" ")));
    // a line that lost every sentence is dropped
  }
  if (!bad.length) return { ok: true, bad: [], answer: text };
  const left = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const substantive = left.replace(/[^A-Za-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 2).length;
  if (substantive < 4) return { ok: false, bad, answer: NOT_PUBLISHED_LINE };
  return { ok: false, bad, answer: `${left}${tail}` };
}

// A refusal ("The library does not have that yet") stays a refusal. Inside the sentence that holds the line, a trailing ", as ... is not
// published yet" qualifier is an unsupported status claim and goes. After it, a sentence that holds a name the grounding text never gave, or
// that claims something "is not published", goes too. A sentence naming what would settle it, or what the library does say, stays.
// An answer without the refusal line is returned unchanged, byte for byte.
const REFUSAL_RE = /the library does not have that yet\.?/i;
const PUB_CLAIM_RE = /(?:\b(?:not|nothing|never|no|none|nobody)\b|n't\b)[^.!?]{0,40}\bpublished\b/i; // advisor follow-up: the old no\w* matched notes, now, November, normal
const PERSONA_ASTHE_RE = new RegExp("^as the [^.!?]{0,160}librarian", "i"), PERSONA_VERB_RE = new RegExp("\\bI (?:can |will |am here to )?(?:share|look up|offer|help|pull)\\b", "i"), PERSONA_VERIFIED_RE = new RegExp("^i (?:look up|share) verified (?:library )?facts, options", "i");
// a persona sentence restates the role and carries no fact (advisor follow-up Nov 9: 'I share verified library facts: Onyxia opens on ...' must survive)
const personaSentence = (s) => (PERSONA_ASTHE_RE.test(s) && PERSONA_VERB_RE.test(s)) || PERSONA_VERIFIED_RE.test(s);
export function guardRefusal(answer, allowedText) {
  const text = String(answer || "");
  if (!REFUSAL_RE.test(text)) return text;
  const cut = text.search(/\n-#\s*Sources?:/i);
  const body = cut >= 0 ? text.slice(0, cut) : text;
  const tail = cut >= 0 ? text.slice(cut) : "";
  const allowed = `${allowedText || ""} ${HOUSE.join(" ")}`.toLowerCase();
  let seen = false;
  const out = [];
  for (const line of body.split("\n")) {
    const parts = line.split(/(?<=[.!?])\s+/);
    const kept = [];
    for (let sent of parts) {
      if (!seen && REFUSAL_RE.test(sent)) {
        seen = true;
        const m = REFUSAL_RE.exec(sent);
        const after = sent.slice(m.index + m[0].length);
        if (PUB_CLAIM_RE.test(after) || badPhrases(after, allowed).length) sent = `${sent.slice(0, m.index + m[0].length).replace(/\.?$/, ".")}`;
        kept.push(sent);
        continue;
      }
      // Nov 9 eval: after the refusal the model restates its persona (As the party librarian for ... I share verified facts); that is branding, not an answer.
      if (seen && (personaSentence(sent.trim()) || PUB_CLAIM_RE.test(sent) || badPhrases(sent, allowed).length)) continue;
      kept.push(sent);
    }
    if (kept.length === parts.length && kept.every((k, i) => k === parts[i])) out.push(line);
    else if (kept.length) out.push(balanceBold(kept.join(" ")));
  }
  const left = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return left ? `${left}${body.match(/\s*$/)[0]}${tail}` : text;
}
