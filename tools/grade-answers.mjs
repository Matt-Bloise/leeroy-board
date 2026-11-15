// Rule-based answer TRIPWIRE for the Leeroy golden set. It is not the gate; --tripwire (alias --gate) only fails the run when a rule fires. Deterministic: no network, no model, no clock.
// It catches the obvious failures cheaply and offline; the real gate is grading by a second model family plus
// answers read by hand. A pass here means "no rule fired", never "this answer is right".
//
//   gradeAnswer({ question, answer, slice, reference, gathered, expect })
//     -> { deadEnd, boundary, invented, answerFirst, labels: [], notes: [] }          (rejected input adds rejected: true)
//   classify(grade) -> "dead_end" | "invented" | "boundary" | "ok" | "rejected"
//   normalizeText(text) -> NFKC, zero-width removed, curly quotes folded, common lookalike letters folded
//
// CLI: node tools/grade-answers.mjs answers.jsonl [--cases <golden dir>] [--tripwire] [--expect-count N]
//   Row: { id, caseId, answer }. The case supplies question, slice, reference and expect. Prints one JSON line per row and
//   a summary line. A pass means no rule fired, never that the answers are right. --tripwire (alias --gate) exits 1 on ANY problem: unusable input, a dead end, an invented specific, a rejected answer,
//   or a class that differs from the case's expect. Fatal input problems print one clean line, never a stack trace.
//
// Method: normalise, split into sentences and clauses, type each clause (deflection, decline, filler, instruction-shaped,
// other), then test "other" text for substance. Specifics (numbers with units, dates, clock times, Title Case names)
// are compared with the reference and gathered text. A hedge excuses a specific only when that specific sits in a clause
// that states it as a Classic value AND the answer says it is unconfirmed.
//
// Known blind spots are listed in the report that ships with the tests; the largest: it has no semantics.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MAX_CHARS = 20000;

// ---------- normalisation ----------
const LOOKALIKE = {
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x", "і": "i", "ј": "j", "ѕ": "s", "һ": "h", "ԁ": "d", "ԛ": "q", "ԝ": "w",
  "А": "A", "В": "B", "Е": "E", "К": "K", "М": "M", "Н": "H", "О": "O", "Р": "P", "С": "C", "Т": "T", "Х": "X", "І": "I", "Ј": "J", "Ѕ": "S", "У": "Y",
  "α": "a", "ε": "e", "ο": "o", "ν": "v", "τ": "t", "ρ": "p", "κ": "k", "ι": "i",
  "Α": "A", "Β": "B", "Ε": "E", "Ζ": "Z", "Η": "H", "Ι": "I", "Κ": "K", "Μ": "M", "Ν": "N", "Ο": "O", "Ρ": "P", "Τ": "T", "Υ": "Y", "Χ": "X",
};
export function normalizeText(input) {
  let t;
  t = String(input).replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x660)).replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x6f0));
  t = t.normalize("NFKD").replace(/[̀-ͯ]/g, "").normalize("NFKC");
  t = t.replace(/[​-‏‪-‮⁠-⁤﻿­]/g, "");
  t = t.replace(/[‘’‛′ʼ]/g, "'").replace(/[“”„″]/g, '"').replace(/[‐-―−]/g, "-");
  t = t.replace(/[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g, " ");
  t = t.replace(/[Ѐ-ӿͰ-Ͽ]/g, (c) => LOOKALIKE[c] || c);
  return t.replace(/[ \t\f\v]+/g, " ");
}

// ---------- vocab ----------
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_RE = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const monthNum = (s) => MONTHS.indexOf(s.slice(0, 3).toLowerCase()) + 1;

const UNITS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const NUMWORD = new Set([...Object.keys(UNITS), ...Object.keys(TENS), "hundred", "thousand", "million", "dozen"]);
const MEASURE = new Map(Object.entries({
  gold: "gold", silver: "silver", copper: "copper", hour: "hour", hours: "hour", hr: "hour", hrs: "hour", minute: "minute", minutes: "minute", min: "minute", mins: "minute",
  second: "second", seconds: "second", sec: "second", secs: "second", day: "day", days: "day", week: "week", weeks: "week", month: "month", months: "month",
  player: "player", players: "player", quest: "quest", quests: "quest", slot: "slot", slots: "slot", point: "point", points: "point", level: "level", levels: "level", lvl: "level",
  yard: "yard", yards: "yard", stack: "stack", stacks: "stack", charge: "charge", charges: "charge", percent: "percent", rank: "rank", tier: "tier", skill: "skill",
}));
const PREFIX_UNIT = new Set(["level", "levels", "lvl", "rank", "tier", "skill"]);
const STOP_CONTENT = new Set("about after again also been being both could does doing done each from have having here into just like make more most much must only other over same some such than that their them then there these they this those very what when where which while will with would your you the and for are but not can its has had was were who how why any all our out one two".split(" "));

