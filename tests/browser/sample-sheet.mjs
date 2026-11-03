// Sample-mode sheet check: a visitor with no identity sees a labelled "Sample guild" sheet on The five, never empty parchment.
//   node sample-sheet.mjs --url https://pr-13.leeroy-board.pages.dev/   (or env PREVIEW_PAGES)
// Fictional data comes from static files under data/sample/. No AI call, nothing sent. Chromium at 390x844 (touch) and 1366x768.
// Checks: label, five fictional lines, the one button, no horizontal overflow, no console errors, hidden once an identity is set. Saves a screenshot per size to tests/browser/out/.
import { stubbed } from "../helpers/browser-stub.mjs";
const pw = await import("playwright").catch(() => { console.error("playwright not found; run npm install in tests/"); process.exit(2); });
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const argv = process.argv.slice(2), ui = argv.indexOf("--url");
const BASE = (ui >= 0 && argv[ui + 1]) || process.env.PREVIEW_PAGES;
if (!BASE) { console.error("usage: node sample-sheet.mjs --url <pages origin> (or set PREVIEW_PAGES)"); process.exit(2); }
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "out"); mkdirSync(out, { recursive: true });
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${extra ? `: ${extra}` : ""}`); } };
const CTX = [["390x844", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }], ["1366x768", { viewport: { width: 1366, height: 768 } }]];
const browser = stubbed(await pw.chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}));
for (const [size, opts] of CTX) {
  const tag = `[${size}]`, errors = [];
  const ctx = await browser.newContext({ ...opts, serviceWorkers: "block" }), page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/^Failed to load resource|cloudflareinsights/.test(m.text())) errors.push(m.text()); });
  await page.goto(BASE, { waitUntil: "load" });
  await page.evaluate(() => { const b = document.getElementById("board"); if (b && b.hidden && window.__board) window.__board.start("preview"); }); // the open-web hosts start on their own; a local static server does not
  await page.waitForFunction(() => window.__boardKit && window.__boardKit.D && window.__boardKit.D.party, null, { timeout: 20000 }).catch(() => {});
  await page.evaluate(() => window.__boardKit.goScene("five"));
  const box = page.locator("#ps-sample");
  await box.waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  ok(`${tag} sample sheet is visible without an identity`, await box.isVisible());
  const t = (await box.innerText().catch(() => "")).replace(/\s+/g, " ");
  ok(`${tag} it is labelled "Sample guild"`, /Sample guild/.test(t), t.slice(0, 80));
  ok(`${tag} it lists five fictional members`, (await box.locator("li").count()) === 5 && /Brindle Oakhand/.test(t));
  ok(`${tag} exactly one button, "Make this for my guild"`, (await box.locator("button").count()) === 1 && (await box.locator("button").textContent()) === "Make this for my guild");
  ok(`${tag} no horizontal overflow`, (await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 1);
  await page.waitForTimeout(400);
  await box.screenshot({ path: path.join(out, `sample-sheet-${size}.png`) });
  await page.evaluate(() => { const k = window.__boardKit, m = k.D.party.members[0]; k.MEM.setMe(k.MEM.slug(m.name)); return window.__sheet.sampleSync(); });
  ok(`${tag} hidden once the visitor has an identity`, !(await box.isVisible()));
  ok(`${tag} no console or page errors`, errors.length === 0, errors.join(" | ").slice(0, 200));
  await ctx.close();
}
await browser.close();
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
