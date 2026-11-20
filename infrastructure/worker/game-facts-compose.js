// COMPOSED TABLE ANSWER (flag GAME_FACTS_COMPOSE, off by default; only with GAME_FACTS_READ on and research mode): when a member asks ONE plain table figure and the lookup returned exactly one row of the asked kind
// for the one named entity, the answer is the row's own claim and its row id (finishAnswerText adds the client table Sources line from the id), written by code. No model is called, so no second figure, no persona decoration and no hedge can be added; the figure is the row's.
// Why (2026-11-19 replay): with the model composing, the asked number was usually right and cited but wrapped in other figures, and a prompt rule could not stop that (docs/runbooks/game-facts.md "Composed table answer").
// Never: a figure that is not in the row; zero rows, more than one row of the asked kind, a second named entity, a do-not-state row or a missing rank (all go to the model unchanged); a question that asks for more than one figure
// (two kinds, "and", "or", compare, why, how); a claim that is not plain text. Pure: no I/O, no clock.
import { normName } from "./game-facts-name.js";

export const GAME_FACTS_COMPOSE_MAX_WORDS = 22;
const ID_RE = /^[a-z_]+:[A-Za-z0-9_.-]{1,40}$/;
const CLAIM_RE = /^[\p{L}\p{N} '’().,:+\-\u2013/&%"!]{8,300}$/u;

// The kinds a question can be about, by the words that name them. Several kinds named = more than one figure asked = null.
const KIND_WORDS = [
  ["spell_cooldown", /\b(?:cooldown|cool down|recharge)\b/],
  ["spell_cast_time", /\b(?:cast time|casting time|cast speed)\b|\bhow long (?:does|is|to|it takes)[^?]*\bcast\b|\btakes? to cast\b|\btake[s]? [^?]*\bto cast\b/],
  ["spell_mana_cost", /\bmana\b/],
  ["trait_max_ranks", /\bhow many ranks\b|\bmax(?:imum)? ranks?\b|\branks? (?:does|can|will|has)\b|\branks can\b/],
  ["trait_points_required", /\bpoints?\b[^?]*\b(?:spent|needed|need|required|require|before|tree)\b|\b(?:need|needs|require|requires|required)\b[^?]*\bpoints?\b/],
  ["trait_prereq", /\bprerequisites?\b|\bprereqs?\b|\bbefore (?:it|you can)\b|\btaken before\b|\bneed first\b|\bwhich talent\b[^?]*\b(?:first|before)\b/],
  ["level", /\blevel\b|\blvl\b|\bwhen (?:do|can) (?:i|you) (?:learn|get)\b/],
];
const MORE_THAN_ONE = /\b(?:and|or|vs|versus|compare|compared|than|why|difference|both|each|all)\b|\bhow (?!many|much|long)\b/;

export function tableFigureKinds(question) {
  const q = String(question == null ? "" : question).toLowerCase().replace(/[’`]/g, "'");
  const kinds = [];
  for (const [k, re] of KIND_WORDS) if (re.test(q)) kinds.push(k);
  return kinds;
}

// -> { text, ids, kind } or null (the model answers). res: the lookup result of the reader ({ rows, doNotSay, rankMissing }).
export function composeTableAnswer(question, res) {
  try {
    const q = String(question == null ? "" : question).trim();
    if (!q || (q.match(/\?/g) || []).length > 1) return null;
    if (q.split(/\s+/).length > GAME_FACTS_COMPOSE_MAX_WORDS) return null;
    const low = q.toLowerCase().replace(/[’`]/g, "'");
    if (MORE_THAN_ONE.test(low.replace(/\band\b(?=\s+(?:cooldown|mana|level))/g, "and"))) return null;
    const kinds = tableFigureKinds(q);
    if (kinds.length !== 1) return null;
    if (!res || typeof res !== "object" || res.failed === true || res.rankMissing === true) return null;
    const rows = Array.isArray(res.rows) ? res.rows : [];
    if (!rows.length || (Array.isArray(res.doNotSay) && res.doNotSay.length)) return null;
    const subjects = new Set(rows.map((r) => normName(r && r.subject)));
    if (subjects.size !== 1 || subjects.has("")) return null;
    const [subject] = [...subjects];
    const qn = ` ${normName(q)} `;
    if (!qn.includes(` ${subject} `)) return null; // the question must name it (a rank suffix of the name is part of the subject key)
    const want = kinds[0] === "level" ? ["spell_level", "item_level_req"] : [kinds[0]];
    const mine = rows.filter((r) => r && want.includes(r.kind));
    if (mine.length !== 1) return null;
    const row = mine[0];
    if (row.verdict !== undefined && row.verdict !== "holds") return null;
    if (typeof row.id !== "string" || !ID_RE.test(row.id) || typeof row.claim !== "string" || typeof row.value !== "string" && typeof row.value !== "number") return null;
    const claim = row.claim.replace(/\s+/g, " ").trim();
    if (!CLAIM_RE.test(claim) || !claim.includes(String(row.value))) return null; // plain text that holds the row's value
    const end = /[.!?]$/.test(claim) ? claim : `${claim}.`;
    return { text: `**${end}** [${row.id}]`, ids: [row.id], kind: row.kind }; // the "-# Sources: client table <id>" line is added by finishAnswerText from ids
  } catch {
    return null;
  }
}
