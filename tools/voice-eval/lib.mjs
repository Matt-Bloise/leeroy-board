// Shared helpers for the offline blind pairwise voice evaluation (tools/voice-eval/). Pure functions, no network, no model calls.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = dirname(fileURLToPath(import.meta.url));

// JSON with sorted keys and no whitespace: the form that is hashed to freeze prompts.json.
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// Text files are hashed with the BOM and CRLF removed, so a Windows checkout hashes like a Linux one.
export const normaliseText = (s) => String(s).replace(/^﻿/, "").replace(/\r\n/g, "\n");
export const hashPrompts = (prompts) => sha256Hex(canonicalJson(prompts));
export const hashRubric = (rubric) => sha256Hex(normaliseText(rubric));

// The stored (frozen) hashes next to this file.
export function frozenHashes(dir = HERE) {
  const first = (f) => readFileSync(join(dir, f), "utf8").trim().split(/\s+/)[0];
  return { prompts: first("prompts.sha256"), rubric: first("rubric.sha256") };
}

// The mapping carries a hash of its own contents, so a hand edit of armA/armB after judging is detected (accidents, not an attacker).
export function mappingContentHash(m) {
  const { contentSha256, ...rest } = m; // eslint-disable-line no-unused-vars
  return sha256Hex(canonicalJson(rest));
}
export function sealMapping(m) {
  m.contentSha256 = mappingContentHash(m);
  return m;
}
export const mappingIntact = (m) => typeof m.contentSha256 === "string" && m.contentSha256 === mappingContentHash(m);

