// COMPOSED TABLE ANSWER (flag GAME_FACTS_COMPOSE, off by default; only with GAME_FACTS_READ on and research mode): when a member asks ONE plain table figure in one of a few known question shapes and the lookup returned exactly
// one row of the asked kind for the one named entity, the answer is the row's own claim and its row id (finishAnswerText adds the client table Sources line from the id), written by code. No model is called, so no second
// figure, no persona decoration and no hedge can be added; the figure is the row's.
// Why (2026-11-19 replay): with the model composing, the asked number was usually right and cited but wrapped in other figures, and a prompt rule could not stop that (docs/runbooks/game-facts.md "Composed table answer").
//
// DECLINE-BY-DEFAULT. The composer answers only when it can PROVE the question is a known shape about exactly this row; anything else returns null and the model answers unchanged:
//   - the WHOLE question, with the row's subject replaced by E (and a class name by C), must equal one of the TEMPLATES of the asked kind (an allow-list: a keyword such as "mana" or "level" inside another question
//     ("how much mana does X restore", "item level of X", "total mana for 5 casts") matches no template). Any extra word, digit, name, rank, comma list, "and", "or", "plus", "&", "/", a hedge or a second question fails it by construction.
//   - the subject must occur once as whole words, with nothing else name-like left over (so "Bestial Wrath" with only a "Wrath" row, "Improved Wrath" or a second entity the table does not hold all fail the template).
//   - the lookup must report no hidden row (cut: a SQL LIMIT, the per-name cap or the row budget may have dropped a candidate) and exactly one name group; exactly one row of the asked kind; no do-not-state row; no missing rank.
//   - the claim must be plain text, hold only the row's own value (as a whole number) and the rank in "(Rank N)", and carry no link, mention or markup.
// Pure: no I/O, no clock.
import { normName } from "./game-facts-name.js";

