// Renders Leeroy's picture cards to PNG with one pinned Chromium, and checks them. docs/runbooks/card-images.md.
//
//   node tools/cards/render.mjs --write   render every card (tools/cards/sources.mjs); write each PNG whose decoded pixels changed under cards/,
//                                         delete the PNGs no card uses, rewrite infrastructure/worker/card-manifest.json
//   node tools/cards/render.mjs --check   render every card; fail unless every one decodes to exactly the pixels of its committed PNG and of the
//                                         manifest, and the manifest matches the repository's data. The CI gate (.github/workflows/cards.yml,
//                                         two clean runners).
//   --only <prefix>   only cards whose key starts with it (page:, tooltip:fireball, map:). --check never passes on a partial set.
//   --out <dir>       also write every render there as PNG (CI uploads it when the check fails)
//   --twice           render every card again in a second, new browser and fail unless the pixels are identical
//
// Determinism: the browser pinned exactly (tools/cards/chromium.json: Chrome for Testing headless shell, version and SHA-256, installed by
// install-chromium.mjs; the run fails if the browser reports another version) and driven by an exactly pinned playwright-core
// (tools/cards/package.json); Skia's baseline CPU code (no SIMD path
// picked at run time), sRGB, no LCD text, no hinting, no GPU; device scale 2; UTC, en-US and a fixed clock; every request answered from this
// repository and anything else refused (a refused request fails the run); the board's WOFF2 fonts only, and DevTools must report that every
// glyph on the card came from one of them; pixels compared after decoding, never as PNG bytes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { cardJobs, ROOT } from "./sources.mjs";
import { decodePng, encodePng, pixelHash, pixelDiff } from "./png.mjs";
import { uncoveredChars } from "./fonts.mjs";
import { modelHash } from "../../infrastructure/worker/card-models.js";
import { PIN as BROWSER_PIN, EXECUTABLE, installed as browserInstalled } from "./install-chromium.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MANIFEST_PATH = "infrastructure/worker/card-manifest.json";
export const CARDS_DIR = "cards";
export const SCALE = 2;
export const FIXED_TIME = "2026-01-01T00:00:00Z";
export const WIDTH = { page: 400, tooltip: 400, signup: 400, map: 800 };
export const FONT_FILES = ["alegreya-latin.woff2", "alegreya-italic-latin.woff2", "alegreya-sans-sc-500-latin.woff2", "alegreya-sans-sc-700-latin.woff2", "grenze-gotisch-latin.woff2"];
export const TEMPLATE_FILES = ["card.html", "card.css", "card.js"];
// Everything else that decides what a card looks like. A change to any of them changes inputsHash(), so the unit test fails until a FULL
// --write has redrawn every card with it (a partial --write refuses); the CI pixel check then proves the committed pixels.
export const DRAWING_FILES = ["tools/cards/sources.mjs", "tools/cards/render.mjs", "tools/cards/png.mjs", "tools/cards/fonts.mjs", "tools/cards/chromium.json", "tools/cards/package-lock.json", "infrastructure/worker/card-models.js"];
export const CHROMIUM_ARGS = [
  "--disable-skia-runtime-opts", // Skia's baseline code path on every CPU (no AVX2 / AVX-512 variants chosen at run time)
  "--force-color-profile=srgb",
  "--font-render-hinting=none",
  "--disable-lcd-text",
  "--disable-gpu",
  "--disable-partial-raster",
  "--disable-threaded-animation",
  "--disable-threaded-scrolling",
  "--disable-checker-imaging",
  "--hide-scrollbars",
  "--mute-audio",
];
const ORIGIN = "https://cards.invalid";
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

function args(argv) {
  const a = { write: argv.includes("--write"), check: argv.includes("--check"), twice: argv.includes("--twice"), only: "", out: "" };
  const at = (k) => { const i = argv.indexOf(k); return i >= 0 ? String(argv[i + 1] || "") : ""; };
  a.only = at("--only");
  a.out = at("--out");
  if (a.write === a.check) throw new Error("say --write or --check (exactly one)");
  return a;
}

