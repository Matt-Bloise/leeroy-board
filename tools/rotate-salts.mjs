#!/usr/bin/env node
// Plan a rotation of the two Worker salts, USER_SALT and KEY_SALT. DRY RUN ONLY: this tool has no --apply, makes no network call, opens no
// database and writes nothing but the optional --sql-out file. Rotating the secrets themselves stays with the account owner
// (docs/runbooks/rotate-salts.md); this prepares the plan, the SQL and the checks.
//
//   OLD_USER_SALT=... NEW_USER_SALT=... OLD_KEY_SALT=... NEW_KEY_SALT=... \
//     node tools/rotate-salts.mjs [--ids-file <ids>] [--export <export.ndjson>] [--vote-ids a,b] [--slugs a,b] [--only user|key] [--reverse] [--sql-out <file>] [--json]
//
// Salts come from the environment ONLY (never an argument, never printed, never written). USER_SALT needs OLD_USER_SALT and NEW_USER_SALT;
// KEY_SALT needs OLD_KEY_SALT and NEW_KEY_SALT. --only limits the plan to one of them.
//   --ids-file <path>   Known Discord ids: one per line, or JSON (an array of ids or of { id } objects, such as the discord_members row).
//   --export <path>     An export from tools/pull-export.mjs. Adds the ids in its users table and discord_members row, the vote ids, the member
//                       slugs, and counts of rows that can and cannot be re-derived. Without it the plan still works but shows no row counts.
//   --vote-ids <list>   Vote ids (8 hex characters) whose ballots should be re-keyed, if no --export.
//   --slugs <list>      Member slugs to re-issue keys for, if no --export.
//   --reverse           Swap old and new: the SQL that undoes a forward run (a rollback aid). The salts still come from the same four variables.
//   --sql-out <file>    Write the FULL statements and checks here (mode 600, outside this repository). The screen shows hashes cut to 8 characters.
//   --json              Print the plan as JSON (hashes cut the same way).
//
// What can be re-derived: a hash of the form sha256(salt:...:<discord id>) can be rebuilt for every Discord id you know, with the old and new
// salt, so those rows are renamed in place. A hash of something that is not stored cannot: member keys (KEY_SALT) and visitor addresses (USER_SALT)
// are not on file, so member keys must be re-issued and the rate-limit counters are cleared. Ids you do not know stay under the old hash and are
// unreachable after the flip (listed as "unmapped" when --export is given). The derivations below are checked against the Worker's own functions
// in tests/unit/rotate-salts.test.mjs.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SALT_MIN = 16; // same floor as worker/salts.js
export const NEW_SALT_MIN = 32; // a new salt must be strong: it is the whole point of rotating
const ID_RE = /^\d{17,20}$/;
const VOTE_RE = /^[a-f0-9]{8}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const CHUNK = 40; // ids per statement: keeps each statement far below D1's statement size limit

const sha = (s) => createHash("sha256").update(s).digest("hex");
// The exact formulas of the Worker (file:line in the comments). Tests compare them with the Worker's functions.
export const derive = {
  userKey: (salt, id) => sha(`${salt}:user:${id}`), // account.js userKey
  answerUx: (salt, id) => sha(`${salt}:answer-ux:${id}`), // answer-ux.js userHash
  voter: (salt, voteId, id) => sha(`${salt}:vote:${voteId}:${id}`), // votes.js voterHash
  memberKey: (salt, key) => sha(`${salt}:${key}`), // auth.js hashKey
};
export const short = (h) => `${String(h).slice(0, 8)}…`;
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

