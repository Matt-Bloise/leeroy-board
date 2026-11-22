// Guarded edit of the production Discord roster (D1 table kv_state, key 'discord_members') from CI. Node 22; imports only the Worker's own
// pure helpers so the write follows exactly the rules of POST /api/admin/members and /member (infrastructure/worker/member-write.js saveMember).
//
//   node tools/roster-upsert.mjs        run by .github/workflows/roster-upsert.yml (workflow_dispatch only); never by hand with a token
//
// Inputs, by environment variable only (never by argument, never interpolated into a shell line):
//   ENTRIES_JSON   a JSON array of entries { slug, name, match: [lowercase strings], id?: "17 to 20 digits" }; at most 10 entries, at most 4000 bytes
//   DRY_RUN        anything except exactly "false" means dry run (the safe default); nothing is written
//   AUDIT_ADDS     anything except exactly "false" means write one audit_log row per ADDED entry that has an id
//   D1_DATABASE_NAME, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID   read by wrangler; the token and account id are never printed
//
// Flow: read the stored roster (fail closed when the row is missing, not JSON, not an array, or fails the Worker's validator) -> print BEFORE ->
// apply every entry with upsertMember, then validateConfigValue (the Worker's functions) -> print AFTER and a diff summary -> dry run stops here ->
// ONE compare-and-set UPDATE (WHERE json = the exact text read) -> audit rows for added slugs -> re-read from the database, print the roster and a proof line per entry.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { upsertMember } from "../infrastructure/worker/members.js";
import { validateConfigValue } from "../infrastructure/worker/config.js";

export const KEY = "discord_members";
export const MAX_ENTRIES = 10;
export const MAX_ENTRIES_BYTES = 4000;
const ENTRY_KEYS = new Set(["slug", "name", "match", "id"]);
const INFRA_DIR = fileURLToPath(new URL("../infrastructure/", import.meta.url));

// ---- pure helpers (exported for the unit tests) ------------------------------------------------------------------------------------------

