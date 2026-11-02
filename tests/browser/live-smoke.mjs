// Browser smoke: loads a deployed board in fresh Chromium and WebKit contexts (390x844 touch, 1366x768) and fails on the defects a ship can leave behind.
//   node live-smoke.mjs --url https://pr-13.leeroy-board.pages.dev/   (or env PREVIEW_PAGES)
// Optional env: PREVIEW_API = the Worker origin, used to tell a Worker 5xx (WARN, platform) from a page defect.
// Checks per context: same-origin 4xx/5xx, console errors, literal "null"/"undefined"/NaN/[object Object] in visible text, Guided as the default journey,
// readable name chips, the journey toggle, and one primary button after a name is picked. Reads only; presses the journey toggle and a name chip, both
// on the fresh context's own localStorage, and never presses anything that sends.
// A failed context is visited once more after 25 s (SMOKE_RETRY_MS overrides); fail-then-pass prints WARN transient, fail twice fails (smoke-retry.mjs).
// Option: --engine chromium|webkit|firefox runs that engine alone (default: Chromium and WebKit; Firefox only when asked, for the scheduled cross-engine run, .github/workflows/cross-engine.yml).
// Exit 0 when every check passes, 1 otherwise.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { needsRetry, mergeRuns, RETRY_DELAY_MS } from "./smoke-retry.mjs";
const pw = await import("playwright").catch(() => { console.error("playwright not found; run npm install in tests/"); process.exit(2); });
const argv = process.argv.slice(2), ui = argv.indexOf("--url");
const BASE = (ui >= 0 && argv[ui + 1]) || process.env.PREVIEW_PAGES;
if (!BASE) { console.error("usage: node live-smoke.mjs --url <pages origin> (or set PREVIEW_PAGES)"); process.exit(2); }
const here = path.dirname(fileURLToPath(import.meta.url));
const base = BASE, origin = new URL(base).origin;
/* the Worker's origin: PREVIEW_API, else js/brain.js const WORKER; not found: no row is the Worker's */
const WORKER_ORIGIN = (() => { try { if (process.env.PREVIEW_API) return new URL(process.env.PREVIEW_API).origin; const m = fs.readFileSync(path.join(here, "..", "..", "js", "brain.js"), "utf8").match(/const WORKER = "(https:\/\/[^"]+)"/); return m ? new URL(m[1]).origin : null; } catch (e) { return null; } })();
if (!WORKER_ORIGIN) console.log("WARN worker origin not found in js/brain.js: every console error counts");
const CTX = [["chromium", "390x844", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }], ["chromium", "1366x768", { viewport: { width: 1366, height: 768 } }],
  ["webkit", "390x844", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }], ["webkit", "1366x768", { viewport: { width: 1366, height: 768 } }],
  ["firefox", "390x844", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }], ["firefox", "1366x768", { viewport: { width: 1366, height: 768 } }]];
const ei = argv.indexOf("--engine"), ENGINE = ei >= 0 ? argv[ei + 1] : null;
if (ENGINE !== null && !["chromium", "webkit", "firefox"].includes(ENGINE)) { console.error(`unknown engine ${ENGINE}`); process.exit(2); }
let pass = 0, fail = 0, warns = 0, transient = 0; const fails = [];
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
/* a Worker 5xx: a cross-origin row from the Worker's origin with a 5xx status. Its "Failed to load resource" line names the address in the console
   location (Chromium does); with no address there, the status in the text has to match one of the Worker's 5xx rows */
