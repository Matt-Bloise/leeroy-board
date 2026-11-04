// Production probe (B53): tests what a person actually sees on the live site, with the REAL API (no stubs, no route interception except the request counter).
//   node prod-probe.mjs [--url https://leeroy.party/] [--engines chromium,webkit,firefox] [--budget 150]
//   env PROBE_REQUIRE_ENGINES=1  an engine that is not installed FAILS the run (the workflows set it); without it the engine is skipped with a WARN
//   env PW_CHROMIUM=<path>       a Chromium binary to use
//   env GITHUB_STEP_SUMMARY      when set, a short report is appended to it
//
// What it does, per engine (Chromium, WebKit, Firefox, one after the other) and per viewport (phone 390x844, laptop 1366x768): ONE page load, "Just take a look",
// then every scene is opened in turn (the location hash, which is what a tab press sets): timeline, five, five.party, one sheet per party member (five.<slug>), roads,
// racials, legacy, buffs, ledger, signups, librarian, library, decide, tonight. It FAILS on:
//   - any console error or uncaught page error (only third-party/report-only noise is exempt: the Cloudflare beacon, "[Report Only]" CSP lines, WebKit-without-WebGL when
//     SMOKE_ALLOW_WEBKIT_NO_WEBGL=1, the same exemptions tests/browser/live-smoke.mjs has)
//   - any 4xx/5xx response from the site or its API, and any failed request to either (aborted navigations excepted)
//   - junk text in what is visible: undefined, NaN, [object Object], Infinity, unfilled {{ }}, raw ids (Discord snowflakes, UUIDs, long hex)
//   - a blank scene (under 20 characters of text after opening it)
//   - the member count: the board's name chips must equal the number of members in /api/state partyDoc (read once, by Node, at the start)
//   - wrong-count copy: when the real party has MORE than five members, no visible or hidden copy may say "five" (the phrases in NOT_PARTY, which are about five of
//     something else, are the only exceptions), "the other four" and the like, or "all/the <wrong count word> of us/you/them". With five members "five" is correct and allowed.
//
// REQUEST BUDGET. The free Cloudflare plan allows 100,000 Worker requests a day for the whole account, shared with real players and CI previews
// (docs/runbooks/cloudflare-requests.md). A Worker request is any request to /api/... (HTTP) or a WebSocket upgrade on /api/live. This probe:
//   - runs serially (one engine, one context, one page at a time) and never in parallel with itself (workflow concurrency group, no matrix)
//   - makes at most BUDGET = 150 Worker requests per run, enforced: every /api request is counted before it is sent, and once the budget is spent further ones are aborted
//     and the run FAILS with "budget"; the count is printed at the end ("Worker requests this run: N of 150") and in the job summary
//   - retries only the first page load of a context, and only once (a page left on about:blank or a failed navigation); nothing else is retried
//   - is run by the workflows once after each production deploy and once a day (cron) and by nothing else. It is NOT run per push and NOT by tests/browser/run.mjs.
// Expected cost: the reference read of /api/state (1) + per page load about 4 to 6 API requests and a socket, x 6 (3 engines x 2 viewports) = about 40; see the PR for the measured number.
// Exit 0 when everything passes, 1 on any failure, 2 on bad usage or a missing engine under PROBE_REQUIRE_ENGINES=1.
import fs from "node:fs";
import { pageUrl, originOf } from "../helpers/page-url.mjs";
import { WORDS, slugOf, junkIn, wrongCountCopy, memberCountProblem, uniq } from "../helpers/probe-checks.mjs";
const pw = await import("playwright").catch(() => { console.error("playwright not found; run npm ci in tests/"); process.exit(2); });
const argv = process.argv.slice(2), arg = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const URL_ = arg("--url", process.env.PROBE_URL || "https://leeroy.party/");
const ENGINES = arg("--engines", "chromium,webkit,firefox").split(",").map((s) => s.trim()).filter(Boolean);
const BUDGET = Number(arg("--budget", "150"));
const REQUIRE = process.env.PROBE_REQUIRE_ENGINES === "1";
if (!/^https?:\/\//.test(URL_) || ENGINES.some((e) => !["chromium", "webkit", "firefox"].includes(e)) || !(BUDGET > 0)) { console.error("usage: node prod-probe.mjs [--url <site>] [--engines chromium,webkit,firefox] [--budget 150]"); process.exit(2); }
const SITE = originOf(URL_);
const local = /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(SITE);
const API = local ? SITE : (arg("--api") || (/(^|\.)leeroy\.party$/.test(new URL(SITE).hostname) ? "https://api.leeroy.party" : SITE));
const VIEWPORTS = [{ name: "phone 390x844", width: 390, height: 844, phone: true }, { name: "laptop 1366x768", width: 1366, height: 768, phone: false }];
const TOP = ["timeline", "five", "five.party", "roads", "racials", "legacy", "buffs", "ledger", "signups", "librarian", "library", "decide", "tonight"];

let used = 0, exceeded = false;
const problems = [], notes = [];
const fail = (where, what) => { problems.push(`${where}: ${what}`); console.log(`FAIL ${where}: ${what}`); };
const pass = (what) => console.log(`PASS ${what}`);
const spend = (n = 1) => { if (used + n > BUDGET) { exceeded = true; return false; } used += n; return true; };

// 1. The reference: the real party, read once by Node.
if (!spend()) { console.error("budget too small"); process.exit(2); }
let party = null;
try {
  const r = await fetch(`${API}/api/state`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) fail("reference", `GET /api/state answered ${r.status}`);
  else { const b = await r.json(); party = b.partyDoc && Array.isArray(b.partyDoc.members) ? b.partyDoc : null; if (!party) fail("reference", "/api/state has no partyDoc.members"); }
} catch (e) { fail("reference", `GET /api/state failed: ${e.message}`); }
const N = party ? party.members.length : 0;
if (party) console.log(`INFO the real party has ${N} members (${WORDS[N] || N}) per ${API}/api/state`);
const SCENES = [...TOP.slice(0, 3), ...(party ? party.members.map((m) => `five.${slugOf(m.name)}`) : []), ...TOP.slice(3)];

// 2. What the page shows. Every string a reader or a screen reader gets: text nodes, aria-label, title, alt, placeholder; `all` also takes hidden text, the title and the meta tags.
const copyOf = (page, all) => page.evaluate((all) => {
  const out = [];
  const shown = (el) => { for (let e = el; e; e = e.parentElement) { if (e.tagName === "OPTION" || e.tagName === "SELECT") continue; const cs = getComputedStyle(e); if (cs.display === "none" || cs.visibility === "hidden") return false; } return !!el.getClientRects().length || !!el.closest("select"); };
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) { const p = n.parentElement; if (p && !/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(p.tagName) && (all || shown(p))) out.push(n.nodeValue); }
  for (const el of document.querySelectorAll("[aria-label],[title],[alt],[placeholder]")) { if (!all && !shown(el)) continue; for (const a of ["aria-label", "title", "alt", "placeholder"]) { const v = el.getAttribute(a); if (v) out.push(v); } }
  if (all) { out.push(document.title); for (const m of document.querySelectorAll('meta[name="description"],meta[property="og:description"],meta[property="og:title"],meta[name="twitter:description"],meta[name="twitter:title"]')) out.push(m.getAttribute("content") || ""); }
  return out;
}, all);

