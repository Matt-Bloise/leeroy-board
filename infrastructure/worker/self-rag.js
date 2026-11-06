// Self-RAG-lite for /ask (ops-wiki karpathy-wiki.md, "Self-RAG"). The published method trains a model to emit reflection tokens; ours are not trained
// with them, so the same four judgments are made by deterministic code. Pure: no I/O, no clock, no model call, so the hot path keeps its Free-plan budget.
//   Retrieve? needsRetrieval(question)       greetings, thanks and pure "my build" questions skip the library; every other question retrieves.
//   IsRel    selectRelevant(...)             a coverage floor on the retrieved facts; below it a fact is dropped, and when no fact is left the answer abstains.
//   Abstain  ABSTAIN_RULE / ABSTAIN_LINE     say plainly that the Library does not cover it and what would settle it; nothing invented.
//   IsSup    supportCheck(answer, ...)       every cited source id was retrieved; a number the answer states appears in the retrieved text, the build, the
//                                            party state or the question, else the sentence goes (names are checked by ask-build.js groundedOrNotPublished).
import { expandWords, idfFor, factHay } from "./rank-core.js";
import { parseSourceIds } from "./answer-format.js";

export const ABSTAIN_LINE = "The Library does not cover that yet, so I won't guess. An official Blizzard post, or someone in the party who has played it, would settle it.";

// ---- Retrieve? ------------------------------------------------------------------------------------------------------------
const GREETING = /^\s*(?:hi|hello|hey|yo|sup|howdy|hiya|good\s+(?:morning|evening|afternoon|night)|thanks?(?:\s+you)?|thx|ty|cheers|ok(?:ay)?|cool|nice|great|awesome|lol|test(?:ing)?|ping|gm|gn)(?:\s+(?:there|leeroy|jenkins|everyone|all|again|so\s+much|a\s+lot|mate|friend|bot))*\s*[!.?~]*\s*$/i;
const BUILD_ONLY = /^\s*(?:what(?:'s|\s+is)|show(?:\s+me)?|tell\s+me\s+about|how(?:'s|\s+is)|describe|summari[sz]e|remind\s+me\s+of)\s+(?:my|our)\s+(?:build|sheet|character|char|spec|gear|talents?|setup|loadout|level|professions?)\s*[!.?]*\s*$/i;
const WHO_AM_I = /^\s*(?:who\s+am\s+i|what\s+am\s+i\s+playing|what\s+do\s+i\s+play)\s*[!.?]*\s*$/i;

// false = do not search the Library for this message. Anything that is not clearly a greeting or a pure "my build" question retrieves.
export function needsRetrieval(question) {
  const q = String(question || "");
  return !(GREETING.test(q) || BUILD_ONLY.test(q) || WHO_AM_I.test(q));
}

// ---- IsRel ----------------------------------------------------------------------------------------------------------------
// Coverage of a fact = the idf mass of the question's content words that the fact's text contains, over the idf mass of all of them. A word the
// Library never uses is worth the most (its idf is highest) and is matched by nothing, so a question about something the Library lacks scores low
// however many generic words it shares. Calibrated on 30 held-out questions the ask-eval judge labelled "library lacks": the three lowest-coverage
// questions were exactly three of the six labelled lacking, and no answerable question scored below 0.27.
export const ABSTAIN_BELOW = 0.2; // best coverage among the top facts under this: nothing relevant, abstain
export const FACT_FLOOR = 0.12; // a fact must cover at least this much of the question ...
export const FACT_REL_BEST = 0.4; // ... and at least this share of the best fact's coverage
export const REL_WINDOW = 40; // facts examined (the ranker already ordered them)

// hits: the ranker's hits ({ score, page, key, value, open, f }); words: its question words; hays: factHays(pages) for the idf corpus.
export function selectRelevant(hits, words, hays) {
  const list = Array.isArray(hits) ? hits : [];
  const ws = Array.isArray(words) ? words : [];
  if (!list.length || !ws.length) return { hits: [], abstain: true, best: 0, kept: 0, dropped: list.length };
  const idf = idfFor(expandWords(ws), hays, null);
  const total = ws.reduce((n, w) => n + (idf[w] || 0), 0) || 1;
  const covered = (h) => {
    const hay = h.f ? factHay(h.f) : String(h.value || "").toLowerCase();
    let m = 0;
    for (const w of ws) if (hay.includes(w)) m += idf[w] || 0;
    return m / total;
  };
  const scored = list.slice(0, REL_WINDOW).map((h) => ({ h, c: covered(h) }));
  const best = scored.reduce((b, x) => Math.max(b, x.c), 0);
  if (best < ABSTAIN_BELOW) return { hits: [], abstain: true, best, kept: 0, dropped: list.length };
  const floor = Math.max(FACT_FLOOR, FACT_REL_BEST * best);
  const kept = scored.filter((x) => x.c >= floor).map((x) => x.h);
  return { hits: kept, abstain: kept.length === 0, best, kept: kept.length, dropped: list.length - kept.length };
}

