// The ONE place that decides what the Cloudflare Pages bundle (the static site at leeroy.party) contains. Both deploy workflows call it
// (.github/workflows/deploy-cloudflare.yml and pr-preview-cloudflare.yml), so production and the PR preview cannot drift apart, and so does
// tools/static-server.mjs (the local server must answer like the deploy, so a test that reads a private file over HTTP fails on a laptop too).
//
//   node tools/pages-bundle.mjs <out-dir> [--root <repo root>]     stage the bundle into <out-dir>, then assert it is clean (exit 1 if not)
//
// MEMBER DATA IS WORKER-ONLY. The files below describe the group's members (race, class, spec, professions, board line, start zone, or
// something derived from them). The Worker serves them through a read-time privacy projection (infrastructure/worker/public-party.js) that
// removes what a member hides; a static copy would bypass it for ever. They stay in the repository (the Worker seeds D1 from them in CI and
// bundles data/client.json as its default document), and they are never published as files. The page reads them from the Worker API only.
//
// NOT PUBLISHED IS NOT ENOUGH (found 2026-11-15): after the files left the bundle, and after every old deployment was deleted, https://leeroy.party/data/party.json kept answering 200 with
// the old bytes (Age in the tens of thousands of seconds, from a layer behind the zone cache). So the bundle also ships a Pages Function (pages-worker/, staged as _worker.js/) and a
// _routes.json that sends exactly the private paths to it: it answers 404 with no-store itself and never asks the asset layer. assertBundleClean checks both are there.
//
// To add a private data file: add its repo path to PRIVATE_DATA_FILES in pages-worker/private-paths.mjs (or a transform to STRIPPED_FILES when the file also holds public
// records the page needs), and the Worker route + projection for it. tests/unit/pages-bundle.test.mjs then pins it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PRIVATE_DATA_FILES, canonPath, isPrivatePath, privateRoutes } from "../pages-worker/private-paths.mjs";

export { PRIVATE_DATA_FILES, canonPath, isPrivatePath };

// What is published, as before: top-level entries of the repository root. (Entries that do not exist are skipped.)
// cards/: the picture cards for Discord replies (tools/cards, docs/runbooks/card-images.md), immutable files named by their pixel hash.
export const BUNDLE_ITEMS = Object.freeze(["index.html", "404.html", "privacy", "terms", "_headers", "og-1200x630.jpg", "robots.txt", "atlas", "cards", "cloth", "css", "data", "fonts", "img", "js", "landing", "rate", "door", "next", "room", "scenes", "vendor"]);

// Files that ship in a reduced form because they also hold public records the page uses. The value is a function text -> text.
// data/atlas/links.json: the `start_zone` records (one per member class) and the per-place `counts[*].records` they add to are removed.
export function stripLinks(text) {
  const j = JSON.parse(text);
  const drop = (j.records || []).filter((r) => r && r.kind === "start_zone");
  if (j.records) j.records = j.records.filter((r) => !(r && r.kind === "start_zone"));
  for (const r of drop) {
    const c = j.counts && r.place ? j.counts[r.place] : null;
    if (c && typeof c.records === "number") c.records = Math.max(0, c.records - 1);
  }
  return JSON.stringify(j);
}
export const STRIPPED_FILES = Object.freeze({ "data/atlas/links.json": stripLinks });

const norm = (p) => String(p).split(path.sep).join("/").replace(/^\.?\//, "");
export const strippedFor = (rel) => STRIPPED_FILES[canonPath(rel)] || null;

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p); else yield p;
  }
}

// The Pages Function (advanced mode): the folder pages-worker/ is staged as <bundle>/_worker.js/ (wrangler bundles a _worker.js folder, imports included, and skips it as an asset).
export const WORKER_SRC_DIR = "pages-worker";
export const WORKER_DIR = "_worker.js";
export const WORKER_FILES = Object.freeze(["index.js", "private-paths.mjs"]);

