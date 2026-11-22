// Shared helpers for tools/replay: CSV parsing, MANIFEST verification, the repo-write refusal, JSONL I/O, a seeded PRNG.
// Real game tables and every generated question set live OUTSIDE the repo. assertOutsideRepo is the guard every writer here goes through.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, realpathSync, lstatSync, openSync, writeSync, closeSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

export const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
export const DEFAULT_OUT_DIR = path.join(os.tmpdir(), "leeroy-replay");
export const die = (msg, code = 2) => { console.error(msg); process.exit(code); };
export const sha256 = (data) => createHash("sha256").update(data).digest("hex");

// Refuses any path inside the repo checkout (symlinks and junctions resolved through the nearest existing ancestor) and any existing target that is a hard link (nlink > 1: a second name for a file that may live in the repo).
// The comparison uses a separator boundary: a child named "..replay" is INSIDE, a sibling "../x" is outside.
// Residual TOCTOU: the check and the open are two steps. Between them a directory component could be swapped for a link into the repo. The writers narrow it (exclusive-create "wx" for new files, append "a" for results, which never truncates)
// but cannot close it on Windows without handle-based checks; the output directory should be one only the owner can write to.
export function isInside(root, target) {
  const rel = path.relative(root, target);
  if (rel === "") return true;
  if (path.isAbsolute(rel)) return false; // another drive
  return !(rel === ".." || rel.startsWith(".." + path.sep));
}
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
  if (isInside(realpathSync(root), real)) throw new Error("refusing to write inside the repo checkout; pick an output path outside it");
  if (existsSync(real) && lstatSync(real).isFile() && lstatSync(real).nlink > 1) throw new Error("refusing to write to a hard-linked file (it may be another name for a file in the repo)");
  return path.resolve(p);
}
// Exclusive create: an existing file is never truncated or replaced.
export function writeOut(p, text, root = REPO_ROOT) {
  const abs = assertOutsideRepo(p, root);
  mkdirSync(path.dirname(abs), { recursive: true });
  try { writeFileSync(abs, text, { encoding: "utf8", flag: "wx" }); } catch (e) { if (e && e.code === "EEXIST") throw new Error("refusing to overwrite an existing file: " + path.basename(abs)); throw e; }
  return abs;
}
export function appendOut(p, text, root = REPO_ROOT) {
  const abs = assertOutsideRepo(p, root);
  mkdirSync(path.dirname(abs), { recursive: true });
  appendFileSync(abs, text, { encoding: "utf8", flag: "a" });
  return abs;
}
// Exclusive-create lock file beside the results file; removed in finally. A leftover lock (crashed run) is reported, never silently taken over.
export async function withLock(p, fn, root = REPO_ROOT) {
  const lock = assertOutsideRepo(p + ".lock", root);
  mkdirSync(path.dirname(lock), { recursive: true });
  let fd;
  try { fd = openSync(lock, "wx"); } catch (e) {
    if (e && e.code === "EEXIST") throw new Error("the results file is locked by " + path.basename(lock) + ": another run is using it, or a run died; if no run is active, delete that lock file and resume");
    throw e;
  }
  try { writeSync(fd, String(process.pid)); closeSync(fd); return await fn(); } finally { try { unlinkSync(lock); } catch { /* already gone */ } }
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
  // MANIFEST rows counts data rows. A physical-line count is accepted ONLY when the table really has a quoted field with an embedded newline (which makes records span lines); otherwise a mismatch refuses.
  const physicalLines = buf.toString("utf8").split("\n").filter((l, i, a) => !(i === a.length - 1 && l === "")).length - 1;
  const multiline = rows.some((r) => r.some((c) => c.includes("\n")));
  if (rows.length !== meta.rows && !(multiline && physicalLines === meta.rows)) throw new Error(`${name}: row count differs from MANIFEST`);
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