// ---- prompt text ----------------------------------------------------------------------------------------------------------
export const ABSTAIN_RULE =
  "The library has nothing on this question. Say so plainly in one short sentence, name what would settle it (an official Blizzard post, or a party member who has played it), and state no game fact, number, name or date. You may still use the asker's build and the party state.";
export const SKIP_RULE = "This message needs no library lookup. Answer it in voice, and state no game fact, number, name or date.";

// ---- IsSup ----------------------------------------------------------------------------------------------------------------
// The retrieved page ids and the abstain flag reach finishAnswerText as a structured argument (`retrieval`). For callers that only have groundingText
// (the offline ask-eval), the same data rides as ONE marker on the very last line. The marker is trusted only there: text a person controls (the question,
// the asker's name) can never be the last line, and any marker-looking text inside it is defanged before the real one is appended.
export const RETRIEVED_MARK = "[[retrieved:";
const defang = (t) => String(t || "").split(RETRIEVED_MARK).join("[ [retrieved:");
export const groundingWithIds = (text, ids, abstain = false) => [defang(text), `${RETRIEVED_MARK} ${[...ids].join(" ")}${abstain ? " | abstain" : ""}]]`].join("\n");
export function retrievedFromGrounding(groundingText) {
  const m = /\n\[\[retrieved:([^\]]*)\]\]$/.exec(String(groundingText || ""));
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
// Ids on one Sources line in any mix of plain ids, [bracketed] ids and Markdown links to library pages. The formatter's parser reads either links or
// plain ids, never both; a mixed line would lose its plain ids, so the two halves are read separately here.
const LINK_ANY = /\[[^\]\n]*\]\(<?[^)>\s]*>?\)/g;
export function sourceIdsOf(rest) {
  const text = String(rest || "");
  const linked = parseSourceIds(text.match(LINK_ANY) ? text.match(LINK_ANY).join(" ") : "");
  return [...new Set([...parseSourceIds(text.replace(LINK_ANY, " ")), ...linked])];
}
// Remove cited ids that were not retrieved. A Sources line is read with the formatter's own parser (plain ids, bracketed ids, Markdown links to library
// pages, mixed), rewritten as plain ids that were retrieved, and dropped when none is left: anything the parser does not recognise is not kept, so a
// mixed-format line cannot smuggle an id past the filter. Inline [id~key] cites and Markdown links to an unretrieved library page are removed too
// (the link keeps its label).
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

// A number the answer states: 6 or more, or any decimal or percentage. 0 to 5 are counting words ("two options") and are not checked.
const NUM = /(?<![\w.])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(%?)/g;
const numbersOf = (sentence) => {
  const out = [];
  for (const m of String(sentence).matchAll(NUM)) {
    const whole = m[1].replace(/,/g, "");
    const decimal = m[2] !== undefined;
    if (!decimal && !m[3] && Number(whole) <= 5) continue;
    out.push(`${whole}${decimal ? "." + m[2] : ""}`);
  }
  return out;
};
const numberSet = (text) => {
  const set = new Set();
  for (const m of String(text).matchAll(/(?<![\w.])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?/g)) set.add(`${m[1].replace(/,/g, "")}${m[2] !== undefined ? "." + m[2] : ""}`);
  return set;
};

// Drop each sentence or bullet that states a number found nowhere in `allowedText` (retrieved facts and pages, the asker's build, the party state, the
// question). The headline, the Sources line and every other sentence stay. Fewer than 4 substantive words left = the abstain line.
export function supportCheck(answer, allowedText) {
  const text = String(answer || "");
  const cut = text.search(/\n-#\s*Sources?:/i);
  const body = cut >= 0 ? text.slice(0, cut) : text;
  const tail = cut >= 0 ? text.slice(cut) : "";
  const allowed = numberSet(String(allowedText || "").replace(/\[\[retrieved:[^\]]*\]\]/g, " "));
  const unsupported = [];
  const kept = [];
  for (const line of body.split("\n")) {
    const parts = line.split(/(?<=[.!?])\s+/);
    const ok = parts.filter((sent) => {
      const bad = numbersOf(sent).filter((n) => !allowed.has(n));
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
  if (substantive < 4) return { ok: false, unsupported, answer: ABSTAIN_LINE };
  return { ok: false, unsupported, answer: `${left}${tail}` };
}

