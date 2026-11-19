// Pure scoring functions for the replay harness (no I/O, importable). Rules are in docs/runbooks/replay-harness.md "Scoring".
//
// Number extraction: integers, decimals (2.5), thousands commas (1,200), ordinals (20th). A digit run glued to letters (a hex id, "x5") is not a number.
// A token has a UNIT CONTEXT from the words around it: level ("level 20", "lvl 20", "20th level"), seconds ("30 seconds", "30s", "5 minutes" = 300, "1.5 sec"), mana ("120 mana", "mana cost of 120"),
// or OTHER (gold, %, yards, damage ...). Number WORDS (twenty, thirty-five) are only read where a level or seconds unit sits next to them, so "one of the" is never a number.
import { WITHIN_BUDGET_MS } from "./pass-bar.mjs";

const NUM_RE = /(?<![\w.])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?:st|nd|rd|th)?(?=(?:ms|s|m|min)?(?![A-Za-z0-9]))/g;
const ONES = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const WORD_RE = new RegExp(`\\b(?:(${Object.keys(TENS).join("|")})(?:[- ](one|two|three|four|five|six|seven|eight|nine))?|(${Object.keys(ONES).join("|")}))\\b`, "gi");
const ID_BEFORE = /(?:\bids?|#|\bno\.|\bnumber)\s*[:=]?\s*$/i;
const LEVEL_BEFORE = /(?:\blevels?|\blvl|\blv)\.?\s*[:=]?\s*(?:of|to|at|is|was)?\s*$/i;
const LEVEL_AFTER = /^\s*-?\s*levels?\b/i;
const SEC_BEFORE = /(?:\bcooldown|\bcast\s*time|\brecharge|\bcd)\s*(?:of|is|was|:|=)?\s*$/i;
const MANA_BEFORE = /\bmana(?:\s+cost)?\s*(?:of|is|was|:|=)?\s*$/i;
const MANA_AFTER = /^\s*mana\b/i;
const OTHER_AFTER = /^\s*(?:%|percent\b|gold\b|silver\b|copper\b|g\b|yards?\b|yds?\b|damage\b|dmg\b|hp\b|health\b|points?\b|stacks?\b|charges?\b|times\b|hits\b|ticks\b|attack\s+power\b|armou?r\b|stamina\b|strength\b|agility\b|intellect\b|spirit\b)/i;
// A clause about another fact (a cap, a rank, an upgrade). Time words (until, then, next, later) are NOT here: "level 30 until the next update, then level 20" is a contradiction.
const DIFFERENT_FACT = /\b(?:max(?:imum)?|cap(?:ped)?|ranks?|upgrade[sd]?|improved)\b/i;
// Negation just before a number's phrase, inside its clause: "not level 20", "isn't 20", "no longer 20", "never level 20". Up to three words may sit between.
const NEG_BEFORE = /(?:n['\u2019]t\b|\bnot\b|\bnever\b|\bno longer\b)(?:\s+[\w'\u2019-]+){0,3}\s*$/i;
const negatedAt = (text, idx) => NEG_BEFORE.test(text.slice(Math.max(0, idx - 60), idx).split(/[.,;:!?\n]/).pop());

const near = (a, b) => Math.abs(a - b) < 1e-9;
const tail = (text, idx) => text.slice(Math.max(0, idx - 32), idx);

export function extractNumbers(text) {
  const s = String(text ?? "");
  const out = [];
  for (const m of s.matchAll(NUM_RE)) {
    const raw = m[0];
    const value = parseFloat(m[1].replace(/,/g, "") + (m[2] ? "." + m[2] : ""));
    const end = m.index + raw.length;
    out.push({ value, raw, index: m.index, end, word: false });
  }
  return out;
}
export function extractNumberWords(text) {
  const s = String(text ?? "");
  const out = [];
  for (const m of s.matchAll(WORD_RE)) {
    const value = m[1] ? TENS[m[1].toLowerCase()] + (m[2] ? ONES[m[2].toLowerCase()] : 0) : ONES[m[3].toLowerCase()];
    out.push({ value, raw: m[0], index: m.index, end: m.index + m[0].length, word: true });
  }
  return out;
}

// -> {unit: "level"|"seconds"|"mana"|"other", mult} or null (no context). mult converts the token to the unit's base (minutes -> seconds x60).
function unitOf(text, t) {
  const before = tail(text, t.index);
  const after = text.slice(t.end, t.end + 28);
  const next = text.slice(t.end, t.end + 28); // right after the token: a glued s/ms/m/min suffix shows here
  if (LEVEL_BEFORE.test(before) || LEVEL_AFTER.test(after)) return { unit: "level", mult: 1 };
  if (MANA_AFTER.test(after) || MANA_BEFORE.test(before)) return { unit: "mana", mult: 1 };
  const glued = /^(ms|s|min|m)(?![A-Za-z0-9])/.exec(next);
  const probe = glued ? glued[0] + " " : after;
  if (/^\s*-?\s*(?:ms|milliseconds?)\b/i.test(probe)) return { unit: "seconds", mult: 0.001 };
  if (/^\s*-?\s*(?:hours?|hrs?)\b/i.test(probe)) return { unit: "seconds", mult: 3600 };
  if (/^\s*-?\s*(?:min|mins|minutes?|m)\b/i.test(probe)) return { unit: "seconds", mult: 60 };
  if (/^\s*-?\s*(?:s|secs?|seconds?)\b/i.test(probe)) return { unit: "seconds", mult: 1 };
  if (OTHER_AFTER.test(after)) return { unit: "other", mult: 1 };
  if (SEC_BEFORE.test(before)) return { unit: "seconds", mult: 1 };
  return null;
}

export const KIND_UNIT = Object.freeze({ spell_level: "level", item_level_req: "level", spell_cooldown: "seconds", spell_cast_time: "seconds", spell_mana_cost: "mana" });
const unitForExpected = (expected) => (expected && expected.unit) || "level";

// Tokens of one answer that carry the question's unit, normalised to that unit. Word forms count here only.
function unitTokens(text, unit) {
  const toks = [...extractNumbers(text), ...extractNumberWords(text)];
  const out = [];
  for (const t of toks) {
    const u = unitOf(text, t);
    if (u && u.unit === unit) out.push({ ...t, norm: t.value * u.mult, negated: negatedAt(text, t.index) });
  }
  return out;
}

// exact_match: the expected number is stated as the question's unit ("level 20", "20th level", "twenty" next to level, "5 minutes" for 300 seconds) or, when the answer states no number in that unit at all,
// as a bare standalone token that is not an id and carries no other unit (gold, %, mana for a level question ...). Not part of a longer number (120, 2.05).
export function exact_match(answer, expected) {
  if (typeof answer !== "string" || !answer || !expected || !Number.isFinite(Number(expected.value))) return false;
  const want = Number(expected.value);
  const unit = unitForExpected(expected);
  const ctx = unitTokens(answer, unit);
  if (ctx.some((t) => !t.negated && !ID_BEFORE.test(tail(answer, t.index)) && near(t.norm, want))) return true;
  if (ctx.length) return false;
  for (const t of extractNumbers(answer)) {
    if (ID_BEFORE.test(tail(answer, t.index)) || negatedAt(answer, t.index)) continue;
    if (unitOf(answer, t)) continue; // a number with some other unit is not this answer
    if (near(t.value, want)) return true;
  }
  return false;
}

// unsupported_numbers: numbers (digits only) in the answer that nothing supports. Supported = the expected value, any of allowed_numbers, any number in the question, the same after unit conversion (5 minutes = 300 s).
// Exempt: integers 0..10 with no unit context (small counters: "3 tips", "step 2"), and list markers ("1." at the start of a line). A small number WITH a unit context ("level 5", "5 seconds") is not exempt.
export function unsupported_numbers(answer, { question = "", expected = null, allowed_numbers = [] } = {}) {
  if (typeof answer !== "string" || !answer) return [];
  const ok = [];
  if (expected && Number.isFinite(Number(expected.value))) ok.push(Number(expected.value));
  for (const v of allowed_numbers || []) if (Number.isFinite(Number(v))) ok.push(Number(v));
  for (const t of extractNumbers(question)) ok.push(t.value);
  const has = (v) => ok.some((x) => near(x, v));
  const bad = new Set();
  for (const t of extractNumbers(answer)) {
    const lineStart = answer.slice(answer.lastIndexOf("\n", t.index - 1) + 1, t.index).trim() === "";
    if (lineStart && /^[.)]/.test(answer.slice(t.end))) continue;
    const u = unitOf(answer, t);
    if (has(t.value)) continue;
    if (u && has(t.value * u.mult)) continue;
    if (!u && Number.isInteger(t.value) && t.value <= 10) continue;
    bad.add(t.value);
  }
  return [...bad].sort((a, b) => a - b);
}

