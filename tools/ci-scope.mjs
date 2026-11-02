// Decides whether a pull request can change what a visitor sees in a browser, so CI can skip the slow browser and layout jobs for
// Worker-only, test-only and docs-only changes (GitHub minutes on a private repo are metered).
// Site paths: the pages and their assets, the browser test suites, the stamp tool and every workflow (a workflow change runs everything).
// Usage: <list of paths, one per line> | node tools/ci-scope.mjs   (prints "true" when the browser and layout jobs must run, else "false")
import { pathToFileURL } from "node:url";

const SITE_DIRS = ["css/", "js/", "scenes/", "landing/", "privacy/", "terms/", "rate/", "atlas/", "cloth/", "next/", "room/", "vendor/", "fonts/", "img/", "data/", "tests/browser/", ".github/workflows/"];
const SITE_FILES = new Set(["index.html", "404.html", "robots.txt", "_headers", "tools/stamps.mjs", "tools/ci-scope.mjs", "tools/docs-only.mjs"]);

export function isSitePath(p) {
  const path = String(p).trim().replace(/^\.\//, "");
  if (!path) return false;
  if (path.includes("..")) return true; // unknown shape: run everything
  if (SITE_FILES.has(path)) return true;
  if (/^og-[^/]*\.(jpg|jpeg|png|webp)$/i.test(path)) return true;
  return SITE_DIRS.some((d) => path.startsWith(d));
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
