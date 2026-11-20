// COMPOSED TABLE ANSWER (flag GAME_FACTS_COMPOSE, off by default; only with GAME_FACTS_READ on and research mode): when a member asks ONE plain table figure in one of a few known question shapes and the lookup returned exactly
// one row of the asked kind for the one named entity, the answer is the row's own claim and its row id (finishAnswerText adds the client table Sources line from the id), written by code. No model is called, so no second
// figure, no persona decoration and no hedge can be added; the figure is the row's.
// Why (2026-11-19 replay): with the model composing, the asked number was usually right and cited but wrapped in other figures, and a prompt rule could not stop that (docs/runbooks/game-facts.md "Composed table answer").
//
// DECLINE-BY-DEFAULT. The composer answers only when it can PROVE the question is a known shape about exactly this row; anything else returns null and the model answers unchanged:
//   - the WHOLE question, with the row's subject replaced by E (and a class name by C), must equal one of the TEMPLATES of the asked kind (an allow-list: a keyword such as "mana" or "level" inside another question
//     ("how much mana does X restore", "item level of X", "total mana for 5 casts") matches no template). Any extra word, digit, name, rank, comma list, "and", "or", "plus", "&", "/", a hedge or a second question fails it by construction.
//   - each level template belongs to one entity type (a learn/get template is for a spell row, an equip/requirement template for an item row); only "what level is E" is neutral, and then exactly one level row may exist.
//   - the subject must occur once as whole words, AS WRITTEN (not only after normalisation: "Light's Vigil" and "Lights Vigil" are two names), with nothing else name-like left over.
//   - a class named in the question must be the class of the row; a talent-rank question must say "talent" when the same name also has spell rank rows.
//   - the lookup must report no hidden row (cut: a SQL LIMIT, the per-name cap or the row budget may have dropped a candidate), exactly one name group, and no sibling row of any verdict (unverifiable rows are counted, not shown);
//     exactly one row of the asked kind; no do-not-state row; no missing rank; an unranked question never composes a rank-specific row (the table does not say the ladder is complete).
//   - the claim must name the row's subject, be plain ASCII-digit text holding only the row's own value (as a whole number), with no number words, link, mention or markup.
// Pure: no I/O, no clock.
import { normName } from "./game-facts-name.js";

const ID_RE = /^[a-z_]+:[A-Za-z0-9_.-]{1,40}$/;
const CLAIM_RE = /^[\p{L}\p{N} '’().,:+\-–%"!]{8,300}$/u;
const DOMAINISH = /[a-z0-9]\.[a-z]{2,}\b|https?|www|discord|\.gg\b/i;
const NUMBER_WORDS = /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|once|twice|thrice|half|dozen|first|second|third)\b/i;
const CLASSES = ["druid", "hunter", "mage", "paladin", "priest", "rogue", "shaman", "warlock", "warrior"];
export const GAME_FACTS_COMPOSE_MAX_WORDS = 24;

