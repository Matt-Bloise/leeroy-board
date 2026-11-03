// Answers the board's Worker API from a recorded snapshot (tests/fixtures/api-snapshot/snapshot.json) with Playwright route interception,
// so a browser suite that judges layout or client behaviour sends ZERO requests to the Worker. Every GET under /api/ (any origin:
// api.leeroy.party, a workers.dev preview, http://127.0.0.1:8787) is fulfilled from the snapshot; the live socket (/api/live) is accepted and stays silent.
//   const stub = await installApiStub(context);   // before the first page.goto
//   ... run the checks ...
//   stub.report()   -> { served, writes, misses }   misses = API paths the page asked for that the snapshot does not have (the fixture is stale: re-record)
// /api/data|library|atlas/<file> come from the repo's data/ folder (same bytes the Worker serves); everything dynamic (bootstrap, state, votes) from the snapshot.
// Record the snapshot with:  tools/local-browser.sh record-fixtures   (from the local Worker and the seeded D1, nothing from production)
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
export const SNAPSHOT_PATH = path.join(here, "..", "fixtures", "api-snapshot", "snapshot.json");
let cached = null;
// The Worker serves /api/data/<x>, /api/library/<x> and /api/atlas/<x> from D1 rows seeded from the repo's data/ files, byte for byte the same JSON
// (checked when the snapshot was recorded), so the stub reads those from data/ instead of duplicating 1.5 MB in the snapshot.
const DATA = path.join(here, "..", "..", "data");
export function repoDoc(key) {
  const m = key.match(/^\/(data|library|atlas)\/([A-Za-z0-9._-]+)$/);
  if (!m) return null;
  const f = path.join(DATA, m[1] === "data" ? "" : m[1], m[2]);
  return existsSync(f) ? { status: 200, type: "application/json; charset=utf-8", body: readFileSync(f, "utf8") } : null;
}
export function loadSnapshot(file = SNAPSHOT_PATH) { return (cached ||= JSON.parse(readFileSync(file, "utf8"))); }

// What a suite's own route handler gets from `route.fetch()` on an API URL: the snapshot answer instead of a request to the Worker (same methods as Playwright's APIResponse).
export function snapshotResponse(key, snapshot = loadSnapshot()) {
  const hit = snapshot.routes[key] || repoDoc(key) || { status: 404, type: "application/json", body: '{"error":"not in api-snapshot"}' };
  return { status: () => hit.status, ok: () => hit.status < 400, headers: () => ({ "content-type": hit.type, ...(hit.etag ? { etag: hit.etag } : {}) }), text: async () => hit.body, json: async () => JSON.parse(hit.body), body: async () => Buffer.from(hit.body), url: () => key };
}

export async function installApiStub(context, { snapshot = loadSnapshot() } = {}) {
  const served = {}, writes = [], misses = new Set();
  const cors = (req) => ({ "access-control-allow-origin": req.headers()["origin"] || "*", "access-control-allow-credentials": "true", "access-control-expose-headers": "ETag", "access-control-allow-headers": "Authorization, Content-Type, If-None-Match, If-Match", "access-control-allow-methods": "GET, HEAD, PUT, POST, DELETE, OPTIONS", vary: "Origin" });
  // a suite's own handler (registered later, so it runs first) often does `const res = await route.fetch(); ...change it...; route.fulfill(...)`; on an API URL that fetch must not reach the Worker either
  const addRoute = context.route.bind(context);
  context.route = (matcher, handler, options) => addRoute(matcher, (route, request) => {
    const plain = route.fetch.bind(route);
    route.fetch = (o = {}) => { const u = new URL(o.url || route.request().url()); return /^\/api\//.test(u.pathname) && !o.method && !o.postData ? Promise.resolve(snapshotResponse(u.pathname.replace(/^\/api/, ""), snapshot)) : plain(o); };
    return handler(route, request);
  }, options);
  await addRoute((u) => /^\/api\//.test(u.pathname) && !/^wss?:$/.test(u.protocol), async (route) => {
    const req = route.request(), u = new URL(req.url()), key = u.pathname.replace(/^\/api/, ""), method = req.method();
    if (method === "OPTIONS") return route.fulfill({ status: 204, headers: cors(req) });
    if (method !== "GET" && method !== "HEAD") { writes.push(`${method} ${key}`); return route.fulfill({ status: 200, contentType: "application/json", headers: cors(req), body: '{"ok":true}' }); }
    const hit = snapshot.routes[key] || repoDoc(key);
    if (!hit) { misses.add(`${method} ${key}`); return route.fulfill({ status: 404, contentType: "application/json", headers: cors(req), body: '{"error":"not in api-snapshot"}' }); }
    served[key] = (served[key] || 0) + 1;
    return route.fulfill({ status: hit.status, contentType: hit.type, headers: { ...cors(req), "cache-control": "no-store", ...(hit.etag ? { etag: hit.etag } : {}) }, body: method === "HEAD" ? "" : hit.body });
  });
  // the live socket: accepted, never connected to a server, no frames. The page treats a silent socket like a quiet room.
  if (typeof context.routeWebSocket === "function") await context.routeWebSocket(/\/api\/live/, () => {});
  return { report: () => ({ served: Object.values(served).reduce((a, b) => a + b, 0), servedByPath: { ...served }, writes: [...writes], misses: [...misses] }) };
}