async function openScene(page, hash) {
  const top = hash.split(".")[0];
  const once = async () => {
    await page.evaluate((h) => { location.hash = h; }, hash);
    return page.waitForFunction(([k]) => document.documentElement.classList.contains("scene-open") && !document.querySelector("#scene").hidden && (() => { const p = document.querySelector(`#panel-${k}`); return !p || !p.hidden; })(), [top], { timeout: 8000 }).then(() => true, () => false);
  };
  let up = await once();
  if (!up) { await page.evaluate(() => { location.hash = ""; }); await page.waitForTimeout(800); up = await once(); } // one more try, as the other suites do
  await page.waitForTimeout(600);
  return up;
}

async function probeOne(browser, engine, vp) {
  const tag = `${engine} ${vp.name}`;
  const ctxOpts = { viewport: { width: vp.width, height: vp.height }, serviceWorkers: "block", reducedMotion: "reduce", ...(vp.phone && engine !== "firefox" ? { hasTouch: true, isMobile: true } : {}) };
  const ctx = await browser.newContext(ctxOpts);
  const errs = [], http = [], failed = [];
  // The only route: count every Worker request before it is sent, and refuse it once the budget is spent.
  await ctx.route(/\/api\//, (route) => { if (spend()) route.continue(); else route.abort("blockedbyclient"); });
  const page = await ctx.newPage();
  page.on("websocket", () => { spend(); });
  page.on("pageerror", (e) => errs.push(`uncaught: ${String(e.message).slice(0, 160)}`));
  page.on("console", (m) => { if (m.type() !== "error") return; const t = m.text(); let at = ""; try { at = (m.location() || {}).url || ""; } catch (e) {} errs.push(`${t.slice(0, 160)}${at ? ` [${at.replace(/[?#].*$/, "")}]` : ""}`); });
  const ours = (u) => { try { const o = new URL(u).origin; return o === SITE || o === API; } catch (e) { return false; } };
  page.on("response", (r) => { if (r.status() >= 400 && ours(r.url())) http.push(`${r.status()} ${r.request().method()} ${r.url().replace(/[?#].*$/, "")}`); });
  page.on("requestfailed", (r) => { const why = (r.failure() || {}).errorText || ""; if (ours(r.url()) && !/ERR_ABORTED|NS_BINDING_ABORTED|cancelled|aborted/i.test(why) && !(exceeded && /blockedbyclient|BLOCKED_BY_CLIENT/i.test(why))) failed.push(`${r.method()} ${r.url().replace(/[?#].*$/, "")} (${why})`); });
  let chips = -1;
  try {
    const target = pageUrl(URL_, { params: {} });
    try { await page.goto(target, { waitUntil: "load", timeout: 45000 }); }
    catch (e) { console.log(`WARN ${tag}: first load failed (${String(e.message).split("\n")[0]}); loading once more`); await page.goto(target, { waitUntil: "load", timeout: 45000 }); } // the one retry
    if (page.url() === "about:blank") { console.log(`WARN ${tag}: tab left on about:blank; loading once more`); await page.goto(target, { waitUntil: "load", timeout: 45000 }); }
    await page.waitForSelector("#nx-fr2-look, .tn-name", { state: "attached", timeout: 25000 }).catch(() => {});
    const look = page.locator("#nx-fr2-look");
    if (await look.count() && await look.isVisible().catch(() => false)) await look.click();
    await page.waitForSelector(".tn-name", { state: "visible", timeout: 25000 }).catch(() => {});
    await page.waitForTimeout(900);
    chips = await page.evaluate(() => Array.from(document.querySelectorAll(".tn-name")).filter((b) => b.getClientRects().length).length);
  } catch (e) { fail(tag, `the page did not load: ${String(e.message).split("\n")[0]}`); }
  if (chips >= 0) {
    const bad = memberCountProblem(chips, N);
    bad.length ? bad.forEach((b) => fail(tag, b)) : pass(`${tag} the board shows ${chips} members, the party has ${N}`);
  }
  const visible = [], everything = [];
  if (chips >= 0) {
    visible.push(...(await copyOf(page, false).catch(() => [])).map((t) => ["first screen", t]));
    for (const hash of SCENES) {
      const up = await openScene(page, hash).catch(() => false);
      if (!up) { fail(tag, `scene #${hash} did not open`); continue; }
      const top = hash.split(".")[0];
      const text = await page.evaluate((k) => { const p = document.querySelector(`#panel-${k}`) || document.querySelector("#scene"); return p ? p.innerText.replace(/\s+/g, " ").trim() : ""; }, top).catch(() => "");
      if (text.length < 20) fail(tag, `scene #${hash} is blank (${text.length} characters)`); else pass(`${tag} scene #${hash} has content`);
      visible.push(...(await copyOf(page, false).catch(() => [])).map((t) => [`#${hash}`, t]));
    }
    everything.push(...(await copyOf(page, true).catch(() => [])).map((t) => ["whole page", t]));
  }
  const origin = (pairs, strings) => (s) => { const hit = pairs.find(([, t]) => String(t).replace(/\s+/g, " ").includes(s.split('"')[1] || s)); return hit ? hit[0] : "?"; };
  const vs = uniq(visible.map((p) => p[1])), es = uniq([...visible, ...everything].map((p) => p[1]));
  for (const j of junkIn(vs)) fail(tag, `junk text, ${j} (in ${origin(visible)(j)})`);
  if (!junkIn(vs).length) pass(`${tag} no junk text in ${vs.length} visible strings`);
  const wc = wrongCountCopy(es, N);
  for (const w of wc) fail(tag, `copy states the wrong party size: ${w}`);
  if (!wc.length) pass(`${tag} no copy states a wrong party size (${es.length} strings, party ${N})`);
  const hard = errs.filter((e) => !(engine === "webkit" && process.env.SMOKE_ALLOW_WEBKIT_NO_WEBGL === "1" && /Error creating WebGL context/.test(e)) && !/cloudflareinsights\.com/.test(e) && !/^\[Report Only\]|Content Security Policy/i.test(e));
  hard.length ? hard.slice(0, 5).forEach((e) => fail(tag, `console error: ${e}`)) : pass(`${tag} no console errors`);
  http.length ? uniq(http).slice(0, 8).forEach((h) => fail(tag, `HTTP error from the site or its API: ${h}`)) : pass(`${tag} no 4xx/5xx from the site or its API`);
  failed.length ? uniq(failed).slice(0, 5).forEach((h) => fail(tag, `request failed: ${h}`)) : pass(`${tag} no failed requests`);
  await ctx.close();
}

for (const engine of ENGINES) {
  let browser;
  try { browser = await pw[engine].launch(engine === "chromium" && process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}); }
  catch (e) {
    const msg = `engine ${engine} is not available here: ${String(e.message).split("\n")[0]}`;
    if (REQUIRE) fail("engines", msg); else { console.log(`WARN ${msg}; skipped`); notes.push(`${engine} skipped`); }
    continue;
  }
  try { for (const vp of VIEWPORTS) { if (exceeded) break; await probeOne(browser, engine, vp); } }
  catch (e) { fail(engine, `probe crashed: ${String(e.message).split("\n")[0]}`); }
  finally { await browser.close().catch(() => {}); }
  notes.push(`${engine} ran`);
}
if (exceeded) fail("budget", `more than ${BUDGET} Worker requests were needed; the rest were refused`);
console.log(`\nWorker requests this run: ${used} of ${BUDGET}. Engines: ${notes.join(", ")}. Party: ${N}. ${problems.length ? `${problems.length} problem(s)` : "all checks passed"}.`);
if (process.env.GITHUB_STEP_SUMMARY) {
  try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Production probe (${SITE})\n\nWorker requests this run: **${used} of ${BUDGET}**. Engines: ${notes.join(", ")}. Party: ${N}.\n\n${problems.length ? problems.map((p) => `- ${p}`).join("\n") : "All checks passed."}\n`); } catch (e) {}
}
process.exit(problems.length ? 1 : 0);
