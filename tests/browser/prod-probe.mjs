// Production probe (B53): tests what a person actually sees on the live site, with the REAL API (no stubs, no route interception except the request counter).
//   node prod-probe.mjs [--url https://leeroy.party/] [--engines chromium,webkit,firefox] [--budget 150] [--clock <iso>]
//   --clock <iso>  only for the local self-test: the page clock is set to that instant. Production runs use the real time on purpose (what a visitor sees RIGHT NOW, the launch wall included).
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
//   - the member count: the board's name chips must equal the number of members in /api/state partyDoc (read once, by Node, at the start); the probe first WAITS (DOM polling only, up to 10 s)
//     for the chips to reach that number, because the board finishes rendering them a little after the first paint; before the first party-size judgement of a scene it also
//     waits (bounded, visible text only) for the copy that counts the party to catch up, and before a member route it waits for all the member cards
//   - wrong-count copy: when the real party has MORE than five members, no VISIBLE copy (the text a visitor can read in the scene they are in) may say "five" (the phrases in NOT_PARTY, which are about five of
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
// If the reference read of /api/state fails (a redirect counts as a failure), the run stops there (1 request) and launches no browser. In the browser every /api request is counted and
// then sent by the browser itself (helpers/probe-budget.mjs); a redirect it follows is counted hop by hop and FAILS the run (the browser bounds one chain at 20 hops).
// Once the budget is spent nothing else starts: no more scenes, viewports or engines, and the run reports the budget as its one failure of that kind.
// Exit 0 when everything passes, 1 on any failure, 2 on bad usage or a missing engine under PROBE_REQUIRE_ENGINES=1.
import fs from "node:fs";
import { pageUrl, originOf } from "../helpers/page-url.mjs";
import { WORDS, slugOf, junkIn, wrongCountCopy, memberCountProblem, uniq, consoleFailures, exemptedAdvisories, classifyHttp, isInsightsHost } from "../helpers/probe-checks.mjs";
import { createBudget, guardContext } from "../helpers/probe-budget.mjs";
import { parseClock } from "../helpers/clock-arg.mjs";
const pw = await import("playwright").catch(() => { console.error("playwright not found; run npm ci in tests/"); process.exit(2); });
const argv = process.argv.slice(2), arg = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const URL_ = arg("--url", process.env.PROBE_URL || "https://leeroy.party/");
const ENGINES = arg("--engines", "chromium,webkit,firefox").split(",").map((s) => s.trim()).filter(Boolean);
const BUDGET = Number(arg("--budget", "200"));
const VPSEL = arg("--viewports", "phone,laptop").split(",").map((s) => s.trim());
const REQUIRE = process.env.PROBE_REQUIRE_ENGINES === "1";
let CLOCK = null;
try { CLOCK = parseClock(argv); } catch (e) { console.error(e.message); process.exit(2); }
if (!/^https?:\/\//.test(URL_) || ENGINES.some((e) => !["chromium", "webkit", "firefox"].includes(e)) || !(BUDGET > 0)) { console.error("usage: node prod-probe.mjs [--url <site>] [--engines chromium,webkit,firefox] [--budget 200] [--viewports phone,laptop]"); process.exit(2); }
const SITE = originOf(URL_);
const local = /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(SITE);
const API = arg("--api") || (local ? SITE : (/(^|\.)leeroy\.party$/.test(new URL(SITE).hostname) ? "https://api.leeroy.party" : SITE));
const VIEWPORTS = [{ id: "phone", name: "phone 390x844", width: 390, height: 844, phone: true }, { id: "laptop", name: "laptop 1366x768", width: 1366, height: 768, phone: false }].filter((v) => VPSEL.includes(v.id));
const TOP = ["timeline", "five", "five.party", "roads", "racials", "legacy", "buffs", "ledger", "signups", "librarian", "library", "decide", "tonight"];

const budget = createBudget(BUDGET);
// How /api requests are routed (helpers/probe-budget.mjs): default "browser" = counted, then sent by the browser itself (what a visitor's browser does: its own CORS handling and HTTP cache);
// PROBE_API_ROUTE=fetch = the older mode where the probe sent them with route.fetch and gave the page the answer with route.fulfill (a 3xx is refused there). The older mode made Firefox
// fall back to the static 5-member data/party.json on production; keep it for comparison only, never in the workflows.
const API_ROUTE = process.env.PROBE_API_ROUTE === "fetch" ? "fetch" : "browser";
if (API_ROUTE === "fetch") console.log("WARN PROBE_API_ROUTE=fetch: the probe sends /api requests itself and fulfils the page with the answer (the older mode, known to change what Firefox shows); comparison only");
const problems = [], notes = [], hiddenCopy = new Set(), advisories = new Set();
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

// 2. What the page shows. mode "text": the VISIBLE text only (text nodes of elements that are displayed: not display:none, visibility:hidden, inside a [hidden] element or a closed
// panel, or zero-size), which is what a visitor reads and what the party-size check judges. mode "visible": the same plus the aria-label/title/alt/placeholder of visible elements
// (junk check). mode "all": everything in the DOM, hidden text, templates, the title and the meta tags (only ever reported as information, never a failure).
const copyOf = (page, mode) => page.evaluate((mode) => {
  const out = [];
  const shown = (el) => {
    // Walk every ancestor: [hidden], inert, aria-hidden="true" (a closed or off-stage panel is often marked that way and may still have a box), display:none, visibility:hidden, opacity:0.
    for (let e = el; e; e = e.parentElement) { if (e.tagName === "OPTION" || e.tagName === "SELECT") continue; if (e.hasAttribute && (e.hasAttribute("hidden") || e.hasAttribute("inert") || e.getAttribute("aria-hidden") === "true")) return false; const cs = getComputedStyle(e); if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return false; }
    if (el.closest("select")) return true;
    // The same test in every engine: the spec'd Element.checkVisibility() where the engine has it (Chromium 105+, Firefox 106+, WebKit 17.4+: false for display:none, content-visibility:hidden
    // and the closed <details> content), AND the computed-style walk above, AND a real box with a size: no engine-specific shortcut decides on its own.
    if (typeof el.checkVisibility === "function" && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true })) return false;
    return Array.from(el.getClientRects()).some((r) => r.width > 0 && r.height > 0);
  };
  const all = mode === "all";
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) { const p = n.parentElement; if (p && !/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(p.tagName) && (all || shown(p))) out.push(n.nodeValue); }
  if (mode !== "text") for (const el of document.querySelectorAll("[aria-label],[title],[alt],[placeholder]")) { if (!all && !shown(el)) continue; for (const a of ["aria-label", "title", "alt", "placeholder"]) { const v = el.getAttribute(a); if (v) out.push(v); } }
  if (all) { out.push(document.title); for (const m of document.querySelectorAll('meta[name="description"],meta[property="og:description"],meta[property="og:title"],meta[name="twitter:description"],meta[name="twitter:title"]')) out.push(m.getAttribute("content") || ""); for (const t of document.querySelectorAll("template")) out.push(t.innerHTML.replace(/<[^>]+>/g, " ")); }
  return out;
}, mode);