// Whole-question templates, over normName text (lower case, no punctuation, single spaces) with E = the entity and C = a class name. "( in seconds)?" is the only optional part.
// Level templates are split by entity type: SPELL (learn / get / available), ITEM (equip / requirement), and the neutral "what level is E".
const TEMPLATES = {
  spell_level: ["at what level does a player learn E", "what level do i need to be to get E", "E what level is it available from", "at what level do i learn E", "when do i learn E"],
  item_level_req: ["what level do you need to be to equip E", "can you tell me the level requirement of E", "what is the required level for E", "what is the level requirement of E", "what is the required level of E"],
  level: ["what level is E"],
  spell_cooldown: ["what is the cooldown of E( in seconds)?", "E how long is its cooldown( in seconds)?", "how many seconds is the cooldown on E", "how long is the cooldown of E( in seconds)?"],
  spell_cast_time: ["E how long is the cast( in seconds)?", "how many seconds does E take to cast", "what is the cast time of E( in seconds)?", "how long does E take to cast( in seconds)?"],
  spell_mana_cost: ["what is the mana cost of E", "how much mana does E cost", "E what does it cost in mana", "how much does E cost in mana"],
  trait_max_ranks: ["in the C talent tree how many ranks does E have", "how many ranks can you put into the C talent E", "C talent E how many ranks does it have", "how many ranks does E have"],
  trait_points_required: [
    "C talent E how many points do you need to have spent in the tree first", "what is the points requirement in the C talent tree for E", "how many talent points must be spent in the C tree before E can be learned",
    "how many points do you need to have spent in the tree before E",
  ],
  trait_prereq: ["which C talent do you need to take first before you can learn E", "C talent E which talent has to be taken before it", "in the C talent tree what is the prerequisite talent for E", "what is the prerequisite talent for E"],
};
const TEMPLATE_RES = Object.entries(TEMPLATES).flatMap(([kind, list]) => list.map((t) => ({ kind, talent: /\btalent\b/.test(t), re: new RegExp(`^${t}$`) })));

