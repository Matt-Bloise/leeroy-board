// Votes card check: the Open votes card on Next steps and the Votes list in What to decide, against a deployed board, with GET /api/votes stubbed by route interception.
//   node votes-card.mjs --url https://pr-13.leeroy-board.pages.dev/   (or env PREVIEW_PAGES)
// No AI call, no Worker data and nothing sent: only the page's GET to /api/votes is answered locally. Contexts: Chromium at 390x844 (touch) and 1366x768.
// Checks: the card renders title, per-choice counts, a bar per choice and "Closes in N hours"; user text is inert (textContent); no horizontal overflow;
// no console or page errors; the empty state; a failing route does not break the page; polling runs every 60 s while the card is visible and stops when it is not.
// Exit 0 when every check passes, 1 otherwise.
import { stubbed } from "../helpers/browser-stub.mjs";
const pw = await import("playwright").catch(() => { console.error("playwright not found; run npm install in tests/"); process.exit(2); });
const argv = process.argv.slice(2), ui = argv.indexOf("--url");
const BASE = (ui >= 0 && argv[ui + 1]) || process.env.PREVIEW_PAGES;
if (!BASE) { console.error("usage: node votes-card.mjs --url <pages origin> (or set PREVIEW_PAGES)"); process.exit(2); }
let pass = 0, fail = 0; const fails = [];
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; const l = `FAIL ${name}${extra ? `: ${extra}` : ""}`; fails.push(l); console.log(l); } };
const CTX = [["390x844", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }], ["1366x768", { viewport: { width: 1366, height: 768 } }]];
const HOUR = 3600000;
const EVIL = '<img src=x onerror="window.__votePwned=1"> Pick a night';
const sample = () => ({ votes: [
  { id: "aaaa1111", title: EVIL, choices: [{ label: "Friday", count: 3 }, { label: "<b>Saturday</b>", count: 1 }, { label: "Sunday", count: 0 }], closes_at: new Date(Date.now() + 5 * HOUR - 60000).toISOString(), open: true },
  { id: "bbbb2222", title: "Which dungeon first", choices: [{ label: "Alpha", count: 2 }, { label: "Beta", count: 2 }], closes_at: new Date(Date.now() - 30 * HOUR).toISOString(), open: false },
] });
const cors = { "access-control-allow-origin": "*", "content-type": "application/json" };
const VOTES_RE = /\/api\/votes(\?.*)?$/;

