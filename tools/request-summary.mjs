// Adds up the per-process request counts that tests/helpers/count-requests.mjs wrote and prints them into the job summary.
//   node tools/request-summary.mjs <log file> <job label>
// Lines are "<script> <count>"; processes that sent nothing (npm, the test runner itself) are left out of the table. Never fails the job: a missing or unreadable log prints a notice.
import { readFileSync, appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// -> { total, rows: [{ script, count }] }
export function sumRequests(text) {
  const by = new Map();
  for (const line of String(text || "").split("\n")) {
    const m = /^(\S+) (\d+)$/.exec(line.trim());
    if (!m) continue;
    by.set(m[1], (by.get(m[1]) || 0) + Number(m[2]));
  }
  const rows = [...by].map(([script, count]) => ({ script, count })).filter((r) => r.count > 0).sort((a, b) => b.count - a.count);
  return { total: rows.reduce((n, r) => n + r.count, 0), rows };
}

export function render(label, { total, rows }) {
  return [`### Worker requests sent by the ${label} job (measured)`, "", `**${total}** requests to the preview Worker (the account's daily budget is about 2,000 for all CI; a full run was estimated at about 250).`, "",
    ...(rows.length ? ["| test file | requests |", "| --- | ---: |", ...rows.map((r) => `| \`${r.script}\` | ${r.count} |`)] : ["No request was counted."])].join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [file, label = "test"] = process.argv.slice(2);
  let text = "";
  try { text = readFileSync(file, "utf8"); } catch { console.log(`::notice title=Request counter::no counter log at the given path; nothing was counted for the ${label} job.`); process.exit(0); }
  const out = render(label, sumRequests(text));
  console.log(out);
  if (process.env.GITHUB_STEP_SUMMARY) { try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, out + "\n"); } catch { /* best effort */ } }
}