// Opens a scene and says what it found: { ok, why }. The expected #panel-<name> MUST exist and be visible (a missing panel fails), and for a member route (five.<slug>)
// that member's card in the panel must exist and carry the board's "landed" mark, so a route that ignores its hash cannot pass on the top-level panel alone.
async function openScene(page, hash, state = {}) {
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
    // Wait for the member CARDS of the panel this assertion reads (all N of them, DOM only, bounded by 10 s): the board can re-render the party after the scene opened, which replaces
    // the cards and drops the "landed" mark. If the mark is gone once the cards are all there, open the route once more, then judge.
    const landedNow = (ms) => page.waitForFunction(([k, sl]) => { const c = document.querySelector(`#panel-${k} .card[data-slug="${sl}"]`); return !!c && c.classList.contains("landed"); }, [top, sub], { timeout: ms }).then(() => true, () => false);
    const SEL = `#panel-${top} .card[data-slug]`;
    const cardsUp = () => page.waitForFunction(([sel, want]) => document.querySelectorAll(sel).length === want, [SEL, MEMBER_SLUGS.size], { timeout: state.cardsGaveUp ? 1500 : 10000, polling: 250 }).then(() => true, () => false);
    const allCards = await cardsUp();
    if (!allCards) state.cardsGaveUp = true; // one bounded wait per context, not one per member route
    let landed = await landedNow(allCards ? 1500 : 3000);
    if (!landed && allCards) { await page.evaluate(() => { location.hash = ""; }); await page.waitForTimeout(500); await page.evaluate((h) => { location.hash = h; }, hash); landed = await landedNow(6000); }
    if (!landed) {
      const have = await page.evaluate(([k, sl]) => { const p = document.querySelector(`#panel-${k}`); return { card: !!document.querySelector(`#panel-${k} .card[data-slug="${sl}"]`), n: document.querySelectorAll(`#panel-${k} .card[data-slug]`).length, cards: document.querySelectorAll(`#panel-${k} .card`).length, named: p ? p.innerText.toLowerCase().includes(sl.split("-")[0]) : false, slugs: Array.from(document.querySelectorAll(`#panel-${k} .card[data-slug]`)).map((c) => c.getAttribute("data-slug")).join(",") }; }, [top, sub]).catch(() => ({ card: false, n: 0, cards: 0, named: false, slugs: "" }));
      const facts = `selector \`${SEL}\`: ${have.n} of ${MEMBER_SLUGS.size} found (slugs: ${have.slugs || "none"}); \`#panel-${top} .card\`: ${have.cards}; "${sub.split("-")[0]}" appears in the panel text: ${have.named}`;
      return { ok: false, why: have.card ? `the route did not land on ${sub}'s card (no "landed" mark) [${facts}]` : `${sub} has no card in #panel-${top} [${facts}]` };
    }
  }
  await page.waitForTimeout(600);
  return { ok: true };
}

