// Restore drill against a REAL local D1 (wrangler --local). Not part of `node --test tests/unit/*`: it needs infrastructure/node_modules (npm install there)
// and starts `wrangler dev` on a local port. Nothing leaves the machine and no AI is called: the Worker is started with a throwaway admin token and
// salts passed on the command line (local only, made up here), against a temporary database folder that is deleted at the end.
//   node tests/local/restore-drill.mjs [--port 8799] [--keep]
// Steps: build a source database from schema.sql and seed it with made-up rows (including secret-looking values), start the Worker on it, pull the
// export through GET /api/admin/export, restore the export into a second, fresh local database, compare every table count, and check that no secret
// value reached the export file. Exit 0 only if everything matches. Prints the count table for the PR.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pull } from "../../tools/pull-export.mjs";
import { restore, parseExport } from "../../tools/restore-local.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."), INFRA = path.join(ROOT, "infrastructure");
const argv = process.argv.slice(2), port = Number(argv[argv.indexOf("--port") + 1]) || 8799, keep = argv.includes("--keep");
const TOKEN = "drill-admin-token-0123456789abcdef", SALT = "drill-salt-0123456789abcdef";
const SECRETS = ["k".repeat(64), "t".repeat(64), "CIPHERTEXT-drill", "iphash-drill", "SECRET-DRILL-VALUE"];
const U = "100000000000000001";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "restore-drill-")), src = path.join(tmp, "src"), dst = path.join(tmp, "dst"), exportFile = path.join(tmp, "export.ndjson");

const wr = (args) => { const r = spawnSync("npx", ["wrangler", ...args], { cwd: INFRA, encoding: "utf8" }); if (r.status !== 0) throw new Error(`wrangler ${args.slice(0, 3).join(" ")} failed: ${(r.stderr || r.stdout).split("\n").filter((l) => /error/i.test(l)).slice(0, 2).join(" | ")}`); return r.stdout; };
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
function seedSql() {
  const out = [];
  out.push(`INSERT INTO members (slug, key_hash, created_at) VALUES ('santa', ${q(SECRETS[0])}, 'now'), ('rudolf', ${q("r".repeat(64))}, 'now');`);
  out.push(`INSERT INTO sessions (token_hash, user_key, created_at, expires_at, last_seen) VALUES (${q(SECRETS[1])}, ${q("f".repeat(64))}, 1, 2, 3);`);
  out.push(`INSERT INTO user_state (user_key, doc, etag, json, updated_at) VALUES (${q("f".repeat(64))}, 'prefs', 'e', ${q('{"keys":{"a":{"v":"it\'s fine","t":1}}}')}, 1);`);
  out.push(`INSERT INTO users (discord_user_id, display_name, created_at) VALUES ('${U}', ${q("Tester O'Neil")}, 'now');`);
  out.push(`INSERT INTO provider_tokens (discord_user_id, provider, access_token_enc, updated_at) VALUES ('${U}', 'discord', ${q(SECRETS[2])}, 'now');`);
  out.push(`INSERT INTO guest_rate_limits (ip_hash, created_at) VALUES (${q(SECRETS[3])}, 1);`);
  out.push(`INSERT INTO tenants (id, discord_guild_id, name, status, created_at) VALUES ('t1', '200000000000000001', 'Guild', 'active', 'now');`);
  out.push(`INSERT INTO characters (id, tenant_id, discord_user_id, name, realm, region, class, created_at) VALUES ('c1', 't1', '${U}', 'Pip', 'Normal|EU', 'eu', 'Mage', 'now');`);
  out.push(`INSERT INTO character_profiles (character_id, race, faction, ruleset, region_label, selected) VALUES ('c1', 'Gnome', 'Alliance', 'Normal', 'EU', 1);`);
  out.push(`INSERT INTO builds (id, character_id, source, status, title, data_json, created_at) VALUES ('b1', 'c1', 'web', 'draft', 'T', '{}', 'now');`);
  out.push(`INSERT INTO kv_state (key, json, updated_at) VALUES ('party', ${q('{"members":[{"name":"Línea ünï"}]}')}, 'now'), ('signups', '{"entries":[]}', 'now'), ('secret_x', ${q(SECRETS[4])}, 'now'), ('feed_cache:stats', '{}', 'now');`);
  for (let i = 0; i < 450; i++) out.push(`INSERT INTO intents (at, slug, kind, body, ver) VALUES ('now', 'santa', 'signup', ${q(JSON.stringify({ n: i }))}, 1);`);
  out.push(`INSERT INTO ask_turns (id, by_name, question, status, created_at) VALUES ('a1', 'Tester', 'Where is the bank?', 'error', 'now');`);
  return out.join("\n") + "\n";
}

