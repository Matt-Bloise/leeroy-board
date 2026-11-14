// Allow list for the public document routes GET /api/data/<name> and GET /api/atlas/<name>.
// Both routes read kv_state, which also holds configuration and private working rows. Only the documents the public
// site fetches are served; every other name answers 404. Names carry no .json suffix and no ids.
// Evidence for each name (file and line that fetches it) is in the pull request that introduced this file.
// Adding a document the site starts to fetch means adding its name here in the same change.

// /api/data/<name>: js/board.js apiFetch maps any `data/<name>.json` request to this route.
export const PUBLIC_DATA_DOCS = new Set([
  "party", "timeline", "client", "stats", "signups", "tonight", // js/board.js DATA_NAMES and the optional pair
  "launch", // js/v15.js
  "decide", // scenes/decide.js
  "guided-atlas", // scenes/guided-atlas.js
]);

// /api/atlas/<name>: js/atlas-hook.js (marks) and atlas/atlas.js (links).
export const PUBLIC_ATLAS_DOCS = new Set(["marks", "links"]);

const clean = (name) => String(name == null ? "" : name).trim();

export function isPublicDataDoc(name) {
  return PUBLIC_DATA_DOCS.has(clean(name));
}

export function isPublicAtlasDoc(name) {
  return PUBLIC_ATLAS_DOCS.has(clean(name));
}

// The stored stats row also carries `recent`: the last 15 shared questions, answers and asker names (ai-models.js). The site
// never renders it, and the privacy page promises shared answers to the group, not to anyone who asks the server, so the
// public reads (GET /api/data/stats, /api/state, /api/bootstrap) serve only these keys: the shape feed.js builds plus `updated`.
export const PUBLIC_STATS_KEYS = [
  "generated", "answers", "replies", "noreply", "median_s", "p95_s", "max_s", "miss_threshold_s", "misses",
  "last7", "wiki_pages", "wiki_facts", "index_generated", "updated",
];

const isoMs = (v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v) ? Date.parse(v) : NaN);

// The public form of a stored data document. `generated` is what the board footer reads as the records' date
// ("Generated from the group's own records on ..."). Only the retired PC publisher set it; Worker writes (a sheet or build
// change on the party row, an answer on the stats row) update the row's updated_at only. So the later of the two is served.
// The stored row is not changed: party-source.js seeds sheet timestamps from the stored party.generated.
export function publicDataDoc(name, doc, updatedAt) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return doc;
  let out = doc;
  if (clean(name) === "stats") {
    out = {};
    for (const k of PUBLIC_STATS_KEYS) if (k in doc) out[k] = doc[k];
  }
  const g = isoMs(out.generated), u = isoMs(updatedAt);
  if (Number.isFinite(g) && Number.isFinite(u) && u > g) out = { ...out, generated: new Date(u).toISOString() };
  return out;
}
