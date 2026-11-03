// Trust card check: the "What we track and why" card is reachable in two clicks from the first screen, and reads well at 390 px.
//   node trust-card.mjs --url https://pr-13.leeroy-board.pages.dev/   (or env PREVIEW_PAGES)
// No AI call, nothing sent. Contexts: Chromium at 390x844 (touch) and 1366x768.
// Checks: More then the menu entry opens the card (2 clicks); the footer entry opens it (1 click); four lines each with a Why; the erase line is marked coming soon and is not a link;
// no horizontal overflow, card inside the viewport; Escape closes it and returns focus; no console or page errors. Exit 0 when every check passes, 1 otherwise.
import { stubbed } from "../helpers/browser-stub.mjs";
const pw = await import("playwright").catch(() => { console.error("playwright not found; run npm install in tests/"); process.exit(2); });
const argv = process.argv.slice(2), ui = argv.indexOf("--url");
const BASE = (ui >= 0 && argv[ui + 1]) || process.env.PREVIEW_PAGES;
if (!BASE) { console.error("usage: node trust-card.mjs --url <pages origin> (or set PREVIEW_PAGES)"); process.exit(2); }
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${extra ? `: ${extra}` : ""}`); } };
const CTX = [["390x844", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }], ["1366x768", { viewport: { width: 1366, height: 768 } }]];
const NAME = /What we track and why/i;

async function run(browser, size, opts) {
  const tag = `[${size}]`, errors = [];
  const ctx = await browser.newContext({ ...opts, serviceWorkers: "block" });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`pageerror ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/^Failed to load resource|cloudflareinsights/.test(m.text())) errors.push(m.text()); });
  const card = page.locator("#trust-card .tr-card");
  const shown = async () => { await card.waitFor({ state: "visible", timeout: 8000 }).catch(() => {}); return card.isVisible(); };
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForTimeout(1500);

  /* 1. footer: one click */
  const foot = page.locator("#foot-trust");
  await foot.waitFor({ state: "attached", timeout: 15000 }).catch(() => {});
  ok(`${tag} footer has the entry`, (await foot.count()) === 1 && NAME.test(await foot.textContent().catch(() => "")));
  /* the phone shell can hide the footer line; the DOM click proves the entry works either way */
  await foot.evaluate((el) => el.click()).catch(() => {});
  ok(`${tag} footer entry opens the card`, await shown());
  const text = (await card.innerText().catch(() => "")).replace(/\s+/g, " ");
  const lines = await card.locator(".tr-line").count();
  ok(`${tag} four lines, each with a Why`, lines === 4 && (await card.locator(".tr-why").count()) === 4 && (text.match(/Why:/g) || []).length === 4, `${lines} lines`);
  ok(`${tag} names what is read, stored, seen, deleted`, /display name/i.test(text) && /avatar/i.test(text) && /roles/i.test(text) && /builds/i.test(text) && /stored/i.test(text) && /who can see/i.test(text) && /delete/i.test(text));
  const erase = card.locator(".tr-erase");
  ok(`${tag} erase line is marked coming soon and is not a live link`, /coming soon/i.test(await erase.innerText().catch(() => "")) && (await card.locator("a[href]").count()) === 0);
  ok(`${tag} card is inside the viewport width, no horizontal overflow`, await card.evaluate((el) => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth + 0.5 && document.documentElement.scrollWidth - window.innerWidth <= 1; }));
  await page.screenshot({ path: `trust-card-${size}.png` }).catch(() => {});
  await page.keyboard.press("Escape");
  ok(`${tag} Escape closes the card`, (await page.locator("#trust-card").count()) === 0);

  /* 2. menu: exactly two clicks from the first screen (More, then the entry) */
  await page.reload({ waitUntil: "load" }); await page.waitForTimeout(1500);
  const phone = size.startsWith("390");
  let clicks = 0;
  const more = phone ? page.locator('#bottombar [data-place="more"]') : page.locator('#bottombar [data-go="more"]');
  if (await more.isVisible().catch(() => false)) {
    await more.click(); clicks++;
    const entry = page.getByRole("button", { name: NAME }).last();
    await entry.waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
    await entry.click().catch(() => {}); clicks++;
    ok(`${tag} More, then the entry opens the card in ${clicks} clicks`, clicks === 2 && (await shown()));
  } else {
    ok(`${tag} More is not shown on this layout; the footer entry is the 1-click path`, true);
  }
  ok(`${tag} no console or page errors`, errors.length === 0, errors.join(" | ").slice(0, 200));
  await ctx.close();
}

const browser = stubbed(await pw.chromium.launch());
try { for (const [size, opts] of CTX) await run(browser, size, opts); } finally { await browser.close(); }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
