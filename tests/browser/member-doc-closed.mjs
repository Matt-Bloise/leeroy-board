// F3 (option b): when the API answers a non-OK status for party, decide, tonight, client or guided-atlas, the board does NOT read the static data/<name>.json in its place
// (those files are the whole party, hidden fields included). It shows the one plain line instead. Fictional: nothing here is a real member; the API is a local port that answers 500.
//   node tools/static-server.mjs 8123 &   node tests/browser/member-doc-closed.mjs --url http://127.0.0.1:8123/        optional: env PW_CHROMIUM
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pageUrl } from "../helpers/page-url.mjs";
import { stubbed } from "../helpers/browser-stub.mjs";
const pw = await import("playwright").catch(() => { console.error("playwright not found; run npm install in tests/"); process.exit(2); });
const argv = process.argv.slice(2), arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const BASE = arg("--url") || process.env.PREVIEW_PAGES;
if (!BASE) { console.error("usage: node member-doc-closed.mjs --url <pages origin>"); process.exit(2); }
const here = path.dirname(fileURLToPath(import.meta.url));
const party = JSON.parse(fs.readFileSync(path.join(here, "..", "..", "data", "party.json"), "utf8"));
const LINE = "This part of the board could not load. Try again in a moment.";
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${extra ? `: ${extra}` : ""}`); } };

const browser = stubbed(await pw.chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}));
try {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, serviceWorkers: "block", reducedMotion: "reduce" });
  const api = [], staticReads = [];
  await ctx.route("http://127.0.0.1:9/**", (r) => { api.push(new URL(r.request().url()).pathname); return r.fulfill({ status: 500, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: "{\"error\":\"down\"}" }); });
  await ctx.route(/\/data\/(party|decide|tonight|client|guided-atlas)\.json(\?|$)/, (r) => { staticReads.push(new URL(r.request().url()).pathname); return r.continue(); });
  const page = await ctx.newPage();
  await page.goto(pageUrl(BASE, { params: { preview: "1", brain: "http://127.0.0.1:9" } }), { waitUntil: "load" });
  await page.waitForTimeout(9000); // three tries with their waits, then the plain line
  const text = await page.evaluate(() => document.body.innerText);
  const html = await page.content();
  ok("the API was asked for the party document", api.some((p) => /\/api\/data\/party$/.test(p)), api.join(","));
  ok("the static data/party.json was never fetched", !staticReads.some((p) => /party\.json$/.test(p)), staticReads.join(","));
  ok("none of the five member documents was read from its static file", staticReads.length === 0, staticReads.join(","));
  ok("the plain line is on the page", text.includes(LINE), `the page text has ${text.length} characters and not the line`);
  ok("no member of the static party.json is shown", party.members.every((m) => !html.includes(`>${m.name}<`)), `${party.members.length} members checked, none shown`);
  await ctx.close();
} finally { await browser.close(); }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