// Every place a salted hash is stored or checked, and what can be done about it. One source for the plan, the runbook and the tests.
export const INVENTORY = [
  { salt: "USER_SALT", where: "user_state.user_key", scheme: "sha256(USER_SALT:user:<discord id>)", source: "worker/account.js userKey", rederive: "yes, for known ids", action: "UPDATE OR IGNORE old to new, then delete leftovers" },
  { salt: "USER_SALT", where: "sessions.user_key", scheme: "sha256(USER_SALT:user:<discord id>)", source: "worker/account.js login", rederive: "yes, for known ids", action: "UPDATE old to new (the token_hash column is unsalted and unchanged)" },
  { salt: "USER_SALT", where: "answer_details.asker_hash", scheme: "sha256(USER_SALT:answer-ux:<discord id>)", source: "worker/answer-ux.js userHash", rederive: "yes, for known ids", action: "UPDATE old to new (rows expire after 30 days anyway)" },
  { salt: "USER_SALT", where: "ask_turn_askers.asker_hash", scheme: "sha256(USER_SALT:answer-ux:<discord id>) and/or sha256(USER_SALT:answer-ux:slug:<member slug>), one row per hash", source: "worker/answer-ux.js askerHashes", rederive: "yes, for known ids and slugs", action: "UPDATE old to new (without it, an old question is no longer found by erase and export)" },
  { salt: "USER_SALT", where: "answer_feedback.user_hash", scheme: "sha256(USER_SALT:answer-ux:<discord id>)", source: "worker/answer-ux.js userHash", rederive: "yes, for known ids", action: "UPDATE OR IGNORE old to new, then delete leftovers (rows expire after 90 days)" },
  { salt: "USER_SALT", where: "kv_state vote:<id> .ballots keys", scheme: "sha256(USER_SALT:vote:<vote id>:<discord id>)", source: "worker/votes.js voterHash", rederive: "yes, for known ids and known vote ids", action: "json_set the ballot under its new key" },
  { salt: "USER_SALT", where: "vote_ballots.voter_hash", scheme: "sha256(USER_SALT:vote:<vote id>:<discord id>)", source: "worker/votes.js voterHash", rederive: "yes, for known ids and known vote ids", action: "NOT re-keyed: the tool REFUSES a USER_SALT plan when --export holds any vote_ballots row (see refusalFor); needs a re-key step with collision handling first" },
  { salt: "USER_SALT", where: "guest_rate_limits.ip_hash", scheme: "sha256(USER_SALT:guest-ask:<ip>)", source: "worker/guest-key.js", rederive: "NO (visitor addresses are not stored)", action: "DELETE all rows: they are short-lived counters" },
  { salt: "USER_SALT", where: "audit_log.target (action 'erase')", scheme: "sha256(USER_SALT:erase:<random uuid>)", source: "worker/data-rights.js", rederive: "NO (random, tied to nobody)", action: "none: opaque records, never looked up by hash" },
  { salt: "USER_SALT", where: "Discord button ids (not stored)", scheme: "HMAC-SHA256(USER_SALT, answer-ux:<kind>:<intent>:<message>)", source: "worker/answer-ux.js signButton", rederive: "NO (signed into messages already posted)", action: "none: More, Sources, Helpful and Off on old answers stop working" },
  { salt: "KEY_SALT", where: "members.key_hash", scheme: "sha256(KEY_SALT:<member key>)", source: "worker/auth.js hashKey", rederive: "NO (keys are never stored)", action: "RE-ISSUE a key per member (infrastructure/scripts/hash-key.mjs)" },
  { salt: "KEY_SALT", where: "kv_state moments_ledger entries: channelHash, contentHash", scheme: "first 16 hex of sha256(KEY_SALT:<channel id or post text>)", source: "worker/moments.js shortHash", rederive: "NO (and not needed: diagnostic rows only)", action: "none: rows written after the flip use the new salt, so compare before and after the flip separately" },
  { salt: "KEY_SALT", where: "account_keys.key_hash", scheme: "unknown (no Worker code reads this table)", source: "schema.sql only", rederive: "NO", action: "re-issue or empty it; check whether anything still uses it first" },
];
export const BREAKS = [
  "USER_SALT, known ids: saved board preferences and signed-in sessions carry over once the SQL has run; until then (the minutes between the secret change and the SQL) people see empty preferences.",
  "USER_SALT, unknown ids: their saved preferences and sessions are orphaned (unreachable); they sign in again and start empty. Add every id you know to the ids list first.",
  "USER_SALT: a person who voted keeps their ballot only if their id is known and the vote id is listed; otherwise they can vote again in an open vote.",
  "USER_SALT: More, Sources, Helpful and Off buttons on answers already posted in Discord stop working (new answers are fine). Guest rate-limit counters restart from zero.",
  "KEY_SALT: EVERY member key stops working the moment the new KEY_SALT is live. Each member needs the new key you give them, and the hash for it must be in the members table. Plan it as a short window.",
];