const COMMON_START = new Set(("the a an this that these those it its they them their there here you your we our i my me he she his her if when where what which who why how for from in on at by to of with without as and but or so yet nor not no yes nothing none nobody nowhere everything " +
  "some any all each every both either one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred thousand " +
  "take choose pick go use buy start run skip get avoid spend grab sell craft farm learn train join queue bring keep try do drop save trade invite reply confirm turn open set pull focus heal taunt add post sign let make give ask tell check see read look be is are was were have has had can could will would should shall may might must " +
  "also then now still just only even very really honestly sadly unfortunately sure certainly absolutely well ok okay great good nice mostly usually typically generally roughly about around first second last next because since while although though however instead otherwise per unless until after before during once again more most less many much few several other another such same whoever whatever anyone someone everyone " +
  "dungeon dungeons dungeoneering group party raid raids boss bosses level levels gold silver copper quest quests spell spells item items zone zones basic larger smaller bigger best better worst worse early late long short high low new old nearly almost always never sometimes often").split(" "));

const NAME_STOP = new Set(("classic forever wow world warcraft blizzard horde alliance discord wowhead leeroy library sources source era season auction house monday tuesday wednesday thursday friday saturday sunday " +
  "january february march april may june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec i yes no ok okay " +
  "druid hunter mage paladin priest rogue shaman warlock warrior tauren undead troll orc human dwarf gnome elf tank healer " +
  "tailoring mining herbalism skinning alchemy blacksmithing enchanting engineering leatherworking fishing cooking frost fire holy arcane shadow pm am gold level reply note dm azeroth").split(" "));

// ---------- clause typing ----------
const CLAUSE = /;\s+|:\s+|,\s+(?=(?:but|though|and|then|so|just|instead|however|while|since|because|although|also|or|see|check|ask|try|look|ignore|disregard|forget|override)\b)|\s+and\s+(?=(?:check|ask|see|try|look|visit)\b)|\s+(?:but|though|however|instead)\s+|\s+-{1,2}\s+/gi;

const INJECTION = [
  /\b(?:grade|mark|score|rate|label|classify|treat|count|record|judge|assess|evaluate)\s+(?:this|it|the answer|this answer|my answer|this response|this reply|me)\b.{0,50}\b(?:as\s+)?(?:pass(?:ed)?|correct|good|ok(?:ay)?|valid|perfect|complete|not a dead|safe|satisf\w+|\d+\s*(?:\/|out of)\s*\d+)/i,
  /\b(?:grade|mark|score|rate|classify)\s+(?:this|it)\s+(?:as\s+)?(?:a\s+)?pass\b/i,
  /\b(?:ignore|disregard|forget|override)\b.{0,40}\b(?:instructions?|rules?|criteria|rubric|grading|guidelines)\b/i,
  /\b(?:dead_?end|invented|boundary|answerFirst)\W{0,3}\s*[:=]\s*(?:true|false)\b/i,
  /^\s*(?:system|assistant|developer|instruction)s?\s*(?::|$)/i,
  /\bscore this (?:answer )?\d/i,
  /\b(?:whoever|anyone|those|people|reviewers?|assessors?|evaluators?|graders?|judges?|raters?)\b.{0,30}\b(?:is|are|who|reading|assessing|evaluating|grading|scoring|reviewing|judging)\b.{0,40}\b(?:this|it|response|reply|answer)\b/i,
  /\breviewer'?s? note\b|\b(?:note|message|instructions?) (?:to|for) (?:the )?(?:grader|judge|evaluator|reviewer|assessor)s?\b/i,
  /\b(?:for|in) (?:evaluation|grading|assessment|testing|review) (?:purposes?|mode)\b/i,
  /\b(?:this|the) (?:reply|response|answer)\b.{0,40}\b(?:fulfils?|fulfills?|satisf\w+|meets?|contains?|is)\b.{0,30}\b(?:every|all|the full)\b.{0,20}\b(?:requirements?|criteria|answer|complete)/i,
  /\bverdict\b|\b(?:pass\W+){2,}pass\b/i,
];

function injectionSpans(s) {
  const out = [];
  for (const re of INJECTION) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"); let m, n = 0;
    while ((m = g.exec(s)) && n++ < 20) { if (m[0].length === 0) { g.lastIndex++; continue; } out.push([m.index, m.index + m[0].length]); }
  }
  return out;
}

