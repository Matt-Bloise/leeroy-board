// Post-deploy backfill for ask_turns rows written by the OLD Worker between applying migration 0009 and the deploy of the new one
// (a window of seconds). Such a row has no ask_turn_askers row and is not in ask_turn_legacy, so export and erase fail closed: they never
// find it. This marks exactly those rows as legacy (so, like every question older than migration 0009, they may be matched by name).
// Only rows created BEFORE --before are touched: pass the time the new Worker went live, so nothing the new Worker wrote (which either
// carries hashes or is a visitor question) is ever marked. Idempotent. No secrets, no Discord ids, no hashes are read or written.
//   node infrastructure/scripts/backfill-ask-legacy.mjs --remote|--local --before 2026-11-04T12:00:00Z [--dry-run]
// --dry-run prints the count and the ids and changes nothing. Nothing is written without --remote or --local being named.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const GAP_WHERE = "id NOT IN (SELECT intent_id FROM ask_turn_askers) AND id NOT IN (SELECT intent_id FROM ask_turn_legacy) AND created_at < ?";

// db: a D1 binding or anything with prepare().bind().all()/run(). -> { ids, marked }
export async function backfillAskLegacy(db, { before, dryRun = false } = {}) {
  const cut = new Date(before);
  if (!before || Number.isNaN(cut.getTime())) throw new Error("--before must be an ISO time, e.g. 2026-11-04T12:00:00Z");
  const iso = cut.toISOString();
  const found = await db.prepare(`SELECT id FROM ask_turns WHERE ${GAP_WHERE} ORDER BY created_at`).bind(iso).all();
  const ids = ((found && found.results) || []).map((r) => String(r.id));
  if (dryRun || !ids.length) return { ids, marked: 0 };
  const res = await db.prepare(`INSERT OR IGNORE INTO ask_turn_legacy (intent_id) SELECT id FROM ask_turns WHERE ${GAP_WHERE}`).bind(iso).run();
  return { ids, marked: Number((res && res.meta && res.meta.changes) || 0) };
}

function cliDb(target) {
  const run = (sql, args) => {
    const bound = sql.replace(/\?/g, () => `'${String(args.shift()).replace(/'/g, "''")}'`);
    const out = execFileSync("npx", ["wrangler", "d1", "execute", "leeroy-board-db", target, "--json", "--command", bound], { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8" });
    return JSON.parse(out)[0] || {};
  };
  return { prepare: (sql) => { let a = []; const o = { bind: (...x) => { a = x; return o; }, all: async () => ({ results: run(sql, [...a]).results || [] }), run: async () => ({ meta: { changes: (run(sql, [...a]).meta || {}).changes || 0 } }) }; return o; } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2), val = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
  const target = argv.includes("--remote") ? "--remote" : argv.includes("--local") ? "--local" : null;
  if (!target) { console.error("name --remote or --local"); process.exit(2); }
  try {
    const r = await backfillAskLegacy(cliDb(target), { before: val("--before"), dryRun: argv.includes("--dry-run") });
    console.log(`${argv.includes("--dry-run") ? "would mark" : "marked"} ${argv.includes("--dry-run") ? r.ids.length : r.marked} ask_turns row(s) as legacy`);
    if (argv.includes("--dry-run")) for (const id of r.ids) console.log(id);
  } catch (e) { console.error(String(e.message || e)); process.exit(1); }
}
