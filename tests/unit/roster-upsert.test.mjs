// tools/roster-upsert.mjs and .github/workflows/roster-upsert.yml. A fake wrangler (injected executor) stands in for D1: no network, no installs.
// Every member below is fictional and every id is a synthetic digit string.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
  main, planUpsert, parseEntries, parseRosterRow, parseWranglerRows, parseWranglerChanges, sqlLiteral, buildWriteSql, buildAuditSql, proofLines, rosterLines, diffLines,
} from "../../tools/roster-upsert.mjs";

const TOKEN = "fake-token-0123456789", ACCOUNT = "fake-account-abcdef";
const id = (n) => "99999999" + String(n).padStart(10, "0"); // 18 digits
const ALDOUS = { slug: "aldous-thorne", name: "Aldous Thorne", match: ["aldous", "thorne"], id: id(1) };
const MIRELLE = { slug: "mirelle-voss", name: "Mirelle Voss", match: ["mirelle"], id: id(2) };
const BRAM = { slug: "bram-quill", name: "Bram Quill", match: ["bram"] }; // no id (legacy entry)

// A fake D1: one kv_state row, an audit list, a log of every wrangler call. Understands only the four statements the tool sends.
function makeDb({ text, rows, raceOnWrite, ignoreWrite, noChangeCount } = {}) {
  const db = { text, audits: [], calls: [], logs: [] };
  db.exec = (args) => {
    const sqlAt = args.indexOf("--command");
    const fileAt = args.indexOf("--file");
    assert.ok(args.includes("--remote") && args.includes("--json"), "every call is remote and JSON");
    assert.ok(!args.join(" ").includes(TOKEN) && !args.join(" ").includes(ACCOUNT), "no credential on the command line");
    const ok = (results, changes) => ({ status: 0, stderr: "", stdout: JSON.stringify([{ results, success: true, meta: noChangeCount ? {} : { changes } }]) });
    if (sqlAt >= 0) {
      const sql = args[sqlAt + 1];
      db.calls.push({ kind: "read", sql });
      if (rows) return rows(db);
      return ok(db.text === undefined || db.text === null ? [] : [{ json: db.text }], 0);
    }
    assert.ok(fileAt >= 0, "a write goes through --file");
    const sql = readFileSync(args[fileAt + 1], "utf8");
    if (sql.startsWith("UPDATE kv_state")) {
      db.calls.push({ kind: "update", sql });
      const m = /^UPDATE kv_state SET json = '([\s\S]*)', updated_at = '([^']*)' WHERE key = 'discord_members' AND json = '([\s\S]*)';$/.exec(sql);
      assert.ok(m, "the UPDATE has the expected shape");
      const un = (s) => s.replace(/''/g, "'");
      if (raceOnWrite) db.text = raceOnWrite(db.text);
      if (un(m[3]) === db.text) { if (!ignoreWrite) db.text = un(m[1]); return ok([], 1); }
      return ok([], 0);
    }
    if (sql.startsWith("INSERT INTO audit_log")) {
      db.calls.push({ kind: "audit", sql });
      db.audits.push(sql);
      return ok([], 1);
    }
    throw new Error("unexpected statement: " + sql.slice(0, 40));
  };
  db.kinds = () => db.calls.map((c) => c.kind);
  db.writes = () => db.calls.filter((c) => c.kind !== "read");
  return db;
}

const envFor = (entries, extra = {}) => ({
  D1_DATABASE_NAME: "test-db", CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
  ENTRIES_JSON: typeof entries === "string" ? entries : JSON.stringify(entries), DRY_RUN: "false", AUDIT_ADDS: "true", ...extra,
});
async function run(db, entries, extra) {
  const lines = [];
  const code = await main({ env: envFor(entries, extra), exec: db.exec, log: (l) => lines.push(l), now: () => "2026-11-16T12:00:00.000Z" });
  db.logs = lines;
  return { code, lines, text: lines.join("\n") };
}
const roster = (...ms) => JSON.stringify(ms);

