// Landing page check: /landing/ against a deployed board, in Chromium at 390x844 (touch) and 1366x768.
//   node landing.mjs --url https://pr-13.leeroy-board.pages.dev/   (or env PREVIEW_PAGES)
// Reads only. Checks: what the product is in the h1 and lede, the sample card, one call to action whose href equals BOARD_URL in landing/landing.js,
// the policy references, the non-affiliation footer, no external requests or tracking scripts, no horizontal overflow, no console errors,
// and no serious or critical axe violations (minor and moderate print as WARN).
// Exit 0 when every check passes, 1 otherwise.
const pw = await import("playwright").catch(() => { console.error("playwright not found; run npm install in tests/"); process.exit(2); });
const { AxeBuilder } = await import("@axe-core/playwright").catch(() => { console.error("@axe-core/playwright not found; run npm install in tests/"); process.exit(2); });
const argv = process.argv.slice(2), ui = argv.indexOf("--url");
const ORIGIN = (ui >= 0 && argv[ui + 1]) || process.env.PREVIEW_PAGES;
if (!ORIGIN) { console.error("usage: node landing.mjs --url <pages origin> (or set PREVIEW_PAGES)"); process.exit(2); }
const BASE = new URL("landing/", ORIGIN.endsWith("/") ? ORIGIN : ORIGIN + "/").href;
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${extra ? `: ${extra}` : ""}`); } };
const CTX = [["390x844", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }], ["1366x768", { viewport: { width: 1366, height: 768 } }]];
const BLOCKING = new Set(["serious", "critical"]);
const brief = (v) => `${v.id} (${v.impact}) x${v.nodes.length}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`;

const browser = await pw.chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ["--no-sandbox"] } : {});
const src = await (await fetch(new URL("landing.js", BASE))).text();
const constUrl = /const\s+BOARD_URL\s*=\s*"([^"]+)"/.exec(src)?.[1];
ok("landing.js defines BOARD_URL once", !!constUrl && (src.match(/BOARD_URL\s*=/g) || []).length === 1);
for (const [size, opts] of CTX) {
  const tag = `[${size}]`;
  const errors = [], foreign = [], scripts = [];
  const ctx = await browser.newContext({ ...opts, serviceWorkers: "block" });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => { if (!/cloudflareinsights/.test(e.message)) errors.push(e.message); });
  // Cloudflare Pages injects its Web Analytics beacon on the host; it is not part of the page, so ignore it in every check below.
  const HOST_BEACON = /cloudflareinsights\.com|\/beacon\.min\.js/;
  page.on("console", (m) => { if (m.type() === "error" && !/^Failed to load resource/.test(m.text()) && !HOST_BEACON.test(m.text())) errors.push(m.text()); });
  page.on("request", (r) => { if (HOST_BEACON.test(r.url())) return; const u = new URL(r.url()); if (u.origin !== new URL(BASE).origin) foreign.push(r.url()); if (r.resourceType() === "script") scripts.push(u.pathname); });
  const resp = await page.goto(BASE, { waitUntil: "load" });
  ok(`${tag} /landing/ answers 200`, resp && resp.status() === 200, String(resp && resp.status()));
  const h1 = (await page.locator("h1").innerText()).replace(/\s+/g, " ");
  ok(`${tag} the h1 says what it is`, /Discord/.test(h1) && /next steps/.test(h1), h1);
  ok(`${tag} the h1 is visible without scrolling`, await page.locator("h1").evaluate((el) => el.getBoundingClientRect().bottom <= window.innerHeight));
  const lede = await page.locator(".lede").innerText();
  ok(`${tag} the lede says guild companion`, /guild companion/i.test(lede));
  const card = page.locator(".card");
  ok(`${tag} the sample card is built in CSS`, (await card.isVisible()) && (await card.locator(".bars li").count()) === 3 && (await card.locator("img").count()) === 0);
  ok(`${tag} the card is labelled as example data`, /Example data/.test(await card.innerText()));
  const cta = page.locator("a.cta");
  ok(`${tag} exactly one call to action`, (await cta.count()) === 1 && (await page.locator("a.cta, button").count()) === 1);
  const href = await cta.getAttribute("href");
  ok(`${tag} the call to action uses BOARD_URL`, href === constUrl, `${href} vs ${constUrl}`);
  ok(`${tag} the call to action is at least 44px tall`, (await cta.boundingBox()).height >= 44);
  const foot = (await page.locator("footer").innerText()).replace(/\s+/g, " ");
  ok(`${tag} footer references privacy, terms and what we track`, /Privacy notice/.test(foot) && /Terms of use/.test(foot) && /What we track/.test(foot));
  ok(`${tag} footer carries the non-affiliation sentence`, /not affiliated with or endorsed by Blizzard Entertainment/i.test(foot));
  const title = await page.title();
  ok(`${tag} the title carries no Blizzard mark`, !/wow|warcraft|blizzard/i.test(title), title);
  ok(`${tag} only first-party requests`, foreign.length === 0, foreign.join(" "));
  ok(`${tag} the only script is landing.js`, scripts.length === 1 && scripts[0].endsWith("/landing/landing.js"), scripts.join(" "));
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  ok(`${tag} no horizontal overflow`, over <= 1, String(over));
  ok(`${tag} no console or page errors`, errors.length === 0, errors.join(" | "));
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  for (const v of r.violations.filter((x) => !BLOCKING.has(x.impact))) console.log(`WARN ${tag}: ${brief(v)}`);
  const hit = r.violations.filter((v) => BLOCKING.has(v.impact));
  ok(`${tag} no serious or critical axe violations`, hit.length === 0, hit.map(brief).join("; "));
  await ctx.close();
}
await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