const wordsOf = (s) => (s ? s.split(" ") : []);
const straight = (s) => String(s == null ? "" : s).replace(/[‘’ʼ´`]/g, "'");

// The question as one template line: the subject (once, whole words) becomes E, any class name C. null when the subject is not there exactly once.
function templateLine(question, subjectNorm) {
  const q = wordsOf(normName(question));
  const sub = wordsOf(subjectNorm);
  if (!sub.length || !q.length) return null;
  const at = [];
  for (let i = 0; i + sub.length <= q.length; i++) if (sub.every((w, j) => q[i + j] === w)) at.push(i);
  if (at.length !== 1) return null;
  const outside = [...q.slice(0, at[0]), ...q.slice(at[0] + sub.length)];
  const classes = outside.filter((w) => CLASSES.includes(w));
  const line = [...q.slice(0, at[0]), "E", ...q.slice(at[0] + sub.length)].map((w) => (CLASSES.includes(w) ? "C" : w)).join(" ");
  return { line, classes };
}

// The subject as the person wrote it: the row's own spelling (curly quotes read as straight, case ignored) must appear in the question at word boundaries. "Lights Vigil" is not "Light's Vigil".
function writtenAsIs(question, subject) {
  const q = straight(question).toLowerCase().replace(/\s+/g, " "), sub = straight(subject).toLowerCase().replace(/\s+/g, " ");
  if (!sub) return false;
  let from = 0, found = 0;
  for (;;) {
    const i = q.indexOf(sub, from);
    if (i < 0) break;
    const before = q[i - 1], after = q[i + sub.length];
    if (!(before && /[\p{L}\p{N}]/u.test(before)) && !(after && /[\p{L}\p{N}]/u.test(after))) found++;
    from = i + 1;
  }
  return found === 1;
}

// -> { kind, talent, classes } when the whole question matches a template of that kind, else null.
export function matchTemplate(question, subjectNorm) {
  const q = String(question == null ? "" : question);
  if (!q.trim() || q.split(/\s+/).length > GAME_FACTS_COMPOSE_MAX_WORDS || (q.match(/\?/g) || []).length > 1) return null;
  if (/[&,/;+@\[\]<>`*_\\|#=~^{}\u0000-\u001f]/.test(q.replace(/,\s*in seconds\b/i, "").replace(/\btree,/i, "tree"))) return null; // lists, links, mentions, markup: not a plain question
  if (/[()]/.test(q.replace(/\(in seconds\)/i, ""))) return null;
  if (/[\p{Cf}\p{Cc}\p{Co}\p{Cn}\p{Zl}\p{Zp}"]/u.test(q)) return null; // zero-width and direction-control characters, private use, line separators, double quotes
  const t = templateLine(q, subjectNorm);
  if (t === null) return null;
  for (const x of TEMPLATE_RES) if (x.re.test(t.line)) return { kind: x.kind, talent: x.talent, classes: t.classes };
  return null;
}
export function tableFigureKind(question, subjectNorm) {
  const m = matchTemplate(question, subjectNorm);
  return m ? m.kind : null;
}

const NUM = /\d+(?:\.\d+)?/g;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The claim names the row's subject and states the row's own value and nothing numeric besides it.
function claimOk(claim, value, subject) {
  if (typeof claim !== "string" || typeof subject !== "string" || !subject) return false;
  const v = value === null || value === undefined ? "" : String(value).trim();
  if (!v) return false;
  if (!CLAIM_RE.test(claim) || DOMAINISH.test(claim)) return false;
  if (/(?![0-9])\p{N}/u.test(claim)) return false; // a non-ASCII digit, a superscript, a fraction
  const named = straight(claim).toLowerCase().includes(straight(subject).toLowerCase());
  if (!named) return false;
  const rest = straight(claim).replace(new RegExp(esc(straight(subject)), "gi"), " ");
  if (NUMBER_WORDS.test(rest)) return false;
  if (!new RegExp(`(?<![\\p{L}\\p{N}.])${esc(v)}(?![\\p{L}\\p{N}])`, "iu").test(claim)) return false;
  if (/\(rank\s*\d/i.test(claim)) return false; // a rank-specific claim is never composed from an unranked question
  for (const n of claim.match(NUM) || []) if (n !== v) return false;
  return true;
}

const classOfRow = (row) => {
  if (typeof row.hint === "string" && row.hint) return row.hint.toLowerCase();
  const m = new RegExp(`\\b(${CLASSES.join("|")})\\b`, "i").exec(String(row.claim || ""));
  return m ? m[1].toLowerCase() : null;
};

// -> { text, ids, kind } or null (the model answers). res: the reader's composeInput ({ rows, doNotSay, rankMissing, cut, groups, unverifiable }).
export function composeTableAnswer(question, res) {
  try {
    if (!res || typeof res !== "object" || res.failed === true || res.rankMissing === true || res.cut !== false || res.groups !== 1 || res.unverifiable !== 0) return null;
    const rows = Array.isArray(res.rows) ? res.rows : [];
    if (!rows.length || (Array.isArray(res.doNotSay) && res.doNotSay.length)) return null;
    const subjects = new Set(rows.map((r) => normName(r && r.subject)));
    const raws = new Set(rows.map((r) => String(r && r.subject)));
    if (subjects.size !== 1 || subjects.has("") || raws.size !== 1) return null;
    const [subject] = [...subjects], [rawSubject] = [...raws];
    if (!writtenAsIs(question, rawSubject)) return null;
    const m = matchTemplate(question, subject);
    if (!m) return null;
    const want = m.kind === "level" ? ["spell_level", "item_level_req"] : [m.kind];
    const mine = rows.filter((r) => r && want.includes(r.kind));
    if (mine.length !== 1) return null;
    const row = mine[0];
    if (row.verdict !== undefined && row.verdict !== "holds") return null;
    if (typeof row.id !== "string" || !ID_RE.test(row.id)) return null;
    if (row.rank !== undefined) return null; // rank-specific row, unranked question: the table does not say the ladder is complete
    if (m.classes.length > 1) return null;
    if (m.classes.length === 1 && classOfRow(row) !== m.classes[0]) return null;
    if (m.kind === "trait_max_ranks" && !m.talent && rows.some((r) => r && r.rank !== undefined)) return null; // spell ranks or talent ranks? only a question that says "talent" is about the talent
    const claim = String(row.claim == null ? "" : row.claim).replace(/\s+/g, " ").trim();
    if (!claimOk(claim, row.value, rawSubject)) return null;
    const end = /[.!?]$/.test(claim) ? claim : `${claim}.`;
    return { text: `**${end}** [${row.id}]`, ids: [row.id], kind: row.kind }; // the "-# Sources: client table <id>" line is added by finishAnswerText from ids
  } catch {
    return null;
  }
}
