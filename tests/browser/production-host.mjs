// The board served AS https://leeroy.party (Playwright route interception: the files come from --url, the Worker answers as https://api.leeroy.party), so brain.js picks its production base
// and js/board.js reads the five member documents (party, decide, tonight, client, guided-atlas) from the Worker only. Two modes:
//   healthy: the Worker answers every /api/data/<name> with the document PROJECTED for a party in which one member hides all nine lines (public-party.js);
//   down:    the Worker answers 500 to every member document.
// In both: no static member document (data/<name>.json) is fetched, and no hidden value is in the page text or markup. Healthy also shows the board and the scenes that used to print
// "undefined" for a hider (buff wheel, race skills); down shows the one plain line.
//   node tools/static-server.mjs 8123 &   node tests/browser/production-host.mjs --url http://127.0.0.1:8123/        optional: env PW_CHROMIUM
// Fictional data only (the repo's made-up party). Nothing leaves the machine: every other leeroy.party and api.leeroy.party request is answered here.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pageUrl } from "../helpers/page-url.mjs";
import { stubbed } from "../helpers/browser-stub.mjs";
import { projectForAnonymous, projectDecide, projectTonight, projectGuidedAtlas, projectClient } from "../../infrastructure/worker/public-party.js";
const pw = await import("playwright").catch(() => { console.error("playwright not found; run npm install in tests/"); process.exit(2); });
const argv = process.argv.slice(2), arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const BASE = arg("--url") || process.env.PREVIEW_PAGES;
if (!BASE) { console.error("usage: node production-host.mjs --url <pages origin> (or set PREVIEW_PAGES)"); process.exit(2); }
const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = (n) => JSON.parse(fs.readFileSync(path.join(here, "..", "..", "data", `${n}.json`), "utf8"));
const LINE = "This part of the board could not load. Try again in a moment.";
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${extra ? `: ${extra}` : ""}`); } };

// the hider: the first member of the party, who hides all nine lines. Their class must be unique, so any mention of it is a leak.
const party0 = DATA("party"), docs0 = { party: party0, decide: DATA("decide"), tonight: DATA("tonight"), "guided-atlas": DATA("guided-atlas"), client: DATA("client") };
const slug = (n) => n.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const hider = party0.members[0];
ok("fixture: the hider's class is unique in the party", party0.members.filter((m) => m.class_key === hider.class_key).length === 1);
const FIELDS = ["race", "class", "spec_path", "spec_at_40", "professions", "plan_zone", "level", "launch_state", "goals"];
const sheets = party0.members.map((m, i) => ({ slug: slug(m.name), name: m.name, updated: "x", fields: Object.fromEntries(FIELDS.map((f) => [f, { value: "x", visible: i !== 0 }])) }));
const PROJECTED = {
  party: projectForAnonymous(party0, sheets), decide: projectDecide(docs0.decide, party0, sheets), tonight: projectTonight(docs0.tonight, party0, sheets),
  "guided-atlas": projectGuidedAtlas(docs0["guided-atlas"], party0, sheets), client: projectClient(docs0.client, party0, sheets),
};
const classRx = new RegExp(`(?<![a-z0-9])${hider.class.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9])`, "i");
const HIDDEN = [["class", classRx], ["class_key", new RegExp(`"${hider.class_key}"`)], ["board_line", new RegExp(hider.board_line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")], ["color", new RegExp(hider.color.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")]];

const STATIC_RE = /^https:\/\/leeroy\.party\/data\/(party|decide|tonight|guided-atlas|client)\.json(\?|$)/;
const home = new URL(pageUrl(BASE, { params: { preview: "1" } }));
const START = `https://leeroy.party${home.pathname}${home.search}`;
const browser = stubbed(await pw.chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}));
try {
  for (const mode of ["healthy", "down"]) {
    const t = `[leeroy.party, API ${mode}]`;
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, serviceWorkers: "block", reducedMotion: "reduce" });
    const staticReads = [], apiReads = [], errors = [];
    // the site: every file comes from BASE; a static member document is recorded (and would be served, so a read would show up as a leak below)
    await ctx.route("https://leeroy.party/**", async (r) => {
      const u = new URL(r.request().url());
      if (STATIC_RE.test(u.href)) staticReads.push(u.pathname);
      try { await r.fulfill({ response: await r.fetch({ url: new URL(u.pathname + u.search, BASE).href }) }); } catch (e) { r.abort().catch(() => {}); }
    });
    // the Worker
    await ctx.route("https://api.leeroy.party/**", (r) => {
      const u = new URL(r.request().url()), cors = { "access-control-allow-origin": "*", "cache-control": "no-store" };
      const m = /^\/api\/data\/([a-z-]+?)(?:\.json)?$/.exec(u.pathname);
      if (m && PROJECTED[m[1]]) { apiReads.push(m[1]); return mode === "down" ? r.fulfill({ status: 500, contentType: "application/json", headers: cors, body: '{"error":"stub"}' }) : r.fulfill({ status: 200, contentType: "application/json", headers: cors, body: JSON.stringify(PROJECTED[m[1]]) }); }
      return r.fulfill({ status: 503, contentType: "application/json", headers: cors, body: '{"error":"stub"}' }); // bootstrap, state, library, everything else: not part of this test
    });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(START, { waitUntil: "load" });
    await page.waitForTimeout(mode === "down" ? 9000 : 5000); // down: three tries with their waits, then the plain line
    if (mode === "healthy") {
      const look = page.locator("#nx-fr2-look");
      if (await look.isVisible().catch(() => false)) await look.click();
      await page.waitForSelector(".tn-name", { state: "visible", timeout: 15000 }).catch(() => {});
    }
    const ctxOf = (s, rx) => { const m = rx.exec(s); return m ? s.slice(Math.max(0, m.index - 50), m.index + 40).replace(/\s+/g, " ") : "-"; };
    const scan = async (what) => {
      // what a visitor can read: the visible text and the labels (markup carries static decoration such as colour variables and the sample guild, which no member document feeds)
      const text = await page.evaluate(() => [document.body.innerText, ...[...document.querySelectorAll("[aria-label],[title],[alt]")].flatMap((e) => ["aria-label", "title", "alt"].map((a) => e.getAttribute(a) || ""))].join("\n"));
      for (const [field, rx] of HIDDEN) ok(`${t} ${what}: no hidden ${field} in the page text or labels`, !rx.test(text), ctxOf(text, rx));
      return text;
    };
    let text = await scan("the board");
    if (mode === "down") {
      ok(`${t} the plain line is on the page`, text.includes(LINE), text.slice(0, 160));
      ok(`${t} no member of the party is listed`, party0.members.every((m) => !text.includes(m.name)));
    } else {
      ok(`${t} the board is up and lists the hider by name`, text.includes(hider.name));
      for (const hash of ["buffs", "racials", "decide", "tonight"]) {
        await page.evaluate((h) => { location.hash = h; }, hash);
        await page.waitForTimeout(1200);
        text = await scan(`#${hash}`);
        ok(`${t} #${hash}: nothing prints "undefined"`, !/\bundefined\b/.test(text), (/.{30}\bundefined\b.{10}/.exec(text) || [""])[0]);
      }
      ok(`${t} the member documents came from the Worker`, ["party", "decide", "tonight", "client"].every((n) => apiReads.includes(n)), apiReads.join(","));
    }
    ok(`${t} no static member document was fetched`, staticReads.length === 0, staticReads.join(","));
    ok(`${t} the Worker was asked for the member documents`, apiReads.includes("party") && apiReads.includes("client"), apiReads.join(","));
    ok(`${t} no page errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
    await ctx.close();
  }
} finally { await browser.close(); }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
