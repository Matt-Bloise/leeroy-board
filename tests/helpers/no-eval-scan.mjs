// B61: finds eval-class calls in the code the site serves to visitors. An enforcing CSP without 'unsafe-eval' blocks all of these.
// Text scan, no parsing: a mention in a comment or string also counts, so reword it rather than allow it.
// Known limit: a timer whose first argument is a variable that holds a string is not visible to a text scan.
import fs from "node:fs";
import path from "node:path";

export const RULES = [
  { kind: "eval", re: /(?<![\w$])eval(?![\w$])/g, what: "eval (direct, indirect, window.eval, or the name used anywhere)" },
  { kind: "new Function", re: /new\s+Function(?![\w$])/g, what: "new Function(...) constructor" },
  { kind: "Function(", re: /(?<![\w$.])(?<!new\s+)Function\s*\(/g, what: "Function(...) called as the constructor" },
  { kind: "constructor.constructor", re: /constructor\s*\.\s*constructor\s*\(/g, what: "constructor.constructor(...) reaching the Function constructor" },
  { kind: "string timer", re: /set(?:Timeout|Interval)\s*\(\s*['"`]/g, what: "setTimeout/setInterval with a string of code" },
];

// Only files a visitor can be served. tests/, tools/, infrastructure/ (Worker, not served), docs/ and .github/ are not.
export const SKIP_DIRS = new Set([".git", ".github", "node_modules", "tests", "tools", "infrastructure", "docs"]);
export const EXTS = new Set([".js", ".mjs", ".cjs", ".html", ".htm"]);

export function walk(root, dir = root, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(root, path.join(dir, e.name), out); }
    else if (EXTS.has(path.extname(e.name).toLowerCase())) out.push(path.relative(root, path.join(dir, e.name)).split(path.sep).join("/"));
  }
  return out.sort();
}

// -> [{file, line, kind, snippet}]
export function scanText(file, text) {
  const hits = [];
  for (const r of RULES) {
    for (const m of text.matchAll(r.re)) {
      const line = text.slice(0, m.index).split("\n").length;
      const s = Math.max(0, m.index - 30);
      hits.push({ file, line, kind: r.kind, snippet: text.slice(s, m.index + m[0].length + 30).replace(/\s+/g, " ") });
    }
  }
  return hits;
}

// allowlist: [{file, kind, count, reason}]; count is exact, so a second hit in an allowed file still fails, and an entry that no longer matches fails too.
export function scanTree(root, allowlist = []) {
  const files = walk(root);
  const all = files.flatMap((f) => scanText(f, fs.readFileSync(path.join(root, f), "utf8")));
  const problems = [];
  const used = new Set();
  const byKey = new Map();
  for (const h of all) { const k = h.file + "\0" + h.kind; (byKey.get(k) || byKey.set(k, []).get(k)).push(h); }
  for (const [k, hs] of byKey) {
    const a = allowlist.find((x) => x.file + "\0" + x.kind === k);
    if (a) { used.add(a); if (hs.length === a.count) continue; }
    for (const h of hs) problems.push(a ? `${h.file}:${h.line} ${h.kind}: ${hs.length} hits, allowlist says ${a.count}: ${h.snippet}` : `${h.file}:${h.line} ${h.kind}: ${h.snippet}`);
  }
  for (const a of allowlist) if (!used.has(a)) problems.push(`stale allowlist entry (no hit): ${a.file} ${a.kind}`);
  return { files, hits: all, problems };
}
