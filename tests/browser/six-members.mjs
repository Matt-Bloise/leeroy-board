// Six-member board check (flag party.n): the board is loaded with a six-member fixture, made-up names only, and checked at five widths.
//   node six-members.mjs --url https://pr-N.leeroy-board.pages.dev/   (or env PREVIEW_PAGES)   optional: env PW_CHROMIUM = path to a Chromium binary
// Nothing is sent and there is no AI call. data/party.json, data/signups.json and data/client.json are answered from tests/fixtures/six-members (client.json is the
// real file with the flag party.n switched on); both the static path and the Worker path (/api/data/<name>) are intercepted, /api/bootstrap is refused so the board
// falls back to them. Widths: 320, 390, 768, 1024, 1366. Per width, flag on: six name chips; none cut off or off screen; no overlap; each at least 44px tall; no horizontal
// scroll; the roster (The party scene) shows six cards and the front tile six medallions; no visible text, label or title says "five". Once, flag off: the old copy
// ("The five") is unchanged. Exit 0 when every check passes, 1 otherwise.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const pw = await import("playwright").catch(() => { console.error("playwright not found; run npm install in tests/"); process.exit(2); });
const argv = process.argv.slice(2), ui = argv.indexOf("--url");
const BASE = (ui >= 0 && argv[ui + 1]) || process.env.PREVIEW_PAGES;
if (!BASE) { console.error("usage: node six-members.mjs --url <pages origin> (or set PREVIEW_PAGES)"); process.exit(2); }
const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = (n) => fs.readFileSync(path.join(here, "..", "fixtures", "six-members", `${n}.json`), "utf8");
const PARTY = FIX("party"), SIGNUPS = FIX("signups");
const NAMES = JSON.parse(PARTY).members.map((m) => m.name);
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${extra ? `: ${extra}` : ""}`); } };
const WIDTHS = [320, 390, 768, 1024, 1366];
const DATA_RE = /\/(?:api\/)?data\/(party|signups|client)(?:\.json)?(?:\?|$)/;
const json = (route, body) => route.fulfill({ status: 200, contentType: "application/json", headers: { "cache-control": "no-store", "access-control-allow-origin": "*" }, body });

async function setup(browser, width, flagOn) {
  const phone = width < 768;
  const ctx = await browser.newContext({ viewport: { width, height: phone ? 800 : 900 }, hasTouch: phone, isMobile: phone, serviceWorkers: "block", reducedMotion: "reduce" });
  await ctx.route("**/api/bootstrap*", (r) => r.abort());
  await ctx.route(DATA_RE, async (route) => {
    const n = DATA_RE.exec(route.request().url())[1];
    if (n === "party") return json(route, PARTY);
    if (n === "signups") return json(route, SIGNUPS);
    const res = await route.fetch(), j = await res.json();
    j.flags = { ...(j.flags || {}), "party.n": flagOn };
    return json(route, JSON.stringify(j));
  });
  const page = await ctx.newPage(), errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE.replace(/\/$/, "")}/?preview=1`, { waitUntil: "load" });
  await page.waitForSelector("#nx-fr2-look, .tn-name", { state: "attached", timeout: 20000 }).catch(() => {});
  const look = page.locator("#nx-fr2-look");
  if (await look.count() && await look.isVisible().catch(() => false)) await look.click();
  await page.waitForSelector(".tn-name", { state: "visible", timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(600);
  return { ctx, page, errors };
}

const chipInfo = (page) => page.evaluate(() => {
  const vw = document.documentElement.clientWidth;
  const chips = Array.from(document.querySelectorAll(".tn-name")).filter((b) => b.getClientRects().length).map((b) => { const r = b.getBoundingClientRect(); return { t: b.textContent.trim(), x: r.left, y: r.top, w: r.width, h: r.height, r: r.right, b: r.bottom, clipped: b.scrollWidth > b.clientWidth + 1 }; });
  let overlap = 0;
  for (let i = 0; i < chips.length; i++) for (let j = i + 1; j < chips.length; j++) {
    const a = chips[i], c = chips[j], dx = Math.min(a.r, c.r) - Math.max(a.x, c.x), dy = Math.min(a.b, c.b) - Math.max(a.y, c.y);
    if (dx > 1 && dy > 1) overlap++;
  }
  return { vw, sw: document.documentElement.scrollWidth, bw: document.body.scrollWidth, chips, overlap };
});

// Visible text plus the labels a reader or screen reader gets. Library and glossary prose that is not about the party is not on these screens.
const fiveCopy = (page) => page.evaluate(() => {
  const hits = [], re = /\bfive\b/i;
  const seen = (el) => !!(el.getClientRects().length) && getComputedStyle(el).visibility !== "hidden";
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) { const p = n.parentElement; if (p && !/^(SCRIPT|STYLE|NOSCRIPT)$/.test(p.tagName) && re.test(n.nodeValue) && seen(p)) hits.push(`text: ${n.nodeValue.trim().slice(0, 80)}`); }
  for (const el of document.querySelectorAll("[aria-label],[title]")) for (const a of ["aria-label", "title"]) { const v = el.getAttribute(a); if (v && re.test(v) && seen(el)) hits.push(`${a}: ${v.slice(0, 80)}`); }
  return hits;
});

