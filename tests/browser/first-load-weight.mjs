// First-load image weight: a first visit (no remembered name) at 390x844 on a touch phone, ?preview=1, serviceWorkers blocked.
//   node first-load-weight.mjs --url https://pr-13.leeroy-board.pages.dev/   (or env PREVIEW_PAGES)
// Counts every image response (avif, webp, jpg, png) from navigation until 3.5 s after the load event, with no tap, scroll or key press,
// and prints each request with its bytes. The wall is covered on a first visit, so its art, the scene warm-up and the vector pass wait
// (js/board.js whenSettled, html.wall-cold) and are not in this window. medal/tonight is the bottom-bar coin on the first screen and is allowed. Asserts: total image bytes and request count under a budget,
// the hero (img/tavern-hero) is requested, and nothing from the covered wall (crests, medals, pints, map, vector, board-wall) loads.
// Budget: 20 percent above the value measured when this suite was added (see the PR body). Raise it only with a measured reason.
// Reads only. Exit 0 when every check passes, 1 otherwise.
import { pageUrl, originOf, dirOf } from "../helpers/page-url.mjs";
import { stubbed } from "../helpers/browser-stub.mjs";
const pw = await import("playwright").catch(() => { console.error("playwright not found; run npm install in tests/"); process.exit(2); });
const argv = process.argv.slice(2), ui = argv.indexOf("--url");
const ORIGIN = (ui >= 0 && argv[ui + 1]) || process.env.PREVIEW_PAGES;
if (!ORIGIN) { console.error("usage: node first-load-weight.mjs --url <pages origin> (or set PREVIEW_PAGES)"); process.exit(2); }
const BASE = dirOf(ORIGIN);
const BUDGET_BYTES = 799067, BUDGET_REQUESTS = 17, WINDOW_MS = 3500;
const COVERED = /\/img\/(crests|pints|vector|map|buffs|chamber|seats|wax)\/|\/img\/medal\/(?!tonight)|\/img\/(board-wall|map-parchment|parchment-tile|dial-face|beam)\./;
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${extra ? `: ${extra}` : ""}`); } };

const browser = stubbed(await pw.chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ["--no-sandbox"] } : {}));
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3, serviceWorkers: "block" });
const page = await ctx.newPage();
const rows = [], pending = [];
page.on("response", (r) => {
  const u = new URL(r.url());
  if (!/\.(avif|webp|jpe?g|png)$/i.test(u.pathname)) return;
  pending.push(r.body().then((b) => rows.push({ path: u.pathname, bytes: b.length }), () => rows.push({ path: u.pathname, bytes: 0 })));
});
await page.goto(pageUrl(ORIGIN, { params: { preview: "1" } }), { waitUntil: "load" });
await page.waitForTimeout(WINDOW_MS);
await Promise.all(pending);
await browser.close();

// The same image can be reported twice (two requests for one URL in the window; the browser cache serves real visitors once), so each path counts once. Measured Nov 3: the run reported tonight.webp (133 KB) twice and a lantern twice, so the raw total sat 168 bytes under the budget and one extra duplicate failed PR 135.
const seen = new Set();
for (let i = rows.length - 1; i >= 0; i--) { if (seen.has(rows[i].path)) rows.splice(i, 1); else seen.add(rows[i].path); }
rows.sort((a, b) => b.bytes - a.bytes);
const total = rows.reduce((n, r) => n + r.bytes, 0);
for (const r of rows) console.log(`${String(r.bytes).padStart(8)}  ${r.path}`);
console.log(`image requests ${rows.length}, bytes ${total}`);
ok("the hero image is requested", rows.some((r) => /\/img\/tavern-hero/.test(r.path)));
ok(`image bytes ${total} within budget ${BUDGET_BYTES}`, total <= BUDGET_BYTES);
ok(`image requests ${rows.length} within budget ${BUDGET_REQUESTS}`, rows.length <= BUDGET_REQUESTS);
const early = rows.filter((r) => COVERED.test(r.path));
ok("no covered-wall art loads before the first tap", early.length === 0, early.map((r) => r.path).join(", "));
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
