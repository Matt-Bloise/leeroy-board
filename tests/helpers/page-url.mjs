// Builds page URLs from a --url / PREVIEW_PAGES value that may already carry a query string (for example
// http://127.0.0.1:8080/?brain=http://127.0.0.1:8787) or a hash. String concatenation (`${BASE}/?preview=1`) turns that into a broken URL
// with two question marks, so every browser suite builds its URLs here with the URL class.
//   pageUrl(base, { path: "rate/", params: { preview: "1" }, defaults: { brain: "local" }, hash: "five" })
//   params    always set (replaces a value already in the base)
//   defaults  set only when the base does not already carry that key (so a caller's ?brain=... wins)
// The base is treated as a directory: "https://x/app" and "https://x/app/" both give "https://x/app/".
export function pageUrl(base, { path = "", params = {}, defaults = {}, hash = null } = {}) {
  const u = new URL(base);
  if (!u.pathname.endsWith("/")) u.pathname += "/";
  if (path) u.pathname += String(path).replace(/^\/+/, "");
  for (const [k, v] of Object.entries(defaults)) if (v != null && !u.searchParams.has(k)) u.searchParams.set(k, v);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  if (hash != null) u.hash = hash;
  return u.href;
}
// The site origin of a base (no path, no query).
export const originOf = (base) => new URL(base).origin;
// A base without its query and hash, always ending in "/": for resolving data files and paths next to the page.
export function dirOf(base) { const u = new URL(base); u.search = ""; u.hash = ""; if (!u.pathname.endsWith("/")) u.pathname += "/"; return u.href; }