// ---- inputs
export function readSalts(env, only) {
  const out = {}, errors = [];
  const names = [];
  if (only !== "key") names.push("USER");
  if (only !== "user") names.push("KEY");
  for (const n of names) {
    const o = env[`OLD_${n}_SALT`], w = env[`NEW_${n}_SALT`];
    for (const [label, v, min] of [[`OLD_${n}_SALT`, o, SALT_MIN], [`NEW_${n}_SALT`, w, NEW_SALT_MIN]]) {
      if (!v) errors.push(`${label} is not set (environment only)`);
      else if (String(v).length < min) errors.push(`${label} must be at least ${min} characters`);
    }
    if (o && w) {
      if (o === w) errors.push(`NEW_${n}_SALT is the same as OLD_${n}_SALT`);
      else if (new Set(String(w)).size < 10) errors.push(`NEW_${n}_SALT has too few different characters: use a random value (for example 48 random bytes, base64)`);
    }
    if (o && w && !errors.some((e) => e.includes(`_${n}_SALT`))) out[n] = { old: String(o), neu: String(w) };
  }
  if (names.length && Object.keys(out).length === 0 && !errors.length) errors.push("no salts given");
  return { salts: out, errors };
}

export function parseIds(text) {
  const ids = new Set(), bad = [];
  let list = null;
  try { const j = JSON.parse(text); list = Array.isArray(j) ? j : j && Array.isArray(j.members) ? j.members : null; } catch (e) { list = null; }
  const items = list ? list.map((x) => (x && typeof x === "object" ? x.id : x)) : String(text).split(/\s+/).filter(Boolean);
  for (const x of items) { const s = String(x === undefined || x === null ? "" : x).trim(); if (ID_RE.test(s)) ids.add(s); else if (s) bad.push(s); }
  return { ids: [...ids], ignored: bad.length };
}

// Reads an export from tools/pull-export.mjs: ids, vote ids, slugs and the rows we can classify. No I/O beyond the string it is given.
// Why a plan must not be made, or null. Ballots cast after migration 0010 live in vote_ballots.voter_hash, which this tool does not re-key:
// after a USER_SALT flip a returning voter would be counted twice and the old rows orphaned. So a USER_SALT plan is refused while the export
// holds such a row. (The tool opens no database: it can only see what --export shows it. Run it with a fresh --export.)
export function refusalFor(salts, facts) {
  const n = facts && facts.tables ? facts.tables.vote_ballots || 0 : 0;
  if (salts && salts.USER && n > 0) {
    return `refusing to plan a USER_SALT rotation: the export holds ${n} vote_ballots row(s) and this tool does not re-key vote_ballots.voter_hash (voters would be counted twice after the flip). Add the re-key step first, or use --only key.`;
  }
  return null;
}

