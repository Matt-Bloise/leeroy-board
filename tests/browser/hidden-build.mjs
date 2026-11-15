// A member can hide race, class, spec, professions and zone, and the public party document then simply lacks them (public-party.js). This loads the real board in Chromium
// with the repo's own party, decide and tonight documents PROJECTED for a party in which one member hides everything, others hide one field each, and one has no role at all
// (the document of a board that predates roles), and checks the page copes:
//   - every scene opens with no page error and no console error;
//   - no visible text, label or title says "undefined", "null" or "NaN";
//   - the party formation (js/seals.js) puts a coin in a lane for EVERY member, including the one with no role and the one with no class (it used to throw and show none);
//   - the card of the member who hides race and class says "Build hidden", and every view of a withheld document (decide, ledger, racials, buffs, tonight, the wall tiles) shows the one plain line where the section was;
//   - the sheet page offers only values that are on the board's vocabulary (the lists the Worker checks a write against), whoever hides what.
//   node tools/static-server.mjs 8123 &   node tests/browser/hidden-build.mjs --url http://127.0.0.1:8123/        optional: env PW_CHROMIUM = path to a Chromium binary
// Nothing is sent and there is no AI call: both the static path and the Worker path of each document are answered here, /api/bootstrap is refused so the board falls back to them.
// Fictional data only (the names are the repo's own made-up party). Exit 0 when every check passes, 1 otherwise.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pageUrl } from "../helpers/page-url.mjs";
import { stubbed } from "../helpers/browser-stub.mjs";
import { projectForAnonymous, projectDecide, projectTonight, projectGuidedAtlas, projectClient, WITHHELD_LINE } from "../../infrastructure/worker/public-party.js";
import { SHEET_VOCAB } from "../../infrastructure/worker/sheet-vocab.js";
const pw = await import("playwright").catch(() => { console.error("playwright not found; run npm install in tests/"); process.exit(2); });
const argv = process.argv.slice(2), arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const BASE = arg("--url") || process.env.PREVIEW_PAGES;
if (!BASE) { console.error("usage: node hidden-build.mjs --url <pages origin> (or set PREVIEW_PAGES)"); process.exit(2); }
const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = (n) => JSON.parse(fs.readFileSync(path.join(here, "..", "..", "data", `${n}.json`), "utf8"));
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${extra ? `: ${extra}` : ""}`); } };

// ---- the projected documents ---------------------------------------------------------------------------------------------------------
const party0 = DATA("party"), decide0 = DATA("decide"), tonight0 = DATA("tonight"), atlas0 = DATA("guided-atlas"), client0 = DATA("client");
const slug = (n) => n.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const HIDE = [["race", "class", "spec_path", "spec_at_40", "professions", "plan_zone"], ["class"], ["professions", "spec_at_40"], ["race"], ["plan_zone"]];
const sheets = party0.members.map((m, i) => ({ slug: slug(m.name), name: m.name, updated: "x", fields: Object.fromEntries(["race", "class", "spec_path", "spec_at_40", "professions", "plan_zone", "level", "goals"].map((f) => [f, { value: "x", visible: !(HIDE[i] || []).includes(f), source: "board", at: "x" }])) }));
const party = projectForAnonymous(party0, sheets);
delete party.members[4].role; // a card with no role at all
const PARTY = JSON.stringify(party), DECIDE = JSON.stringify(projectDecide(decide0, party0, sheets)), TONIGHT = JSON.stringify(projectTonight(tonight0, party0, sheets)), ATLAS = JSON.stringify(projectGuidedAtlas(atlas0, party0, sheets)), CLIENT = JSON.stringify(projectClient(client0, party0, sheets));
ok("fixture: the first member shows a name and a role only", JSON.stringify(Object.keys(party.members[0]).sort()) === JSON.stringify(["name", "role"]), Object.keys(party.members[0]).join(","));
ok("fixture: the last member has no role and no start zone", party.members[4].role === undefined && party.members[4].start_zone === undefined && party.members[4].class !== undefined, JSON.stringify(Object.keys(party.members[4])));
ok("fixture: one member hides class, so there is a member with no class_key", party.members[1].class_key === undefined && party.members[1].race !== undefined);

const DATA_RE = /\/(?:api\/)?data\/(party|decide|tonight|guided-atlas|client)(?:\.json)?(?:\?|$)/;
const json = (route, body) => route.fulfill({ status: 200, contentType: "application/json", headers: { "cache-control": "no-store", "access-control-allow-origin": "*" }, body });
async function setup(browser, width, { member = null } = {}) {
  const phone = width < 768;
  const ctx = await browser.newContext({ viewport: { width, height: phone ? 800 : 900 }, hasTouch: phone, isMobile: phone, serviceWorkers: "block", reducedMotion: "reduce" });
  await ctx.route("**/api/bootstrap*", (r) => r.abort());
  await ctx.route(DATA_RE, (route) => json(route, { party: PARTY, decide: DECIDE, tonight: TONIGHT, "guided-atlas": ATLAS, client: CLIENT }[DATA_RE.exec(route.request().url())[1]]));
  const page = await ctx.newPage(), errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|net::ERR|favicon|ERR_FAILED/.test(m.text())) errors.push(`console: ${m.text()}`); });
  await page.goto(pageUrl(BASE, { params: { preview: "1" } }), { waitUntil: "load" });
  await page.waitForSelector("#nx-fr2-look, .tn-name", { state: "attached", timeout: 20000 }).catch(() => {});
  await page.waitForFunction(() => { const vis = (e) => !!e && e.getClientRects().length > 0; return vis(document.querySelector("#nx-fr2-look")) || Array.from(document.querySelectorAll(".tn-name")).some(vis); }, null, { timeout: 20000 }).catch(() => {});
  const look = page.locator("#nx-fr2-look");
  if (await look.isVisible().catch(() => false)) await look.click();
  await page.waitForSelector(".tn-name", { state: "visible", timeout: 20000 }).catch(() => {});
  if (member) { await page.locator(".tn-name", { hasText: member }).first().click().catch(() => {}); await page.locator("#nx-show").click({ timeout: 3000 }).catch(() => {}); } // pick the name, then "Show me": the page is then signed in as that member
  await page.waitForTimeout(1000);
  return { ctx, page, errors };
}
const BAD = /\bundefined\b|\bnull\b|\bNaN\b/;
const strings = (page) => page.evaluate(() => {
  const out = [];
  const shown = (el) => { for (let e = el; e; e = e.parentElement) { const cs = getComputedStyle(e); if (cs.display === "none" || cs.visibility === "hidden") return false; } return true; };
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) { const t = n.nodeValue.replace(/\s+/g, " ").trim(); if (t && n.parentElement && !["SCRIPT", "STYLE", "NOSCRIPT"].includes(n.parentElement.tagName) && shown(n.parentElement)) out.push(`text: ${t}`); }
  for (const el of document.querySelectorAll("[aria-label],[title],[alt]")) for (const a of ["aria-label", "title", "alt"]) { const v = el.getAttribute(a); if (v && shown(el)) out.push(`${a}: ${v}`); }
  return out;
});
async function openHash(page, hash) {
  await page.evaluate((h) => { location.hash = h; }, hash);
  await page.waitForFunction(() => document.documentElement.classList.contains("scene-open") && !document.querySelector("#scene").hidden, null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(900);
}

const SCENES = ["five", "five.party", `five.sheet-${slug(party0.members[0].name)}`, `five.sheet-${slug(party0.members[1].name)}`, "roads", "atlas", "racials", "buffs", "ledger", "signups", "decide", "tonight", "timeline", "legacy"];
const browser = stubbed(await pw.chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}));
try {
  for (const [width, member] of [[1366, null], [390, null], [1366, party0.members[3].name]]) {
    const t = `[@${width}${member ? ", signed in as a member" : ""}]`;
    const { ctx, page, errors } = await setup(browser, width, { member });
    for (const hash of SCENES) {
      await openHash(page, hash);
      const bad = (await strings(page)).filter((s) => BAD.test(s));
      ok(`${t} #${hash}: no "undefined", "null" or "NaN" on screen`, bad.length === 0, bad.slice(0, 4).join(" || "));
    }
    // the #atlas lede ("M4 in undefined" once) and the guided "In short" box of the roads scene
    await openHash(page, "atlas");
    const lede = await page.evaluate(() => (document.querySelector("#map-lede") || {}).textContent || "");
    ok(`${t} the atlas lede is there and has no undefined`, lede.length > 20 && !BAD.test(lede), lede);
    await openHash(page, "roads");
    const brief = await page.evaluate(() => Array.from(document.querySelectorAll(".jr-core")).map((e) => e.textContent).join(" | "));
    ok(`${t} the guided "In short" box of the roads scene is there and has no undefined`, brief.length > 20 && !BAD.test(brief), brief.slice(0, 200));
    // the party formation: a coin for every member, whatever they hide
    await openHash(page, "five");
    await page.waitForSelector("#five-form", { state: "attached", timeout: 8000 }).catch(() => {});
    const coins = await page.evaluate(() => Array.from(document.querySelectorAll("#five-form .fl")).map((l) => [l.dataset.role, Array.from(l.querySelectorAll(".fc")).map((c) => c.dataset.name)]));
    const all = coins.flatMap(([, names]) => names);
    ok(`${t} the formation has a coin for every member (${party0.members.length})`, all.length === party0.members.length && party0.members.every((m) => all.includes(m.name)), JSON.stringify(coins));
    const lane = (name) => (coins.find(([, names]) => names.includes(name)) || [])[0];
    ok(`${t} the member with no role sits in the damage lane`, lane(party0.members[4].name) === "damage", String(lane(party0.members[4].name)));
    ok(`${t} the member who shows only name and role sits in the lane of that role (${party.members[0].role})`, lane(party0.members[0].name) === party.members[0].role, String(lane(party0.members[0].name)));
    const sum = await page.locator("#five-sum").innerText().catch(() => "");
    ok(`${t} the formation summary counts every member`, /\d/.test(sum) && !BAD.test(sum), sum);
    const cards = await page.evaluate(() => (document.querySelector("#cards") || {}).textContent || ""); // a carousel on a phone: the card is there, off screen
    ok(`${t} the card of the member who hides race and class says "Build hidden"`, /Build hidden/.test(cards), cards.slice(0, 160));
    const panelText = (sel) => page.evaluate((q) => (document.querySelector(q) || {}).textContent || "", sel);
    for (const [hash, sel] of [["decide", "#panel-decide"], ["ledger", "#ledger-slip"], ["racials", "#races"], ["buffs", "#wheel"], ["buffs", "#buffs-deep"], ["tonight", "#panel-tonight"]]) {
      await openHash(page, hash);
      const text = await panelText(sel);
      ok(`${t} #${hash} (${sel}): the one withheld line stands where the section was`, text.includes(WITHHELD_LINE), text.slice(0, 120));
    }
    if (member && width >= 1000) { // the signed-in guided atlas: "Your route" is member-derived, so the guide says the line where the route was
      await page.evaluate(() => { location.hash = ""; }); await page.waitForTimeout(1200);
      const ga = await panelText("#ga");
      ok(`${t} the guided atlas guide says the line where "Your route" was`, ga.includes(WITHHELD_LINE), ga.slice(0, 160));
    }
    for (const id of ["ts-ledger", "ts-racials", "ts-buffs"]) ok(`${t} the wall tile #${id} says the line`, (await panelText(`#${id}`)).includes(WITHHELD_LINE));
    ok(`${t} the wall tile of the roles does not say "All five have picked a spec"`, !/have picked a spec/.test(await panelText("#ts-five")));
    // the sheet page: every option of every list is on the vocabulary, with a whole party withheld
    await openHash(page, `five.sheet-${slug(party0.members[3].name)}`);
    const opts = await page.evaluate(() => Array.from(document.querySelectorAll("#ps-sheet select option")).map((o) => o.value).filter(Boolean));
    const known = new Set([...Object.keys(SHEET_VOCAB.race), ...Object.keys(SHEET_VOCAB.class), ...Object.keys(SHEET_VOCAB.spec), ...Object.keys(SHEET_VOCAB.professions), ...Object.keys(SHEET_VOCAB.plan_zone), "queue", "in", "out", "later"]);
    ok(`${t} the sheet page offers only vocabulary values (${opts.length} options seen)`, opts.every((o) => known.has(o)), opts.filter((o) => !known.has(o)).join(","));
    ok(`${t} no page error and no console error`, errors.length === 0, errors.slice(0, 3).join(" | "));
    await ctx.close();
  }
} finally { await browser.close(); }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
