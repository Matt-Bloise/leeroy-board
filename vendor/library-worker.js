// Living Board library search worker (V4-SPEC 3.3). A module worker: it loads every category file of data/library/ and
// search.json off the page's thread, then answers { id, q, cap, full, cat, more } with the ranked hits, scored by rank-core.js (the wiki's
// own ranker, copied by build-data.mjs), so typing never blocks a frame. Hits carry what a result row shows.
import { rank, factHays } from "./rank-core.js?v=16d8a1283e";
let pages = [], hays = [], idf = null, ready = null;
/* V11 cache stamps: index.json loads with "no-cache" and names every other file's stamp, which rides on its URL */
let stamps = {};
const get = (f) => fetch(new URL(`../data/library/${f}${stamps[f] ? `?v=${stamps[f]}` : ""}`, import.meta.url), f === "index.json" ? { cache: "no-cache" } : {}).then((r) => { if (!r.ok) throw new Error(`${f} answered ${r.status}`); return r.json(); });
async function load() {
  const index = await get("index.json");
  stamps = index.stamps || {};
  const [cats, search] = await Promise.all([Promise.all(index.categories.map((c) => get(`${c.key}.json`))), get("search.json").catch(() => null)]);
  const byId = {};
  for (const c of cats) for (const p of c.pages) byId[p.id] = p;
  pages = index.pages.map((h) => byId[h.id]).filter(Boolean).map((p) => ({ id: p.id, title: p.title, category: p.category, aliases: p.aliases, facts: p.facts, open: p.open }));
  hays = factHays(pages);
  idf = search && search.idf ? search.idf : null;
  return { pages: pages.length, facts: hays.length };
}
onmessage = async (e) => {
  const m = e.data || {};
  try {
    ready ||= load();
    const info = await ready;
    if (m.q === undefined) { postMessage({ ready: true, ...info }); return; }
    const t0 = performance.now();
    const { words, hits } = rank(m.q, pages, { hays, idf });
    const cap = m.cap || 400;
    /* V13a: only the rows the page can show carry their text: the first `full` hits on the shelf asked for (`cat`, or every
       shelf). The rest come slim (page, title, shelf, score), enough for the counts; the page asks again for more. */
    /* the page draws rows grouped by page in first-hit order, so the rows it draws first are picked the same way */
    const top = hits.slice(0, cap), groups = new Map(), full = new Set();
    for (const h of top) if (!m.cat || h.p.category === m.cat) { if (!groups.has(h.page)) groups.set(h.page, []); groups.get(h.page).push(h); }
    let left = m.full > 0 ? m.full : Infinity;
    for (const list of groups.values()) { for (const h of list) { if (left <= 0) break; full.add(h); left--; } if (left <= 0) break; }
    postMessage({ id: m.id, q: m.q, words, total: hits.length, ms: Math.round((performance.now() - t0) * 10) / 10, more: !!m.more, full: m.full || 0, cat: m.cat || "",
      hits: top.map((h) => {
        const slim = { score: h.score, page: h.page, title: h.p.title, category: h.p.category };
        return full.has(h) ? { ...slim, key: h.key, value: h.value, open: h.open, refs: h.f ? h.f.refs : [] } : slim;
      }) });
  } catch (err) { postMessage({ id: m.id, error: String(err && err.message || err) }); }
};
