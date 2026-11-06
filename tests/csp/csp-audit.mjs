// CSP enforcement READINESS audit. Reads only, changes nothing, sends nothing to production: it opens every page of this checkout in a browser with a
// test copy of the Content-Security-Policy in ENFORCE mode and lists what that policy would block, so the owner of the back end can decide from data.
//   node tests/csp/csp-audit.mjs [--policy current|strict|both|locked] [--json out.json] [--md out.md] [--engine chromium|webkit|firefox]
//   Run `npm install` in tests/ first (Playwright). Not part of CI: it is a manual measurement (docs/csp-enforcement.md holds the last result).
// Policies (both are test copies; _headers is NOT changed and stays Report-Only):
//   current  the policy in _headers, Report-Only turned into enforce, plus the intended frame-ancestors.
//   strict   the proposed enforced policy: current, but style-src without 'unsafe-inline' (so every inline style block and style attribute is a violation).
// How: the site is served from disk under https://leeroy.party/ with Playwright route.fulfill (so the page picks the production API host and the 'self' source is
// the production origin), the Worker API is answered from tests/fixtures/api-snapshot (tests/helpers/api-stub.mjs, zero requests to the Worker), any other host is
// refused and recorded, and a securitypolicyviolation listener plus the browser console collect every block (workers and sockets report in the console).
// Pages: /, /landing/, /privacy/, /terms/, /rate/, /404.html, and /?preview=1 with each scene opened through its hash, as a first visit and with a made-up member.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installApiStub } from "../helpers/api-stub.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const pw = await import("playwright").catch(() => { console.error("playwright not found; run npm install in tests/"); process.exit(2); });
const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt; };
const POLICY_MODE = opt("--policy", "both"), ENGINE = opt("--engine", "chromium"), JSON_OUT = opt("--json", ""), MD_OUT = opt("--md", "");
const ORIGIN = "https://leeroy.party";
const FRAME_ANCESTORS = "frame-ancestors 'self' https://discord.com https://*.discordsays.com";
const SCENES = ["timeline", "five", "roads", "racials", "legacy", "buffs", "ledger", "signups", "librarian", "library", "tonight", "decide"];
const PAGES = ["/", "/landing/", "/privacy/", "/terms/", "/rate/", "/404.html"];
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".woff2": "font/woff2", ".woff": "font/woff", ".txt": "text/plain", ".ico": "image/x-icon" };

// The /* rule's Content-Security-Policy-Report-Only line from _headers.
function policyFromHeaders() {
  const block = fs.readFileSync(path.join(ROOT, "_headers"), "utf8").split(/\r?\n\r?\n/)[0];
  const line = block.split(/\r?\n/).find((l) => /^\s+Content-Security-Policy(-Report-Only)?:/i.test(l));
  if (!line) throw new Error("_headers has no Content-Security-Policy line under /*");
  return line.replace(/^\s+[^:]+:\s*/, "").trim();
}
const withDirective = (policy, name, fn) => policy.split(";").map((d) => d.trim()).filter(Boolean).map((d) => (d.split(/\s+/)[0] === name ? fn(d) : d)).join("; ");
export function buildPolicies(base) {
  const current = `${base}; ${FRAME_ANCESTORS}`;
  const strict = `${withDirective(base, "style-src", (d) => d.replace(/\s*'unsafe-inline'/, ""))}; ${FRAME_ANCESTORS}`;
  // locked is a positive control, not a proposal: scripts still run (current script-src) but connect, font, image, worker and style sources are all 'none', so the run
  // proves the audit can see blocked sockets, requests, fonts, images, workers and styles.
  const locked = `${["connect-src", "font-src", "img-src", "worker-src", "style-src"].reduce((p, d) => withDirective(p, d, () => `${d} 'none'`), base)}; ${FRAME_ANCESTORS}`;
  return { current, strict, locked };
}

function fileFor(urlPath) {
  const rel = decodeURIComponent(urlPath).replace(/^\/+/, "");
  const abs = path.join(ROOT, path.normalize(rel));
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) return null;
  for (const c of [abs, path.join(abs, "index.html")]) { try { if (fs.statSync(c).isFile()) return c; } catch {} }
  return null;
}

