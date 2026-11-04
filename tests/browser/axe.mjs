// Accessibility check with axe-core: the first screen and the sheet (Next steps, opened with __boardKit.goScene("tonight")), in Chromium at 390x844 (touch) and 1366x768.
//   node axe.mjs --url https://pr-13.leeroy-board.pages.dev/   (or env PREVIEW_PAGES)
// Fails on serious or critical violations only; minor and moderate ones are printed as WARN. Reads only, nothing is sent.
// Exclusions are listed in EXCLUDE below, each with a reason and a narrow selector. Add none without a reason.
// Exit 0 when every check passes, 1 otherwise.
import { stubbed } from "../helpers/browser-stub.mjs";
import { parseClock, applyClock } from "../helpers/clock-arg.mjs";
const pw = await import("playwright").catch(() => { console.error("playwright not found; run npm install in tests/"); process.exit(2); });
const { AxeBuilder } = await import("@axe-core/playwright").catch(() => { console.error("@axe-core/playwright not found; run npm install in tests/"); process.exit(2); });
const argv = process.argv.slice(2), ui = argv.indexOf("--url");
const BASE = (ui >= 0 && argv[ui + 1]) || process.env.PREVIEW_PAGES;
if (!BASE) { console.error("usage: node axe.mjs --url <pages origin> (or set PREVIEW_PAGES)"); process.exit(2); }
let CLOCK = null;
try { CLOCK = parseClock(argv); } catch (e) { console.error(e.message); process.exit(2); } /* --clock <iso>: the page runs at that time (tests/helpers/clock-arg.mjs), e.g. inside the launch hero window (B49) */
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${extra ? `: ${extra}` : ""}`); } };
const CTX = [["390x844", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }], ["1366x768", { viewport: { width: 1366, height: 768 } }]];
/* Narrow, documented exclusions: [axe rule id, CSS selector, reason]. The selector is excluded from the scan (axe cannot exclude per rule), so keep it to one element. */
const EXCLUDE = []; // none needed on 2026-11-02: the first screen and the sheet pass at both widths
const BLOCKING = new Set(["serious", "critical"]);
const brief = (v) => `${v.id} (${v.impact}) x${v.nodes.length}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`;

async function scan(page, label, tag) {
  let b = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]);
  for (const [, sel] of EXCLUDE) b = b.exclude(sel);
  const r = await b.analyze();
  const hit = r.violations.filter((v) => BLOCKING.has(v.impact));
  for (const v of r.violations.filter((x) => !BLOCKING.has(x.impact))) console.log(`WARN ${tag} ${label}: ${brief(v)}`);
  ok(`${tag} ${label}: no serious or critical axe violations`, hit.length === 0, hit.map(brief).join("; "));
}

const browser = stubbed(await pw.chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ["--no-sandbox"] } : {}));
for (const [size, opts] of CTX) {
  const tag = `[${size}]`;
  const ctx = await browser.newContext({ ...opts, serviceWorkers: "block", reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await applyClock(page, CLOCK);
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector("#tn-me .tn-name", { state: "visible", timeout: 12000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await scan(page, "first screen", tag);
  await page.evaluate(() => window.__boardKit.goScene("tonight")).catch(() => {});
  await page.waitForSelector(".sheet", { state: "visible", timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1200);
  ok(`${tag} the sheet is open`, await page.locator(".sheet").first().isVisible());
  await scan(page, "sheet", tag);
  await ctx.close();
}
await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
