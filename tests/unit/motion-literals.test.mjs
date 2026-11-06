// Slice 0 lint, report mode: hard-coded animation and transition durations outside the token files are listed in
// tests/fixtures/motion-literals-baseline.json. The test fails only on NEW offenders (a key that is not in the baseline, or a count above it).
// Migrating an offender to a token (css/motion-tokens.css, js/motion-tokens.js) lowers the baseline: run `MOTION_LINT_WRITE=1 node tests/unit/motion-literals.test.mjs`.
// MOTION_LINT_REPORT=1 prints every offender. Flip to strict (baseline {}) once the program has migrated them.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BASELINE = path.join(root, "tests/fixtures/motion-literals-baseline.json");
const TOKEN_FILES = new Set(["css/motion-tokens.css", "js/motion-tokens.js"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "tests", "docs", "vendor", "infrastructure", "tools", ".github", "img", "fonts", "data"]);
const ALLOWED = new Set(["0s", "0ms", "1ms"]); // zero and the reduced-motion collapse value are not durations

function walk(dir, out = []) {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(rel, out); }
    else if (/\.(css|js)$/.test(e.name) && !TOKEN_FILES.has(rel)) out.push(rel);
  }
  return out;
}
function stripVar(v) { // drop var(...), cubic-bezier(...), steps(...) groups (balanced) so only literal times remain
  let out = "", i = 0;
  while (i < v.length) {
    const m = /^(var|cubic-bezier|steps)\(/.exec(v.slice(i));
    if (!m) { out += v[i++]; continue; }
    let depth = 0, j = i + m[1].length;
    for (; j < v.length; j++) { if (v[j] === "(") depth++; else if (v[j] === ")" && --depth === 0) break; }
    i = j + 1; out += " ";
  }
  return out;
}
export function scanCss(text) {
  const src = text.replace(/\/\*[\s\S]*?\*\//g, "");
  const found = [];
  for (const m of src.matchAll(/(?<![\w-])(transition|transition-duration|animation|animation-duration)\s*:\s*([^;}]+)/g)) {
    for (const t of stripVar(m[2]).matchAll(/(?<![\w.#-])(\d*\.?\d+)(ms|s)\b/g)) if (!ALLOWED.has(t[0])) found.push(`${m[1]}: ${t[0]}`);
  }
  return found;
}
export function scanJs(text) {
  const src = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  return [...src.matchAll(/\bduration\s*:\s*(\d+(?:\.\d+)?)\b/g)].filter((m) => m[1] !== "0").map((m) => `duration: ${m[1]}`);
}
export function collect() {
  const counts = {};
  for (const rel of walk("")) {
    const text = fs.readFileSync(path.join(root, rel), "utf8");
    for (const k of rel.endsWith(".css") ? scanCss(text) : scanJs(text)) counts[`${rel} | ${k}`] = (counts[`${rel} | ${k}`] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

if (process.env.MOTION_LINT_WRITE === "1") {
  fs.writeFileSync(BASELINE, JSON.stringify(collect(), null, 1) + "\n");
  console.log("wrote", BASELINE);
} else {
  test("no new hard-coded animation or transition durations (report mode)", () => {
    const now = collect(), base = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
    const total = Object.values(now).reduce((a, b) => a + b, 0), baseTotal = Object.values(base).reduce((a, b) => a + b, 0);
    console.log(`motion-literals: ${total} literal durations in ${Object.keys(now).length} places (baseline ${baseTotal}); new ones fail, migrating one to a token lowers the baseline`);
    if (process.env.MOTION_LINT_REPORT === "1") for (const [k, n] of Object.entries(now)) console.log(`  ${n} x ${k}`);
    const fresh = Object.entries(now).filter(([k, n]) => n > (base[k] || 0)).map(([k, n]) => `${k} (${n}, baseline ${base[k] || 0})`);
    assert.deepEqual(fresh, [], `new hard-coded durations: use a token from css/motion-tokens.css or js/motion-tokens.js\n  ${fresh.join("\n  ")}`);
  });
  test("the baseline has no stale entries beyond the current offenders", () => {
    const now = collect(), base = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
    const stale = Object.entries(base).filter(([k, n]) => (now[k] || 0) < n).map(([k]) => k);
    assert.deepEqual(stale, [], `offenders were migrated: run MOTION_LINT_WRITE=1 node tests/unit/motion-literals.test.mjs to lower the baseline\n  ${stale.join("\n  ")}`);
  });
}
