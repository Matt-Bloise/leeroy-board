// A local stand-in for the live site, ONLY for proving that tests/browser/prod-probe.mjs fails when it should (tests/browser/prod-probe-selftest.mjs).
// It serves the repository as static files and answers /api/* from tests/fixtures/api-snapshot with the six-member party of tests/fixtures/six-members,
// so the probe sees a real HTTP server, real fetches and a real WebSocket upgrade. It sends nothing to Cloudflare. Never used against production.
//   const srv = await startFixtureServer({ mode: "green" });  srv.url -> "http://127.0.0.1:PORT/?brain=local";  await srv.close();
// Modes:
//   green        six members everywhere, flag party.n on: the probe must pass
//   wrong-count  the probe's own /api/state read (a request without Sec-Fetch-Site, i.e. not from a browser) lists one member more than the board shows: must fail
//   typed-five   six members but flag party.n off, so the board still says "the five" / "all five": must fail
//   junk         a member's board line carries "undefined" and "NaN": must fail
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadSnapshot, repoDoc } from "./api-stub.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..", "..");
const FIX = (n) => fs.readFileSync(path.join(ROOT, "tests", "fixtures", "six-members", `${n}.json`), "utf8");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".woff2": "font/woff2", ".woff": "font/woff", ".txt": "text/plain; charset=utf-8", ".ico": "image/x-icon" };
const STATIC_OK = /^\/(?:index\.html|404\.html|css|js|img|fonts|vendor|scenes|data|landing|rate|next|room|atlas|cloth|privacy|terms|robots\.txt|favicon\.ico|og-1200x630\.jpg)(?:\/|$|\.)/;

export async function startFixtureServer({ mode = "green" } = {}) {
  const snap = loadSnapshot();
  const party = JSON.parse(FIX("party")), signups = FIX("signups");
  if (mode === "junk") party.members[1] = { ...party.members[1], board_line: "undefined NaN Druid" };
  const rows = party.members.map((m) => ({ slug: m.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""), name: m.name, fields: { race: { value: m.race, visible: true, source: "board" }, class: { value: m.class, visible: true, source: "board" } }, updated: null }));
  const state = () => ({ ...JSON.parse(snap.routes["/state"].body), party: rows, partyDoc: party, signups: JSON.parse(signups) });
  const bootstrap = () => ({ ...JSON.parse(snap.routes["/bootstrap"].body), party, signups: JSON.parse(signups) });
  const client = () => { const j = JSON.parse(repoDoc("/data/client.json").body); j.flags = { ...(j.flags || {}), "party.n": mode !== "typed-five" }; return JSON.stringify(j); };
  const seen = { api: 0, static: 0 };
  const json = (res, body, status = 200) => { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(body); };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x"), p = u.pathname;
    if (p.startsWith("/api/")) {
      seen.api++;
      const key = p.replace(/^\/api/, "");
      if (key === "/state") {
        const s = state();
        if (mode === "wrong-count" && !req.headers["sec-fetch-site"]) s.partyDoc = { ...party, members: [...party.members, { ...party.members[0], name: "Extra Member" }] };
        return json(res, JSON.stringify(s));
      }
      if (key === "/bootstrap") return json(res, JSON.stringify(bootstrap()));
      if (key === "/data/party.json" || key === "/data/party") return json(res, JSON.stringify(party));
      if (key === "/data/signups.json" || key === "/data/signups") return json(res, signups);
      if (key === "/data/client.json" || key === "/data/client") return json(res, client());
      const hit = snap.routes[key] || repoDoc(key);
      if (hit) { res.writeHead(hit.status, { "content-type": hit.type || "application/json", "cache-control": "no-store" }); return res.end(hit.body); }
      return json(res, '{"error":"not in api-snapshot"}', 404);
    }
    if (p === "/data/client.json") { res.writeHead(200, { "content-type": TYPES[".json"], "cache-control": "no-store" }); return res.end(client()); }
    const rel = p === "/" ? "/index.html" : decodeURIComponent(p);
    const file = path.normalize(path.join(ROOT, rel));
    if (!file.startsWith(ROOT + path.sep) || !STATIC_OK.test(rel) && rel !== "/index.html") { res.writeHead(404); return res.end("not found"); }
    let f = file;
    try { if (fs.statSync(f).isDirectory()) f = path.join(f, "index.html"); } catch (e) { res.writeHead(404, { "content-type": "text/plain" }); return res.end("not found"); }
    try { const body = fs.readFileSync(f); seen.static++; res.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream", "cache-control": "no-store" }); res.end(body); } catch (e) { res.writeHead(404); res.end("not found"); }
  });
  // /api/live: accept the WebSocket upgrade and stay silent, as the stub in api-stub.mjs does.
  const socks = new Set();
  server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    if (!key) return socket.destroy();
    const acc = crypto.createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acc}\r\n\r\n`);
    socks.add(socket); socket.on("close", () => socks.delete(socket)); socket.on("error", () => {});
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return { port, origin: `http://127.0.0.1:${port}`, url: `http://127.0.0.1:${port}/?brain=local&preview=1`, seen, close: () => new Promise((r) => { for (const s of socks) s.destroy(); server.close(() => r()); }) };
}
