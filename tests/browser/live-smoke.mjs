// Browser smoke: loads a deployed board in fresh Chromium and WebKit contexts (390x844 touch, 1366x768) and fails on the defects a ship can leave behind.
//   node live-smoke.mjs --url https://pr-13.leeroy-board.pages.dev/   (or env PREVIEW_PAGES)
// API: stubbed like every browser suite (tests/fixtures/api-snapshot, zero Worker requests), so this suite judges the PAGE; a Worker 5xx cannot happen here and any 4xx/5xx or console error is a failure.
// The live check of the deployed Worker is tests/browser/deploy-smoke.mjs. With --live-api (spends requests) a Worker 5xx is a plain failure, retried once after 25 s like any other.
// Checks per context: same-origin 4xx/5xx, console errors, literal "null"/"undefined"/NaN/[object Object] in visible text, Guided as the default journey,
// readable name chips, the journey toggle, and one primary button after a name is picked. Reads only; presses the journey toggle and a name chip, both
// on the fresh context's own localStorage, and never presses anything that sends.
// A failed context is visited once more after 25 s (SMOKE_RETRY_MS overrides); fail-then-pass prints WARN transient, fail twice fails (smoke-retry.mjs).
// Option: --engine chromium|webkit|firefox runs that engine alone (default: Chromium and WebKit; Firefox only when asked, for the scheduled cross-engine run, .github/workflows/cross-engine.yml).
// Option: --clock <iso> loads every page with its clock set to that instant (tests/helpers/clock-arg.mjs), e.g. 2026-11-04T10:00:00Z to see the launch hero today.
// Exit 0 when every check passes, 1 otherwise.
import { needsRetry, mergeRuns, RETRY_DELAY_MS } from "./smoke-retry.mjs";
import { stubbed } from "../helpers/browser-stub.mjs";
import { parseClock, applyClock } from "../helpers/clock-arg.mjs";
import fs from "node:fs";
/* The party tab is named by the client flag party.n (data/client.json) AND the size of the party: "The five" when the flag is off or the party has exactly five members, "The party" otherwise (the rule of
   js/board.js K.pn.title()). The size is the number of distinct members in the fixture this suite answers the API from (tests/fixtures/api-snapshot/snapshot.json, /bootstrap party.members), not read from the page. */
const PARTY_FLAG = !!JSON.parse(fs.readFileSync(new URL("../../data/client.json", import.meta.url), "utf8")).flags["party.n"];
const FIXTURE_MEMBERS = new Set(JSON.parse(JSON.parse(fs.readFileSync(new URL("../fixtures/api-snapshot/snapshot.json", import.meta.url), "utf8")).routes["/bootstrap"].body).party.members.map((m) => m.name)).size;
const PARTY_TAB = PARTY_FLAG && FIXTURE_MEMBERS !== 5 ? "The party" : "The five";
const pw = await import("playwright").catch(() => { console.error("playwright not found; run npm install in tests/"); process.exit(2); });
const argv = process.argv.slice(2), ui = argv.indexOf("--url");
const BASE = (ui >= 0 && argv[ui + 1]) || process.env.PREVIEW_PAGES;
if (!BASE) { console.error("usage: node live-smoke.mjs --url <pages origin> (or set PREVIEW_PAGES)"); process.exit(2); }
const base = BASE, origin = new URL(base).origin;
const CTX = [["chromium", "390x844", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }], ["chromium", "1366x768", { viewport: { width: 1366, height: 768 } }],
  ["webkit", "390x844", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }], ["webkit", "1366x768", { viewport: { width: 1366, height: 768 } }],
  ["firefox", "390x844", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }], ["firefox", "1366x768", { viewport: { width: 1366, height: 768 } }]];
