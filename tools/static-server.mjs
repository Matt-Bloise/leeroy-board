// Tiny static file server for local browser runs (tools/local-browser.sh): serves the repo root like Cloudflare Pages does
// (directory index, 404.html with status 404, no clean-URL redirects, the rules of the repo's _headers file joined per header as Pages does,
// and Pages' default Cache-Control "public, max-age=0, must-revalidate" when no rule sets one). Listens on 127.0.0.1 only. No dependencies.
//   node tools/static-server.mjs [port=8080] [root=repo root]
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2] || 8080), ROOT = path.resolve(process.argv[3] || path.join(here, ".."));
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".avif": "image/avif", ".woff2": "font/woff2", ".woff": "font/woff", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml", ".webmanifest": "application/manifest+json", ".ico": "image/x-icon", ".mp3": "audio/mpeg", ".wasm": "application/wasm" };
// _headers: a line starting in column 0 is a path pattern (`*` = anything, `:name` = one segment); indented `Name: value` lines belong to it. Every matching rule applies; same header names are joined with ", ".
const RULES = [];
try {
  let cur = null;
  for (const line of readFileSync(path.join(ROOT, "_headers"), "utf8").split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) { cur = { re: new RegExp("^" + line.trim().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "(.*)").replace(/:\w+/g, "[^/]+") + "$"), h: [] }; RULES.push(cur); }
    else if (cur) { const i = line.indexOf(":"); if (i > 0) cur.h.push([line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim()]); }
  }
} catch {}
function ruleHeaders(rel) {
  const out = {};
  for (const r of RULES) if (r.re.test(rel)) for (const [k, v] of r.h) out[k] = out[k] ? `${out[k]}, ${v}` : v;
  return out;
}
async function file(p) { try { const s = await stat(p); return s.isFile() ? p : s.isDirectory() ? file(path.join(p, "index.html")) : null; } catch { return null; } }
http.createServer(async (req, res) => {
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, "http://x").pathname); } catch { res.writeHead(400).end(); return; }
  const abs = path.join(ROOT, path.normalize(rel));
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }
  const hit = await file(abs), notFound = !hit;
  const target = hit || (await file(path.join(ROOT, "404.html")));
  if (!target) { res.writeHead(404, { "content-type": "text/plain" }).end("not found"); return; }
  const body = await readFile(target);
  res.writeHead(notFound ? 404 : 200, { "cache-control": "public, max-age=0, must-revalidate", ...ruleHeaders(rel), "content-type": TYPES[path.extname(target).toLowerCase()] || "application/octet-stream" });
  res.end(req.method === "HEAD" ? undefined : body);
}).listen(PORT, "127.0.0.1", () => console.log(`static server on http://127.0.0.1:${PORT}/ (root ${ROOT})`));