test("dry run: reads, prints BEFORE, AFTER and the diff, and makes no write call", async () => {
  const db = makeDb({ text: roster(ALDOUS) });
  const r = await run(db, [MIRELLE, { slug: "aldous-thorne", name: "Aldous Thorne", match: ["aldous", "thorne", "ald"] }], { DRY_RUN: "true" });
  assert.equal(r.code, 0);
  assert.deepEqual(db.kinds(), ["read"]);
  assert.equal(db.text, roster(ALDOUS), "the stored roster is untouched");
  assert.match(r.text, /DRY RUN/);
  assert.match(r.text, /BEFORE \(1 members\)/);
  assert.match(r.text, new RegExp(`aldous-thorne \\| Aldous Thorne \\| ${id(1)} \\| 2`));
  assert.match(r.text, /AFTER, planned \(2 members\)/);
  assert.match(r.text, /added: mirelle-voss/);
  assert.match(r.text, /changed: aldous-thorne \(match\)/);
  assert.match(r.text, /Nothing was written|nothing was written/);
});

test("the dry run is the default: anything but exactly DRY_RUN=false writes nothing", async () => {
  for (const v of [undefined, "", "true", "0", "False", "no"]) {
    const db = makeDb({ text: roster(ALDOUS) });
    const env = envFor([MIRELLE]);
    if (v === undefined) delete env.DRY_RUN; else env.DRY_RUN = v;
    const code = await main({ env, exec: db.exec, log: () => {}, now: () => "2026-11-16T12:00:00.000Z" });
    assert.equal(code, 0, String(v));
    assert.equal(db.writes().length, 0, `DRY_RUN=${v}`);
  }
});

test("real run: ONE guarded UPDATE with the old-text guard, one audit INSERT per added entry, none for an update, then a read-back with proofs", async () => {
  const old = roster(ALDOUS);
  const db = makeDb({ text: old });
  const r = await run(db, [MIRELLE, { slug: "aldous-thorne", name: "Aldous Thorne", match: ["aldous", "ald"] }]);
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(db.kinds(), ["read", "update", "audit", "read"]);
  const upd = db.calls.find((c) => c.kind === "update").sql;
  assert.equal(db.calls.filter((c) => c.kind === "update").length, 1);
  assert.ok(upd.includes(` WHERE key = 'discord_members' AND json = '${old.replaceAll("'", "''")}';`), "compare-and-set on the exact old text");
  assert.ok(upd.includes("updated_at = '2026-11-16T12:00:00.000Z'"));
  const stored = JSON.parse(db.text);
  assert.deepEqual(stored.map((m) => m.slug), ["aldous-thorne", "mirelle-voss"]);
  assert.deepEqual(stored[0], { slug: "aldous-thorne", name: "Aldous Thorne", match: ["aldous", "ald"], id: id(1) });
  assert.equal(db.audits.length, 1);
  assert.equal(db.audits[0], buildAuditSql({ slug: "mirelle-voss", id: id(2), at: "2026-11-16T12:00:00.000Z" }));
  assert.match(db.audits[0], /VALUES \(NULL, NULL, 'member\.add', 'mirelle-voss', '\{"added":"99999999\d{10}"\}', '2026-11-16T12:00:00\.000Z'\);$/);
  assert.match(r.text, /proof mirelle-voss: present=true id-match=true match-count=1/);
  assert.match(r.text, /proof aldous-thorne: present=true id-match=true match-count=2/);
  assert.match(r.text, /up to 60 seconds per isolate/);
});

test("an update-only run writes the roster but no audit row; audit_adds=false writes none even for an add", async () => {
  let db = makeDb({ text: roster(ALDOUS) });
  let r = await run(db, [{ slug: "aldous-thorne", name: "Aldous T", match: ["aldous"] }]);
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(db.kinds(), ["read", "update", "read"]);
  assert.equal(JSON.parse(db.text)[0].id, id(1), "the update kept the id");
  db = makeDb({ text: roster(ALDOUS) });
  r = await run(db, [MIRELLE], { AUDIT_ADDS: "false" });
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(db.kinds(), ["read", "update", "read"]);
  assert.match(r.text, /audit_adds is off/);
});

test("an added entry without an id gets no audit row", async () => {
  const db = makeDb({ text: roster(ALDOUS) });
  const r = await run(db, [BRAM]);
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(db.kinds(), ["read", "update", "read"]);
  assert.match(r.text, /no id on bram-quill, no audit row/);
});

