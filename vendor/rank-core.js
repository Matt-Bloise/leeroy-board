// The wiki ranker's pure core: question words (stop words, stems, synonyms), idf over every fact, the score of one fact
// (alias boost, key boost) and of one Open bullet. No fs, no path, no Node globals: wiki-ask.mjs imports it on the CLI side,
// and board/build-data.mjs copies it to board/vendor/rank-core.js so the Living Board ranks in the browser the way Leeroy does.
// Usage: rank(question, pages) where each page is { id, aliases: [phrase], facts: [{ key, value }], open: [bullet text] };
// returns { words, hits } with hits { score, page, key, value, open, p, f } sorted by score (stable, so equal scores keep
// page order, facts before Open bullets). Pass { hays } from factHays(pages) to skip rebuilding the idf corpus per question.
export const STOP = new Set("the a an and or of to in on at for with from by is are was were be been can could will would should do does did we our us you your they them it its this that these those what when where which who how why any some all one two about into than then there here just also only more most much very like get got have has had not no yes if so as up out off over".split(" "));
export const SYNONYMS = { zone: ["area", "starting", "start"], group: ["party", "invite", "grouping"], level: ["lvl"], raid: ["onyxia", "hyjal", "barrow"], money: ["gold", "silver", "copper", "price", "cost"], mount: ["riding"], spec: ["talent", "build"], pack: ["skyborne", "epic", "heroic", "collection"], launch: ["release", "nov"], name: ["surname", "reservation"] };
export const stem = (w) => w.toLowerCase().replace(/'s$/, "").replace(/(ies)$/, "y").replace(/(es|s)$/, "");
export function questionWords(q, stop = STOP) {
  return [...new Set((String(q).toLowerCase().match(/[a-z0-9][a-z0-9'-]+/g) || []).map(stem).filter((w) => w.length > 2 && !stop.has(w)))];
}
export function expandWords(words, synonyms = SYNONYMS) {
  const expanded = new Set(words);
  for (const w of words) for (const s of synonyms[w] || []) expanded.add(s);
  return expanded;
}
// The text a fact is matched on: dotted key as words, then the value, lower case. Aliases are appended per page in rank();
// the idf corpus ignores them.
export const factHay = (f) => (f.key.replace(/[._]/g, " ") + " " + f.value).toLowerCase();
export const factHays = (pages) => pages.flatMap((p) => p.facts.map(factHay));
// idf: a word that appears in half the facts ("level") is worth little; "zeppelin" is worth a lot. Substring match, as always.
export const idfOf = (w, hays) => Math.log((hays.length + 1) / (hays.filter((h) => h.includes(w)).length + 1)) + 0.1;
export function idfFor(expanded, hays, known) {
  const idf = {};
  for (const w of expanded) idf[w] = known && Object.prototype.hasOwnProperty.call(known, w) ? known[w] : idfOf(w, hays);
  return idf;
}
export const aliasText = (aliases) => (aliases || []).map((a) => " " + a).join("");
// A synonym target counts only at a word start ("lvl" is not inside "ilvl", "nov" not inside "novice"); question words match anywhere.
const starts = new Map();
const synIn = (hay, w) => { if (!starts.has(w)) starts.set(w, new RegExp(`(?:^|[^a-z0-9])${w.replace(/[^a-z0-9]/g, "\\$&")}`)); return starts.get(w).test(hay); };
export function scoreFact(f, alias, words, expanded, idf) {
  const hay = factHay(f) + alias;
  let score = 0;
  for (const w of expanded) if (words.includes(w) ? hay.includes(w) : synIn(hay, w)) score += idf[w] * (words.includes(w) ? 1 : 0.6);
  if (f.key.split(".").some((k) => expanded.has(stem(k)))) score += 1.5;
  return Math.round(score * 10) / 10;
}
// Plain-role questions ("what does a priest do", "what is a paladin", "is a druid a healer", "what role does a mage play") ask
// what a class is for. A page's `<class>.role` fact answers that, so it gets a bonus on such a question (and only there, and
// only when the page already matched). The words of the question stay the only evidence of WHICH class.
export const ROLE_INTENT = /\bwhat\s+(?:does|do)\s+(?:an?\s+|the\s+)?[a-z']+(?:\s+[a-z']+)?\s+do\b|\bwhat\s+(?:is|are|'s)\s+(?:an?|the)\s+[a-z']+(?:\s+[a-z']+)?\s*\??$|\bwhats\s+(?:an?\s+|the\s+)?[a-z']+\s*\??$|\bis\s+(?:an?|the)\s+[a-z']+\s+(?:an?\s+)?(?:healer|tank|dps|caster|support|damage dealer)\b|\bcan\s+(?:an?\s+|the\s+)?[a-z']+\s+(?:heal|tank)\b|\bwhat\s+(?:is|are)\s+(?:an?\s+|the\s+)?[a-z']+\s+good\s+(?:at|for)\b|\brole\b/i;
export const roleIntent = (q) => ROLE_INTENT.test(String(q));
// An Open bullet counts only at 2 or more, and is then shaded half a point below a fact with the same words.
export function scoreOpen(text, expanded, idf) {
  const hay = String(text).toLowerCase();
  let score = 0;
  for (const w of expanded) if (hay.includes(w)) score += idf[w];
  return score >= 2 ? Math.round((score - 0.5) * 10) / 10 : 0;
}
// The bonus goes only to a role fact whose owner the question names: a word of the question other than "role" is in the fact's
// key (mage.role) or in an alias of its page. Otherwise the word "role" alone would lift every class's role fact equally.
const named = (f, p, alias, expanded) => [...expanded].some((w) => w !== "role" && (f.key.split(".").slice(0, -1).some((k) => stem(k) === w) || alias.includes(w)));
// Plain answers first (fix round 2026-10-30): a newcomer's question gets a page's own answer before a beta changelog or an open
// question. The words of a page's slug are its title ("raids/onyxias-lair" is onyxia, lair; the category is left out, or every
// leveling page would be named by "level"). A page is named when a question word starts a title word (or the other way round)
// or sits in its aliases; its lead (first fact in file order) then gains LEAD (a title outranks a key segment's 1.5), and a page
// named by 3 or more question words, or by both words of a two-word question, puts its lead first outright. For the order, not the
// list: an Open bullet keeps 0.8 of its score, a value saying "superseded" 0.5, and a beta or changes line (history/ pages, keys
// with a beta segment, changes or known_issues) 0.6 unless the question asks about the beta or what changed. A question asking
// which class to play is answered by every class's role line: each scores all the question's words plus the role bonus.
export const LEAD = 2;
export const ASKS_HISTORY = /\b(?:beta|changed?|changes|patch|notes|builds?|history|stress)\b/i;
export const CLASS_PICK = /\b(?:what|which)\s+class(?:es)?\s+(?:should|to|is|are|would|do)\b/i;
const HISTORYISH = /(?:^|[._])beta(?:[._]|$)|changes|known_issues/;
export const titleWords = (id) => String(id).split("/").pop().split("-").map(stem).filter((w) => w.length > 2 && !STOP.has(w));
const r1 = (x) => Math.round(x * 10) / 10;
export function rank(q, pages, { hays = factHays(pages), idf: known = null, stop = STOP, synonyms = SYNONYMS } = {}) {
  const role = roleIntent(q), pick = CLASS_PICK.test(String(q)), plain = !ASKS_HISTORY.test(String(q));
  const words = questionWords(q, stop);
  const expanded = expandWords(words, synonyms);
  const idf = idfFor(expanded, hays, known);
  const all = words.reduce((n, w) => n + idf[w], 0);
  const hits = [];
  let lead = null, leadBy = 1;
  for (const p of pages) {
    const alias = aliasText(p.aliases), title = titleWords(p.id);
    const names = (w) => alias.includes(w) || title.some((t) => t.startsWith(w) || w.startsWith(t));
    const isNamed = [...expanded].some(names), by = words.filter(names).length, strong = by >= 3 || (by === 2 && by === words.length);
    p.facts.forEach((f, i) => {
      let score = scoreFact(f, alias, words, expanded, idf);
      if (score && role && /\.role$/.test(f.key) && named(f, p, alias, expanded)) score += 3;
      if (pick && /\.role$/.test(f.key) && p.id.startsWith("classes/")) score = Math.max(score, all) + 3;
      if (score && i === 0 && isNamed) score += LEAD;
      if (/superseded/i.test(f.value)) score *= 0.5;
      if (plain && (p.id.startsWith("history/") || HISTORYISH.test(f.key))) score *= 0.6;
      score = r1(score);
      if (!score) return;
      const h = { score, page: p.id, key: f.key, value: f.value, open: false, p, f };
      if (i === 0 && strong && by > leadBy) { lead = h; leadBy = by; }
      hits.push(h);
    });
    for (const text of p.open || []) {
      const score = r1(scoreOpen(text, expanded, idf) * 0.8);
      if (score) hits.push({ score, page: p.id, key: "OPEN", value: text, open: true, p, f: null });
    }
  }
  if (lead) lead.score = r1(Math.max(...hits.map((h) => h.score)) + 0.1);
  hits.sort((a, b) => b.score - a.score);
  return { words, hits };
}
// Every stemmed word of the facts (plus the synonym targets) with its idf, for a browser that wants it without the corpus.
export function vocabIdf(hays, synonyms = SYNONYMS) {
  const vocab = new Set(Object.values(synonyms).flat());
  for (const h of hays) for (const w of h.match(/[a-z0-9][a-z0-9'-]+/g) || []) { const s = stem(w); if (s.length > 2) vocab.add(s); }
  const out = {};
  for (const w of [...vocab].sort()) out[w] = idfOf(w, hays);
  return out;
}
