// Game-facts lookup: lookupGameFacts(env, question, { limit }). docs/runbooks/game-facts.md. NOT wired into any answer path in this PR; a later PR runs it before the Claude hop.
// What it returns (and ONLY this): rows { id, claim, value, source_table, row_id, build } that HOLD, and separately doNotSay rows (verdict 'wrong') that match the question, in the same shape.
// A row counts only while its load is 'done' and it is not superseded; a row of an open or failed load is invisible. unverifiable rows are not returned.
// The question is never put into SQL: tokens are cut out of it (letters and digits only), reserved words and stop words dropped, each token double-quoted for FTS5 and bound as a parameter. An FTS5 operator, quote, column filter,
// NEAR, prefix star or caret in the question therefore can only ever become a plain quoted word. If the FTS5 query cannot run (no FTS5, no index) a LIKE query over the same tokens answers instead.
export const LOOKUP_MAX_TOKENS = 12;
export const LOOKUP_MAX_CHARS = 600; // the question is cut to this many characters before tokenising
const FTS_RESERVED = new Set(["and", "or", "not", "near"]);
const STOP = new Set(["a", "an", "the", "of", "to", "in", "on", "at", "is", "are", "was", "were", "be", "it", "its", "do", "does", "did", "i", "me", "my", "you", "your", "we", "can", "could", "would", "should",
  "what", "whats", "which", "who", "whom", "when", "where", "why", "how", "for", "from", "with", "and", "or", "not", "near", "tell", "about", "please", "get", "have", "has", "had", "that", "this", "there", "then", "than", "if", "so", "as", "by"]);
// Words that describe the KIND of fact asked for. They narrow a lookup when a name token is present, and are used alone only when nothing else is left.
const GENERIC = new Set(["level", "levels", "cooldown", "cooldowns", "cast", "casts", "casting", "time", "mana", "cost", "costs", "required", "requires", "require", "requirement", "rank", "ranks", "point", "points", "spell", "spells",
  "talent", "talents", "item", "items", "much", "many", "long", "seconds", "second", "sec", "minimum", "min", "need", "needs", "learn", "available", "equip", "take", "takes", "use", "max", "maximum", "prerequisite", "prerequisites", "trait"]);

// -> { specific: [...], generic: [...] }, lower-case, deduplicated, at most LOOKUP_MAX_TOKENS in all.
export function extractTokens(question) {
  const text = String(question == null ? "" : question).slice(0, LOOKUP_MAX_CHARS).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const seen = new Set();
  const specific = [];
  const generic = [];
  for (const t of text.match(/[\p{L}\p{N}]+/gu) || []) {
    if (t.length < 2 || t.length > 40 || FTS_RESERVED.has(t) || STOP.has(t) || seen.has(t)) continue;
    seen.add(t);
    if (specific.length + generic.length >= LOOKUP_MAX_TOKENS) break;
    (GENERIC.has(t) ? generic : specific).push(t);
  }
  return { specific, generic };
}

const quoteToken = (t) => `"${t}"`; // tokens hold only letters and digits, so there is nothing inside to escape
// FTS5 MATCH text. mode 'narrow': (specific OR ...) AND (generic OR ...); 'wide': the specific tokens alone, or the generic ones alone when no specific token exists. null when there is nothing to match.
export function buildMatch({ specific, generic }, mode) {
  const or = (list) => `(${list.map(quoteToken).join(" OR ")})`;
  if (!specific.length && !generic.length) return null;
  if (mode === "narrow") return specific.length && generic.length ? `${or(specific)} AND ${or(generic)}` : null;
  return or(specific.length ? specific : generic);
}