let dev = null, failed = false;
const say = (m) => console.log(m);
try {
  say(`drill folder: ${tmp}`);
  wr(["d1", "execute", "leeroy-board-db", "--local", "--persist-to", src, "--file", path.join(INFRA, "schema.sql")]);
  const seed = path.join(tmp, "seed.sql"); fs.writeFileSync(seed, seedSql());
  wr(["d1", "execute", "leeroy-board-db", "--local", "--persist-to", src, "--file", seed]);
  say("source database built and seeded");
  dev = spawn("npx", ["wrangler", "dev", "--local", "--port", String(port), "--persist-to", src, "--var", `BOARD_ADMIN_TOKEN:${TOKEN}`, "--var", `KEY_SALT:${SALT}`, "--var", `USER_SALT:${SALT}`], { cwd: INFRA, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let log = ""; dev.stdout.on("data", (d) => { log += d; }); dev.stderr.on("data", (d) => { log += d; });
  const api = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 90; i++) { if (/Ready on/.test(log)) break; if (dev.exitCode !== null) throw new Error(`wrangler dev exited: ${log.slice(-300)}`); await new Promise((r) => setTimeout(r, 1000)); }
  if (!/Ready on/.test(log)) throw new Error("wrangler dev did not become ready in 90 seconds");
  const no = await fetch(`${api}/api/admin/export`);
  if (no.status !== 401) throw new Error(`export without a token answered ${no.status}, expected 401`);
  say("export without the token: 401");
  const res = await pull({ api, token: TOKEN, limit: 200 });
  fs.writeFileSync(exportFile, res.lines.join("\n") + "\n", { mode: 0o600 });
  say(`pulled ${res.lines.length} lines in ${res.pages} pages`);
  const text = fs.readFileSync(exportFile, "utf8");
  for (const s of SECRETS) if (text.includes(s)) throw new Error(`a secret value reached the export file: ${s.slice(0, 8)}...`);
  say("no secret value in the export file");
  const parsed = parseExport(text);
  if (parsed.problems.length) throw new Error(`export file problems: ${parsed.problems.join("; ")}`);
  const out = restore({ file: exportFile, persistTo: dst, log: say });
  if (out.problems) throw new Error(`restore refused: ${out.problems.join("; ")}`);
  say("");
  for (const r of out.counts) say(`${r.ok ? "ok  " : "FAIL"} ${r.table.padEnd(24)} exported ${String(r.expected).padStart(5)}  restored ${String(r.restored).padStart(5)}`);
  if (!out.ok) throw new Error("a restored count does not match");
  say(`\nmembers restored without keys: ${out.members}`);
  say("DRILL PASSED");
} catch (e) {
  failed = true;
  console.error(`DRILL FAILED: ${e.message}`);
} finally {
  if (dev && dev.pid) { // npx starts wrangler which starts workerd: stop the whole group, not just the first process
    for (const sig of ["SIGTERM", "SIGKILL"]) { try { process.kill(-dev.pid, sig); } catch (e) { break; } await new Promise((r) => setTimeout(r, 700)); }
  }
  if (!keep) fs.rmSync(tmp, { recursive: true, force: true }); else say(`kept ${tmp}`);
  process.exit(failed ? 1 : 0);
}
