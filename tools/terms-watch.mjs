// Fetch the watched Blizzard pages, hash their visible text, compare with
// docs/compliance/terms-hashes.json. Writes a markdown report to --report <file> when
// something changed. Exit 0 always except on bad usage: a page that cannot be fetched is
// logged and skipped (no report, no issue). Add --write to store the current hashes.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const FILE = new URL("../docs/compliance/terms-hashes.json", import.meta.url);
const sha = (s) => createHash("sha256").update(s).digest("hex");
const args = process.argv.slice(2);
const write = args.includes("--write");
const reportPath = args.includes("--report") ? args[args.indexOf("--report") + 1] : null;

export function visibleLines(html) {
  const text = html
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|br)\s*>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;|&rsquo;|&lsquo;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
  return text.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
}

async function fetchLines(url) {
  const res = await fetch(url, { redirect: "follow", headers: { "user-agent": "leeroy-board-terms-watch/1 (+https://leeroy.party)", accept: "text/html" }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const lines = visibleLines(await res.text());
  if (lines.join(" ").length < 500) throw new Error("page text too short (likely a script-rendered shell or block page)");
  return lines;
}

const doc = JSON.parse(readFileSync(FILE, "utf8"));
const sections = [];
for (const [key, page] of Object.entries(doc.pages)) {
  let lines;
  try { lines = await fetchLines(page.url); } catch (e) { console.log(`${key}: could not fetch ${page.url}: ${e.message}. No issue opened.`); continue; }
  const hash = sha(lines.join("\n"));
  const lineHashes = lines.map((l) => sha(l).slice(0, 16));
  if (page.hash === hash) { console.log(`${key}: unchanged (${hash.slice(0, 12)})`); continue; }
  const old = new Set(page.lines || []), cur = new Set(lineHashes);
  const added = lines.filter((l, i) => !old.has(lineHashes[i]));
  const removed = (page.lines || []).filter((h) => !cur.has(h)).length;
  console.log(`${key}: CHANGED ${page.hash ? page.hash.slice(0, 12) : "(no baseline)"} -> ${hash.slice(0, 12)}`);
  sections.push([
    `### ${key}`, `URL: ${page.url}`,
    `Old hash: \`${page.hash || "none (no baseline)"}\``, `New hash: \`${hash}\``,
    page.hash ? `Visible lines: ${added.length} added or changed, ${removed} removed or changed.` : "No baseline was stored, so a line diff is not possible. Review the whole page.",
    ...(page.hash && added.length ? ["", "First added or changed lines (truncated):", ...added.slice(0, 15).map((l) => `- ${l.length > 200 ? l.slice(0, 200) + "..." : l}`)] : []),
  ].join("\n"));
  if (write) { page.hash = hash; page.lines = lineHashes; }
}
if (write) writeFileSync(FILE, JSON.stringify(doc, null, 2) + "\n");
if (sections.length && reportPath) {
  writeFileSync(reportPath, [
    "The watched Blizzard page text changed (or has no stored baseline).", "",
    ...sections.flatMap((s) => [s, ""]),
    "To clear this issue: read the changed page, update `docs/compliance/blizzard-checklist.md` if a rule changed, then commit new hashes with `node tools/terms-watch.mjs --write` run from a network that can reach the pages.",
  ].join("\n"));
}