// A SQL string literal: single quotes doubled. Anything that is not a string, or that holds a NUL, is refused (fail closed).
export function sqlLiteral(s) {
  if (typeof s !== "string") throw new Error("sqlLiteral needs a string");
  if (s.includes("\0")) throw new Error("sqlLiteral refuses a NUL character");
  return "'" + s.replace(/'/g, "''") + "'";
}

// The one roster write: compare-and-set on the exact text that was read. Changes 0 rows when the stored text moved in the meantime.
export function buildWriteSql({ newText, oldText, at }) {
  return `UPDATE kv_state SET json = ${sqlLiteral(newText)}, updated_at = ${sqlLiteral(at)} WHERE key = ${sqlLiteral(KEY)} AND json = ${sqlLiteral(oldText)};`;
}

// One audit row for an added member, the same columns and values as auditMemberAdd in infrastructure/worker/member-write.js, with a NULL actor.
export function buildAuditSql({ slug, id, at }) {
  const detail = JSON.stringify({ added: String(id) });
  return "INSERT INTO audit_log (tenant_id, actor_discord_user_id, action, target, detail_json, at) VALUES (NULL, NULL, 'member.add', " +
    `${sqlLiteral(slug)}, ${sqlLiteral(detail)}, ${sqlLiteral(at)});`;
}

// Parses `wrangler d1 execute --json` output into the array of result sets [{ results, success, meta }]. Whole text first; failing that, the span from the
// first "[" to the last "]" (a banner line before the JSON). Throws on anything else, and on a result set that says success: false.
export function parseWranglerSets(stdout) {
  const text = String(stdout ?? "");
  let parsed;
  try { parsed = JSON.parse(text); } catch {
    const a = text.indexOf("["), b = text.lastIndexOf("]");
    if (a < 0 || b <= a) throw new Error("wrangler output is not JSON");
    try { parsed = JSON.parse(text.slice(a, b + 1)); } catch { throw new Error("wrangler output is not JSON"); }
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((s) => !s || typeof s !== "object")) throw new Error("wrangler output has an unexpected shape (not a list of result sets)");
  if (parsed.some((s) => s.success === false)) throw new Error("wrangler reported success: false");
  return parsed;
}

// The rows of the first result set (a SELECT).
export function parseWranglerRows(stdout) {
  const rows = parseWranglerSets(stdout)[0].results;
  if (!Array.isArray(rows)) throw new Error("wrangler output has no results array");
  return rows;
}

// Rows changed by a write: the sum of meta.changes over the result sets, else the sum of meta.rows_written, else null (unknown).
export function parseWranglerChanges(stdout) {
  const sets = parseWranglerSets(stdout);
  for (const field of ["changes", "rows_written"]) {
    const nums = sets.map((s) => (s.meta && typeof s.meta[field] === "number" ? s.meta[field] : null));
    if (nums.every((n) => n !== null)) return nums.reduce((a, b) => a + b, 0);
  }
  return null;
}

// The stored roster row -> { text, members }. Throws (fail closed) when the row is missing, the text is not JSON, the value is not an array,
// or the Worker's own validator rejects it. A roster that does not validate is never edited by this tool.
export function parseRosterRow(rows) {
  if (!Array.isArray(rows) || rows.length !== 1 || !rows[0] || typeof rows[0].json !== "string") throw new Error("the discord_members row is missing or unreadable");
  const text = rows[0].json;
  let members;
  try { members = JSON.parse(text); } catch { throw new Error("the stored discord_members text is not valid JSON"); }
  if (!Array.isArray(members)) throw new Error("the stored discord_members value is not a JSON array");
  const problem = validateConfigValue(KEY, members);
  if (problem) throw new Error(`the stored roster fails the Worker's validator (${problem})`);
  return { text, members };
}

// Parses and bounds the operator input. Returns { entries } or { error }.
export function parseEntries(raw) {
  if (typeof raw !== "string" || !raw.trim()) return { error: "entries_json is empty" };
  if (Buffer.byteLength(raw, "utf8") > MAX_ENTRIES_BYTES) return { error: `entries_json is longer than ${MAX_ENTRIES_BYTES} bytes` };
  let v;
  try { v = JSON.parse(raw); } catch { return { error: "entries_json is not valid JSON" }; }
  if (!Array.isArray(v) || v.length === 0) return { error: "entries_json must be a non-empty JSON array" };
  if (v.length > MAX_ENTRIES) return { error: `entries_json has more than ${MAX_ENTRIES} entries` };
  for (let i = 0; i < v.length; i++) {
    const e = v[i];
    if (!e || typeof e !== "object" || Array.isArray(e)) return { error: `entry ${i + 1} is not an object` };
    const extra = Object.keys(e).filter((k) => !ENTRY_KEYS.has(k));
    if (extra.length) return { error: `entry ${i + 1} has unknown field(s): ${extra.join(", ")}` };
  }
  const slugs = v.map((e) => e.slug);
  if (new Set(slugs).size !== slugs.length) return { error: "entries_json names the same slug twice" };
  return { entries: v };
}

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Applies every entry with the Worker's upsertMember (same slug rules, same id-collision rule, an update keeps the prior id and match list when the entry has none),
// then checks the whole result with the Worker's validateConfigValue. Returns { ok: true, members, added, changed } or { ok: false, error }. Nothing is mutated.
export function planUpsert(oldMembers, entries) {
  let members = Array.isArray(oldMembers) ? oldMembers.slice() : [];
  const added = [], changed = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const before = members.find((m) => m && m.slug === entry.slug) || null;
    const out = upsertMember(members, entry);
    if (out.error) return { ok: false, error: `entry ${i + 1}: ${out.error}` };
    members = out.members;
    const after = members.find((m) => m.slug === entry.slug);
    if (!before) { added.push(entry.slug); continue; }
    const fields = ["name", "match", "id"].filter((f) => !sameJson(before[f], after[f]));
    if (fields.length) changed.push({ slug: entry.slug, fields });
  }
  const problem = validateConfigValue(KEY, members);
  if (problem) return { ok: false, error: problem };
  return { ok: true, members, added, changed };
}

// One printable line, no control characters, so a stored value cannot start a workflow command or break the layout.
const CONTROL = new RegExp("[\\x00-\\x1f\\x7f" + String.fromCharCode(0x2028, 0x2029) + "]", "g");
const clean = (v) => String(v ?? "").replace(CONTROL, " ");
export function rosterLines(members) {
  return members.map((m) => `  ${clean(m.slug)} | ${clean(m.name)} | ${m.id === undefined ? "-" : clean(m.id)} | ${Array.isArray(m.match) ? m.match.length : 0}`);
}

// Plain summary of the plan: the slugs added, and the slugs changed with the field names that changed. No values, no other member's details.
export function diffLines(plan) {
  const lines = [];
  lines.push(`  added: ${plan.added.length ? plan.added.map(clean).join(", ") : "(none)"}`);
  lines.push(`  changed: ${plan.changed.length ? plan.changed.map((c) => `${clean(c.slug)} (${c.fields.join(", ")})`).join("; ") : "(none)"}`);
  return lines;
}

