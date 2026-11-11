// Close guard and focus after close, Chromium, fixtures, zero Worker requests.
//   node close-guard.mjs --url http://127.0.0.1:8080/   (or env PREVIEW_PAGES; tools/local-browser.sh close-guard)
// A: two close requests inside ONE task (key repeat, Escape plus the close button). The browser's own Back button bypasses requestClose (it only raises popstate), so this guard cannot cover Escape plus a real Back press must call history.back() once: the page stays on the site and the scene closes exactly once.
//    Before the guard the second history.back() left the page (about:blank in this probe).
// B: after a close, focus is on the tile, or on the main landmark while the tile has no layout box yet, and never stays on <body>; the tile takes focus once it has a box.
import { pageUrl } from "../helpers/page-url.mjs";
import { stubbed } from "../helpers/browser-stub.mjs";
const pw = await import("playwright").catch(() => { console.error("playwright not found; run npm install in tests/"); process.exit(2); });
const argv = process.argv.slice(2), arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const BASE = arg("--url") || process.env.PREVIEW_PAGES;
if (!BASE) { console.error("usage: node close-guard.mjs --url <pages origin> (or set PREVIEW_PAGES)"); process.exit(2); }
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${extra ? `: ${extra}` : ""}`); } };
const THROTTLE = Number(arg("--throttle") || 1);
const browser = stubbed(await pw.chromium.launch());
const TILE = '#wall a.tile[data-scene="roads"]';
async function fresh() {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, serviceWorkers: "block" });
  await ctx.addInitScript(() => { try { localStorage.setItem("board-as", "Santa"); localStorage.setItem("board-hinted", "1"); localStorage.setItem("board-room", "off"); } catch (e) {} });
  const page = await ctx.newPage();
  if (THROTTLE > 1) { const cdp = await ctx.newCDPSession(page); await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE }); }
  await page.goto("about:blank"); await page.goto(pageUrl(BASE, { params: { preview: "1" } }), { waitUntil: "load" });
  await page.waitForFunction(() => !!document.querySelector("#wall .tile"), null, { timeout: 15000 });
  await page.locator("#scene-close").click({ timeout: 8000 }).catch(() => {});
  await page.waitForFunction(() => { const l = document.querySelector("#scene"); return (l.hidden || l.classList.contains("warming")) && !l.classList.contains("closing"); }, null, { timeout: 6000 }).catch(() => {});
  return { ctx, page };
}
const open = async (page) => { await page.locator(TILE).focus(); await page.locator(TILE).dispatchEvent("click"); await page.waitForFunction(() => document.documentElement.classList.contains("scene-open") && !document.querySelector("#scene").classList.contains("opening"), null, { timeout: 5000 }); await page.waitForTimeout(700); };
const shut = (page) => page.waitForFunction(() => { const l = document.querySelector("#scene"); return (l.hidden || l.classList.contains("warming")) && !l.classList.contains("closing") && !document.documentElement.classList.contains("scene-open"); }, null, { timeout: 4000 }).then(() => true, () => false);

try {
  for (const mode of ["esc,esc", "esc,closebtn"]) {
    const { ctx, page } = await fresh();
    await open(page);
    await page.evaluate(() => { window.__backs = 0; window.__pops = 0; const b = history.back; history.back = function () { window.__backs++; return b.apply(this, arguments); }; addEventListener("popstate", () => window.__pops++); });
    const url0 = page.url();
    await page.evaluate((m) => { const k = () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); k(); if (m === "esc,esc") k(); else document.querySelector("#scene-close").click(); }, mode);
    const closed = await shut(page); await page.waitForTimeout(800);
    const res = await page.evaluate(() => ({ backs: window.__backs, pops: window.__pops, hash: location.hash })).catch(() => null);
    ok(`[${mode}] two close requests in one task: the page stays on the site`, res !== null && page.url().replace(/#.*$/, "") === url0.replace(/#.*$/, ""), page.url());
    ok(`[${mode}] history.back() is called once and the scene closes once`, closed && res && res.backs === 1 && res.pops === 1 && res.hash !== "#roads", JSON.stringify(res) + ` closed=${closed}`);
    await ctx.close();
  }
  { // a later close request still works (the flag never sticks)
    const { ctx, page } = await fresh();
    for (let i = 0; i < 3; i++) { await open(page); await page.keyboard.press("Escape"); const c = await shut(page); ok(`[repeat ${i + 1}] open then Escape closes again`, c && page.url().startsWith("http")); await page.waitForTimeout(300); }
    await ctx.close();
  }
  { // B: the tile is briefly not laid out when the scene closes
    const { ctx, page } = await fresh();
    await open(page);
    await page.evaluate((sel) => { const t = document.querySelector(sel); t.style.display = "none"; window.__bodyFocus = []; document.addEventListener("focusout", () => setTimeout(() => { if (document.activeElement === document.body) window.__bodyFocus.push(Math.round(performance.now())); }, 0), true); window.__restore = () => { t.style.display = ""; }; }, TILE);
    await page.keyboard.press("Escape");
    await shut(page); await page.waitForTimeout(100); /* the tile comes back a short, fixed time AFTER the close finished, well inside the 1500 ms retry window */
    const mid = await page.evaluate(() => { const a = document.activeElement; return { tag: a ? a.tagName + (a.id ? "#" + a.id : "") : "none", body: a === document.body, cls: a && a.className, href: a && a.getAttribute("href"), box: a ? a.getClientRects().length : -1 }; });
    ok("[tile not laid out] focus is on the main landmark, not on <body>, while the tile has no box", !mid.body && mid.tag === "MAIN#main", JSON.stringify(mid));
    await page.waitForTimeout(200); await page.evaluate(() => window.__restore());
    await page.waitForFunction((sel) => document.activeElement === document.querySelector(sel), TILE, { timeout: 2500 }).catch(() => {});
    const end = await page.evaluate((sel) => ({ onTile: document.activeElement === document.querySelector(sel), body: document.activeElement === document.body }), TILE);
    ok("[tile not laid out] once the tile has a box it takes focus", end.onTile && !end.body, JSON.stringify(end));
    await ctx.close();
  }
  { // B: a plain close puts focus on the tile
    const { ctx, page } = await fresh();
    await open(page); await page.keyboard.press("Escape"); await shut(page);
    await page.waitForFunction((sel) => document.activeElement === document.querySelector(sel), TILE, { timeout: 2500 }).catch(() => {});
    ok("[plain close] focus is on the tile", await page.evaluate((sel) => document.activeElement === document.querySelector(sel), TILE));
    await ctx.close();
  }
} finally { await browser.close(); }
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
