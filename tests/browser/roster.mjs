// Officer roster scene check: flag roster.v1 off hides it, flag on shows a Menu entry and #roster opens the scene. 390x844 (touch) and 1366x768.
//   node roster.mjs --url https://pr-13.leeroy-board.pages.dev/   (or env PREVIEW_PAGES)
// The flag is switched on by intercepting data/client.json (the file itself ships roster.v1 as false). Reads data/sample/roster.json only; nothing is sent, no AI call.
// Checks: flag off = no Menu entry and #roster does nothing; flag on = Menu entry opens it; three role columns with the right seat counts; one-line summary text;
// bench strip; no horizontal overflow; arrow keys move focus between seats; Escape closes and returns focus; axe finds no serious or critical violations; no console or page errors.
// Exit 0 when every check passes, 1 otherwise.
const pw = await import("playwright").catch(() => { console.error("playwright not found; run npm install in tests/"); process.exit(2); });
const { AxeBuilder } = await import("@axe-core/playwright").catch(() => { console.error("@axe-core/playwright not found; run npm install in tests/"); process.exit(2); });
const argv = process.argv.slice(2), ui = argv.indexOf("--url");
const BASE = (ui >= 0 && argv[ui + 1]) || process.env.PREVIEW_PAGES;
if (!BASE) { console.error("usage: node roster.mjs --url <pages origin> (or set PREVIEW_PAGES)"); process.exit(2); }
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${extra ? `: ${extra}` : ""}`); } };
const CTX = [["390x844", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }], ["1366x768", { viewport: { width: 1366, height: 768 } }]];
const SUMMARY = "2 tanks, 4 healers, 14 damage; 3 on the bench";

async function flagged(ctx, on) {
  await ctx.route("**/data/client.json*", async (route) => {
    const res = await route.fetch();
    const j = await res.json();
    j.flags = { ...(j.flags || {}), "roster.v1": on };
    await route.fulfill({ status: 200, contentType: "application/json", headers: { "cache-control": "no-store" }, body: JSON.stringify(j) });
  });
}

async function run(browser, size, opts, flagOn) {
  const tag = `[${size}${flagOn ? "" : " flag off"}]`, errors = [];
  const ctx = await browser.newContext({ ...opts, serviceWorkers: "block", reducedMotion: "reduce" });
  await flagged(ctx, flagOn);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`pageerror ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/^Failed to load resource|cloudflareinsights/.test(m.text())) errors.push(m.text()); });
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForTimeout(2000);
  const dlg = page.locator("#roster");
  const phone = size.startsWith("390");

  if (!flagOn) {
    await page.goto(`${BASE}#roster`, { waitUntil: "load" }); await page.waitForTimeout(2000);
    ok(`${tag} #roster does nothing`, (await dlg.count()) === 0 || !(await dlg.isVisible()));
    if (phone) { await page.locator('#bottombar [data-place="more"]').click({ timeout: 4000 }).catch(() => {}); await page.waitForTimeout(500); }
    ok(`${tag} no Menu entry`, (await page.locator("#open-roster").count()) === 0 && (await page.getByRole("button", { name: "Raid roster" }).count()) === 0);
    ok(`${tag} no console or page errors`, errors.length === 0, errors.join(" | ").slice(0, 200));
    await ctx.close(); return;
  }

  /* Menu entry: the More places sheet on the phone shell, the Raid roster button beside Settings on the wall elsewhere */
  let entry;
  if (phone) {
    const more = page.locator('#bottombar [data-place="more"]');
    await more.waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
    await more.click().catch(() => {});
    entry = page.getByRole("button", { name: "Raid roster" }).last();
    await entry.waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
  } else {
    await page.evaluate(() => window.__boardKit.requestClose()).catch(() => {}); await page.waitForTimeout(1200);
    entry = page.locator("#open-roster");
    await entry.waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
  }
  ok(`${tag} Menu has the Raid roster entry`, (await entry.count()) === 1 && /raid roster/i.test(await entry.textContent().catch(() => "")));
  await entry.click().catch(() => {});
  await dlg.waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
  ok(`${tag} Menu entry opens the roster`, await dlg.isVisible());
  await page.locator("#rs-body .rs-col").first().waitFor({ state: "attached", timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(300);

  /* content */
  ok(`${tag} hash is #roster`, (await page.evaluate(() => location.hash)) === "#roster");
  ok(`${tag} one-line summary`, (await page.locator("#rs-sum").innerText()).trim() === SUMMARY, await page.locator("#rs-sum").innerText());
  const counts = {};
  for (const r of ["tank", "healer", "dps"]) counts[r] = await page.locator(`.rs-col[data-role="${r}"] .rs-seat`).count();
  ok(`${tag} role columns hold 2 tanks, 4 healers, 14 damage`, counts.tank === 2 && counts.healer === 4 && counts.dps === 14, JSON.stringify(counts));
  ok(`${tag} bench strip lists 3`, (await page.locator(".rs-bench .rs-seat").count()) === 3);
  ok(`${tag} no horizontal overflow`, await page.evaluate(() => { const c = document.getElementById("rs-card"); return c.scrollWidth - c.clientWidth <= 1 && document.documentElement.scrollWidth - window.innerWidth <= 1; }));
  const cols = await page.locator(".rs-col").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)));
  ok(`${tag} columns ${phone ? "stack" : "sit side by side"}`, phone ? new Set(cols.slice(0, 3)).size === 1 : new Set(cols.slice(0, 3)).size === 3, cols.join(","));
  ok(`${tag} focus starts on Close`, await page.evaluate(() => document.activeElement && document.activeElement.id === "rs-close"));

  /* keyboard: Tab reaches the first seat, arrows move */
  await page.keyboard.press("Tab");
  const seatName = () => page.evaluate(() => (document.activeElement && document.activeElement.hasAttribute("data-seat") ? document.activeElement.querySelector(".rs-name").textContent : null));
  const first = await seatName();
  ok(`${tag} Tab lands on the first seat`, first === "Brindle Oakhand", String(first));
  await page.keyboard.press("ArrowDown");
  const second = await seatName();
  ok(`${tag} ArrowDown moves to the next seat in the column`, second === "Marrow Ironkettle", String(second));
  await page.keyboard.press("ArrowRight");
  const healer = await page.evaluate(() => document.activeElement.closest(".rs-col") && document.activeElement.closest(".rs-col").dataset.role);
  ok(`${tag} ArrowRight moves to the next role column`, healer === "healer", String(healer));
  await page.keyboard.press("End");
  ok(`${tag} End goes to the last seat in the column`, (await seatName()) === "Tamsin Riverbend");

  await page.screenshot({ path: `roster-${size}.png` }).catch(() => {});

  /* axe */
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const hit = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  for (const v of r.violations.filter((x) => !hit.includes(x))) console.log(`WARN ${tag} axe ${v.id} (${v.impact}) x${v.nodes.length}`);
  ok(`${tag} no serious or critical axe violations`, hit.length === 0, hit.map((v) => `${v.id} x${v.nodes.length}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`).join("; "));

  /* Escape closes, hash cleared, focus returns */
  await page.keyboard.press("Escape");
  ok(`${tag} Escape closes the roster`, !(await dlg.isVisible()));
  ok(`${tag} hash cleared`, (await page.evaluate(() => location.hash)) !== "#roster");
  ok(`${tag} focus is back on the page`, await page.evaluate(() => document.activeElement && document.activeElement !== document.body));

  /* #roster opens it directly */
  await page.evaluate(() => { location.hash = "#roster"; });
  await dlg.waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
  ok(`${tag} #roster opens it`, await dlg.isVisible());
  await page.keyboard.press("Escape");

  ok(`${tag} no console or page errors`, errors.length === 0, errors.join(" | ").slice(0, 300));
  await ctx.close();
}

const browser = await pw.chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ["--no-sandbox"] } : {});
for (const [size, opts] of CTX) { await run(browser, size, opts, false); await run(browser, size, opts, true); }
await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