test("a lost race (the stored text moved, changes 0) writes no audit rows, says so, and exits 1", async () => {
  const db = makeDb({ text: roster(ALDOUS), raceOnWrite: (t) => t.replace("thorne", "thorne2") });
  const r = await run(db, [MIRELLE]);
  assert.equal(r.code, 1);
  assert.deepEqual(db.kinds(), ["read", "update"]);
  assert.equal(db.audits.length, 0);
  assert.match(r.text, /The roster changed while we ran, nothing written/);
  assert.ok(db.text.includes("thorne2") && !db.text.includes("mirelle"), "the other writer's text stands");
});

test("a missing, garbled, non-array or invalid stored roster fails closed: exit 1, no write", async () => {
  const bad = {
    "no row": undefined,
    "empty text": "",
    "not JSON": "{not json",
    "an object": JSON.stringify({ slug: "x" }),
    "null": "null",
    "uppercase match token": JSON.stringify([{ slug: "a", name: "A", match: ["Upper"] }]),
    "a non-object member": JSON.stringify(["x"]),
    "bad id": JSON.stringify([{ slug: "a", name: "A", match: [], id: "12" }]),
  };
  for (const [name, text] of Object.entries(bad)) {
    const db = makeDb({ text });
    const r = await run(db, [MIRELLE]);
    assert.equal(r.code, 1, name);
    assert.equal(db.writes().length, 0, name);
    assert.deepEqual(db.kinds(), ["read"], name);
  }
  // wrangler itself failing, or printing something that is not the expected shape
  for (const [name, rows] of Object.entries({
    "wrangler exit 1": () => ({ status: 1, stdout: "", stderr: "boom" }),
    "not JSON": () => ({ status: 0, stdout: "all fine", stderr: "" }),
    "success false": () => ({ status: 0, stdout: JSON.stringify([{ results: [], success: false }]), stderr: "" }),
    "an object, not a list": () => ({ status: 0, stdout: JSON.stringify({ results: [{ json: "[]" }] }), stderr: "" }),
    "json column renamed": () => ({ status: 0, stdout: JSON.stringify([{ results: [{ body: "[]" }], success: true }]), stderr: "" }),
    "two rows": () => ({ status: 0, stdout: JSON.stringify([{ results: [{ json: "[]" }, { json: "[]" }], success: true }]), stderr: "" }),
  })) {
    const db = makeDb({ text: "[]", rows });
    const r = await run(db, [MIRELLE]);
    assert.equal(r.code, 1, name);
    assert.equal(db.writes().length, 0, name);
  }
});

test("an id held by another slug is rejected and nothing is written", async () => {
  const db = makeDb({ text: roster(ALDOUS, MIRELLE) });
  const r = await run(db, [{ slug: "bram-quill", name: "Bram Quill", match: ["bram"], id: id(1) }]);
  assert.equal(r.code, 1);
  assert.match(r.text, /id already belongs to a different member/);
  assert.equal(db.writes().length, 0);
  assert.equal(db.text, roster(ALDOUS, MIRELLE));
  // two entries in one run that claim the same id
  const db2 = makeDb({ text: roster(ALDOUS) });
  const r2 = await run(db2, [{ slug: "bram-quill", name: "Bram", match: [], id: id(7) }, { slug: "cora-fenn", name: "Cora", match: [], id: id(7) }]);
  assert.equal(r2.code, 1);
  assert.equal(db2.writes().length, 0);
  assert.equal(planUpsert([ALDOUS], [{ slug: "bram-quill", name: "B", match: [], id: id(1) }]).ok, false);
});

test("an update of an existing slug with a new match list keeps slug, name and id", () => {
  const plan = planUpsert([ALDOUS, MIRELLE], [{ slug: "aldous-thorne", name: "Aldous Thorne", match: ["aldous", "al"] }]);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.members[0], { slug: "aldous-thorne", name: "Aldous Thorne", match: ["aldous", "al"], id: id(1) });
  assert.deepEqual(plan.members[1], MIRELLE);
  assert.deepEqual(plan.added, []);
  assert.deepEqual(plan.changed, [{ slug: "aldous-thorne", fields: ["match"] }]);
  // order of the other members is kept; a new slug goes on the end
  const two = planUpsert([ALDOUS, MIRELLE], [BRAM]);
  assert.deepEqual(two.members.map((m) => m.slug), ["aldous-thorne", "mirelle-voss", "bram-quill"]);
  assert.deepEqual(two.added, ["bram-quill"]);
});

