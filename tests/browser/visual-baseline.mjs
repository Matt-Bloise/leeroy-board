// Visual baselines (Q62), NON-GATING: always exits 0. Screenshots the first screen, the sample guild sheet and the landing page at 390x844 and 1366x768
// and compares each with a committed PNG in tests/browser/baselines/<screen>-<size>.png using a small pixel diff (decoded in the browser, no dependency).
//   node visual-baseline.mjs --url https://pr-13.leeroy-board.pages.dev/   (or env PREVIEW_PAGES)
//   --write-baselines [dir]   write the screenshots as baselines into dir (default tests/browser/baselines) and compare nothing; used by the visual-baselines workflow
// A missing baseline prints SKIP (no comparison). A diff ratio above WARN_RATIO prints WARN. Neither fails the run. Output: tests/browser/out/visual-baseline/
// (actual/*.png, summary.json, summary.md). Animated regions (candle glow, canvases, clock/countdown, moon) are masked and CSS animations are disabled.
// Baselines must come from the Linux CI image (see docs/runbooks/visual-baselines.md); local Windows or macOS font rendering will differ.
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2), arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const finish = (code = 0) => process.exit(code); // never gate: crashes below also exit 0
process.on("uncaughtException", (e) => { console.log(`WARN visual-baseline crashed: ${e && e.message}`); finish(0); });
const pw = await import("playwright").catch(() => null);
if (!pw) { console.log("WARN playwright not found; run npm ci in tests/. visual-baseline skipped."); finish(0); }
const BASE = arg("--url") || process.env.PREVIEW_PAGES;
if (!BASE) { console.log("WARN no --url or PREVIEW_PAGES; visual-baseline skipped."); finish(0); }
const wi = argv.indexOf("--write-baselines");
const WRITE = wi >= 0 ? path.resolve(argv[wi + 1] && !argv[wi + 1].startsWith("--") ? argv[wi + 1] : path.join(here, "baselines")) : null;
const BASELINES = path.join(here, "baselines"), OUT = path.join(here, "out", "visual-baseline"), ACTUAL = path.join(OUT, "actual");
mkdirSync(ACTUAL, { recursive: true }); if (WRITE) mkdirSync(WRITE, { recursive: true });
const WARN_RATIO = 0.01, PIXEL_TOLERANCE = 32; // a pixel differs when any channel differs by more than 32 of 255
const ROOT = BASE.endsWith("/") ? BASE : BASE + "/";
const SIZES = [["390x844", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }], ["1366x768", { viewport: { width: 1366, height: 768 } }]];
const MASK = [".candle", "canvas", "#clock", "#mini-clock", ".clock-digits", "[class*=moon]", "[id*=moon]", "[class*=countdown]", "[id*=countdown]"];
const FREEZE = "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}";

const SCREENS = {
  async first(page) {
    await page.goto(`${ROOT}?preview=1`, { waitUntil: "load" });
    await page.waitForSelector("#nx-fr2-go", { state: "visible", timeout: 20000 });
  },
  async sample(page) {
    await page.goto(ROOT, { waitUntil: "load" });
    await page.evaluate(() => { const b = document.getElementById("board"); if (b && b.hidden && window.__board) window.__board.start("preview"); });
    await page.waitForFunction(() => window.__boardKit && window.__boardKit.D && window.__boardKit.D.party, null, { timeout: 20000 });
    await page.evaluate(() => window.__boardKit.goScene("five"));
    await page.waitForSelector("#ps-sample", { state: "visible", timeout: 15000 });
  },
  async landing(page) {
    await page.goto(new URL("landing/", ROOT).href, { waitUntil: "load" });
    await page.waitForSelector("h1", { timeout: 15000 });
  },
};