const hostOf = (u) => { if (/^data:?$/.test(u)) return "data:"; if (/^blob:?$/.test(u)) return "blob:"; try { const x = new URL(u); return x.protocol === "data:" ? "data:" : x.protocol === "blob:" ? "blob:" : x.host ? `${x.protocol}//${x.host}` : u; } catch { return String(u); } };
const KIND = (d) => /^script/.test(d) ? "script" : /^style/.test(d) ? "style" : /^font/.test(d) ? "font" : /^img/.test(d) ? "image" : /^connect/.test(d) ? "connect" : /^worker/.test(d) ? "worker" : /^frame/.test(d) ? "frame" : d;

async function auditPolicy(browser, label, policy) {
  const hits = new Map(), refused = new Map(), problems = [], seen = {}, seenHosts = new Set();
  const note = (type, url) => { seen[type] = (seen[type] || 0) + 1; if (/^https?:|^wss?:/.test(url)) seenHosts.add(`${type} ${hostOf(url)}`); else seenHosts.add(`${type} ${url.split(":")[0]}:`); };
  const add = (page, v) => {
    const kind = KIND(v.directive);
    const blocked = v.blocked === "inline" || v.blocked === "eval" ? v.blocked : hostOf(v.blocked);
    const src = v.source ? String(v.source).replace(ORIGIN, "").split("?")[0] : "";
    const key = [kind, v.directive, blocked, src, v.sample ? String(v.sample).slice(0, 60) : ""].join("|");
    const h = hits.get(key) || { kind, directive: v.directive, blocked, source: src, line: v.line || null, sample: v.sample ? String(v.sample).slice(0, 80) : "", pages: new Set(), count: 0 };
    h.pages.add(page); h.count += v.count || 1; hits.set(key, h);
  };
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
  await ctx.addInitScript(() => {
    window.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => window.__csp.push({ directive: e.effectiveDirective, blocked: e.blockedURI, source: e.sourceFile, line: e.lineNumber, sample: e.sample, disposition: e.disposition }), true);
  });
  await installApiStub(ctx);
  ctx.on("request", (r) => note(r.resourceType(), r.url()));
  // The site, served from disk as https://leeroy.party/, with the test policy ENFORCED on every response.
  await ctx.route(`${ORIGIN}/**`, async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname.startsWith("/api/")) return route.fallback();
    const hit = fileFor(u.pathname);
    const headers = { "content-security-policy": policy, "cache-control": "no-store" };
    if (hit) return route.fulfill({ status: 200, headers, contentType: TYPES[path.extname(hit).toLowerCase()] || "application/octet-stream", body: fs.readFileSync(hit) });
    return route.fulfill({ status: 404, headers, contentType: "text/html; charset=utf-8", body: fs.readFileSync(path.join(ROOT, "404.html")) });
  });
  // Anything else on the network (the Cloudflare analytics beacon exists on the live site only) is refused and listed, never fetched.
  await ctx.route((u) => /^https?:$/.test(u.protocol) && u.origin !== ORIGIN && u.origin !== "https://api.leeroy.party", (route) => {
    const h = hostOf(route.request().url()); refused.set(h, (refused.get(h) || 0) + 1); return route.abort();
  });

  const visit = async (name, url, member) => {
    const page = await ctx.newPage();
    page.on("websocket", (w) => note("websocket", w.url()));
    const consoleHits = [];
    page.on("console", (m) => {
      const t = m.text();
      if (!/Content Security Policy|Content-Security-Policy/i.test(t) || !/Refused/i.test(t)) return;
      if (/inline (style|script)|evaluate a string|apply inline/i.test(t)) return; // the page listener has these, with file and line
      // Worker and socket blocks never reach the page listener; the console line is the only trace of them. Same URL as a listener entry = a duplicate, dropped below.
      const what = /Refused to (?:[a-z ]+? )?['"]([^'"]+)['"]/i.exec(t);
      const dir = /directive:? "?([a-z-]+)/i.exec(t);
      consoleHits.push({ directive: dir ? dir[1] : "unknown", blocked: what ? what[1] : t.slice(0, 80), source: "console", count: 1 });
    });
    page.on("pageerror", (e) => problems.push(`${name}: pageerror ${String(e.message).slice(0, 120)}`));
    if (member) await page.addInitScript(() => { try { localStorage.setItem("board-key", "audit-key-0123456789abcdef0123"); localStorage.setItem("board-me", "santa"); } catch {} });
    try {
      await page.goto(url, { waitUntil: "load", timeout: 30000 });
      await page.waitForTimeout(1200);
      if (url.startsWith(`${ORIGIN}/?preview`)) for (const sc of SCENES) { await page.evaluate((s) => { location.hash = s; }, sc); await page.waitForTimeout(500); }
    } catch (e) { problems.push(`${name}: ${String(e.message).split("\n")[0]}`); }
    const list = await page.evaluate(() => window.__csp || []).catch(() => []);
    for (const v of list) add(name, v);
    for (const c of consoleHits) if (!list.some((v) => v.blocked === c.blocked)) add(name, c);
    await page.close();
  };
  for (const p of PAGES) await visit(p, `${ORIGIN}${p}`, false);
  await visit("/?preview=1 (first visit, all scenes)", `${ORIGIN}/?preview=1`, false);
  await visit("/?preview=1 (made-up member, all scenes)", `${ORIGIN}/?preview=1`, true);
  await ctx.close();
  const rows = [...hits.values()].map((h) => ({ ...h, pages: [...h.pages].sort() })).sort((a, b) => a.kind.localeCompare(b.kind) || b.count - a.count);
  return { label, policy, blocked: rows, seen, seenHosts: [...seenHosts].sort(), refusedHosts: Object.fromEntries(refused), problems };
}