test("an invalid entry (uppercase match token, bad id, empty name, bad slug, unknown field) is rejected before any write", async () => {
  const bad = {
    "uppercase match token": { slug: "cora-fenn", name: "Cora Fenn", match: ["Cora"] },
    "bad id": { slug: "cora-fenn", name: "Cora Fenn", match: ["cora"], id: "12345" },
    "numeric id": { slug: "cora-fenn", name: "Cora Fenn", match: ["cora"], id: 99999999999999999 },
    "empty name": { slug: "cora-fenn", name: "   ", match: ["cora"] },
    "name too long": { slug: "cora-fenn", name: "x".repeat(41), match: ["cora"] },
    "bad slug": { slug: "Cora Fenn", name: "Cora", match: ["cora"] },
    "match not an array": { slug: "cora-fenn", name: "Cora", match: "cora" },
    "unknown field": { slug: "cora-fenn", name: "Cora", match: ["cora"], role: "admin" },
  };
  for (const [name, entry] of Object.entries(bad)) {
    const db = makeDb({ text: roster(ALDOUS) });
    const r = await run(db, [entry]);
    assert.equal(r.code, 1, name);
    assert.equal(db.writes().length, 0, name);
    assert.equal(db.text, roster(ALDOUS), name);
  }
  // a good entry next to a bad one writes nothing either
  const db = makeDb({ text: roster(ALDOUS) });
  const r = await run(db, [MIRELLE, bad["uppercase match token"]]);
  assert.equal(r.code, 1);
  assert.equal(db.writes().length, 0);
  assert.match(r.text, /entry 2/);
});

test("the input caps: more than 10 entries, more than 4000 bytes, empty, not an array, duplicate slug, not JSON all stop before wrangler is called", async () => {
  const many = Array.from({ length: 11 }, (_, i) => ({ slug: `m-${i}`, name: `M ${i}`, match: [] }));
  const big = [{ slug: "a", name: "A", match: ["x".repeat(4000)] }];
  const cases = { "11 entries": many, "over 4000 bytes": big, "empty array": [], "an object": { slug: "a" }, "duplicate slug": [MIRELLE, MIRELLE], "not JSON": "[{", "blank": "  ", "a non-object entry": [1] };
  for (const [name, entries] of Object.entries(cases)) {
    const db = makeDb({ text: roster(ALDOUS) });
    const r = await run(db, entries);
    assert.equal(r.code, 1, name);
    assert.equal(db.calls.length, 0, `${name}: wrangler must not be called`);
  }
  assert.equal(parseEntries(JSON.stringify(Array.from({ length: 10 }, (_, i) => ({ slug: `m-${i}`, name: "M", match: [] })))).entries.length, 10, "exactly 10 is allowed");
  const db = makeDb({ text: roster(ALDOUS) });
  assert.equal(await main({ env: { ...envFor([MIRELLE]), D1_DATABASE_NAME: "" }, exec: db.exec, log: () => {} }), 1);
  assert.equal(db.calls.length, 0);
});

test("SQL escaping: a name with a single quote round-trips through the UPDATE, and the helpers double quotes", async () => {
  assert.equal(sqlLiteral("O'Brien"), "'O''Brien'");
  assert.equal(sqlLiteral("''"), "''''''");
  assert.equal(sqlLiteral(""), "''");
  assert.throws(() => sqlLiteral(5));
  assert.throws(() => sqlLiteral("a\0b"));
  assert.equal(buildWriteSql({ newText: "n'x", oldText: "o'y", at: "T" }), "UPDATE kv_state SET json = 'n''x', updated_at = 'T' WHERE key = 'discord_members' AND json = 'o''y';");
  assert.match(buildAuditSql({ slug: "o'x", id: id(3), at: "T" }), /'member\.add', 'o''x', '\{"added":"99999999\d{10}"\}', 'T'\);$/);
  const quoted = { slug: "finn-oreilly", name: "Finn O'Reilly", match: ["o'reilly"], id: id(4) };
  const db = makeDb({ text: roster({ slug: "x-y", name: "It's Old", match: [] }) });
  const r = await run(db, [quoted]);
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(JSON.parse(db.text)[1], quoted);
  assert.match(r.text, /proof finn-oreilly: present=true id-match=true match-count=1/);
});

