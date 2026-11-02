// Pure helper: read a board key from the request headers only. The URL query string is deliberately
// not consulted: a key in a URL ends up in access logs, browser history and referrers.
export function extractKey(req) {
  const auth = req.headers.get("Authorization") || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
  if (auth.startsWith("Board ")) return auth.slice(6).trim();
  const h = req.headers.get("X-Board-Key");
  return h ? h.trim() : "";
}
