// Living Board library search worker (V4-SPEC 3.3). A module worker: it loads every category file of data/library/ and
// search.json off the page's thread, then answers { id, q, cap } with the ranked hits, scored by rank-core.js (the wiki's
// own ranker, copied by build-data.mjs), so typing never blocks a frame. Hits carry what a result row shows.
import { rank, factHays } from "./rank-core.js";
let pages = [], hays = [], idf = null, ready = null;
const get = (f) => fetch(new URL(`../data/library/${f}`, import.meta.url)).then((r) => { if (!r.ok) throw new Error(`${f} answered ${r.status}`); return r.json(); });
async function load() {
  const index = await get("index.json");
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
    postMessage({ id: m.id, q: m.q, words, total: hits.length, ms: Math.round((performance.now() - t0) * 10) / 10,
      hits: hits.slice(0, cap).map((h) => ({ score: h.score, page: h.page, title: h.p.title, category: h.p.category, key: h.key, value: h.value, open: h.open, refs: h.f ? h.f.refs : [] })) });
  } catch (err) { postMessage({ id: m.id, error: String(err && err.message || err) }); }
};
