// Counts the Worker requests in a `wrangler dev` log between two line offsets and prints them grouped by path.
//   node tools/local-requests.mjs <log> <fromLine> [--json]      (fromLine = number of log lines before the suite started)
// wrangler prints one line per request, for example `[wrangler:inf] GET /api/health 200 OK (210ms)` (`[wrangler:info]` in other versions).
import { readFileSync } from "node:fs";
export function countRequests(text, fromLine = 0) {
  const lines = text.split(/\r?\n/).slice(fromLine), byPath = {};
  let total = 0;
  for (const l of lines) {
    const m = l.match(/\[wrangler:\w+\]\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)\s+(\d{3})/);
    if (!m) continue;
    const p = m[2].split("?")[0].replace(/\/(api\/(?:data|atlas|library))\/[^/]+$/, "/$1/*").replace(/\/[0-9a-f]{8,}(?=\/|$)/g, "/:id");
    const k = `${m[1]} ${p}`;
    byPath[k] = (byPath[k] || 0) + 1; total++;
  }
  return { total, byPath };
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const [log, from] = process.argv.slice(2), r = countRequests(readFileSync(log, "utf8"), Number(from || 0));
  if (process.argv.includes("--json")) console.log(JSON.stringify(r));
  else {
    console.log(`Worker requests: ${r.total}`);
    for (const [k, n] of Object.entries(r.byPath).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) console.log(`  ${String(n).padStart(6)}  ${k}`);
  }
}
