// Content-derived asset stamps. Node 22, no dependencies.
//
//   node tools/stamps.mjs --check   exit 1 and list every stale stamp
//   node tools/stamps.mjs --write   rewrite every stale stamp in place
//   add --root <dir> to run against another tree (the unit tests do)
//
// Rule: the stamp of a file is the first 10 hex chars of the sha256 of its exact bytes.
// A reference is a string  <path>.js|.mjs|.css ?v=<10 hex>  that resolves to an existing file.
// Path styles found in this repo, all resolved the same way:
//   "./geo.js?v="            relative to the importing file (imports, new URL(..., import.meta.url))
//   "../scenes/x.js?v="      relative to the importing file (js/scenes.js map: new URL(.., HERE))
//   "css/board.css?v="       site root (index.html, and Worker("vendor/..") in js/board.js)
//   "/css/x.css?v="          site root
// A bare path (no ./ ../ or /) is tried against the site root, then the importing file's folder.
// If both exist and differ, or neither exists, the reference is listed as unresolved and never touched.
// Because a file's own bytes include the stamps of the files it references, stamps are computed in
// dependency order (referenced files first). A cycle is reported and stops the run (exit 2).
// Files are read and written as Buffers (latin1 view), so CRLF/LF and every other byte are kept.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const REF = /(?<![A-Za-z0-9_./:@-])([A-Za-z0-9_./-]+\.(?:js|mjs|css))\?v=([0-9a-f]{10})/g;
const BARE = /(?<!=)["'`]((?:js|scenes|css|vendor|cloth|room|next)\/[A-Za-z0-9_./-]+\.(?:js|mjs|css))["'`]/g;
const SCAN_DIRS = ["js", "scenes", "css", "vendor", "cloth", "room", "next", "atlas", "img"];
const SCAN_EXT = /\.(?:js|mjs|css|html)$/;
const HASHABLE = /\.(?:js|mjs|css|html)$/;

function walk(dir, out) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (SCAN_EXT.test(e.name)) out.push(p);
  }
}

export function run(root, write) {
  root = path.resolve(root);
  const rel = (abs) => path.relative(root, abs).split(path.sep).join("/");
  const exists = (abs) => abs.startsWith(root + path.sep) && fs.existsSync(abs) && fs.statSync(abs).isFile();
  const roots = [];
  if (fs.existsSync(path.join(root, "index.html"))) roots.push(path.join(root, "index.html"));
  for (const d of SCAN_DIRS) walk(path.join(root, d), roots);

  const unresolved = [];
  const unstamped = [];
  const info = new Map(); // abs -> { buf, text, refs:[{index,len,spec,stamp,target,line}] }
  const stamp = new Map(); // abs -> expected stamp
  const out = new Map(); // abs -> final text
  const state = new Map(); // abs -> 1 visiting, 2 done
  const mismatches = [];
  let cycle = null;

  function resolve(spec, abs) {
    const fromFile = path.resolve(path.dirname(abs), spec);
    const fromRoot = path.resolve(root, "." + (spec.startsWith("/") ? spec : "/" + spec));
    if (spec.startsWith("./") || spec.startsWith("../")) return exists(fromFile) ? fromFile : null;
    if (spec.startsWith("/")) return exists(fromRoot) ? fromRoot : null;
    const a = exists(fromRoot), b = exists(fromFile);
    if (a && b && fromRoot !== fromFile) return undefined; // ambiguous
    return a ? fromRoot : b ? fromFile : null;
  }

  function load(abs) {
    if (info.has(abs)) return info.get(abs);
    const buf = fs.readFileSync(abs);
    const rec = { buf, text: buf.toString("latin1"), refs: [] };
    info.set(abs, rec);
    if (!SCAN_EXT.test(abs)) return rec;
    for (const m of rec.text.matchAll(REF)) {
      const line = rec.text.slice(0, m.index).split("\n").length;
      const target = resolve(m[1], abs);
      if (!target) {
        unresolved.push({ file: rel(abs), line, ref: m[1] + "?v=" + m[2], why: target === undefined ? "ambiguous" : "no such file" });
        continue;
      }
      rec.refs.push({ index: m.index, len: m[0].length, spec: m[1], stamp: m[2], target, line });
    }
    for (const m of rec.text.matchAll(BARE)) {
      const t = resolve(m[1], abs);
      if (t) unstamped.push({ file: rel(abs), line: rec.text.slice(0, m.index).split("\n").length, ref: m[1] });
    }
    return rec;
  }

  function visit(abs, stack) {
    if (cycle) return;
    if (state.get(abs) === 2) return;
    if (state.get(abs) === 1) { cycle = [...stack.slice(stack.indexOf(abs)), abs].map(rel); return; }
    state.set(abs, 1);
    const rec = load(abs);
    for (const r of rec.refs) visit(r.target, [...stack, abs]);
    if (cycle) return;
    let text = "", last = 0;
    for (const r of rec.refs) {
      const want = stamp.get(r.target);
      if (want !== r.stamp) mismatches.push({ file: rel(abs), line: r.line, target: rel(r.target), have: r.stamp, want });
      text += rec.text.slice(last, r.index) + r.spec + "?v=" + want;
      last = r.index + r.len;
    }
    text += rec.text.slice(last);
    out.set(abs, text);
    stamp.set(abs, crypto.createHash("sha256").update(Buffer.from(text, "latin1")).digest("hex").slice(0, 10));
    state.set(abs, 2);
  }

  for (const f of roots) visit(f, []);
  if (cycle) return { cycle, mismatches, unresolved, unstamped, changedFiles: [], changedRefs: 0 };

  const changedFiles = [...out].filter(([abs, text]) => text !== info.get(abs).text).map(([abs]) => abs);
  if (write) for (const abs of changedFiles) fs.writeFileSync(abs, Buffer.from(out.get(abs), "latin1"));
  return { cycle: null, mismatches, unresolved, unstamped, changedFiles: changedFiles.map(rel), changedRefs: mismatches.length };
}

function main(argv) {
  const write = argv.includes("--write");
  if (!write && !argv.includes("--check")) { console.error("usage: node tools/stamps.mjs --check | --write [--root <dir>]"); return 2; }
  const i = argv.indexOf("--root");
  const root = i >= 0 ? argv[i + 1] : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const r = run(root, write);
  if (r.cycle) { console.error("stamps: reference cycle, cannot order stamps: " + r.cycle.join(" -> ")); return 2; }
  for (const u of r.unresolved) console.log(`unresolved (not touched): ${u.file}:${u.line} ${u.ref} [${u.why}]`);
  for (const u of r.unstamped) console.log(`no stamp (report only): ${u.file}:${u.line} ${u.ref}`);
  if (write) {
    console.log(`stamps: rewrote ${r.changedRefs} references in ${r.changedFiles.length} files`);
    return 0;
  }
  for (const m of r.mismatches) console.log(`STALE ${m.file}:${m.line} ${m.target} has ?v=${m.have}, expected ?v=${m.want}`);
  console.log(r.mismatches.length ? `stamps: ${r.mismatches.length} stale references. Run: node tools/stamps.mjs --write` : "stamps: all references current");
  return r.mismatches.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) process.exit(main(process.argv.slice(2)));