// One proof line per input entry, judged against the roster stored now and the planned roster. ok is false when any entry is absent, has a different id, a
// different match count, or any other difference from what was planned (reported on a second line, field names only).
export function proofLines(entries, storedMembers, plannedMembers) {
  const lines = [];
  let ok = true;
  for (const e of entries) {
    const want = plannedMembers.find((m) => m.slug === e.slug);
    const got = storedMembers.find((m) => m && m.slug === e.slug);
    const present = !!got;
    const idMatch = present && want ? got.id === want.id : false;
    const count = present && Array.isArray(got.match) ? got.match.length : 0;
    const countOk = present && want ? count === want.match.length : false;
    lines.push(`proof ${clean(e.slug)}: present=${present} id-match=${idMatch} match-count=${count}`);
    let exact = present && want && sameJson(got, want);
    if (!exact && present && want) {
      const fields = ["name", "match", "id"].filter((f) => !sameJson(got[f], want[f]));
      if (fields.length) lines.push(`proof ${clean(e.slug)}: stored entry differs from the planned entry in: ${fields.join(", ")}`);
    }
    if (!present || !idMatch || !countOk || !exact) ok = false;
  }
  return { lines, ok };
}

// ---- redaction ---------------------------------------------------------------------------------------------------------------------------

// Exact secret values, longest first, wherever they occur.
export function redactSecrets(text, secrets) {
  let s = String(text);
  for (const secret of [...secrets].filter((x) => typeof x === "string" && x.length >= 4).sort((a, b) => b.length - a.length)) s = s.split(secret).join("[redacted]");
  return s;
}

// Text captured from a child process (wrangler). The exact secrets first, then anything shaped like a credential: a Bearer header, key=value pairs for
// token/key/secret names, a 32-hex id (an account id), a long token-like run. ALWAYS call this on the whole text before any truncation.
export function redactChildOutput(text, secrets) {
  return redactSecrets(text, secrets)
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/=-]+/gi, "Bearer [redacted]")
    .replace(/\b((?:api[-_ ]?key|token|secret|authorization)\w*\s*[:=]\s*)\S+/gi, "$1[redacted]")
    .replace(/\b[0-9a-f]{32}\b/gi, "[redacted]")
    .replace(/[A-Za-z0-9_-]{40,}/g, "[redacted]");
}

// ---- I/O --------------------------------------------------------------------------------------------------------------------------------------

