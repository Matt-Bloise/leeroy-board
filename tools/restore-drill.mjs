#!/usr/bin/env node
// Restore drill: prove a backup restores, with numbers. Local only, nothing leaves the machine, no AI, no Cloudflare account, no secrets.
//
//   node tools/restore-drill.mjs [--backend wrangler|sqlite] [--port 8799] [--keep] [--expect <file>]
//
//   --backend wrangler  (default) a real local D1: `wrangler d1 execute --local` and `wrangler dev --local` (needs `cd infrastructure && npm install`).
//   --backend sqlite    the same steps on in-process SQLite through the real Worker route. Offline, no wrangler. tests/unit/restore-drill.test.mjs runs this one.
//   --port <n>          port for the local `wrangler dev` (wrangler backend only). Default 8799.
//   --keep              keep the temporary folder (wrangler backend) instead of deleting it.
//   --expect <file>     compare the printed report with this file, line by line, and fail on any difference
//                       (the expected report is tests/fixtures/restore-drill.expected.txt; docs/runbooks/restore-drill.md).
//
// Steps: (1) seed a source database from schema.sql with made-up fixtures (secret-looking values included), (2) export it through GET /api/admin/export
// (admin token made up for the run), (3) checksum every exported table in the SOURCE database, (4) WIPE: delete the database, (5) restore the export into a
// fresh database, (6) checksum the restored tables and diff row counts and checksums table by table. Exit 0 only if every table matches, no secret value
// reached the export, and every table that is never exported came back empty. A checksum is sha256 over the exported columns of every row in rowid order,
// so it catches a changed value that a row count cannot. The members key_hash column is not exported (keys are re-issued after a restore), so it is not in the checksum.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pull } from "./pull-export.mjs";
import { parseExport, buildSql, restore } from "./restore-local.mjs";
import { ROW_FILTERS, EXCLUDED_TABLES } from "../infrastructure/worker/export.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), INFRA = path.join(ROOT, "infrastructure");
export const TOKEN = "drill-admin-token-0123456789abcdef";
const SALT = "drill-salt-0123456789abcdef";
export const SECRETS = ["k".repeat(64), "t".repeat(64), "CIPHERTEXT-drill", "iphash-drill", "SECRET-DRILL-VALUE", "e".repeat(64)];
const U = "100000000000000001";
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

