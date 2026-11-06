// Cinematic slice 1 (hierarchy), acceptance checks on the table (home board) at 390x844, Chromium. API answered from tests/fixtures/api-snapshot: zero Worker requests.
//   node hierarchy.mjs --url http://127.0.0.1:8080/   (or env PREVIEW_PAGES; tools/local-browser.sh hierarchy)   --out <dir> writes the screenshots
// Checks: 0 visible text under 12 px; CLS at or under 0.05 over the first 4 s (first visit and a remembered member); the brightest cluster of a blurred frame (cells of
// 48 CSS px, about a 24 px sigma blur) sits on the hero; exactly one hero and three distinct luminance tiers; no counters and no NEW pills on the table; one
// experience control (no depth bar); the totals are inside the Library scene.
import fs from "node:fs";
import path from "node:path";
import { pageUrl } from "../helpers/page-url.mjs";
import { stubbed } from "../helpers/browser-stub.mjs";
const pw = await import("playwright").catch(() => { console.error("playwright not found; run npm install in tests/"); process.exit(2); });
const argv = process.argv.slice(2), arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const BASE = arg("--url") || process.env.PREVIEW_PAGES;
if (!BASE) { console.error("usage: node hierarchy.mjs --url <pages origin> (or set PREVIEW_PAGES)"); process.exit(2); }
const OUT = arg("--out");
if (OUT) fs.mkdirSync(OUT, { recursive: true });
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${extra ? `: ${extra}` : ""}`); } };
const url = pageUrl(BASE, { params: { preview: "1" } });
const CLS_JS = () => { window.__cls = { v: 0, n: [] }; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) { window.__cls.v += e.value; window.__cls.n.push(e.sources.map((s) => (s.node && (s.node.id || s.node.className || s.node.nodeName)) + "").join(",")); } }).observe({ type: "layout-shift", buffered: true }); } catch (e) {} };

// text under 12 px: visible own text whose computed size is under 12 px and whose box is real (a visually hidden label is 1 px or clipped, not counted)
const smallText = () => {
  const out = [];
  for (const el of document.body.querySelectorAll("*")) {
    if (/^(SCRIPT|STYLE|NOSCRIPT|SVG|PATH)$/i.test(el.tagName)) continue;
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim())) continue;
    const cs = getComputedStyle(el), r = el.getBoundingClientRect();
    if (cs.display === "none" || cs.visibility === "hidden" || r.width <= 1 || r.height <= 1 || cs.clip === "rect(0px, 0px, 0px, 0px)" || +cs.opacity === 0) continue;
    if (r.bottom < 0 || r.top > innerHeight * 6) continue;
    const fs = parseFloat(cs.fontSize);
    if (fs > 0 && fs < 12) out.push(`${el.id ? "#" + el.id : el.tagName.toLowerCase() + "." + [...el.classList].join(".")} ${fs}px "${el.textContent.trim().slice(0, 20)}"`);
  }
  return out;
};
// the brightest 48 px cell of a screenshot, in CSS px (area-averaged luminance, no library)
async function brightestCell(page, png, dpr) {
  const b64 = png.toString("base64");
  return page.evaluate(async ({ b64, dpr }) => {
    const img = new Image(); img.src = "data:image/png;base64," + b64; await img.decode();
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height; const g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(img, 0, 0);
    const cell = Math.round(48 * dpr), cols = Math.floor(img.width / cell), rows = Math.floor(img.height / cell);
    let best = { l: -1, x: 0, y: 0 };
    for (let r = 0; r < rows; r++) for (let q = 0; q < cols; q++) {
      const d = g.getImageData(q * cell, r * cell, cell, cell).data; let s = 0;
      for (let i = 0; i < d.length; i += 16) s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      const l = s / (d.length / 16);
      if (l > best.l) best = { l, x: (q * cell + cell / 2) / dpr, y: (r * cell + cell / 2) / dpr };
    }
    return best;
  }, { b64, dpr });
}

const browser = stubbed(await pw.chromium.launch());
try {
  const mk = async (member) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, serviceWorkers: "block" });
    await ctx.addInitScript(CLS_JS);
    if (member) await ctx.addInitScript(() => { try { localStorage.setItem("board-as", "Santa"); localStorage.setItem("board-hinted", "1"); } catch (e) {} });
    return ctx;
  };
  // first visit: Next steps over the wall, nobody signed in
  { const ctx = await mk(false), page = await ctx.newPage();
    await page.goto(url, { waitUntil: "load" }); await page.waitForTimeout(4000);
    const cls = await page.evaluate(() => window.__cls);
    ok("[first visit] CLS at or under 0.05 over 4 s", cls.v <= 0.05, `CLS ${cls.v.toFixed(3)} from ${cls.n.join(" | ")}`);
    const small = await page.evaluate(smallText);
    ok("[first visit] 0 visible text under 12 px", small.length === 0, small.slice(0, 5).join("; "));
    await ctx.close(); }
  // the table: a remembered member, the sheet closed
  const ctx = await mk(true), page = await ctx.newPage();
  await page.goto(url, { waitUntil: "load" });
  await page.waitForTimeout(3000);
  await page.locator("#scene-close").click().catch(() => {});
  await page.waitForTimeout(2200);
  const cls = await page.evaluate(() => window.__cls);
  ok("[table] CLS at or under 0.05 over 5 s", cls.v <= 0.05, `CLS ${cls.v.toFixed(3)} from ${cls.n.join(" | ")}`);
  const small = await page.evaluate(smallText);
  ok("[table] 0 visible text under 12 px", small.length === 0, small.slice(0, 5).join("; "));
  const shape = await page.evaluate(() => {
    const wall = document.querySelector("#wall"), tiers = [...wall.querySelectorAll(":scope > li[data-tier]")].map((li) => ({ k: li.className.split(" ")[0], t: li.dataset.tier, f: getComputedStyle(li).filter }));
    const hero = wall.querySelector(':scope > li[data-tier="1"]'), r = hero && hero.getBoundingClientRect();
    return { tiers, heroFirst: !!hero && hero === wall.firstElementChild, rect: r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null, depth: !!document.querySelector("#depth"), journey: document.querySelectorAll("#journey").length,
      minis: wall.querySelectorAll(".minis").length, badges: document.querySelectorAll("#board .new-badge").length, libNew: !!document.querySelector("#ts-library-new"), wallText: wall.innerText };
  });
  ok("[table] exactly one hero tile and it comes first", shape.tiers.filter((x) => x.t === "1").length === 1 && shape.heroFirst, JSON.stringify(shape.tiers.map((x) => x.k + ":" + x.t)));
  ok("[table] three luminance tiers (three distinct brightness values)", new Set(shape.tiers.map((x) => x.f)).size === 3, JSON.stringify([...new Set(shape.tiers.map((x) => x.f))]));
  ok("[table] no counter blocks on the wall", shape.minis === 0, `${shape.minis} .minis`);
  ok("[table] no NEW pills on the board", shape.badges === 0, `${shape.badges}`);
  ok("[table] no library totals or audit line on the wall", !/\b\d[\d,]*\s*(pages|facts)\b|from Blizzard|open questions|Newest change|No numbers have changed/i.test(shape.wallText) && !shape.libNew, shape.wallText.slice(0, 120));
  ok("[table] one experience control (no depth bar)", !shape.depth && shape.journey === 1);
  const png = await page.screenshot({ path: OUT ? path.join(OUT, "table-390x844.png") : undefined });
  const bright = await brightestCell(page, png, 2), r = shape.rect;
  ok("[table] the brightest cluster of the blurred frame is on the hero", !!r && bright.x >= r.x && bright.x <= r.x + r.w && bright.y >= r.y && bright.y <= r.y + r.h, `cell (${bright.x.toFixed(0)}, ${bright.y.toFixed(0)}) l ${bright.l.toFixed(0)} hero ${r ? JSON.stringify(r) : "none"}`);
  // the totals moved inside the Library scene
  await page.locator("#wall .lib-tile a.tile-band").click();
  await page.waitForSelector("#panel-library:not([hidden]) .lib-stat", { timeout: 8000 }).catch(() => {});
  const stats = await page.evaluate(() => [...document.querySelectorAll("#panel-library .lib-stat")].map((e) => e.textContent.replace(/\s+/g, " ").trim()));
  ok("[library] the totals (pages, facts) are inside the Library scene", stats.some((t) => /pages/.test(t)) && stats.some((t) => /facts/.test(t)), JSON.stringify(stats));
  await ctx.close();
} finally { await browser.close(); }
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