async function run(browser, size, opts) {
  const tag = `[${size}]`;
  const errors = [], hits = { n: 0 };
  let mode = "sample";
  const ctx = await browser.newContext({ ...opts, serviceWorkers: "block" });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`pageerror ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/^\[Report Only\]/.test(m.text()) && !/^Failed to load resource|cloudflareinsights/.test(m.text())) errors.push(m.text()); });
  await page.route(VOTES_RE, (route) => {
    hits.n++;
    if (mode === "fail") return route.fulfill({ status: 500, headers: cors, body: JSON.stringify({ error: "x" }) });
    return route.fulfill({ status: 200, headers: cors, body: JSON.stringify(mode === "empty" ? { votes: [] } : sample()) });
  });
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const go = (scene) => page.evaluate((s) => window.__boardKit.goScene(s), scene);
  const settle = (ms = 600) => page.waitForTimeout(ms);

  /* 1. Next steps with an open vote */
  await page.clock.install();
  await page.goto(BASE, { waitUntil: "load" });
  await go("tonight"); await page.clock.runFor(1000);
  const card = page.locator("#vt-tonight");
  await card.waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  ok(`${tag} Next steps shows the votes card when a vote is open`, await card.isVisible());
  const t = (await card.innerText().catch(() => "")).replace(/\s+/g, " ");
  ok(`${tag} card shows the title as text`, t.includes(EVIL.trim().slice(0, 12)) && t.includes("Pick a night"), t.slice(0, 120));
  ok(`${tag} card shows each choice with its count`, /Friday\s*3/.test(t) && /Saturday<\/b>\s*1/.test(t) && /Sunday\s*0/.test(t), t.slice(0, 200));
  ok(`${tag} card shows "Closes in 5 hours"`, /Closes in 5 hours/.test(t), t.slice(0, 200));
  ok(`${tag} card tells where to vote`, t.includes("Vote in Discord with the buttons on the poll message."));
  ok(`${tag} one bar per choice, width follows the share`, await card.evaluate((el) => { const f = [...el.querySelectorAll(".vt-fill")].map((x) => x.getBoundingClientRect().width / x.parentElement.getBoundingClientRect().width); return f.length === 3 && Math.abs(f[0] - 0.75) < 0.03 && Math.abs(f[1] - 0.25) < 0.03 && f[2] < 0.01; }));
  ok(`${tag} the closed vote is not on Next steps`, !t.includes("Which dungeon first"));
  ok(`${tag} user text is inert (no injected elements, no script run)`, (await card.locator("img, b").count()) === 0 && !(await page.evaluate(() => window.__votePwned)));
  ok(`${tag} card is inside the viewport width`, await card.evaluate((el) => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth + 0.5; }));
  ok(`${tag} no horizontal overflow on Next steps`, (await overflow()) <= 1, String(await overflow()));
  const top = await card.evaluate((el) => el.getBoundingClientRect().top - el.parentElement.getBoundingClientRect().top - parseFloat(getComputedStyle(el.parentElement).paddingTop || 0));
  ok(`${tag} card is the first thing on Next steps`, top < 300 && (await card.evaluate((el) => el.parentElement.firstElementChild === el)), `top=${Math.round(top)}`);
  await card.scrollIntoViewIfNeeded().catch(() => {});
  await page.screenshot({ path: `votes-card-${size}-next.png` }).catch(() => {});

  /* 2. polling: every 60 s while visible */
  const n0 = hits.n;
  await page.clock.runFor(61000); await settle(300);
  ok(`${tag} polls again after 60 s while the card is visible`, hits.n > n0, `${n0} -> ${hits.n}`);

  /* 3. What to decide: the full list */
  await go("decide"); await page.clock.runFor(1000);
  const full = page.locator("#dc-votes");
  await full.waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  const ft = (await full.innerText().catch(() => "")).replace(/\s+/g, " ");
  ok(`${tag} What to decide lists open and recent votes`, ft.includes("Pick a night") && ft.includes("Which dungeon first") && ft.includes("Recent votes"), ft.slice(0, 200));
  ok(`${tag} recent vote shows it is closed`, /Closed [A-Z][a-z]{2} \d/.test(ft), ft.slice(0, 300));
  ok(`${tag} no horizontal overflow on What to decide`, (await overflow()) <= 1, String(await overflow()));
  ok(`${tag} no voter information is rendered`, !/voter|ballot|hash|<@|discord id/i.test(ft));
  await full.scrollIntoViewIfNeeded().catch(() => {});
  await page.screenshot({ path: `votes-card-${size}-decide.png` }).catch(() => {});

  /* 4. polling stops when neither view is shown */
  await go("timeline"); await page.clock.runFor(1000);
  const n1 = hits.n;
  await page.clock.runFor(190000); await settle(300);
  ok(`${tag} no polling while neither the card nor the list is visible`, hits.n === n1, `${n1} -> ${hits.n}`);

  /* 5. empty state */
  mode = "empty"; await go("decide"); await page.clock.runFor(1000); await settle(400);
  const et = (await full.innerText().catch(() => "")).replace(/\s+/g, " ");
  ok(`${tag} empty state reads "No open votes. Start one in Discord with /vote start."`, et.includes("No open votes. Start one in Discord with /vote start."), et.slice(0, 200));
  await go("tonight"); await page.clock.runFor(61000); await settle(400);
  ok(`${tag} Next steps hides the card when no vote is open`, !(await card.isVisible()));

  /* 6. a failing route: page stays whole, says so, retries */
  const ctx2 = await browser.newContext({ ...opts, serviceWorkers: "block" });
  const p2 = await ctx2.newPage(); const err2 = [];
  p2.on("pageerror", (e) => err2.push(`pageerror ${e.message}`));
  p2.on("console", (m) => { if (m.type() === "error" && !/^\[Report Only\]/.test(m.text()) && !/^Failed to load resource|cloudflareinsights/.test(m.text())) err2.push(m.text()); });
  await p2.route(VOTES_RE, (route) => route.fulfill({ status: 500, headers: cors, body: "{}" }));
  await p2.goto(BASE, { waitUntil: "load" });
  await p2.evaluate(() => window.__boardKit.goScene("decide"));
  await p2.locator("#dc-votes").waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  await p2.waitForTimeout(1500);
  const ft2 = (await p2.locator("#dc-votes").innerText().catch(() => "")).replace(/\s+/g, " ");
  ok(`${tag} a failing /api/votes shows a plain message`, /did not load/.test(ft2), ft2.slice(0, 200));
  ok(`${tag} a failing /api/votes raises no page error`, err2.length === 0, err2.join(" | ").slice(0, 200));
  await ctx2.close();

  ok(`${tag} no console or page errors`, errors.length === 0, errors.join(" | ").slice(0, 300));
  await ctx.close();
}

const browser = stubbed(await pw.chromium.launch());
try { for (const [size, opts] of CTX) await run(browser, size, opts); } catch (e) { fail++; fails.push(`FAIL votes-card crashed: ${e.message}`); console.log(`FAIL votes-card crashed: ${e.message}`); }
await browser.close();
if (fail) { console.log(`votes-card: ${fail} of ${pass + fail} checks FAILED`); process.exit(1); }
console.log(`votes-card: all ${pass} checks passed`);