// Runs wrangler from infrastructure/ (where wrangler.toml and the patched D1 database id are). No shell, so no quoting problems.
export function defaultExec(args, env = process.env) {
  const r = spawnSync("npx", ["--no-install", "wrangler", ...args], { cwd: INFRA_DIR, env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return { status: r.status === null ? 1 : r.status, stdout: r.stdout || "", stderr: (r.stderr || "") + (r.error ? String(r.error.message) : "") };
}

const READ_SQL = `SELECT json FROM kv_state WHERE key = '${KEY}'`;

// Returns the exit code. exec, log, now and tmp are injectable; the tests pass fakes, so no network and no wrangler.
export async function main({ env = process.env, exec = defaultExec, log = console.log, now = () => new Date().toISOString(), tmp = tmpdir } = {}) {
  const secrets = [env.CLOUDFLARE_API_TOKEN, env.CLOUDFLARE_ACCOUNT_ID].filter((s) => typeof s === "string" && s.length >= 4);
  const out = (line) => log(redactSecrets(String(line), secrets));
  const db = env.D1_DATABASE_NAME;
  if (!db) { out("roster-upsert: D1_DATABASE_NAME is not set. Nothing was read or written."); return 1; }
  const dryRun = env.DRY_RUN !== "false";
  const auditAdds = env.AUDIT_ADDS !== "false";
  const parsed = parseEntries(env.ENTRIES_JSON);
  if (parsed.error) { out(`roster-upsert: ${parsed.error}. Nothing was read or written.`); return 1; }
  const entries = parsed.entries;
  out(`roster-upsert: ${dryRun ? "DRY RUN (nothing will be written)" : "REAL RUN"}, ${entries.length} entr${entries.length === 1 ? "y" : "ies"}, audit rows for adds: ${auditAdds ? "yes" : "no"}.`);

  const run = (args) => {
    const r = exec(args, env);
    return r && typeof r.then === "function" ? r : Promise.resolve(r);
  };
  const failExec = (what, r) => {
    // Redact the FULL captured text first, then cut: a cut inside a secret would leave a fragment that no exact match can find.
    const detail = redactChildOutput(String(r.stderr || ""), secrets).trim().slice(0, 300);
    out(`roster-upsert: ${what} failed (exit ${r.status}).${detail ? " wrangler said: " + detail : ""}`);
  };
  const readRoster = async () => {
    const r = await run(["d1", "execute", db, "--remote", "--json", "--command", READ_SQL]);
    if (r.status !== 0) { failExec("reading the roster", r); return null; }
    try { return parseRosterRow(parseWranglerRows(r.stdout)); } catch (e) {
      out(`roster-upsert: ${e.message}. The roster was not touched; this tool never creates or overwrites a missing or unreadable roster.`);
      return null;
    }
  };

  // (a) + (b) read and print BEFORE
  const before = await readRoster();
  if (!before) return 1;
  out(`BEFORE (${before.members.length} members): slug | name | id | match-count`);
  for (const l of rosterLines(before.members)) out(l);

  // (c) plan with the Worker's functions, print AFTER and the diff
  const plan = planUpsert(before.members, entries);
  if (!plan.ok) { out(`roster-upsert: rejected, nothing written: ${plan.error}`); return 1; }
  const newText = JSON.stringify(plan.members);
  out(`AFTER, planned (${plan.members.length} members): slug | name | id | match-count`);
  for (const l of rosterLines(plan.members)) out(l);
  out("DIFF:");
  for (const l of diffLines(plan)) out(l);

  // (d) dry run
  if (dryRun) {
    out(newText === before.text ? "Dry run: the roster already holds exactly this result. Nothing to write." : "Dry run: nothing was written. Run again with dry_run unticked to apply.");
    return 0;
  }

  // (e) the one guarded write
  let code = 0, unverified = false;
  if (newText === before.text) {
    out("The stored roster already equals the planned result. Nothing to write.");
  } else {
    const at = now();
    const wrote = await runSql(buildWriteSql({ newText, oldText: before.text, at }), "the roster write");
    if (!wrote.ok) return 1;
    const changes = safeChanges(wrote.stdout);
    if (changes === 0) { out("The roster changed while we ran, nothing written. Re-run (dry run first) against the current roster."); return 1; }
    if (changes !== null && changes !== 1) { out(`roster-upsert: the write reported ${changes} changed rows (expected exactly 1). Check the roster before doing anything else.`); return 1; }
    unverified = changes === null;
    if (unverified) out("roster-upsert: wrangler did not report a changed-row count; the read-back below decides.");
    // audit rows, only for ADDED slugs that carry an id
    if (auditAdds) {
      for (const slug of plan.added) {
        const id = plan.members.find((m) => m.slug === slug).id;
        if (id === undefined) { out(`audit: no id on ${clean(slug)}, no audit row.`); continue; }
        const a = await runSql(buildAuditSql({ slug, id, at }), `the audit row for ${slug}`);
        if (a.ok) out(`audit: member.add row written for ${clean(slug)}.`);
        else code = 1;
      }
    } else if (plan.added.length) out("audit: audit_adds is off, no audit rows written.");
    out("The roster is written. The Worker caches the roster for up to 60 seconds per isolate, so a change can take up to a minute to show.");
  }

  // (f) re-read from the database, print, prove
  const after = await readRoster();
  if (!after) return 1;
  out(`AFTER, stored now (${after.members.length} members): slug | name | id | match-count`);
  for (const l of rosterLines(after.members)) out(l);
  const proof = proofLines(entries, after.members, plan.members);
  for (const l of proof.lines) out(l);
  if (!proof.ok) { out("roster-upsert: a proof failed. The stored roster does not match the plan."); code = 1; }
  if (unverified && after.text !== newText) { out("roster-upsert: the write could not be confirmed and the stored text is not the planned text."); code = 1; }
  if (code === 0 && after.text !== newText) out("note: the stored text differs from the planned text (formatting or a later write); every proof still passed.");
  return code;

  // Writes a statement through a temp .sql file (`wrangler d1 execute --remote --file`), then deletes the file. Returns { ok, stdout }.
  async function runSql(sql, what) {
    const dir = mkdtempSync(join(tmp(), "roster-upsert-"));
    const file = join(dir, "stmt.sql");
    try {
      writeFileSync(file, sql, { encoding: "utf8", mode: 0o600 });
      const r = await run(["d1", "execute", db, "--remote", "--json", "--file", file]);
      if (r.status !== 0) { failExec(what, r); return { ok: false, stdout: null }; }
      return { ok: true, stdout: r.stdout };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  function safeChanges(stdout) {
    try { return parseWranglerChanges(stdout); } catch { return null; }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((c) => { process.exitCode = c; }, (e) => {
    // Whole message redacted first, then cut.
    const m = redactChildOutput(String(e && e.message ? e.message : e), [process.env.CLOUDFLARE_API_TOKEN, process.env.CLOUDFLARE_ACCOUNT_ID]).slice(0, 300);
    console.log(`roster-upsert: unexpected error: ${m}`);
    process.exitCode = 1;
  });
}
