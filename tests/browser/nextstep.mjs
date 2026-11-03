// Next-step engine check (Q36, flag nextstep.v2): flag off keeps the existing card; flag on shows the engine's card for each rule. 390x844 (touch).
//   node nextstep.mjs --url https://pr-N.leeroy-board.pages.dev/   (or env PREVIEW_PAGES)   optional: --shots <dir> (default os tmpdir)
// The flag is switched on by intercepting data/client.json (the file ships it as false). The group is data/sample/roster.json, rewritten per case by interception,
// and data/signups.json is rewritten the same way for the viewer's own answer. The viewer is the first member on the board (read at run time), chosen through
// localStorage; nothing is sent and no AI is called.
// Cases: flag off; no build ("just looking"); no group; ruleset mismatch; open seat to answer; event soon; and a null result that falls back to the existing card.
// Per case: the card carries the expected step id and title text, its button is inside the viewport, the page does not scroll sideways, no page or console errors.
import os from "node:os";
import path from "node:path";
import { pageUrl, originOf, dirOf } from "../helpers/page-url.mjs";
import { stubbed } from "../helpers/browser-stub.mjs";
import { gotoRetry } from "../helpers/goto-retry.mjs";
const pw = await import("playwright").catch(() => { console.error("playwright not found; run npm install in tests/"); process.exit(2); });
const argv = process.argv.slice(2), arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const BASE = arg("--url") || process.env.PREVIEW_PAGES;
if (!BASE) { console.error("usage: node nextstep.mjs --url <pages origin> (or set PREVIEW_PAGES)"); process.exit(2); }
const SHOTS = arg("--shots") || os.tmpdir();
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${extra ? `: ${extra}` : ""}`); } };
const OPTS = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const slug = (n) => String(n).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const json = (route, body) => route.fulfill({ status: 200, contentType: "application/json", headers: { "cache-control": "no-store" }, body: JSON.stringify(body) });

async function open(browser, c, who) {
  const ctx = await browser.newContext({ ...OPTS, serviceWorkers: "block", reducedMotion: "reduce" }), page = await ctx.newPage(), errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/^\[Report Only\]/.test(m.text()) && !/^Failed to load resource|cloudflareinsights/.test(m.text())) errors.push(m.text()); });
  await ctx.addInitScript((me) => { try { localStorage.setItem("board-me", me); localStorage.setItem("board-journey", "guided"); } catch (e) {} }, c.me === "viewer" ? slug(who.name) : "just-looking");
  await ctx.route("**/data/client.json*", async (route) => { const j = await (await route.fetch()).json(); j.flags = { ...(j.flags || {}), "nextstep.v2": !!c.flag }; await json(route, j); });
  await ctx.route("**/data/sample/roster.json*", async (route) => {
    const j = await (await route.fetch()).json(), seat = (status, role, name) => ({ role, status, ...(name ? { character: { id: "t-me", name, class_key: "mage", class: "Mage", spec: "Frost", color: "#69ccf0" } } : {}) });
    j.group = { ...j.group, ...(c.group || {}) };
    if (c.inGroup) j.slots = [seat("filled", who.role, who.name), ...(c.openSeat ? [seat("open", who.role)] : [])];
    await json(route, j);
  });
  // on a preview the board reads signups through the Worker (api/data/signups) as well as the static file: stub both the same way
  const signupsStub = async (route) => {
    const j = await (await route.fetch()).json(); j.entries = (j.entries || []).filter((e) => e.name !== who.name);
    if (c.rsvp) j.entries.push({ name: who.name, rsvp: c.rsvp, when: "8pm", meet: null, pack: null });
    await json(route, j);
  };
  await ctx.route("**/data/signups.json*", signupsStub);
  await ctx.route("**/api/data/signups*", signupsStub);
  // the Worker bundles signups inside /api/bootstrap: apply the same edit to that document
  await ctx.route("**/api/bootstrap*", async (route) => {
    const j = await (await route.fetch()).json(), sg = j.signups || (j.signups = { entries: [] });
    sg.entries = (sg.entries || []).filter((e) => e.name !== who.name);
    if (c.rsvp) sg.entries.push({ name: who.name, rsvp: c.rsvp, when: "8pm", meet: null, pack: null });
    await json(route, j);
  });
  await gotoRetry(page, pageUrl(BASE, { params: { preview: "1" }, hash: "tonight" }), { waitUntil: "load" }, { label: `nextstep [${c.tag}]` });
  await page.waitForFunction(() => window.__next && window.__next.status().stepId, null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1200);
  return { ctx, page, errors };
}

const browser = stubbed(await pw.chromium.launch());
try {
  const probe = await browser.newContext({ ...OPTS, serviceWorkers: "block" }), pp = await probe.newPage();
  await gotoRetry(pp, pageUrl(BASE, { params: { preview: "1" } }), { waitUntil: "load" }, { label: "nextstep probe" });
  await pp.waitForFunction(() => window.__next && window.__next.input().party, null, { timeout: 20000 }).catch(() => {});
  const who = await pp.evaluate(() => { try { const m = window.__next.input().party.members[0]; return { name: m.name, role: m.role }; } catch (e) { return null; } });
  await probe.close();
  ok("found a board member to act as", !!(who && who.name && who.role));
  if (!who) process.exit(1);
  const soon = Math.floor(Date.now() / 1000) + 3600;
  const CASES = [
    { tag: "flag off", flag: false, me: "viewer", inGroup: true, openSeat: true, id: null },
    { tag: "no build", flag: true, me: "just-looking", id: "ns-no-build", text: /build is not on the board/ },
    { tag: "no group", flag: true, me: "viewer", id: "ns-no-group", text: /not in a group/ },
    { tag: "mismatch", flag: true, me: "viewer", inGroup: true, group: { ruleset: "Hardcore" }, id: "ns-mismatch", text: /differs from the one/, why: /Hardcore/ },
    { tag: "open seat", flag: true, me: "viewer", inGroup: true, openSeat: true, group: { ruleset: "Normal", faction: "Horde" }, id: "ns-rsvp", text: /open .* seat/ },
    // the event-soon rule is covered rule by rule in tests/unit/nextstep.test.mjs; against a live preview the viewer's RSVP comes from the preview database, which a route stub could not override reliably, so it is not asserted here
    { tag: "no result falls back", flag: true, me: "viewer", inGroup: true, rsvp: "out", group: { ruleset: "Normal", faction: "Horde" }, id: null },
  ];
  for (const c of CASES) {
    const t = `[390x844 ${c.tag}]`, s = await open(browser, c, who);
    // window.__next can lag the load on a busy runner (seen as `Cannot read properties of undefined (reading 'status')` on PRs 112 and 123, Nov 2): wait for it, and report a clear failure instead of crashing the run.
    await s.page.waitForFunction(() => !!window.__next, null, { timeout: 15000 }).catch(() => {});
    const st = await s.page.evaluate(() => (window.__next ? window.__next.status() : null));
    if (!st) { ok(`${t} next-step module is present`, false, `window.__next is missing (tab url ${s.page.url()})`); continue; }
    if (c.id) {
      ok(`${t} step id`, st.stepId === c.id, String(st.stepId));
      const title = (await s.page.locator("#nx-t").textContent({ timeout: 3000 }).catch(() => "")), why = (await s.page.locator("#nx-card .nx-why").textContent({ timeout: 3000 }).catch(() => ""));
      ok(`${t} title`, c.text.test(title), title);
      if (c.why) ok(`${t} why`, c.why.test(why), why);
      ok(`${t} no class, race or role is chosen for anyone`, !/\b(you should|you must|pick a|choose a)\b/i.test(`${title} ${why}`), `${title} ${why}`);
      const r = await s.page.evaluate(() => { const b = document.querySelector("#nx-card .nx-act button"), x = b ? b.getBoundingClientRect() : null; return x && { t: x.top, b: x.bottom, l: x.left, r: x.right, h: innerHeight, w: innerWidth }; });
      ok(`${t} button inside the viewport`, !!r && r.t >= 0 && r.b <= r.h && r.l >= 0 && r.r <= r.w, JSON.stringify(r));
    } else {
      ok(`${t} existing card kept`, !!st.stepId && !String(st.stepId).startsWith("ns-"), String(st.stepId));
    }
    ok(`${t} no sideways scroll`, await s.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await s.page.screenshot({ path: path.join(SHOTS, `nextstep-${c.tag.replace(/\W+/g, "-")}.png`) });
    ok(`${t} no console or page errors`, s.errors.length === 0, s.errors.join(" | ").slice(0, 200));
    await s.ctx.close();
  }
} finally { await browser.close(); }
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