const ID_RE = /^[a-z_]+:[A-Za-z0-9_.-]{1,40}$/;
const CLAIM_RE = /^[\p{L}\p{N} '’().,:+\-–%"!]{8,300}$/u;
const DOMAINISH = /[a-z0-9]\.[a-z]{2,}\b|https?|www|discord|\.gg\b/i;
const CLASSES = ["druid", "hunter", "mage", "paladin", "priest", "rogue", "shaman", "warlock", "warrior"];
export const GAME_FACTS_COMPOSE_MAX_WORDS = 24;

// Whole-question templates, over normName text (lower case, no punctuation, single spaces) with E = the entity and C = a class name. "(c )?" and "(in seconds )?" are the only optional parts.
const TEMPLATES = {
  level: [
    "at what level does a player learn E", "what level do i need to be to get E", "E what level is it available from", "what level is E", "at what level do i learn E", "when do i learn E",
    "what level do you need to be to equip E", "can you tell me the level requirement of E", "what is the required level for E", "what is the level requirement of E", "what is the required level of E",
  ],
  spell_cooldown: ["what is the cooldown of E( in seconds)?", "E how long is its cooldown( in seconds)?", "how many seconds is the cooldown on E", "how long is the cooldown of E( in seconds)?"],
  spell_cast_time: ["E how long is the cast( in seconds)?", "how many seconds does E take to cast", "what is the cast time of E( in seconds)?", "how long does E take to cast( in seconds)?"],
  spell_mana_cost: ["what is the mana cost of E", "how much mana does E cost", "E what does it cost in mana", "how much does E cost in mana"],
  trait_max_ranks: ["(in the C talent tree )?how many ranks does E have", "how many ranks can you put into the C talent E", "C talent E how many ranks does it have", "how many ranks does E have"],
  trait_points_required: [
    "C talent E how many points do you need to have spent in the tree first", "what is the points requirement in the C talent tree for E", "how many talent points must be spent in the C tree before E can be learned",
    "how many points do you need to have spent in the tree before E",
  ],
  trait_prereq: ["which C talent do you need to take first before you can learn E", "C talent E which talent has to be taken before it", "in the C talent tree what is the prerequisite talent for E", "what is the prerequisite talent for E"],
};
const TEMPLATE_RES = Object.fromEntries(Object.entries(TEMPLATES).map(([k, list]) => [k, list.map((t) => new RegExp(`^${t}$`))]));

const wordsOf = (s) => (s ? s.split(" ") : []);

// The question as one template line: the subject (once, whole words) becomes E, any class name C. null when the subject is not there exactly once. Lower case, apostrophes dropped, punctuation = space.
function templateLine(question, subjectNorm) {
  const q = wordsOf(normName(question));
  const sub = wordsOf(subjectNorm);
  if (!sub.length || !q.length) return null;
  const at = [];
  for (let i = 0; i + sub.length <= q.length; i++) if (sub.every((w, j) => q[i + j] === w)) at.push(i);
  if (at.length !== 1) return null;
  const out = [...q.slice(0, at[0]), "E", ...q.slice(at[0] + sub.length)];
  return out.map((w) => (CLASSES.includes(w) ? "C" : w)).join(" ");
}

// -> the kind the question is about (one of the TEMPLATES keys) when the whole question matches a template of it, else null.
export function tableFigureKind(question, subjectNorm) {
  const q = String(question == null ? "" : question);
  if (!q.trim() || q.split(/\s+/).length > GAME_FACTS_COMPOSE_MAX_WORDS || (q.match(/\?/g) || []).length > 1) return null;
  if (/[&,/;+@\[\]<>`*_\\|#=~^{}\u0000-\u001f]/.test(q.replace(/,\s*in seconds\b/i, "").replace(/\btree,/i, "tree"))) return null; // lists, links, mentions, markup: not a plain question
  if (/[()]/.test(q.replace(/\(in seconds\)/i, ""))) return null;
  const line = templateLine(q, subjectNorm);
  if (line === null) return null;
  for (const [kind, res] of Object.entries(TEMPLATE_RES)) if (res.some((re) => re.test(line))) return kind;
  return null;
}

const NUM = /\d+(?:\.\d+)?/g;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The claim states the row's own value and nothing numeric besides it (and the rank in "(Rank N)").
function claimOk(claim, value) {
  if (typeof claim !== "string") return false;
  const v = value === null || value === undefined ? "" : String(value).trim();
  if (!v) return false;
  if (!CLAIM_RE.test(claim) || DOMAINISH.test(claim)) return false;
  const holdsValue = new RegExp(`(?<![\\p{L}\\p{N}.])${esc(v)}(?![\\p{L}\\p{N}])`, "iu").test(claim);
  if (!holdsValue) return false;
  const rank = /\(Rank (\d{1,3})\)/.exec(claim);
  for (const n of claim.match(NUM) || []) if (n !== v && !(rank && n === rank[1])) return false;
  return true;
}

// -> { text, ids, kind } or null (the model answers). res: the reader's composeInput ({ rows, doNotSay, rankMissing, cut, groups }).
export function composeTableAnswer(question, res) {
  try {
    if (!res || typeof res !== "object" || res.failed === true || res.rankMissing === true || res.cut !== false || res.groups !== 1) return null;
    const rows = Array.isArray(res.rows) ? res.rows : [];
    if (!rows.length || (Array.isArray(res.doNotSay) && res.doNotSay.length)) return null;
    const subjects = new Set(rows.map((r) => normName(r && r.subject)));
    if (subjects.size !== 1 || subjects.has("")) return null;
    const [subject] = [...subjects];
    const kind = tableFigureKind(question, subject);
    if (!kind) return null;
    const want = kind === "level" ? ["spell_level", "item_level_req"] : [kind];
    const mine = rows.filter((r) => r && want.includes(r.kind));
    if (mine.length !== 1) return null;
    const row = mine[0];
    if (row.verdict !== undefined && row.verdict !== "holds") return null;
    if (typeof row.id !== "string" || !ID_RE.test(row.id)) return null;
    const claim = String(row.claim == null ? "" : row.claim).replace(/\s+/g, " ").trim();
    if (!claimOk(claim, row.value)) return null;
    const end = /[.!?]$/.test(claim) ? claim : `${claim}.`;
    return { text: `**${end}** [${row.id}]`, ids: [row.id], kind: row.kind }; // the "-# Sources: client table <id>" line is added by finishAnswerText from ids
  } catch {
    return null;
  }
}