// The pinned browser driver, installed by `npm ci` in tools/cards. It launches the pinned browser by path, never a browser it finds itself.
export function pinnedPlaywright() {
  const req = createRequire(path.join(HERE, "package.json"));
  const want = JSON.parse(fs.readFileSync(path.join(HERE, "package.json"), "utf8")).dependencies["playwright-core"];
  let pkg;
  try { pkg = req("playwright-core/package.json"); } catch { throw new Error("playwright-core is not installed: run `npm ci` in tools/cards"); }
  if (pkg.version !== want) throw new Error(`playwright-core ${pkg.version} is installed, tools/cards/package.json pins ${want}: run \`npm ci\` in tools/cards`);
  return { version: pkg.version, chromium: req("playwright-core").chromium };
}

// Chromium will not load web fonts at all unless fontconfig knows at least one font file (measured: every face reports "error").
// So fontconfig gets a private directory holding ONE system font and nothing else. Which one does not matter: no card may draw a glyph
// with it, and the DevTools check below fails the card if one does.
function privateFontconfig() {
  const candidates = ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf", "/usr/share/fonts/truetype/freefont/FreeSans.ttf", "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf"];
  let file = candidates.find((f) => fs.existsSync(f));
  if (!file) {
    try { file = execFileSync("fc-match", ["-f", "%{file}", "sans-serif"], { encoding: "utf8" }).trim(); } catch { file = ""; }
  }
  if (!file || !/\.(ttf|otf)$/i.test(file) || !fs.existsSync(file)) throw new Error("no TrueType or OpenType system font found for fontconfig (install fonts-dejavu-core)");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leeroy-cards-fc-"));
  fs.mkdirSync(path.join(dir, "fonts"));
  fs.mkdirSync(path.join(dir, "cache"));
  fs.symlinkSync(file, path.join(dir, "fonts", path.basename(file)));
  const conf = path.join(dir, "fonts.conf");
  fs.writeFileSync(conf, `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig>\n  <dir>${path.join(dir, "fonts")}</dir>\n  <cachedir>${path.join(dir, "cache")}</cachedir>\n</fontconfig>\n`);
  return { conf, dir, fallback: path.basename(file) };
}

function serveFile(rel) {
  if (TEMPLATE_FILES.includes(rel)) return { body: fs.readFileSync(path.join(HERE, rel)), type: rel.endsWith(".html") ? "text/html; charset=utf-8" : rel.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8" };
  const m = /^fonts\/([a-z0-9-]+\.woff2)$/.exec(rel);
  if (m && FONT_FILES.includes(m[1])) return { body: fs.readFileSync(path.join(ROOT, "fonts", m[1])), type: "font/woff2" };
  return null;
}

// Every platform font DevTools says was used for the text of any node on the page. All must be web fonts from fonts/ (isCustomFont).
async function fontsUsed(cdp) {
  const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
  const used = new Map();
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    if (n.nodeType === 1) {
      const r = await cdp.send("CSS.getPlatformFontsForNode", { nodeId: n.nodeId });
      for (const f of r.fonts || []) {
        const k = `${f.familyName}${f.isCustomFont ? "" : " (SYSTEM)"}`;
        used.set(k, (used.get(k) || 0) + f.glyphCount);
      }
    }
    for (const c of n.children || []) stack.push(c);
  }
  return used;
}

