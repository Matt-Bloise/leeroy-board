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
    // A "!" next to the name that is not part of the row's own spelling makes it another name ("Bite!" is not "Bite"); the template check drops punctuation, so it is decided here.
    const bang = (before === "!" && !sub.startsWith("!")) || (after === "!" && !sub.endsWith("!"));
    if (!(before && /[\p{L}\p{N}]/u.test(before)) && !(after && /[\p{L}\p{N}]/u.test(after)) && !bang) found++;
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

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const CLASS_SLOT = `(${CLASSES.map((c) => c[0].toUpperCase() + c.slice(1)).join("|")})`;
const NUMBER_VALUE = /^\d{1,6}(?:\.\d{1,3})?$/;
const NAME_VALUE = /^[\p{L}][\p{L} '’:-]{0,60}$/u;
const plural = (v, w) => `${v} ${w}${v === "1" ? "" : "s"}`;
// The loader's own claim sentence of each kind (tools/facts-load.mjs CLAIM and TRAIT_CLAIM), as a regular expression over the subject and the value. The claim must BE this sentence, whole: no other words, figure, sign, unit, qualifier or rank, and
// the subject is the whole subject (a longer name that starts with it fails). The class slot of a talent claim is read here and nowhere else. unit: what the row's unit field must be when it is set.
const SHAPES = {
  spell_level: { unit: "level", num: true, re: (s, v) => `${s} requires level ${v}\\.` },
  item_level_req: { unit: "level", num: true, re: (s, v) => `${s} has a required level of ${v}\\.` },
  spell_cooldown: { unit: "seconds", num: true, re: (s, v) => `${s} has a cooldown of ${v} seconds\\.` },
  spell_cast_time: { unit: "seconds", num: true, re: (s, v) => `${s} has a cast time of ${v} seconds\\.` },
  spell_mana_cost: { unit: "mana", num: true, re: (s, v) => `${s} costs ${v} mana\\.` },
  trait_max_ranks: { unit: "ranks", num: true, cls: true, re: (s, v) => `${s} is a ${CLASS_SLOT} talent with ${plural(v, "rank")}\\.` },
  trait_points_required: { unit: "points", num: true, cls: true, re: (s, v) => `${s} \\(${CLASS_SLOT} talent\\) needs ${plural(v, "point")} spent in its tree before it can be learned\\.` },
  trait_prereq: { unit: "", num: false, cls: true, re: (s, v) => `${s} \\(${CLASS_SLOT} talent\\) has ${v} as its prerequisite talent\\.` },
};
// The claim states the row's own value in the loader's own sentence for its kind, about exactly this subject, and nothing else. -> { cls } (the class of a talent claim, lower case, or null) or null.
function claimOk(claim, value, subject, kind, unit) {
  const shape = SHAPES[kind];
  if (!shape || typeof claim !== "string" || typeof subject !== "string" || !subject) return null;
  const v = value === null || value === undefined ? "" : String(value).trim();
  if (!v || v !== String(value)) return null;
  if (shape.num ? !NUMBER_VALUE.test(v) : !NAME_VALUE.test(v)) return null;
  if (unit !== undefined && unit !== "" && unit !== shape.unit) return null;
  if (!CLAIM_RE.test(claim) || DOMAINISH.test(claim)) return null;
  if (/(?![0-9])\p{N}/u.test(claim)) return null; // a non-ASCII digit, a superscript, a fraction
  const m = new RegExp(`^${shape.re(esc(straight(subject)), esc(v))}$`, "iu").exec(straight(claim));
  if (!m) return null;
  return { cls: shape.cls ? String(m[1]).toLowerCase() : null };
}

const CONNECTORS = new Set(["and", "or", "vs", "versus", "in", "if", "with", "without", "not", "plus", "its", "but", "at", "for", "on", "when", "then", "than", "while"]);
// A name that carries question syntax in it ("Ember and Ash", "Ember in Classic", "Ember if buffed", "Ember - not Ash").
const syntaxInName = (subject) => /\s[-–—]\s/.test(subject) || wordsOf(normName(subject)).some((w) => CONNECTORS.has(w));
const entityOf = (kind) => (kind.startsWith("spell_") ? "spell" : kind === "item_level_req" ? "item" : kind.startsWith("trait_") ? "talent" : "other");

// -> { text, ids, kind } or null (the model answers). res: the reader's composeInput ({ rows, doNotSay, rankMissing, cut, groups, unverifiable, overlap }).
export function composeTableAnswer(question, res) {
  try {
    if (!res || typeof res !== "object" || res.failed === true || res.rankMissing === true || res.cut !== false || res.groups !== 1 || res.unverifiable !== 0) return null;
    const rows = Array.isArray(res.rows) ? res.rows : [];
    if (!rows.length || (Array.isArray(res.doNotSay) && res.doNotSay.length)) return null;
    if (rows.some((r) => !r || typeof r.kind !== "string" || typeof r.id !== "string")) return null;
    const subjects = new Set(rows.map((r) => normName(r && r.subject)));
    const raws = new Set(rows.map((r) => String(r && r.subject)));
    if (subjects.size !== 1 || subjects.has("") || raws.size !== 1) return null;
    const [subject] = [...subjects], [rawSubject] = [...raws];
    if (!writtenAsIs(question, rawSubject)) return null;
    if (/\bin seconds\b/i.test(String(question)) && !/(?:,\s*|\(\s*)in seconds\b/i.test(String(question))) return null; // "in seconds" is a unit only after a comma or in brackets; "Bite in Seconds" can be a name
    if (syntaxInName(rawSubject) && res.overlap !== 0) return null; // a long name that holds a connector, with a shorter name of the question also in the table: two readings of the question
    const m = matchTemplate(question, subject);
    if (!m) return null;
    // One name, one entity: a name that is a spell AND an item, or a spell AND a talent, is two things. Only a question that says "talent" picks the talent row of a talent kind.
    const want = m.kind === "level" ? ["spell_level", "item_level_req"] : [m.kind];
    const mine = rows.filter((r) => want.includes(r.kind));
    if (mine.length !== 1) return null;
    const row = mine[0];
    const entity = entityOf(row.kind);
    if (rows.some((r) => entityOf(r.kind) !== entity) && !(m.talent && entity === "talent")) return null;
    // Among the rows of the asked entity: the same kind (and rank) twice, or two classes, makes the name ambiguous whatever kind was asked (the rows of a talent question's other entities are not part of the question).
    const same = rows.filter((r) => entityOf(r.kind) === entity);
    const seenKey = new Set();
    for (const r of same) { const k = `${r.kind}|${r.rank === undefined ? "" : r.rank}`; if (seenKey.has(k)) return null; seenKey.add(k); }
    if (new Set(same.map((r) => (typeof r.hint === "string" && r.hint ? r.hint.toLowerCase() : "")).filter(Boolean)).size > 1) return null;
    // A spell row at level 1 is the client's BaseLevel of a talent (Cruelty, Improved Cleave: "requires level 1") as often as a real level-1 spell: the table value is not when a player can take a talent. Talents with a trait row are caught by the entity rule above;
    // this closes the talents the loader has no trait row for. A real level-1 spell is answered by the model from the same row.
    if (row.kind === "spell_level" && String(row.value).trim() === "1") return null;
    if (row.verdict !== undefined && row.verdict !== "holds") return null;
    if (!ID_RE.test(row.id)) return null;
    if (row.rank !== undefined) return null; // rank-specific row, unranked question: the table does not say the ladder is complete
    if (m.classes.length > 1) return null;
    const claim = String(row.claim == null ? "" : row.claim).replace(/\s+/g, " ").trim();
    const ok = claimOk(claim, row.value, rawSubject, row.kind, row.unit);
    if (!ok) return null;
    const rowClass = typeof row.hint === "string" && row.hint ? row.hint.toLowerCase() : ok.cls;
    if (ok.cls && typeof row.hint === "string" && row.hint && row.hint.toLowerCase() !== ok.cls) return null;
    if (m.classes.length === 1 && rowClass !== m.classes[0]) return null;
    return { text: `**${claim}** [${row.id}]`, ids: [row.id], kind: row.kind }; // the "-# Sources: client table <id>" line is added by finishAnswerText from ids
  } catch {
    return null;
  }
}
