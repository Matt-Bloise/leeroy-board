// Game-facts lookup: lookupGameFacts(env, question, { limit }). docs/runbooks/game-facts.md. NOT wired into any answer path in this PR; a later PR runs it before the Claude hop.
// No full-text index: the question is folded with the SAME normaliser the loader used (game-facts-name.js), cut into word windows (longest first), and the windows are looked up as names through the (kind, subject_norm) index and, for
// "Arcane Spirit" finding "Arcane Spirit III", the partial (kind, subject_base) index. Curated facts (kind 'curated', a sentence each, a few hundred rows) are matched on their words instead.
// Returns { rows, doNotSay, ambiguous, via }. A row is { id, kind, subject, claim, value, unit, source_table, row_id, build }. ALL rows that share a matched name come back, with their ids: when one name has several rows of the same kind
// (a spell with three rows, ranks of one talent) ambiguous is true and nothing is picked silently. Wrong rows (verdict 'wrong') come back separately as doNotSay. Unverifiable rows are not returned.
// A row is visible only while its load is 'done', it is not superseded, and no NEWER done load holds the same id (so the newest build wins, in the query, before any limit).
// The question never reaches SQL as text: every value is a bound parameter built from letters and digits only. A database error answers empty; it never throws.
import { normName, tokensOfNorm, ROMAN } from "./game-facts-name.js";
import { FACT_KINDS } from "./game-facts.js";

export const LOOKUP_MAX_QUESTION_CHARS = 600;
export const LOOKUP_MAX_TOKENS = 24;
export const LOOKUP_MAX_WINDOW = 6;
export const LOOKUP_MAX_KEYS = 90; // D1 allows 100 bound values per statement
const NAME_KINDS = FACT_KINDS.filter((k) => k !== "curated");
const KIND_LIST = NAME_KINDS.map((k) => `'${k}'`).join(", "); // constants, never input
const STOP = new Set(["a", "an", "the", "of", "to", "in", "on", "at", "is", "are", "was", "were", "be", "it", "its", "do", "does", "did", "i", "me", "my", "you", "your", "we", "can", "could", "would", "should",
  "what", "whats", "which", "who", "whom", "when", "where", "why", "how", "for", "from", "with", "and", "or", "not", "tell", "about", "please", "get", "have", "has", "had", "that", "this", "there", "then", "than", "if", "so", "as", "by"]);
// Words that name the KIND of fact asked for; they are never a curated search word on their own.
const GENERIC = new Set(["level", "levels", "cooldown", "cooldowns", "cast", "casts", "casting", "time", "mana", "cost", "costs", "required", "requires", "require", "requirement", "rank", "ranks", "point", "points", "spell", "spells",
  "talent", "talents", "item", "items", "much", "many", "long", "seconds", "second", "sec", "minimum", "min", "need", "needs", "learn", "available", "equip", "take", "takes", "use", "max", "maximum", "prerequisite", "prerequisites", "trait"]);

// -> { tokens, windows: [{ key, start, len, next }] }. Windows of 1 to LOOKUP_MAX_WINDOW words; a one-word window that is a stop word is never a name.
export function questionWindows(question) {
  const norm = normName(String(question == null ? "" : question).slice(0, LOOKUP_MAX_QUESTION_CHARS));
  const tokens = tokensOfNorm(norm).filter((t) => t.length <= 40).slice(0, LOOKUP_MAX_TOKENS);
  const windows = [];
  for (let start = 0; start < tokens.length; start++) {
    for (let len = 1; len <= LOOKUP_MAX_WINDOW && start + len <= tokens.length; len++) {
      if (len === 1 && STOP.has(tokens[start])) continue;
      const key = tokens.slice(start, start + len).join(" ");
      windows.push({ key, start, len, next: tokens[start + len] || "" });
    }
  }
  return { tokens, windows };
}

// The candidate keys of both lookups, longest windows first, capped. exact: a name equal to a window ("frostbolt rank 4" asks for "frostbolt" through its own window "frostbolt").
// byBase: a name whose own base equals a window ("arcane spirit" finds "arcane spirit iii"), unless a rank follows the window in the question: asking for rank II must not return rank III by itself.
export function candidateKeys(windows) {
  const order = [...windows].sort((a, b) => b.len - a.len || a.start - b.start);
  const exact = [], byBase = [];
  const seenE = new Set(), seenB = new Set();
  for (const w of order) {
    if (exact.length < LOOKUP_MAX_KEYS && !seenE.has(w.key)) { seenE.add(w.key); exact.push(w.key); }
    if (byBase.length < LOOKUP_MAX_KEYS && !seenB.has(w.key)) { seenB.add(w.key); byBase.push(w.key); }
  }
  return { exact, byBase };
}

