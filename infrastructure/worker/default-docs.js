// Documents the Worker serves from the copy bundled with it when kv_state has no row of that name. Today that is `client` only: scripts/seed-d1.mjs never wrote it, so
// GET /api/data/client answered 404 and a board that reads member documents from the API alone (js/board.js dataGet, fail closed) would show nothing.
// The bundled copy is the repository's data/client.json, imported by the deploy bundler. The route projects it exactly as it projects a stored row (projectDataDoc), so a
// default document never carries a hidden member's class or race. A stored row, when there is one, always wins.
import client from "../../data/client.json" with { type: "json" };

const DEFAULTS = Object.freeze({ client });

// The row shape the /data route reads ({ json, updated_at }), or null when the name has no bundled default.
export function defaultDocRow(name) {
  return Object.hasOwn(DEFAULTS, name) ? { json: JSON.stringify(DEFAULTS[name]), updated_at: null } : null;
}
