// Character switcher check (Q37, flag chars.v1): flag off or signed out shows nothing new; flag on with 2 or more characters in the /me answer shows "You have N", an inline switcher and
// "Add another character" with the manual form. 320, 390 (touch), 768 and 1366 wide.
//   node char-switcher.mjs --url https://pr-N.leeroy-board.pages.dev/   (or env PREVIEW_PAGES)
// The flag is switched on by intercepting data/client.json (the file ships chars.v1 as false). /me and POST /me/characters are stubbed by interception with fictional names;
// the viewer is the first member on the board (read at run time) and board-wl marks a web sign-in. Nothing real is sent and no AI is called.
// A page that is not on localhost reaches the Worker through its own brain address, so on localhost the check opens the page with ?brain=local&preview=1 and stubs /api/* itself.
// Checks: off = no switcher; one character = no switcher; three = heading, three buttons, first pressed, summary line; click and arrow keys switch and the choice is remembered after a reload;
// the form validates (named errors, aria-invalid, focus on the first bad line), a 201 adds a fourth, a 404 keeps the form open with a plain message, Escape closes and returns focus;
// no horizontal scroll, every control at least 44px tall, the title never overlaps the switcher or Back; axe finds no serious or critical violations; no console or page errors.
// Exit 0 when every check passes, 1 otherwise.
import { pageUrl, originOf, dirOf } from "../helpers/page-url.mjs";
import { stubbed } from "../helpers/browser-stub.mjs";
const pw = await import("playwright").catch(() => { console.error("playwright not found; run npm install in tests/"); process.exit(2); });
const { AxeBuilder } = await import("@axe-core/playwright").catch(() => { console.error("@axe-core/playwright not found; run npm install in tests/"); process.exit(2); });
const argv = process.argv.slice(2), ui = argv.indexOf("--url");
const BASE = (ui >= 0 && argv[ui + 1]) || process.env.PREVIEW_PAGES;
if (!BASE) { console.error("usage: node char-switcher.mjs --url <pages origin> (or set PREVIEW_PAGES)"); process.exit(2); }
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${extra ? `: ${extra}` : ""}`); } };
const SIZES = [
  ["320x700", { viewport: { width: 320, height: 700 }, hasTouch: true, isMobile: true }],
  ["390x844", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }],
  ["768x1024", { viewport: { width: 768, height: 1024 }, hasTouch: true }],
  ["1366x768", { viewport: { width: 1366, height: 768 } }],
];
const slug = (n) => String(n).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const CHARS = [
  { id: "t-1", name: "Pip Fizzwick", class: "Mage", race: "Gnome", ruleset: "Normal", faction: "Alliance", region: "Americas" },
  { id: "t-2", name: "Marrow Ironkettle", class: "Warrior", race: "Dwarf", ruleset: "Normal", faction: "Alliance", region: "Americas" },
  { id: "t-3", name: "Tamsin Riverbend of the Long Name Wells", class: "Priest", race: "Human", ruleset: "Hardcore", faction: "Alliance", region: "EU" },
];
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: { "cache-control": "no-store" }, body: JSON.stringify(body) });
const FORM = { name: "Wick Tallow", class: "Rogue", race: "Human", ruleset: "Normal", faction: "Horde", region: "Americas" };

async function openSheet(page, me) {
  await page.waitForFunction(() => window.__scenes && window.__boardKit && window.__boardKit.D && window.__boardKit.D.party, null, { timeout: 15000 }).catch(() => {});
  await page.evaluate(() => window.__scenes.load("sheet")).catch(() => {});
  await page.evaluate((m) => window.__sheet && window.__sheet.openSheet(m, true), me).catch(() => {});
  await page.locator("#ps-name").waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1200);
}
async function open(browser, opts, c) {
  const ctx = await browser.newContext({ ...opts, serviceWorkers: "block", reducedMotion: "reduce" }), page = await ctx.newPage(), errors = [], posts = [];
  page.on("pageerror", (e) => errors.push(`pageerror ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/^\[Report Only\]/.test(m.text()) && !/^Failed to load resource|cloudflareinsights|net::ERR|WebSocket connection/.test(m.text())) errors.push(m.text()); });
  await ctx.addInitScript(([me, wl]) => { try { if (!localStorage.getItem("board-journey")) localStorage.setItem("board-journey", "guided"); localStorage.setItem("board-me", me); if (wl) localStorage.setItem("board-wl", "1"); } catch (e) {} }, [c.me, c.signedIn !== false]);
  await ctx.route("**/data/client.json*", async (route) => { const j = await (await route.fetch()).json(); j.flags = { ...(j.flags || {}), "chars.v1": !!c.flag }; await json(route, j); });
  await ctx.route("**/api/**", (route) => route.abort());
  await ctx.route("**/api/me", (route) => (route.request().method() === "GET" ? json(route, { user: "abcd1234", expires_at: 4102444800, characters: c.chars }) : route.abort()));
  await ctx.route("**/api/me/characters", (route) => { posts.push(route.request().postDataJSON()); return c.post === 404 ? json(route, { error: "not found" }, 404) : json(route, { character: { id: "t-new", ...route.request().postDataJSON() } }, 201); });
  await page.goto(pageUrl(BASE, { params: { preview: "1" }, defaults: { brain: "local" } }), { waitUntil: "load" });
  await openSheet(page, c.me);
  return { ctx, page, errors, posts };
}
/* centre the control first: on a short phone screen the sheet scrolls under the floating bottom bar, and a click at the very edge can land on it */
const tap = async (page, sel) => { await page.locator(sel).evaluate((e) => e.scrollIntoView({ block: "center" })); await page.locator(sel).click(); };
const noScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth <= 1);
/* layout height (offsetHeight): the wide sheet is scaled to fit, so the painted box can be a little under the CSS size */
const tall = (page, sel) => page.locator(sel).evaluateAll((els) => els.filter((e) => e.getBoundingClientRect().width > 0).map((e) => e.offsetHeight).filter((h) => h < 44));
const box = (page, sel) => page.locator(sel).first().boundingBox();
const apart = (a, b) => !!a && !!b && (a.y + a.height <= b.y + 0.5 || b.y + b.height <= a.y + 0.5 || a.x + a.width <= b.x + 0.5 || b.x + b.width <= a.x + 0.5);