export function readExportFacts(text) {
  const facts = { ids: new Set(), voteIds: new Set(), slugs: new Set(), userState: [], feedback: [], details: [], ballots: {}, tables: {} };
  for (const raw of String(text).split("\n")) {
    if (!raw.trim()) continue;
    let l; try { l = JSON.parse(raw); } catch (e) { continue; }
    if (!l || l.t !== "row") continue;
    facts.tables[l.table] = (facts.tables[l.table] || 0) + 1;
    const r = l.r || {};
    if (l.table === "users" && ID_RE.test(String(r.discord_user_id))) facts.ids.add(String(r.discord_user_id));
    else if (l.table === "kv_state" && r.key === "discord_members") { try { for (const m of JSON.parse(r.json)) if (m && ID_RE.test(String(m.id))) facts.ids.add(String(m.id)); } catch (e) { /* ignore */ } }
    else if (l.table === "kv_state" && /^vote:[a-f0-9]{8}$/.test(String(r.key))) { const id = r.key.slice(5); facts.voteIds.add(id); try { facts.ballots[id] = Object.keys(JSON.parse(r.json).ballots || {}); } catch (e) { facts.ballots[id] = []; } }
    else if (l.table === "members" && SLUG_RE.test(String(r.slug))) facts.slugs.add(r.slug);
    else if (l.table === "user_state") facts.userState.push(r.user_key);
    else if (l.table === "answer_feedback") facts.feedback.push(r.user_hash);
    else if (l.table === "answer_details") facts.details.push(r.asker_hash);
  }
  return facts;
}

// ---- the plan
const chunks = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
const caseSql = (col, pairs) => `CASE ${col} ${pairs.map(([o, n]) => `WHEN ${q(o)} THEN ${q(n)}`).join(" ")} END`;
const inList = (xs) => xs.map(q).join(", ");

