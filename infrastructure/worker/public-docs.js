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