function renderMd(results) {
  const out = [];
  for (const r of results) {
    out.push(`### Policy ${r.label}: ${r.blocked.length} distinct block${r.blocked.length === 1 ? "" : "s"}`, "");
    if (!r.blocked.length) out.push("Nothing blocked on any page.", "");
    else {
      out.push("| Kind | Directive | Blocked | Source | Sample | Pages | Count |", "| --- | --- | --- | --- | --- | ---: | ---: |");
      for (const b of r.blocked) out.push(`| ${b.kind} | ${b.directive} | \`${b.blocked}\` | ${b.source ? `\`${b.source}${b.line ? ":" + b.line : ""}\`` : ""} | ${b.sample ? "`" + b.sample.replace(/\|/g, "/").replace(/`/g, "'") + "`" : ""} | ${b.pages.length} | ${b.count} |`);
      out.push("");
    }
    out.push(`Requests the audit saw (so "nothing blocked" means something): ${Object.entries(r.seen).map(([k, n]) => `${k} ${n}`).join(", ")}.`, "", `Hosts and kinds: ${r.seenHosts.map((h) => "`" + h + "`").join(", ")}.`, "");
    const hosts = Object.entries(r.refusedHosts);
    out.push(`Hosts the pages asked for outside the site and the API (refused by the audit, never fetched): ${hosts.length ? hosts.map(([h, n]) => `\`${h}\` x${n}`).join(", ") : "none"}.`, "");
    if (r.problems.length) out.push("Audit notes:", ...r.problems.slice(0, 20).map((p) => `- ${p}`), "");
  }
  return out.join("\n");
}

const base = policyFromHeaders();
const policies = buildPolicies(base);
const wanted = POLICY_MODE === "both" ? ["current", "strict"] : [POLICY_MODE]; // --policy locked runs the positive control
if (!wanted.every((w) => policies[w])) { console.error("--policy must be current, strict or both"); process.exit(2); }
const browser = await pw[ENGINE].launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ["--no-sandbox"] } : {});
const results = [];
for (const w of wanted) results.push(await auditPolicy(browser, w, policies[w]));
await browser.close();
const md = renderMd(results);
console.log(md);
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ engine: ENGINE, base, results }, null, 2));
if (MD_OUT) fs.writeFileSync(MD_OUT, md);
