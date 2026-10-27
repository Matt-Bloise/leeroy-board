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
export function scoreFact(f, alias, words, expanded, idf) {
  const hay = factHay(f) + alias;
  let score = 0;
  for (const w of expanded) if (hay.includes(w)) score += idf[w] * (words.includes(w) ? 1 : 0.6);
  if (f.key.split(".").some((k) => expanded.has(stem(k)))) score += 1.5;
  return Math.round(score * 10) / 10;
}
// An Open bullet counts only at 2 or more, and is then shaded half a point below a fact with the same words.
export function scoreOpen(text, expanded, idf) {
  const hay = String(text).toLowerCase();
  let score = 0;
  for (const w of expanded) if (hay.includes(w)) score += idf[w];
  return score >= 2 ? Math.round((score - 0.5) * 10) / 10 : 0;
}
export function rank(q, pages, { hays = factHays(pages), idf: known = null, stop = STOP, synonyms = SYNONYMS } = {}) {
  const words = questionWords(q, stop);
  const expanded = expandWords(words, synonyms);
  const idf = idfFor(expanded, hays, known);
  const hits = [];
  for (const p of pages) {
    const alias = aliasText(p.aliases);
    for (const f of p.facts) {
      const score = scoreFact(f, alias, words, expanded, idf);
      if (score) hits.push({ score, page: p.id, key: f.key, value: f.value, open: false, p, f });
    }
    for (const text of p.open || []) {
      const score = scoreOpen(text, expanded, idf);
      if (score) hits.push({ score, page: p.id, key: "OPEN", value: text, open: true, p, f: null });
    }
  }
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
