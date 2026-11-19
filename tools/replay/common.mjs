// Shared helpers for tools/replay: CSV parsing, MANIFEST verification, the repo-write refusal, JSONL I/O, a seeded PRNG.
// Real game tables and every generated question set live OUTSIDE the repo. assertOutsideRepo is the guard every writer here goes through.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

export const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
export const DEFAULT_OUT_DIR = path.join(os.tmpdir(), "leeroy-replay");
export const die = (msg, code = 2) => { console.error(msg); process.exit(code); };
export const sha256 = (data) => createHash("sha256").update(data).digest("hex");

// Refuses any path inside the repo checkout (symlinks and junctions resolved through the nearest existing ancestor).
export function assertOutsideRepo(p, root = REPO_ROOT) {
  let cur = path.resolve(p);
  const rest = [];
  while (!existsSync(cur)) {
    const up = path.dirname(cur);
    if (up === cur) break;
    rest.unshift(path.basename(cur));
    cur = up;
  }
  const real = path.join(realpathSync(cur), ...rest);
  const rel = path.relative(realpathSync(root), real);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) throw new Error("refusing to write inside the repo checkout; pick an output path outside it");
  return path.resolve(p);
}
export function writeOut(p, text, root = REPO_ROOT) {
  const abs = assertOutsideRepo(p, root);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, text, "utf8");
  return abs;
}
export function appendOut(p, text, root = REPO_ROOT) {
  const abs = assertOutsideRepo(p, root);
  mkdirSync(path.dirname(abs), { recursive: true });
  appendFileSync(abs, text, "utf8");
  return abs;
}

export function readJsonl(p) {
  const out = [];
  readFileSync(p, "utf8").split("\n").forEach((line, i) => {
    const t = line.trim();
    if (!t) return;
    try { out.push(JSON.parse(t)); } catch { throw new Error(`${path.basename(p)} line ${i + 1}: not JSON`); }
  });
  return out;
}

// RFC 4180 subset: quoted fields, "" escapes, CRLF or LF, optional BOM. Returns an array of string arrays.
export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", q = false, i = 0;
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  for (; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      rows.push(row); row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Loads <dir>/<name> after checking it against MANIFEST.json files[name] {sha256, bytes, rows}. Any mismatch throws and nothing is parsed.
// rows counts data rows (the header excluded). Returns {header, rows, col(name)->position, sha256, bytes}.
export function loadVerifiedTable(dir, manifest, name) {
  const meta = manifest && manifest.files && manifest.files[name];
  if (!meta) throw new Error(`${name}: not listed in MANIFEST.json`);
  const buf = readFileSync(path.join(dir, name));
  if (buf.length !== meta.bytes) throw new Error(`${name}: byte count differs from MANIFEST`);
  if (sha256(buf) !== meta.sha256) throw new Error(`${name}: sha256 differs from MANIFEST`);
  const all = parseCsv(buf.toString("utf8")).filter((r) => !(r.length === 1 && r[0] === ""));
  const header = all[0] || [];
  const rows = all.slice(1);
  // MANIFEST rows is the count of data lines in some exports (a quoted field with an embedded newline makes a record span two lines), so either count must match.
  const physicalLines = buf.toString("utf8").split("\n").filter((l, i, a) => !(i === a.length - 1 && l === "")).length - 1;
  if (rows.length !== meta.rows && physicalLines !== meta.rows) throw new Error(`${name}: row count differs from MANIFEST`);
  const pos = new Map(header.map((h, i) => [h, i]));
  const col = (c) => { if (!pos.has(c)) throw new Error(`${name}: column ${c} missing`); return pos.get(c); };
  return { header, rows, col, sha256: meta.sha256, bytes: meta.bytes };
}

// mulberry32: small seeded PRNG, deterministic across platforms.
export function rng(seed) {
  let a = (Number(seed) >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function shuffle(arr, rand) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
// spec: {flag: "value"|"bool"}; positionals collected in _. Unknown flags die.
export function parseArgs(argv, spec) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      if (!(k in spec)) die(`unknown option ${a}`);
      if (spec[k] === "bool") out[k] = true;
      else { if (i + 1 >= argv.length) die(`missing value for ${a}`); out[k] = argv[++i]; }
    } else out._.push(a);
  }
  return out;
}