// ---- fixtures: made-up, deterministic (the report below is byte for byte the same on every run and on both backends)
export function fixtureSql() {
  const out = [];
  out.push(`INSERT INTO members (slug, key_hash, created_at) VALUES ('santa', ${q(SECRETS[0])}, 'now'), ('rudolf', ${q("r".repeat(64))}, 'now');`);
  out.push(`INSERT INTO sessions (token_hash, user_key, created_at, expires_at, last_seen) VALUES (${q(SECRETS[1])}, ${q("f".repeat(64))}, 1, 2, 3);`);
  out.push(`INSERT INTO user_state (user_key, doc, etag, json, updated_at) VALUES (${q("f".repeat(64))}, 'prefs', 'e', ${q('{"keys":{"a":{"v":"it\'s fine","t":1}}}')}, 1);`);
  out.push(`INSERT INTO users (discord_user_id, display_name, created_at) VALUES ('${U}', ${q("Tester O'Neil")}, 'now');`);
  out.push(`INSERT INTO sessions_v2 (token_hash, discord_user_id, created_at, expires_at) VALUES (${q(SECRETS[5])}, '${U}', '2026-01-01', '2026-02-01');`);
  out.push(`INSERT INTO provider_tokens (discord_user_id, provider, access_token_enc, updated_at) VALUES ('${U}', 'discord', ${q(SECRETS[2])}, 'now');`);
  out.push(`INSERT INTO guest_rate_limits (ip_hash, created_at) VALUES (${q(SECRETS[3])}, 1);`);
  out.push(`INSERT INTO tenants (id, discord_guild_id, name, status, created_at) VALUES ('t1', '200000000000000001', 'Guild', 'active', 'now');`);
  out.push(`INSERT INTO characters (id, tenant_id, discord_user_id, name, realm, region, class, created_at) VALUES ('c1', 't1', '${U}', 'Pip', 'Normal|EU', 'eu', 'Mage', 'now');`);
  out.push(`INSERT INTO character_profiles (character_id, race, faction, ruleset, region_label, selected) VALUES ('c1', 'Gnome', 'Alliance', 'Normal', 'EU', 1);`);
  out.push(`INSERT INTO builds (id, character_id, source, status, title, data_json, created_at) VALUES ('b1', 'c1', 'web', 'draft', 'T', '{}', 'now');`);
  out.push(`INSERT INTO kv_state (key, json, updated_at) VALUES ('party', ${q('{"members":[{"name":"Línea ünï \u{1F9D9}"}]}')}, 'now'), ('signups', '{"entries":[]}', 'now'), ('secret_x', ${q(SECRETS[4])}, 'now'), ('feed_cache:stats', '{}', 'now');`);
  for (let i = 0; i < 450; i++) out.push(`INSERT INTO intents (at, slug, kind, body, ver) VALUES ('now', 'santa', 'signup', ${q(JSON.stringify({ n: i, note: i % 7 === 0 ? "it's" : null }))}, 1);`);
  out.push(`INSERT INTO ask_turns (id, by_name, question, status, created_at) VALUES ('a1', 'Tester', 'Where is the bank?', 'error', 'now');`);
  out.push(`INSERT INTO request_gauge (day, n) VALUES ('2026-11-02', 15600), ('2026-11-03', 4210);`);
  out.push(`INSERT INTO noise_ledger (day, channel, n) VALUES ('2026-11-03', 'chan-1', 2);`);
  return out.join("\n") + "\n";
}

// ---- checksums
// Every value is read as SQL quote(value): NULL, 'null', 1 and '1' stay four different texts, whatever the driver does with types
// (wrangler's --json prints a SQL NULL as the string "null"; a plain SELECT would not tell them apart).
const sha = (rows, cols) => createHash("sha256").update(rows.map((r) => JSON.stringify(cols.map((c) => String(r[c])))).join("\n")).digest("hex");
const selectSql = (t, cols) => `SELECT ${cols.map((c) => `quote("${c}") AS "${c}"`).join(", ")} FROM "${t}"${ROW_FILTERS[t] ? ` WHERE ${ROW_FILTERS[t]}` : ""} ORDER BY rowid;`;
const SYSTEM = /^(sqlite_|_cf_|d1_)/;
const tablesSql = "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY rowid;";

// ---- backends. Each: { name, setup(sql), exportText(), query(sqls) -> [rows[]], wipe(), restoreFrom(text) -> {ok, problems?}, dispose() }
export async function sqliteBackend() {
  const { schemaDb } = await import("../tests/helpers/sqlite-d1.mjs");
  const { default: worker } = await import("../infrastructure/worker/index.js");
  let db = null;
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  return {
    name: "sqlite (in-process, no wrangler)",
    async setup(sql) { db = schemaDb(); db.raw.exec(sql); },
    async exportText() {
      const fetchImpl = async (url, init) => { const u = new URL(url); return worker.fetch(new Request(`https://api.test${u.pathname}${u.search}`, init), { DB: db, BOARD_ADMIN_TOKEN: TOKEN, ALLOWED_ORIGINS: "" }, ctx); };
      const denied = await fetchImpl("https://api.test/api/admin/export", {});
      if (denied.status !== 401) throw new Error(`export without a token answered ${denied.status}, expected 401`);
      return (await pull({ api: "https://api.test", token: TOKEN, limit: 200, fetchImpl })).lines.join("\n") + "\n";
    },
    async query(sqls) { return sqls.map((s) => db.raw.prepare(s.replace(/;\s*$/, "")).all().map((r) => ({ ...r }))); },
    async wipe() { db = null; },
    async restoreFrom(text) {
      const parsed = parseExport(text);
      if (parsed.problems.length) return { ok: false, problems: parsed.problems };
      db = schemaDb();
      db.raw.exec(["BEGIN", "PRAGMA defer_foreign_keys = true", ...buildSql(parsed), "COMMIT"].map((s) => s + ";").join("\n"));
      return { ok: true };
    },
    async dispose() { db = null; },
  };
}