const ei = argv.indexOf("--engine"), ENGINE = ei >= 0 ? argv[ei + 1] : null;
if (ENGINE !== null && !["chromium", "webkit", "firefox"].includes(ENGINE)) { console.error(`unknown engine ${ENGINE}`); process.exit(2); }
let CLOCK = null;
try { CLOCK = parseClock(argv); } catch (e) { console.error(e.message); process.exit(2); }
let pass = 0, fail = 0, transient = 0; const fails = [];
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; const l = `FAIL ${name}${extra ? `: ${extra}` : ""}`; fails.push(l); console.log(l); } };
const bad = (t) => { if (/\[object Object\]/.test(String(t))) return "object Object"; const m = String(t).match(/(^|[^A-Za-z0-9_.\-])(null|undefined|NaN)(?![A-Za-z0-9_\-])/); return m ? m[2] : null; }; // + [object Object] and NaN (2026-10-30: the five's arrangement line)
const visibleText = () => document.body.innerText;
/* the first view as a friend sees it: the default journey, what the head toggle shows as pressed, and the visible name chips with their label colour.
   A chip is readable when its label is light on the dark plank (a border-image fill) with a shadow, or 4.5:1 on a flat background. */
const state = () => {
  const lum = (c) => { const m = String(c).match(/[\d.]+/g) || [0, 0, 0], f = (v) => { v = v / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(+m[0]) + 0.7152 * f(+m[1]) + 0.0722 * f(+m[2]); };
  const chips = [...document.querySelectorAll("#tn-me .tn-name")].filter((b) => b.offsetWidth > 0 && b.offsetHeight > 0).map((b) => {
    const c = getComputedStyle(b), plank = c.borderImageSource !== "none", l = lum(c.color), bg = c.backgroundColor, flat = !/rgba?\(\s*\d+,\s*\d+,\s*\d+,\s*0\)|transparent/.test(bg);
    const ratio = flat ? (Math.max(l, lum(bg)) + 0.05) / (Math.min(l, lum(bg)) + 0.05) : 0;
    return { name: b.textContent.trim(), plank, lum: l, shadow: c.textShadow !== "none", readable: plank ? l >= 0.55 && c.textShadow !== "none" : ratio >= 4.5 };
  });
  return {
    journey: document.documentElement.dataset.journey || "",
    chips,
    headPressed: [...document.querySelectorAll("#journey [aria-pressed=true], .journey [aria-pressed=true]")].filter((b) => b.offsetWidth > 0).map((b) => b.dataset.journey),
  };
};
const row = (r) => `${r.status} ${r.method} ${r.url}`;
/* one first visit; its checks come back as rows for one() to judge */
async function visit(browser, engine, size, opts, setup) {
  /* Firefox has no isMobile (Playwright refuses the context); its phone context is the viewport and touch alone (2026-10-31, the cross-engine run) */
  const { isMobile, ...rest } = opts, tag = `${engine} ${size}`, ctx = await browser.newContext({ ...(engine === "firefox" ? rest : opts), serviceWorkers: "block" }), errs = [], http = [], xo = [], rows = [];
  const ok = (name, cond, extra = "") => { rows.push([name, !!cond, extra]); }; /* the file's ok(), held until one() knows whether this visit counts */
  if (setup) await setup(ctx);
  const page = await ctx.newPage();
  await applyClock(page, CLOCK);
  page.on("console", (m) => { if (m.type() === "error" && !/^\[Report Only\]/.test(m.text())) { let at = ""; try { at = (m.location() || {}).url || ""; } catch (e) {} errs.push({ text: m.text().slice(0, 160), at: at.replace(/[?#].*$/, "") }); } });
  page.on("pageerror", (e) => errs.push({ text: `pageerror ${String(e.message).slice(0, 160)}`, at: "" }));
  page.on("response", (r) => { try { const u = new URL(r.url()); if (r.status() >= 400) (u.origin === origin ? http : xo).push({ status: r.status(), method: r.request().method(), url: r.url().replace(/[?#].*$/, ""), origin: u.origin, route: u.pathname }); } catch (e) {} }); /* xo: other origins (the Worker), named next to a console error (2026-10-31: two ships logged a bare 503) */
  try {
    await page.goto(`${base}${base.includes("?") ? "&" : "?"}cb=${Date.now()}${Math.random().toString(36).slice(2, 6)}`, { waitUntil: "load", timeout: 45000 });
    await page.waitForSelector("#tn-me .tn-name, #nx-fr2-look", { state: "visible", timeout: 12000 }).catch(() => {});
    /* flag firstrun.v2: the first screen is purpose, one button, one quiet link (tests/browser/firstrun.mjs); the name grid checked below sits behind "Just take a look" */
    if (await page.locator("#nx-fr2-look").isVisible().catch(() => false)) { await page.locator("#nx-fr2-look").click(); await page.waitForSelector("#tn-me .tn-name", { state: "visible", timeout: 12000 }).catch(() => {}); }
    await page.waitForTimeout(1500);
    const s = await page.evaluate(state);
    ok(`${tag} first visit: Guided is the default journey`, s.journey === "guided", `data-journey: ${s.journey || "-"}`);
    ok(`${tag} first visit: nothing stored, so no journey reads as pressed in the head`, !s.headPressed.length, `pressed: ${s.headPressed.join(",") || "-"}`);
    ok(`${tag} first visit: a name picker with at least 4 chips`, s.chips.length >= 4, `visible chips: ${s.chips.length}`);
    ok(`${tag} first visit: every name chip label is readable`, s.chips.length >= 4 && s.chips.every((c) => c.readable), s.chips.filter((c) => !c.readable).map((c) => `${c.name} (lum ${c.lum.toFixed(2)}, shadow ${c.shadow})`).join("; ") || "no chips");
    const t0 = await page.evaluate(visibleText), b0 = bad(t0);
    ok(`${tag} no "null" or "undefined" in visible text (first view)`, !b0, b0 && `found ${b0} near: ${t0.slice(Math.max(0, t0.search(new RegExp(`\b${b0}\b`)) - 40), t0.search(new RegExp(`\b${b0}\b`)) + 40).replace(/\s+/g, " ")}`);
    /* the three journeys through the head toggle: on a phone the plate opens on the first tap, then the others show */
    const reach = [];
    for (const j of ["curious", "everything", "guided"]) {
      let got = false;
      try {
        const cur = () => page.evaluate(() => document.documentElement.dataset.journey);
        /* a phone's plate opens on a first tap and picks on the next; its buttons animate, so the tap is a DOM click on whichever copy shows */
        const tap = () => page.evaluate((jj) => { const all = [...document.querySelectorAll(".journey-scene [data-journey]")], b = all.find((x) => x.dataset.journey === jj && x.offsetWidth > 0) || all.find((x) => x.offsetWidth > 0); if (b) b.click(); return !!b; }, j);
        for (let n = 0; n < 3 && (await cur()) !== j; n++) { await tap(); await page.waitForTimeout(500); }
        got = (await cur()) === j;
      } catch (e) {}
      reach.push(`${j}:${got ? "ok" : "no"}`);
    }
    ok(`${tag} the head toggle reaches Guided, Curious and Everything`, reach.every((r) => r.endsWith(":ok")), reach.join(" "));
    await page.waitForTimeout(800);
    /* the first screen explains itself (first-run purpose card): four plain lines above the name picker, one primary action ("Show me what is next"), "Just looking" beside it, the countdown below them; on a desktop or tablet Guided shows four ribbon tabs plus More (a phone has its own bottom bar) */
    const fr = await page.evaluate(() => {
      const vis = (e) => !!e && e.offsetWidth > 0 && e.offsetHeight > 0, r = (e) => e.getBoundingClientRect(), P = document.querySelector("#nx-purpose"), chip = [...document.querySelectorAll("#tn-me .tn-name")].find(vis), go = document.querySelector("#nx-show"), look = document.querySelector("#nx-looking"), line = document.querySelector("#nx-tonight");
      const tabs = [...document.querySelectorAll("#tabs .tab")].filter(vis).map((t) => t.textContent.trim()), more = document.querySelector("#tab-more");
      return { lines: P ? [...P.querySelectorAll("p")].map((p) => p.textContent.trim()) : [], above: !!(P && chip && r(P).bottom <= r(chip).top + 1), go: vis(go) && /^Show me what is next$/.test(go.textContent.trim()), look: vis(look) && /^Just looking$/.test(look.textContent.trim()), tall: [go, look].filter(vis).every((b) => r(b).height >= 44), below: !line || !go || r(line).top >= r(go).bottom - 1, tabs, more: vis(more), wide: document.documentElement.scrollWidth <= innerWidth + 1 };
    });
    ok(`${tag} first visit: a purpose card of four lines sits above the name picker`, fr.lines.length === 4 && fr.above, `lines: ${fr.lines.length}, above: ${fr.above}`);
    ok(`${tag} first visit: "Show me what is next" is the primary action and "Just looking" the secondary, both tall enough to tap`, fr.go && fr.look && fr.tall, `go: ${fr.go}, look: ${fr.look}, tall: ${fr.tall}`);
    ok(`${tag} first visit: the countdown line is below the primary action, and the page does not scroll sideways`, fr.below && fr.wide, `below: ${fr.below}, no sideways scroll: ${fr.wide}`);
    if (!opts.isMobile) ok(`${tag} first visit: Guided shows Next steps, ${PARTY_TAB}, Sign-ups, Leeroy and More`, fr.tabs.join("|") === `Next steps|${PARTY_TAB}|Sign-ups|Leeroy` && fr.more, `tabs: ${fr.tabs.join("|")}, More: ${fr.more}`);
    /* a name picker: the Tonight panel's chips; a chip selects, and "Show me what is next" opens that person's next steps (it used to open on the chip itself) */
    const picked = await page.evaluate(() => {
      const b = [...document.querySelectorAll("#tn-me .tn-name")].find((x) => x.offsetWidth > 0);
      if (!b) return null; b.click(); const g = document.querySelector("#nx-show"); if (g) g.click(); return b.textContent.trim().slice(0, 30);
    });
    ok(`${tag} a name can be picked`, !!picked, "no name chip visible");
    await page.waitForTimeout(2500);
    /* a name closes the sheet and opens the guide layer (#ga), whose rail mirrors #nx-card: one main action, Not now, Show me more */
    const nx = await page.evaluate(() => { const c = document.querySelector("#nx-card"), vis = (b) => b.offsetWidth > 0 && b.offsetHeight > 0; const prim = [...document.querySelectorAll("#nx-card #nx-go, #ga-card .ga-btn.strong")].filter(vis); return { has: !!c, primary: prim.length, label: prim.map((b) => b.textContent.trim().slice(0, 24)).join("|") }; });
    ok(`${tag} #nx-card present after a name`, nx.has);
    if (nx.has) ok(`${tag} after a name exactly one primary button shows (#nx-go or #ga-card .ga-btn.strong)`, nx.primary === 1, `primary buttons: ${nx.primary} ${nx.label}`);
    const t1 = await page.evaluate(visibleText), b1 = bad(t1);
    ok(`${tag} no "null" or "undefined" in visible text (after Guided)`, !b1, b1 && `found ${b1}`);
    /* every scene once, in the first context only: a stray null, undefined, NaN or [object Object] anywhere a friend can open */
    if (engine === "chromium" && !opts.isMobile) for (const sc of ["tonight", "timeline", "five", "roads", "racials", "legacy", "buffs", "ledger", "signups", "librarian", "library", "decide"]) {
      await page.evaluate((h) => { location.hash = "#" + h; }, sc); await page.waitForTimeout(900);
      const ts = await page.evaluate(visibleText), bs = bad(ts);
      ok(`${tag} no stray value in visible text (${sc})`, !bs, bs && `found ${bs} near: ${ts.slice(Math.max(0, ts.indexOf(bs) - 50), ts.indexOf(bs) + 30).replace(/\s+/g, " ")}`);
    }
    const noGl = (e) => engine === "webkit" && process.env.SMOKE_ALLOW_WEBKIT_NO_WEBGL === "1" && /Error creating WebGL context/.test(e.text); /* headless Linux WebKit in CI has no WebGL; the board still renders its fallback */
    const insights = errs.some((e) => /cloudflareinsights\.com/.test(e.text + " " + e.at)) || xo.some((r) => /cloudflareinsights\.com/.test(r.url)); /* Cloudflare Web Analytics beacon on a preview host is blocked by CORS: third-party, not our code */
    const cfBeacon = (e) => /cloudflareinsights\.com/.test(e.text + " " + e.at) || (insights && /net::ERR_FAILED|not allowed by Access-Control-Allow-Origin/.test(e.text)); /* WebKit words the same failure without the URL */
    const csp = (e) => /^\[Report Only\]|Content Security Policy/i.test(e.text); /* _headers ships the CSP as Report-Only (not enforced): its violation lines are noise, in WebKit worded without the [Report Only] prefix. Remove this when the policy is enforced. */
    const hard = errs.filter((e) => !noGl(e) && !cfBeacon(e) && !csp(e)); /* every other console error counts */
    ok(`${tag} no same-origin 4xx/5xx`, !http.length, http.slice(0, 3).map(row).join(" | "));
    ok(`${tag} no console errors`, !hard.length, hard.slice(0, 3).map((e) => e.text).join(" | ") + (xo.length ? ` [from: ${xo.slice(0, 3).map(row).join(" | ")}]` : ""));
  } catch (e) {
    ok(`${tag} run completed`, false, String((e && e.message) || e).split("\n")[0].slice(0, 200));
  } finally { await ctx.close().catch(() => {}); }
  return { rows };
}
/* one context's result: a failed context is visited once more (below), and the pure mergeRuns judges the two runs. */
const retryMs = () => Number(process.env.SMOKE_RETRY_MS) || RETRY_DELAY_MS;
async function one(browser, engine, size, opts, setup, fault = false) {
  const tag = `${engine} ${size}`;
  let v = await visit(browser, engine, size, opts, setup);
  /* a failed check: one more visit in a fresh context after 25 s; the pure mergeRuns judges the two runs */
  let retried = false;
  if (needsRetry(v.rows, { fault })) {
    const names = v.rows.filter((r) => !r[1]).map((r) => r[0].slice(tag.length + 1));
    console.log(`INFO ${tag} ${names.length} check(s) failed (${names.slice(0, 3).join("; ")}): ${String((v.rows.find((r) => !r[1]) || [])[2] || "").slice(0, 300)} retrying once in a fresh context in ${Math.round(retryMs() / 1000)} s`);
    await new Promise((r) => setTimeout(r, retryMs()));
    const v2 = await visit(browser, engine, size, opts, setup); retried = true;
    if (v2 && v2.w5 && v2.w5.length) warn(tag, v2.w5, ", retry"); /* visit() returns only rows: this line threw on every retry */
    v = { ...v2, rows: mergeRuns(v.rows, v2.rows) };
  }
  return { ...v, retried };
}
for (const eng of ENGINE ? [ENGINE] : ["chromium", "webkit"]) {
  let browser; try { browser = stubbed(await pw[eng].launch()); } catch (e) { ok(`${eng} launches`, false, String(e.message).split("\n")[0]); continue; }
  try { for (const [en, size, opts] of CTX.filter((c) => c[0] === eng)) for (const r of (await one(browser, en, size, opts)).rows) { ok(r[0], r[1], r[2]); if (r[3]) { transient++; console.log(`WARN transient ${r[0]}: failed on the first run, passed on the retry${r[2] ? ` (${String(r[2]).slice(0, 120)})` : ""}`); } } } finally { await browser.close().catch(() => {}); }
}
console.log(`${fail ? `live-smoke: ${fail} of ${pass + fail} checks FAILED` : `live-smoke: all ${pass} checks passed`}${transient ? ` (${transient} transient WARN)` : ""}`);
process.exit(fail ? 1 : 0);
