// Self-RAG-lite for /ask (ops-wiki karpathy-wiki.md, "Self-RAG"). The published method trains a model to emit reflection tokens; ours are not trained
// with them, so the same four judgments are made by deterministic code. Pure: no I/O, no clock, no model call, so the hot path keeps its Free-plan budget.
//   Retrieve? skipKind(question)             greetings, thanks and pure "my build" questions skip the library; every other question retrieves.
//   IsRel    cleanQuestion, selectRelevant   party names, the asker's name and chat filler are taken out of the question before ranking; a coverage floor and an
//                                            absent-words rule then drop weak facts, and when none is left the answer abstains.
//   Abstain  ABSTAIN_RULE / ABSTAIN_LINE     say plainly that the Library does not cover it and what would settle it; nothing invented.
//   IsSup    stripUnretrievedCites, supportCheck   every cited source id was retrieved; a number the answer states appears (in any common spelling) in the
//                                            retrieved text, the build, the party state or the question, else that sentence goes. Names: ask-build.js.
// Trade-off, stated plainly: this trades some recall for fewer invented facts. A real question can abstain (see the calibration notes below and
// docs/answer-claims.md), and a true number the Library never gave is removed.
import { expandWords, idfFor, factHay, stem } from "./rank-core.js";
import { parseSourceIds } from "./answer-format.js";

export const ABSTAIN_LINE = "The Library does not cover that yet, so I won't guess. An official Blizzard post, or someone in the party who has played it, would settle it.";
export const NUMBER_UNCONFIRMED_LINE = "The Library doesn't confirm that figure, so I won't state it.";

// ---- Retrieve? ------------------------------------------------------------------------------------------------------------
const GREETING = /^\s*(?:hi|hello|hey|yo|sup|howdy|hiya|good\s+(?:morning|evening|afternoon|night)|thanks?(?:\s+you)?|thx|ty|cheers|ok(?:ay)?|cool|nice|great|awesome|lol|test(?:ing)?|ping|gm|gn)(?:\s+(?:there|leeroy|jenkins|everyone|all|again|so\s+much|a\s+lot|mate|friend|bot))*\s*[!.?~]*\s*$/i;
const BUILD_ONLY = /^\s*(?:what(?:'s|\s+is)|show(?:\s+me)?|tell\s+me\s+about|how(?:'s|\s+is)|describe|summari[sz]e|remind\s+me\s+of)\s+(?:my|our)\s+(?:build|sheet|character|char|spec|gear|talents?|setup|loadout|level|professions?)\s*[!.?]*\s*$/i;
const WHO_AM_I = /^\s*(?:who\s+am\s+i|what\s+am\s+i\s+playing|what\s+do\s+i\s+play)\s*[!.?]*\s*$/i;

// "greeting" = chat with no content; "build" = a question about the asker's own sheet; null = search the Library.
export function skipKind(question) {
  const q = String(question || "");
  if (GREETING.test(q)) return "greeting";
  if (BUILD_ONLY.test(q) || WHO_AM_I.test(q)) return "build";
  return null;
}
// false = do not search the Library for this message. Anything that is not clearly a greeting or a pure "my build" question retrieves.
export const needsRetrieval = (question) => skipKind(question) === null;

// ---- IsRel ----------------------------------------------------------------------------------------------------------------
// Chat filler and names are not topics. They used to be scored like topics: a word the Library never uses has the highest idf, so "bro ... nah lol" or a
// party member's name dragged the coverage of a perfectly answerable question down (audit: "bro can Bible Boi tank onyxia or nah lol" abstained).
const FILLER = ("bro bruh dude dudes man mate fam yo hey hi hello sup lol lmao lmfao rofl haha hehe nah nope yep yeah yea ya yup ok okay pls plz please thx thanks thank ty " +
  "tbh imo idk imho btw fyi omg wtf asking asked wanna gonna gotta kinda sorta whatever anyways anyway basically literally honestly guys folks anyone someone everyone " +
  "friend buddy pal u ur r k kk lemme gimme sooo soo so ok ya yall y'all").split(/\s+/);
