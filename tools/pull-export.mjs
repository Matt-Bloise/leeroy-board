#!/usr/bin/env node
// Pull a full backup from GET /api/admin/export into one NDJSON file, page by page. Read only: it never writes to the Worker.
//
//   BOARD_ADMIN_TOKEN=... node tools/pull-export.mjs --api <origin> --out <file.ndjson> [--limit 200] [--tables a,b]
//
//   --api <origin>   Worker origin, for example the local `wrangler dev` address or https://api.leeroy.party. Required, so a run never
//                    points at production by accident.
//   --out <file>     Where to write. Must be OUTSIDE this repository: the file holds personal data (names, questions, user keys).
//   --limit <n>      Rows per page (the Worker caps it at 1000). Default 200.
//   --tables <list>  Only these tables (comma separated). Default: every table the manifest lists.
//
// The token comes from the environment only and is never printed. Which tables and columns are left out is decided by the Worker
// (infrastructure/worker/export.js: member key hashes, session and OAuth tokens, rate-limit hashes, secret* config rows).
// Restore it into a scratch local database with tools/restore-local.mjs; see docs/runbooks/backup-restore.md.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const insideRepo = (file) => { const rel = path.relative(REPO, path.resolve(file)); return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel)); };

export function parseArgv(argv) {
  const o = {}, flags = new Set(["help"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    const k = a.slice(2);
    if (!["api", "out", "limit", "tables", "help"].includes(k)) throw new Error(`unknown option --${k}`);
    if (flags.has(k)) o[k] = true;
    else { if (argv[i + 1] === undefined || argv[i + 1].startsWith("--")) throw new Error(`--${k} needs a value`); o[k] = argv[++i]; }
  }
  return o;
}

// Pulls everything and returns { lines, tables: { name: rows }, pages }. `fetchImpl` is injectable for tests.
export async function pull({ api, token, limit = 200, tables = null, fetchImpl = fetch }) {
  const base = api.replace(/\/$/, ""), head = { authorization: `Bearer ${token}`, accept: "application/x-ndjson" };
  const get = async (q) => {
    const r = await fetchImpl(`${base}/api/admin/export${q}`, { headers: head });
    if (!r.ok) throw new Error(`GET /api/admin/export${q ? "?" + q.slice(1).split("&")[0] : ""} answered ${r.status}`);
    return (await r.text()).split("\n").filter(Boolean);
  };
  const out = [], counts = {};
  const manifest = await get("");
  out.push(...manifest);
  const names = manifest.map((l) => JSON.parse(l)).filter((l) => l.t === "table").map((l) => l.table).filter((t) => !tables || tables.includes(t));
  let pages = 0;
  for (const t of names) {
    counts[t] = 0;
    let after = 0;
    for (;;) {
      const lines = await get(`?table=${encodeURIComponent(t)}&after=${after}&limit=${limit}`);
      pages++;
      const end = JSON.parse(lines[lines.length - 1] || "{}");
      if (end.t !== "end" || end.table !== t) throw new Error(`page of ${t} after ${after} did not finish with an end line`);
      out.push(...lines);
      counts[t] += end.rows;
      if (end.next === null || end.next === undefined) break;
      if (!(end.next > after)) throw new Error(`cursor for ${t} did not advance`);
      after = end.next;
    }
  }
  return { lines: out, tables: counts, pages };
}

async function main() {
  let o;
  try { o = parseArgv(process.argv.slice(2)); } catch (e) { console.error(`error: ${e.message}`); process.exit(2); }
  if (o.help) { console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n")); return; }
  const token = process.env.BOARD_ADMIN_TOKEN;
  if (!token) { console.error("error: BOARD_ADMIN_TOKEN is not set (environment only)"); process.exit(2); }
  if (!o.api || !o.out) { console.error("error: --api and --out are required"); process.exit(2); }
  if (insideRepo(o.out)) { console.error("error: --out is inside this repository; the file holds personal data. Choose a path outside it."); process.exit(2); }
  const limit = o.limit === undefined ? 200 : Number(o.limit);
  if (!Number.isSafeInteger(limit) || limit < 1) { console.error("error: --limit must be a whole number, 1 or more"); process.exit(2); }
  let res;
  try { res = await pull({ api: o.api, token, limit, tables: o.tables ? o.tables.split(",").map((s) => s.trim()).filter(Boolean) : null }); }
  catch (e) { console.error(`stopped: ${e.message}. Nothing was written.`); process.exit(1); }
  fs.writeFileSync(o.out, res.lines.join("\n") + "\n", { mode: 0o600 });
  console.log(`wrote ${o.out} (${res.lines.length} lines, ${res.pages} pages)`);
  for (const [t, n] of Object.entries(res.tables)) console.log(`  ${t.padEnd(24)} ${String(n).padStart(7)} rows`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
