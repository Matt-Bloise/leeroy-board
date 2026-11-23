// The Worker's entry module (wrangler.toml `main`). It exports ONLY what the Workers runtime may see: the default handler (fetch, scheduled) and the Durable Object class.
// worker/index.js also exports helpers and constants for the unit tests and for other modules (ROUTES, SHEET_FIELDS, KEPT_CACHE_CONTROL, MEMBER_NO_STORE, buildPartySheetsFromD1, ...). The local runtime
// of `wrangler dev --local` (workerd, wrangler 4.148.0) refuses an entry module with any other export: "Incorrect type for map entry 'KEPT_CACHE_CONTROL': the provided value is not of type
// 'function or ExportedHandler'", so the Worker could not be started locally on master and no change could be tried on a real runtime before a push (the steward's RULES.md, rule 1).
// This file changes nothing at run time: same handler, same class, same bindings. Production keeps working from the same code; only the module the bundler starts from is this one.
export { default } from "./index.js";
export { BoardRoom } from "./index.js";