test("the proof fails (exit 1) when the read-back does not hold the planned entry", async () => {
  // the write reports one change but the database does not hold it (a fake that drops the write)
  const db = makeDb({ text: roster(ALDOUS), ignoreWrite: true });
  const r = await run(db, [MIRELLE]);
  assert.equal(r.code, 1);
  assert.match(r.text, /proof mirelle-voss: present=false id-match=false match-count=0/);
  assert.match(r.text, /a proof failed/);
  // a different match list stored than planned
  const planned = [{ ...MIRELLE }];
  const stored = [{ ...MIRELLE, match: ["other", "x"] }];
  const p = proofLines([MIRELLE], stored, planned);
  assert.equal(p.ok, false);
  assert.match(p.lines.join("\n"), /differs from the planned entry in: match/);
  assert.equal(proofLines([MIRELLE], planned, planned).ok, true);
});

test("a write result with no change count is judged by the read-back: confirmed passes, unconfirmed fails", async () => {
  let db = makeDb({ text: roster(ALDOUS), noChangeCount: true });
  let r = await run(db, [MIRELLE]);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /did not report a changed-row count/);
  db = makeDb({ text: roster(ALDOUS), noChangeCount: true, ignoreWrite: true });
  r = await run(db, [MIRELLE]);
  assert.equal(r.code, 1);
});

test("a plan that equals the stored text writes nothing even in a real run", async () => {
  const db = makeDb({ text: JSON.stringify([ALDOUS]) });
  const r = await run(db, [ALDOUS]);
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(db.kinds(), ["read", "read"]);
  assert.match(r.text, /Nothing to write/);
});

test("a failed audit INSERT after the roster write exits 1 and says which row", async () => {
  const db = makeDb({ text: roster(ALDOUS) });
  const inner = db.exec;
  db.exec = (args) => {
    const f = args.indexOf("--file");
    if (f >= 0 && readFileSync(args[f + 1], "utf8").startsWith("INSERT INTO audit_log")) return { status: 1, stdout: "", stderr: "constraint failed" };
    return inner(args);
  };
  const r = await run(db, [MIRELLE]);
  assert.equal(r.code, 1);
  assert.match(r.text, /audit row for mirelle-voss failed/);
  assert.equal(JSON.parse(db.text).length, 2, "the roster write stands");
});

test("no output line carries the token or the account id, even when wrangler's error text does", async () => {
  const leak = { status: 1, stdout: "", stderr: `Authentication error with ${TOKEN} for account ${ACCOUNT}` };
  let db = makeDb({ text: "[]", rows: () => leak });
  let r = await run(db, [MIRELLE]);
  assert.equal(r.code, 1);
  assert.ok(!r.text.includes(TOKEN) && !r.text.includes(ACCOUNT), "read failure");
  assert.match(r.text, /\[redacted\]/);
  db = makeDb({ text: roster(ALDOUS) });
  const inner = db.exec;
  db.exec = (args) => (args.includes("--file") ? leak : inner(args));
  r = await run(db, [MIRELLE]);
  assert.equal(r.code, 1);
  assert.ok(!r.text.includes(TOKEN) && !r.text.includes(ACCOUNT), "write failure");
  for (const extra of [{ DRY_RUN: "true" }, {}]) {
    db = makeDb({ text: roster(ALDOUS) });
    r = await run(db, [MIRELLE], extra);
    assert.ok(!r.text.includes(TOKEN) && !r.text.includes(ACCOUNT), "success path");
  }
});

