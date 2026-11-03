// Blind rating page check: /rate/ against a deployed board, in Chromium at 320, 390, 768 and 1366 px wide, dark and light.
//   node rate.mjs --url https://pr-13.leeroy-board.pages.dev/   (or env PREVIEW_PAGES)
// Reads only. The results file is a fictional fixture built in this file and handed to the page's file input; the page never
// fetches a results file. Checks: three pairs rated by keyboard, labels hidden until the summary, export content, hostile text
// rendered as text, keys ignored while typing a note, no horizontal overflow, no console errors, no request outside the page's
// own files, no serious or critical axe violations.
// Exit 0 when every check passes, 1 otherwise.
import { pageUrl, originOf, dirOf } from "../helpers/page-url.mjs";
const pw = await import("playwright").catch(() => { console.error("playwright not found; run npm install in tests/"); process.exit(2); });
const { AxeBuilder } = await import("@axe-core/playwright").catch(() => { console.error("@axe-core/playwright not found; run npm install in tests/"); process.exit(2); });
const argv = process.argv.slice(2), ui = argv.indexOf("--url");
const ORIGIN = (ui >= 0 && argv[ui + 1]) || process.env.PREVIEW_PAGES;
if (!ORIGIN) { console.error("usage: node rate.mjs --url <pages origin> (or set PREVIEW_PAGES)"); process.exit(2); }
const BASE = new URL("rate/", dirOf(ORIGIN)).href;
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${extra ? `: ${extra}` : ""}`); } };
const SIZES = [["320x640", 320, 640], ["390x844", 390, 844], ["768x1024", 768, 1024], ["1366x768", 1366, 768]];
const BLOCKING = new Set(["serious", "critical"]);
const brief = (v) => `${v.id} (${v.impact}) x${v.nodes.length}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`;

// Fictional results: three questions, three made-up candidates. Nothing here came from anyone.
const LONG = "x".repeat(300);
const cells = [];
const FRUIT = { alpha: "Kiwi", bravo: "Plum", charlie: "Fig" };
const HOSTILE = '<img src=x onerror="window.__pwned=1"> <script>window.__pwned=1</script> [bad](javascript:window.__pwned=1)';
for (const q of ["f1", "f2", "f3"]) {
  for (const c of ["alpha", "bravo", "charlie"]) {
    cells.push({
      index: cells.length, questionId: q, question: `Fictional question ${q}?`, candidate: c, provider: "fake", model: null, ok: true, ms: 100, chars: 50, rawChars: 50,
      answer: `**${FRUIT[c]} answers ${q} in one bold sentence.**\n\n• **Item** · value from ${FRUIT[c]}\n\n${HOSTILE}\n\n-# Sources: [Basics](<https://example.test/#library.a.b>)` + (c === "charlie" ? `\n\n${LONG}` : ""),
      lint: null,
    });
  }
}
const results = { jobId: "fixture", total: 9, nextCursor: null, results: cells };

const browser = await pw.chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ["--no-sandbox"] } : {});
const HOST_BEACON = /cloudflareinsights\.com|\/beacon\.min\.js/;

