// Accessibility details axe does not catch (found by a manual audit, 3 November 2026). Stubbed, no Worker request, no AI call.
//   node a11y-hygiene.mjs --url https://pr-N.leeroy-board.pages.dev/   (or env PREVIEW_PAGES)
// Checks: the Leeroy bar hint text has at least 4.5:1 contrast on its parchment; the footer links are at least 44x44 px on a touch screen; a panel that is a Tab stop shows a focus ring;
// Escape on the first-visit card leaves focus on a real element (it dropped to <body>).
import { stubbed } from "../helpers/browser-stub.mjs";
import { pageUrl } from "../helpers/page-url.mjs";
const pw = await import("playwright").catch(() => { console.error("playwright not found; run npm install in tests/"); process.exit(2); });
const argv = process.argv.slice(2), ui = argv.indexOf("--url");
const BASE = (ui >= 0 && argv[ui + 1]) || process.env.PREVIEW_PAGES;
if (!BASE) { console.error("usage: node a11y-hygiene.mjs --url <pages origin> (or set PREVIEW_PAGES)"); process.exit(2); }
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${extra ? `: ${extra}` : ""}`); } };
const launch = process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ["--no-sandbox"] } : {};
const browser = stubbed(await pw.chromium.launch(launch), { label: "a11y-hygiene api-stub" });
const url = pageUrl(BASE, { params: { preview: "1" } });
const CTX = [["1366x768", { viewport: { width: 1366, height: 768 } }], ["768x1024 touch", { viewport: { width: 768, height: 1024 }, hasTouch: true, isMobile: true }], ["390x844 touch", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }]];
const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

for (const [size, opts] of CTX) {
  const tag = `[${size}]`, touch = !!opts.hasTouch;
  const ctx = await browser.newContext({ ...opts, serviceWorkers: "block", reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "load" });
  await page.waitForSelector("#nx-fr2-look", { state: "visible", timeout: 20000 });
  await page.waitForTimeout(800);

  /* Escape on the first-visit card: focus must not drop to <body> */
  if (!touch) {
    await page.keyboard.press("Tab");
    await page.keyboard.press("Escape"); await page.waitForTimeout(900);
    const a = await page.evaluate(() => { const e = document.activeElement; return { tag: e && e.tagName, id: e && e.id, scene: document.documentElement.classList.contains("scene-open") }; });
    ok(`${tag} Escape on the first-visit card closes it and focus lands on a real element, not <body>`, !a.scene && a.tag !== "BODY" && a.tag !== undefined, JSON.stringify(a));
  }

  await page.getByText("Just take a look", { exact: false }).first().click({ timeout: 15000 }).catch(() => { });
  await page.waitForTimeout(1200);

  /* the footer links: touch target */
  const legal = await page.evaluate(() => { const e = document.querySelector("#foot-legal"), t = document.querySelector("#foot-trust"), r = (x) => { if (!x) return null; const b = x.getBoundingClientRect(); return [Math.round(b.width), Math.round(b.height)]; }; return { legal: r(e), trust: r(t), coarse: matchMedia("(pointer: coarse)").matches }; });
  if (touch) ok(`${tag} footer links are at least 44x44 on touch`, legal.coarse && legal.legal && legal.legal[0] >= 44 && legal.legal[1] >= 44 && legal.trust && legal.trust[0] >= 44 && legal.trust[1] >= 44, JSON.stringify(legal));
  else ok(`${tag} footer links keep their text size with a mouse (no touch padding)`, legal.legal && legal.legal[1] < 44, JSON.stringify(legal));

  /* the Leeroy bar hint: contrast */
  /* the bar scene is lazy: open it so chamber.js builds the hint. Which of the bar and the chat is shown depends on the Worker, so the check reads the element's computed colours, shown or not. */
  await page.evaluate(() => { location.hash = "librarian"; }); await page.waitForSelector(".ch-still-how", { state: "attached", timeout: 15000 }).catch(() => {}); await page.waitForTimeout(500);
  const c = await page.evaluate(() => {
    const el = document.querySelector(".ch-still-how"); if (!el) return null;
    const rgb = (s) => (s.match(/[\d.]+/g) || []).map(Number);
    let bg = null; for (let n = el; n && !bg; n = n.parentElement) { const v = rgb(getComputedStyle(n).backgroundColor); if (v.length >= 3 && (v.length < 4 || v[3] > 0.99)) bg = v.slice(0, 3); }
    const cs = getComputedStyle(el); return { fg: rgb(cs.color).slice(0, 3), bg: bg || [255, 255, 255], op: Number(cs.opacity) };
  });
  if (c) { const mixed = c.fg.map((v, i) => v * c.op + c.bg[i] * (1 - c.op)); ok(`${tag} .ch-still-how contrast is at least 4.5:1`, ratio(mixed, c.bg) >= 4.5, `${ratio(mixed, c.bg).toFixed(2)}:1 ${JSON.stringify(c)}`); }
  else ok(`${tag} .ch-still-how is built by the bar scene`, false, "missing");

  /* a panel that is a Tab stop shows a ring when focused from the keyboard */
  await page.evaluate(() => { location.hash = "tonight"; }); await page.waitForTimeout(1500);
  if (!touch) {
    await page.keyboard.press("Tab");
    const ring = await page.evaluate(() => { const p = document.querySelector("#panel-tonight"); if (!p || p.hidden) return null; p.focus(); const cs = getComputedStyle(p); return { fv: p.matches(":focus-visible"), style: cs.outlineStyle, width: parseFloat(cs.outlineWidth) }; });
    ok(`${tag} #panel-tonight shows a focus ring when focused from the keyboard`, ring && ring.fv && ring.style !== "none" && ring.width >= 2, JSON.stringify(ring));
  }
  await ctx.close();
}
await browser.close();
console.log(`a11y-hygiene: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