// Throws (listing every problem) when `out` holds a private path or an unreduced stripped file. Run by the CLI after staging: the deploy step fails loudly.
export function assertBundleClean(out) {
  const bad = [];
  for (const rel of PRIVATE_DATA_FILES) if (fs.existsSync(path.join(out, rel))) bad.push(`${rel} is in the bundle (private member data)`);
  for (const rel of Object.keys(STRIPPED_FILES)) {
    const f = path.join(out, rel);
    if (!fs.existsSync(f)) continue;
    const text = fs.readFileSync(f, "utf8");
    if (STRIPPED_FILES[rel](text) !== JSON.stringify(JSON.parse(text))) bad.push(`${rel} is in the bundle unreduced`);
  }
  // The 404 Function and its routes must ship: without them a copy an edge layer still holds for an older deployment is served again (see the header).
  for (const rel of WORKER_FILES) if (!fs.existsSync(path.join(out, WORKER_DIR, rel))) bad.push(`${WORKER_DIR}/${rel} is missing from the bundle (the Pages Function that answers 404 for the private paths)`);
  const routesFile = path.join(out, "_routes.json");
  if (!fs.existsSync(routesFile)) bad.push("_routes.json is missing from the bundle (it sends the private paths to the Function)");
  else {
    let routes = null;
    try { routes = JSON.parse(fs.readFileSync(routesFile, "utf8")); } catch { /* reported below */ }
    if (!routes || JSON.stringify(routes) !== JSON.stringify(privateRoutes())) bad.push("_routes.json does not equal the routes for the private paths (pages-worker/private-paths.mjs privateRoutes)");
  }
  if (bad.length) throw new Error(`pages bundle is not clean:\n  ${bad.join("\n  ")}`);
  let files = 0;
  for (const _ of walk(out)) files++;
  return files;
}

// Copies BUNDLE_ITEMS from root into out (private files left out, STRIPPED_FILES reduced), stages the Function and _routes.json, then asserts the result.
export function buildBundle(root, out, log = () => {}) {
  fs.mkdirSync(out, { recursive: true });
  for (const item of BUNDLE_ITEMS) {
    const src = path.join(root, item);
    if (!fs.existsSync(src)) continue;
    fs.cpSync(src, path.join(out, item), {
      recursive: true,
      filter: (s) => {
        const rel = norm(path.relative(root, s));
        if (isPrivatePath(rel)) { log(`left out (private): ${rel}`); return false; }
        return true;
      },
    });
  }
  fs.cpSync(path.join(root, WORKER_SRC_DIR), path.join(out, WORKER_DIR), { recursive: true });
  fs.writeFileSync(path.join(out, "_routes.json"), JSON.stringify(privateRoutes(), null, 2) + "\n", "utf8");
  log(`staged the Pages Function (${WORKER_DIR}/) and _routes.json for ${PRIVATE_DATA_FILES.length} private paths`);
  for (const [rel, fn] of Object.entries(STRIPPED_FILES)) {
    const src = path.join(root, rel), dst = path.join(out, rel);
    if (!fs.existsSync(src) || !fs.existsSync(dst)) continue;
    fs.writeFileSync(dst, fn(fs.readFileSync(src, "utf8")), "utf8");
    log(`reduced: ${rel}`);
  }
  return assertBundleClean(out);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const args = process.argv.slice(2);
  const ri = args.indexOf("--root");
  const root = path.resolve(ri >= 0 ? args[ri + 1] : path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
  const outArg = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--root");
  if (!outArg) { console.error("usage: node tools/pages-bundle.mjs <out-dir> [--root <repo root>]"); process.exit(2); }
  try {
    const n = buildBundle(root, path.resolve(outArg), (m) => console.log(`pages-bundle: ${m}`));
    console.log(`pages-bundle: ${n} files staged into ${outArg}, no private member data`);
  } catch (e) {
    console.error(`::error::${String(e.message).split("\n").join(" ")}`);
    console.error(`pages-bundle: FAILED: ${e.message}`);
    process.exit(1);
  }
}