// Redact first, THEN truncate: a 300-character cut that lands inside the token must not leave a fragment of it in the log.
test("a truncation cutoff inside the token or the account id leaks no fragment of either (redact the full text, then slice)", async () => {
  const token = "cfut_" + Array.from({ length: 40 }, (_, i) => "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"[(i * 7 + 3) % 36]).join("");
  const account = Array.from({ length: 32 }, (_, i) => "0123456789abcdef"[(i * 5 + 1) % 16]).join("");
  const fragments = (s) => { const out = []; for (let i = 0; i + 6 <= s.length; i++) out.push(s.slice(i, i + 6)); return out; };
  const leaks = (text) => [...fragments(token), ...fragments(account)].filter((f) => text.includes(f));
  const env = (extra) => ({ ...envFor([MIRELLE], extra), CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account });
  const cases = [];
  for (const secret of [token, account]) {
    for (const keep of [1, 5, 6, 12, secret.length - 6, secret.length - 1]) {
      // the secret starts `keep` characters before the 300-character cut
      // (word padding with spaces, so no long token-like run helps the pattern-based redaction: only redact-then-cut passes)
      cases.push({ secret, stderr: "ab ".repeat(100).slice(0, 300 - keep) + secret + " trailing text" });
    }
  }
  cases.push({ secret: token, stderr: "ab ".repeat(100).slice(0, 280) + `Authorization: Bearer ${token} for ${account}` });
  for (const c of cases) {
    // a read failure
    let db = makeDb({ text: "[]", rows: () => ({ status: 1, stdout: "", stderr: c.stderr }) });
    let lines = [];
    let code = await main({ env: env(), exec: db.exec, log: (l) => lines.push(l), now: () => "T" });
    assert.equal(code, 1);
    assert.deepEqual(leaks(lines.join("\n")), [], "read failure");
    // a write failure, and a failed audit row
    for (const failing of ["UPDATE", "INSERT"]) {
      db = makeDb({ text: roster(ALDOUS) });
      const inner = db.exec;
      db.exec = (args) => {
        const f = args.indexOf("--file");
        if (f >= 0 && readFileSync(args[f + 1], "utf8").startsWith(failing)) return { status: 1, stdout: "", stderr: c.stderr };
        return inner(args);
      };
      lines = [];
      code = await main({ env: env(), exec: db.exec, log: (l) => lines.push(l), now: () => "T" });
      assert.equal(code, 1, failing);
      assert.deepEqual(leaks(lines.join("\n")), [], `${failing} failure`);
    }
  }
});

test("the diff summary names added slugs and changed field names only, never other members", () => {
  const plan = planUpsert([ALDOUS, MIRELLE], [BRAM, { slug: "mirelle-voss", name: "Mirelle V", match: ["mirelle"], id: id(5) }]);
  const text = diffLines(plan).join("\n");
  assert.match(text, /added: bram-quill/);
  assert.match(text, /changed: mirelle-voss \(name, id\)/);
  assert.ok(!text.includes("aldous") && !text.includes(id(1)) && !text.includes("Mirelle V"));
  assert.deepEqual(rosterLines([{ slug: "a", name: "A\nB::x", match: ["a", "b"], id: id(1) }, { slug: "b", name: "B", match: [] }]), [`  a | A B::x | ${id(1)} | 2`, "  b | B | - | 0"]);
});

test("parseWranglerRows and parseWranglerChanges read the defensive shapes and refuse the rest", () => {
  const ok = JSON.stringify([{ results: [{ json: "[]" }], success: true, meta: { changes: 0 } }]);
  assert.deepEqual(parseWranglerRows(ok), [{ json: "[]" }]);
  assert.deepEqual(parseWranglerRows("Executing on remote database\n" + ok + "\n"), [{ json: "[]" }], "a banner before the JSON");
  assert.equal(parseWranglerChanges(JSON.stringify([{ results: [], success: true, meta: { changes: 1 } }])), 1);
  assert.equal(parseWranglerChanges(JSON.stringify([{ results: [], success: true, meta: { rows_written: 1 } }])), 1);
  assert.equal(parseWranglerChanges(JSON.stringify([{ results: [], success: true, meta: {} }])), null);
  assert.equal(parseWranglerChanges(JSON.stringify([{ results: [], success: true }, { results: [], success: true, meta: { changes: 1 } }])), null, "unknown for one statement means unknown");
  for (const bad of ["", "x", "{}", "[]", "[null]", "[1]", JSON.stringify([{ results: [], success: false }])]) assert.throws(() => parseWranglerRows(bad), undefined, bad);
  assert.throws(() => parseWranglerRows(JSON.stringify([{ success: true }])));
  assert.throws(() => parseRosterRow([{ json: 5 }]));
  assert.throws(() => parseRosterRow([]));
});

// ---- the workflow ------------------------------------------------------------------------------------------------------------------------