export async function openRenderer() {
  const { version, chromium } = pinnedPlaywright();
  if (!browserInstalled()) throw new Error("the pinned card browser is not installed: run node tools/cards/install-chromium.mjs");
  const fc = privateFontconfig();
  const browser = await chromium.launch({ executablePath: EXECUTABLE, headless: true, args: CHROMIUM_ARGS, env: { ...process.env, FONTCONFIG_FILE: fc.conf } });
  if (browser.version() !== BROWSER_PIN.version) { await browser.close(); throw new Error(`the browser reports ${browser.version()}, tools/cards/chromium.json pins ${BROWSER_PIN.version}`); }
  const context = await browser.newContext({ viewport: { width: 800, height: 1000 }, deviceScaleFactor: SCALE, locale: "en-US", timezoneId: "UTC", colorScheme: "dark", reducedMotion: "reduce", serviceWorkers: "block", offline: false });
  const refused = [];
  await context.route("**/*", (route) => {
    const u = new URL(route.request().url());
    const file = u.origin === ORIGIN ? serveFile(decodeURIComponent(u.pathname).replace(/^\/+/, "")) : null;
    if (!file) { refused.push(u.href); return route.abort("blockedbyclient"); }
    return route.fulfill({ status: 200, contentType: file.type, body: file.body, headers: { "cache-control": "no-store" } });
  });
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date(FIXED_TIME));
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e && e.message)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(`${ORIGIN}/card.html`, { waitUntil: "load" });
  const cdp = await context.newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  const info = { playwright: version, browser: browser.version(), sha256: BROWSER_PIN.sha256, scale: SCALE, args: CHROMIUM_ARGS };
  async function render(job) {
    const missing = uncoveredChars({ model: job.model, view: job.view });
    if (missing.length) throw new Error(`${job.key}: characters the board's fonts cannot draw (they would be a fallback font or an empty box): ${missing.join(", ")}`);
    const size = await page.evaluate((m) => window.renderCard(m), { ...job.model, ...job.view });
    const want = WIDTH[job.kind];
    if (size.width !== want) throw new Error(`${job.key}: card is ${size.width} CSS px wide, expected ${want}`);
    if (!Number.isInteger(size.height) || size.height < 80 || size.height > 900) throw new Error(`${job.key}: card height ${size.height} is not a whole number of CSS px in 80..900`);
    const used = await fontsUsed(cdp);
    const system = [...used.keys()].filter((k) => k.endsWith("(SYSTEM)"));
    if (system.length) throw new Error(`${job.key}: glyphs drawn with a system font (${system.join(", ")}); every character on a card must be in the board's fonts`);
    const foreign = [...used.keys()].filter((k) => !/^(Alegreya|Grenze Gotisch)\b/.test(k));
    if (foreign.length) throw new Error(`${job.key}: unexpected font ${foreign.join(", ")}`);
    if (refused.length) throw new Error(`${job.key}: the page asked for something outside the template and fonts: ${refused.join(", ")}`);
    if (errors.length) throw new Error(`${job.key}: page error: ${errors.join(" | ")}`);
    const png = await page.screenshot({ clip: { x: 0, y: 0, width: size.width, height: size.height }, scale: "device", type: "png", animations: "disabled", caret: "hide" });
    const decoded = decodePng(png);
    if (decoded.width !== size.width * SCALE || decoded.height !== size.height * SCALE) throw new Error(`${job.key}: screenshot is ${decoded.width}x${decoded.height}, expected ${size.width * SCALE}x${size.height * SCALE}`);
    return { decoded, px: pixelHash(decoded), faces: size.faces, fonts: Object.fromEntries([...used].sort()) };
  }
  async function close() {
    await browser.close();
    fs.rmSync(fc.dir, { recursive: true, force: true });
  }
  return { render, close, info, fallback: fc.fallback };
}

export function inputsHash() {
  const template = sha(Buffer.concat(TEMPLATE_FILES.map((f) => Buffer.concat([Buffer.from(`${f}\n`), fs.readFileSync(path.join(HERE, f))])))).slice(0, 16);
  const drawing = sha(Buffer.concat(DRAWING_FILES.map((f) => Buffer.concat([Buffer.from(`${f}\n`), fs.readFileSync(path.join(ROOT, f))])))).slice(0, 16);
  const fonts = Object.fromEntries(FONT_FILES.map((f) => [f, sha(fs.readFileSync(path.join(ROOT, "fonts", f))).slice(0, 16)]));
  return { template, drawing, fonts };
}

