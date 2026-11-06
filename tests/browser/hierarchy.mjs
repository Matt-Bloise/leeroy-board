// Cinematic slice 1 (hierarchy), acceptance checks on the table (home board) at 390x844, Chromium. API answered from tests/fixtures/api-snapshot: zero Worker requests.
//   node hierarchy.mjs --url http://127.0.0.1:8080/   (or env PREVIEW_PAGES; tools/local-browser.sh hierarchy)   --out <dir> writes the screenshots
// Checks: 0 visible text under 12 px; CLS at or under 0.05 over the first 4 s (first visit and a remembered member); the brightest cluster of a blurred frame (cells of
// 48 CSS px, about a 24 px sigma blur) sits on the hero; exactly one hero and three distinct luminance tiers; no counters and no NEW pills on the table; one
// experience control (no depth bar); the totals are inside the Library scene; the page boots with no #depth and no page error; the Ledger tile never says nothing is
// open while a poll is taking votes; and rendered text in every tier keeps WCAG contrast of 4.5:1 or better at 390 and 1366 wide (measured on the screenshot, so the
// brightness filter is included).
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

// WCAG contrast of text as rendered: background = median luminance of the element's rect in the screenshot (so the tier's dimming of backgrounds and pictures is
// included), text = the element's computed colour (text is never filtered). Rects are in viewport CSS px.
async function contrastOf(page, png, rects, dpr) {
  const b64 = png.toString("base64");
  return page.evaluate(async ({ b64, rects, dpr }) => {
    const img = new Image(); img.src = "data:image/png;base64," + b64; await img.decode();
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height; const g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(img, 0, 0);
    const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return rects.map((r) => {
      const x = Math.max(0, Math.floor(r.x * dpr)), y = Math.max(0, Math.floor(r.y * dpr)), w = Math.min(img.width - x, Math.ceil(r.w * dpr)), h = Math.min(img.height - y, Math.ceil(r.h * dpr));
      if (w < 2 || h < 2) return { ...r, ratio: null };
      const d = g.getImageData(x, y, w, h).data, L = [];
      for (let i = 0; i < d.length; i += 8) L.push(0.2126 * lin(d[i]) + 0.7152 * lin(d[i + 1]) + 0.0722 * lin(d[i + 2]));
      L.sort((a, b) => a - b);
      const med = L[L.length >> 1], m = (r.color.match(/[\d.]+/g) || []).slice(0, 3).map(Number), fg = 0.2126 * lin(m[0]) + 0.7152 * lin(m[1]) + 0.0722 * lin(m[2]);
      const hi = Math.max(med, fg), lo = Math.min(med, fg);
      return { ...r, ratio: (hi + 0.05) / (lo + 0.05) };
    });
  }, { b64, rects, dpr });
}
// the representative text of each tile (and the countdown): its title and its first body line, as rects in page CSS px with the computed text colour
const TEXT_RECTS = () => {
  const out = [], rect = (el, label, tier) => { if (!el) return; const r = el.getBoundingClientRect(); if (r.width > 4 && r.height > 4 && getComputedStyle(el).display !== "none") out.push({ label, tier, color: getComputedStyle(el).color, x: r.x + scrollX, y: r.y + scrollY, w: r.width, h: r.height }); };
  rect(document.querySelector("#clock .clock-event, #clock .clock-kicker"), "clock", "2");
  for (const li of document.querySelectorAll("#wall > li[data-tier]")) {
    const k = li.className.split(" ")[0], t = li.dataset.tier;
    rect(li.querySelector(".tile-title"), `${k} title`, t);
    rect(li.querySelector(".tile-body .tile-line, .tile-body .su-num small, .tile-body .fm-n, .tile-body .loading"), `${k} body`, t);
  }
  return out;
};
// one full-page screenshot per viewport (13 viewport shots per viewport timed out on the CI runner's software renderer: a slice 1 CI lesson)
async function measureAll(page, dpr) {
  // settle first: the entrance stagger is over and the library tile has its line (its text arrives after the index loads and moves the layout)
  await page.waitForFunction(() => !document.querySelector("#wall.settle") && /Find an answer/.test((document.querySelector("#ts-library") || {}).textContent || ""), null, { timeout: 15000 }).catch(() => {});
  let got = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.waitForTimeout(700);
    const rects = await page.evaluate(TEXT_RECTS);
    const png = await page.screenshot({ fullPage: true, timeout: 120000 });
    got = await contrastOf(page, png, rects, dpr);
    if (got.every((r) => r.ratio !== null && r.ratio >= 4.5)) break; // a transient (a layout still moving under the screenshot) gets one re-measure; a real low ratio fails twice
  }
  return got;
}
const browser = stubbed(await pw.chromium.launch());
try {
  const mk = async (member, roomOff = false) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, serviceWorkers: "block" });
    await ctx.addInitScript(CLS_JS);
    if (roomOff) await ctx.addInitScript(() => { try { localStorage.setItem("board-room", "off"); } catch (e) {} }); /* contrast contexts only: the WebGL room is not under test there, and a software renderer made 13 screenshots time out on CI */
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
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url, { waitUntil: "load" });
  await page.waitForTimeout(3000);
  await page.locator("#scene-close").click().catch(() => {});
  await page.waitForTimeout(2200);
  const cls = await page.evaluate(() => window.__cls);
  ok("[table] CLS at or under 0.05 over 5 s", cls.v <= 0.05, `CLS ${cls.v.toFixed(3)} from ${cls.n.join(" | ")}`);
  const small = await page.evaluate(smallText);
  ok("[table] 0 visible text under 12 px", small.length === 0, small.slice(0, 5).join("; "));
  const shape = await page.evaluate(() => {
    const wall = document.querySelector("#wall"), tiers = [...wall.querySelectorAll(":scope > li[data-tier]")].map((li) => ({ k: li.className.split(" ")[0], t: li.dataset.tier, f: getComputedStyle(li).getPropertyValue("--tv").trim() }));
    const hero = wall.querySelector(':scope > li[data-tier="1"]'), r = hero && hero.getBoundingClientRect();
    return { tiers, heroFirst: !!hero && hero === wall.firstElementChild, rect: r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null, depth: !!document.querySelector("#depth"), journey: document.querySelectorAll("#journey").length,
      minis: wall.querySelectorAll(".minis").length, badges: document.querySelectorAll("#board .new-badge").length, libNew: !!document.querySelector("#ts-library-new"), wallText: wall.innerText };
  });
  ok("[table] exactly one hero tile and it comes first", shape.tiers.filter((x) => x.t === "1").length === 1 && shape.heroFirst, JSON.stringify(shape.tiers.map((x) => x.k + ":" + x.t)));
  ok("[table] three luminance tiers (three distinct --tv values)", new Set(shape.tiers.map((x) => x.f)).size === 3, JSON.stringify([...new Set(shape.tiers.map((x) => x.f))]));
  ok("[table] no counter blocks on the wall", shape.minis === 0, `${shape.minis} .minis`);
  ok("[table] no NEW pills on the board", shape.badges === 0, `${shape.badges}`);
  ok("[table] no library totals or audit line on the wall", !/\b\d[\d,]*\s*(pages|facts)\b|from Blizzard|open questions|Newest change|No numbers have changed/i.test(shape.wallText) && !shape.libNew, shape.wallText.slice(0, 120));
  ok("[table] one experience control (no depth bar)", !shape.depth && shape.journey === 1);
  const png = await page.screenshot({ path: OUT ? path.join(OUT, "table-390x844.png") : undefined, timeout: 120000 });
  const bright = await brightestCell(page, png, 2), r = shape.rect;
  ok("[table] the brightest cluster of the blurred frame is on the hero", !!r && bright.x >= r.x && bright.x <= r.x + r.w && bright.y >= r.y && bright.y <= r.y + r.h, `cell (${bright.x.toFixed(0)}, ${bright.y.toFixed(0)}) l ${bright.l.toFixed(0)} hero ${r ? JSON.stringify(r) : "none"}`);
  ok("[table] the page booted with no #depth and raised no page error (startDepth, markNew gone)", errors.length === 0 && !shape.depth, errors.join("; "));
  // the totals moved inside the Library scene
  await page.locator("#wall .lib-tile a.tile-band").click();
  await page.waitForSelector("#panel-library:not([hidden]) .lib-stat", { timeout: 8000 }).catch(() => {});
  const stats = await page.evaluate(() => [...document.querySelectorAll("#panel-library .lib-stat")].map((e) => e.textContent.replace(/\s+/g, " ").trim()));
  ok("[library] the totals (pages, facts) are inside the Library scene", stats.some((t) => /pages/.test(t)) && stats.some((t) => /facts/.test(t)), JSON.stringify(stats));
  await ctx.close();
  // contrast at 390 in a room-off context (same page, no WebGL room)
  { const cctx = await mk(true, true), cp = await cctx.newPage();
    await cp.goto(url, { waitUntil: "load" }); await cp.waitForTimeout(3000); await cp.locator("#scene-close").click().catch(() => {}); await cp.waitForTimeout(2200);
  const got = await measureAll(cp, 2);
  for (const r of got) ok(`[table 390] contrast ${r.label} (tier ${r.tier}) at 4.5:1 or better`, r.ratio !== null && r.ratio >= 4.5, r.ratio === null ? "no rect" : `${r.ratio.toFixed(2)}:1`);
  console.log("INFO contrast 390 " + got.map((r) => `${r.label}=${r.ratio ? r.ratio.toFixed(1) : "-"}`).join(" "));
    await cctx.close(); }
  // wide screen: the same contrast rule at 1366x768
  { const wctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1, serviceWorkers: "block" });
    await wctx.addInitScript(() => { try { localStorage.setItem("board-as", "Santa"); localStorage.setItem("board-hinted", "1"); localStorage.setItem("board-room", "off"); } catch (e) {} });
    const wp = await wctx.newPage(); await wp.goto(url, { waitUntil: "load" }); await wp.waitForTimeout(3000);
    await wp.locator("#scene-close").click().catch(() => {}); await wp.waitForTimeout(2200);
    const wg = await measureAll(wp, 1);
    for (const r of wg) ok(`[table 1366] contrast ${r.label} (tier ${r.tier}) at 4.5:1 or better`, r.ratio !== null && r.ratio >= 4.5, r.ratio === null ? "no rect" : `${r.ratio.toFixed(2)}:1`);
    console.log("INFO contrast 1366 " + wg.map((r) => `${r.label}=${r.ratio ? r.ratio.toFixed(1) : "-"}`).join(" "));
    await wctx.close(); }
  // the Ledger tile with a poll-only, an empty and an open-only party (data/party.json rewritten in the page; no API)
  const noBrain = new URL(url); noBrain.searchParams.delete("brain");
  const ledger = async (mutate) => {
    const c = await mk(true);
    await c.route("**/data/party.json", async (route) => { const r = await route.fetch(); const j = JSON.parse(await r.text()); mutate(j); await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(j) }); });
    const pg = await c.newPage(); await pg.goto(noBrain.href, { waitUntil: "load" }); await pg.waitForTimeout(3000);
    const t = await pg.evaluate(() => document.querySelector("#ts-ledger").textContent.replace(/\s+/g, " ")); await c.close(); return t;
  };
  const far = 4e9;
  const pollOnly = await ledger((j) => { j.open = []; j.polls = [{ title: "Pick a guild name", text: "a poll", url: "https://example.invalid/p", closes_epoch: far }]; j.polls_closed = []; });
  ok("[ledger] poll-only: the tile names the poll and does not say nothing is open", /A poll is taking votes: Pick a guild name/.test(pollOnly) && !/Nothing is open/.test(pollOnly), pollOnly.slice(0, 160));
  const empty = await ledger((j) => { j.open = []; j.polls = []; j.polls_closed = []; });
  ok("[ledger] nothing open and no poll: the tile says so", /Nothing is open right now/.test(empty), empty.slice(0, 160));
  const openOnly = await ledger((j) => { j.open = [{ title: "Pick a raid night", text: "x" }]; j.polls = []; j.polls_closed = []; });
  ok("[ledger] an open decision is named first", /Needs a vote: Pick a raid night/.test(openOnly), openOnly.slice(0, 160));
} finally { await browser.close(); }
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
