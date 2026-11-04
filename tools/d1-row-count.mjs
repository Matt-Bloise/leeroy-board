// Read the row count out of `wrangler d1 execute ... --command="SELECT COUNT(*) AS n ..." --json`. Node 22, no dependencies.
//
//   node tools/d1-row-count.mjs '<json>'     prints the count; exit 1 with a message on stderr unless it is a non-negative integer number
//
// FAIL CLOSED: the deploy seeds D1 when the count is 0 (seed-d1.mjs does INSERT OR REPLACE over kv_state). An unexpected wrangler output shape
// (empty, error object, renamed field, string, null) must therefore stop the deploy, never be read as 0 rows.
import { fileURLToPath } from "node:url";

export function rowCount(json) {
  let res;
  try { res = JSON.parse(json); } catch { throw new Error("the D1 count output is not JSON"); }
  const n = Array.isArray(res) && res[0] && Array.isArray(res[0].results) && res[0].results[0] ? res[0].results[0].n : undefined;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0) throw new Error("the D1 count output has no numeric results[0].n (unexpected wrangler output shape)");
  return n;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.stdout.write(String(rowCount(process.argv[2] || "")));
  } catch (e) {
    process.stderr.write(`d1-row-count: ${e.message}. Refusing to guess a row count; nothing was seeded.\n`);
    process.exitCode = 1;
  }
}
