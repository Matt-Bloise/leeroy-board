// Navigation collapse check (flag firstrun.v2): until the first value event the ribbon, journeys, depth, Sensory and room toggles are hidden and one Menu stands in.
//   node nav-collapse.mjs --url https://pr-N.leeroy-board.pages.dev/   (or env PREVIEW_PAGES)
// No AI call, nothing sent. Viewports: 390x844 (touch), 1080x1920, 1366x768. Per viewport, on a first visit: counts the visible nav items (buttons, links, tabs,
// selects, ranges outside the first-run card); desktop shows only Menu and Close, a phone shows the bottom bar Next, My sheet, Menu and Close. Then fires
// board:first-value and checks the ribbon (tabs) is back and the Menu button is gone. On a phone the title must not overlap any control beside it.
// Exit 0 when every check passes, 1 otherwise.
const pw = await import("playwright").catch(() => { console.error("playwright not found; run npm install in tests/"); process.exit(2); });
const argv = process.argv.slice(2), arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const BASE = arg("--url") || process.env.PREVIEW_PAGES;
if (!BASE) { console.error("usage: node nav-collapse.mjs --url <pages origin> (or set PREVIEW_PAGES)"); process.exit(2); }
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${extra ? `: ${extra}` : ""}`); } };
const SIZES = [["390x844", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }], ["1080x1920", { viewport: { width: 1080, height: 1920 } }], ["1366x768", { viewport: { width: 1366, height: 768 } }]];
const url = `${BASE.replace(/\/$/, "")}/?preview=1`;

const navItems = (page) => page.evaluate(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(); if (!r.width || !r.height) return false; for (let n = e; n && n.nodeType === 1; n = n.parentElement) { const c = getComputedStyle(n); if (c.display === "none" || c.visibility === "hidden" || parseFloat(c.opacity) < 0.1) return false; } return true; };
  const inScene = !document.getElementById("scene").hidden;
  return Array.from(document.querySelectorAll("button, a[href], select, input, [role=tab]"))
    .filter((e) => vis(e) && !e.closest("#nx-fr2") && !(inScene && e.closest("#board")) && !e.closest(".skip"))
    .map((e) => (e.id || (e.textContent || "").trim() || e.tagName).slice(0, 30));
});

const browser = await pw.chromium.launch();
try {
  for (const [tag, opts] of SIZES) {
    const ctx = await browser.newContext({ ...opts, serviceWorkers: "block" }), page = await ctx.newPage(), errors = [], t = `[${tag}]`;
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(url, { waitUntil: "load" });
    await page.waitForSelector("#nx-fr2-go", { state: "visible", timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(800);
    const phone = opts.viewport.width < 700, items = await navItems(page);
    const want = phone ? ["Next", "My sheet", "Menu", "scene-close"] : ["nav-menu", "scene-close"];
    ok(`${t} first screen heading and primary button`, (await page.locator("#nx-fr2-h").isVisible()) && (await page.locator("#nx-fr2-go").isVisible()) && (await page.locator("#nx-fr2-look").isVisible()));
    ok(`${t} visible nav items = ${want.length}`, items.length === want.length && want.every((w) => items.includes(w)), items.join(", "));
    ok(`${t} ribbon, journeys, Sensory, room hidden`, await page.evaluate(() => ["tabs", "journey", "journey-scene", "sense-btn", "scene-peek", "depth", "room-pick"].every((id) => { const e = document.getElementById(id); return !e || !e.getClientRects().length || getComputedStyle(e).display === "none" || !!e.closest("[hidden]") || getComputedStyle(e.closest("#board") || e).display === "none" || getComputedStyle(e).visibility === "hidden" || (e.id === "room-pick" || e.id === "depth") && !document.getElementById("scene").hidden; })));
    if (phone) {
      const ov = await page.evaluate(() => {
        const t = document.getElementById("sheet-title"), n = t && t.closest(".sheet-name"); if (!t || !n) return ["no title"];
        const r = t.getBoundingClientRect(), nr = n.getBoundingClientRect(), bad = [];
        if (r.right > nr.right - 36 + 0.5) bad.push("under crest ribbon");
        for (const e of document.querySelectorAll(".sheet-top > *")) { if (e.contains(t)) continue; const c = getComputedStyle(e); if (c.display === "none" || c.visibility === "hidden") continue; const x = e.getBoundingClientRect(); if (x.width && x.left < r.right && x.right > r.left && x.top < r.bottom && x.bottom > r.top) bad.push(e.id || e.className); }
        return bad;
      });
      ok(`${t} title overlaps nothing`, ov.length === 0, ov.join(", "));
    }
    await page.evaluate(() => document.dispatchEvent(new CustomEvent("board:first-value")));
    await page.waitForTimeout(600);
    const after = await navItems(page);
    ok(`${t} after first value the ribbon returns`, after.includes(phone ? "More" : "tab-tonight") && !after.includes("nav-menu") && (phone || after.length >= 5), after.join(", "));
    if (phone) {
      const ov2 = await page.evaluate(() => { const t = document.getElementById("sheet-title"), r = t.getBoundingClientRect(), nr = t.closest(".sheet-name").getBoundingClientRect(); return r.right <= nr.right - 36 + 0.5; });
      ok(`${t} title clear of the crest after reveal`, ov2);
    }
    ok(`${t} no page errors`, errors.length === 0, errors.join(" | "));
    await ctx.close();
  }
} finally { await browser.close(); }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