export function buildPlan({ salts, ids, voteIds = [], slugs = [], facts = null, reverse = false }) {
  const swap = (s) => (reverse ? { old: s.neu, neu: s.old } : { old: s.old, neu: s.neu });
  const plan = { direction: reverse ? "reverse (rollback aid)" : "forward", ids: ids.length, voteIds: voteIds.length, steps: [], checks: { before: [], after: [] }, rows: {}, members: null, inventory: INVENTORY.filter((i) => salts[i.salt.replace("_SALT", "")]), breaks: [] };
  const U = salts.USER && swap(salts.USER), K = salts.KEY && swap(salts.KEY);
  if (U) {
    const pairsOf = (fn) => ids.map((id) => [fn(U.old, id), fn(U.neu, id)]);
    const uk = pairsOf(derive.userKey), ax = pairsOf(derive.answerUx);
    const add = (table, kind, sql, shown, note) => plan.steps.push({ salt: "USER_SALT", table, kind, sql, shown, note });
    for (const c of chunks(uk, CHUNK)) {
      const abbr = (s) => s.replace(/'([0-9a-f]{64})'/g, (_, h) => `'${short(h)}'`);
      const upd = `UPDATE OR IGNORE user_state SET user_key = ${caseSql("user_key", c)} WHERE user_key IN (${inList(c.map((p) => p[0]))});`;
      add("user_state", "update", upd, abbr(upd), "keeps the newer row if one already exists under the new key");
      const del = `DELETE FROM user_state WHERE user_key IN (${inList(c.map((p) => p[0]))});`;
      add("user_state", "cleanup", del, abbr(del), "removes old-key leftovers that could not move because a newer row exists");
      const s = `UPDATE sessions SET user_key = ${caseSql("user_key", c)} WHERE user_key IN (${inList(c.map((p) => p[0]))});`;
      add("sessions", "update", s, abbr(s), "sessions keep their token_hash; only the owner key changes");
    }
    for (const c of chunks(ax, CHUNK)) {
      const abbr = (s) => s.replace(/'([0-9a-f]{64})'/g, (_, h) => `'${short(h)}'`);
      const d = `UPDATE answer_details SET asker_hash = ${caseSql("asker_hash", c)} WHERE asker_hash IN (${inList(c.map((p) => p[0]))});`;
      add("answer_details", "update", d, abbr(d), "");
      const f = `UPDATE OR IGNORE answer_feedback SET user_hash = ${caseSql("user_hash", c)} WHERE user_hash IN (${inList(c.map((p) => p[0]))});`;
      add("answer_feedback", "update", f, abbr(f), "");
      const fd = `DELETE FROM answer_feedback WHERE user_hash IN (${inList(c.map((p) => p[0]))});`;
      add("answer_feedback", "cleanup", fd, abbr(fd), "");
    }
    for (const v of voteIds) {
      for (const id of ids) {
        const o = derive.voter(U.old, v, id), n = derive.voter(U.neu, v, id);
        const sql = `UPDATE kv_state SET json = json_set(json_remove(json, '$.ballots."${o}"'), '$.ballots."${n}"', json_extract(json, '$.ballots."${o}"')) WHERE key = ${q(`vote:${v}`)} AND json_extract(json, '$.ballots."${o}"') IS NOT NULL;`;
        plan.steps.push({ salt: "USER_SALT", table: "kv_state", kind: "update", sql, shown: sql.replace(/[0-9a-f]{64}/g, (h) => short(h)), note: `vote ${v}` });
      }
    }
    const rl = "DELETE FROM guest_rate_limits;";
    plan.steps.push({ salt: "USER_SALT", table: "guest_rate_limits", kind: "delete", sql: rl, shown: rl, note: "counters only; visitor addresses cannot be re-derived" });
    // checks: scalar subqueries (D1 limits compound SELECT), old hashes of known ids must be gone afterwards
    const oldUk = uk.map((p) => p[0]), newUk = uk.map((p) => p[1]), oldAx = ax.map((p) => p[0]), newAx = ax.map((p) => p[1]);
    const cnt = (t, c, xs) => `(SELECT COUNT(*) FROM ${t} WHERE ${c} IN (${inList(xs)}))`;
    const olds = (voteIds.length ? voteIds : []).flatMap((v) => ids.map((id) => derive.voter(U.old, v, id)));
    const news = (voteIds.length ? voteIds : []).flatMap((v) => ids.map((id) => derive.voter(U.neu, v, id)));
    const ballots = (hs) => (hs.length ? `(SELECT COUNT(*) FROM kv_state WHERE key LIKE 'vote:%' AND (${hs.map((h) => `instr(json, ${q(h)}) > 0`).join(" OR ")}))` : "0");
    const sel = (parts) => `SELECT ${parts.map(([n, e]) => `${e} AS ${n}`).join(", ")};`;
    plan.checks.before = [{ name: "user rows under the OLD hashes of known ids", sql: sel([["user_state_old", cnt("user_state", "user_key", oldUk)], ["sessions_old", cnt("sessions", "user_key", oldUk)], ["answer_details_old", cnt("answer_details", "asker_hash", oldAx)], ["answer_feedback_old", cnt("answer_feedback", "user_hash", oldAx)], ["vote_rows_old", ballots(olds)]]) }];
    plan.checks.after = [{ name: "must all be 0: nothing known is left under the old hashes", sql: sel([["user_state_old", cnt("user_state", "user_key", oldUk)], ["sessions_old", cnt("sessions", "user_key", oldUk)], ["answer_details_old", cnt("answer_details", "asker_hash", oldAx)], ["answer_feedback_old", cnt("answer_feedback", "user_hash", oldAx)], ["vote_rows_old", ballots(olds)], ["rate_limit_rows", "(SELECT COUNT(*) FROM guest_rate_limits)"]]) },
      { name: "must be at least the matching BEFORE numbers (more is fine: people used the board meanwhile)", sql: sel([["user_state_new", cnt("user_state", "user_key", newUk)], ["sessions_new", cnt("sessions", "user_key", newUk)], ["answer_details_new", cnt("answer_details", "asker_hash", newAx)], ["answer_feedback_new", cnt("answer_feedback", "user_hash", newAx)], ["vote_rows_new", ballots(news)]]) }];
    if (facts) {
      const set = new Set(oldUk), setA = new Set(oldAx);
      const split = (xs, s) => ({ total: xs.length, mapped: xs.filter((x) => s.has(x)).length, unmapped: xs.filter((x) => !s.has(x)).length });
      plan.rows.user_state = split(facts.userState, set);
      plan.rows.answer_feedback = split(facts.feedback, setA);
      plan.rows.answer_details = split(facts.details, setA);
      const bal = { total: 0, mapped: 0, unmapped: 0 };
      for (const [v, keys] of Object.entries(facts.ballots)) { const known = new Set(ids.map((id) => derive.voter(U.old, v, id))); for (const k of keys) { bal.total++; if (known.has(k)) bal.mapped++; else bal.unmapped++; } }
      plan.rows.vote_ballots = bal;
      plan.rows.sessions = "not in the export (session tokens are never exported)";
    }
    plan.breaks.push(...BREAKS.filter((b) => b.startsWith("USER_SALT")));
  }
  if (K) {
    plan.members = {
      slugs,
      reissue: slugs.map((s) => `printf '%s' "$KEY_FOR_${s.toUpperCase().replace(/-/g, "_")}" | KEY_SALT="$NEW_KEY_SALT" node infrastructure/scripts/hash-key.mjs ${s}`),
      after_check: "SELECT slug, substr(key_hash, 1, 8) AS hash_start FROM members ORDER BY slug;  -- run before and after: every hash_start must change",
    };
    plan.breaks.push(...BREAKS.filter((b) => b.startsWith("KEY_SALT")));
  }
  return plan;
}

