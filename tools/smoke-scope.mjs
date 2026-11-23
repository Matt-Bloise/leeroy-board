// Decides whether a pull request can change what the game-facts smoke proves (tools/d1-facts-smoke.mjs, step "Prove the game_facts store on the real preview D1" in
// pr-preview-cloudflare.yml). The smoke writes rows to the real preview D1 on every spin-up it runs, so it runs only when something it exercises changed:
//   the Worker lookup and the loader statements (game-facts.js, game-facts-lookup.js, game-facts-name.js), the loader cost constants (tools/facts-load.mjs), the smoke itself,
//   the schema and the migrations (a new migration can change the table), the wrangler version and config and the export and restore code the smoke runs (infrastructure/package*.json, wrangler.toml, worker/export.js,
//   tools/restore-drill.mjs, scripts/seed-d1.mjs), and the preview workflow (the wiring). The composer (game-facts-compose.js) and the reader (game-facts-read.js)
//   run no SQL of their own against the table in the smoke, so they are not here.
// Fails open: an empty list or an unknown shape (absolute, backslash, quoted, parent segment, control character) runs the smoke. A skipped smoke prints a notice with the reason.
// Usage: <list of paths, one per line> | node tools/smoke-scope.mjs   (prints "true" when the smoke must run, else "false")
import { pathToFileURL } from "node:url";

export const SMOKE_FILES = Object.freeze([
  "infrastructure/worker/game-facts.js",
  "infrastructure/worker/game-facts-lookup.js",
  "infrastructure/worker/game-facts-name.js",
  "infrastructure/schema.sql",
  "infrastructure/package.json", // a wrangler bump changes what `d1 execute --json` and `d1 export --remote` print, and the export is one of the smoke's assertions
  "infrastructure/package-lock.json",
  "infrastructure/wrangler.toml",
  "infrastructure/scripts/seed-d1.mjs",
  "infrastructure/worker/export.js",
  "infrastructure/worker/kv-cas.js", // imported by game-facts.js
  "tools/restore-drill.mjs", // the smoke runs the restore drill
  "tools/facts-load.mjs",
  "tools/d1-facts-smoke.mjs",
  ".github/workflows/pr-preview-cloudflare.yml",
]);
export const SMOKE_PREFIXES = Object.freeze(["infrastructure/migrations/"]);

export function touchesSmoke(p) {
  let path = String(p).trim();
  if (!path) return false;
  if (path.startsWith("/") || path.includes("\\") || path.startsWith('"') || path.includes("..") || /[\u0000-\u001f]/.test(path)) return true; // unknown shape: run it
  path = path.replace(/^(\.\/)+/, "");
  if (!path || path.endsWith("/")) return true;
  return SMOKE_FILES.includes(path) || SMOKE_PREFIXES.some((d) => path.startsWith(d));
}

export function smokeNeeded(paths) {
  const list = paths.map((p) => String(p).trim()).filter(Boolean);
  if (list.length === 0) return true; // could not classify: run it
  return list.some(touchesSmoke);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  process.stdout.write(smokeNeeded(input.split("\n")) ? "true\n" : "false\n");
}
