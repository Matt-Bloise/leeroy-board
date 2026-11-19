// NORMALISED scorer for the replay harness: a SECOND, separate reading of the same answers. score.mjs (the STRICT scorer) is not changed and stays the verdict of record.
// Why it exists: the strict scorer counts the model's bracketed row ids ([spelllevels:98572]) as numbers, cannot read "82 800" (thin-space groups), a composite duration ("1 hour 30 minutes"), and counts a neighbouring
// supported figure as "unsupported". This file only changes HOW A NUMBER IS WRITTEN, never WHICH number is accepted. tools/replay/rescore.mjs prints strict and normalised side by side and lists every flip with the matched text.
//
// What is normalised (and nothing else):
//   - bracketed row ids [table:id] are removed before reading (they are citations, not figures)
//   - markdown wrappers (** * ` ~) are removed; dash variants become "-"; no-break and thin spaces become spaces
//   - thousands groups: "82,800" (the strict scorer already reads it) and thin-space / no-break-space groups of exactly three digits ("82 800" with U+2009, U+202F or U+00A0). A plain space or a dot is NEVER a thousands separator ("82.800" stays 82.8, "82 800" stays two numbers): ambiguous, so refused.
//   - hyphenated units ("15-second", "level-18"), unit words (seconds/sec/s, minutes, hours, ms) are the strict scorer's own unit reader (score.mjs unitOf), applied to the cleaned text
//   - composite durations: "1 hour 30 minutes" = 5400 seconds, "1 minute 30 seconds" = 90 (hours+minutes[+seconds] or minutes+seconds, words only)
// What is REFUSED on purpose (each is a different statement, never a way of writing the expected number):
//   - a range ("level 18-20", "18 to 20", "between 18 and 20", "18 or 20") never states the number
//   - a number that is only in the QUESTION (echo): it cannot match as a bare number; "Rank N" is never a level, cooldown or mana figure
//   - the match sits in a sentence about ANOTHER RANK (the question names Rank 4, the sentence says Rank 3 or cites a row of rank 3) or ANOTHER ENTITY (the sentence cites a row of a different subject, or, with --tables, names a different
//     known subject and not the asked one)
//   - the wrong unit ("18 mana" for a level question; "4 minutes" for 14400 seconds: 240 is not 14400), negation, and the strict scorer's contradiction rule (a DIFFERENT number in the question's unit, per clause) are all unchanged
//   - a degraded response is never exact
//
// UNSUPPORTED has ONE meaning here: a figure in the answer that no supplied row and no library fact holds. See unsupportedFigures.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { extractNumbers, unitTokens, unitOf, negatedAt, isNumeric, unitForExpected, near, tail, exact_match, contradiction as strictContradiction, degraded, summarize } from "./score.mjs";
import { evaluateBar } from "./pass-bar.mjs";

