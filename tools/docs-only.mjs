// Decides whether a pull request changes only documentation.
// Used by pr-preview-cloudflare.yml (skip the preview) and preview-tests.yml (run only unit and stamps).
// Docs-only means every changed path (and every rename source) is under docs/, a root-level *.md file,
// or under .github/ISSUE_TEMPLATE/. An empty list is not docs-only.
//
// LIGHT PATH (the CLI answer): docs paths, library data (isLibraryPath), plus tests/unit/ and the tools that no CI job and no deploy runs (LIGHT_TOOL_FILES, LIGHT_TOOL_DIRS).
// Library data (data/library/<file>.json) is light because the visual gate reads the pinned tests/fixtures/library, never the live files (docs/runbooks/visual-baselines.md), and the unit job
// checks the library files themselves; a preview Worker adds nothing for it. The merge still deploys (the deploy workflow does not ignore data/library): the Worker merges the library into D1 then.
// Those changes are fully covered by the unit job, which always runs, so the preview, api, browser and layout jobs add nothing. Tools that a
// workflow, the deploy, the Pages bundle, the browser tests or the scope classifiers run (pages-bundle, static-server, ci-*, api-scope, stamps, ...) are NOT here.
// tests/unit/deploy-trigger.test.mjs pins this list against the deploy workflow's paths-ignore so neither can drift.
// Usage: <list of paths, one per line> | node tools/docs-only.mjs   (prints "true" or "false", the light-path answer)
import { pathToFileURL } from "node:url";

export function isDocsPath(p) {
  const path = String(p).trim().replace(/^\.\//, "");
  if (!path || path.includes("..")) return false;
  if (path.startsWith("docs/")) return true;
  if (path.startsWith(".github/ISSUE_TEMPLATE/")) return true;
  return !path.includes("/") && path.endsWith(".md");
}

// A library data file: data/library/<name>.json, one level only (no nested path, no other extension).
export function isLibraryPath(p) {
  const path = String(p).trim().replace(/^\.\//, "");
  return /^data\/library\/[A-Za-z0-9._-]+\.json$/.test(path) && !path.includes("..");
}

export const LIGHT_TOOL_FILES = Object.freeze(["add-member.mjs", "bench-ask-cpu.mjs", "check-secret-scope.sh", "claude-selftest.mjs", "cost-model.mjs", "deadman-status.mjs", "first-paint-measure.mjs", "grade-answers.mjs", "heartbeat-send.mjs", "images.mjs", "import-signups.mjs", "local-check.sh", "measure-claude-latency.mjs", "measure-research-cpu.mjs", "pull-export.mjs", "research-synthetic.mjs", "restore-drill.mjs", "restore-local.mjs", "rotate-salts.mjs", "shadow-ask.mjs", "source-probe.mjs", "source-probe.sources.json", "tooltips-compliance.mjs"]);
export const LIGHT_TOOL_DIRS = Object.freeze(["gateway-spike", "replay", "voice-eval"]);

// Light path: a docs path, a unit test, or a tool nothing in CI or the deploy runs. Unknown shapes are not light (they run everything).
export function isLightPath(p) {
  const path = String(p).trim().replace(/^\.\//, "");
  if (isDocsPath(path) || isLibraryPath(path)) return true;
  if (!path || path.includes("..") || path.includes("\\") || path.startsWith("/") || /[\u0000-\u001f"]/.test(path)) return false;
  if (path.startsWith("tests/unit/")) return true;
  if (!path.startsWith("tools/")) return false;
  const rest = path.slice("tools/".length);
  return LIGHT_TOOL_FILES.includes(rest) || LIGHT_TOOL_DIRS.some((d) => rest.startsWith(d + "/"));
}

export function isLightOnly(paths) {
  const list = paths.map((p) => String(p).trim()).filter(Boolean);
  return list.length > 0 && list.every(isLightPath);
}

export function isDocsOnly(paths) {
  const list = paths.map((p) => String(p).trim()).filter(Boolean);
  return list.length > 0 && list.every(isDocsPath);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  process.stdout.write(isLightOnly(input.split("\n")) ? "true\n" : "false\n");
}
