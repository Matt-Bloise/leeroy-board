// Records tests/fixtures/api-snapshot/snapshot.json: every GET the board makes to its API while a visitor opens each scene, from a LOCAL Worker with the seeded D1.
//   tools/local-browser.sh record-fixtures        (starts the local stack, runs this, prints the size)
//   node record-api-snapshot.mjs --url "http://127.0.0.1:8080/?brain=http://127.0.0.1:8787"   (stack already running)
// Never run it against a preview or production: it refuses any URL that is not 127.0.0.1 / localhost. Nothing secret is recorded: only public GETs without an
// Authorization header (the Worker's seeded demo data), and per-request values (timestamps) are kept as they were.
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pageUrl } from "./page-url.mjs";
import { SNAPSHOT_PATH, repoDoc } from "./api-stub.mjs";
const pw = await import("playwright").catch(() => { console.error("playwright not found; run npm ci in tests/"); process.exit(2); });
const argv = process.argv.slice(2), arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const BASE = arg("--url") || process.env.PREVIEW_PAGES;
if (!BASE || !/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(BASE)) { console.error("record-api-snapshot: --url must be a local page (127.0.0.1 or localhost); it will not record from a preview or production"); process.exit(2); }
const SCENES = ["timeline", "five", "roads", "racials", "legacy", "buffs", "ledger", "signups", "librarian", "library", "tonight", "decide"];
const routes = {};
const browser = await pw.chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ["--no-sandbox"] } : {});
for (const state of ["gate", "looking", "member"]) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, serviceWorkers: "block", reducedMotion: "reduce" }), page = await ctx.newPage();
  page.on("response", async (r) => {
    const u = new URL(r.url());
    if (!/^\/api\//.test(u.pathname) || r.request().method() !== "GET") return;
    if (r.request().headers()["authorization"]) return;
    const key = u.pathname.replace(/^\/api/, "");
    if (routes[key] || r.status() >= 300) return;
    if (repoDoc(key)) { const t = await r.text(); try { if (JSON.stringify(JSON.parse(t)) !== JSON.stringify(JSON.parse(repoDoc(key).body))) console.log(`WARN ${key} differs from the repo file; the stub will serve the repo file`); } catch (e) {} return; }
    try { routes[key] = { status: r.status(), type: r.headers()["content-type"] || "application/json", ...(r.headers()["etag"] ? { etag: r.headers()["etag"] } : {}), body: await r.text() }; } catch (e) {}
  });
  await page.goto(pageUrl(BASE, { params: { preview: "1" } }), { waitUntil: "load" });
  await page.waitForSelector("#nx-fr2-look", { state: "visible", timeout: 20000 });
  await page.waitForTimeout(800);
  if (state !== "gate") await page.getByText("Just take a look", { exact: false }).first().click({ timeout: 8000 });
  if (state === "member") { await page.getByRole("button", { name: /Bloise/ }).first().click({ timeout: 8000 }); await page.getByRole("button", { name: /Show me what is next/ }).first().click({ timeout: 8000 }); }
  if (state !== "gate") for (const sc of SCENES) { await page.evaluate((h) => { location.hash = h; }, sc); await page.waitForTimeout(900); }
  await page.waitForTimeout(1500);
  await ctx.close();
}
await browser.close();
const keys = Object.keys(routes).sort(), sorted = Object.fromEntries(keys.map((k) => [k, routes[k]]));
const snapshot = { about: "Recorded GET responses of the board API from a local Worker (wrangler dev --local) with the seeded D1. Used by tests/helpers/api-stub.mjs. Re-record with tools/local-browser.sh record-fixtures.", routes: sorted };
mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
const text = JSON.stringify(snapshot, null, 1) + "\n";
writeFileSync(SNAPSHOT_PATH, text);
console.log(`recorded ${keys.length} routes, ${(text.length / 1024).toFixed(1)} KiB -> ${path.relative(process.cwd(), SNAPSHOT_PATH)}`);
for (const k of keys) console.log(`  ${String(sorted[k].body.length).padStart(8)}  ${k}`);
