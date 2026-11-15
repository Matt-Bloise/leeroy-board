// Your own answer on the Sign-ups scene (fix/own-answer-after-launch). Two checks, both on made-up data:
//  A. the seal shelf repaints when /me arrives. The sign-ups come first and /me is held until the shelf is painted; the seal for your own answer is marked ("mine") only after /me answers
//     (before the fix the shelf listened to the sign-ups alone and never marked it on this path).
//  B. a 40-character name with no spaces in a tally row does not widen the page or the tally at 390x844 (scrollWidth <= clientWidth), and an ordinary name keeps one line.
//   node own-answer.mjs --url http://127.0.0.1:8080/   (or env PREVIEW_PAGES)   optional: env PW_CHROMIUM = path to a Chromium binary
// Everything under /api/ is answered by interception (a made-up member key); nothing real is sent and there is no AI call. Exit 0 when every check passes, 1 otherwise.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pageUrl } from "../helpers/page-url.mjs";
import { stubbed } from "../helpers/browser-stub.mjs";
const pw = await import("playwright").catch(() => { console.error("playwright not found; run npm install in tests/"); process.exit(2); });
const argv = process.argv.slice(2), arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const BASE = arg("--url") || process.env.PREVIEW_PAGES;
if (!BASE) { console.error("usage: node own-answer.mjs --url <pages origin> (or set PREVIEW_PAGES)"); process.exit(2); }
const here = path.dirname(fileURLToPath(import.meta.url));
const PARTY = fs.readFileSync(path.join(here, "..", "fixtures", "six-members", "party.json"), "utf8");
const MEMBERS = JSON.parse(PARTY).members;
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${extra ? `: ${extra}` : ""}`); } };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: { "cache-control": "no-store", "access-control-allow-origin": "*" }, body: typeof body === "string" ? body : JSON.stringify(body) });
const DATA_RE = /\/(?:api\/)?data\/(party|signups)(?:\.json)?(?:\?|$)/;
const KEY = "TestKeyTestKeyTestKey123456";
const LONG = "Wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww"; // 40 characters, no spaces
const slugOf = (n) => n.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const [ME, OTHER] = MEMBERS.map((m) => ({ name: m.name, slug: slugOf(m.name) }));
const stamp = new Date(Date.now() - 3600e3).toISOString();

// Everyone answers "in"; the member signed in answers "maybe", so their seal is the one the shelf must mark. One more entry carries the long name.
function signups() {
  const rows = [{ name: ME.name, slug: ME.slug, rsvp: "maybe" }, { name: OTHER.name, slug: OTHER.slug, rsvp: "in" }, { name: LONG, slug: "long-name", rsvp: "in" }];
  const entries = rows.map((r) => ({ name: r.name, slug: r.slug, pack: null, meet: null, rsvp: r.rsvp, when: "8pm", updated: stamp }));
  const names = (k) => rows.filter((r) => r.rsvp === k).map((r) => r.name);
  const tally = (o) => Object.fromEntries(Object.entries(o).map(([k, n]) => [k, { count: n.length, names: n }]));
  return { generated: stamp, present: true, updated: stamp, options: { meet: ["Valley of Strength", "The Crossroads"], when: ["6pm", "8pm", "later"] }, entries,
    tallies: { pack: { yes: { count: 0, names: [] }, no: { count: 0, names: [] } }, meet: { "Valley of Strength": { count: 0, names: [] }, "The Crossroads": { count: 0, names: [] }, other: { count: 0, names: [], places: [] } },
      rsvp: tally({ in: names("in"), maybe: names("maybe"), late: [], out: [] }), when: tally({ "6pm": [], "8pm": rows.map((r) => r.name), later: [] }) } };
}

async function open(browser, width, height, meDelayMs) {
  const phone = width < 768;
  const ctx = await browser.newContext({ viewport: { width, height }, hasTouch: phone, isMobile: phone, serviceWorkers: "block", reducedMotion: "reduce" });
  await ctx.addInitScript(([key, slug]) => { try { localStorage.setItem("board-journey", "everything"); localStorage.setItem("board-walked", "1"); localStorage.setItem("board-me", slug); localStorage.setItem("board-key", key); } catch (e) {} }, [KEY, ME.slug]);
  const doc = signups(), meAt = { t: 0 }; let release; const gate = new Promise((r) => { release = r; }); // /me waits for release() when meDelayMs is -1, else for that many ms
  meAt.release = release;
  await ctx.route("**/api/**", async (route) => {
    const u = new URL(route.request().url()), m = route.request().method();
    if (m === "GET" && u.pathname.endsWith("/api/me")) { await (meDelayMs < 0 ? gate : new Promise((r) => setTimeout(r, meDelayMs))); meAt.t = Date.now(); return json(route, { slug: ME.slug, name: ME.name }); }
    if (m === "GET" && u.pathname.endsWith("/api/state")) return json(route, { type: "state", ver: 1, at: stamp, party: [], signups: doc });
    return route.abort();
  });
  await ctx.route(DATA_RE, (route) => json(route, DATA_RE.exec(route.request().url())[1] === "party" ? PARTY : doc));
  const page = await ctx.newPage(), errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(pageUrl(BASE, { params: { preview: "1" }, defaults: { brain: "local" }, hash: "signups" }), { waitUntil: "load" });
  return { ctx, page, errors, meAt };
}

const browser = stubbed(await pw.chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}));
try {
  { // A: the shelf repaints when /me arrives
    const t = "[shelf, /me held back @390x844]", { ctx, page, errors, meAt } = await open(browser, 390, 844, -1);
    try {
      await page.waitForSelector("#su-shelf .sh-seal", { state: "attached", timeout: 20000 });
      const early = await page.evaluate(() => ({ seals: document.querySelectorAll("#su-shelf .sh-seal").length, mine: document.querySelectorAll("#su-shelf .sh-seal.mine").length, me: !!(window.BoardBrain && window.BoardBrain.status().key) }));
      ok(`${t} the shelf is painted from the sign-ups before /me has answered`, early.seals >= 4 && early.mine === 0 && meAt.t === 0, JSON.stringify({ ...early, meAnswered: meAt.t !== 0 }));
      meAt.release();
      await page.waitForFunction(() => document.querySelector("#su-shelf .sh-seal.mine"), null, { timeout: 15000 }).catch(() => {});
      const late = await page.evaluate(() => { const m = document.querySelector("#su-shelf .sh-seal.mine"); return m ? { k: m.getAttribute("data-k"), label: m.getAttribute("aria-label") } : null; });
      ok(`${t} after /me answers, the shelf marks the seal of your own answer`, !!late && late.k === "maybe" && /your answer/.test(late.label), JSON.stringify(late));
      ok(`${t} no page errors`, errors.length === 0, errors.join(" | "));
    } catch (e) { ok(`${t} ran to the end without an exception`, false, String((e && e.message) || e).split("\n")[0]); }
    finally { await ctx.close().catch(() => {}); }
  }
  for (const [width, height] of [[390, 844], [360, 640]]) { // B: a long unbroken name
    const t = `[long name @${width}x${height}]`, { ctx, page, errors } = await open(browser, width, height, 0);
    try {
      await page.waitForSelector("#dsu-body .trow-who .who", { state: "attached", timeout: 20000 });
      await page.waitForTimeout(800);
      const g = await page.evaluate((long) => {
        const de = document.documentElement, body = document.querySelector("#dsu-body"), who = [...document.querySelectorAll("#dsu-body .trow-who .who")];
        const name = (n) => n.textContent.trim(), longEl = who.find((n) => name(n).includes(long)), plain = who.find((n) => !name(n).includes(long));
        const lines = (n) => { const r = n.getBoundingClientRect(), lh = parseFloat(getComputedStyle(n).lineHeight) || parseFloat(getComputedStyle(n).fontSize) * 1.2; return Math.round(r.height / lh); };
        return { docW: de.scrollWidth, vw: de.clientWidth, bodyScroll: body.scrollWidth, bodyClient: body.clientWidth, longRight: longEl ? longEl.getBoundingClientRect().right : null, bodyRight: body.getBoundingClientRect().right,
          longShown: !!longEl && longEl.getClientRects().length > 0, plainLines: plain ? lines(plain) : null, plainText: plain ? name(plain) : null };
      }, LONG);
      ok(`${t} the tally with the 40-character name is on the page`, g.longShown, JSON.stringify(g));
      ok(`${t} #dsu-body scrollWidth <= clientWidth`, g.bodyScroll <= g.bodyClient, `${g.bodyScroll} > ${g.bodyClient}`);
      ok(`${t} the page does not scroll sideways`, g.docW <= g.vw + 1, `document ${g.docW}, viewport ${g.vw}`);
      ok(`${t} the long name ends inside the tally`, g.longRight !== null && g.longRight <= g.bodyRight + 1, `${g.longRight} > ${g.bodyRight}`);
      ok(`${t} an ordinary name keeps one line`, g.plainLines === 1, `${g.plainText}: ${g.plainLines} lines`);
      ok(`${t} no page errors`, errors.length === 0, errors.join(" | "));
    } catch (e) { ok(`${t} ran to the end without an exception`, false, String((e && e.message) || e).split("\n")[0]); }
    finally { await ctx.close().catch(() => {}); }
  }
} finally { await browser.close(); }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