const browser = stubbed(await pw.chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ["--no-sandbox"] } : {}));
const first = await (await fetch(new URL("data/party.json", dirOf(BASE)))).json();
const me = slug(first.members[0].name);

/* off, signed out, one character: nothing new */
for (const [label, c] of [["flag off", { flag: false, chars: CHARS }], ["signed out", { flag: true, chars: CHARS, signedIn: false }], ["one character", { flag: true, chars: CHARS.slice(0, 1) }], ["no characters key", { flag: true, chars: undefined }]]) {
  const { ctx, page, errors } = await open(browser, SIZES[1][1], { ...c, me });
  ok(`[${label}] the sheet opens`, await page.locator("#ps-name").isVisible());
  ok(`[${label}] no switcher`, (await page.locator("#ps-chars").count()) === 0);
  ok(`[${label}] no console or page errors`, errors.length === 0, errors.join(" | ").slice(0, 200));
  await ctx.close();
}

for (const [size, opts] of SIZES) {
  const tag = `[${size}]`, phone = opts.viewport.width < 700;
  const { ctx, page, errors, posts } = await open(browser, opts, { flag: true, chars: CHARS, me });
  const sw = page.locator("#ps-chars");
  await sw.waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
  ok(`${tag} switcher shows`, await sw.isVisible());
  ok(`${tag} heading says "You have 3"`, (await page.locator("#ps-chars-h").innerText()).trim() === "You have 3");
  ok(`${tag} three character buttons, first pressed`, (await page.locator(".ps-char").count()) === 3 && (await page.locator(".ps-char").first().getAttribute("aria-pressed")) === "true");
  ok(`${tag} summary line names the first character`, /^Pip Fizzwick: Gnome Mage, Normal, Alliance, Americas\.$/.test((await page.locator("#ps-char-now").innerText()).trim()), await page.locator("#ps-char-now").innerText());
  ok(`${tag} no horizontal scroll`, await noScroll(page));
  ok(`${tag} controls at least 44px tall`, (await tall(page, ".ps-char, .ps-char-add")).length === 0, JSON.stringify(await tall(page, ".ps-char, .ps-char-add")));
  const title = await box(page, "#ps-name"), back = await box(page, ".ps-back"), bar = await box(page, "#ps-chars");
  ok(`${tag} title does not overlap the switcher or Back`, apart(title, bar) && apart(title, back) && apart(back, bar), JSON.stringify({ title, back, bar }));
  ok(`${tag} switcher sits inside the card`, await page.evaluate(() => { const c = document.querySelector(".ps-card").getBoundingClientRect(), s = document.getElementById("ps-chars").getBoundingClientRect(); return s.left >= c.left - 1 && s.right <= c.right + 1; }));

  /* switching: click, then the arrow keys, then a reload remembers it */
  await page.locator(".ps-char").nth(1).click();
  ok(`${tag} click switches the character`, (await page.locator(".ps-char").nth(1).getAttribute("aria-pressed")) === "true" && /^Marrow Ironkettle: Dwarf Warrior/.test(await page.locator("#ps-char-now").innerText()));
  ok(`${tag} focus stays on the chosen button`, await page.evaluate(() => document.activeElement && document.activeElement.getAttribute("aria-pressed") === "true"));
  await page.keyboard.press("ArrowRight");
  ok(`${tag} ArrowRight moves focus to the next button`, (await page.evaluate(() => document.activeElement.textContent)).startsWith("Tamsin"));
  await page.keyboard.press("Enter");
  ok(`${tag} Enter picks it, long name wraps inside the card`, /^Tamsin/.test(await page.locator("#ps-char-now").innerText()) && (await noScroll(page)));
  ok(`${tag} the choice is announced`, /Showing Tamsin/.test(await page.locator("#ps-char-say").innerText()));
  await page.reload({ waitUntil: "load" }); await openSheet(page, me); await page.locator("#ps-chars").waitFor({ state: "visible", timeout: 10000 }).catch(() => {}); await page.waitForTimeout(500);
  ok(`${tag} the choice is remembered after a reload`, (await page.locator(".ps-char").nth(2).getAttribute("aria-pressed")) === "true");

  /* the form */
  await tap(page, "#ps-char-add");
  await page.locator("#ps-cf").waitFor({ state: "visible", timeout: 4000 }).catch(() => {});
  ok(`${tag} Add another character opens the form with focus on Name`, (await page.locator("#ps-cf").isVisible()) && (await page.evaluate(() => document.activeElement && document.activeElement.id)) === "ps-cf-name");
  ok(`${tag} the form has the six lines, each labelled`, (await page.locator("#ps-cf .ps-cf-l").count()) === 6 && (await page.evaluate(() => [...document.querySelectorAll("#ps-cf .ps-cf-c")].every((e) => document.querySelector(`label[for="${e.id}"]`)))));
  ok(`${tag} the add button reports it is expanded`, (await page.locator("#ps-char-add").getAttribute("aria-expanded")) === "true");
  ok(`${tag} form controls at least 44px tall`, (await tall(page, "#ps-cf .ps-cf-c, #ps-cf .ps-cf-go, #ps-cf .ps-cf-cancel")).length === 0, JSON.stringify(await tall(page, "#ps-cf .ps-cf-c, #ps-cf .ps-cf-go, #ps-cf .ps-cf-cancel")));
  ok(`${tag} form has no horizontal scroll`, await noScroll(page));
  await tap(page, "#ps-cf .ps-cf-go");
  ok(`${tag} an empty form names every missing line`, (await page.locator("#ps-cf .ps-cf-e").count()) === 6 && (await page.locator('#ps-cf [aria-invalid="true"]').count()) === 6);
  ok(`${tag} focus goes to the first bad line`, (await page.evaluate(() => document.activeElement && document.activeElement.id)) === "ps-cf-name");
  ok(`${tag} nothing was sent for a bad form`, posts.length === 0);
  await page.locator("#ps-cf-name").fill("Pip Fizzwick");
  await page.locator("#ps-cf-class").selectOption({ index: 1 }); await page.locator("#ps-cf-race").selectOption({ index: 1 }); await page.locator("#ps-cf-faction").selectOption("Horde"); await page.locator("#ps-cf-region").selectOption("Americas");
  await page.locator("#ps-cf-ruleset").fill("Normal");
  await page.locator("#ps-cf-name").fill(CHARS[0].name); await page.locator("#ps-cf-ruleset").fill("Normal"); await page.locator("#ps-cf-region").selectOption("Americas");
  await tap(page, "#ps-cf .ps-cf-go");
  ok(`${tag} a name already on the list is refused`, /already have/.test((await page.locator("#ps-cf-name-e").innerText().catch(() => "")) || ""));

  /* a failing save keeps the form and the list */
  await page.locator("#ps-cf-name").fill(FORM.name);
  await tap(page, "#ps-cf .ps-cf-go");
  await page.waitForTimeout(500);
  const body = posts[posts.length - 1];
  ok(`${tag} the add sends exactly the six lines`, !!body && JSON.stringify(Object.keys(body).sort()) === JSON.stringify(["class", "faction", "name", "race", "region", "ruleset"]) && body.name === FORM.name && body.faction === "Horde", JSON.stringify(body));
  ok(`${tag} the new character is shown and counted`, (await page.locator("#ps-chars-h").innerText()).trim() === "You have 4" && (await page.locator(".ps-char").count()) === 4 && /^Wick Tallow:/.test(await page.locator("#ps-char-now").innerText()));
  ok(`${tag} the form closed and the result was announced`, (await page.locator("#ps-cf").count()) === 0 && /Added Wick Tallow/.test(await page.locator("#ps-char-say").innerText()));
  ok(`${tag} focus is on the new character`, await page.evaluate(() => document.activeElement && document.activeElement.getAttribute("aria-pressed") === "true"));

  /* Escape closes the form and returns focus */
  await tap(page, "#ps-char-add"); await page.locator("#ps-cf-name").waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
  await page.keyboard.press("Escape");
  ok(`${tag} Escape closes the form`, (await page.locator("#ps-cf").count()) === 0);
  ok(`${tag} focus returns to the add button`, (await page.evaluate(() => document.activeElement && document.activeElement.id)) === "ps-char-add");

  /* axe, with the form open so it is covered */
  await tap(page, "#ps-char-add"); await page.locator("#ps-cf").waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
  if (size === "390x844" || size === "1366x768") {
    const r = await new AxeBuilder({ page }).include("#ps-chars").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    const hit = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    for (const v of r.violations.filter((x) => !hit.includes(x))) console.log(`WARN ${tag} axe ${v.id} (${v.impact}) x${v.nodes.length}`);
    ok(`${tag} no serious or critical axe violations`, hit.length === 0, hit.map((v) => `${v.id} x${v.nodes.length}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`).join("; "));
  }
  await page.screenshot({ path: `char-switcher-${size}.png` }).catch(() => {});
  ok(`${tag} no console or page errors`, errors.length === 0, errors.join(" | ").slice(0, 300));
  await ctx.close();
}

