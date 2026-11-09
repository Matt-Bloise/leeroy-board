// Decides whether a pull request can change the Worker or the API, so the API suite (the only CI job that calls the real preview Worker, about 117 requests a run) is required for it.
// B72. Same shape and same rule as tools/ci-scope.mjs: a scope bug is a silent gate bypass, so every doubt resolves to "true" (run the API suite).
// Needs the API suite: anything under infrastructure/ except markdown, tests/api/, tests/helpers/, tests/fixtures/, schema or migration files anywhere,
// wrangler* config anywhere, docs/openapi.yaml (the contract test reads it), data/ (served by /api/data), .github/ and tools/ (they decide how and whether the suite runs),
// any package*.json, and any path of an unknown shape. Everything else (css, js, scenes, pages, docs, unit tests, browser tests) does not.
// Usage: <list of paths, one per line> | node tools/api-scope.mjs   (prints "true" when the API suite must run, else "false")
// The caller must list renames on both sides (filename and previous_filename), as tools/ci-scope.mjs expects.
import { pathToFileURL } from "node:url";

const FORCE_DIRS = ["infrastructure/", "tests/api/", "tests/helpers/", "tests/fixtures/", "data/", ".github/", "tools/"];
const FORCE_FILES = new Set(["docs/openapi.yaml", "docs/openapi.yml"]);

export function isApiPath(p) {
  let path = String(p).trim();
  if (!path) return false;
  // unknown shapes: run the suite (absolute, backslash, quoted by git, parent segment, control characters)
  if (path.startsWith("/") || path.includes("\\") || path.startsWith('"') || path.includes("..") || /[\u0000-\u001f]/.test(path)) return true;
  path = path.replace(/^(\.\/)+/, "").toLowerCase();
  if (!path || path.endsWith("/")) return true;
  if (FORCE_FILES.has(path)) return true;
  if (/(^|\/)package[^/]*\.json$/.test(path)) return true;
  if (/(^|\/)wrangler[^/]*$/.test(path)) return true;
  if (/(^|\/)(schema|migrations?)([./]|$)/.test(path) || /\.sql$/.test(path)) return true;
  if (path.startsWith("infrastructure/") && /\.(md|markdown|txt)$/.test(path)) return false; // docs inside infrastructure/
  return FORCE_DIRS.some((d) => path.startsWith(d));
}

export function apiNeeded(paths) {
  const list = paths.map((p) => String(p).trim()).filter(Boolean);
  if (list.length === 0) return true; // could not classify: run everything
  return list.some(isApiPath);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  process.stdout.write(apiNeeded(input.split("\n")) ? "true\n" : "false\n");
}