// Visible: the row's load is done, it is not superseded, and no NEWER done load holds the same id (the build preference is applied here, in the query, before any LIMIT: finish supersedes older rows too, this is the second guard).
const VISIBLE = "l.status = 'done' AND g.superseded = 0 AND g.verdict IN ('holds', 'wrong') AND NOT EXISTS (SELECT 1 FROM game_facts g2 JOIN game_fact_loads l2 ON l2.id = g2.load_id WHERE g2.id = g.id AND g2.load_id <> g.load_id AND l2.status = 'done' AND (l2.finished_at > l.finished_at OR (l2.finished_at = l.finished_at AND l2.started_at > l.started_at)))";
const COLS = "g.id AS id, g.claim AS claim, g.value AS value, g.source_table AS source_table, g.row_id AS row_id, g.build AS build, g.verdict AS verdict, g.kind AS kind, g.subject_norm AS subject_norm, l.finished_at AS finished_at";
const JOIN = "JOIN game_fact_loads l ON l.id = g.load_id";

// -> { sql, binds } for the FTS5 query.
export function buildFtsSql(match, fetch) {
  return { sql: `SELECT ${COLS} FROM game_facts_fts f JOIN game_facts g ON g.rowid = f.rowid ${JOIN} WHERE game_facts_fts MATCH ? AND ${VISIBLE} ORDER BY bm25(game_facts_fts, 4.0, 1.0), l.finished_at DESC, g.id LIMIT ?`, binds: [match, fetch] };
}
// -> { sql, binds } for the fallback: every specific token (or, with none, every generic one) must appear in the subject or the claim; generic tokens narrow when `narrow` is set.
export function buildLikeSql(tokens, narrow, fetch) {
  const list = tokens.specific.length ? tokens.specific : tokens.generic;
  const esc = (t) => `%${t}%`; // tokens are letters and digits: no LIKE wildcard can be inside one
  const clause = (ts) => `(${ts.map(() => "(g.subject_norm LIKE ? OR lower(g.claim) LIKE ?)").join(" OR ")})`;
  const binds = [];
  let where = clause(list);
  for (const t of list) binds.push(esc(t), esc(t));
  if (narrow && tokens.specific.length && tokens.generic.length) {
    where += ` AND ${clause(tokens.generic)}`;
    for (const t of tokens.generic) binds.push(esc(t), esc(t));
  }
  return { sql: `SELECT ${COLS} FROM game_facts g ${JOIN} WHERE ${where} AND ${VISIBLE} ORDER BY l.finished_at DESC, g.id LIMIT ?`, binds: [...binds, fetch] };
}

const shape = (r) => ({ id: r.id, claim: r.claim, value: r.value, source_table: r.source_table, row_id: r.row_id, build: r.build });

// Pure over the rows (they arrive in rank order): splits holds from wrong and applies the limit.
export function pickRows(rows, limit) {
  return {
    rows: rows.filter((r) => r.verdict === "holds").slice(0, limit).map(shape),
    doNotSay: rows.filter((r) => r.verdict === "wrong").slice(0, limit).map(shape),
  };
}

async function runAll(env, q) {
  const { results } = await env.DB.prepare(q.sql).bind(...q.binds).all();
  return results || [];
}

// -> { rows: [...], doNotSay: [...], via: "fts" | "like" | "none" }. Never throws: a database error answers empty.
export async function lookupGameFacts(env, question, { limit = 5 } = {}) {
  const empty = { rows: [], doNotSay: [], via: "none" };
  const n = Number.isInteger(limit) ? Math.min(20, Math.max(1, limit)) : 5;
  const tokens = extractTokens(question);
  if (!tokens.specific.length && !tokens.generic.length) return empty;
  const fetch = n * 6; // headroom for the newest-build pick and for the wrong rows that share the match
  const narrowMatch = buildMatch(tokens, "narrow");
  const wideMatch = buildMatch(tokens, "wide");
  try {
    let found = narrowMatch ? await runAll(env, buildFtsSql(narrowMatch, fetch)) : [];
    if (!found.some((r) => r.verdict === "holds")) found = await runAll(env, buildFtsSql(wideMatch, fetch));
    return { ...pickRows(found, n), via: "fts" };
  } catch {
    try {
      let found = await runAll(env, buildLikeSql(tokens, true, fetch));
      if (!found.some((r) => r.verdict === "holds")) found = await runAll(env, buildLikeSql(tokens, false, fetch));
      return { ...pickRows(found, n), via: "like" };
    } catch {
      return empty;
    }
  }
}