// The board renders its member chips (and the copy that counts them) a little after the first paint, and a phone can be slower than a laptop. Before ANY member-count, scene or
// party-size assertion, wait until the number of visible name chips equals the partyDoc count (the DOM is polled in the page every 250 ms, no API request is made), then let it
// stay put for half a second. After 10 s the count it last saw is returned and the caller fails with both numbers.
const countChips = () => Array.from(document.querySelectorAll(".tn-name")).filter((b) => b.getClientRects().length).length;
async function settleChips(page, n) {
  await page.waitForFunction((want) => Array.from(document.querySelectorAll(".tn-name")).filter((b) => b.getClientRects().length).length === want, n, { timeout: 10000, polling: 250 }).then(() => page.waitForTimeout(500), () => {});
  return page.evaluate(countChips);
}

// Self-explaining failures. When a visible string is judged wrong, say WHERE it is and why this engine considers it visible, so a run in an engine I cannot reproduce locally
// (Firefox, WebKit) shows the cause instead of only the symptom.
const explainStrings = (page, wanted) => page.evaluate((wanted) => {
  const out = [];
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n && out.length < wanted.length; n = w.nextNode()) {
    const t = n.nodeValue.replace(/\s+/g, " ").trim(); if (!t || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(n.parentElement.tagName)) continue;
    const hit = wanted.find((x) => t.includes(x.slice(0, 40))); if (!hit) continue;
    const el = n.parentElement, cs = getComputedStyle(el), r = el.getBoundingClientRect();
    const path = []; for (let e = el; e && path.length < 5; e = e.parentElement) path.push(`${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ""}${e.className && typeof e.className === "string" ? `.${e.className.trim().split(/\s+/)[0]}` : ""}`);
    const flags = []; for (let e = el; e; e = e.parentElement) { if (e.hasAttribute("hidden")) flags.push("hidden"); if (e.hasAttribute("inert")) flags.push("inert"); if (e.getAttribute("aria-hidden") === "true") flags.push("aria-hidden"); }
    out.push(`"${hit.slice(0, 50)}" in ${path.join(" < ")}: display ${cs.display}, visibility ${cs.visibility}, opacity ${cs.opacity}, box ${Math.round(r.width)}x${Math.round(r.height)} at ${Math.round(r.left)},${Math.round(r.top)}, checkVisibility ${typeof el.checkVisibility === "function" ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true }) : "n/a"}, ancestors flagged: ${flags.length ? [...new Set(flags)].join("+") : "none"}`);
  }
  return out;
}, wanted);
const chipFacts = (page, n) => page.evaluate((n) => { const all = Array.from(document.querySelectorAll(".tn-name")); return `selector ".tn-name": ${all.length} elements, ${all.filter((b) => b.getClientRects().length).length} with a box; names: ${all.map((b) => b.textContent.trim()).filter(Boolean).slice(0, 12).join(", ") || "none"} (wanted ${n})`; }, n).catch(() => "no DOM facts");