/* a refused save (404) keeps the form and the list */
{
  const { ctx, page, errors } = await open(browser, SIZES[1][1], { flag: true, chars: CHARS, me, post: 404 });
  await page.locator("#ps-chars").waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
  await tap(page, "#ps-char-add");
  await page.locator("#ps-cf-name").fill(FORM.name);
  await page.locator("#ps-cf-class").selectOption({ index: 1 }); await page.locator("#ps-cf-race").selectOption({ index: 1 }); await page.locator("#ps-cf-faction").selectOption("Horde"); await page.locator("#ps-cf-region").selectOption("Americas");
  await page.locator("#ps-cf-ruleset").fill("Normal");
  await tap(page, "#ps-cf .ps-cf-go");
  // bounded wait on the state instead of a fixed 500 ms sleep: the refusal message arrives with the 404, which was slower than that once on a loaded CI runner (run 42320879864)
  await page.waitForFunction(() => /^Not added: /.test(((document.querySelector("#ps-char-say") || {}).innerText || "").trim()), null, { timeout: 8000 }).catch(() => {});
  ok("[refused save] the form stays open with what was typed", (await page.locator("#ps-cf").isVisible()) && (await page.locator("#ps-cf-name").inputValue()) === FORM.name);
  ok("[refused save] the list is unchanged and the message is plain", (await page.locator(".ps-char").count()) === 3 && /^Not added: /.test((await page.locator("#ps-char-say").innerText()).trim()));
  ok("[refused save] no console or page errors", errors.length === 0, errors.join(" | ").slice(0, 300));
  await ctx.close();
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