// contradiction: the answer states a DIFFERENT number in the question's unit than the expected one ("level 30" when the fact is level 20), unless that number is negated ("not level 30"), is in the question, or sits in a clause about a
// different fact (max, cap, rank, upgrade, improved). Number words next to the unit count.
export function contradiction(answer, expected, question = "") {
  if (typeof answer !== "string" || !answer || !expected || !Number.isFinite(Number(expected.value))) return false;
  const want = Number(expected.value);
  const unit = unitForExpected(expected);
  const qn = extractNumbers(question).map((t) => t.value);
  // per CLAUSE: sentences, then commas, semicolons and but/though/however/while
  for (const sentence of answer.split(/(?<=[.!?])\s+|\n+|;|,(?!\d)|\s+(?:but|though|however|while)\s+/)) {
    if (DIFFERENT_FACT.test(sentence)) continue;
    for (const t of unitTokens(sentence, unit)) {
      if (!t.negated && !near(t.norm, want) && !qn.some((q) => near(q, t.norm))) return true;
    }
  }
  return false;
}

// degraded: reason present and not "ok", OR the model label carries +degraded, OR the status is anything but "answered".
export function degraded(res) {
  if (!res || typeof res !== "object") return true;
  const nonOkReason = res.reason !== null && res.reason !== undefined && res.reason !== "ok";
  const label = typeof res.model === "string" && res.model.includes("+degraded");
  const status = res.status !== undefined && res.status !== null && res.status !== "answered";
  return nonOkReason || label || status;
}

