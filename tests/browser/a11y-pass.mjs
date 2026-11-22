// Accessibility pass (DOM level, Chromium, 390x844 touch and 1366x768, API answered from fixtures, zero Worker requests).
//   node a11y-pass.mjs --url https://pr-N.leeroy-board.pages.dev/   (or env PREVIEW_PAGES)
// One check per class of fix:
//  1. the three-way "how much do you want to see" switch is a labelled group, not a navigation landmark (a landmark list of "Places", "Scene shortcuts", legal links
//     and a display setting is noise for a screen-reader user); both copies (the header one and the one built into the scene sheet) are checked;
//  2. a hover tip on a picture INSIDE a link or button (the crest in a name chip) does not turn that picture into a second Tab stop and does not give it a duplicate
//     accessible name or description: the control already has its name; a stand-alone tipped element still gets its keyboard tip; a control with no name of its own
//     (an icon-only button or link whose only name was the inner title) takes the tip as its name instead of being left unnamed;
//  3. the journey switch's own tip (it is a [role=group] now) still avoids the header controls next to it, as it did as a <nav> (checked at 1024x768).
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

  /* 2. pictures inside controls (the hover layer, scenes/place.js, loads lazily: wait for its tip element first) */
  await page.waitForSelector("#place-tip", { state: "attached", timeout: 15000 }).catch(() => {});
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
  /* an icon-only control keeps a name: the tip of its only picture becomes the control's name; a control with its own text is left alone */
  const icon = await page.evaluate(() => {
    const box = document.createElement("div"); box.id = "a11y-icons";
    box.innerHTML = '<button type="button" id="a11y-b1"><img alt="" src="data:," title="Close the card"></button>'
      + '<a href="#a11y" id="a11y-a1"><svg width="10" height="10"><title>Go to the wall</title><rect width="10" height="10"></rect></svg></a>'
      + '<button type="button" id="a11y-b2">Save<img alt="" src="data:," title="Save tip"></button>';
    document.body.append(box);
    return new Promise((r) => setTimeout(() => { const q = (s) => document.querySelector(s); const at = (e, a) => (e ? e.getAttribute(a) : "missing");
      const out = { b1: at(q("#a11y-b1"), "aria-label"), b1img: [at(q("#a11y-b1 img"), "tabindex"), at(q("#a11y-b1 img"), "aria-label")], a1: at(q("#a11y-a1"), "aria-label"), a1svg: [at(q("#a11y-a1 svg"), "tabindex"), at(q("#a11y-a1 svg"), "aria-label")], b2: at(q("#a11y-b2"), "aria-label"), b2img: at(q("#a11y-b2 img"), "tabindex") };
      box.remove(); r(out); }, 300)); });
  ok(`${tag} an icon-only control takes its inner tip as its own name, and the inner picture stays out of the Tab order`, icon.b1 === "Close the card" && icon.a1 === "Go to the wall" && icon.b1img[0] === null && icon.b1img[1] === null && icon.a1svg[0] === null && icon.a1svg[1] === null, JSON.stringify(icon));
  ok(`${tag} a control with its own text gets no extra name from an inner tip`, icon.b2 === null && icon.b2img === null, JSON.stringify(icon));
  await ctx.close();
}
/* 3. the journey switch's tip avoids the header controls around it (1024x768, where a container lookup that stops at the switch itself let the tip cover Sound) */
{
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 }, serviceWorkers: "block", reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "load" });
  await page.waitForSelector("#nx-fr2-look", { state: "visible", timeout: 20000 }).catch(() => {});
  await page.locator("#nx-fr2-look").click().catch(() => {});
  await page.waitForTimeout(1200);
  await page.keyboard.press("Escape"); /* "Just take a look" opens Next steps, and the board behind an open sheet is inert: close it first */
  await page.waitForFunction(() => { const b = document.getElementById("board"); return !b || !b.hasAttribute("inert"); }, null, { timeout: 8000 }).catch(() => {});
  await page.keyboard.press("Shift"); /* keyboard modality, and a key press loads the hover layer */
  await page.waitForSelector("#place-tip", { state: "attached", timeout: 15000 }).catch(() => {});
  await page.evaluate(() => { const j = document.getElementById("journey"); if (j) j.focus(); });
  const shown = await page.waitForFunction(() => { const t = document.getElementById("place-tip"); return !!t && !t.hidden && t.textContent.length > 0; }, null, { timeout: 8000 }).then(() => true).catch(() => false);
  const cover = await page.evaluate(() => {
    const t = document.getElementById("place-tip"); if (!t || t.hidden) return null;
    const a = t.getBoundingClientRect();
    return ["open-settings", "light-calm", "sound"].map((id) => document.getElementById(id)).filter((e) => e && e.getClientRects().length && getComputedStyle(e).visibility !== "hidden")
      .filter((e) => { const b = e.getBoundingClientRect(); return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom; }).map((e) => e.id);
  });
  ok("[1024x768] the journey switch's tip opens on keyboard focus", shown);
  ok("[1024x768] the journey switch's tip covers none of the header controls next to it", Array.isArray(cover) && cover.length === 0, JSON.stringify(cover));
  await ctx.close();
}
await browser.close();
console.log(`a11y-pass: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
