// Live deploy smoke: the ONLY browser suite that talks to the real Worker API of the environment under test (the other suites answer from tests/fixtures/api-snapshot).
//   node deploy-smoke.mjs --url https://pr-N.leeroy-board.pages.dev/   (or env PREVIEW_PAGES)   API origin: env PREVIEW_API, else the ?brain= value of --url
// Proves a preview (or a local stack) is really wired together: GET /api/health, /api/bootstrap and /api/state answer 200 with the expected shape, then ONE page load per
// engine (Chromium, WebKit) renders the first screen with the live API and the Worker answers its calls without a 5xx. About 3 + 2 x 7 = 20 Worker requests in total.
// WebKit is skipped with a WARN when it is not installed locally; set SMOKE_REQUIRE_ENGINES=1 (CI does not need to) to make that a failure. No AI call, nothing is written, no secret is used.
// Exit 0 when every check passes, 1 otherwise.
import { pageUrl } from "../helpers/page-url.mjs";
const pw = await import("playwright").catch(() => { console.error("playwright not found; run npm install in tests/"); process.exit(2); });
const argv = process.argv.slice(2), ui = argv.indexOf("--url");
const BASE = (ui >= 0 && argv[ui + 1]) || process.env.PREVIEW_PAGES;
if (!BASE) { console.error("usage: node deploy-smoke.mjs --url <pages origin> (or set PREVIEW_PAGES)"); process.exit(2); }
const API = (() => { try { return process.env.PREVIEW_API ? new URL(process.env.PREVIEW_API).origin : (new URL(BASE).searchParams.get("brain") ? new URL(new URL(BASE).searchParams.get("brain")).origin : null); } catch (e) { return null; } })();
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${extra ? `: ${extra}` : ""}`); } };
const getJson = async (p) => { const r = await fetch(`${API}${p}`, { headers: { accept: "application/json" } }); let j = null; try { j = await r.json(); } catch (e) {} return { status: r.status, j }; };

if (!API) ok("API origin known (env PREVIEW_API or ?brain= in --url)", false);
else {
  const h = await getJson("/api/health").catch((e) => ({ status: 0, j: null, e }));
  ok("GET /api/health is 200 and ok", h.status === 200 && h.j && h.j.ok === true, `status ${h.status}`);
  const b = await getJson("/api/bootstrap").catch(() => ({ status: 0, j: null }));
  ok("GET /api/bootstrap is 200 with the party, sign-ups and providers", b.status === 200 && b.j && typeof b.j === "object" && "party" in b.j && "signups" in b.j && "providers" in b.j, `status ${b.status}`);
  const s = await getJson("/api/state").catch(() => ({ status: 0, j: null }));
  ok("GET /api/state is 200 with a JSON object", s.status === 200 && s.j && typeof s.j === "object" && !Array.isArray(s.j), `status ${s.status}`);
}

for (const eng of ["chromium", "webkit"]) {
  let browser;
  try { browser = await pw[eng].launch(process.env.CHROMIUM_PATH && eng === "chromium" ? { executablePath: process.env.CHROMIUM_PATH, args: ["--no-sandbox"] } : {}); }
  catch (e) { if (eng === "webkit" && process.env.SMOKE_REQUIRE_ENGINES !== "1") { console.log(`WARN ${eng} is not installed here; its page load is skipped (${String(e.message).split("\n")[0].slice(0, 100)})`); continue; } ok(`${eng} launches`, false, String(e.message).split("\n")[0]); continue; }
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: eng !== "firefox", serviceWorkers: "block" }), page = await ctx.newPage();
  const errors = [], apiRows = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("response", (r) => { const u = new URL(r.url()); if (/^\/api\//.test(u.pathname)) apiRows.push({ path: u.pathname, status: r.status() }); });
  await page.goto(pageUrl(BASE, { params: { preview: "1" } }), { waitUntil: "load" });
  const shown = await page.waitForSelector("#nx-fr2-look", { state: "visible", timeout: 25000 }).then(() => true, () => false);
  await page.waitForTimeout(1500);
  ok(`${eng}: the first screen renders with the live API`, shown);
  ok(`${eng}: the page asked the Worker for /api/bootstrap and got 200`, apiRows.some((r) => r.path === "/api/bootstrap" && r.status === 200), JSON.stringify(apiRows.slice(0, 4)));
  ok(`${eng}: no Worker call answered 5xx`, !apiRows.some((r) => r.status >= 500), JSON.stringify(apiRows.filter((r) => r.status >= 500)));
  ok(`${eng}: no uncaught page error`, errors.length === 0, errors[0] || "");
  await browser.close();
}
console.log(`deploy-smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