const FILLER_SET = new Set(FILLER.map((w) => w.toLowerCase()));
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A display name is not always a name: a Discord user called "Rogue" or "Hunter" asking about the rogue or the hunter class is asking about the Library. The
// asker's own name is therefore taken out of the question only when none of its words occurs in the Library text; party member names always are.
export function askerNameToStrip(by, hays) {
  const tokens = String(by || "").toLowerCase().match(/[a-z0-9']{3,}/g) || [];
  const inLibrary = tokens.some((t) => (Array.isArray(hays) ? hays : []).some((h) => h.includes(stem(t))));
  return inLibrary ? "" : String(by || "");
}
// The question with party names (and the asker's own name), chat filler and "lvl" tidied away, for ranking and coverage only. The prompt still carries the
// question exactly as asked.
export function cleanQuestion(question, names = []) {
  let q = String(question || "");
  const list = [...new Set((Array.isArray(names) ? names : []).map((n) => String(n || "").trim().toLowerCase()).filter((n) => n.length >= 3))].sort((a, b) => b.length - a.length);
  for (const n of list) q = q.replace(new RegExp(`(?<![A-Za-z0-9])${escapeRe(n)}(?![A-Za-z0-9])`, "gi"), " ");
  q = q.replace(/\blvls?\b/gi, "level");
  return q.split(/(\s+)/).map((t) => (FILLER_SET.has(t.toLowerCase().replace(/[^a-z0-9']/g, "")) ? " " : t)).join("").replace(/\s+/g, " ").trim();
}

// Coverage of a fact = the idf mass of the question's content words that the fact's text (key and value) contains, over the idf mass of all of them.
// Words the Library never uses count at a capped idf, and two or more of them abstain outright (a question about pizza, a laptop driver or a football cup is
// not about the Library whatever else it shares). Calibration, in docs/answer-claims.md claim 36: 15 fictional messy in-scope questions (none may abstain)
// and 10 out-of-scope ones; the gold-set labels used earlier were a model's and did not separate the two well enough to rely on.
export const ABSTAIN_BELOW = 0.2; // best coverage among the top facts under this: nothing relevant, abstain
export const ABSENT_MAX = 2; // content words the Library never uses: this many or more abstain (one is enough for a question of two content words)
export const ABSENT_IDF_CAP = 3; // an absent word weighs no more than this in the coverage denominator
export const FACT_FLOOR = 0.12; // a fact must cover at least this much of the question ...
export const FACT_REL_BEST = 0.4; // ... and at least this share of the best fact's coverage
export const REL_WINDOW = 40; // facts examined (the ranker already ordered them)

// hits: the ranker's hits ({ score, page, key, value, open, f }); words: its question words (already cleaned); hays: factHays(pages) for the idf corpus.
export function selectRelevant(hits, words, hays) {
  const list = Array.isArray(hits) ? hits : [];
  const ws = Array.isArray(words) ? words : [];
  const none = (extra = {}) => ({ hits: [], abstain: true, best: 0, kept: 0, dropped: list.length, absent: 0, ...extra });
  if (!list.length || !ws.length) return none();
  const absent = ws.filter((w) => !hays.some((h) => h.includes(w)));
  // two or more absent words, or a very short question (one or two content words) with one: the Library is not what this question is about
  if (absent.length >= ABSENT_MAX || (absent.length >= 1 && ws.length <= 2)) return none({ absent: absent.length });
  const idf = idfFor(expandWords(ws), hays, null);
  for (const w of absent) idf[w] = Math.min(idf[w] || 0, ABSENT_IDF_CAP);
  const total = ws.reduce((n, w) => n + (idf[w] || 0), 0) || 1;
  const covered = (h) => {
    const hay = h.f ? factHay(h.f) : String(h.value || "").toLowerCase();
    let m = 0;
    for (const w of ws) if (hay.includes(w)) m += idf[w] || 0;
    return m / total;
  };
  const scored = list.slice(0, REL_WINDOW).map((h) => ({ h, c: covered(h) }));
  const best = scored.reduce((b, x) => Math.max(b, x.c), 0);
  if (best < ABSTAIN_BELOW) return none({ best, absent: absent.length });
  const floor = Math.max(FACT_FLOOR, FACT_REL_BEST * best);
  const kept = scored.filter((x) => x.c >= floor).map((x) => x.h);
  return { hits: kept, abstain: kept.length === 0, best, kept: kept.length, dropped: list.length - kept.length, absent: absent.length };
}

// ---- prompt text ----------------------------------------------------------------------------------------------------------
export const ABSTAIN_RULE =
  "The library has nothing on this question. Say so plainly in one short sentence, name what would settle it (an official Blizzard post, or a party member who has played it), and state no game fact, number, name or date. You may still use the asker's build and the party state.";
// A greeting needs no facts; a question about the asker's own sheet is answered from YOUR_BUILD, which is the one place its class, level and spec may come from.
export const SKIP_RULE = "This message needs no library lookup. Answer it in voice, and state no game fact, number, name or date.";
export const BUILD_RULE = "This is a question about the asker's own build. Answer it from YOUR_BUILD only: you may state exactly what it lists (class, race, spec, level, professions, goals, sign-up). Add no other game fact, number, name or date.";

// ---- IsSup ----------------------------------------------------------------------------------------------------------------
// The retrieved page ids and the abstain flag reach finishAnswerText as a structured argument (`retrieval`). For callers that only have groundingText
// (the offline ask-eval in leeroy-ops passes groundingText, so it gets these checks; the admin model bake-off, eval.js, passes neither and does not run them:
// it compares raw model behaviour with the lint), the same data rides as ONE marker on the very last line. The marker is trusted only there: text a person controls (the question,
// the asker's name) can never be the last line, and any marker-looking text inside it is defanged before the real one is appended.
export const RETRIEVED_MARK = "[[retrieved:";
const defang = (t) => String(t || "").split(RETRIEVED_MARK).join("[ [retrieved:");
export const groundingWithIds = (text, ids, abstain = false) => [defang(text), `${RETRIEVED_MARK} ${[...ids].join(" ")}${abstain ? " | abstain" : ""}]]`].join("\n");
export function retrievedFromGrounding(groundingText) {
  const m = /\n\[\[retrieved:([^\][]*)\]\]$/.exec(String(groundingText || ""));
  if (!m) return null; // an older caller without the marker: no citation filter, as before
  const [list, flag] = m[1].split("|");
  return { ids: new Set(list.split(/\s+/).filter(Boolean)), abstain: /abstain/.test(flag || "") };
}
// The structured form wins; the marker is only the fallback.
export function retrievalOf({ retrieval, groundingText } = {}) {
  if (retrieval && typeof retrieval === "object") return { ids: new Set(retrieval.ids || []), abstain: Boolean(retrieval.abstain) };
  return retrievedFromGrounding(groundingText);
}

const SOURCES_LINE = /^(\s*(?:-#\s*)?)Sources?\s*:\s*(.*)$/gim;
const LIB_LINK = /\[([^\]\n]*)\]\(<?([^)>\s]*#library\.([a-z0-9_-]+)\.([a-z0-9_.-]+))>?\)/gi;
// Ids on one Sources line in any mix of plain ids ("a/b, c/d", "a/b and c/d"), [bracketed] ids and Markdown links to library pages. The formatter's parser
// reads either links or plain ids, never both; a mixed line would lose its plain ids, so the two halves are read separately here.
const LINK_ANY = /\[[^\]\n]*\]\(<?[^)>\s]*>?\)/g;
export function sourceIdsOf(rest) {
  const text = String(rest || "");
  const linked = parseSourceIds(text.match(LINK_ANY) ? text.match(LINK_ANY).join(" ") : "");
  return [...new Set([...parseSourceIds(text.replace(LINK_ANY, " ")), ...linked])];
}
// Remove cited ids that were not retrieved. A Sources line is read with the formatter's own parser, rewritten as plain ids that were retrieved, and dropped
// when none is left: anything the parser does not recognise is not kept, so a mixed-format line cannot smuggle an id past the filter. Inline [id~key] cites and
// Markdown links to an unretrieved library page are removed too (the link keeps its label). A library id written bare in prose is not a citation and stays.
export function stripUnretrievedCites(answer, retrieved) {
  if (!retrieved) return { answer, removed: [] };
  const removed = [];
  const keep = (id) => retrieved.has(id) || (removed.push(id), false);
  let out = String(answer || "").replace(SOURCES_LINE, (line, head, rest) => {
    const kept = sourceIdsOf(rest).filter(keep);
    return kept.length ? `${head}Sources: ${kept.join(", ")}` : "";
  });
  out = out.replace(/\[([a-z0-9_-]+\/[a-z0-9_.-]+)(?:~[^\]]+)?\](?!\()/gi, (m, id) => (keep(id) ? m : ""));
  out = out.replace(LIB_LINK, (m, label, href, cat, slug) => (keep(`${cat}/${slug}`) ? m : label));
  return { answer: out.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+\n/g, "\n").trim(), removed };
}

// ---- numbers ----------------------------------------------------------------------------------------------------------------
// One tokenizer reads numbers in the answer AND in the grounding text: digits (with thousands commas, decimals, % and k/m suffixes) and number words
// ("sixty", "twenty-five", "two hundred"). A token is "checked" when its value is 6 or more, or it is a decimal or a percentage; 0 to 5 are counting words
// ("two options"). A checked token is supported when the grounding text has the same VALUE: in any spelling (digits or words, leading zeros, "10k" and
// "10,000"), as a date part ("2026-12-09" supports "December 9" and "the 9th"), or inside a range ("5 to 7 hours" and "about 6 hours" support each other).
// Clock equivalents (8 PM is 20:00) are added only from a recognised clock expression in the grounding text (h:mm, am/pm, o'clock), never from a bare
// number: "8 gold" does not authorise "20 gold", and "level 20" does not authorise "level 8". Known blind spots: "a dozen", fractions, "a couple", and a wrong
// number that happens to equal another number in the grounding text. "ten minutes" and the like are checked too: a spelled-out number of 6 or more that the
// shown text never gave is removed with its sentence.
const UNIT_WORDS = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split(" ");
const TENS_WORDS = { twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const UNIT_VALUE = Object.fromEntries(UNIT_WORDS.map((w, i) => [w, i]));
const NUMWORD = [...UNIT_WORDS, ...Object.keys(TENS_WORDS), "hundred", "thousand"].sort((x, y) => y.length - x.length).join("|");
// A run of number words ("two hundred and fifty", "twenty-five", "hundred"); parsed left to right by wordRunTokens, which splits a run that is really two numbers.
const WORD_RUN_RE = new RegExp(`(?<![A-Za-z0-9])(?:${NUMWORD})(?:[-\\s]+(?:and\\s+)?(?:${NUMWORD}))*(?![A-Za-z0-9])`, "gi");
const NUM_RE = /(?<![\w.])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?:\s?(k|m)(?![A-Za-z0-9]))?(%)?/gi;
const RANGE_RE = /(?<![\w.])(\d+)\s*(?:to|-|–|—)\s*(\d+)(?![\d.])/gi;
const canon = (v) => String(Math.round(v * 1e6) / 1e6);

// Parse one run of number words into tokens. Standard reading: units and tens add up, "hundred" multiplies what came before (or stands for 100 alone, as in
// "a hundred"), "thousand" closes a group. A word that cannot continue the number starts a new one ("five six" is 5 and 6, "twenty five" is 25).
function wordRunTokens(text, offset) {
  const words = [...text.matchAll(/[A-Za-z]+/g)].filter((w) => w[0].toLowerCase() !== "and");
  const tokens = [];
  let total = 0, current = 0, last = "none", start = null, end = null;
  const flush = () => {
    if (start !== null) tokens.push({ value: total + current, start: offset + start, end: offset + end, decimal: false, percent: false });
    total = 0; current = 0; last = "none"; start = null; end = null;
  };
  for (const w of words) {
    const word = w[0].toLowerCase();
    const isTens = Object.prototype.hasOwnProperty.call(TENS_WORDS, word);
    const isUnit = Object.prototype.hasOwnProperty.call(UNIT_VALUE, word);
    const v = isTens ? TENS_WORDS[word] : isUnit ? UNIT_VALUE[word] : 0;
    const open = last === "none" || last === "hundred" || last === "thousand";
    let ok;
    if (isUnit) ok = open || (last === "tens" && v >= 1 && v <= 9);
    else if (isTens) ok = open;
    else if (word === "hundred") ok = last === "none" || last === "unit" || last === "tens";
    else ok = last !== "none"; // thousand
    if (!ok) flush();
    if (start === null) start = w.index;
    end = w.index + w[0].length;
    if (isUnit) { current += v; last = "unit"; }
    else if (isTens) { current += v; last = "tens"; }
    else if (word === "hundred") { current = (current || 1) * 100; last = "hundred"; }
    else { total += (current || 1) * 1000; current = 0; last = "thousand"; }
  }
  flush();
  return tokens;
}

// [{ value, start, end, decimal, percent }] for the digits and the number words in `text`.
function numberTokens(text) {
  const s = String(text || "");
  const out = [];
  for (const m of s.matchAll(NUM_RE)) {
    let v = parseFloat(`${m[1].replace(/,/g, "")}${m[2] !== undefined ? "." + m[2] : ""}`);
    if (m[3]) v *= m[3].toLowerCase() === "k" ? 1e3 : 1e6;
    out.push({ value: v, start: m.index, end: m.index + m[0].length, decimal: m[2] !== undefined, percent: Boolean(m[4]) });
  }
  for (const run of s.matchAll(WORD_RUN_RE)) out.push(...wordRunTokens(run[0], run.index));
  return out;
}

// Clock expressions only: "8pm", "8 PM", "8:30", "20:00", "8 o'clock". The 12-hour and 24-hour readings of the hour are both allowed.
const CLOCK_RE = /(?<![\w.:])(\d{1,2}):(\d{2})(?![\d:])|(?<![\w.:])(\d{1,2})\s?(a\.?m\.?|p\.?m\.?)(?![A-Za-z])|(?<![\w.:])(\d{1,2})\s?o['’]?clock/gi;
function clockHours(text) {
  const hours = new Set();
  for (const m of String(text || "").matchAll(CLOCK_RE)) {
    const h = Number(m[1] ?? m[3] ?? m[5]);
    if (!Number.isInteger(h) || h < 0 || h > 23) continue;
    hours.add(h);
    if (h >= 1 && h <= 12) hours.add(h + 12);
    if (h >= 13) hours.add(h - 12);
  }
  return hours;
}

function allowedValues(text) {
  const src = String(text || "").replace(/\[\[retrieved:[^\]]*\]\]/g, " ");
  const set = new Set();
  for (const t of numberTokens(src)) set.add(canon(t.value));
  for (const h of clockHours(src)) set.add(canon(h));
  for (const m of src.matchAll(RANGE_RE)) {
    const a = Number(m[1]), b = Number(m[2]);
    if (b > a && b - a <= 400) for (let n = a; n <= b; n++) set.add(canon(n));
  }
  return set;
}

// The unsupported checked numbers of one sentence, as display strings.
function unsupportedIn(sentence, allowed) {
  const bad = [];
  const consumed = [];
  for (const r of sentence.matchAll(RANGE_RE)) {
    const a = Number(r[1]), b = Number(r[2]);
    if (b <= a || b - a > 400) continue; // not a range ("2026-12-09" is a date: its parts are checked one by one below)
    consumed.push([r.index, r.index + r[0].length]);
    let ok = false;
    for (let n = a; n <= b && !ok; n++) ok = allowed.has(canon(n));
    if (!ok && (a > 5 || b > 5)) bad.push(r[0]);
  }
  for (const t of numberTokens(sentence)) {
    if (consumed.some(([s, e]) => t.start >= s && t.start < e)) continue;
    const checked = t.value > 5 || t.decimal || t.percent;
    if (checked && !allowed.has(canon(t.value))) bad.push(sentence.slice(t.start, t.end).trim());
  }
  return bad;
}

// Drop each sentence or bullet that states a number found nowhere in `allowedText` (retrieved facts and pages as shown, the asker's build, the party state,
// the question). The headline, the Sources line and every other sentence stay. A number mismatch alone never turns the whole answer into the abstain line:
// if almost nothing substantive is left, the answer says the Library does not confirm the figure.
export function supportCheck(answer, allowedText) {
  const text = String(answer || "");
  const cut = text.search(/\n-#\s*Sources?:/i);
  const body = cut >= 0 ? text.slice(0, cut) : text;
  const tail = cut >= 0 ? text.slice(cut) : "";
  const allowed = allowedValues(allowedText);
  const unsupported = [];
  const kept = [];
  for (const line of body.split("\n")) {
    const parts = line.split(/(?<=[.!?])\s+/);
    const ok = parts.filter((sent) => {
      const bad = unsupportedIn(sent, allowed);
      unsupported.push(...bad);
      return bad.length === 0;
    });
    if (ok.length === parts.length) kept.push(line);
    else if (ok.length) {
      const joined = ok.join(" ");
      kept.push((joined.match(/\*\*/g) || []).length % 2 ? joined.replace(/\*\*/g, "") : joined);
    }
  }
  if (!unsupported.length) return { ok: true, unsupported: [], answer: text };
  const left = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const substantive = left.replace(/[^A-Za-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 2).length;
  if (substantive < 4) return { ok: false, unsupported, answer: `${NUMBER_UNCONFIRMED_LINE}${tail}` };
  return { ok: false, unsupported, answer: `${left}${tail}` };
}

