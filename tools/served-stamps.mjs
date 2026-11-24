// Says which commit a live smoke tested: compares the ?v= stamps in the first page the site SERVES with the ?v= stamps in index.html of the CHECKED-OUT commit.
// A stamp is the first 10 hex of the sha256 of the file it names (tools/stamps.mjs), so equal stamps mean the served site files equal this commit's. A commit that changes no site file cannot be told
// from the one before it this way; /api/health reports no commit. That is the limit of what a plain GET can prove, and the output says "site files equal" and never "deployed".
// Exit 0: every stamp matches. Exit 1: they differ after every attempt. Exit 2: it could not tell (no stamp found, the page did not load, bad arguments). Never exits 0 when it could not tell.
// Each attempt is one GET of the page (a Pages request, and one more Worker request if pages-worker answers it). Default: 6 attempts, 20 s apart, so a deploy that is still reaching the edge has about 2 minutes.
// Usage: node tools/served-stamps.mjs --url https://leeroy.party/ [--local index.html] [--attempts 6] [--wait 20]
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const STAMP = /(?:src|href)="([^"]+\?v=[0-9a-f]{10})"/g;

// The sorted unique "<path>?v=<stamp>" references of a page. Edge injections (email-decode, analytics beacon) carry no ?v= stamp, so they never appear here.
export function stampsOf(html) {
  const out = new Set();
  for (const m of String(html).replace(/\r/g, "").matchAll(STAMP)) out.add(m[1]);
  return [...out].sort();
}

// { ok, reason, missing, extra }: ok only when the local page has at least one stamp and the two sets are equal.
export function compareStamps(localHtml, servedHtml) {
  const local = stampsOf(localHtml), served = stampsOf(servedHtml);
  if (local.length === 0) return { ok: false, unknown: true, reason: "the checked-out index.html holds no ?v= stamp, so the commit cannot be told", missing: [], extra: [] };
  if (served.length === 0) return { ok: false, unknown: true, reason: "the served page holds no ?v= stamp, so the commit cannot be told", missing: local, extra: [] };
  const missing = local.filter((s) => !served.includes(s)), extra = served.filter((s) => !local.includes(s));
  return missing.length || extra.length ? { ok: false, reason: `served and checked-out stamps differ (${missing.length} only here, ${extra.length} only served)`, missing, extra } : { ok: true, reason: `${local.length} stamps equal`, missing, extra };
}

async function main(argv, env) {
  const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const url = arg("--url"), localPath = arg("--local", "index.html");
  const attempts = Math.max(1, Number(arg("--attempts", "6"))), wait = Math.max(0, Number(arg("--wait", "20")));
  if (!url || !Number.isFinite(attempts) || !Number.isFinite(wait)) { console.error("usage: node tools/served-stamps.mjs --url <site origin> [--local index.html] [--attempts 6] [--wait 20]"); return 2; }
  let localHtml;
  try { localHtml = readFileSync(localPath, "utf8"); } catch (e) { console.error(`SERVED-STAMPS unknown: cannot read ${localPath}: ${e.message}`); return 2; }
  const sha = (env.GITHUB_SHA || "unknown").slice(0, 8);
  let last = null;
  for (let i = 1; i <= attempts; i++) {
    let servedHtml = null, why = "";
    try { const r = await fetch(url, { cache: "no-store", headers: { accept: "text/html" }, signal: AbortSignal.timeout(20000) }); if (r.status === 200) servedHtml = await r.text(); else why = `HTTP ${r.status}`; } catch (e) { why = String(e.message || e); }
    last = servedHtml === null ? { ok: false, unknown: true, reason: `the page did not load (${why})`, missing: [], extra: [] } : compareStamps(localHtml, servedHtml);
    console.log(`SERVED-STAMPS attempt ${i}/${attempts}: ${last.ok ? "match" : last.reason}`);
    if (last.ok) { console.log(`SERVED-STAMPS ok: ${url} serves the site files of commit ${sha} (${last.reason})`); return 0; }
    if (i < attempts) await new Promise((r) => setTimeout(r, wait * 1000));
  }
  for (const s of last.missing.slice(0, 10)) console.log(`  only in commit ${sha}: ${s}`);
  for (const s of last.extra.slice(0, 10)) console.log(`  only served:        ${s}`);
  console.log(`SERVED-STAMPS ${last.unknown ? "unknown" : "mismatch"}: could not show that ${url} serves commit ${sha}: ${last.reason}`);
  return last.unknown ? 2 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) process.exit(await main(process.argv.slice(2), process.env));
