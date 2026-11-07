/* Cinematic slice 7: Library search, the pure parts. No DOM, no fetch, no clock, so Node imports it and tests/unit/library-search.test.mjs covers it.
   The ranking itself stays in vendor/rank-core.js (the wiki's own ranker, shared with Leeroy); this file only decides
   (1) which pages a result list leads with, and (2) what the honest empty state says and where it sends the person. */

const STOP = new Set("the a an and or of to in on at for with from by is are was were be been can could will would should do does did we our us you your they them it its this that these those what when where which who how why any some all one two about into than then there here just also only more most much very like get got have has had not no yes if so as up out off over i me my".split(" "));
/* plural and a trailing e are folded together, so "mages" and "mage" are the same word (the shared ranker's own stem does not fold them) */
const stem = (w) => w.toLowerCase().replace(/'s$/, "").replace(/ies$/, "y").replace(/([^s])s$/, "$1").replace(/e$/, "");
export const words = (s) => (String(s || "").toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) || []).filter((w) => !STOP.has(w)).map(stem).filter((w) => w.length > 1);

/* A page "is named" by the question when the question's content words are exactly the content words of the page's title or of one of its aliases:
   "mage" names Mage but not Mage spellbook, "mage spellbook" names that page, "mage portal prices" names nothing. Questions with no content words name nothing. */
export function namesPage(q, page) {
  const qw = words(q);
  if (!qw.length) return false;
  const names = [page.title, ...(page.aliases || [])];
  const qs = new Set(qw);
  return names.some((n) => { const nw = new Set(words(n)); return nw.size === qs.size && [...qs].every((w) => nw.has(w)); });
}

/* Hits come ranked by score. Pages the question names lead (their own hits keep their order), everything else follows in rank order.
   Stable, never drops or invents a hit. `pages` is [{ id, title, aliases }]. */
export function leadWithNamedPages(hits, q, pages) {
  const named = new Set((pages || []).filter((p) => namesPage(q, p)).map((p) => p.id));
  if (!named.size) return hits;
  const front = [], rest = [];
  for (const x of hits) (named.has(x.page) ? front : rest).push(x);
  return front.length && rest.length ? front.concat(rest) : hits;
}

const clip = (q, n = 60) => { const t = String(q || "").trim().replace(/\s+/g, " "); return t.length > n ? `${t.slice(0, n - 3).trim()}...` : t; };

/* The empty state. Honest: the Library does not cover it, said once, then the one next step. No guess dressed up as an answer. */
export function emptyState(q, similar) {
  const shown = clip(q);
  const near = (similar || []).slice(0, 5);
  return {
    headline: "The Library does not cover that.",
    detail: `Nothing on the shelves matches "${shown}".`,
    near,
    nearLead: near.length ? "Pages with a similar name:" : "",
    askLabel: "Ask Leeroy",
    askNote: "Leeroy reads the same Library and says so when he does not know either.",
    askHref: "#librarian",
    askDraft: String(q || "").trim().slice(0, 500),
    count: "The Library does not cover that.",
  };
}