// Visible: the row's load is done, it is not superseded, and no NEWER done load holds the same id (the build preference is applied here, in the query, before any LIMIT; finish supersedes older rows too, this is the second guard).
const VISIBLE = "l.status = 'done' AND g.superseded = 0 AND g.verdict IN ('holds', 'wrong') AND NOT EXISTS (SELECT 1 FROM game_facts g2 JOIN game_fact_loads l2 ON l2.id = g2.load_id WHERE g2.id = g.id AND g2.load_id <> g.load_id AND l2.status = 'done' AND (l2.finished_at > l.finished_at OR (l2.finished_at = l.finished_at AND l2.started_at > l.started_at)))";
const COLS = "g.id AS id, g.kind AS kind, g.subject AS subject, g.subject_norm AS subject_norm, g.subject_base AS subject_base, g.claim AS claim, g.value AS value, g.unit AS unit, g.source_table AS source_table, g.row_id AS row_id, g.build AS build, g.note AS note, g.verdict AS verdict";
const FROM = "FROM game_facts g JOIN game_fact_loads l ON l.id = g.load_id";
const marks = (n) => Array.from({ length: n }, () => "?").join(", ");

export function buildNameSql(keys, column, fetch) {
  if (!["subject_norm", "subject_base"].includes(column)) throw new Error("bad column");
  const base = column === "subject_base" ? " AND g.subject_base <> ''" : ""; // the partial index is usable only when the query says so
  return { sql: `SELECT ${COLS} ${FROM} WHERE g.kind IN (${KIND_LIST}) AND g.${column} IN (${marks(keys.length)})${base} AND ${VISIBLE} LIMIT ?`, binds: [...keys, fetch] };
}
export function buildCuratedSql(fetch) {
  return { sql: `SELECT ${COLS} ${FROM} WHERE g.kind = 'curated' AND ${VISIBLE} LIMIT ?`, binds: [fetch] };
}