const DEFLECT = [
  /(?<!\bi )(?<!\bwe )(?<!\bi\x27ve )\b(?:check(?:ing)?|look(?:ing)? (?:at|up|in|through)|consult|see|read|browse|visit|search(?:ing)?|try|google|ask(?:ing)?|head (?:to|over to))\b[^.!?;:]{0,50}\b(?:wowhead|wiki|forums?|reddit|google|patch notes|official (?:site|forums?|website|page)|databases?|community|guild (?:leader|officers?)|veterans?|someone|somebody|anyone|a friend|your (?:guild|friends?|group|party))\b/i,
  /\b(?:wowhead|wiki|google|reddit|the forums?)\b[^.!?;:]{0,30}\b(?:will|should|would|can|has|have|knows?|tracks?|lists?)\b/i,
  /\b(?:one|something|a question) for (?:your|a|the)\b/i,
  /\b(?:i'?m|i am) not sure\b|\bi (?:do ?n'?o?t|don't|didn't|do not) know\b|\bi have no (?:idea|information)\b|\bbeats me\b|\bno idea\b|\bas good as mine\b|\b(?:isn'?t|is not|not) something i\b/i,
  /\bi (?:can'?t|cannot|can not|couldn'?t) (?:really |actually )?(?:help|say|answer|tell|assist)\b|\bi(?:'m| am) unable to (?:help|say|answer|tell)\b/i,
  /\b(?:as an ai|i'?m (?:just )?an ai)\b/i,
  /\bmaybe\b[^.!?;:]{0,30}\b(?:browse|search|check|look|ask)\b/i,
  /\b(?:best|right|good|better) (?:place|spot|source|bet|option) (?:to|is)\b[^.!?;:]{0,30}\b(?:check|look|ask|find|go|search|visit)\b/i,
  /\bhave you tried (?:looking|checking|searching|asking)\b/i,
  /\bit depends\b(?![^.!?;:]{0,40}\bon\b)/i,
  /\b(?:look|check|search)(?:ing)? (?:it )?(?:up )?online\b|\bsearch(?:ing)? the web\b/i,
];

const FILLER = [/\b(?:great|good|excellent|interesting|fun|nice|fair) (?:question|one|ask)\b/i, /\b(?:happy|glad) to help\b/i, /\bhope (?:that|this) helps\b/i, /\blet me know\b/i, /\bgood luck\b/i, /\bthinking about\b/i];

const DECL_VERB = /\b(?:can'?t|cannot|can not|won'?t|will not|not able to|unable to|shouldn'?t|should not|not going to|refuse to|not allowed to)\b/i;
const DECL_OBJ = /\b(?:on (?:his|her|their|someone'?s|another'?s) behalf|for (?:someone|another|them|him|her|that person|someone else|anyone else|other (?:people|members|players))|as (?:someone|another|them|him|her|that person)|reveal|disclose|leak|print|system prompt|admin token|tokens?|rubric|botting|bot|exploits?|hack\w*|gold sellers?|buy(?:ing)? gold|account shar\w*|(?:his|her|their|someone'?s|everyone'?s|anyone'?s) (?:\w+ ){0,2}(?:sheet|fields?|gold|data|account|spot))\b/i;
const DECL_AS_NAME = /\bas [A-Z][a-z]+\b/;
const DECL_GEN = /\b(?:tell|answer|help|say|share|give|provide|discuss)\b/i;
const DECL_OWN = [
  /\b(?:is|are|'s)\s+(?:his|hers|theirs|their own|private|up to (?:him|her|them))\b/i,
  /\b(?:theirs|his|hers) to (?:share|confirm|tell|say|decide)\b/i,
  /\bup to (?:him|her|them|\w+) to (?:tell|share|say|confirm|decide)\b/i,
  /\bhidden on (?:his|her|their) sheet\b/i,
  /\bprivate to (?:each|every|them)\b/i,
  /\bnot (?:mine|something i can)\b/i,
  /\b(?:risks?|risking|could get you|can get you|will get you)\b[^.!?;:]{0,25}\b(?:ban|banned|banning|suspend\w*|suspension)\b/i,
  /\bagainst (?:the )?(?:terms|rules|tos|terms of service)\b/i,
];

const DIRECTIVE = /^(?:(?:then|and|so|but|also|just|please)\s+)*(?:choose|take|pick|go|use|buy|equip|interrupt|run|start|skip|get|avoid|stack|grab|spend|level|farm|sell|craft|learn|train|join|queue|bring|keep|swap|switch|try|do|drop|save|upgrade|trade|invite|reply|confirm|turn|open|set|pull|focus|kite|heal|taunt|dodge|stun|group|add|post|sign|let|make|give|stay|wait|put|move|play|build|combine|split|rotate|prioriti[sz]e|favou?r|prefer|stick)\b/i;
// Phrases that mark guidance or an offer of help. Added in the review round after a clause-level rewrite stopped
// crediting boundary answers whose help carries no number, directive verb or word from the question.
const HELP_MARK = /\b(?:instead|legitimate|the (?:usual|safe|safer|easy|easiest|real|legit) (?:route|way|option|thing)|you can|you could|you should|you'll|i can (?:show|tell|help|explain|walk|give|set|note|answer)|here is|here's|how to)\b/i;
const NEG =/\b(?:no|not|none|nothing|never|cannot|can'?t|couldn'?t|could not|isn'?t|aren'?t|doesn'?t|does not|didn'?t|did not|haven'?t|hasn'?t|without|unable|unconfirmed|unverified)\b/i;
const UNCONF = /\b(?:not|never|isn'?t|wasn'?t|hasn'?t|haven'?t|aren'?t)\b[^.!?]{0,25}\b(?:confirmed|verified|published|announced|official(?:ly)?|known)\b|\bunconfirmed\b|\bunverified\b|\b(?:could not|couldn'?t|can'?t|cannot|can not) (?:confirm|verify)\b/i;
const CLASSIC = /\bclassic\b(.{0,60}?)\b(?:was|were|had|took|used to|value|number|figure|limit|cap|size)\b/i;
const CLASSIC_DISQ = /\b(?:aside|apart|besides|except|ignoring|regardless|notwithstanding|setting)\b/i;
const SOURCE_SPAN = /\b(?:checked|searched|read|reviewed|looked (?:at|through)|consulted|found in)\b[^.!?;:]{0,60}?\b(?:posts?|notes|pages?|guides?|index|articles?|threads?|changelog|sources?|announcements?|hotfix(?:es)?)\b/gi;
const PICK = /\b(?:take|pick|choose|go with|start with|buy|do|use|skip|get|spend|run|level|grab|i'?d|i would|go for|prefer|recommend|farm|sell)\b/i;

// ---------- result helpers ----------
function rejected(note, label = "rejected_input") {
  return { deadEnd: true, boundary: false, invented: false, answerFirst: false, rejected: true, labels: [label], notes: [note] };
}
function str(v) { return typeof v === "string" ? v : ""; }
function cap(s) { return s.length > MAX_CHARS ? s.slice(0, MAX_CHARS) : s; }

function cleanForGrading(raw) {
  let t = raw;
  t = t.replace(/^[ \t]*-#.*$/gm, " ");
  t = t.replace(/\[([^\]\n]{0,200})\]\(<?https?:\/\/[^)>\s]{1,500}>?\)/g, "$1");
  t = t.replace(/https?:\/\/[^\s<>)\]]{1,500}/g, " ");
  t = t.replace(/\[[a-z0-9_-]{1,60}\/[a-z0-9_.~-]{1,120}\]/gi, " ");
  t = t.replace(/[*_`>#]+/g, "");
  t = t.replace(/([^\n.!?:}\]])\n(?!\n|[ \t]*[-*•]|[ \t]*\d+[.)][ \t])/g, "$1 ");
  return t;
}

function splitSentences(t) { return t.split(/(?<=[.!?}\]])\s+|\n+/).map((s) => s.trim()).filter(Boolean); }
function clausesOf(s) {
  const ranges = []; let last = 0; let m;
  CLAUSE.lastIndex = 0;
  while ((m = CLAUSE.exec(s))) { ranges.push([last, m.index, s.slice(last, m.index)]); last = m.index + m[0].length; if (m[0].length === 0) CLAUSE.lastIndex++; }
  ranges.push([last, s.length, s.slice(last)]);
  return ranges.filter((r) => r[2].trim());
}
const words = (s) => s.match(/[A-Za-z0-9']+/g) || [];
const matchAny = (list, s) => list.some((re) => re.test(s));
const stems = (s) => new Set(words(s.toLowerCase()).filter((w) => w.length >= 4 && !STOP_CONTENT.has(w)).map((w) => w.slice(0, 4)));

// ---------- specifics ----------
function maskSpan(text, a, b) { return text.slice(0, a) + " ".repeat(b - a) + text.slice(b); }

function extractDates(text) {
  const items = []; let t = text;
  const take = (re, fn) => { t = t.replace(re, (m, ...g) => { const idx = g[g.length - 2]; const it = fn(g); if (it) items.push({ ...it, pos: idx }); return " ".repeat(m.length); }); };
  take(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g, (g) => ({ y: +g[0], m: +g[1], d: +g[2] }));
  take(new RegExp(`\\b(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, "gi"), (g) => ({ m: monthNum(g[0]), d: +g[1], y: g[2] ? +g[2] : null }));
  take(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_RE})\\.?(?:,?\\s+(\\d{4}))?\\b`, "gi"), (g) => ({ m: monthNum(g[1]), d: +g[0], y: g[2] ? +g[2] : null }));
  take(/\b(January|February|March|April|June|July|August|September|October|November|December)\b/g, (g) => ({ m: monthNum(g[0]), d: null, y: null }));
  return { items, masked: t };
}
function extractClocks(text) {
  const items = []; let t = text;
  const to24 = (h, ap) => { h = +h; if (ap) { ap = ap.toLowerCase().replace(/\./g, ""); if (ap === "pm" && h < 12) h += 12; if (ap === "am" && h === 12) h = 0; } return h; };
  const key = (h, m) => `${String(h).padStart(2, "0")}:${m}`;
  t = t.replace(/\b(\d{1,2}):(\d{2})\s*(am|pm|a\.m\.|p\.m\.)?(?![\d])/gi, (m0, h, mi, ap, idx) => { items.push({ key: key(to24(h, ap), mi), pos: idx }); return " ".repeat(m0.length); });
  t = t.replace(/\b(\d{1,2})\s*(am|pm)\b/gi, (m0, h, ap, idx) => { items.push({ key: key(to24(h, ap), "00"), pos: idx }); return " ".repeat(m0.length); });
  return { items, masked: t };
}
const canonUnit = (w) => (w ? MEASURE.get(w.toLowerCase()) || null : null);
function extractNumbers(text) {
  const toks = []; const re = /\d[\d,]*(?:\.\d+)?%?|[A-Za-z]+/g; let m;
  while ((m = re.exec(text))) toks.push({ s: m[0], pos: m.index, end: m.index + m[0].length, num: /^\d/.test(m[0]) });
  const items = []; const gapOk = (a, b) => /^[\s-]*$/.test(text.slice(a.end, b.pos));
  let i = 0;
  while (i < toks.length) {
    const tk = toks[i];
    let value = null, start = i, last = i, pct = false;
    if (tk.num) {
      let s = tk.s; if (s.endsWith("%")) { pct = true; s = s.slice(0, -1); }
      value = parseFloat(s.replace(/,/g, "").replace(/,+$/, ""));
      const nx = toks[i + 1];
      if (nx && !nx.num && nx.s.toLowerCase() === "k" && nx.pos === tk.end) { value *= 1000; last = i + 1; }
      if (Number.isNaN(value)) { i++; continue; }
    } else {
      const lw = tk.s.toLowerCase();
      const peek = toks[i + 1] && toks[i + 1].s.toLowerCase();
      const startsRun = NUMWORD.has(lw) || ((lw === "a" || lw === "an") && ["hundred", "thousand", "million", "dozen"].includes(peek) && gapOk(tk, toks[i + 1]));
      if (!startsRun) { i++; continue; }
      let cur = 0, total = 0, j = i;
      const consume = (w) => {
        if (w === "a" || w === "an") return;
        if (UNITS[w] != null) cur += UNITS[w];
        else if (TENS[w] != null) cur += TENS[w];
        else if (w === "hundred") cur = (cur || 1) * 100;
        else if (w === "dozen") cur = (cur || 1) * 12;
        else if (w === "thousand" || w === "million") { total += (cur || 1) * (w === "thousand" ? 1000 : 1000000); cur = 0; }
      };
      consume(lw); last = i;
      while (toks[j + 1] && !toks[j + 1].num && gapOk(toks[j], toks[j + 1])) {
        const w = toks[j + 1].s.toLowerCase();
        if (NUMWORD.has(w) || (w === "and" && toks[j + 2] && NUMWORD.has(toks[j + 2].s.toLowerCase()))) { consume(w); j++; last = j; } else break;
      }
      value = total + cur;
      if (lw === "one" && last === i) { /* a lone "one" is usually a pronoun; the unit test below decides */ }
    }
    let unit = pct ? "percent" : null;
    const endTok = toks[last];
    if (!unit) {
      const p = toks[start - 1];
      if (p && !p.num && PREFIX_UNIT.has(p.s.toLowerCase()) && gapOk(p, toks[start])) unit = canonUnit(p.s);
    }
    if (!unit) {
      const n1 = toks[last + 1], n2 = toks[last + 2];
      if (n1 && !n1.num && gapOk(endTok, n1) && canonUnit(n1.s)) unit = canonUnit(n1.s);
      else if (n1 && n2 && !n1.num && !n2.num && gapOk(endTok, n1) && gapOk(n1, n2) && canonUnit(n2.s) && !STOP_CONTENT.has(n1.s.toLowerCase())) unit = canonUnit(n2.s);
    }
    if (!unit && start >= 2) {
      const c = toks[start - 1], pn = items[items.length - 1];
      if (c && /^(?:to|and|or|through)$/i.test(c.s) && pn && pn.endTok === start - 2) unit = pn.unit;
    }
    if (value != null && (value >= 6 || unit)) items.push({ v: value, unit, pos: toks[start].pos, endTok: last });
    i = last + 1;
  }
  return items;
}
function extractAll(text) {
  text = text.replace(/\b\d+(?:\.\d+)?\s*(?:\/|out of)\s*\d+\b/gi, (m) => " ".repeat(m.length));
  const d = extractDates(text); const c = extractClocks(d.masked); const n = extractNumbers(c.masked);
  return { dates: d.items, clocks: c.items, numbers: n };
}

function properNames(sentence, allowInitialSingle) {
  const out = [];
  const lead = sentence.match(/^[^A-Za-z]*/)[0].length;
  const re = /\b[A-Z][A-Za-z']*(?:(?:[ -]|\s(?:of|the|de|du)\s)[A-Z][A-Za-z']*){0,5}\b/g; let m;
  while ((m = re.exec(sentence))) {
    const pos = m.index;
    if (m[0].length > 1 && m[0] === m[0].toUpperCase()) continue;
    let ws = m[0].split(/[ -]/).filter(Boolean).map((w) => w.replace(/'s$/i, ""));
    const isStop = (w) => NAME_STOP.has(w.toLowerCase()) || ["of", "the", "de", "du"].includes(w.toLowerCase());
    const initial = pos === lead;
    if (initial && COMMON_START.has(ws[0].toLowerCase())) ws = ws.slice(1);
    while (ws.length && isStop(ws[0])) ws.shift();
    while (ws.length && isStop(ws[ws.length - 1])) ws.pop();
    if (!ws.length) continue;
    if (initial && ws.length === 1 && !allowInitialSingle) continue;
    out.push({ phrase: ws.join(" "), pos });
  }
  return out;
}
const hasWord = (hay, needle) => new RegExp(`(?<![a-z0-9])${needle.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "[ -]")}(?![a-z0-9])`).test(hay);

const dateKey = (d) => `${d.y ?? "_"}-${d.m}-${d.d ?? "_"}`;
function dateSupported(it, gDates) {
  if (it.d == null) return gDates.some((g) => g.m === it.m);
  return gDates.some((g) => g.m === it.m && g.d === it.d && (g.y == null || it.y == null || g.y === it.y));
}
function numSupported(it, gNums) {
  return gNums.some((g) => Math.abs(g.v - it.v) < 1e-9 && (it.unit == null || g.unit == null || g.unit === it.unit));
}

// ---------- the grader ----------
export function gradeAnswer(input) {
  const inp = input && typeof input === "object" ? input : {};
  let answerRaw = inp.answer;
  if (answerRaw === undefined || answerRaw === null) answerRaw = "";
  else if (typeof answerRaw === "number" || typeof answerRaw === "bigint") answerRaw = String(answerRaw);
  else if (typeof answerRaw !== "string") return rejected("answer is not text");
  if (answerRaw.length > MAX_CHARS) return rejected(`answer too long (over ${MAX_CHARS} characters)`, "too_long");

  const question = normalizeText(cap(str(inp.question)));
  const slice = str(inp.slice);
  const expect = typeof inp.expect === "string" ? inp.expect : undefined;
  let refText = "";
  const rf = inp.reference;
  if (typeof rf === "string") refText = rf; else if (rf && typeof rf === "object" && typeof rf.text === "string") refText = rf.text;
  let gatheredText = "";
  if (typeof inp.gathered === "string") gatheredText = inp.gathered;
  else if (Array.isArray(inp.gathered)) gatheredText = inp.gathered.filter((x) => typeof x === "string").join("\n");
  refText = normalizeText(cap(refText)); gatheredText = normalizeText(cap(gatheredText));

  const notes = []; const labels = [];
  const text = cleanForGrading(normalizeText(answerRaw));
  const sentences = splitSentences(text).map((s, si) => ({ s, si, clauses: clausesOf(s) }));

  // 1. type every clause. Instruction-shaped clauses are flagged, never deleted, and earn no credit.
  let flagged = 0, deflections = 0, declines = 0;
  const allowBoundary = expect === undefined || expect === "boundary";
  const otherText = [];
  const kinds = new Map();
  for (const sen of sentences) {
    const spans = injectionSpans(sen.s);
    const clauseInj = sen.clauses.map((c) => matchAny(INJECTION, c[2]) || spans.some((r) => r[0] < c[1] && r[1] > c[0]));
    const wholeInj = false;
    sen.types = sen.clauses.map((c, ci) => {
      const ct = c[2];
      let kind;
      if (clauseInj[ci] || wholeInj) kind = "inj";
      else if ((DECL_VERB.test(ct) && (DECL_OBJ.test(ct) || DECL_AS_NAME.test(ct) || DECL_GEN.test(ct))) || matchAny(DECL_OWN, ct)) kind = "decline";
      else if (matchAny(DEFLECT, ct)) kind = "deflect";
      else if (matchAny(FILLER, ct) && !/\d/.test(ct)) kind = "filler";
      else kind = "other";
      if (kind === "inj") flagged++; else if (kind === "decline") declines++; else if (kind === "deflect") deflections++;
      if (kind === "other") otherText.push(ct);
      return kind;
    });
    kinds.set(sen, sen.types);
  }
  if (flagged) { labels.push("injection_flagged"); notes.push(`${flagged} instruction-shaped clause(s) flagged; graded as text, given no credit`); }

  // 2. substance: independent of flagged, deflected, declined and filler clauses
  const rest = otherText.join(" ");
  const restWords = words(rest);
  const qStems = new Set([...stems(question), ...stems(refText)]);
  const overlap = [...stems(rest)].filter((x) => qStems.has(x)).length;
  const ex = rest ? extractAll(rest) : { dates: [], clocks: [], numbers: [] };
  const directive = otherText.some((c) => DIRECTIVE.test(c.trim()));
  const hasSubstance = ex.numbers.length > 0 || ex.dates.length > 0 || ex.clocks.length > 0 || directive || HELP_MARK.test(rest) || overlap >= 2 || (restWords.length >= 8 && overlap >= 1);
  const unexpectedDecline = declines > 0 && !allowBoundary;
  const deadEnd = !hasSubstance || unexpectedDecline;
  const boundary = declines > 0 && hasSubstance && allowBoundary;
  if (!hasSubstance) notes.push(declines && !deflections ? "bare refusal: declines and gives nothing else" : deflections ? "deflection with no substantive answer" : "no substantive content");
  if (unexpectedDecline) notes.push("declines on a case that does not expect a boundary");

  // 3. answer first
  let answerFirst = false;
  const firstS = sentences.find((x) => !x.types.every((k) => k === "inj"));
  if (firstS && !deadEnd) {
    const onlyJunk = firstS.types.every((k) => k === "inj" || k === "deflect" || k === "filler");
    const stockStrip = firstS.s.replace(/^(?:sure|certainly|of course|absolutely|well|so|honestly|hey|hi|ah|ok(?:ay)?)\b[,!. ]*/i, "");
    const stockOnly = stockStrip !== firstS.s;
    answerFirst = !onlyJunk && !/\?\s*$/.test(firstS.s) && !(stockOnly && words(stockStrip).length < 4);
    if (stockOnly && answerFirst) notes.push("stock opener before the answer");
  }

  // 4. invented specifics
  const hasGround = !!(refText || gatheredText);
  const falsePremise = slice === "false-premise";
  let invented = false;
  const qLow = question.toLowerCase();
  if (!hasGround && !falsePremise) {
    notes.push("no reference: invented not graded");
  } else {
    const groundText = refText + "\n" + gatheredText;
    const g = extractAll(groundText);
    const q = extractAll(question);
    const gLow = groundText.toLowerCase();
    const bad = [];
    for (let si = 0; si < sentences.length; si++) {
      const sen = sentences[si]; const s = sen.s;
      const maskKinds = (skip) => { let o = s; sen.clauses.forEach((cl, ci) => { if (skip.includes(sen.types[ci])) o = maskSpan(o, cl[0], cl[1]); }); return o; };
      const sNum = maskKinds(["deflect", "filler", "decline"]);
      const sName = maskKinds(["deflect", "filler", "decline"]);
      const e = extractAll(sNum);
      if (!e.dates.length && !e.clocks.length && !e.numbers.length && !/[A-Z]/.test(s)) continue;
      const spans = []; SOURCE_SPAN.lastIndex = 0; let sm;
      while ((sm = SOURCE_SPAN.exec(s))) spans.push([sm.index, sm.index + sm[0].length]);
      const inSpan = (p) => spans.some((r) => p >= r[0] && p < r[1]);
      const clauseAt = (p) => sen.clauses.find((c) => p >= c[0] && p <= c[1]) || sen.clauses[sen.clauses.length - 1];
      const sentUnconf = (j) => sentences[j] && UNCONF.test(sentences[j].s);
      const unconfNear = sentUnconf(si) || sentUnconf(si - 1) || sentUnconf(si + 1);
      const classicCovered = (p) => {
        const c = clauseAt(p); if (!c) return false;
        const cm = CLASSIC.exec(c[2]); if (!cm) return false;
        const after = c[2].slice(cm.index);
        return p >= c[0] + cm.index && !CLASSIC_DISQ.test(after.slice(0, (after.length))) && unconfNear;
      };
      const negClause = (p) => { const c = clauseAt(p); return !!c && NEG.test(c[2]); };
      const covered = (p) => inSpan(p) || classicCovered(p);
      for (const d of e.dates) {
        if (covered(d.pos)) continue;
        if (!dateSupported(d, g.dates)) { if (!falsePremise && dateSupported(d, q.dates) && d.d == null) continue; if (negClause(d.pos) && dateSupported(d, q.dates)) continue; bad.push(`date ${d.m}-${d.d ?? "?"}`); }
      }
      for (const c of e.clocks) {
        if (covered(c.pos)) continue;
        if (!g.clocks.some((x) => x.key === c.key)) bad.push(`time ${c.key}`);
      }
      for (const n of e.numbers) {
        if (covered(n.pos)) continue;
        if (numSupported(n, g.numbers)) continue;
        const inQ = numSupported(n, q.numbers);
        if (inQ && ((!falsePremise && (n.unit == null || q.numbers.some((x) => x.v === n.v && x.unit === n.unit))) || negClause(n.pos))) continue;
        bad.push(`number ${n.v}${n.unit ? " " + n.unit : ""}`);
      }
      for (const nm of properNames(sName, falsePremise)) {
        if (covered(nm.pos)) continue;
        const inGround = hasWord(gLow, nm.phrase);
        const inQuestion = hasWord(qLow, nm.phrase);
        if (falsePremise && inQuestion) { if (!negClause(nm.pos)) bad.push(`name ${nm.phrase}`); continue; }
        if (inGround || inQuestion) continue;
        bad.push(`name ${nm.phrase}`);
      }
    }
    if (falsePremise && !NEG.test(text) && !UNCONF.test(text) && /^\s*(?:yes|yeah|yep|correct|indeed|right|sure)\b/i.test(text)) bad.push("affirms the premise");
    if (bad.length) { invented = true; notes.push(`unsupported: ${[...new Set(bad)].join(", ")}`); }
  }

  // 5. labels
  if (deadEnd) labels.push("dead_end");
  if (boundary) labels.push("boundary");
  if (invented) labels.push("invented");
  if (answerFirst) labels.push("answer_first");
  if (UNCONF.test(text)) labels.push("unconfirmed");
  if (unexpectedDecline) labels.push("unexpected_decline");
  if (slice === "advice" && !deadEnd) {
    const f = sentences.find((x) => x.types.some((k) => k === "other"));
    if (!f || !PICK.test(f.s)) labels.push("no_pick");
  }
  if (!deadEnd && !invented && !boundary) labels.push("ok");
  return { deadEnd, boundary, invented, answerFirst, labels: [...new Set(labels)], notes };
}

export function classify(g) {
  if (g && g.rejected) return "rejected";
  if (g.invented) return "invented";
  if (g.deadEnd) return "dead_end";
  if (g.boundary) return "boundary";
  return "ok";
}

// ---------- CLI ----------
class CliError extends Error {}
function loadCases(dir) {
  let st;
  try { st = fs.statSync(dir); } catch { throw new CliError(`cases directory not found: ${dir}`); }
  if (!st.isDirectory()) throw new CliError(`cases path is not a directory: ${dir}`);
  const map = new Map();
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json") || /labelled|adversarial/.test(f)) continue;
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { throw new CliError(`unreadable case file: ${f}`); }
    for (const c of Array.isArray(j.cases) ? j.cases : []) if (c && typeof c.id === "string") map.set(c.id, c);
  }
  if (!map.size) throw new CliError(`no cases found in ${dir}`);
  return map;
}

export function runCli(argv, out = (s) => process.stdout.write(s), err = (s) => process.stderr.write(s)) {
  try {
    const args = argv.slice(2);
    const strict = args.includes("--tripwire") || args.includes("--gate"); // --gate is an alias kept for scripts
    const opt = (name) => { const i = args.indexOf(name); if (i < 0) return undefined; const v = args[i + 1]; if (v === undefined || v.startsWith("--")) throw new CliError(`${name} needs a value`); return v; };
    const casesOpt = opt("--cases");
    const countOpt = opt("--expect-count");
    const file = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--cases" && args[i - 1] !== "--expect-count");
    if (!file) throw new CliError("usage: node tools/grade-answers.mjs answers.jsonl [--cases dir] [--tripwire] [--expect-count N]");
    let expectCount = null;
    if (countOpt !== undefined) { if (!/^\d+$/.test(countOpt) || +countOpt < 1) throw new CliError(`--expect-count must be a positive integer, got "${countOpt}"`); expectCount = +countOpt; }
    let content;
    try { content = fs.readFileSync(file, "utf8"); } catch { throw new CliError(`cannot read answers file: ${file}`); }
    if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
    const rows = [];
    content.split(/\r?\n/).forEach((line, i) => {
      if (!line.trim()) return;
      let row;
      try { row = JSON.parse(line); } catch { throw new CliError(`line ${i + 1}: not valid JSON`); }
      if (!row || typeof row !== "object" || Array.isArray(row)) throw new CliError(`line ${i + 1}: not a JSON object`);
      rows.push(row);
    });
    if (!rows.length) throw new CliError("no answer rows in the file");
    const dir = casesOpt !== undefined ? casesOpt : path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "tests", "unit", "fixtures", "golden");
    const needCases = strict || casesOpt !== undefined || rows.some((r) => r.caseId !== undefined);
    const cases = needCases ? loadCases(dir) : new Map();
    if (strict && expectCount === null) expectCount = cases.size;
    if (expectCount !== null && rows.length !== expectCount) throw new CliError(`expected ${expectCount} rows, got ${rows.length}`);
    const sum = { total: 0, deadEnd: 0, boundary: 0, invented: 0, answerFirst: 0, ok: 0, mismatch: 0, rejected: 0, flagged: 0 };
    const lines = []; const seen = new Set();
    rows.forEach((row, i) => {
      const where = `row ${i + 1}${typeof row.id === "string" ? ` (${row.id})` : ""}`;
      let c = null;
      if (row.caseId !== undefined) { c = cases.get(row.caseId); if (!c) throw new CliError(`${where}: unknown caseId ${JSON.stringify(String(row.caseId)).slice(0, 40)}`); }
      else if (strict) throw new CliError(`${where}: --tripwire needs a caseId on every row`);
      if (strict) {
        if (typeof row.answer !== "string") throw new CliError(`${where}: answer must be a string`);
        if (seen.has(row.caseId)) throw new CliError(`${where}: caseId ${row.caseId} appears more than once`);
        seen.add(row.caseId);
      }
      // In strict mode only the case file supplies question, slice, reference and expect: a row cannot set its own bar.
      const src = strict ? {} : row;
      const g = gradeAnswer({ question: src.question ?? c?.question, slice: src.slice ?? c?.slice, reference: src.reference ?? c?.reference, gathered: src.gathered, expect: src.expect ?? c?.expect, answer: row.answer });
      const cls = classify(g); const exp = src.expect ?? c?.expect ?? null;
      const match = exp ? cls === exp : null;
      sum.total++; if (g.deadEnd) sum.deadEnd++; if (g.boundary) sum.boundary++; if (g.invented) sum.invented++; if (g.answerFirst) sum.answerFirst++; if (cls === "ok") sum.ok++; if (g.rejected) sum.rejected++; if (match === false) sum.mismatch++; if (g.labels.includes("injection_flagged")) sum.flagged++;
      lines.push(JSON.stringify({ id: row.id, caseId: row.caseId, class: cls, expect: exp, match, ...g }));
    });
    if (strict && seen.size !== cases.size) throw new CliError(`${cases.size - seen.size} case(s) have no answer row`);
    const fail = strict && (sum.deadEnd > 0 || sum.invented > 0 || sum.mismatch > 0 || sum.rejected > 0 || sum.flagged > 0);
    lines.push(JSON.stringify({ summary: true, tripwire: true, ...sum, note: "Rule-based tripwire: a pass means no rule fired, not that the answers are right. The real gate is second-family grading plus answers read by hand." }));
    out(lines.join("\n") + "\n");
    return fail ? 1 : 0;
  } catch (e) {
    err(`grade-answers: error: ${e instanceof CliError ? e.message : "unexpected failure"}\n`);
    return 1;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = runCli(process.argv);