// mulberry32: small seeded PRNG, returns floats in [0, 1). Integer or string seeds.
export function mulberry32(seed) {
  let a = typeof seed === "string" ? parseInt(sha256Hex(seed).slice(0, 8), 16) : seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Seeded Fisher-Yates; returns a new array.
export function shuffled(list, rng) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export const Z_ONE_SIDED_95 = 1.6448536269514722;
export const Z_TWO_SIDED_95 = 1.959963984540054;

// Wilson score interval for k successes in n trials, two-sided at the given z.
export function wilsonInterval(k, n, z = Z_TWO_SIDED_95) {
  if (n <= 0) return [0, 1];
  const p = k / n;
  const z2 = z * z;
  const centre = p + z2 / (2 * n);
  const half = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  const denom = 1 + z2 / n;
  return [Math.max(0, (centre - half) / denom), Math.min(1, (centre + half) / denom)];
}

// One-sided 95% Wilson lower bound on the success rate.
export function wilsonLower(k, n) {
  if (n <= 0) return 0;
  return wilsonInterval(k, n, Z_ONE_SIDED_95)[0];
}

// Smallest number of order-consistent pairs for which an accuracy of exactly 50% has a two-sided 95% Wilson interval inside [lo, hi].
export function pairsNeededForBand(lo = 0.35, hi = 0.65) {
  for (let m = 2; m < 5000; m += 2) {
    const [a, b] = wilsonInterval(m / 2, m);
    if (a >= lo && b <= hi) return m;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Numbers. Documented rules (also in the README):
//  1. Not counted: the "-# ..." sources line, URLs, bracket cites like [page~key], hyphenated ids with a zero-padded suffix
//     ("dungeons-03") and any exact prompt id passed in `ids`.
//  2. Number words count: "four" is 4, "ninety-five" and "thirty five" are 95 and 35, "one hundred" is 100. The bare word "one" is
//     never counted (it is mostly a pronoun); "a/an" is never a number.
//  3. Digits are normalised: "8.0" and "08" are 8, "1,200" is 1200, ".95" is 0.95, "18,24" is two numbers (18 and 24), "lvl35" and
//     "x95" hold 35 and 95, "5-player" holds 5. "95%" and "95" are the same number; "0.95" and "95" are not.
//  4. A numbered-list marker ("1." "2)") at the start of a line is ignored only while the markers run 1, 2, 3 ... in order, so
//     "- 95. Bring gold." is still counted.
//  5. Support side only: "one hour", "an hour", "a day" (any of hour, minute, second, day, week, month, year, in either number)
//     supports the digit 1, so "Under 1 hour" is supported by facts that say "about an hour". No unit conversion is done:
//     "1 hour" is NOT supported by "60 minutes", and 45 is not supported by "three quarters of an hour".
// ---------------------------------------------------------------------------------------------------------------------------------
const UNIT = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
const TEEN = { ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const WORD_ALT = ["zero", ...Object.keys(UNIT), ...Object.keys(TEEN), ...Object.keys(TENS), "hundred", "thousand"].join("|");
const WORD_RUN_RE = new RegExp(`\\b(?:${WORD_ALT})(?:[\\s-]+(?:and[\\s-]+)?(?:${WORD_ALT}))*\\b`, "gi");

function wordClass(w) {
  if (w === "zero") return ["zero", 0];
  if (UNIT[w]) return ["unit", UNIT[w]];
  if (TEEN[w]) return ["teen", TEEN[w]];
  if (TENS[w]) return ["tens", TENS[w]];
  if (w === "hundred") return ["hundred", 100];
  return ["thousand", 1000];
}

function evalWordRun(words) {
  if (words.length === 1 && words[0] === "one") return []; // rule 2
  const out = [];
  let total = 0, cur = 0, last = null, started = false;
  const flush = () => { if (started) out.push(total + cur); total = 0; cur = 0; last = null; started = false; };
  for (const w of words) {
    const [cls, v] = wordClass(w);
    const legal = started && (
      (last === "tens" && cls === "unit") ||
      (cls === "hundred" && last === "unit" && cur > 0 && cur < 10) ||
      (cls === "thousand" && ["unit", "teen", "tens", "hundred"].includes(last)) ||
      ((last === "hundred" || last === "thousand") && ["unit", "teen", "tens"].includes(cls))
    );
    if (!legal) flush();
    if (cls === "hundred") cur = (cur || 1) * 100;
    else if (cls === "thousand") { total += (cur || 1) * 1000; cur = 0; }
    else cur += v;
    started = true;
    last = cls;
  }
  flush();
  return out;
}

function replaceNumberWords(text) {
  return text.replace(WORD_RUN_RE, (run) => ` ${evalWordRun(run.toLowerCase().split(/[\s-]+/).filter((w) => w && w !== "and")).join(" ")} `);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ZERO_PADDED_ID_RE = /\b(?=[A-Za-z0-9-]*[A-Za-z])[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*-0\d+\b/g;

function stripLists(text) {
  let expected = 1;
  return text.split("\n").map((line) => {
    const m = line.match(/^\s*(?:[-*]\s+)?(\d{1,2})[.)]\s+/);
    if (m && (Number(m[1]) === expected || Number(m[1]) === 1)) {
      expected = Number(m[1]) + 1;
      return line.slice(m[0].length);
    }
    return line;
  }).join("\n");
}

function normaliseNumber(tok) {
  let t = tok.replace(/,/g, "");
  if (t.startsWith(".")) t = `0${t}`;
  if (t.includes(".")) t = t.replace(/0+$/, "").replace(/\.$/, "");
  return t.replace(/^0+(?=\d)/, "");
}

function cleanForNumbers(text, ids) {
  let t = normaliseText(text).split("\n").filter((l) => !/^\s*-#/.test(l)).join("\n");
  t = t.replace(/https?:\/\/\S+/gi, " ").replace(/\[[A-Za-z][^\]\s]*\]/g, " ");
  for (const id of ids) t = t.replace(new RegExp(escapeRe(id), "gi"), " ");
  t = t.replace(ZERO_PADDED_ID_RE, " ");
  return stripLists(t);
}

// Extract normalised numbers from already-cleaned text. Answer side (support=false) also ignores ordinals ("2nd"), fractions and
// ratios ("24/7", "10/10"), "100%" and "0%", and the number zero; the support side keeps all of those digits (permissive).
function extractNumbers(t, { support = false } = {}) {
  const out = [];
  if (support) {
    for (const _ of t.matchAll(/\b(?:one|an?)\s+(?:hour|hr|minute|min|second|sec|day|week|month|year)s?\b/gi)) out.push("1"); // rule 5
  } else {
    t = t.replace(/\b\d+(?:st|nd|rd|th)\b/gi, " ").replace(/\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?/g, " ").replace(/(?<![\d.])(?:100|0)\s?%/g, " ");
  }
  t = replaceNumberWords(t);
  for (const m of t.matchAll(/(?<![\d.])(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|\.\d+)(?!\d)/g)) {
    const n = normaliseNumber(m[0]);
    if (support || n !== "0") out.push(n);
  }
  return out;
}

export function numbersIn(text, { ids = [], support = false } = {}) {
  return extractNumbers(cleanForNumbers(text, ids), { support });
}

// How many items a sentence lists after a colon ("two trees: Frostline or Emberlash" -> 2), or the bullet lines that follow it.
function listedCount(sentence, followingLines) {
  const counts = [];
  const colon = sentence.lastIndexOf(":");
  if (colon >= 0) {
    const items = sentence.slice(colon + 1).split(/,|;|\bor\b|\band\b/i).map((x) => x.replace(/[.!?]/g, "").trim()).filter(Boolean);
    if (items.length) counts.push(items.length);
  }
  let bullets = 0;
  for (const l of followingLines) {
    if (/^\s*[-*•]\s+/.test(l)) bullets++;
    else break;
  }
  if (bullets) counts.push(bullets);
  return counts;
}

// Numbers in `answer` that appear in none of: the prompt's facts, the prompt text, the previous turn, or the count of listed facts (2 or
// more), and that are not the count of items the answer itself lists right after the number's sentence.
export function unsupportedNumbers(answer, prompt, { ids = [] } = {}) {
  const support = new Set();
  const facts = prompt.facts || [];
  for (const f of facts) for (const n of numbersIn(String(f), { ids, support: true })) support.add(n);
  for (const n of numbersIn(prompt.prompt || "", { ids, support: true })) support.add(n);
  for (const n of numbersIn(prompt.previous || "", { ids, support: true })) support.add(n);
  if (facts.length >= 2) support.add(String(facts.length));
  const bad = [];
  const lines = cleanForNumbers(answer, ids).split("\n");
  lines.forEach((line, i) => {
    const following = lines.slice(i + 1);
    for (const sentence of line.split(/(?<=[.!?])\s+/)) {
      for (const n of extractNumbers(sentence)) {
        if (support.has(n) || bad.includes(n)) continue;
        if (/^\d+$/.test(n) && listedCount(replaceNumberWords(sentence), following).includes(Number(n))) continue;
        bad.push(n);
      }
    }
  });
  return bad;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Normalisation: removes the formatting and tag artefacts that let a judge tell the arms apart without reading the voice. Applied
// identically to every arm by make-tasks --normalise: "-#" lines and plain "Sources:" lines, parenthetical or bracketed confidence and
// Classic/Forever tags, markdown bold/italic/code/headings/bullet markers, links reduced to their label, and runs of blank space.
// ---------------------------------------------------------------------------------------------------------------------------------
const TAG_RE = /[ \t]*[(\[](?=[^()\[\]\n]*\b(?:classic|forever|confirm\w*|unconfirm\w*|verif\w*|unverif\w*|confiden\w*|sourced|unsourced|tier)\b)[^()\[\]\n]*[)\]]/gi;

export function normaliseAnswer(text) {
  let t = normaliseText(text);
  t = t.split("\n").filter((l) => !/^\s*-#/.test(l) && !/^\s*sources?\s*:/i.test(l)).join("\n");
  t = t.replace(/\[([^\]\n]+)\]\(<?[^)\s>]*>?\)/g, "$1"); // links to their label (before the tag strip, so a label survives)
  t = t.replace(TAG_RE, "");
  t = t.replace(/^[ \t]*#{1,6}[ \t]+/gm, "").replace(/^[ \t]*[-*•][ \t]+/gm, "");
  t = t.replace(/(\*\*|__)(?=\S)([\s\S]+?)(?<=\S)\1/g, "$2");
  t = t.replace(/(?<![\w*])\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*(?![\w*])/g, "$1");
  t = t.replace(/(?<!\w)_(?=[^\s_])([^_\n]+?)(?<=[^\s_])_(?!\w)/g, "$1");
  t = t.replace(/`([^`\n]+)`/g, "$1");
  t = t.split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim()).join("\n");
  return t.replace(/\n{3,}/g, "\n\n").trim();
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Leak and injection checks on answer text (judges must not learn the arm, the vendor, or be told what to answer).
// ---------------------------------------------------------------------------------------------------------------------------------
// Model and vendor names, whole words only. "production" is an ordinary word ("gold production line"): it is a leak only when an arm is
// named that and it appears in a label context, like any other plain-word arm name.
export const LABEL_WORDS = ["claude", "llama", "gemini", "gpt", "codex", "sonnet", "opus", "haiku"];
const VENDOR_TERMS = ["openai", "anthropic", "google", "chatgpt", "llm", "language model", "as an ai", "i am an ai", "i'm an ai"];
const wordRe = (s) => new RegExp(`(?<![A-Za-z0-9])${escapeRe(s)}(?![A-Za-z0-9])`, "i");
const LABEL_CONTEXT = ["arm", "answer", "version", "model", "system", "variant", "build", "candidate", "baseline", "persona"];

export const VALID_ARM_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{2,39}$/;

// Returns {kind, term} for the first leak found, else null. Model-style names (digit, dot, dash or underscore) match anywhere as a
// word; plain-word names ("release", "original") only in a label context ("release arm", "the original version"), so ordinary text
// such as "release notes" or "the original quest giver" does not abort a run.
export function findLeak(text, armNames) {
  const s = String(text);
  for (const w of LABEL_WORDS) if (wordRe(w).test(s)) return { kind: "label", term: w };
  for (const w of VENDOR_TERMS) if (wordRe(w).test(s)) return { kind: "vendor", term: w };
  for (const name of armNames) {
    if (name.length < 3) continue;
    if (/[-_.0-9]/.test(name)) {
      if (wordRe(name).test(s)) return { kind: "arm", term: name };
    } else {
      const n = escapeRe(name);
      const ctx = LABEL_CONTEXT.join("|");
      if (new RegExp(`(?<![A-Za-z0-9])(?:${ctx})\\s+${n}(?![A-Za-z0-9])|(?<![A-Za-z0-9])${n}\\s+(?:${ctx})(?![A-Za-z0-9])`, "i").test(s)) return { kind: "arm", term: name };
    }
  }
  return null;
}

// Text that imitates the task layout or instructs the judge.
export function findInjection(text) {
  const s = String(text);
  // Delimiters may be wrapped in markdown: "**ANSWER B:**", "> ANSWER B:", "## ANSWER B".
  if (/^[\s>*_#-]*(?:answer\s*[ab]|user message|voice rubric|earlier turn[^\n:]*|library facts[^\n:]*|judge|reply|verdict|instructions?|system|assistant|human)\s*[*_]*\s*:/im.test(s)) return "delimiter";
  if (/^[\s>*_#-]*answer\s*[ab]\s*[-–—]/im.test(s)) return "delimiter";
  if (/\breference answer\b|\bthis is the reference\b/i.test(s)) return "reference claim";
  if (/\b(?:ignore|disregard|forget|skip|override)\b[^\n.]{0,30}\b(?:rubric|rules?|instructions?|criteria)\b/i.test(s)) return "override";
  if (/\b(?:judge|grader|evaluator)\b[^\n]{0,40}\b(?:reply|answer|choose|pick|vote|select)\b/i.test(s)) return "judge instruction";
  if (/\b[Rr]eply\b[^\n]{0,40}\b(?:A|B|NONE)\b/.test(s) || /\b(?:[Pp]ick|[Cc]hoose|[Vv]ote|[Oo]utput)\s+["'`]?(?:A|B|NONE)["'`]?\s*(?:\.|$|\n)/m.test(s)) return "verdict instruction";
  if (/ignore (?:all |any )?(?:previous|prior|above) instructions/i.test(s)) return "override";
  return null;
}

// Text file or JSONL reader: BOM tolerant.
export function readJsonl(path) {
  const rows = [];
  const lines = normaliseText(readFileSync(path, "utf8")).split("\n");
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    try {
      rows.push(JSON.parse(line));
    } catch (e) {
      throw new Error(`${path}:${i + 1}: not JSON (${e.message})`);
    }
  });
  return rows;
}