const wfPath = fileURLToPath(new URL("../../.github/workflows/roster-upsert.yml", import.meta.url));
const wfText = readFileSync(wfPath, "utf8");
const wf = parse(wfText);
const deployText = readFileSync(fileURLToPath(new URL("../../.github/workflows/deploy-cloudflare.yml", import.meta.url)), "utf8");
const job = wf.jobs["roster-upsert"];

test("the workflow runs on workflow_dispatch only, dry_run defaults to true, and it is master-only in the production environment with its own concurrency group", () => {
  const on = wf.on ?? wf[true];
  assert.deepEqual(Object.keys(on), ["workflow_dispatch"]);
  assert.equal(on.workflow_dispatch.inputs.dry_run.default, true);
  assert.equal(on.workflow_dispatch.inputs.dry_run.type, "boolean");
  assert.equal(on.workflow_dispatch.inputs.entries_json.required, true);
  assert.equal(on.workflow_dispatch.inputs.entries_json.type, "string");
  assert.equal(on.workflow_dispatch.inputs.audit_adds.default, true);
  assert.deepEqual(Object.keys(on.workflow_dispatch.inputs).sort(), ["audit_adds", "dry_run", "entries_json"]);
  assert.deepEqual(wf.permissions, { contents: "read" });
  assert.equal(job.if, "github.ref == 'refs/heads/master'");
  assert.equal(job.environment, "production");
  assert.equal(wf.concurrency.group, "roster-upsert-production");
  assert.equal(wf.concurrency["cancel-in-progress"], false);
  assert.equal(Object.keys(wf.jobs).length, 1);
});

test("workflow inputs never appear in shell command text: `${{ inputs.` is only in env: blocks, and no run: line holds an expression", () => {
  const all = [...wfText.matchAll(/\$\{\{\s*inputs\./g)].length;
  const inEnv = job.steps.flatMap((s) => Object.values(s.env || {})).filter((v) => /\$\{\{\s*inputs\./.test(String(v))).length;
  assert.equal(all, 3);
  assert.equal(inEnv, all, "every inputs expression is the value of an env: entry");
  for (const s of job.steps) {
    assert.equal(/\$\{\{/.test(s.run || ""), false, `step "${s.name}" has an expression in its run text`);
    const { env, ...rest } = s;
    assert.equal(/inputs\./.test(JSON.stringify(rest)), false, `step "${s.name}" reads inputs outside env`);
  }
  const step = job.steps.find((s) => /roster-upsert\.mjs/.test(s.run || ""));
  assert.equal(step.run.trim(), "node tools/roster-upsert.mjs");
  assert.deepEqual(Object.keys(step.env).sort(), ["AUDIT_ADDS", "DRY_RUN", "ENTRIES_JSON"]);
});

test("the workflow follows the deploy's conventions: pinned action SHAs, locked wrangler, Node 22, the same two secrets, no deploy or create, a public-repo refusal", () => {
  const pins = [...wfText.matchAll(/uses: (\S+@[0-9a-f]{40}) # (v\S+)/g)].map((m) => m[0]);
  assert.equal(pins.length, 2);
  for (const p of pins) assert.ok(deployText.includes(p), `pin differs from the deploy workflow: ${p}`);
  assert.equal(/uses: [^\n]*@(?![0-9a-f]{40}\b)/.test(wfText), false, "every action is pinned to a full SHA");
  const names = [...new Set([...wfText.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]))].sort();
  assert.deepEqual(names, ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"]);
  assert.equal(job.env.D1_DATABASE_NAME, "leeroy-board-db");
  assert.match(wfText, /npm ci --no-audit --no-fund/);
  assert.equal(job.steps.find((s) => /setup-node/.test(s.uses || "")).with["node-version"], "22");
  assert.equal(/wrangler (deploy|secret|d1 create|d1 migrations|pages)/.test(wfText), false);
  assert.equal(/allow_create_database|d1 create/.test(wfText), false, "this workflow never creates a database");
  assert.equal(job.steps[0].env.REPO_PRIVATE, "${{ github.event.repository.private }}");
  assert.match(job.steps[0].run, /\[ "\$REPO_PRIVATE" != "true" \]/);
  assert.ok(job.steps.findIndex((s) => /Refuse to run in a public/.test(s.name)) < job.steps.findIndex((s) => /roster-upsert\.mjs/.test(s.run || "")));
});
