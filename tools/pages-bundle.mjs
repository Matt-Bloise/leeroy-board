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
// To add a private data file: add its repo path to PRIVATE_DATA_FILES (or a transform to STRIPPED_FILES when the file also holds public
// records the page needs), and the Worker route + projection for it. tests/unit/pages-bundle.test.mjs then pins it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// What is published, as before: top-level entries of the repository root. (Entries that do not exist are skipped.)
export const BUNDLE_ITEMS = Object.freeze(["index.html", "404.html", "privacy", "terms", "_headers", "og-1200x630.jpg", "robots.txt", "atlas", "cloth", "css", "data", "fonts", "img", "js", "landing", "rate", "next", "room", "scenes", "vendor"]);

// Repo-relative, forward-slash paths that must never be in the bundle. party/decide/tonight/guided-atlas/client are the five documents
// public-party.js MEMBER_DOCS projects ("client" carries the classes and races at the table: the same facts by elimination).
export const PRIVATE_DATA_FILES = Object.freeze(["data/party.json", "data/decide.json", "data/tonight.json", "data/guided-atlas.json", "data/client.json"]);

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
export const isPrivatePath = (rel) => PRIVATE_DATA_FILES.includes(norm(rel));

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p); else yield p;
  }
}

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
  if (bad.length) throw new Error(`pages bundle is not clean:\n  ${bad.join("\n  ")}`);
  let files = 0;
  for (const _ of walk(out)) files++;
  return files;
}

// Copies BUNDLE_ITEMS from root into out (private files left out, STRIPPED_FILES reduced), then asserts the result.
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
