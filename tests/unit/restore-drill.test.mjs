// tools/restore-drill.mjs on the in-process SQLite backend: export a seeded database through the real Worker route, wipe it, restore, diff row counts and a
// checksum of every table. Offline: no wrangler, no network, no AI, made-up data. The same report comes out of the real local D1 (`node tools/restore-drill.mjs`),
// so one expected file serves both: tests/fixtures/restore-drill.expected.txt (also quoted in docs/runbooks/restore-drill.md).
// The drill must also be able to FAIL: the tamper tests damage the export in ways a row count alone would miss.
// Run: node --test tests/unit/restore-drill.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runDrill, sqliteBackend, fixtureSql, parseArgv, SECRETS } from "../../tools/restore-drill.mjs";

const EXPECTED = readFileSync(new URL("../fixtures/restore-drill.expected.txt", import.meta.url), "utf8").replace(/\n$/, "");
const TOOL = fileURLToPath(new URL("../../tools/restore-drill.mjs", import.meta.url));

// Damage the export file line by line (each line is JSON): fn gets the parsed line and returns it changed, or null to drop it.
const edit = (fn) => (text) => text.split("\n").filter(Boolean).map((l) => JSON.parse(l)).map(fn).filter((l) => l !== null).map((l) => JSON.stringify(l)).join("\n") + "\n";
const drill = async (opts) => runDrill(await sqliteBackend(), opts);

test("the drill passes on the fixtures and prints exactly the expected report", async () => {
  const r = await drill();
  assert.deepEqual(r.failures, []);
  assert.equal(r.ok, true);
  assert.equal(r.lines.slice(1).join("\n"), EXPECTED);
});

test("it wipes and restores for real: the numbers in the report", async () => {
  const text = EXPECTED;
  assert.match(text, /^1\. source database: 41 tables from schema\.sql, seeded with 465 fixture statements$/m);
  assert.match(text, /^2\. export: 36 tables exported, 5 never exported \(account_keys, sessions, guest_rate_limits, sessions_v2, provider_tokens\)/m);
  assert.match(text, /^   ok   intents {16}rows {2}450 -> {2}450 /m);
  assert.match(text, /^   ok   sessions {15}rows {4}1 -> {4}0 {3}never exported/m);
  assert.match(text, /^RESTORE DRILL PASSED: 36 tables, 464 rows, every count and checksum matches$/m);
});

test("it is deterministic: two runs give the same report", async () => {
  assert.deepEqual((await drill()).lines.slice(1), (await drill()).lines.slice(1));
});

test("FAIL: a changed value with the same row count is caught by the checksum", async () => {
  const r = await drill({ tamper: edit((l) => (l.t === "row" && l.table === "ask_turns" ? { ...l, r: { ...l.r, question: "Where is the bank!" } } : l)) });
  assert.equal(r.ok, false);
  assert.deepEqual(r.failures, ["ask_turns: checksum differs"]);
  assert.match(r.lines.join("\n"), /FAIL ask_turns +rows +1 -> +1 .* != /);
});

test("FAIL: SQL NULL turned into the text 'null' is caught (the same row count, the same look in JSON)", async () => {
  const r = await drill({ tamper: edit((l) => (l.t === "row" && l.table === "ask_turns" ? { ...l, r: { ...l.r, answer: "null" } } : l)) });
  assert.deepEqual(r.failures, ["ask_turns: checksum differs"]);
});

test("FAIL: a lost row is a count difference and a checksum difference", async () => {
  let dropped = false;
  const r = await drill({ tamper: edit((l) => {
    if (l.t === "row" && l.table === "user_state") { dropped = true; return null; }
    if (l.t === "end" && l.table === "user_state") return { ...l, rows: 0 };
    return l;
  }) });
  assert.ok(dropped);
  assert.deepEqual(r.failures, ["user_state: rows 1 -> 0", "user_state: checksum differs"]);
});

test("FAIL: a partial export (the last page says more follows) is refused before anything is restored", async () => {
  const r = await drill({ tamper: edit((l) => (l.t === "end" && l.table === "intents" && l.next === null ? { ...l, next: 999999 } : l)) });
  assert.equal(r.ok, false);
  assert.match(r.failures.join("\n"), /table intents is incomplete/);
  assert.ok(!r.lines.some((l) => l.startsWith("4. wipe")), "the wipe step must not run on a file that cannot be restored");
});

test("FAIL: an extra row that was never in the source shows as a count and checksum difference", async () => {
  const addGhost = (text) => {
    const out = [];
    for (const l of text.split("\n").filter(Boolean).map((x) => JSON.parse(x))) {
      if (l.t === "end" && l.table === "noise_ledger") out.push({ t: "row", table: "noise_ledger", r: { day: "2026-11-04", channel: "ghost", n: 1 } }, { ...l, rows: l.rows + 1 });
      else out.push(l);
    }
    return out.map((x) => JSON.stringify(x)).join("\n") + "\n";
  };
  const r = await drill({ tamper: addGhost });
  assert.deepEqual(r.failures, ["noise_ledger: rows 1 -> 2", "noise_ledger: checksum differs"]);
});

test("the report never contains a secret fixture value, and the fixtures hold the secrets the check looks for", async () => {
  const r = await drill();
  for (const s of SECRETS) {
    assert.ok(fixtureSql().includes(s), `fixture lacks ${s.slice(0, 8)}`);
    assert.ok(!r.lines.join("\n").includes(s));
  }
});

test("every table of schema.sql is either in the report or named never exported (a new table cannot be forgotten)", async () => {
  const schema = readFileSync(new URL("../../infrastructure/schema.sql", import.meta.url), "utf8");
  const tables = [...schema.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
  assert.equal(tables.length, 41);
  for (const t of tables) assert.match(EXPECTED, new RegExp(`\\b${t}\\b`), `${t} is missing from the expected report`);
});

test("CLI: --backend sqlite exits 0, prints the report and matches --expect; a wrong --expect exits 1; bad options exit 2", () => {
  const run = (...a) => spawnSync(process.execPath, ["--no-warnings", TOOL, ...a], { encoding: "utf8" });
  const ok = run("--backend", "sqlite", "--expect", fileURLToPath(new URL("../fixtures/restore-drill.expected.txt", import.meta.url)));
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /RESTORE DRILL PASSED: 36 tables, 464 rows/);
  assert.match(ok.stdout, /report matches/);
  const bad = run("--backend", "sqlite", "--expect", TOOL);
  assert.equal(bad.status, 1);
  assert.equal(run("--remote").status, 2);
  assert.equal(run("--backend", "mysql").status, 2);
  assert.equal(run("--port", "99999", "--backend", "sqlite").status, 2);
});

test("parseArgv: local only, values required", () => {
  assert.deepEqual(parseArgv(["--backend", "sqlite", "--keep"]), { backend: "sqlite", keep: true });
  assert.throws(() => parseArgv(["--remote"]), /local only/);
  assert.throws(() => parseArgv(["--port"]), /needs a value/);
  assert.throws(() => parseArgv(["x"]), /unexpected argument/);
});
