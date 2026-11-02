// Decides whether a pull request changes only documentation.
// Used by pr-preview-cloudflare.yml (skip the preview) and preview-tests.yml (run only unit and stamps).
// Docs-only means every changed path (and every rename source) is under docs/, a root-level *.md file,
// or under .github/ISSUE_TEMPLATE/. An empty list is not docs-only.
// Usage: <list of paths, one per line> | node tools/docs-only.mjs   (prints "true" or "false")
import { pathToFileURL } from "node:url";

export function isDocsPath(p) {
  const path = String(p).trim().replace(/^\.\//, "");
  if (!path || path.includes("..")) return false;
  if (path.startsWith("docs/")) return true;
  if (path.startsWith(".github/ISSUE_TEMPLATE/")) return true;
  return !path.includes("/") && path.endsWith(".md");
}

export function isDocsOnly(paths) {
  const list = paths.map((p) => String(p).trim()).filter(Boolean);
  return list.length > 0 && list.every(isDocsPath);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  process.stdout.write(isDocsOnly(input.split("\n")) ? "true\n" : "false\n");
}
