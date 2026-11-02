// Decides whether a pull request can change what a visitor sees in a browser, or how CI itself behaves, so the full suite (api, browser, layout)
// is required for it. GitHub minutes on a private repo are metered, so Worker-only, test-only and docs-only changes skip the browser and layout jobs.
// A scope bug is a silent gate bypass, so every doubt resolves to "true" (run everything).
// Forces a full run: the site paths below, anything under .github/ (every workflow), tools/ (the CI tools themselves), infrastructure/wrangler*
// (deploy config) and any package*.json at any depth (dependencies), plus any path of an unknown shape.
// Usage: <list of paths, one per line> | node tools/ci-scope.mjs   (prints "true" when the full suite must run, else "false")
// The caller must list renames on both sides (filename and previous_filename), as tools/docs-only.mjs expects.
import { pathToFileURL } from "node:url";

const FORCE_DIRS = ["css/", "js/", "scenes/", "landing/", "privacy/", "terms/", "rate/", "atlas/", "cloth/", "next/", "room/", "vendor/", "fonts/", "img/", "data/", "tests/browser/", ".github/", "tools/"];
const FORCE_PREFIXES = ["infrastructure/wrangler"];
const SITE_FILES = new Set(["index.html", "404.html", "robots.txt", "_headers"]);

export function isSitePath(p) {
  let path = String(p).trim();
  if (!path) return false;
  // unknown shapes: run everything (absolute, backslash, quoted by git, parent segment, control characters)
  if (path.startsWith("/") || path.includes("\\") || path.startsWith('"') || path.includes("..") || /[\u0000-\u001f]/.test(path)) return true;
  path = path.replace(/^(\.\/)+/, "").toLowerCase();
  if (!path || path.endsWith("/")) return true; // "./" or a bare directory: not a file path we know
  if (SITE_FILES.has(path)) return true;
  if (/^og-[^/]*\.(jpg|jpeg|png|webp)$/.test(path)) return true;
  if (/(^|\/)package[^/]*\.json$/.test(path)) return true;
  if (FORCE_PREFIXES.some((d) => path.startsWith(d))) return true;
  return FORCE_DIRS.some((d) => path.startsWith(d));
}

export function siteChanged(paths) {
  const list = paths.map((p) => String(p).trim()).filter(Boolean);
  if (list.length === 0) return true; // an empty list means we could not classify: run everything
  return list.some(isSitePath);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  process.stdout.write(siteChanged(input.split("\n")) ? "true\n" : "false\n");
}
