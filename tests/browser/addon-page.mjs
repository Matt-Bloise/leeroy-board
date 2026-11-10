// Get the add-on page: renders at 390x844 and 1440x900 with no overlap, no horizontal scroll, zero console errors;
// the download link has the right href and a download attribute and serves the zip; the SHA-256 and size on the page equal the served file.
//   node tests/browser/addon-page.mjs --url http://127.0.0.1:8080/   (or env PREVIEW_PAGES)
import crypto from "node:crypto";
import { originOf } from "../helpers/page-url.mjs";
import { stubbed } from "../helpers/browser-stub.mjs";
const pw = await import("playwright").catch(() => { console.error("playwright not found; run npm ci in tests/"); process.exit(2); });
const argv = process.argv.slice(2), ui = argv.indexOf("--url");
const RAW = (ui >= 0 && argv[ui + 1]) || process.env.PREVIEW_PAGES;
if (!RAW) { console.error("usage: node addon-page.mjs --url <origin>"); process.exit(2); }
const ORIGIN = originOf(RAW);
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { if (c) { pass++; console.log(`PASS ${n}`); } else { fail++; console.log(`FAIL ${n}${x ? `: ${x}` : ""}`); } };
const browser = stubbed(await pw.chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ["--no-sandbox"] } : {}));
for (const [w, hgt] of [[390, 844], [1440, 900]]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: hgt }, serviceWorkers: "block" });
  const page = await ctx.newPage(), errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/^\[Report Only\]/.test(m.text())) errors.push(m.text()); });
  page.on("requestfailed", (r) => errors.push(`requestfailed ${r.url()}`));
  const r = await page.goto(`${ORIGIN}/landing/addon/`, { waitUntil: "load" });
  const t = `[${w}x${hgt}]`;
  ok(`${t} answers 200`, r && r.status() === 200);
  ok(`${t} one h1`, (await page.locator("h1").count()) === 1);
  ok(`${t} no horizontal scroll`, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  const dl = page.locator("#dl");
  const href = await dl.getAttribute("href");
  ok(`${t} link has a download attribute`, (await dl.getAttribute("download")) !== null);
  ok(`${t} link is relative and names the zip`, /^LeeroyBuild-\d+\.\d+\.\d+\.zip$/.test(href), href);
  ok(`${t} link is visible and at least 44px tall`, (await dl.isVisible()) && (await dl.boundingBox()).height >= 44);
  const zr = await page.request.get(new URL(href, `${ORIGIN}/landing/addon/`).href);
  const buf = Buffer.from(await zr.body());
  ok(`${t} zip answers 200`, zr.status() === 200, String(zr.status()));
  ok(`${t} page SHA-256 equals the served file`, (await page.locator("#sha").innerText()).trim() === crypto.createHash("sha256").update(buf).digest("hex"));
  ok(`${t} page size equals the served file`, (await page.locator("#size").innerText()).trim() === `${buf.length} bytes`);
  ok(`${t} version in the link text`, (await dl.innerText()).includes((await page.locator("#ver").innerText()).trim()));
  // overlap: no two visible leaf blocks in main intersect
  const overlaps = await page.evaluate(() => {
    const els = [...document.querySelectorAll("main h1, main h2, main p, main li, main dt, main dd, main a.dl")].filter((e) => e.getClientRects().length);
    const bad = [];
    for (let i = 0; i < els.length; i++) for (let j = i + 1; j < els.length; j++) {
      if (els[i].contains(els[j]) || els[j].contains(els[i])) continue;
      const a = els[i].getBoundingClientRect(), b = els[j].getBoundingClientRect();
      if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) bad.push(`${els[i].tagName}/${els[j].tagName}`);
    }
    return bad;
  });
  ok(`${t} no overlapping blocks`, overlaps.length === 0, overlaps.join(","));
  ok(`${t} no element wider than the viewport`, await page.evaluate(() => [...document.querySelectorAll("main *")].every((e) => e.getBoundingClientRect().right <= window.innerWidth + 1)));
  ok(`${t} zero console errors`, errors.length === 0, errors.join(" | "));
  await ctx.close();
}
const link0 = (page) => page.locator("#legal-foot a", { hasText: "Get the add-on" }).waitFor({ state: "visible", timeout: 20000 });
{
  // real navigation: home page, footer link, landing page, download link, bytes
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  const page = await ctx.newPage();
  // a signed-in friend (board link opened once) sees the board and its footer; a stranger sees only the gate
  await ctx.addInitScript(() => { try { localStorage.setItem("board-journey", "guided"); localStorage.setItem("board-wl", "1"); localStorage.setItem("board-me", "bard"); } catch (e) {} });
  await page.goto(`${ORIGIN}/?preview=1&brain=local`, { waitUntil: "load" });
  await link0(page);
  const link = page.locator("#legal-foot").getByRole("link", { name: "Get the add-on" });
  ok("home footer has the Get the add-on link", (await link.count()) === 1);
  await Promise.all([page.waitForURL(/\/landing\/addon\/$/), link.click()]);
  ok("footer click lands on /landing/addon/", new URL(page.url()).pathname === "/landing/addon/", page.url());
  ok("landing page shows the h1", /Get the add-on/.test(await page.locator("h1").innerText()));
  const [dlEvent] = await Promise.all([page.waitForEvent("download"), page.locator("#dl").click()]);
  const { readFileSync } = await import("node:fs");
  const bytes = readFileSync(await dlEvent.path());
  const h = crypto.createHash("sha256").update(bytes).digest("hex");
  ok("clicked download is a zip (PK header)", bytes.subarray(0, 2).toString() === "PK");
  ok("clicked download SHA-256 equals the page's", h === (await page.locator("#sha").innerText()).trim(), h);
  ok("download file name is the zip", /^LeeroyBuild-\d+\.\d+\.\d+\.zip$/.test(dlEvent.suggestedFilename()), dlEvent.suggestedFilename());
  await ctx.close();
}
await browser.close();
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