const workerRows = (xo) => (WORKER_ORIGIN ? xo.filter((r) => r.origin === WORKER_ORIGIN && r.status >= 500) : []);
const platform = (e, w5) => /^Failed to load resource/.test(e.text) && w5.some((r) => (e.at ? e.at === r.url : (e.text.match(/status of (\d{3})/) || [])[1] === String(r.status)));
/* one first visit; its checks come back as rows for one() to judge */
async function visit(browser, engine, size, opts, setup) {
  /* Firefox has no isMobile (Playwright refuses the context); its phone context is the viewport and touch alone (2026-10-31, the cross-engine run) */
  const { isMobile, ...rest } = opts, tag = `${engine} ${size}`, ctx = await browser.newContext({ ...(engine === "firefox" ? rest : opts), serviceWorkers: "block" }), errs = [], http = [], xo = [], rows = [];
  const ok = (name, cond, extra = "") => { rows.push([name, !!cond, extra]); }; /* the file's ok(), held until one() knows whether this visit counts */
  if (setup) await setup(ctx);
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") { let at = ""; try { at = (m.location() || {}).url || ""; } catch (e) {} errs.push({ text: m.text().slice(0, 160), at: at.replace(/[?#].*$/, "") }); } });
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
    if (!opts.isMobile) ok(`${tag} first visit: Guided shows Next steps, The five, Sign-ups, Leeroy and More`, fr.tabs.join("|") === "Next steps|The five|Sign-ups|Leeroy" && fr.more, `tabs: ${fr.tabs.join("|")}, More: ${fr.more}`);
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
    const hard = errs.filter((e) => !platform(e, workerRows(xo)) && !noGl(e) && !cfBeacon(e)); /* a Worker 5xx's own line is a WARN (one()), every other console error counts */
    ok(`${tag} no same-origin 4xx/5xx`, !http.length, http.slice(0, 3).map(row).join(" | "));
    ok(`${tag} no console errors`, !hard.length, hard.slice(0, 3).map((e) => e.text).join(" | ") + (xo.length ? ` [from: ${xo.slice(0, 3).map(row).join(" | ")}]` : ""));
  } catch (e) {
    ok(`${tag} run completed`, false, String((e && e.message) || e).split("\n")[0].slice(0, 200));
  } finally { await ctx.close().catch(() => {}); }
  return { rows, w5: workerRows(xo) };
}
/* one context's result. A Worker 5xx is the platform, not the page (G4): each Worker route that answered 5xx prints WARN worker 5xx <route>,
   and the context is visited again 5 s later; that second visit's checks are its result, and the first visit's are only counted in an INFO
   line. The reload is a second first visit in a fresh context rather than page.reload(): the first visit pressed Guided and picked a name,
   which a reload keeps in localStorage, and the first-visit checks need it empty. A 5xx on the second visit warns again; there is no third. */
const warn = (tag, w5, when) => { const by = new Map(); for (const r of w5) (by.get(r.route) || by.set(r.route, []).get(r.route)).push(`${r.status} ${r.method}`); for (const [route, hits] of by) { warns++; console.log(`WARN worker 5xx ${route} (${[...new Set(hits)].join(", ")}${hits.length > 1 ? ` x${hits.length}` : ""}; ${tag}${when})`); } };
const retryMs = () => Number(process.env.SMOKE_RETRY_MS) || RETRY_DELAY_MS;
async function one(browser, engine, size, opts, setup, fault = false) {
  const tag = `${engine} ${size}`;
  let v = await visit(browser, engine, size, opts, setup), reloaded = false;
  if (v.w5.length) {
    warn(tag, v.w5, "");
    const f = v.rows.filter((r) => !r[1]);
    console.log(`INFO ${tag} the Worker answered 5xx: visiting again in 5 s, and that visit's checks are this context's result (set aside: ${v.rows.length - f.length} passed, ${f.length} failed${f.length ? `: ${f.map((r) => r[0].slice(tag.length + 1)).join("; ")}` : ""})`);
    await new Promise((r) => setTimeout(r, 5000));
    v = await visit(browser, engine, size, opts, setup); reloaded = true;
    if (v.w5.length) warn(tag, v.w5, ", second visit");
  }
  /* a failed check: one more visit in a fresh context after 25 s; the pure mergeRuns judges the two runs */
  let retried = false;
  if (needsRetry(v.rows, { fault })) {
    const names = v.rows.filter((r) => !r[1]).map((r) => r[0].slice(tag.length + 1));
    console.log(`INFO ${tag} ${names.length} check(s) failed (${names.slice(0, 3).join("; ")}): retrying once in a fresh context in ${Math.round(retryMs() / 1000)} s`);
    await new Promise((r) => setTimeout(r, retryMs()));
    const v2 = await visit(browser, engine, size, opts, setup); retried = true;
    if (v2.w5.length) warn(tag, v2.w5, ", retry");
    v = { ...v2, rows: mergeRuns(v.rows, v2.rows) };
  }
  return { ...v, reloaded, retried };
}
for (const eng of ENGINE ? [ENGINE] : ["chromium", "webkit"]) {
  let browser; try { browser = await pw[eng].launch(); } catch (e) { ok(`${eng} launches`, false, String(e.message).split("\n")[0]); continue; }
  try { for (const [en, size, opts] of CTX.filter((c) => c[0] === eng)) for (const r of (await one(browser, en, size, opts)).rows) { ok(r[0], r[1], r[2]); if (r[3]) { transient++; console.log(`WARN transient ${r[0]}: failed on the first run, passed on the retry${r[2] ? ` (${String(r[2]).slice(0, 120)})` : ""}`); } } } finally { await browser.close().catch(() => {}); }
}
console.log(`${fail ? `live-smoke: ${fail} of ${pass + fail} checks FAILED` : `live-smoke: all ${pass} checks passed`}${warns ? ` (${warns} worker 5xx WARN)` : ""}${transient ? ` (${transient} transient WARN)` : ""}`);
process.exit(fail ? 1 : 0);
