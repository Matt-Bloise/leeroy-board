// Production probe (B53): tests what a person actually sees on the live site, with the REAL API (no stubs, no route interception except the request counter).
//   node prod-probe.mjs [--url https://leeroy.party/] [--engines chromium,webkit,firefox] [--budget 150]
//   env PROBE_REQUIRE_ENGINES=1  an engine that is not installed FAILS the run (the workflows set it); without it the engine is skipped with a WARN
//   env PW_CHROMIUM=<path>       a Chromium binary to use
//   env GITHUB_STEP_SUMMARY      when set, a short report is appended to it
//
// What it does, per engine (Chromium, WebKit, Firefox, one after the other) and per viewport (phone 390x844, laptop 1366x768): ONE page load, "Just take a look",
// then every scene is opened in turn (the location hash, which is what a tab press sets): timeline, five, five.party, one sheet per party member (five.<slug>), roads,
// racials, legacy, buffs, ledger, signups, librarian, library, decide, tonight. It FAILS on:
//   - any console error or uncaught page error (only third-party/report-only noise is exempt: the Cloudflare beacon, CSP messages that say they are
//     report-only, WebKit-without-WebGL when SMOKE_ALLOW_WEBKIT_NO_WEBGL=1; an ENFORCED Content Security Policy violation fails)
//   - any 4xx/5xx response from the site itself; from the API any 5xx, and any 4xx on /api/bootstrap and /api/state (a 4xx elsewhere, for example an anonymous 401, is a
//     WARN annotation, the rule tests/browser/live-smoke.mjs has); and any failed request to either (aborted navigations excepted)
//   - junk text in what is visible: undefined, NaN, [object Object], Infinity, unfilled {{ }}, raw ids (Discord snowflakes, UUIDs, long hex)
//   - a blank scene (under 20 characters of text after opening it), a scene whose #panel-<name> does not exist, and a member route (five.<slug>) that does not land on that
//     member's card (the card must exist and carry the board's "landed" mark)
//   - the member count: the board's name chips must equal the number of members in /api/state partyDoc (read once, by Node, at the start)
//   - wrong-count copy: when the real party has MORE than five members, no visible or hidden copy may say "five" (the phrases in NOT_PARTY, which are about five of
//     something else, are the only exceptions), "the other four" and the like, or "all/the <wrong count word> of us/you/them". With five members "five" is correct and allowed.
//
// REQUEST BUDGET. The free Cloudflare plan allows 100,000 Worker requests a day for the whole account, shared with real players and CI previews
// (docs/runbooks/cloudflare-requests.md). A Worker request is any request to /api/... (HTTP) or a WebSocket upgrade on /api/live. This probe:
//   - runs serially (one engine, one context, one page at a time) and never in parallel with itself (workflow concurrency group, no matrix)
//   - makes at most BUDGET = 200 Worker requests per run, enforced: every /api request AND every /api/live WebSocket is counted BEFORE it is sent (helpers/probe-budget.mjs:
//     ctx.route for HTTP, ctx.routeWebSocket for sockets, so a socket that keeps reconnecting cannot overspend), and once the budget is spent further ones are refused
//     and the run FAILS with "budget"; the count is printed at the end ("Worker requests this run: N of 200") and in the job summary
//   - retries only the first page load of a context, and only once (a page left on about:blank or a failed navigation); nothing else is retried
//   - is run by the workflows once after each production deploy and once a day (cron) and by nothing else. It is NOT run per push and NOT by tests/browser/run.mjs.
// Expected cost: the reference read of /api/state (1) + about 26 per context (one page load, every scene, a socket) x 6 (3 engines x 2 viewports) = about 157, measured on the
// local fixture (53 for Chromium alone). Worst case 200 per run; at about 10 deploys + 1 scheduled run a day that is at most 2,200 of the 100,000 a day (about 2 percent).
// If the reference read of /api/state fails (a redirect counts as a failure), the run stops there (1 request) and launches no browser. In the browser every /api request is sent by the
// probe itself without following redirects (helpers/probe-budget.mjs): a 3xx from the API is refused and FAILS the run, so a redirect chain cannot multiply the count.
// Once the budget is spent nothing else starts: no more scenes, viewports or engines, and the run reports the budget as its one failure of that kind.
// Exit 0 when everything passes, 1 on any failure, 2 on bad usage or a missing engine under PROBE_REQUIRE_ENGINES=1.
import fs from "node:fs";
import { pageUrl, originOf } from "../helpers/page-url.mjs";
import { WORDS, slugOf, junkIn, wrongCountCopy, memberCountProblem, uniq, consoleFailures, classifyHttp, isInsightsHost } from "../helpers/probe-checks.mjs";
import { createBudget, guardContext } from "../helpers/probe-budget.mjs";
const pw = await import("playwright").catch(() => { console.error("playwright not found; run npm ci in tests/"); process.exit(2); });
const argv = process.argv.slice(2), arg = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const URL_ = arg("--url", process.env.PROBE_URL || "https://leeroy.party/");
const ENGINES = arg("--engines", "chromium,webkit,firefox").split(",").map((s) => s.trim()).filter(Boolean);
const BUDGET = Number(arg("--budget", "200"));
const VPSEL = arg("--viewports", "phone,laptop").split(",").map((s) => s.trim());
const REQUIRE = process.env.PROBE_REQUIRE_ENGINES === "1";
if (!/^https?:\/\//.test(URL_) || ENGINES.some((e) => !["chromium", "webkit", "firefox"].includes(e)) || !(BUDGET > 0)) { console.error("usage: node prod-probe.mjs [--url <site>] [--engines chromium,webkit,firefox] [--budget 200] [--viewports phone,laptop]"); process.exit(2); }
const SITE = originOf(URL_);
const local = /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(SITE);
const API = local ? SITE : (arg("--api") || (/(^|\.)leeroy\.party$/.test(new URL(SITE).hostname) ? "https://api.leeroy.party" : SITE));
const VIEWPORTS = [{ id: "phone", name: "phone 390x844", width: 390, height: 844, phone: true }, { id: "laptop", name: "laptop 1366x768", width: 1366, height: 768, phone: false }].filter((v) => VPSEL.includes(v.id));
const TOP = ["timeline", "five", "five.party", "roads", "racials", "legacy", "buffs", "ledger", "signups", "librarian", "library", "decide", "tonight"];

const budget = createBudget(BUDGET);
const problems = [], notes = [];
const fail = (where, what) => { problems.push(`${where}: ${what}`); console.log(`FAIL ${where}: ${what}`); };
const pass = (what) => console.log(`PASS ${what}`);

// 1. The reference: the real party, read once by Node. redirect: "error": Node would otherwise follow a redirect chain, each hop a Worker request the budget never saw.
if (!budget.spend()) { console.error("budget too small"); process.exit(2); }
let party = null;
try {
  const r = await fetch(`${API}/api/state`, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(20000) });
  if (!r.ok) fail("reference", `GET /api/state answered ${r.status}`);
  else { const b = await r.json(); party = b.partyDoc && Array.isArray(b.partyDoc.members) ? b.partyDoc : null; if (!party) fail("reference", "/api/state has no partyDoc.members"); }
} catch (e) { fail("reference", `GET /api/state failed: ${e.message}`); }
const N = party ? party.members.length : 0;
if (!party) {
  // No reference party, so nothing could be judged: stop here, before any browser is launched (1 Worker request spent).
  console.log(`\nAborting before any browser is launched: the reference read of ${API}/api/state failed.\nWorker requests this run: ${budget.used} of ${BUDGET}. Engines: none. Party: 0. ${problems.length} problem(s).`);
  if (process.env.GITHUB_STEP_SUMMARY) { try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Production probe (${SITE})\n\nAborted before any browser: the reference read of /api/state failed. Worker requests this run: **${budget.used} of ${BUDGET}**.\n\n${problems.map((p) => `- ${p}`).join("\n")}\n`); } catch (e) {} }
  process.exit(1);
}
const MEMBER_SLUGS = new Set(party.members.map((m) => slugOf(m.name)));
if (party) console.log(`INFO the real party has ${N} members (${WORDS[N] || N}) per ${API}/api/state`);
const SCENES = [...TOP.slice(0, 3), ...party.members.map((m) => `five.${slugOf(m.name)}`), ...TOP.slice(3)];

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

// Opens a scene and says what it found: { ok, why }. The expected #panel-<name> MUST exist and be visible (a missing panel fails), and for a member route (five.<slug>)
// that member's card in the panel must exist and carry the board's "landed" mark, so a route that ignores its hash cannot pass on the top-level panel alone.
async function openScene(page, hash) {
  const [top, sub] = hash.split(".");
  const once = async () => {
    await page.evaluate((h) => { location.hash = h; }, hash);
    return page.waitForFunction(([k]) => document.documentElement.classList.contains("scene-open") && !document.querySelector("#scene").hidden && (() => { const p = document.querySelector(`#panel-${k}`); return !!p && !p.hidden; })(), [top], { timeout: 8000 }).then(() => true, () => false);
  };
  let up = await once();
  if (!up) { await page.evaluate(() => { location.hash = ""; }); await page.waitForTimeout(800); up = await once(); } // one more try, as the other suites do
  if (!up) {
    const has = await page.evaluate((k) => !!document.querySelector(`#panel-${k}`), top).catch(() => false);
    return { ok: false, why: has ? "its panel stayed hidden" : `there is no #panel-${top} in the page` };
  }
  if (sub && MEMBER_SLUGS.has(sub)) {
    const landed = await page.waitForFunction(([k, sl]) => { const c = document.querySelector(`#panel-${k} .card[data-slug="${sl}"]`); return !!c && c.classList.contains("landed"); }, [top, sub], { timeout: 4000 }).then(() => true, () => false);
    if (!landed) {
      const card = await page.evaluate(([k, sl]) => !!document.querySelector(`#panel-${k} .card[data-slug="${sl}"]`), [top, sub]).catch(() => false);
      return { ok: false, why: card ? `the route did not land on ${sub}'s card (no "landed" mark)` : `${sub} has no card in #panel-${top}` };
    }
  }
  await page.waitForTimeout(600);
  return { ok: true };
}