export const readManifest = () => {
  const p = path.join(ROOT, MANIFEST_PATH);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
};
const fileFor = (job, px) => `${CARDS_DIR}/${job.kind}/${job.slug}-${px.slice(0, 12)}.png`;
function committedPngs() {
  const out = [];
  const base = path.join(ROOT, CARDS_DIR);
  if (!fs.existsSync(base)) return out;
  for (const kind of fs.readdirSync(base)) {
    const dir = path.join(base, kind);
    if (!fs.statSync(dir).isDirectory()) { out.push(`${CARDS_DIR}/${kind}`); continue; }
    for (const f of fs.readdirSync(dir)) out.push(`${CARDS_DIR}/${kind}/${f}`);
  }
  return out.sort();
}
// A committed card must be a strict PNG (IHDR, IDAT and IEND only: png.mjs), or what a viewer shows could differ from what is hashed.
const committedPixels = (rel) => {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) return null;
  try { return decodePng(fs.readFileSync(p), { strict: true }); } catch { return null; }
};

async function main() {
  const opt = args(process.argv.slice(2));
  const t0 = Date.now();
  const { jobs: all, aliases } = await cardJobs();
  const jobs = opt.only ? all.filter((j) => j.key.startsWith(opt.only)) : all;
  if (!jobs.length) throw new Error(`no card key starts with "${opt.only}"`);
  const old = readManifest();
  if (opt.write && opt.only && old && JSON.stringify(old.inputs) !== JSON.stringify(inputsHash())) throw new Error("the template, the drawing code or a font changed since the manifest was written: run a full --write (a partial one would stamp cards it did not redraw)");
  const r = await openRenderer();
  if (opt.write && opt.only && old && old.renderer && JSON.stringify({ ...old.renderer }) !== JSON.stringify(r.info)) { await r.close(); throw new Error("the browser, the driver or the launch flags changed since the manifest was written: run a full --write"); }
  const second = opt.twice ? await openRenderer() : null;
  const problems = [];
  const entries = {};
  let written = 0;
  if (opt.out) fs.mkdirSync(opt.out, { recursive: true });
  try {
    for (const job of jobs) {
      const got = await r.render(job);
      if (second) {
        const again = await second.render(job);
        if (again.px !== got.px) problems.push(`${job.key}: two clean browsers drew different pixels (${pixelDiff(got.decoded, again.decoded).pixels} pixels differ)`);
      }
      const model = await modelHash(job.model);
      if (opt.out) fs.writeFileSync(path.join(opt.out, `${job.key.replace(/[^a-z0-9]+/gi, "_")}.png`), encodePng(got.decoded));
      const prev = old && old.cards && Object.hasOwn(old.cards, job.key) ? old.cards[job.key] : null;
      if (opt.check) {
        if (!prev) { problems.push(`${job.key}: no manifest entry (run --write)`); continue; }
        if (prev.model !== model) problems.push(`${job.key}: the repository data changed since the card was drawn (model hash differs; run --write)`);
        if (prev.px !== got.px) {
          const committed = committedPixels(prev.file);
          const diff = committed ? pixelDiff(got.decoded, committed) : null;
          problems.push(`${job.key}: rendered pixels differ from the manifest${diff ? ` (${diff.pixels} pixels differ from ${prev.file}, largest channel difference ${diff.maxDelta})` : ""}`);
        }
        const committed = committedPixels(prev.file);
        if (!committed) problems.push(`${job.key}: ${prev.file} is missing or is not a strict PNG (IHDR, IDAT and IEND only)`);
        else if (pixelHash(committed) !== prev.px) problems.push(`${job.key}: ${prev.file} does not decode to the manifest's pixels`);
        if (!prev.file.endsWith(`-${prev.px.slice(0, 12)}.png`)) problems.push(`${job.key}: ${prev.file} does not carry its pixel hash in the name`);
        continue;
      }
      const keep = prev && prev.px === got.px && committedPixels(prev.file) && pixelHash(committedPixels(prev.file)) === got.px;
      const file = keep ? prev.file : fileFor(job, got.px);
      if (!keep) {
        fs.mkdirSync(path.join(ROOT, path.dirname(file)), { recursive: true });
        fs.writeFileSync(path.join(ROOT, file), encodePng(got.decoded));
        written++;
      }
      entries[job.key] = { file, w: got.decoded.width, h: got.decoded.height, px: got.px, model };
    }
  } finally {
    await r.close();
    if (second) await second.close();
  }
  if (opt.check) {
    if (!opt.only) {
      const keys = new Set(all.map((j) => j.key));
      for (const k of Object.keys((old && old.cards) || {})) if (!keys.has(k)) problems.push(`${k}: in the manifest but no longer a card (run --write)`);
      const files = new Set(Object.values((old && old.cards) || {}).map((e) => e.file));
      for (const f of committedPngs()) if (!files.has(f)) problems.push(`${f}: committed but not in the manifest (run --write)`);
      if (JSON.stringify((old && old.aliases) || {}) !== JSON.stringify(aliases)) problems.push("map aliases in the manifest differ from data/atlas (run --write)");
      const inputs = inputsHash();
      if (old && JSON.stringify(old.inputs) !== JSON.stringify(inputs)) problems.push(`template or font files changed since the manifest was written (manifest ${JSON.stringify(old.inputs)}, now ${JSON.stringify(inputs)})`);
      if (old && old.renderer && (old.renderer.browser !== r.info.browser || old.renderer.playwright !== r.info.playwright)) problems.push(`the manifest was drawn with Chrome for Testing ${old.renderer.browser} and playwright-core ${old.renderer.playwright}, this run has ${r.info.browser} and ${r.info.playwright}`);
    } else problems.push(`--only ${opt.only}: a partial check never passes (${jobs.length} of ${all.length} cards)`);
    const report = { ok: problems.length === 0, cards: jobs.length, renderer: r.info, seconds: Math.round((Date.now() - t0) / 1000), problems };
    if (opt.out) fs.writeFileSync(path.join(opt.out, "report.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(`cards: checked ${jobs.length} cards with Chrome for Testing ${r.info.browser} driven by playwright-core ${r.info.playwright} in ${report.seconds} s`);
    for (const p of problems) console.log(`::error title=Card pixels::${p}`);
    if (problems.length) { console.log(`cards: ${problems.length} problem(s). Renders: ${opt.out || "(pass --out <dir> to keep them)"}`); process.exit(1); }
    console.log("cards: every card decodes to exactly its committed pixels");
    return;
  }
  if (problems.length) { for (const p of problems) console.error(p); process.exit(1); }
  const cards = opt.only ? { ...((old && old.cards) || {}), ...entries } : entries;
  const sorted = Object.fromEntries(Object.entries(cards).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const manifest = {
    about: "Generated by tools/cards/render.mjs --write; do not edit. The Worker (card-images.js) sends a card only when its model hash matches. docs/runbooks/card-images.md",
    schema: 1,
    renderer: r.info,
    inputs: inputsHash(),
    aliases,
    cards: sorted,
  };
  fs.writeFileSync(path.join(ROOT, MANIFEST_PATH), JSON.stringify(manifest, null, 1) + "\n");
  let removed = 0;
  if (!opt.only) {
    const keepFiles = new Set(Object.values(sorted).map((e) => e.file));
    for (const f of committedPngs()) if (!keepFiles.has(f)) { fs.rmSync(path.join(ROOT, f), { force: true }); removed++; }
  }
  const bytes = Object.values(sorted).reduce((n, e) => n + fs.statSync(path.join(ROOT, e.file)).size, 0);
  console.log(`cards: ${Object.keys(sorted).length} cards (${written} written, ${removed} removed), ${(bytes / 1048576).toFixed(2)} MiB, ${Math.round((Date.now() - t0) / 1000)} s; fontconfig fallback present but unused: ${r.fallback}`);
}

if (import.meta.url === `file://${process.argv[1]}` || fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || "")) {
  main().catch((e) => { console.error(`cards: ${e && e.stack ? e.stack : e}`); process.exit(1); });
}