export const withinBudget = (latencyMs) => Number.isFinite(latencyMs) && latencyMs < WITHIN_BUDGET_MS;

// Scores one result against one truth record. answer: the text (null when the Worker withheld it).
export function scoreTruthItem(record, res, answer) {
  const expected = record.expected;
  const em = exact_match(answer, expected);
  const ct = contradiction(answer, expected, record.question);
  const un = unsupported_numbers(answer, { question: record.question, expected, allowed_numbers: record.allowed_numbers });
  return { exact_match: em, contradiction: ct, exact: em && !ct && !degraded(res), unsupported_count: un.length, degraded: degraded(res) };
}

export function percentile(values, p) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.max(0, Math.ceil((p / 100) * v.length) - 1)];
}

// items: results rows {kind, scored, latency_ms, scores?}. Denominators: every rate is over SCORED rows (the Worker returned a composed answer record).
// exact_rate and unsupported_rate use the rows that carry truth scores (exact_scored); degraded_rate and within_budget_rate use all scored rows.
function group(rows) {
  const scored = rows.filter((r) => r.scored);
  const truth = scored.filter((r) => r.scores && typeof r.scores.exact === "boolean");
  const rate = (num, den) => (den ? num / den : null);
  return {
    n: rows.length,
    scored: scored.length,
    unscored: rows.length - scored.length,
    exact_scored: truth.length,
    exact_rate: rate(truth.filter((r) => r.scores.exact).length, truth.length),
    unsupported_rate: rate(truth.filter((r) => r.scores.unsupported_count > 0).length, truth.length),
    degraded_rate: rate(scored.filter((r) => (typeof r.degraded === "boolean" ? r.degraded : degraded({ reason: r.reason, model: r.model, status: r.status }))).length, scored.length),
    within_budget_rate: rate(scored.filter((r) => withinBudget(r.latency_ms)).length, scored.length),
    latency_p50_ms: percentile(scored.map((r) => r.latency_ms), 50),
    latency_p95_ms: percentile(scored.map((r) => r.latency_ms), 95),
  };
}
export function summarize(items) {
  const by_kind = {};
  for (const k of new Set(items.map((r) => r.kind || "pair"))) by_kind[k] = group(items.filter((r) => (r.kind || "pair") === k));
  return { ...group(items), by_kind };
}