for (const scheme of ["dark", "light"]) {
  for (const [size, w, h] of SIZES) {
    if (scheme === "light" && w !== 390 && w !== 1366) continue;
    const tag = `[${size} ${scheme}]`;
    const errors = [], foreign = [], requested = [];
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme, acceptDownloads: true, serviceWorkers: "block", hasTouch: w < 768, isMobile: w < 768 });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => { if (!HOST_BEACON.test(e.message)) errors.push(e.message); });
    page.on("console", (m) => { if (m.type() === "error" && !/^Failed to load resource/.test(m.text()) && !HOST_BEACON.test(m.text())) errors.push(m.text()); });
    page.on("request", (r) => { if (HOST_BEACON.test(r.url()) || r.url().startsWith("data:") || r.url().startsWith("blob:")) return; const u = new URL(r.url()); requested.push(u.pathname); if (u.origin !== new URL(BASE).origin) foreign.push(r.url()); });
    const resp = await page.goto(BASE, { waitUntil: "load" });
    ok(`${tag} /rate/ answers 200`, resp && resp.status() === 200, String(resp && resp.status()));
    ok(`${tag} noindex and no Blizzard mark in the title`, (await page.locator('meta[name=robots]').getAttribute("content")).includes("noindex") && !/wow|warcraft|blizzard/i.test(await page.title()));
    const over0 = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    ok(`${tag} load screen: no horizontal overflow`, over0 <= 1, String(over0));

    await page.setInputFiles("#file", { name: "results.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(results)) });
    await page.waitForSelector("#pair:not([hidden])");
    ok(`${tag} three pairs from nine answers`, /Pair 1 of 3/.test(await page.locator("#progress-text").innerText()));
    ok(`${tag} candidate labels are hidden while rating`, !/alpha|bravo|charlie/i.test(await page.locator("#rate").innerText()));
    ok(`${tag} hostile markup is shown as text, not run`, (await page.locator("#pair img, #pair script").count()) === 0 && (await page.evaluate(() => window.__pwned)) === undefined && (await page.locator("#pair a[href^=javascript]").count()) === 0 && /<img src=x/.test(await page.locator("#ans-a").innerText()));
    const visible = await page.locator("#pair").innerText();
    ok(`${tag} only Answer A and Answer B headings name the sides`, /Answer A/.test(visible) && /Answer B/.test(visible));
    ok(`${tag} bold renders as strong and the masked link as a link`, (await page.locator("#ans-a strong").count()) > 0 && (await page.locator("#ans-a a, #ans-b a").count()) > 0);
    ok(`${tag} small footer line is rendered smaller`, (await page.locator(".discord .small").count()) >= 2);
    const over1 = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    ok(`${tag} rating screen: no horizontal overflow`, over1 <= 1, String(over1));
    const btnH = await page.locator("[data-choice]").evaluateAll((els) => Math.min(...els.map((e) => e.getBoundingClientRect().height)));
    ok(`${tag} choice buttons are at least 44px tall`, btnH >= 44, String(btnH));

    // Keys are ignored while typing in the note.
    await page.locator("#note").click();
    await page.keyboard.type("abtx");
    ok(`${tag} typing a note does not rate`, /Pair 1 of 3/.test(await page.locator("#progress-text").innerText()) && (await page.locator("#note").inputValue()) === "abtx");
    await page.locator("#note").fill("");
    await page.locator("#note").blur();

    const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    for (const v of axe.violations.filter((x) => !BLOCKING.has(x.impact))) console.log(`WARN ${tag}: ${brief(v)}`);
    const hit = axe.violations.filter((v) => BLOCKING.has(v.impact));
    ok(`${tag} no serious or critical axe violations (rating screen)`, hit.length === 0, hit.map(brief).join("; "));

    for (const key of ["a", "b", "t"]) await page.keyboard.press(key);
    ok(`${tag} three keyboard ratings finish the list`, /Rated 3/.test(await page.locator("#progress-text").innerText()) && (await page.locator("#pair").isHidden()));

    // Export (reveals labels).
    const [dl] = await Promise.all([page.waitForEvent("download"), page.locator("#export-btn").click()]);
    ok(`${tag} export is named ratings.json`, dl.suggestedFilename() === "ratings.json");
    const body = JSON.parse(await (await import("node:fs/promises")).readFile(await dl.path(), "utf8"));
    ok(`${tag} export holds three ratings with revealed labels`, body.ratings.length === 3 && body.ratings.every((r) => ["alpha", "bravo", "charlie"].includes(r.a) && ["alpha", "bravo", "charlie"].includes(r.b) && r.a !== r.b));
    ok(`${tag} choices are a, b, tie in order; the tie has no winner`, body.ratings.map((r) => r.choice).join() === "a,b,tie" && body.ratings[2].winner === null);
    ok(`${tag} export carries the seed and a summary`, body.seed === "bake-off" && Array.isArray(body.summary) && body.summary.length >= 2);
    ok(`${tag} export holds no question text`, !JSON.stringify(body).includes("Fictional question"));

    await page.locator("#summary-btn").click();
    ok(`${tag} summary reveals candidates with Bradley-Terry strength`, (await page.locator("#sum-body tr").count()) >= 2 && /%$/.test((await page.locator("#sum-body tr").first().locator("td").last().innerText()).trim()));
    const over2 = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    ok(`${tag} summary screen: no horizontal overflow`, over2 <= 1, String(over2));
    const axe2 = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    const hit2 = axe2.violations.filter((v) => BLOCKING.has(v.impact));
    ok(`${tag} no serious or critical axe violations (summary)`, hit2.length === 0, hit2.map(brief).join("; "));

    ok(`${tag} only first-party requests, none for results`, foreign.length === 0 && !requested.some((p) => /results|ratings/i.test(p)), foreign.join(" ") + requested.join(" "));
    ok(`${tag} no console or page errors`, errors.length === 0, errors.join(" | "));
    await ctx.close();
  }
}
await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
