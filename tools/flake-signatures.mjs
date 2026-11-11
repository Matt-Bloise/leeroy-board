// Pure matcher for .github/workflows/flake-rerun.yml. No I/O except the CLI at the bottom. Node 22, no dependencies.
// failureLines(log): the lines of one job log that report a failure (a `FAIL ...` line or an error annotation).
// classify(lines, signatures): { rerun, matched, unknown }. rerun is true ONLY when there is at least one failure line and every one matches a known signature.
// A job with no failure line at all (a crash, a timeout, a cancelled step) is unknown: never rerun on silence.
// CLI: node tools/flake-signatures.mjs <log file>...   prints one JSON object, exit 0 = rerun, 10 = do not rerun.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const TIMESTAMP = /^﻿?\d{4}-\d\d-\d\dT[\d:.]+Z\s?/;
const EXIT_CODE_ONLY = /^##\[error\]Process completed with exit code \d+\.?$/; // the consequence of a failure line, not a cause

export function failureLines(log) {
  const out = [];
  for (const raw of String(log).split(/\r?\n/)) {
    const line = raw.replace(TIMESTAMP, "").trimEnd();
    if (/^\s*FAIL\b/.test(line)) out.push(line.trim());
    else if (/^##\[error\]/.test(line) && !EXIT_CODE_ONLY.test(line)) out.push(line);
  }
  return out;
}

export function loadSignatures(json) {
  const doc = typeof json === "string" ? JSON.parse(json) : json;
  return doc.signatures.map((s) => ({ id: s.id, re: new RegExp(s.pattern) }));
}

export function classify(lines, signatures) {
  const matched = [], unknown = [];
  for (const line of lines) {
    const sig = signatures.find((s) => s.re.test(line));
    if (sig) matched.push({ id: sig.id, line }); else unknown.push(line);
  }
  return { rerun: lines.length > 0 && unknown.length === 0, matched, unknown };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const sigs = loadSignatures(readFileSync(new URL("./flake-signatures.json", import.meta.url), "utf8"));
  const lines = process.argv.slice(2).flatMap((f) => failureLines(readFileSync(f, "utf8")));
  const r = classify(lines, sigs);
  console.log(JSON.stringify({ failureLines: lines.length, ...r }, null, 2));
  process.exit(r.rerun ? 0 : 10);
}
