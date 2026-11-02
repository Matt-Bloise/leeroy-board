// "Is this you?" check (Q28, flag firstrun.v2): a viewer the board can name gets one confirmation card instead of the name grid.
//   node is-this-you.mjs --url https://pr-N.leeroy-board.pages.dev/   (or env PREVIEW_PAGES)   optional: --shots <dir> (default os tmpdir)
// /api/me is stubbed by route interception, so nothing real is read or sent and no AI is called. Viewports 390x844 (touch) and 1366x768.
// Per viewport: the card names the display name and never shows the Discord id; no name button is visible; "No, pick someone else" opens the five names;
// "Yes, that's me" on a name that is on the board opens that sheet; "Yes" on a name that is not on the board shows the /build prompt and the build the answer carried.
// A local static server works too: the check adds ?brain=https://api.leeroy.party so the board has an API base to ask. Exit 0 when every check passes, 1 otherwise.
import os from "node:os";
import path from "node:path";
const pw = await import("playwright").catch(() => { console.error("playwright not found; run npm install in tests/"); process.exit(2); });
const argv = process.argv.slice(2), arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const BASE = arg("--url") || process.env.PREVIEW_PAGES;
if (!BASE) { console.error("usage: node is-this-you.mjs --url <pages origin> (or set PREVIEW_PAGES)"); process.exit(2); }
const SHOTS = arg("--shots") || os.tmpdir();
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${extra ? `: ${extra}` : ""}`); } };
const SIZES = [["390x844", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }], ["1366x768", { viewport: { width: 1366, height: 768 } }]];
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(BASE);
const url = () => `${BASE.replace(/\/$/, "")}/?preview=1${LOCAL ? "&brain=https://api.leeroy.party" : ""}`;
const FAKE_ID = "123456789012345678";

async function open(browser, opts, body, status = 200) {
  const ctx = await browser.newContext({ ...opts, serviceWorkers: "block" }), page = await ctx.newPage(), errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route(/\/api\/me(\?|$)/, (route) => {
    const origin = route.request().headers().origin || "*", cors = { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true", "Access-Control-Allow-Headers": "*" };
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    return route.fulfill({ status, contentType: "application/json", headers: cors, body: JSON.stringify(body) });
  });
  await page.goto(url(), { waitUntil: "load" });
  return { ctx, page, errors };
}
const visibleNames = (page) => page.evaluate(() => Array.from(document.querySelectorAll(".tn-name")).filter((b) => b.getClientRects().length && getComputedStyle(b).visibility !== "hidden").length);
const text = (page, sel) => page.locator(sel).innerText({ timeout: 3000 }).catch(() => "");
const ready = (page, sel) => page.waitForSelector(sel, { state: "visible", timeout: 20000 }).catch(() => {});

const browser = await pw.chromium.launch();
try {
  for (const [tag, opts] of SIZES) {
    const t = `[${tag}]`, stranger = { display_name: "Zzyzx Test", discord_user_id: FAKE_ID, class: "Mage", race: "Gnome", role: "Damage" };

    /* the card, and the No path */
    let s = await open(browser, opts, stranger);
    await ready(s.page, "#nx-you-yes");
    ok(`${t} card heading`, (await text(s.page, "#nx-you-h")) === "Is this you, Zzyzx Test?");
    ok(`${t} Yes label`, (await text(s.page, "#nx-you-yes")) === "Yes, that's me");
    ok(`${t} No label`, (await text(s.page, "#nx-you-no")) === "No, pick someone else");
    ok(`${t} no names behind the card`, (await visibleNames(s.page)) === 0);
    ok(`${t} no Discord id on the page`, !(await s.page.content()).includes(FAKE_ID));
    const r = await s.page.evaluate(() => { const b = document.getElementById("nx-you-yes"), x = b ? b.getBoundingClientRect() : null; return x && { t: x.top, b: x.bottom, l: x.left, r: x.right, h: innerHeight, w: innerWidth }; });
    ok(`${t} Yes inside the viewport`, !!r && r.t >= 0 && r.b <= r.h && r.l >= 0 && r.r <= r.w, JSON.stringify(r));
    await s.page.screenshot({ path: path.join(SHOTS, `is-this-you-${tag}.png`) });
    await s.page.locator("#nx-you-no").click();
    await s.page.waitForTimeout(500);
    ok(`${t} No opens the five names`, (await visibleNames(s.page)) === 5, String(await visibleNames(s.page)));
    ok(`${t} card gone after No`, (await s.page.locator("#nx-you").count()) === 0);
    ok(`${t} no page errors (No path)`, s.errors.length === 0, s.errors.join(" | "));
    await s.ctx.close();

    /* the Yes path, name not on the board: empty state with the /build prompt */
    s = await open(browser, opts, stranger);
    await ready(s.page, "#nx-you-yes");
    await s.page.locator("#nx-you-yes").click();
    await s.page.waitForSelector("#nx-you-empty", { timeout: 5000 }).catch(() => {});
    const empty = await text(s.page, "#nx-you");
    ok(`${t} Yes (unknown build) prompts /build`, /Run \/build in Discord/.test(empty), empty);
    ok(`${t} Yes shows the build the answer carried`, /Gnome Mage, Damage/.test(empty), empty);
    ok(`${t} Yes empty state hides the id`, !empty.includes(FAKE_ID));
    ok(`${t} no names in the empty state`, (await visibleNames(s.page)) === 0);
    await s.ctx.close();

    /* the Yes path, name on the board: that sheet opens. The member name is read from the board itself. */
    const probe = await open(browser, opts, {}, 401);
    await probe.page.waitForFunction(() => window.__next && window.__next.input().party, null, { timeout: 20000 }).catch(() => {});
    const known = await probe.page.evaluate(() => { try { return window.__next.input().party.members[0].name; } catch (e) { return ""; } });
    await probe.ctx.close();
    ok(`${t} found a board member to match`, !!known);
    s = await open(browser, opts, { display_name: known, discord_user_id: FAKE_ID });
    await ready(s.page, "#nx-you-yes");
    ok(`${t} card names the board member`, (await text(s.page, "#nx-you-h")) === `Is this you, ${known}?`);
    await s.page.locator("#nx-you-yes").click();
    await ready(s.page, "#ps-name");
    ok(`${t} Yes opens the sheet`, (await text(s.page, "#ps-name")) === `${known}'s sheet`, await text(s.page, "#ps-name"));
    ok(`${t} card gone after Yes`, (await s.page.locator("#nx-you").count()) === 0);
    ok(`${t} no Discord id after Yes`, !(await s.page.content()).includes(FAKE_ID));
    ok(`${t} no page errors (Yes path)`, s.errors.length === 0, s.errors.join(" | "));
    await s.ctx.close();
  }
  /* a failed /api/me leaves the first screen alone */
  const c = await open(browser, SIZES[0][1], {}, 401);
  await ready(c.page, "#nx-fr2-go");
  ok("[401] first-run card stays", (await c.page.locator("#nx-fr2-go").count()) === 1 && (await c.page.locator("#nx-you").count()) === 0);
  await c.ctx.close();
} finally { await browser.close(); }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