// Compares two PNG buffers inside a blank page (canvas decode). Returns { w, h, diff, ratio } or { sizeMismatch }.
async function compare(helper, a, b) {
  return helper.evaluate(async ([x, y, tol]) => {
    const load = (b64) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = "data:image/png;base64," + b64; });
    const [ia, ib] = await Promise.all([load(x), load(y)]);
    if (ia.width !== ib.width || ia.height !== ib.height) return { sizeMismatch: `${ia.width}x${ia.height} vs ${ib.width}x${ib.height}` };
    const px = (img) => { const c = document.createElement("canvas"); c.width = img.width; c.height = img.height; const g = c.getContext("2d"); g.drawImage(img, 0, 0); return g.getImageData(0, 0, img.width, img.height).data; };
    const da = px(ia), db = px(ib); let diff = 0;
    for (let i = 0; i < da.length; i += 4) if (Math.abs(da[i] - db[i]) > tol || Math.abs(da[i + 1] - db[i + 1]) > tol || Math.abs(da[i + 2] - db[i + 2]) > tol) diff++;
    return { w: ia.width, h: ia.height, diff, ratio: diff / (ia.width * ia.height) };
  }, [a.toString("base64"), b.toString("base64"), PIXEL_TOLERANCE]);
}

const rows = [];
const browser = await pw.chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ["--no-sandbox"] } : {});
try {
  const helper = await (await browser.newContext()).newPage(); await helper.setContent("<!doctype html><title>diff</title>");
  for (const [size, opts] of SIZES) for (const [name, go] of Object.entries(SCREENS)) {
    const id = `${name}-${size}`, row = { id, status: "", ratio: null };
    rows.push(row);
    const ctx = await browser.newContext({ ...opts, serviceWorkers: "block", reducedMotion: "reduce", colorScheme: "light" });
    try {
      const page = await ctx.newPage();
      await go(page);
      await page.addStyleTag({ content: FREEZE });
      await page.waitForTimeout(600);
      const png = await page.screenshot({ animations: "disabled", mask: MASK.map((s) => page.locator(s)), maskColor: "#ff00ff" });
      writeFileSync(path.join(ACTUAL, `${id}.png`), png);
      if (WRITE) { writeFileSync(path.join(WRITE, `${id}.png`), png); row.status = "WROTE"; console.log(`WROTE ${id}`); continue; }
      const bp = path.join(BASELINES, `${id}.png`);
      if (!existsSync(bp)) { row.status = "SKIP"; console.log(`SKIP ${id}: no baseline at tests/browser/baselines/${id}.png (generate with the visual-baselines workflow, see docs/runbooks/visual-baselines.md)`); continue; }
      const r = await compare(helper, readFileSync(bp), png);
      if (r.sizeMismatch) { row.status = "WARN"; row.ratio = 1; console.log(`WARN ${id}: size differs (${r.sizeMismatch})`); continue; }
      row.ratio = r.ratio; row.status = r.ratio > WARN_RATIO ? "WARN" : "OK";
      console.log(`${row.status === "OK" ? "PASS" : "WARN"} ${id}: diff ratio ${(r.ratio * 100).toFixed(3)}% (${r.diff} of ${r.w * r.h} px, limit ${WARN_RATIO * 100}%)`);
    } catch (e) { row.status = "ERROR"; console.log(`WARN ${id}: could not capture: ${String(e.message).split("\n")[0]}`); }
    finally { await ctx.close(); }
  }
} finally { await browser.close(); }

const compared = rows.filter((r) => r.ratio !== null), max = compared.reduce((m, r) => Math.max(m, r.ratio), 0);
const summary = { mode: WRITE ? "write-baselines" : "compare", warnRatio: WARN_RATIO, pixelTolerance: PIXEL_TOLERANCE, maxDiffRatio: compared.length ? max : null, screens: rows };
writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
writeFileSync(path.join(OUT, "summary.md"), ["| Screen | Status | Diff ratio |", "| :--- | :--- | ---: |", ...rows.map((r) => `| ${r.id} | ${r.status} | ${r.ratio === null ? "-" : (r.ratio * 100).toFixed(3) + "%"} |`), ""].join("\n"));
console.log(`visual-baseline: ${WRITE ? "wrote " + rows.filter((r) => r.status === "WROTE").length + " baselines" : `compared ${compared.length} of ${rows.length}, max diff ratio ${compared.length ? (max * 100).toFixed(3) + "%" : "n/a"}`} (non-gating)`);
finish(0);