export function fullSql(plan) {
  const out = [`-- Salt rotation plan, ${plan.direction}. GENERATED, NOT APPLIED. Holds hashes of Discord ids: keep it private and delete it afterwards.`, "-- Run only inside the window described in docs/runbooks/rotate-salts.md, after the new USER_SALT is live.", ""];
  for (const s of plan.steps) out.push(`-- ${s.table}: ${s.kind}${s.note ? ` (${s.note})` : ""}`, s.sql);
  out.push("", "-- CHECK BEFORE (run before the change; keep the numbers)");
  for (const c of plan.checks.before) out.push(`-- ${c.name}`, c.sql);
  out.push("", "-- CHECK AFTER");
  for (const c of plan.checks.after) out.push(`-- ${c.name}`, c.sql);
  return out.join("\n") + "\n";
}

export function formatPlan(plan) {
  const out = ["DRY RUN: nothing was applied. This tool cannot apply anything.", `Direction: ${plan.direction}`, `Known Discord ids: ${plan.ids}; vote ids: ${plan.voteIds}`, "", "Where salted hashes live"];
  for (const i of plan.inventory) out.push(`  [${i.salt}] ${i.where}`, `      ${i.scheme}  (${i.source})`, `      re-derive: ${i.rederive}`, `      plan: ${i.action}`);
  if (Object.keys(plan.rows).length) {
    out.push("", "Rows in the export");
    for (const [t, r] of Object.entries(plan.rows)) out.push(typeof r === "string" ? `  ${t}: ${r}` : `  ${t}: ${r.total} total, ${r.mapped} will be renamed, ${r.unmapped} unmapped (unknown ids: unreachable after the flip)`);
  }
  const user = plan.steps.length;
  if (user) {
    out.push("", `SQL it would run (${plan.steps.length} statements; hashes cut to 8 characters here, full text with --sql-out):`);
    const seen = new Map();
    for (const s of plan.steps) { const k = `${s.table}/${s.kind}`; seen.set(k, (seen.get(k) || 0) + 1); if (seen.get(k) <= 2) out.push(`  ${s.shown.length > 260 ? s.shown.slice(0, 257) + "..." : s.shown}`); else if (seen.get(k) === 3) out.push(`  -- ... more ${s.table} ${s.kind} statements`); }
    out.push("", "Verification (run BEFORE and AFTER; full queries with --sql-out):");
    for (const c of [...plan.checks.before, ...plan.checks.after]) out.push(`  - ${c.name}`);
  }
  if (plan.members) {
    out.push("", `KEY_SALT: ${plan.members.slugs.length || "no"} member key(s) must be re-issued (they cannot be re-derived):`);
    if (plan.members.slugs.length) { for (const c of plan.members.reissue) out.push(`  ${c}`); } else out.push("  (give --export or --slugs to list them)");
    out.push(`  check: ${plan.members.after_check}`);
  }
  out.push("", "What breaks for people");
  for (const b of plan.breaks) out.push(`  - ${b}`);
  return out.join("\n");
}

