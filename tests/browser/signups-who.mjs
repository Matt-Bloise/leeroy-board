// B65 check: the member's Sign-ups scene shows who is in for each time slot, under the card, with an explicit "Not answered yet" group.
//   node signups-who.mjs --url https://pr-N.leeroy-board.pages.dev/   (or env PREVIEW_PAGES)   optional: env PW_CHROMIUM = path to a Chromium binary
// Nothing is sent and there is no AI call. data/party.json comes from tests/fixtures/six-members (six made-up members); data/signups.json is built here from a
// table of made-up answers, one per scenario, so the groups are known in advance. Both the static path and the Worker path (/api/data/<name>) are intercepted and
// /api/bootstrap and /api/state are refused so the board falls back to them, with or without an API origin (?brain=, as CI has one). The board reads the roster from the same tallies it already shows (no new endpoint).
// Per scenario (A: every group used, B: no time picked + running late + empty slots, C: everybody answered) and per size (390x844 touch, 1366x768):
//   every member appears exactly once, in the group the table says; "Not answered yet" is always there; the card is under the header (top-aligned, not centred);
//   "Change my answer" and "Show me more" are fully inside the first viewport, and so is the roster; no sideways scroll; no page errors.
// Then the answer flow is unchanged: "Change my answer" opens the panel and "Show me more" opens it too.
// Exit 0 when every check passes, 1 otherwise.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pageUrl } from "../helpers/page-url.mjs";
import { stubbed } from "../helpers/browser-stub.mjs";
const pw = await import("playwright").catch(() => { console.error("playwright not found; run npm install in tests/"); process.exit(2); });
const argv = process.argv.slice(2), arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const BASE = arg("--url") || process.env.PREVIEW_PAGES;
if (!BASE) { console.error("usage: node signups-who.mjs --url <pages origin> (or set PREVIEW_PAGES)"); process.exit(2); }
const here = path.dirname(fileURLToPath(import.meta.url));
const PARTY = fs.readFileSync(path.join(here, "..", "fixtures", "six-members", "party.json"), "utf8");
const NAMES = JSON.parse(PARTY).members.map((m) => m.name);
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${extra ? `: ${extra}` : ""}`); } };
const json = (route, body) => route.fulfill({ status: 200, contentType: "application/json", headers: { "cache-control": "no-store", "access-control-allow-origin": "*" }, body });
const DATA_RE = /\/(?:api\/)?data\/(party|signups)(?:\.json)?(?:\?|$)/;

// answers: member name -> [rsvp, when]; a member that is not listed has not answered. Names go into the tallies the way Discord sends them (decorated with "=").
const signupsOf = (answers) => {
  const rsvp = { in: [], maybe: [], late: [], out: [] }, when = { "6pm": [], "8pm": [], later: [] }, entries = [];
  for (const [name, [r, w]] of Object.entries(answers)) {
    const shown = `=${name}=`; rsvp[r].push(shown); if (w) when[w].push(shown);
    entries.push({ name: shown, pack: null, meet: null, rsvp: r, when: w || null, updated: "2026-10-29T02:42:02.549Z" });
  }
  const tally = (o) => Object.fromEntries(Object.entries(o).map(([k, names]) => [k, { count: names.length, names }]));
  return JSON.stringify({ generated: "2026-11-01T22:54:51.764Z", present: true, updated: "2026-10-29T02:42:02.549Z", options: { meet: ["Valley of Strength", "The Crossroads"], when: ["6pm", "8pm", "later"] }, entries,
    tallies: { pack: { yes: { count: 0, names: [] }, no: { count: 0, names: [] } }, meet: { "Valley of Strength": { count: 0, names: [] }, "The Crossroads": { count: 0, names: [] }, other: { count: 0, names: [], places: [] } }, rsvp: tally(rsvp), when: tally(when) } });
};
const [BRINDLE, PIP, MOSSBACK, EMBER, HOBB, TALLOW] = NAMES;
// expected: group id (data-g) -> member names
const SCENARIOS = [
  { id: "A every group used", signups: { [BRINDLE]: ["in", "6pm"], [PIP]: ["in", "8pm"], [MOSSBACK]: ["in", "later"], [EMBER]: ["maybe", null], [HOBB]: ["out", null] },
    want: { "6pm": [BRINDLE], "8pm": [PIP], later: [MOSSBACK], maybe: [EMBER], out: [HOBB], none: [TALLOW] } },
  { id: "B no time picked, running late, empty slots", signups: { [BRINDLE]: ["in", null], [PIP]: ["late", null], [EMBER]: ["in", "8pm"] },
    want: { "6pm": [], "8pm": [EMBER], later: [], "in-open": [BRINDLE], late: [PIP], none: [MOSSBACK, HOBB, TALLOW] } },
  { id: "C everybody answered", signups: Object.fromEntries(NAMES.map((n, i) => [n, ["in", ["6pm", "8pm", "later"][i % 3]]])),
    want: { "6pm": [NAMES[0], NAMES[3]], "8pm": [NAMES[1], NAMES[4]], later: [NAMES[2], NAMES[5]], none: [] } },
];

async function open(browser, width, height, signups) {
  const phone = width < 768;
  const ctx = await browser.newContext({ viewport: { width, height }, hasTouch: phone, isMobile: phone, serviceWorkers: "block", reducedMotion: "reduce" });
  await ctx.route("**/api/bootstrap*", (r) => r.abort());
  await ctx.route("**/api/state*", (r) => r.abort()); // with an API origin the board also takes its sign-ups from /api/state (the snapshot's real names); refused, it keeps the data files above
  await ctx.route(DATA_RE, (route) => json(route, DATA_RE.exec(route.request().url())[1] === "party" ? PARTY : signups));
  const page = await ctx.newPage(), errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(pageUrl(BASE, { params: { preview: "1" } }), { waitUntil: "load" });
  await page.waitForSelector("#nx-fr2-look, .tn-name", { state: "attached", timeout: 20000 }).catch(() => {});
  // "Just take a look" must be TAKEN, not only looked for: the link (or the chips themselves, on a visit that skips the first-visit sheet) can be attached a moment before it is
  // visible, and a click skipped because the link was not visible yet leaves the chips hidden for good, so the click on a chip times out (the same race B64 fixed in six-members).
  // Wait until one of the two is visible, then click the link if it is the one that is there.
  await page.waitForFunction(() => { const vis = (e) => !!e && e.getClientRects().length > 0; return vis(document.querySelector("#nx-fr2-look")) || Array.from(document.querySelectorAll(".tn-name")).some(vis); }, null, { timeout: 20000 }).catch(() => {});
  const look = page.locator("#nx-fr2-look");
  if (await look.isVisible().catch(() => false)) { await look.click(); await page.evaluate(() => window.__boardKit && window.__boardKit.goScene("tonight")).catch(() => {}); // "Just take a look" now closes the card; the name picker is one tap away in Next steps
  }
  await page.waitForSelector(".tn-name", { state: "visible", timeout: 20000 }).catch(() => {});
  await page.locator(".tn-name", { hasText: NAMES[1] }).first().click({ timeout: 15000 });
  await page.getByRole("button", { name: /Show me what is next/ }).first().click({ timeout: 15000 }).catch(() => {}); // a name is only kept once it is confirmed; "Change my answer" waits for that
  await page.waitForTimeout(800);
  await page.evaluate(() => { location.hash = "signups"; });
  await page.waitForSelector("#panel-signups .jr-who .jr-wn, #panel-signups .jr-who .jr-w0", { state: "visible", timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(700);
  return { ctx, page, errors };
}

const browser = stubbed(await pw.chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}));
try {
  ok("fixture has six made-up members", NAMES.length === 6 && new Set(NAMES).size === 6, NAMES.join(", "));
  for (const [width, height] of [[390, 844], [1366, 768]]) {
    for (const sc of SCENARIOS) {
      const t = `[${sc.id} @${width}x${height}]`; let ctx = null;
      try {
        const opened = await open(browser, width, height, signupsOf(sc.signups)), { page, errors } = opened; ctx = opened.ctx;
        const got = await page.evaluate(() => Array.from(document.querySelectorAll("#panel-signups .jr-who .jr-wg")).map((g) => ({ id: g.dataset.g, label: g.querySelector(".jr-wh").textContent.trim(), names: Array.from(g.querySelectorAll(".jr-wn")).map((n) => n.textContent.trim()), empty: !!g.querySelector(".jr-w0"), shown: g.getClientRects().length > 0 })));
        const all = got.flatMap((g) => g.names);
        ok(`${t} the page is in the guided Sign-ups scene with a roster`, got.length > 0 && got.every((g) => g.shown), JSON.stringify(got.map((g) => g.id)));
        ok(`${t} every member appears exactly once`, all.length === NAMES.length && NAMES.every((n) => all.filter((x) => x === n).length === 1), all.join(" | "));
        for (const [g, names] of Object.entries(sc.want)) {
          const row = got.find((x) => x.id === g);
          ok(`${t} group ${g} holds ${names.length ? names.join(", ") : "nobody"}`, !!row && JSON.stringify([...row.names].sort()) === JSON.stringify([...names].sort()) && row.empty === (names.length === 0), row ? row.names.join(", ") : "group missing");
        }
        ok(`${t} no other group has anybody in it`, got.every((g) => sc.want[g.id] || g.names.length === 0), got.filter((g) => !sc.want[g.id] && g.names.length).map((g) => g.id).join(", "));
        const none = got.find((x) => x.id === "none");
        ok(`${t} "Not answered yet" group is always there`, !!none && none.label === "Not answered yet", none ? none.label : "missing");
        const geo = await page.evaluate(() => {
          const r = (el) => { const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, w: b.width, h: b.height }; };
          const btn = (re) => Array.from(document.querySelectorAll("#panel-signups .jr-core button")).find((b) => re.test(b.textContent));
          const go = btn(/Change my answer/), more = btn(/Show me more/), card = document.querySelector("#panel-signups .jr-core"), body = document.querySelector("#sheet-body"), who = document.querySelector("#panel-signups .jr-who");
          const vh = window.innerHeight, vw = document.documentElement.clientWidth;
          return { vh, vw, sw: document.documentElement.scrollWidth, go: go && r(go), more: more && r(more), goShown: !!go && go.getClientRects().length > 0, moreShown: !!more && more.getClientRects().length > 0, card: card && r(card), body: body && r(body), who: who && r(who) };
        });
        const inView = (b) => b && b.top >= 0 && b.bottom <= geo.vh && b.left >= 0 && b.right <= geo.vw + 0.5;
        ok(`${t} "Change my answer" is in the first viewport`, geo.goShown && inView(geo.go), JSON.stringify(geo.go));
        ok(`${t} "Show me more" is in the first viewport`, geo.moreShown && inView(geo.more), JSON.stringify(geo.more));
        ok(`${t} the roster is in the first viewport`, inView(geo.who), JSON.stringify(geo.who));
        ok(`${t} the card is top-aligned under the header, not centred`, geo.card.top - geo.body.top <= 40, `card ${Math.round(geo.card.top)}, sheet body ${Math.round(geo.body.top)}`);
        ok(`${t} no horizontal scroll`, geo.sw <= geo.vw + 1, `viewport ${geo.vw}, document ${geo.sw}`);
        ok(`${t} no page errors`, errors.length === 0, errors.join(" | "));
        if (sc === SCENARIOS[0]) {
          // the answer flow is unchanged: both buttons still open the folded panel
          await page.locator("#panel-signups").getByRole("button", { name: "Show me more" }).first().click();
          await page.waitForTimeout(400);
          ok(`${t} "Show me more" still opens the panel`, await page.evaluate(() => document.querySelector("#panel-signups").classList.contains("jr-open")));
          await page.locator("#panel-signups").getByRole("button", { name: "Show less" }).first().click();
          await page.waitForTimeout(300);
          await page.locator("#panel-signups").getByRole("button", { name: "Change my answer" }).first().click();
          await page.waitForTimeout(500);
          ok(`${t} "Change my answer" still opens the panel`, await page.evaluate(() => document.querySelector("#panel-signups").classList.contains("jr-open")));
        }
      } catch (e) { ok(`${t} the scenario ran to the end without an exception`, false, String((e && e.message) || e).split("\n")[0]); }
      finally { if (ctx) await ctx.close().catch(() => {}); }
    }
  }
} finally { await browser.close(); }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