// A spell row of the loader carries "rank=4;class=Mage" in its note (tools/facts-load.mjs deriveRankRows). rank is an integer or absent, hint (the class) a short word string or absent; the other fields are unchanged.
export function parseNote(note) {
  const out = {};
  for (const part of String(note || "").split(";")) {
    const m = /^(rank|class)=(.{1,40})$/.exec(part);
    if (!m) continue;
    if (m[1] === "rank" && /^[0-9]{1,3}$/.test(m[2])) out.rank = Number(m[2]);
    else if (m[1] === "class" && /^[\p{L} '-]{2,30}$/u.test(m[2])) out.hint = m[2];
  }
  return out;
}
const shape = (r) => ({ id: r.id, kind: r.kind, subject: r.subject, claim: r.claim, value: r.value, unit: r.unit, source_table: r.source_table, row_id: r.row_id, build: r.build, ...parseNote(r.note) });
const rankOfRow = (r) => parseNote(r.note).rank;
const KIND_RANK = new Map(NAME_KINDS.map((k, i) => [k, i]));
// The rank the question asks for next to a chosen name window: "fireball rank 4", "fireball rank iv", or "rank 4 fireball". null when none (then every rank comes back).
export function askedRank(tokens, win) {
  const read = (a, b) => { if (a !== "rank") return null; if (/^[0-9]{1,3}$/.test(b || "")) return Number(b); const i = ["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x"].indexOf(b); return i >= 0 ? i + 1 : null; };
  const after = read(tokens[win.start + win.len], tokens[win.start + win.len + 1]);
  if (after !== null) return after;
  return win.start >= 2 ? read(tokens[win.start - 2], tokens[win.start - 1]) : null;
}

// A window that is the base of a row's name ("arcane spirit" for "arcane spirit iii") counts only when no rank follows it in the question: "Arcane Spirit II" must not return the rank III row on its own.
const rankFollows = (next) => ROMAN.has(next) || /^[0-9]{1,3}$/.test(next) || next === "rank";

// Pure over the fetched rows. Chooses non-overlapping names, longest first; every row of a chosen name comes back. -> { groups: [{ len, rows }], ... }
export function chooseNames(windows, rows) {
  const winByKey = new Map();
  for (const w of windows) { if (!winByKey.has(w.key)) winByKey.set(w.key, []); winByKey.get(w.key).push(w); }
  // every window each row could belong to
  const items = rows.map((r) => {
    const ws = [...(winByKey.get(r.subject_norm) || []), ...(r.subject_base ? (winByKey.get(r.subject_base) || []).filter((w) => !rankFollows(w.next)) : [])];
    return { r, ws };
  }).filter((x) => x.ws.length);
  const cand = [...new Map(items.flatMap((x) => x.ws).map((w) => [`${w.start}:${w.len}`, w])).values()].sort((a, b) => b.len - a.len || a.start - b.start);
  const taken = new Set();
  const groups = [];
  const used = new Set();
  for (const w of cand) {
    let clash = false;
    for (let i = w.start; i < w.start + w.len; i++) if (taken.has(i)) clash = true;
    if (clash) continue;
    const mine = items.filter((x) => !used.has(x.r.id + "|" + x.r.kind) && x.ws.some((y) => y.start === w.start && y.len === w.len));
    if (!mine.length) continue;
    for (let i = w.start; i < w.start + w.len; i++) taken.add(i);
    for (const x of mine) used.add(x.r.id + "|" + x.r.kind);
    groups.push({ len: w.len, start: w.start, rows: mine.map((x) => x.r) });
  }
  return groups;
}

// Curated rows are sentences: a row matches by the question's specific words (no stop or generic word) found among the claim's words. Needs two matching words when the question has two or more, else one.
export function curatedMatches(question, rows) {
  const qt = [...new Set(tokensOfNorm(normName(String(question == null ? "" : question).slice(0, LOOKUP_MAX_QUESTION_CHARS))).filter((t) => t.length >= 3 && t.length <= 40 && !STOP.has(t) && !GENERIC.has(t)))].slice(0, 12);
  if (!qt.length) return [];
  const need = qt.length >= 2 ? 2 : 1;
  return rows.map((r) => { const words = new Set(tokensOfNorm(normName(`${r.subject} ${r.claim}`))); return { r, score: qt.filter((t) => words.has(t)).length }; })
    .filter((x) => x.score >= need).sort((a, b) => b.score - a.score || (a.r.id < b.r.id ? -1 : 1)).map((x) => x.r);
}

async function runAll(env, q) {
  const { results } = await env.DB.prepare(q.sql).bind(...q.binds).all();
  return results || [];
}

// -> { rows, doNotSay, ambiguous, via: "names" | "none" }. limit: the most rows returned by whole names (the first name is never cut: an ambiguous name returns every row).
export async function lookupGameFacts(env, question, { limit = 5 } = {}) {
  const empty = { rows: [], doNotSay: [], ambiguous: false, via: "none" };
  const n = Number.isInteger(limit) ? Math.min(20, Math.max(1, limit)) : 5;
  const { tokens, windows } = questionWindows(question);
  const { exact, byBase } = candidateKeys(windows);
  try {
    const fetched = new Map();
    const add = (list) => { for (const r of list) fetched.set(`${r.id}|${r.load_id || ""}|${r.build}`, r); };
    if (exact.length) add(await runAll(env, buildNameSql(exact, "subject_norm", 400)));
    if (byBase.length) add(await runAll(env, buildNameSql(byBase, "subject_base", 400)));
    const named = chooseNames(windows, [...fetched.values()]);
    const holds = [], wrong = [];
    let ambiguous = false, rankMissing = false;
    for (const g of named) {
      // A rank in the question ("Fireball rank 4") picks the rows of that rank when the name has ranked rows; rows without a rank line stay (they are other spells of the same name). A rank no row has returns nothing for that name
      // and sets rankMissing: stating another rank's number would be wrong. With no rank in the question every rank comes back, lowest rank first, so "when do I get Fireball" sees the whole ladder.
      const want = askedRank(tokens, { start: g.start, len: g.len });
      let mine = g.rows;
      if (want !== null && mine.some((r) => rankOfRow(r) !== undefined)) {
        mine = mine.filter((r) => rankOfRow(r) === undefined || rankOfRow(r) === want);
        if (!mine.some((r) => rankOfRow(r) !== undefined)) { rankMissing = true; mine = []; }
      }
      mine = [...mine].sort((a, b) => (rankOfRow(a) ?? 1e9) - (rankOfRow(b) ?? 1e9) || KIND_RANK.get(a.kind) - KIND_RANK.get(b.kind) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const gh = mine.filter((r) => r.verdict === "holds"), gw = mine.filter((r) => r.verdict === "wrong");
      const perKind = new Map();
      for (const r of gh) perKind.set(r.kind, (perKind.get(r.kind) || 0) + 1);
      if ([...perKind.values()].some((c) => c > 1)) ambiguous = true;
      if (holds.length === 0 || holds.length + gh.length <= n) holds.push(...gh);
      wrong.push(...gw);
    }
    const cur = curatedMatches(question, await runAll(env, buildCuratedSql(300)));
    for (const r of cur) { if (r.verdict === "holds" && holds.length < n) holds.push(r); else if (r.verdict === "wrong") wrong.push(r); }
    const rank = (r) => r.id;
    return { rows: holds.map(shape), doNotSay: [...new Map(wrong.map((r) => [rank(r), r])).values()].map(shape), ambiguous, ...(rankMissing ? { rankMissing: true } : {}), via: "names" };
  } catch {
    return empty;
  }
}
