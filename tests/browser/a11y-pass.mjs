// Accessibility pass (DOM level, Chromium, 390x844 touch and 1366x768, API answered from fixtures, zero Worker requests).
//   node a11y-pass.mjs --url https://pr-N.leeroy-board.pages.dev/   (or env PREVIEW_PAGES)
// One check per class of fix:
//  1. the three-way "how much do you want to see" switch is a labelled group, not a navigation landmark (a landmark list of "Places", "Scene shortcuts", legal links
//     and a display setting is noise for a screen-reader user); both copies (the header one and the one built into the scene sheet) are checked;
//  2. a hover tip on a picture INSIDE a link or button (the crest in a name chip) does not turn that picture into a second Tab stop and does not give it a duplicate
//     accessible name or description: the control already has its name; a stand-alone tipped element still gets its keyboard tip.
import { stubbed } from "../helpers/browser-stub.mjs";
import { pageUrl } from "../helpers/page-url.mjs";
const pw = await import("playwright").catch(() => { console.error("playwright not found; run npm install in tests/"); process.exit(2); });
const argv = process.argv.slice(2), ui = argv.indexOf("--url");
const BASE = (ui >= 0 && argv[ui + 1]) || process.env.PREVIEW_PAGES;
if (!BASE) { console.error("usage: node a11y-pass.mjs --url <pages origin> (or set PREVIEW_PAGES)"); process.exit(2); }
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${extra ? `: ${extra}` : ""}`); } };
const launch = process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ["--no-sandbox"] } : {};
const browser = stubbed(await pw.chromium.launch(launch), { label: "a11y-pass api-stub" });
const url = pageUrl(BASE, { params: { preview: "1" } });
const CTX = [["390x844", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }], ["1366x768", { viewport: { width: 1366, height: 768 } }]];

for (const [size, opts] of CTX) {
  const tag = `[${size}]`;
  const ctx = await browser.newContext({ ...opts, serviceWorkers: "block", reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "load" });
  await page.waitForSelector("#nx-fr2-look", { state: "visible", timeout: 20000 });
  await page.locator("#nx-fr2-look").click().catch(() => {});
  await page.waitForTimeout(1200);

  /* 1. the journey switch */
  await page.evaluate(() => { location.hash = "tonight"; });
  await page.waitForSelector("#journey-scene", { state: "attached", timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(800);
  const j = await page.evaluate(() => [...document.querySelectorAll("#journey, #journey-scene")].map((e) => ({ id: e.id, tag: e.tagName, role: e.getAttribute("role"), name: e.getAttribute("aria-label"), buttons: e.querySelectorAll("button[data-journey]").length })));
  ok(`${tag} both journey switches exist`, j.length === 2, JSON.stringify(j));
  ok(`${tag} each journey switch is a labelled group, not a nav landmark`, j.length > 0 && j.every((x) => x.tag !== "NAV" && x.role === "group" && x.name && x.buttons === 3), JSON.stringify(j));
  const navs = await page.evaluate(() => [...document.querySelectorAll("nav, [role=navigation]")].filter((n) => n.querySelector("[data-journey]")).length);
  ok(`${tag} no navigation landmark holds the journey buttons`, navs === 0, String(navs));

  /* 2. pictures inside controls */
  await page.waitForSelector("img.crest-mark", { state: "attached", timeout: 15000 }).catch(() => {});
  const c = await page.evaluate(() => {
    const imgs = [...document.querySelectorAll("a[href] img, button img, summary img, [role=button] img")];
    const bad = imgs.filter((i) => i.hasAttribute("tabindex") || i.hasAttribute("aria-label") || i.hasAttribute("aria-description")).map((i) => i.outerHTML.slice(0, 120));
    return { n: imgs.length, bad };
  });
  ok(`${tag} there are pictures inside controls to judge`, c.n > 0, String(c.n));
  ok(`${tag} a picture inside a link or button is not a Tab stop and has no duplicate name`, c.bad.length === 0, c.bad.join(" | "));
  /* the tip itself is kept for the mouse: data-tip stays on the picture */
  const tips = await page.evaluate(() => document.querySelectorAll("button img[data-tip], a[href] img[data-tip]").length);
  ok(`${tag} the hover tip on such a picture is kept`, tips > 0, String(tips));
  /* a stand-alone tipped element keeps its keyboard tip */
  const standalone = await page.evaluate(() => { const e = document.createElement("span"); e.id = "a11y-probe"; e.title = "A tip"; document.body.append(e); return new Promise((r) => setTimeout(() => r({ tab: e.getAttribute("tabindex"), name: e.getAttribute("aria-label") }), 200)); });
  ok(`${tag} a stand-alone element with a tip still gets a Tab stop and a name`, standalone.tab === "0" && standalone.name === "A tip", JSON.stringify(standalone));
  await ctx.close();
}
await browser.close();
console.log(`a11y-pass: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