// The copy that counts the party ("The five", "Open the five") is re-rendered by the board a moment after the chips, and in some engines later than in others. Before the first
// party-size judgement of a scene, poll the DOM (visible text only, no API request) until no visible string states the wrong count; bounded. If a wait ever runs out the copy is
// really stale: the failure is then reported, and later scenes are not waited for again (one bounded wait, not one per scene).
async function settleCopy(page, n, ms, state) {
  if (!(n > 5) || state.gaveUp) return;
  const end = Date.now() + ms;
  for (;;) {
    const texts = await copyOf(page, "text").catch(() => []);
    if (!wrongCountCopy(uniq(texts), n).length) return;
    if (Date.now() >= end) { state.gaveUp = true; return; }
    await page.waitForTimeout(400);
  }
}

async function probeOne(browser, engine, vp) {
  const tag = `${engine} ${vp.name}`;
  const ctxOpts = { viewport: { width: vp.width, height: vp.height }, serviceWorkers: "block", reducedMotion: "reduce", ...(vp.phone && engine !== "firefox" ? { hasTouch: true, isMobile: true } : {}) };
  const ctx = await browser.newContext(ctxOpts);
  const errs = [], http = [], failed = [];
  // The only routes: count every Worker request and every socket before it is sent, and refuse it once the budget is spent (helpers/probe-budget.mjs).
  await guardContext(ctx, budget, { mode: API_ROUTE });
  if (CLOCK) await ctx.clock.install({ time: CLOCK }); // self-test only (see --clock above)
  const page = await ctx.newPage();
  let insightsFailed = false;
  page.on("pageerror", (e) => errs.push({ text: `uncaught: ${String(e.message).slice(0, 160)}`, at: "" }));
  page.on("console", (m) => { if (m.type() !== "error") return; let at = ""; try { at = (m.location() || {}).url || ""; } catch (e) {} errs.push({ text: m.text().slice(0, 4000), at: at.replace(/[?#].*$/, "") }); });
  const ours = (u) => { try { const o = new URL(u).origin; return o === SITE || o === API; } catch (e) { return false; } };
  const warned = [];
  page.on("response", (r) => {
    const v = classifyHttp(r.url(), r.status(), SITE, API), row = `${r.status()} ${r.request().method()} ${r.url().replace(/[?#].*$/, "")}`;
    if (v === "fail") http.push(row); else if (v === "warn") warned.push(row);
  });
  page.on("requestfailed", (r) => { if (isInsightsHost(r.url())) insightsFailed = true; const why = (r.failure() || {}).errorText || ""; if (ours(r.url()) && !/ERR_ABORTED|NS_BINDING_ABORTED|cancelled|aborted/i.test(why) && !(budget.exceeded && /blockedbyclient|BLOCKED_BY_CLIENT/i.test(why))) failed.push(`${r.method()} ${r.url().replace(/[?#].*$/, "")} (${why})`); });
  let chips = -1;
  const target = pageUrl(URL_, { params: {} });
  // Reveal the member chips ("Just take a look" can appear a moment after the chips' container is attached: Firefox, phones) and wait for them to equal the API count.
  const reveal = async () => {
    await page.waitForSelector("#nx-fr2-look, .tn-name", { state: "attached", timeout: 25000 }).catch(() => {});
    await page.waitForSelector("#nx-fr2-look", { state: "visible", timeout: 8000 }).catch(() => {});
    const look = page.locator("#nx-fr2-look");
    if (await look.count() && await look.isVisible().catch(() => false)) await look.click();
    await page.waitForSelector(".tn-name", { state: "visible", timeout: 25000 }).catch(() => {});
    return settleChips(page, N);
  };
  try {
    try { await page.goto(target, { waitUntil: "load", timeout: 45000 }); }
    catch (e) { console.log(`WARN ${tag}: first load failed (${String(e.message).split("\n")[0]}); loading once more`); await page.goto(target, { waitUntil: "load", timeout: 45000 }); } // the one retry
    if (page.url() === "about:blank") { console.log(`WARN ${tag}: tab left on about:blank; loading once more`); await page.goto(target, { waitUntil: "load", timeout: 45000 }); }
    chips = await reveal();
    // A board that still shows another number of members after the bounded wait was loaded from a state that is behind (a slow engine, a cached answer). A visitor would reload, so the probe
    // does too, ONCE (the same single retry the first load has; it is counted in the request budget like any load). Only if the count is still wrong is that a failure.
    if (chips >= 0 && chips !== N && !budget.exceeded) {
      console.log(`WARN ${tag}: the board shows ${chips} members, the party has ${N}; reloading once`);
      await page.reload({ waitUntil: "load", timeout: 45000 });
      chips = await reveal();
    }
  } catch (e) { fail(tag, `the page did not load: ${String(e.message).split("\n")[0]}`); }
  // Nothing is judged against a half-rendered board: every copy and scene check below runs only when the members shown equal the API count.
  const boardReady = chips >= 0 && chips === N;
  if (chips >= 0 && !budget.exceeded) {
    const bad = memberCountProblem(chips, N);
    if (bad.length) { const facts = await chipFacts(page, N); bad.forEach((b) => fail(tag, `${b} [DOM: ${facts}]`)); console.log(`INFO ${tag}: the scenes were not stepped through and no copy was judged, because the board never showed the ${N} members`); } else pass(`${tag} the board shows ${chips} members, the party has ${N}`);
  }
  const visible = [], vtext = [], everything = [], copyState = { gaveUp: false }, sceneState = { cardsGaveUp: false };
  if (boardReady) {
    await settleCopy(page, N, 10000, copyState);
    visible.push(...(await copyOf(page, "visible").catch(() => [])).map((t) => ["first screen", t]));
    vtext.push(...(await copyOf(page, "text").catch(() => [])).map((t) => ["first screen", t]));
    for (const hash of SCENES) {
      if (budget.exceeded) break; // nothing else starts once the budget is spent
      const up = await openScene(page, hash, sceneState).catch((e) => ({ ok: false, why: String(e.message).split("\n")[0] }));
      if (!up.ok) { fail(tag, `scene #${hash} did not open: ${up.why}`); continue; }
      const top = hash.split(".")[0];
      await settleCopy(page, N, 5000, copyState);
      const text = await page.evaluate((k) => { const p = document.querySelector(`#panel-${k}`) || document.querySelector("#scene"); return p ? p.innerText.replace(/\s+/g, " ").trim() : ""; }, top).catch(() => "");
      if (text.length < 20) fail(tag, `scene #${hash} is blank (${text.length} characters)`); else pass(`${tag} scene #${hash} has content`);
      visible.push(...(await copyOf(page, "visible").catch(() => [])).map((t) => [`#${hash}`, t]));
      vtext.push(...(await copyOf(page, "text").catch(() => [])).map((t) => [`#${hash}`, t]));
    }
    everything.push(...(await copyOf(page, "all").catch(() => [])).map((t) => ["whole page", t]));
  }
  const origin = (pairs, strings) => (s) => { const hit = pairs.find(([, t]) => String(t).replace(/\s+/g, " ").includes(s.split('"')[1] || s)); return hit ? hit[0] : "?"; };
  const vs = uniq(visible.map((p) => p[1])), vt = uniq(vtext.map((p) => p[1]));
  for (const j of junkIn(vs)) fail(tag, `junk text, ${j} (in ${origin(visible)(j)})`);
  if (!junkIn(vs).length) pass(`${tag} no junk text in ${vs.length} visible strings`);
  // The party-size check judges only what a visitor can read in the scene they are in. Hidden text (other scenes' panels, templates, meta) that still says the wrong count is a leftover
  // for a later copy-fix PR: reported as information, never a failure.
  const wc = wrongCountCopy(vt, N);
  for (const w of wc) fail(tag, `copy states the wrong party size: ${w}`);
  if (wc.length) for (const line of (await explainStrings(page, wc.map((w) => (w.match(/^"(.*)" \(the party has/) || [])[1] || w)).catch(() => [])).slice(0, 8)) console.log(`DIAG ${tag}: ${line}`);
  if (!wc.length) pass(`${tag} no visible copy states a wrong party size (${vt.length} visible strings, party ${N})`);
  const seenVisible = new Set(wc);
  for (const h of wrongCountCopy(uniq(everything.map((p) => p[1])), N)) if (!seenVisible.has(h)) hiddenCopy.add(h);
  for (const a of exemptedAdvisories(errs)) advisories.add(`${engine}: ${a}`);
  const hard = consoleFailures(errs, { engine, allowWebkitNoWebgl: process.env.SMOKE_ALLOW_WEBKIT_NO_WEBGL === "1", insightsRequestFailed: insightsFailed, budgetSpent: budget.exceeded });
  hard.length ? hard.slice(0, 5).forEach((e) => fail(tag, `console error: ${e.text.length > 200 ? `${e.text.slice(0, 200)}... (${e.text.length} chars)` : e.text}${e.at ? ` [${e.at}]` : ""}`)) : pass(`${tag} no console errors`);
  for (const w of uniq(warned).slice(0, 8)) console.log(`WARN ${tag}: API 4xx (not a failure off /api/bootstrap and /api/state): ${w}\n::warning title=Production probe::${tag}: API 4xx ${w}`);
  http.length ? uniq(http).slice(0, 8).forEach((h) => fail(tag, `HTTP error (site 4xx/5xx, API 5xx, or API 4xx on bootstrap/state): ${h}`)) : pass(`${tag} no 4xx/5xx from the site or its API`);
  failed.length ? uniq(failed).slice(0, 5).forEach((h) => fail(tag, `request failed: ${h}`)) : pass(`${tag} no failed requests`);
  for (const r of budget.redirects.splice(0)) fail(tag, `the API answered with a redirect (counted hop by hop; the probe fails on any): ${r}`);
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
if (hiddenCopy.size) console.log(`INFO hidden copy that still says the wrong party size (not visible to a visitor, NOT a failure; for a later copy-fix PR), ${hiddenCopy.size}:\n${[...hiddenCopy].slice(0, 40).map((h) => `  - ${h}`).join("\n")}`);
if (advisories.size) console.log(`INFO exempted report-only CSP advisories (they flag real eval use in site code, ticket B61), ${advisories.size}:\n${[...advisories].slice(0, 20).map((h) => `  - ${h}`).join("\n")}`);
if (budget.exceeded) fail("budget", `more than ${BUDGET} Worker requests were needed; the rest were refused`);
console.log(`\nWorker requests this run: ${budget.used} of ${BUDGET}. Engines: ${notes.join(", ")}. Party: ${N}. ${problems.length ? `${problems.length} problem(s)` : "all checks passed"}.`);
if (process.env.GITHUB_STEP_SUMMARY) {
  try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Production probe (${SITE})\n\nWorker requests this run: **${budget.used} of ${BUDGET}**. Engines: ${notes.join(", ")}. Party: ${N}.\n\n${problems.length ? problems.map((p) => `- ${p}`).join("\n") : "All checks passed."}\n${hiddenCopy.size ? `\nHidden copy that still says the wrong party size (information, not a failure; for a later copy-fix PR):\n${[...hiddenCopy].slice(0, 40).map((h) => `- ${h}`).join("\n")}\n` : ""}${advisories.size ? `\nExempted report-only CSP advisories (real eval use in site code, ticket B61):\n${[...advisories].slice(0, 20).map((h) => `- ${h}`).join("\n")}\n` : ""}`); } catch (e) {}
}
process.exit(problems.length ? 1 : 0);
