// Cloudflare Pages "advanced mode" Worker (the bundler stages this folder as <bundle>/_worker.js/). It runs only for the routes in _routes.json, which are the private member data
// paths (pages-worker/private-paths.mjs), and answers 404 with Cache-Control: no-store for them on EVERY hostname of the deployment (leeroy.party, www, leeroy-board.pages.dev, the
// per-deployment and branch aliases), without ever asking the static asset layer, so a copy that layer or an edge cache still holds for an older deployment is never reached.
// Everything else that reaches it (a route variant that is not private) is handed to the assets unchanged. _headers does not apply to a Function's own responses, so the headers are set here.
// Failure is closed: if the path check itself throws, the answer is 404. docs/runbooks/member-data-worker-only.md
import { isPrivateRequestPath } from "./private-paths.mjs";

export function notFound(request) {
  return new Response(request && request.method === "HEAD" ? null : "Not found\n", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "cdn-cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

export async function handle(request, env) {
  let priv = true;
  try { priv = isPrivateRequestPath(new URL(request.url).pathname); } catch { priv = true; }
  if (priv) return notFound(request);
  return env.ASSETS.fetch(request);
}

export default { fetch: handle };