export function parseArgv(argv) {
  const o = {}, flags = new Set(["json", "reverse", "help"]), known = new Set(["ids-file", "export", "vote-ids", "slugs", "only", "sql-out", ...flags]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    const k = a.slice(2);
    if (k === "apply") throw new Error("this tool never applies anything: it only prints a plan (see docs/runbooks/rotate-salts.md for who runs what)");
    if (/salt/i.test(k)) throw new Error("salts are never arguments: use the OLD_/NEW_ environment variables");
    if (!known.has(k)) throw new Error(`unknown option --${k}`);
    if (flags.has(k)) o[k] = true;
    else { if (argv[i + 1] === undefined || argv[i + 1].startsWith("--")) throw new Error(`--${k} needs a value`); o[k] = argv[++i]; }
  }
  if (o.only && !["user", "key"].includes(o.only)) throw new Error("--only must be user or key");
  return o;
}
const insideRepo = (file) => { const rel = path.relative(REPO, path.resolve(file)); return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel)); };
const list = (s, re, what) => { const xs = String(s).split(",").map((x) => x.trim()).filter(Boolean); for (const x of xs) if (!re.test(x)) throw new Error(`${what} "${x.slice(0, 12)}" is not valid`); return xs; };

function main() {
  let o;
  try { o = parseArgv(process.argv.slice(2)); } catch (e) { console.error(`error: ${e.message}`); process.exit(2); }
  if (o.help) { console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n")); return; }
  const { salts, errors } = readSalts(process.env, o.only);
  if (errors.length) { for (const e of errors) console.error(`error: ${e}`); process.exit(2); }
  let ids = new Set(), ignored = 0, facts = null, voteIds = new Set(), slugs = new Set();
  try {
    if (o["ids-file"]) { const r = parseIds(fs.readFileSync(o["ids-file"], "utf8")); r.ids.forEach((x) => ids.add(x)); ignored += r.ignored; }
    if (o.export) { facts = readExportFacts(fs.readFileSync(o.export, "utf8")); facts.ids.forEach((x) => ids.add(x)); facts.voteIds.forEach((x) => voteIds.add(x)); facts.slugs.forEach((x) => slugs.add(x)); }
    if (o["vote-ids"]) list(o["vote-ids"], VOTE_RE, "vote id").forEach((x) => voteIds.add(x));
    if (o.slugs) list(o.slugs, SLUG_RE, "slug").forEach((x) => slugs.add(x));
    if (o["sql-out"] && insideRepo(o["sql-out"])) throw new Error("--sql-out is inside this repository; it holds hashes of Discord ids. Choose a path outside it.");
  } catch (e) { console.error(`error: ${e.message}`); process.exit(2); }
  const refused = refusalFor(salts, facts);
  if (refused) { console.error(`error: ${refused}`); process.exit(3); }
  if (salts.USER && !ids.size) { console.error("error: no Discord ids given. Without them nothing can be re-derived (use --ids-file and/or --export)."); process.exit(2); }
  const plan = buildPlan({ salts, ids: [...ids].sort(), voteIds: [...voteIds].sort(), slugs: [...slugs].sort(), facts, reverse: !!o.reverse });
  if (ignored) plan.ignored_ids = ignored;
  if (o["sql-out"]) fs.writeFileSync(o["sql-out"], fullSql(plan), { mode: 0o600 });
  if (o.json) { const { steps, checks, ...rest } = plan; console.log(JSON.stringify({ ...rest, steps: steps.map((s) => ({ salt: s.salt, table: s.table, kind: s.kind, sql: s.shown })), checks: { before: checks.before.map((c) => c.name), after: checks.after.map((c) => c.name) } }, null, 2)); }
  else console.log(formatPlan(plan));
  if (ignored) console.error(`note: ${ignored} value(s) in --ids-file were not Discord ids (17 to 20 digits) and were ignored`);
  if (o["sql-out"]) console.error(`full SQL written to ${o["sql-out"]} (mode 600). Delete it when done.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