// ---- text normalisation (length preserving: every index in the cleaned text is the same index in the original) ----------------------------------------
const ROW_ID_RE = /\[([a-z_]+:[A-Za-z0-9_.-]{1,40})\](?!\()/g; // the Worker's own citation shape (game-facts-read.js BRACKET_ROW_RE)
export const rowIdsIn = (text) => [...new Set([...String(text == null ? "" : text).matchAll(ROW_ID_RE)].map((m) => m[1]))];
const pad = (s, n) => s + " ".repeat(Math.max(0, n - s.length));
const THIN = "\\u2009\\u202f\\u00a0";
const THIN_GROUP_RE = new RegExp(`(?<![\\d.,${THIN}])\\d{1,3}(?:[${THIN}]\\d{3})+(?![\\d])`, "g");
const NUM = String.raw`\d+(?:\.\d+)?`;
const HMS_RE = new RegExp(String.raw`(?<![\d.])(${NUM})\s*(?:hours?|hrs?)\s*(?:,|and)?\s*(${NUM})\s*(?:minutes?|mins?)(?:\s*(?:,|and)?\s*(${NUM})\s*(?:seconds?|secs?))?(?![A-Za-z])`, "gi");
const MS_RE = new RegExp(String.raw`(?<![\d.])(${NUM})\s*(?:minutes?|mins?)\s*(?:,|and)?\s*(${NUM})\s*(?:seconds?|secs?)(?![A-Za-z])`, "gi");
const RANGE_RES = [
  /(?<![\w.])\d[\d,]*(?:\.\d+)?\s*(?:-|to|or)\s*(?:(?:levels?|lvl)\s*)?\d[\d,]*(?:\.\d+)?(?![\w])/gi,
  /\bbetween\s+(?:(?:levels?|lvl)\s*)?\d[\d,]*(?:\.\d+)?\s+and\s+(?:(?:levels?|lvl)\s*)?\d[\d,]*(?:\.\d+)?(?![\w])/gi,
];
const DOTTED_RE = /(?<![\w.])\d+(?:\.\d+){2,}(?![\w.])/g; // 1.60.1.70959

// -> { text (cleaned, ranges kept), noRange (cleaned, ranges blanked), ranges: [{start, end}] }
export function normaliseText(answer) {
  let s = String(answer == null ? "" : answer).replace(ROW_ID_RE, (m) => " ".repeat(m.length));
  s = s.replace(/[*`~]/g, " ").replace(/[\u2010-\u2015\u2212]/g, "-");
  s = s.replace(THIN_GROUP_RE, (m) => pad(m.replace(new RegExp(`[${THIN}]`, "g"), ""), m.length));
  s = s.replace(new RegExp(`[${THIN}]`, "g"), " ");
  s = s.replace(/\b(levels?|lvl)-(?=\d)/gi, "$1 ");
  const dur = (m, h, mi, se) => {
    const total = Number(h) * 3600 + Number(mi) * 60 + (se === undefined ? 0 : Number(se));
    const out = `${total} seconds`;
    return Number.isInteger(total) && out.length <= m.length ? pad(out, m.length) : m;
  };
  s = s.replace(HMS_RE, dur);
  s = s.replace(MS_RE, (m, mi, se) => dur(m, 0, mi, se));
  const ranges = [];
  for (const re of RANGE_RES) for (const m of s.matchAll(re)) ranges.push({ start: m.index, end: m.index + m[0].length });
  let noRange = s;
  for (const r of ranges) noRange = noRange.slice(0, r.start) + " ".repeat(r.end - r.start) + noRange.slice(r.end);
  return { text: s, noRange, ranges };
}

// ---- row and library lookups -----------------------------------------------------------------------------------------------------------------------
// rows: the facts rows tools/facts-load.mjs would load ({id, subject, claim, value, note}). Built from the tables by loadFactRows (rescore.mjs) or handed in directly (tests).
export function buildRowIndex(rows) {
  const byId = new Map();
  const ranksBySubject = new Map();
  const subjects = new Set();
  for (const r of rows || []) {
    if (!r || typeof r.id !== "string") continue;
    const rank = /(?:^|;)rank=(\d+)(?:;|$)/.exec(String(r.note || ""));
    byId.set(r.id, { subject: String(r.subject || "").toLowerCase(), claim: String(r.claim || ""), value: String(r.value == null ? "" : r.value), rank: rank ? Number(rank[1]) : null });
    const sub = String(r.subject || "").toLowerCase();
    if (sub.length >= 4) subjects.add(sub);
    if (rank && sub) { if (!ranksBySubject.has(sub)) ranksBySubject.set(sub, new Set()); ranksBySubject.get(sub).add(Number(rank[1])); }
  }
  return { byId, ranksBySubject, subjects };
}
const EMPTY_INDEX = buildRowIndex([]);

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordIn = (hay, needle) => needle.length > 0 && new RegExp(`(?<![\\p{L}\\p{N}])${escRe(needle).replace(/\s+/g, "\\s+")}(?![\\p{L}\\p{N}])`, "iu").test(hay);

// Library facts (data/library/*.json, public data in the repo: pages[].{title, facts[].{key, value}}). Approximation, stated: a page MENTIONS an entity when its title or one of its facts' key or value holds the entity's name as whole words.
// The numbers the entity may be given are those of every fact of a page whose TITLE mentions it, plus those of any fact (on any page) whose own key or value mentions it. Page-level, not sentence-level: a figure that shares a page
// with the entity is supported. That errs toward SUPPORTED, so the new unsupported rate can only be lower than a sentence-level reading; the report says so.
export function loadLibrary(dir) {
  const pages = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
    let j;
    try { j = JSON.parse(readFileSync(path.join(dir, f), "utf8")); } catch { continue; }
    if (!j || !Array.isArray(j.pages)) continue;
    for (const p of j.pages) if (p && Array.isArray(p.facts)) pages.push({ title: String(p.title || ""), facts: p.facts.filter((x) => x && typeof x === "object").map((x) => ({ key: String(x.key || ""), text: String(x.value == null ? "" : x.value) })) });
  }
  const cache = new Map();
  return {
    pages: pages.length,
    numbersFor(entity) {
      const name = String(entity || "").trim().toLowerCase();
      if (name.length < 3) return [];
      if (cache.has(name)) return cache.get(name);
      const out = new Set();
      for (const p of pages) {
        const titleHit = wordIn(p.title, name);
        for (const f of p.facts) if (titleHit || wordIn(f.key, name) || wordIn(f.text, name)) for (const t of extractNumbers(f.text)) out.add(t.value);
      }
      const list = [...out];
      cache.set(name, list);
      return list;
    },
  };
}

// ---- sentence and clause helpers ------------------------------------------------------------------------------------------------------------------
const bounds = (text, idx, splitRe) => {
  let start = 0, end = text.length;
  for (const m of text.matchAll(splitRe)) {
    if (m.index + m[0].length <= idx) start = m.index + m[0].length;
    else if (m.index >= idx) { end = m.index; break; }
  }
  return [start, end];
};
const SENTENCE_RE = /(?<=[.!?])\s+|\n+|;/g; // the unit of "this sentence is about another entity or rank"
const CLAUSE_RE = /(?<=[.!?])\s+|\n+|;|,(?!\d)|\s+(?:but|though|however|while)\s+/g; // the strict scorer's clause split

const rankIn = (s) => { const m = /\brank\s*(\d{1,3})\b/i.exec(String(s || "")); return m ? Number(m[1]) : null; };
const ID_BEFORE = /(?:\bids?|#|\bno\.|\bnumber)\s*[:=]?\s*$/i;

// ---- the normalised exact match ---------------------------------------------------------------------------------------------------------------------
// ctx: { index: buildRowIndex(...) } (optional: without it only rank mentions in the text are guarded). -> { exact_match, contradiction, exact, matched: {start, end, text} | null, why, class, expected_unit }
// why: null | "range" | "rank" | "entity" | "echo" | "negated" | "contradiction" | "wrong-unit" | "degraded" | "no-answer"
export const ABSTAIN_RE = /\bnot in the (?:client )?table\b|\bnot in (?:the )?(?:client table|library)\b|\b(?:library|client table) (?:does not|doesn't|did not|has no|holds no)\b|\bno (?:row|rows|data|entry|entries) (?:for|in|holds?|found)\b|\bnot (?:been )?(?:added|loaded) (?:to|in) the (?:client )?(?:table|library)\b/i;

// A known subject (a name from the rows) written with a capital letter in the sentence: word n-grams of 1..5 words, so 18,000 names cost no regexes.
function otherSubjectIn(sentence, subjects, entityLower) {
  const words = sentence.match(/[\p{L}\p{N}'-]+/gu) || [];
  for (let i = 0; i < words.length; i++) {
    if (!/^\p{Lu}/u.test(words[i])) continue;
    for (let n = 1; n <= 5 && i + n <= words.length; n++) {
      const g = words.slice(i, i + n).join(" ").toLowerCase();
      if (g !== entityLower && !entityLower.includes(g) && !g.includes(entityLower) && subjects.has(g)) return g;
    }
  }
  return null;
}

function guardReason(text, original, tok, record, index, qRank, entityLower) {
  // rank: the token's comma-clause names a rank that is not the question's
  if (qRank !== null) {
    const [cs, ce] = bounds(text, tok.index, CLAUSE_RE);
    const r = rankIn(text.slice(cs, ce));
    if (r !== null && r !== qRank) return "rank";
  }
  // citations and names in the token's sentence
  const [ss, se] = bounds(text, tok.index, SENTENCE_RE);
  const ids = rowIdsIn(original.slice(ss, se));
  const rows = ids.map((id) => index.byId.get(id)).filter(Boolean);
  if (rows.length) {
    const own = rows.filter((r) => r.subject === entityLower && (qRank === null || r.rank === null || r.rank === qRank));
    if (!own.length) return rows.every((r) => r.subject === entityLower) ? "rank" : "entity";
  }
  if (entityLower && index.subjects.size) {
    const sentence = text.slice(ss, se);
    if (!wordIn(sentence, entityLower)) {
      const other = otherSubjectIn(sentence, index.subjects, entityLower);
      if (other) return "entity";
    }
  }
  return null;
}

export function normalisedExact(answer, record, res = {}, ctx = {}) {
  const expected = record && record.expected;
  const isDegraded = typeof res.degraded === "boolean" ? res.degraded : degraded(res);
  const out = { exact_match: false, contradiction: false, exact: false, matched: null, why: null, class: null, expected_unit: unitForExpected(expected) };
  if (typeof answer !== "string" || !answer) { out.why = "no-answer"; out.class = isDegraded ? "degraded" : "no-figure"; return out; }
  const finish = () => {
    out.exact = out.exact_match && !out.contradiction && !isDegraded;
    if (!out.exact) out.class = classify(answer, out, isDegraded);
    return out;
  };
  if (expected && expected.unit === "name") { // names: the strict reading, unchanged (no number is being written differently)
    out.exact_match = exact_match(answer, expected, record.entity_name);
    return finish();
  }
  if (!isNumeric(expected)) return finish();
  const index = ctx.index || EMPTY_INDEX;
  const n = normaliseText(answer);
  const want = Number(expected.value);
  const unit = unitForExpected(expected);
  const qNums = extractNumbers(record.question || "").map((t) => t.value);
  const qRank = rankIn(record.question) ?? rankIn(record.entity_name);
  const entityLower = String(record.entity_name || "").toLowerCase().replace(/\s*\(rank \d+\)\s*$/, "");
  const toks = unitTokens(n.noRange, unit);
  const reasons = [];
  let hit = null;
  for (const t of toks) {
    if (t.negated) { reasons.push("negated"); continue; }
    if (ID_BEFORE.test(tail(n.noRange, t.index)) || !near(t.norm, want)) continue;
    const g = guardReason(n.noRange, answer, t, record, index, qRank, entityLower);
    if (g) { reasons.push(g); continue; }
    hit = t; break;
  }
  if (!hit && !toks.length) { // no number in the question's unit at all: a bare standalone number, as the strict rule, minus echoes of the question, ids and "Rank N"
    for (const t of extractNumbers(n.noRange)) {
      if (ID_BEFORE.test(tail(n.noRange, t.index)) || negatedAt(n.noRange, t.index) || unitOf(n.noRange, t, unit) || !near(t.value, want)) continue;
      if (/\branks?\s*[:=]?\s*$/i.test(tail(n.noRange, t.index)) && unit !== "ranks") { reasons.push("echo"); continue; }
      if (qNums.some((q) => near(q, t.value))) { reasons.push("echo"); continue; }
      const g = guardReason(n.noRange, answer, t, record, index, qRank, entityLower);
      if (g) { reasons.push(g); continue; }
      hit = { ...t, norm: t.value }; break;
    }
  }
  if (hit) {
    const after = /^\s*-?\s*[A-Za-z]{1,12}/.exec(n.noRange.slice(hit.end, hit.end + 16)); // the cleaned text: same length, so the same indexes in the original
    const end = hit.end + (after ? after[0].length : 0);
    out.matched = { start: hit.index, end, text: answer.slice(hit.index, end) };
    out.exact_match = true;
    // the strict scorer's contradiction rule, on the cleaned text
    out.contradiction = strictContradiction(n.noRange, expected, record.question);
    if (out.contradiction) out.why = "contradiction";
  } else {
    out.why = reasons[0] || (n.ranges.length ? "range" : toks.length ? "wrong-number" : null);
    if (!reasons.length && n.ranges.length && !toks.length) out.why = "range";
    out.guard = reasons.find((r) => r === "rank" || r === "entity") || null;
    out.stated = toks.length > 0 || n.ranges.length > 0;
  }
  return finish();
}

function classify(answer, out, isDegraded) {
  if (isDegraded) return "degraded";
  if (ABSTAIN_RE.test(answer) && !out.exact_match) return "abstained";
  if (out.guard) return "right-number-wrong-entity-or-rank";
  if (out.expected_unit === "name") return "wrong-name";
  if (out.exact_match && out.contradiction) return "wrong-number";
  if (out.stated || out.why === "negated" || out.why === "range" || out.why === "echo") return "wrong-number";
  return "no-figure";
}

// ---- UNSUPPORTED (one meaning) ------------------------------------------------------------------------------------------------------------------------
// A figure (a number with its optional unit) in the answer that is NOT
//   (a) in the claim or value of a row the answer CITES ([table:id], looked up in `index`), nor
//   (b) in the truth record's allowed_numbers (the expected value and the numbers of the rows the question rests on), nor
//   (c) in the library facts for the entity (library.numbersFor; page-level approximation above).
// Also supported: a number in the question; the same figure under a unit conversion (23 hours for 82800 seconds, 1.5 s for 1500 ms).
// Not figures: bracketed ids, dotted versions (1.60.1.70959), a number after "build"/"client"/"version"/"patch", a year (1990..2099) with no unit, list markers ("1." at a line start), and "Rank N" where N is a rank the entity's rows carry
// (needs the tables for rows the answer does not cite; the cited rows and the question's own rank always count).
// -> [{value, raw, unit, index, context}]. The small-counter exemption of the strict scorer (integers 0..10 with no unit) is NOT used: a stray "3" is reported, so the new rate is not lowered by a loophole.
export function unsupportedFigures(answer, record, ctx = {}) {
  if (typeof answer !== "string" || !answer) return [];
  const index = ctx.index || EMPTY_INDEX;
  const library = ctx.library || null;
  const expected = record && record.expected;
  const ok = [];
  if (isNumeric(expected)) ok.push(Number(expected.value));
  for (const v of (record && record.allowed_numbers) || []) if (Number.isFinite(Number(v))) ok.push(Number(v));
  for (const t of extractNumbers((record && record.question) || "")) ok.push(t.value);
  const cited = rowIdsIn(answer).map((id) => index.byId.get(id)).filter(Boolean);
  const ranks = new Set();
  for (const r of cited) {
    for (const t of extractNumbers(`${r.claim} ${r.value}`)) ok.push(t.value);
    if (r.value !== "" && Number.isFinite(Number(r.value))) ok.push(Number(r.value));
    if (r.rank !== null) ranks.add(r.rank);
  }
  if (library) for (const v of library.numbersFor(record && record.entity_name)) ok.push(v);
  const entityLower = String((record && record.entity_name) || "").toLowerCase();
  for (const r of index.ranksBySubject.get(entityLower) || []) ranks.add(r);
  const qr = rankIn(record && record.question);
  if (qr !== null) ranks.add(qr);
  const has = (v) => ok.some((x) => near(x, v));
  let text = normaliseText(answer).text.replace(DOTTED_RE, (m) => " ".repeat(m.length));
  const bad = [];
  for (const t of extractNumbers(text)) {
    const before = tail(text, t.index);
    if (/\b(?:build|client|version|patch)\s*[:#]?\s*$/i.test(before)) continue;
    const lineStart = text.slice(text.lastIndexOf("\n", t.index - 1) + 1, t.index).trim() === "";
    if (lineStart && /^[.)]/.test(text.slice(t.end))) continue;
    if (ID_BEFORE.test(before)) continue;
    const u = unitOf(text, t, expected && expected.unit ? expected.unit : null);
    if (/\branks?\s*[:=]?\s*$/i.test(before) && Number.isInteger(t.value) && ranks.has(t.value)) continue;
    if (!u && Number.isInteger(t.value) && t.value >= 1990 && t.value <= 2099) continue;
    if (has(t.value) || (u && has(t.value * u.mult))) continue;
    const a = Math.max(0, t.index - 30), b = Math.min(answer.length, t.end + 30);
    bad.push({ value: t.value, raw: t.raw, unit: u ? u.unit : null, index: t.index, context: answer.slice(a, b).replace(/\s+/g, " ").trim() });
  }
  return bad;
}

// ---- one item, and the summaries -------------------------------------------------------------------------------------------------------------------
// -> { exact, exact_match, contradiction, matched, why, class, unsupported: [...], unsupported_count }
export function scoreNormalised(record, res, answer, ctx = {}) {
  const e = normalisedExact(answer, record, res, ctx);
  const u = unsupportedFigures(answer, record, ctx);
  return { ...e, unsupported: u, unsupported_count: u.length };
}

// rows: results rows ({kind, scored, latency_ms, scores, ...}); norm: Map id -> scoreNormalised result. The normalised summary swaps in the normalised exact and unsupported_count and keeps every other field as it was.
export function normalisedSummary(rows, norm) {
  const swapped = rows.map((r) => {
    const n = norm.get(r.id);
    if (!r.scored || !r.scores || typeof r.scores.exact !== "boolean" || !n) return r;
    return { ...r, scores: { ...r.scores, exact: n.exact, unsupported_count: n.unsupported_count } };
  });
  return summarize(swapped);
}
export const evaluateNormalisedBar = (summary) => evaluateBar(summary);