const browser = await pw.chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
try {
  ok("fixture has six made-up members", NAMES.length === 6 && new Set(NAMES).size === 6, NAMES.join(", "));
  for (const width of WIDTHS) {
    const t = `[${width}]`, { ctx, page, errors } = await setup(browser, width, true);
    const c = await chipInfo(page);
    ok(`${t} six name chips`, c.chips.length === 6 && NAMES.every((n) => c.chips.some((x) => x.t === n)), c.chips.map((x) => x.t).join(" | "));
    ok(`${t} no horizontal scroll`, c.sw <= c.vw + 1 && c.bw <= c.vw + 1, `viewport ${c.vw}, document ${c.sw}, body ${c.bw}`);
    ok(`${t} every chip on screen sideways`, c.chips.every((x) => x.x >= -0.5 && x.r <= c.vw + 0.5), JSON.stringify(c.chips.map((x) => [Math.round(x.x), Math.round(x.r)])));
    ok(`${t} no chip text cut off`, c.chips.every((x) => !x.clipped), c.chips.filter((x) => x.clipped).map((x) => x.t).join(", "));
    ok(`${t} no chips overlap`, c.overlap === 0, `${c.overlap} overlapping pairs`);
    ok(`${t} every chip is at least 44px tall`, c.chips.every((x) => x.h >= 44), c.chips.map((x) => Math.round(x.h * 10) / 10).join(", "));
    const front = await fiveCopy(page);
    ok(`${t} first screen: no copy says "five"`, front.length === 0, front.join(" || "));
    ok(`${t} the front tile shows six medallions`, (await page.locator("#ts-five .med").count()) === 6, String(await page.locator("#ts-five .med").count()));
    await page.goto(`${BASE.replace(/\/$/, "")}/?preview=1#five`, { waitUntil: "load" });
    await page.waitForSelector("#cards .card", { state: "attached", timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1200);
    ok(`${t} the roster shows six cards`, (await page.locator("#cards .card").count()) === 6, String(await page.locator("#cards .card").count()));
    ok(`${t} the scene is titled for the party`, /The party/.test(await page.locator("#sheet-title").innerText().catch(() => "")) || /The party/.test(await page.locator("#tab-five").innerText().catch(() => "")));
    const scene = await fiveCopy(page);
    ok(`${t} roster scene: no copy says "five"`, scene.length === 0, scene.join(" || "));
    const c2 = await chipInfo(page);
    ok(`${t} no horizontal scroll on the roster scene`, c2.sw <= c2.vw + 1 && c2.bw <= c2.vw + 1, `viewport ${c2.vw}, document ${c2.sw}`);
    ok(`${t} no page errors`, errors.length === 0, errors.join(" | "));
    await ctx.close();
  }
  // Flag off is production today: six members in the data change nothing about the wording.
  const off = await setup(browser, 1366, false);
  const copy = await off.page.evaluate(() => [document.getElementById("tab-five") && document.getElementById("tab-five").textContent.trim(), document.querySelector("#panel-five .swipe-hint") && document.querySelector("#panel-five .swipe-hint").textContent.trim()]);
  ok("[flag off] the old copy is unchanged", copy[0] === "The five" && copy[1] === "Swipe sideways for all five.", JSON.stringify(copy));
  ok("[flag off] chips still come from the data", (await chipInfo(off.page)).chips.length === 6);
  await off.ctx.close();
} finally { await browser.close(); }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
