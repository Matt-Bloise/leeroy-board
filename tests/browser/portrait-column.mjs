// Portrait column check (Q21): the first screen at 390x844, 1080x1920 and 3440x1440 against a deployed board. Reads only; nothing is sent.
//   node portrait-column.mjs --url https://pr-13.leeroy-board.pages.dev/   (or env PREVIEW_PAGES)
// Every size: no horizontal overflow, no console or page errors. Screenshots go to portrait-column-<size>.png.
// 1080x1920 (portrait, under 1200 wide): the open sheet is one centred column of at most 720 px, sized by its content (the body has no empty parchment below the
// last card, and the sheet is at least 60 percent of the height or ends with the card), the cloth banner ribbons are gone, the tabs sit in one strip,
// the Next steps cards stack, and the decorative moon is below the content.
// Exit 0 when every check passes, 1 otherwise.
const pw = await import("playwright").catch(() => { console.error("playwright not found; run npm install in tests/"); process.exit(2); });
const argv = process.argv.slice(2), ui = argv.indexOf("--url");
const BASE = (ui >= 0 && argv[ui + 1]) || process.env.PREVIEW_PAGES;
if (!BASE) { console.error("usage: node portrait-column.mjs --url <pages origin> (or set PREVIEW_PAGES)"); process.exit(2); }
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${extra ? `: ${extra}` : ""}`); } };
const CTX = [
  ["390x844", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }],
  ["1080x1920", { viewport: { width: 1080, height: 1920 } }],
  ["3440x1440", { viewport: { width: 3440, height: 1440 } }],
];
const browser = await pw.chromium.launch();
for (const [size, opts] of CTX) {
  const tag = `[${size}]`, errors = [];
  const ctx = await browser.newContext({ ...opts, serviceWorkers: "block" });
  await ctx.addInitScript(() => { try { sessionStorage.setItem("board-pass", "review"); } catch (e) {} });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`pageerror ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/^Failed to load resource|cloudflareinsights/.test(m.text())) errors.push(m.text()); });
  await page.goto(BASE, { waitUntil: "load", timeout: 45000 });
  await page.waitForFunction(() => window.__boardKit && window.__boardKit.goScene, null, { timeout: 15000 }).catch(() => {});
  await page.evaluate(() => window.__boardKit.goScene("tonight")).catch(() => {});
  await page.locator("#panel-tonight").waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  ok(`${tag} no horizontal overflow`, over <= 1, String(over));
  const m = await page.evaluate(() => {
    const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom, w: b.width, h: b.height }; };
    const body = document.querySelector("#sheet-body"), panel = document.querySelector("#panel-tonight");
    const kids = [...panel.children].filter((c) => c.getBoundingClientRect().height > 0);
    const last = kids.length ? kids[kids.length - 1].getBoundingClientRect().bottom : 0;
    const cards = [...document.querySelectorAll("#panel-tonight > .tn-cards > *")].map((c) => c.getBoundingClientRect().left);
    return { sheet: r(".sheet"), body: r("#sheet-body"), orn: r("#sheet-orn"), ornShown: !!document.querySelector("#sheet-orn") && getComputedStyle(document.querySelector("#sheet-orn")).display !== "none",
      slack: body.scrollHeight - body.clientHeight, last, cards, vw: innerWidth, vh: innerHeight,
      clothShown: !!document.querySelector("#tab-cloth") && getComputedStyle(document.querySelector("#tab-cloth")).display !== "none",
      tabH: Math.max(0, ...[...document.querySelectorAll("#tabs .tab")].map((t) => t.getBoundingClientRect().height)) };
  });
  ok(`${tag} the sheet is inside the viewport width`, m.sheet && m.sheet.l >= -0.5 && m.sheet.r <= m.vw + 0.5, JSON.stringify(m.sheet));
  if (size === "1080x1920") {
    ok(`${tag} one column, 720 px at most`, m.sheet.w <= 720.5 && m.sheet.w >= 600, String(m.sheet.w));
    ok(`${tag} the column is centred`, Math.abs((m.sheet.l + m.sheet.r) / 2 - m.vw / 2) <= 2, `${m.sheet.l}..${m.sheet.r}`);
    ok(`${tag} sized by its content (no empty parchment under the last card)`, m.slack <= 1 && m.body.b - m.last <= m.vh * 0.12 + 160, `slack=${m.slack} gap=${Math.round(m.body.b - m.last)}`);
    ok(`${tag} fills 60 percent of the height or ends with the card`, m.sheet.h >= 0.6 * m.vh || m.body.b - m.last <= 200, `h=${Math.round(m.sheet.h)} of ${m.vh}`);
    ok(`${tag} no banner ribbons (cloth hidden, tabs one strip)`, !m.clothShown && m.tabH <= 60, `cloth=${m.clothShown} tab=${m.tabH}`);
    ok(`${tag} cards stack in one column`, new Set(m.cards.map((x) => Math.round(x))).size <= 1, JSON.stringify(m.cards));
    ok(`${tag} the moon sits below the content`, !m.ornShown || (m.orn && m.orn.t >= m.last - 1), m.orn ? `orn.t=${Math.round(m.orn.t)} last=${Math.round(m.last)}` : "no moon");
  }
  ok(`${tag} no console or page errors`, errors.length === 0, errors.slice(0, 2).join(" | "));
  await page.screenshot({ path: `portrait-column-${size}.png` }).catch(() => {});
  await ctx.close();
}
await browser.close();
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