export async function wranglerBackend({ port = 8799, keep = false, log = () => {} } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "restore-drill-")), dir = path.join(tmp, "d1");
  const wr = (args) => {
    const r = spawnSync("npx", ["wrangler", ...args], { cwd: INFRA, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`wrangler ${args.slice(0, 3).join(" ")} failed: ${String(r.stderr || r.stdout).split("\n").filter((l) => /error|failed|SQLITE/i.test(l)).slice(0, 2).join(" | ") || "see wrangler output"}`);
    return r.stdout;
  };
  const d1 = (extra) => wr(["d1", "execute", "leeroy-board-db", "--local", "--persist-to", dir, ...extra]);
  const jsonOf = (stdout) => { const i = stdout.search(/^\[/m); if (i < 0) throw new Error("wrangler printed no JSON"); return JSON.parse(stdout.slice(i)); };
  return {
    name: "wrangler --local (real local D1)",
    async setup(sql) {
      d1(["--file", path.join(INFRA, "schema.sql")]);
      const f = path.join(tmp, "fixtures.sql"); fs.writeFileSync(f, sql); d1(["--file", f]);
    },
    async exportText() {
      const dev = spawn("npx", ["wrangler", "dev", "--local", "--port", String(port), "--persist-to", dir, "--var", `BOARD_ADMIN_TOKEN:${TOKEN}`, "--var", `KEY_SALT:${SALT}`, "--var", `USER_SALT:${SALT}`], { cwd: INFRA, stdio: ["ignore", "pipe", "pipe"], detached: true });
      let out = ""; dev.stdout.on("data", (d) => { out += d; }); dev.stderr.on("data", (d) => { out += d; });
      try {
        for (let i = 0; i < 90 && !/Ready on/.test(out); i++) { if (dev.exitCode !== null) throw new Error(`wrangler dev exited: ${out.slice(-300)}`); await new Promise((r) => setTimeout(r, 1000)); }
        if (!/Ready on/.test(out)) throw new Error("wrangler dev did not become ready in 90 seconds");
        const api = `http://127.0.0.1:${port}`;
        const denied = await fetch(`${api}/api/admin/export`);
        if (denied.status !== 401) throw new Error(`export without a token answered ${denied.status}, expected 401`);
        return (await pull({ api, token: TOKEN, limit: 200 })).lines.join("\n") + "\n";
      } finally { // npx starts wrangler which starts workerd: stop the whole group
        for (const sig of ["SIGTERM", "SIGKILL"]) { try { process.kill(-dev.pid, sig); } catch (e) { break; } await new Promise((r) => setTimeout(r, 700)); }
      }
    },
    async query(sqls) {
      const f = path.join(tmp, `q-${Date.now()}.sql`); fs.writeFileSync(f, sqls.join("\n") + "\n");
      const res = jsonOf(d1(["--json", "--file", f]));
      if (res.length !== sqls.length) throw new Error(`wrangler returned ${res.length} results for ${sqls.length} statements`);
      return res.map((r) => r.results || []);
    },
    async wipe() { fs.rmSync(dir, { recursive: true, force: true }); if (fs.existsSync(dir)) throw new Error("the database folder is still there after the wipe"); },
    async restoreFrom(text) {
      const f = path.join(tmp, "export.ndjson"); fs.writeFileSync(f, text, { mode: 0o600 });
      const r = restore({ file: f, persistTo: dir });
      return r.problems ? { ok: false, problems: r.problems } : { ok: r.ok, problems: r.ok ? undefined : ["restore-local reported a count mismatch"] };
    },
    async dispose() { if (!keep) fs.rmSync(tmp, { recursive: true, force: true }); else log(`kept ${tmp}`); },
  };
}

// ---- the drill. -> { ok, lines: [string], failures: [string] }. `tamper(text)` lets a test damage the export to prove the drill can fail.
export async function runDrill(backend, { tamper = null, fixtures = fixtureSql() } = {}) {
  const lines = [], failures = [], say = (m = "") => lines.push(m), fail = (m) => { failures.push(m); say(`FAIL ${m}`); };
  say(`RESTORE DRILL (backend: ${backend.name})`);
  await backend.setup(fixtures);
  const srcTables = (await backend.query([tablesSql]))[0].map((r) => r.name).filter((n) => !SYSTEM.test(n));
  say(`1. source database: ${srcTables.length} tables from schema.sql, seeded with ${fixtures.split("\n").filter(Boolean).length} fixture statements`);

  let text = await backend.exportText();
  const secretHit = SECRETS.filter((s) => text.includes(s));
  if (tamper) text = tamper(text);
  const parsed = parseExport(text);
  if (parsed.problems.length) { for (const p of parsed.problems) fail(`export file: ${p}`); return { ok: false, lines, failures }; }
  const exported = parsed.order, excluded = parsed.excluded;
  say(`2. export: ${exported.length} tables exported, ${excluded.length} never exported (${excluded.join(", ")}), ${text.split("\n").filter(Boolean).length} lines`);
  if (secretHit.length) fail(`${secretHit.length} secret value(s) reached the export file`); else say(`   no secret value in the export file (${SECRETS.length} checked)`);
  const unclassified = srcTables.filter((t) => !exported.includes(t) && !excluded.includes(t));
  for (const t of unclassified) fail(`table ${t} is neither exported nor excluded`);
  for (const t of excluded) if (!Object.prototype.hasOwnProperty.call(EXCLUDED_TABLES, t)) fail(`table ${t} is reported excluded but is not in EXCLUDED_TABLES`);

  const measure = async () => {
    const sqls = [...exported.map((t) => `SELECT COUNT(*) AS n FROM "${t}"${ROW_FILTERS[t] ? ` WHERE ${ROW_FILTERS[t]}` : ""};`), ...exported.map((t) => selectSql(t, parsed.tables.get(t).columns)), ...excluded.map((t) => `SELECT COUNT(*) AS n FROM "${t}";`)];
    const res = await backend.query(sqls), m = { exported: {}, excluded: {} };
    exported.forEach((t, i) => { m.exported[t] = { n: Number(res[i][0].n), sha: sha(res[exported.length + i], parsed.tables.get(t).columns) }; });
    excluded.forEach((t, i) => { m.excluded[t] = Number(res[2 * exported.length + i][0].n); });
    return m;
  };
  const before = await measure();
  say(`3. checksums of the source: ${exported.length} tables, ${Object.values(before.exported).reduce((a, b) => a + b.n, 0)} rows`);
  await backend.wipe();
  say("4. wipe: the database is deleted");
  const r = await backend.restoreFrom(text);
  if (!r.ok) { for (const p of r.problems || ["restore failed"]) fail(`restore: ${p}`); return { ok: false, lines, failures }; }
  const after = await measure();
  say("5. restore: a fresh database is built from schema.sql and loaded from the export");
  say("6. diff, table by table (rows and sha256 of the exported columns; source vs restored)");
  const empty = [];
  for (const t of exported) {
    const a = before.exported[t], b = after.exported[t], rowsOk = a.n === b.n, shaOk = a.sha === b.sha;
    if (a.n === 0 && b.n === 0 && shaOk) { empty.push(t); continue; } // nothing to compare; listed once below so an empty table is never mistaken for a tested one
    say(`   ${rowsOk && shaOk ? "ok  " : "FAIL"} ${t.padEnd(22)} rows ${String(a.n).padStart(4)} -> ${String(b.n).padStart(4)}   sha256 ${a.sha.slice(0, 16)} ${shaOk ? "==" : "!="} ${b.sha.slice(0, 16)}`);
    if (!rowsOk) failures.push(`${t}: rows ${a.n} -> ${b.n}`);
    if (!shaOk) failures.push(`${t}: checksum differs`);
  }
  if (empty.length) say(`   ok   ${empty.length} tables are empty in the fixtures (0 -> 0, nothing to compare, not tested): ${empty.join(", ")}`);
  for (const t of excluded) {
    const ok = after.excluded[t] === 0;
    say(`   ${ok ? "ok  " : "FAIL"} ${t.padEnd(22)} rows ${String(before.excluded[t]).padStart(4)} -> ${String(after.excluded[t]).padStart(4)}   never exported: comes back empty (by design)`);
    if (!ok) failures.push(`${t}: not empty after restore`);
  }
  const total = Object.values(after.exported).reduce((x, y) => x + y.n, 0);
  say("");
  say(failures.length ? `RESTORE DRILL FAILED: ${failures.length} problem(s)` : `RESTORE DRILL PASSED: ${exported.length} tables, ${total} rows, every count and checksum matches`);
  return { ok: failures.length === 0, lines, failures };
}

export function parseArgv(argv) {
  const o = {}, flags = new Set(["keep", "help"]), known = new Set(["backend", "port", "expect", ...flags]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    const k = a.slice(2);
    if (!known.has(k)) throw new Error(`unknown option --${k}${k === "remote" ? " (this tool is local only)" : ""}`);
    if (flags.has(k)) o[k] = true;
    else { if (argv[i + 1] === undefined || argv[i + 1].startsWith("--")) throw new Error(`--${k} needs a value`); o[k] = argv[++i]; }
  }
  return o;
}

async function main() {
  let o;
  try { o = parseArgv(process.argv.slice(2)); } catch (e) { console.error(`error: ${e.message}`); process.exit(2); }
  if (o.help) { console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n")); return; }
  const which = o.backend || "wrangler";
  if (!["wrangler", "sqlite"].includes(which)) { console.error("error: --backend is wrangler or sqlite"); process.exit(2); }
  const port = o.port === undefined ? 8799 : Number(o.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) { console.error("error: --port must be a port number"); process.exit(2); }
  if (which === "wrangler" && !fs.existsSync(path.join(INFRA, "node_modules", ".bin", "wrangler"))) { console.error("error: wrangler is not installed. Run: cd infrastructure && npm install (or use --backend sqlite)"); process.exit(2); }
  const backend = which === "sqlite" ? await sqliteBackend() : await wranglerBackend({ port, keep: !!o.keep, log: (m) => console.log(m) });
  let res;
  try { res = await runDrill(backend); }
  catch (e) { console.error(`DRILL STOPPED: ${e.message}`); await backend.dispose(); process.exit(1); }
  await backend.dispose();
  console.log(res.lines.join("\n"));
  if (o.expect && res.ok) {
    const want = fs.readFileSync(o.expect, "utf8").replace(/\n$/, "").split("\n"), got = res.lines.slice(1); // line 1 names the backend and differs by design
    const bad = got.map((l, i) => (l === want[i - 0] ? null : i)).filter((i) => i !== null);
    if (got.length !== want.length || bad.length) { console.error(`\nreport differs from ${o.expect} at line(s): ${bad.slice(0, 5).map((i) => i + 2).join(", ")}`); process.exit(1); }
    console.log(`\nreport matches ${path.relative(process.cwd(), o.expect)}`);
  }
  process.exit(res.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
