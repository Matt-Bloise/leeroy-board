// Accessibility check with axe-core: the first screen and the sheet (Next steps, opened with __boardKit.goScene("tonight")), in Chromium at 390x844 (touch) and 1366x768.
//   node axe.mjs --url https://pr-13.leeroy-board.pages.dev/   (or env PREVIEW_PAGES)
// Fails on serious or critical violations only; minor and moderate ones are printed as WARN. Reads only, nothing is sent.
// Exclusions are listed in EXCLUDE below, each with a reason and a narrow selector. Add none without a reason.
// Exit 0 when every check passes, 1 otherwise.
import { stubbed } from "../helpers/browser-stub.mjs";
import { pageUrl } from "../helpers/page-url.mjs";
import { parseClock, applyClock, expectedHero, heroStateProblem } from "../helpers/clock-arg.mjs";
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

/* B49: the launch hero (from T-24h to T+24h) is NOT rendered while the first-visit sheet covers a cold wall (html.wall-cold, display:none), so the two scans above never see its
   text. With --clock, one more scan runs where the hero is on screen: the sheet closed and the wall warmed, limited to #launch-hero, on the ?preview=1 page the other suites use (without
   it the page does not take the recorded timeline and the hero never appears). Any serious or critical violation fails. Axe cannot measure most hero text (it sits on the plate picture and
   pseudo-elements: "incomplete", reasons pseudoContent / bgGradient / bgOverlap), so failing on every incomplete node would be permanently red; instead the incomplete nodes are counted in a WARN
   line, and the node that once failed, #lh-check-sum (the checklist summary), must be measured and pass: missing, incomplete or failing fails the run. */
async function heroScan(browser, opts, tag) {
  const ctx = await browser.newContext({ ...opts, serviceWorkers: "block", reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await applyClock(page, CLOCK);
  await page.goto(pageUrl(BASE, { params: { preview: "1" } }), { waitUntil: "load" });
  await page.waitForSelector("#nx-fr2-look, #launch-hero", { state: "attached", timeout: 12000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const problem = await heroStateProblem(page, CLOCK);
  ok(`${tag} the faked clock puts the launch hero in the state it should be (${expectedHero(CLOCK) || "absent"})`, !problem, problem || "");
  if (expectedHero(CLOCK) && !problem) {
    if (await page.locator("#nx-fr2-look").isVisible().catch(() => false)) await page.locator("#nx-fr2-look").click().catch(() => {});
    else await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(500);
    await page.mouse.move(200, 200); await page.mouse.wheel(0, 5); /* the first touch warms the wall (js/board.js whenSettled) */
    await page.waitForTimeout(1200);
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(600);
    const shown = await page.evaluate(() => { const e = document.querySelector("#launch-hero"); return !!e && getComputedStyle(e).display !== "none" && e.getClientRects().length > 0; });
    ok(`${tag} the launch hero is on screen once the sheet is closed and the wall has warmed`, shown);
    if (shown) {
      const r = await new AxeBuilder({ page }).include("#launch-hero").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      const hit = r.violations.filter((v) => BLOCKING.has(v.impact));
      for (const v of r.violations.filter((x) => !BLOCKING.has(x.impact))) console.log(`WARN ${tag} launch hero: ${brief(v)}`);
      ok(`${tag} launch hero: no serious or critical axe violations`, hit.length === 0, hit.map(brief).join("; "));
      const reasons = {};
      for (const v of r.incomplete.filter((x) => x.id === "color-contrast")) for (const n of v.nodes) for (const c of [...n.any, ...n.all, ...n.none]) { const k = (c.data && c.data.messageKey) || "other"; reasons[k] = (reasons[k] || 0) + 1; }
      const nIncomplete = r.incomplete.filter((x) => x.id === "color-contrast").reduce((a, v) => a + v.nodes.length, 0);
      if (nIncomplete) console.log(`WARN ${tag} launch hero: axe could not measure the contrast of ${nIncomplete} text node(s) (text over the plate picture or pseudo-elements): ${JSON.stringify(reasons)}; checked by eye only`);
      const inList = (arr) => arr.filter((x) => x.id === "color-contrast").some((v) => v.nodes.some((n) => n.target.join(" ") === "#lh-check-sum"));
      ok(`${tag} launch hero: the checklist summary (#lh-check-sum, the node that once failed at 1.2:1) was measured and passes`, inList(r.passes) && !inList(r.violations) && !inList(r.incomplete), `in passes ${inList(r.passes)}, violations ${inList(r.violations)}, incomplete ${inList(r.incomplete)}`);
    }
  }
  await ctx.close();
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
  if (CLOCK) await heroScan(browser, opts, tag);
}
await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
