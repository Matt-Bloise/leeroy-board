// Cinematic slice 7 (Library search), Chromium at 1366x768 and 390x844. API answered from tests/fixtures/api-snapshot: zero Worker requests.
//   node library-search.mjs --url http://127.0.0.1:8080/   (or env PREVIEW_PAGES; tools/local-browser.sh library-search)   --out <dir> keeps the screenshots
// Checks: the search box is reachable by keyboard ("/" focuses it) and has an accessible name; a question the Library answers leads with the page it names,
// and a result row opens the exact fact (the row is lit, inside the viewport); a question it cannot answer says "The Library does not cover that." with an Ask Leeroy
// link to the Leeroy scene that carries the question into the ask box; the empty card is dark (black stays black); nothing on it animates under reduced motion.
// Every wait is bounded (WAIT ms) and a watchdog ends the run: a failing probe fails fast, it never sits silent.
import fs from "node:fs";
import path from "node:path";
import { pageUrl } from "../helpers/page-url.mjs";
import { stubbed } from "../helpers/browser-stub.mjs";
const pw = await import("playwright").catch(() => { console.error("playwright not found; run npm install in tests/"); process.exit(2); });
const argv = process.argv.slice(2), arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const BASE = arg("--url") || process.env.PREVIEW_PAGES;
if (!BASE) { console.error("usage: node library-search.mjs --url <pages origin> (or set PREVIEW_PAGES)"); process.exit(2); }
const OUT = arg("--out");
if (OUT) fs.mkdirSync(OUT, { recursive: true });
const WAIT = 8000, WATCHDOG = 150000;
const dog = setTimeout(() => { console.log(`FAIL watchdog: the run took longer than ${WATCHDOG / 1000} s`); process.exit(1); }, WATCHDOG); dog.unref();
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${extra ? `: ${extra}` : ""}`); } };
const url = pageUrl(BASE, { params: { preview: "1" } });
// a wait that reports instead of throwing, so one failed probe is one FAIL line and the run goes on
const until = async (page, fn, arg0) => { try { await page.waitForFunction(fn, arg0, { timeout: WAIT }); return true; } catch (e) { return false; } };
const lum = (rgb) => { const m = (rgb.match(/[\d.]+/g) || []).slice(0, 3).map((v) => { v = +v / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]; };

// first visit -> "Just take a look" -> the wanted hash; every step bounded
async function open(page, hash) {
  await page.goto(url, { waitUntil: "load", timeout: WAIT * 2 }).catch(() => {});
  if (await until(page, () => { const b = document.querySelector("#nx-fr2-look"); return !!b && b.getBoundingClientRect().width > 0; })) await page.click("#nx-fr2-look", { timeout: WAIT }).catch(() => {});
  await page.waitForTimeout(600);
  await page.evaluate((h) => { location.hash = h; }, hash).catch(() => {});
}

const browser = stubbed(await pw.chromium.launch());
async function run(label, viewport, mobile) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, hasTouch: mobile, isMobile: mobile, serviceWorkers: "block", reducedMotion: "reduce" });
  ctx.setDefaultTimeout(WAIT); const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(String(e.message || e)));
  await open(page, "library");
  ok(`${label}: the Library scene opens with a search box`, await until(page, () => { const q = document.querySelector("#lib-q"); return !!q && q.getBoundingClientRect().width > 40; }));
  const name = await page.evaluate(() => { const q = document.querySelector("#lib-q"); if (!q) return ""; const l = q.labels && q.labels[0]; return q.getAttribute("aria-label") || (l && l.textContent) || ""; }).catch(() => "");
  ok(`${label}: the search box has an accessible name`, name.trim().length > 2, name);
  await page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
  await page.keyboard.press("/");
  ok(`${label}: "/" puts the cursor in the search box`, await until(page, () => !!document.activeElement && document.activeElement.id === "lib-q"));
  // a question the Library answers: the page it names leads
  await page.fill("#lib-q", "mage");
  await page.keyboard.press("Enter");
  ok(`${label}: "mage" shows results`, await until(page, () => document.querySelector("#panel-library").dataset.view === "results" && !!document.querySelector("#lib-main .group-head a")));
  const lead = await page.evaluate(() => (document.querySelector("#lib-main .group-head a") || {}).textContent || "").catch(() => "");
  ok(`${label}: "mage" leads with the Mage page`, lead.trim() === "Mage", lead);
  const live = await page.evaluate(() => { const c = document.querySelector("#lib-count"); return c ? c.getAttribute("aria-live") : null; }).catch(() => null);
  ok(`${label}: the result count is announced politely`, live === "polite", String(live));
  // a result row opens the exact fact
  const row = await page.evaluate(() => { const a = document.querySelector("#lib-main .hit-go:not(.open-q)"); return a ? { href: a.getAttribute("href") } : null; }).catch(() => null);
  ok(`${label}: a result row links to a page and a fact`, !!row && /^#library\.[^~]+~[a-z0-9_.]+$/.test(row.href), JSON.stringify(row));
  if (row) {
    // results re-render once while the worker fills the first rows; a person clicks later than that, so wait for the list to hold still (bounded: 3 s)
    await page.evaluate(() => new Promise((done) => { const m = document.querySelector("#lib-main"); let t = setTimeout(done, 400); const ob = new MutationObserver(() => { clearTimeout(t); t = setTimeout(done, 400); }); ob.observe(m, { childList: true, subtree: true }); setTimeout(done, 3000); })).catch(() => {});
    await page.evaluate(() => { const a = document.querySelector("#lib-main .hit-go:not(.open-q)"); if (a) a.scrollIntoView({ block: "center" }); }).catch(() => {}); // a row can sit half under the sheet edge; a person scrolls to it
    let clickErr = ""; await page.click("#lib-main .hit-go:not(.open-q)", { timeout: WAIT }).catch((e) => { clickErr = String(e.message || e).replace(/\s+/g, " ").slice(0, 300); });
    const litOk = await until(page, () => !!document.querySelector("#lib-main .lib-page .lf.lit"));
    const why = litOk ? "" : await page.evaluate(() => JSON.stringify({ hash: location.hash, view: document.querySelector("#panel-library").dataset.view, fact: !!document.querySelector("#lib-main .lib-page"), rows: document.querySelectorAll("#lib-main .lf").length })).catch(() => "") + " " + clickErr;
    ok(`${label}: the row opens the page with that fact lit`, litOk, why);
    const lit = await page.evaluate(() => { const r = document.querySelector("#lib-main .lf.lit"); if (!r) return null; const b = r.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, h: innerHeight }; }).catch(() => null);
    ok(`${label}: the lit fact is inside the viewport`, !!lit && lit.bottom > 0 && lit.top < lit.h, JSON.stringify(lit));
  }
  // a question it cannot answer
  await open(page, "library");
  await until(page, () => !!document.querySelector("#lib-q") && document.querySelector("#lib-q").getBoundingClientRect().width > 40);
  await page.fill("#lib-q", "flurble wumpus");
  await page.keyboard.press("Enter");
  ok(`${label}: an unanswerable question shows the empty state`, await until(page, () => document.querySelector("#panel-library").dataset.view === "zero" && !!document.querySelector("#lib-main .lib-empty")));
  const empty = await page.evaluate(() => {
    const e = document.querySelector("#lib-main .lib-empty"); if (!e) return null;
    const a = e.querySelector("a.lib-ask-go"), cs = getComputedStyle(e);
    return { text: e.textContent, href: a && a.getAttribute("href"), label: a && a.textContent, bg: cs.backgroundColor, status: e.getAttribute("role"), count: (document.querySelector("#lib-count") || {}).textContent, anim: e.getAnimations({ subtree: true }).length };
  }).catch(() => null);
  ok(`${label}: it says the Library does not cover that`, !!empty && /The Library does not cover that\./.test(empty.text) && /flurble wumpus/.test(empty.text), empty && empty.text.slice(0, 120));
  ok(`${label}: the count line says it too`, !!empty && /does not cover that/.test(empty.count || ""), empty && empty.count);
  ok(`${label}: the empty card is announced as a status`, !!empty && empty.status === "status");
  ok(`${label}: Ask Leeroy links to the Leeroy scene`, !!empty && empty.href === "#librarian" && /Ask Leeroy/.test(empty.label || ""), JSON.stringify(empty && [empty.href, empty.label]));
  ok(`${label}: the empty card is dark (OLED: luminance at most 0.05)`, !!empty && lum(empty.bg) <= 0.05, empty && empty.bg);
  ok(`${label}: nothing on the empty card animates under reduced motion`, !!empty && empty.anim === 0, empty && String(empty.anim));
  if (OUT) await page.screenshot({ path: path.join(OUT, `library-empty-${label}.png`), timeout: WAIT * 2 }).catch(() => {});
  if (empty && empty.href) {
    await page.click("#lib-main a.lib-ask-go", { timeout: WAIT }).catch(() => {});
    ok(`${label}: Ask Leeroy opens the Leeroy scene`, await until(page, () => location.hash === "#librarian" && !document.querySelector("#panel-librarian").hidden));
    const draft = await page.evaluate(() => { const t = document.querySelector("#ask-text"); return t ? t.value : null; }).catch(() => null);
    ok(`${label}: the question is carried into the ask box (the box exists and holds it)`, draft === "flurble wumpus", String(draft));
  }
  await open(page, "library.q.mage");
  await until(page, () => !!document.querySelector("#lib-main .group-head a"));
  if (OUT) await page.screenshot({ path: path.join(OUT, `library-results-${label}.png`), timeout: WAIT * 2 }).catch(() => {});
  ok(`${label}: no page error`, errors.length === 0, errors.join(" | ").slice(0, 200));
  await ctx.close();
}
try {
  await run("1366x768", { width: 1366, height: 768 }, false);
  await run("390x844", { width: 390, height: 844 }, true);
} finally { await browser.close().catch(() => {}); }
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
