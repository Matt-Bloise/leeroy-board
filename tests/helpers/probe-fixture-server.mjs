// A local stand-in for the live site, ONLY for proving that tests/browser/prod-probe.mjs fails when it should (tests/browser/prod-probe-selftest.mjs).
// It serves the repository as static files and answers /api/* from tests/fixtures/api-snapshot with the six-member party of tests/fixtures/six-members,
// so the probe sees a real HTTP server, real fetches and a real WebSocket upgrade. It sends nothing to Cloudflare. Never used against production.
//   const srv = await startFixtureServer({ mode: "green" });  srv.url -> "http://127.0.0.1:PORT/?brain=local";  await srv.close();
// Modes:
//   green        six members everywhere, flag party.n on: the probe must pass
//   wrong-count  the probe's own /api/state read (a request without Sec-Fetch-Site, i.e. not from a browser) lists one member more than the board shows: must fail
//   typed-five   six members but flag party.n off, so the board still says "the five" / "all five": must fail
//   junk         a member's race says "undefined" (and a board line "undefined NaN"): must fail
//   no-panel     #panel-ledger is removed from the page 2.5 s after load (the board has started; only that scene is affected): a missing panel must fail
//   ignored-hash member routes (five.<slug>) never land on the member's card (the "landed" mark is stripped): must fail
//   csp-enforced the page logs an ENFORCED Content Security Policy violation as a console error: must fail
//   csp-report-only the same message marked "[Report Only]": must pass (the exemption stays narrow but exists)
//   state-redirect a plain (non-browser) GET /api/state answers 302 to the real thing: the probe must NOT follow it (redirect: error) and stop, 1 API request
//   cf-text      the page logs a console error that merely MENTIONS cloudflareinsights.com (location: the page itself): must fail, the exemption is not by message text
// Any mode also serves /api/hop?n=0..11: a 12-hop redirect chain, to prove the probe's context never lets the browser follow redirects on its own.
//   state-fail   a plain (non-browser) GET /api/state answers 500: the probe must stop at once and launch no browser
//   delayed-render the sixth name chip is hidden for the first 5 s after load (the board finishing its render late): the probe's /api/state read says six. Read at once the board
//                shows five and a probe without the settle wait fails; with it the probe waits for six and passes.
//   csp-advisory WebKit's advisory (its real wording): "The Content Security Policy '...' was delivered in report-only mode, but does not specify a 'report-uri'; the policy will have no effect ...": must be exempt (pass)
//   hidden-five  hidden text (a [hidden] div, a <template>, a display:none paragraph) says "five" with six members: the probe must PASS and list it as information
//                (also hidden by: visibility:hidden, a closed <details>, zero size, content-visibility:hidden: every form must be left out of the judgement, in every engine)
//   delayed-copy a visible "Which of the five are you?" that is corrected to "six" after 4 s (the copy lags the chips): the probe waits for it and passes; without the wait it fails
//   cards-never  the member cards of #panel-five never appear: must fail, naming the selector, the count found and what the panel does contain (no fixed wait per route)
//   csp-advisory-long the WebKit advisory with a policy long enough that "report-only" lies beyond the 160th character: must be exempt (the text is matched in full, not truncated)
//   stale-first-load  a browser is given FIVE members until the page is reloaded (the probe's own /api/state read says six): the probe reloads ONCE, then passes
//   members-never     a browser is always given five: must fail with ONE count failure and no copy or scene noise (nothing is judged against a half-rendered board)
//   late-look    the "Just take a look" link is attached but not visible for the first 3 s (a slow phone or engine): the probe waits for the link, clicks it and passes; without the wait it never reveals the chips
//   late-cards   the member cards of #panel-five are missing until 7 s after load and come back without the "landed" mark: the probe waits for all cards, opens the route again, passes
//   csp-firefox-js-error / csp-firefox-js-mention  the same two Firefox messages as Playwright reports them, wrapped as `[JavaScript Error: "..." {file: ...}]`: exempt / still fails
//   visible-five a VISIBLE paragraph says "Which of the five are you?" with six members: must fail
//   csp-firefox  Firefox's report-only eval message "Content-Security-Policy: (Report-Only policy) The page's settings would block a JavaScript eval ...": exempt (pass), listed
//   csp-mention  an ENFORCED block that merely mentions report-only elsewhere (in the resource URL): must still fail
//   csp-mention-firefox  Firefox-style ENFORCED block with "(Report-Only policy)" at the END of the message: must still fail
//   csp-nonadvisory an error that starts with "The Content Security Policy" but is NOT the report-only advisory (an enforced block): must still fail
// seen.api counts HTTP requests under /api/, seen.ws the WebSocket upgrades on /api/live (the Worker requests the probe's budget stands for).
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
  if (mode === "junk") party.members[1] = { ...party.members[1], race: "undefined", board_line: "undefined NaN Druid" };
  const rows = party.members.map((m) => ({ slug: m.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""), name: m.name, fields: { race: { value: m.race, visible: true, source: "board" }, class: { value: m.class, visible: true, source: "board" } }, updated: null }));
  // stale-first-load / members-never: a BROWSER request (it carries a Referer or Sec-Fetch-Site; the probe's own Node read of /api/state does not) is answered with FIVE members.
  // stale-first-load does that only until the page has been loaded a second time (a reload), members-never always.
  const five = { ...party, members: party.members.slice(0, 5) }, fiveRows = rows.slice(0, 5);
  const staleFor = (req) => (mode === "members-never" || (mode === "stale-first-load" && seen.index <= 1)) && !!(req.headers["sec-fetch-site"] || req.headers.referer);
  const state = () => ({ ...JSON.parse(snap.routes["/state"].body), party: rows, partyDoc: party, signups: JSON.parse(signups) });
  const bootstrap = () => ({ ...JSON.parse(snap.routes["/bootstrap"].body), party, signups: JSON.parse(signups) });
  const client = () => { const j = JSON.parse(repoDoc("/data/client.json").body); j.flags = { ...(j.flags || {}), "party.n": mode !== "typed-five" }; return JSON.stringify(j); };
  const INJECT = {
    "no-panel": `setTimeout(() => { const p = document.getElementById("panel-ledger"); if (p) p.remove(); }, 2500);`,
    "ignored-hash": `new MutationObserver((ms) => { for (const m of ms) if (m.target.classList && m.target.classList.contains("landed")) m.target.classList.remove("landed"); }).observe(document.documentElement, { attributes: true, attributeFilter: ["class"], subtree: true });`,
    "csp-enforced": `setTimeout(() => console.error("Refused to load the image 'https://evil.example/x.png' because it violates the following Content Security Policy directive: \\"img-src 'self'\\"."), 1500);`,
    "cf-text": `setTimeout(() => console.error("TypeError: cannot read properties of undefined (reading x) at https://static.cloudflareinsights.com/beacon.min.js"), 1500);`,
    "delayed-render": `(() => { const hide = () => document.querySelectorAll(".tn-name").forEach((e, i) => { if (i >= 5 && !e.dataset.late) { e.dataset.late = "1"; e.style.display = "none"; } }); const obs = new MutationObserver(hide); obs.observe(document.documentElement, { childList: true, subtree: true }); hide(); setTimeout(() => { obs.disconnect(); document.querySelectorAll(".tn-name[data-late]").forEach((e) => { e.style.display = ""; delete e.dataset.late; }); }, 5000); })();`,
    "csp-advisory": `setTimeout(() => console.error("The Content Security Policy 'default-src 'self'' was delivered in report-only mode, but does not specify a 'report-uri'; the policy will have no effect. Please either add a 'report-uri' directive, or deliver the policy via the 'Content-Security-Policy' header."), 1500);`,
    "csp-nonadvisory": `setTimeout(() => console.error("The Content Security Policy 'default-src 'self'' blocked the resource https://evil.example/x.js"), 1500);`,
    "hidden-five": `(() => { const add = (tag, html, css) => { const e = document.createElement(tag); e.innerHTML = html; if (css) e.style.cssText = css; document.body.append(e); return e; }; const d = add("div", "All five have picked a spec."); d.hidden = true; const t = document.createElement("template"); t.innerHTML = "<p>Where each of the five starts</p>"; document.body.append(t); add("p", "Buff links between the five", "display:none"); add("p", "Open the five", "visibility:hidden"); add("details", "<summary>More</summary><p>Where the five start</p>"); add("div", "Swipe sideways for all five.", "display:block;width:0;height:0;overflow:hidden"); add("div", "<p>The five of us</p>", "content-visibility:hidden"); add("p", "The five (opacity)", "opacity:0"); add("div", "<p>The five (aria-hidden)</p>").setAttribute("aria-hidden", "true"); add("div", "<p>The five (inert)</p>").setAttribute("inert", ""); add("p", "Which of the six are you?", "position:fixed;left:0;bottom:0;z-index:1;background:#fff;color:#000;padding:4px"); })();`,
    "delayed-copy": `(() => { const p = document.createElement("p"); p.textContent = "Which of the five are you?"; p.style.cssText = "position:fixed;left:0;bottom:0;z-index:1;background:#fff;color:#000;padding:4px"; document.body.append(p); setTimeout(() => { p.textContent = "Which of the six are you?"; }, 4000); })();`,
    "cards-never": `(() => { const obs = new MutationObserver(() => document.querySelectorAll("#panel-five .card[data-slug]").forEach((c) => c.remove())); obs.observe(document.documentElement, { childList: true, subtree: true }); })();`,
    "csp-advisory-long": `setTimeout(() => console.error("The Content Security Policy 'default-src 'self'; script-src 'self' https://static.cloudflareinsights.com https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' https://api.leeroy.party wss://api.leeroy.party; base-uri 'self'; form-action 'self'' was delivered in report-only mode, but does not specify a 'report-uri'; the policy will have no effect. Please either add a 'report-uri' directive, or deliver the policy via the 'Content-Security-Policy' header."), 1500);`,
    "late-look": `(() => { const st = document.createElement("style"); st.textContent = "#nx-fr2-look{display:none !important}"; document.head.append(st); setTimeout(() => st.remove(), 3000); })();`,
    "late-cards": `(() => { const t0 = Date.now(), stash = []; const obs = new MutationObserver(() => { if (Date.now() - t0 > 7000) return; document.querySelectorAll("#panel-five .card[data-slug]").forEach((c) => { stash.push([c.parentNode, c]); c.remove(); }); }); obs.observe(document.documentElement, { childList: true, subtree: true }); setTimeout(() => { obs.disconnect(); for (const [par, c] of stash) par.append(c); }, 7000); })();`,
    "csp-firefox-js-error": `setTimeout(() => console.error("[JavaScript Error: \\"Content-Security-Policy: (Report-Only policy) The page's settings would block a JavaScript eval (script-src) from being executed because it violates the following directive: \\"script-src 'self'\\"\\" {file: \\"https://leeroy.party/js/x.js\\" line: 3}]"), 1500);`,
    "csp-firefox-js-mention": `setTimeout(() => console.error("[JavaScript Error: \\"Content-Security-Policy: The page's settings blocked the loading of a resource at https://evil.example/x.js (default-src) (Report-Only policy)\\" {file: \\"https://leeroy.party/js/x.js\\" line: 3}]"), 1500);`,
    "visible-five": `(() => { const p = document.createElement("p"); p.textContent = "Which of the five are you?"; p.style.cssText = "position:fixed;left:0;bottom:0;z-index:1;background:#fff;color:#000;padding:4px"; document.body.append(p); })();`,
    "csp-firefox": `setTimeout(() => console.error("Content-Security-Policy: (Report-Only policy) The page's settings would block a JavaScript eval (script-src) from being executed because it violates the following directive: \\"script-src 'self'\\""), 1500);`,
    "csp-mention": `setTimeout(() => console.error("The Content Security Policy 'default-src 'self'' blocked the resource https://evil.example/report-only.js"), 1500);`,
    "csp-mention-firefox": `setTimeout(() => console.error("Content-Security-Policy: The page's settings blocked the loading of a resource at https://evil.example/x.js (default-src) (Report-Only policy)"), 1500);`,
    "csp-report-only": `setTimeout(() => console.error("[Report Only] Refused to load the image 'https://evil.example/x.png' because it violates the following Content Security Policy directive: \\"img-src 'self'\\"."), 1500);`,
  };
  const seen = { api: 0, ws: 0, static: 0, index: 0 };
  const json = (res, body, status = 200) => { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(body); };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x"), p = u.pathname;
    if (p.startsWith("/api/")) {
      seen.api++;
      const key = p.replace(/^\/api/, "");
      if (key === "/hop") { const n = Number(u.searchParams.get("n") || 0); if (n < 12) { res.writeHead(302, { location: `/api/hop?n=${n + 1}`, "cache-control": "no-store" }); return res.end(); } return json(res, "{}"); }
      if (key === "/state") {
        if (mode === "state-redirect" && !req.headers["sec-fetch-site"] && !u.searchParams.has("r")) { res.writeHead(302, { location: "/api/state?r=1", "cache-control": "no-store" }); return res.end(); }
        if (mode === "state-fail" && !req.headers["sec-fetch-site"]) return json(res, '{"error":"fixture: state is down"}', 500);
        const s = state(); if (staleFor(req)) { s.party = fiveRows; s.partyDoc = five; }
        if (mode === "wrong-count" && !req.headers["sec-fetch-site"]) s.partyDoc = { ...party, members: [...party.members, { ...party.members[0], name: "Extra Member" }] };
        return json(res, JSON.stringify(s));
      }
      if (key === "/bootstrap") { const b = bootstrap(); if (staleFor(req)) b.party = five; return json(res, JSON.stringify(b)); }
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
    try { let body = fs.readFileSync(f); seen.static++; if (path.basename(f) === "index.html") seen.index++; if (path.basename(f) === "index.html" && INJECT[mode]) body = Buffer.from(body.toString("utf8").replace("</body>", `<script>${INJECT[mode]}</script></body>`)); res.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream", "cache-control": "no-store" }); res.end(body); } catch (e) { res.writeHead(404); res.end("not found"); }
  });
  // /api/live: accept the WebSocket upgrade and stay silent, as the stub in api-stub.mjs does.
  const socks = new Set();
  server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    seen.ws++;
    if (!key) return socket.destroy();
    const acc = crypto.createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acc}\r\n\r\n`);
    socks.add(socket); socket.on("close", () => socks.delete(socket)); socket.on("error", () => {});
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return { port, origin: `http://127.0.0.1:${port}`, url: `http://127.0.0.1:${port}/?brain=local&preview=1`, seen, close: () => new Promise((r) => { for (const s of socks) s.destroy(); server.close(() => r()); }) };
}
