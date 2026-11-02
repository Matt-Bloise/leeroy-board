// Entry points check: the legal pages, the real 404, and that the existing pages still resolve. Reads only.
//   node entry-points.mjs --url https://pr-13.leeroy-board.pages.dev/   (or env PREVIEW_PAGES)
// Checks: /privacy/ and /terms/ answer 200 with an h1, a "Back to the board" link and no horizontal scroll at 320, 390, 768 and 1366 px;
// the landing page links to them and both resolve; an unknown path answers 404 with the 404 page; /, /landing/, /privacy, /terms and real atlas and js files still answer 200
// (so the 404.html breaks nothing that exists); no console errors. Exit 0 when every check passes, 1 otherwise.
const pw = await import("playwright").catch(() => { console.error("playwright not found; run npm install in tests/"); process.exit(2); });
const argv = process.argv.slice(2), ui = argv.indexOf("--url");
const RAW = (ui >= 0 && argv[ui + 1]) || process.env.PREVIEW_PAGES;
if (!RAW) { console.error("usage: node entry-points.mjs --url <pages origin> (or set PREVIEW_PAGES)"); process.exit(2); }
const ORIGIN = new URL(RAW.endsWith("/") ? RAW : RAW + "/").origin;
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${extra ? `: ${extra}` : ""}`); } };
const HOST_BEACON = /cloudflareinsights\.com|\/beacon\.min\.js/;
const browser = await pw.chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ["--no-sandbox"] } : {});

for (const w of [320, 390, 768, 1366]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: 800 }, serviceWorkers: "block" });
  const page = await ctx.newPage(), errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/^Failed to load resource/.test(m.text()) && !HOST_BEACON.test(m.text())) errors.push(m.text()); });
  for (const [p, re] of [["privacy/", /privacy/i], ["terms/", /terms/i]]) {
    const tag = `[${w}] /${p}`;
    const r = await page.goto(`${ORIGIN}/${p}`, { waitUntil: "load" });
    ok(`${tag} answers 200`, r && r.status() === 200, String(r && r.status()));
    ok(`${tag} has one h1 naming the page`, (await page.locator("h1").count()) === 1 && re.test(await page.locator("h1").innerText()));
    ok(`${tag} has a visible Back to the board link to /`, await page.getByRole("link", { name: "Back to the board" }).first().isVisible() && (await page.getByRole("link", { name: "Back to the board" }).first().getAttribute("href")) === "/");
    ok(`${tag} is not noindex`, (await page.locator('meta[name="robots"]').count()) === 0);
    ok(`${tag} has no horizontal scroll`, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "scrollWidth > width");
  }
  ok(`[${w}] no console or page errors`, errors.length === 0, errors.join(" | "));
  await ctx.close();
}

{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
  const page = await ctx.newPage();
  await page.goto(`${ORIGIN}/landing/`, { waitUntil: "load" });
  for (const [name, want] of [["Privacy notice", "/privacy/"], ["Terms of use", "/terms/"]]) {
    const a = page.locator("footer").getByRole("link", { name });
    ok(`landing links "${name}"`, (await a.count()) === 1);
    const href = await a.first().evaluate((el) => new URL(el.href).pathname);
    ok(`landing "${name}" points at ${want}`, href === want, href);
    const r = await page.request.get(new URL(href, ORIGIN).href);
    ok(`landing "${name}" target answers 200`, r.status() === 200, String(r.status()));
  }
  await ctx.close();
}

for (const p of ["/this-does-not-exist", "/sitemap.xml", "/favicon.ico"]) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
  const page = await ctx.newPage();
  const r = await page.goto(ORIGIN + p, { waitUntil: "load" });
  ok(`${p} answers 404`, r && r.status() === 404, String(r && r.status()));
  if (p === "/this-does-not-exist") {
    ok("the 404 page says it, with a link back", /That page is not here/.test(await page.locator("h1").innerText().catch(() => "")) && (await page.getByRole("link", { name: "Back to the board" }).count()) === 1);
    ok("the 404 page is not the board", (await page.locator("#footer").count()) === 0);
  }
  await ctx.close();
}

// /atlas/ has no index.html (the folder holds the atlas modules), so it only ever answered 200 through the SPA fallback; the real files keep resolving.
for (const p of ["/", "/landing/", "/atlas/atlas.js", "/js/board.js", "/privacy", "/terms"]) {
  const r = await (await browser.newContext({ serviceWorkers: "block" })).request.get(ORIGIN + p);
  ok(`${p} still resolves (${r.status()})`, r.status() === 200);
}
{
  const r = await (await browser.newContext({ serviceWorkers: "block" })).request.get(ORIGIN + "/", {});
  const body = await r.text();
  ok("/ is the board (host-redirect script present, not redirecting on this host)", /id="host-redirect"/.test(body));
}

await browser.close();
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
