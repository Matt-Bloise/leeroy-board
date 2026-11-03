// The private-by-default GET /api/data|atlas/<name> allow list must contain EVERY document the front end fetches from those routes.
// This reads the front-end source (js/, scenes/, atlas/, landing/, next/, rate/, room/, cloth/, index.html) and fails if a document it asks the Worker for is missing from the allow list.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isPrivateKvKey } from "../../infrastructure/worker/config.js";
import { isPublicAtlasDoc, isPublicDataDoc } from "../../infrastructure/worker/public-docs.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".") || ["tests", "infrastructure", "vendor", "docs", "tools"].includes(e.name) && d === root) continue;
    const f = path.join(d, e.name);
    if (e.isDirectory()) walk(f); else if (/\.(js|html)$/.test(e.name)) files.push(f);
  }
})(root);

// What the front end asks the Worker for. Static-only files (foley, trust, cta, sample/*, library/*) are not fetched through these routes.
function documents() {
  const data = new Map(), atlas = new Map(), add = (m, n, f) => { if (!m.has(n)) m.set(n, f); };
  for (const f of files) {
    const rel = path.relative(root, f), src = fs.readFileSync(f, "utf8");
    // BoardFetch.json("data/<name>.json") and BoardFetch.json("data/atlas/<name>.json") go through apiFetch, which maps data/<name>.json to /api/data/<name>
    for (const m of src.matchAll(/(?:BoardFetch|BF)\.json\(\s*["'`]data\/(atlas\/)?([a-z0-9-]+)\.json/g)) add(m[1] ? atlas : data, m[2], rel);
    // BoardBrain.url("/data/<name>.json") and ("/atlas/<name>.json")
    for (const m of src.matchAll(/\.url\(\s*["'`]\/(data|atlas)\/([a-z0-9-]+)(?:\.json)?["'`]/g)) add(m[1] === "atlas" ? atlas : data, m[2], rel);
  }
  // js/board.js: DATA_NAMES and the optional pair are read as data/<n>.json through apiFetch; client.json is read by name
  const board = fs.readFileSync(path.join(root, "js/board.js"), "utf8");
  const names = /const DATA_NAMES = \[([^\]]+)\]/.exec(board), opt = /opt: \[([^\]]+)\]\.map\(\(n\) => dataGet/.exec(board);
  assert.ok(names && opt, "js/board.js DATA_NAMES and the optional list are still where this test expects them");
  for (const m of `${names[1]},${opt[1]}`.matchAll(/"([a-z0-9-]+)"/g)) add(data, m[1], "js/board.js");
  for (const m of board.matchAll(/BF\.json\(`data\/\$\{n\}\.json`/g)) assert.ok(m); // the template form is covered by the lists above
  return { data, atlas };
}

test("the scan finds the documents it should (guards against the regexes rotting)", () => {
  const { data, atlas } = documents();
  for (const n of ["party", "timeline", "client", "stats", "signups", "tonight", "launch", "decide", "guided-atlas"]) assert.ok(data.has(n), `data/${n} found in the front end`);
  for (const n of ["marks", "links"]) assert.ok(atlas.has(n), `atlas/${n} found in the front end`);
});
test("every /api/data/<name> the front end fetches is public (allow list, and not private by default)", () => {
  for (const [n, f] of documents().data) {
    assert.ok(isPublicDataDoc(n), `/api/data/${n} (read in ${f}) is missing from PUBLIC_DATA_DOCS in infrastructure/worker/public-docs.js`);
    assert.equal(isPrivateKvKey(n), false, `/api/data/${n} (read in ${f}) is private by default in isPrivateKvKey`);
  }
});
test("every /api/atlas/<name> the front end fetches is public", () => {
  for (const [n, f] of documents().atlas) {
    assert.ok(isPublicAtlasDoc(n), `/api/atlas/${n} (read in ${f}) is missing from PUBLIC_ATLAS_DOCS`);
    assert.equal(isPrivateKvKey(n), false, `/api/atlas/${n} (read in ${f}) is private by default in isPrivateKvKey`);
  }
});
test("a document missing from the allow list would be caught (the check is not vacuous)", () => {
  assert.equal(isPublicDataDoc("zz-new-doc"), false);
  assert.equal(isPrivateKvKey("zz-new-doc"), true);
});