async function probeOne(browser, engine, vp) {
  const tag = `${engine} ${vp.name}`;
  const ctxOpts = { viewport: { width: vp.width, height: vp.height }, serviceWorkers: "block", reducedMotion: "reduce", ...(vp.phone && engine !== "firefox" ? { hasTouch: true, isMobile: true } : {}) };
  const ctx = await browser.newContext(ctxOpts);
  const errs = [], http = [], failed = [];
  // The only routes: count every Worker request and every socket before it is sent, and refuse it once the budget is spent (helpers/probe-budget.mjs).
  await guardContext(ctx, budget);
  const page = await ctx.newPage();
  let insightsFailed = false;
  page.on("pageerror", (e) => errs.push({ text: `uncaught: ${String(e.message).slice(0, 160)}`, at: "" }));
  page.on("console", (m) => { if (m.type() !== "error") return; let at = ""; try { at = (m.location() || {}).url || ""; } catch (e) {} errs.push({ text: m.text().slice(0, 160), at: at.replace(/[?#].*$/, "") }); });
  const ours = (u) => { try { const o = new URL(u).origin; return o === SITE || o === API; } catch (e) { return false; } };
  const warned = [];
  page.on("response", (r) => {
    const v = classifyHttp(r.url(), r.status(), SITE, API), row = `${r.status()} ${r.request().method()} ${r.url().replace(/[?#].*$/, "")}`;
    if (v === "fail") http.push(row); else if (v === "warn") warned.push(row);
  });
  page.on("requestfailed", (r) => { if (isInsightsHost(r.url())) insightsFailed = true; const why = (r.failure() || {}).errorText || ""; if (ours(r.url()) && !/ERR_ABORTED|NS_BINDING_ABORTED|cancelled|aborted/i.test(why) && !(budget.exceeded && /blockedbyclient|BLOCKED_BY_CLIENT/i.test(why))) failed.push(`${r.method()} ${r.url().replace(/[?#].*$/, "")} (${why})`); });
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
  if (chips >= 0 && !budget.exceeded) {
    const bad = memberCountProblem(chips, N);
    bad.length ? bad.forEach((b) => fail(tag, b)) : pass(`${tag} the board shows ${chips} members, the party has ${N}`);
  }
  const visible = [], everything = [];
  if (chips >= 0) {
    visible.push(...(await copyOf(page, false).catch(() => [])).map((t) => ["first screen", t]));
    for (const hash of SCENES) {
      if (budget.exceeded) break; // nothing else starts once the budget is spent
      const up = await openScene(page, hash).catch((e) => ({ ok: false, why: String(e.message).split("\n")[0] }));
      if (!up.ok) { fail(tag, `scene #${hash} did not open: ${up.why}`); continue; }
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
  const hard = consoleFailures(errs, { engine, allowWebkitNoWebgl: process.env.SMOKE_ALLOW_WEBKIT_NO_WEBGL === "1", insightsRequestFailed: insightsFailed });
  hard.length ? hard.slice(0, 5).forEach((e) => fail(tag, `console error: ${e.text}${e.at ? ` [${e.at}]` : ""}`)) : pass(`${tag} no console errors`);
  for (const w of uniq(warned).slice(0, 8)) console.log(`WARN ${tag}: API 4xx (not a failure off /api/bootstrap and /api/state): ${w}\n::warning title=Production probe::${tag}: API 4xx ${w}`);
  http.length ? uniq(http).slice(0, 8).forEach((h) => fail(tag, `HTTP error (site 4xx/5xx, API 5xx, or API 4xx on bootstrap/state): ${h}`)) : pass(`${tag} no 4xx/5xx from the site or its API`);
  failed.length ? uniq(failed).slice(0, 5).forEach((h) => fail(tag, `request failed: ${h}`)) : pass(`${tag} no failed requests`);
  for (const r of budget.redirects.splice(0)) fail(tag, `the API answered with a redirect (refused, not followed): ${r}`);
  await ctx.close();
}

for (const engine of ENGINES) {
  if (budget.exceeded) { notes.push(`${engine} not run (budget spent)`); continue; } // no more browsers once the budget is spent
  let browser;
  try { browser = await pw[engine].launch(engine === "chromium" && process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}); }
  catch (e) {
    const msg = `engine ${engine} is not available here: ${String(e.message).split("\n")[0]}`;
    if (REQUIRE) fail("engines", msg); else { console.log(`WARN ${msg}; skipped`); notes.push(`${engine} skipped`); }
    continue;
  }
  let ranAny = false;
  try { for (const vp of VIEWPORTS) { if (budget.exceeded) break; ranAny = true; await probeOne(browser, engine, vp); } }
  catch (e) { fail(engine, `probe crashed: ${String(e.message).split("\n")[0]}`); }
  finally { await browser.close().catch(() => {}); }
  notes.push(ranAny ? `${engine} ran` : `${engine} not run (budget spent)`);
}
if (budget.exceeded) fail("budget", `more than ${BUDGET} Worker requests were needed; the rest were refused`);
console.log(`\nWorker requests this run: ${budget.used} of ${BUDGET}. Engines: ${notes.join(", ")}. Party: ${N}. ${problems.length ? `${problems.length} problem(s)` : "all checks passed"}.`);
if (process.env.GITHUB_STEP_SUMMARY) {
  try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Production probe (${SITE})\n\nWorker requests this run: **${budget.used} of ${BUDGET}**. Engines: ${notes.join(", ")}. Party: ${N}.\n\n${problems.length ? problems.map((p) => `- ${p}`).join("\n") : "All checks passed."}\n`); } catch (e) {}
}
process.exit(problems.length ? 1 : 0);
