// tools/import-signups.mjs: reads the board's sign-up export (the signups document, or the intents mailbox), dry run by default, idempotent,
// refuses names that are not on the board. Fixtures are made up (tests/unit/fixtures/signups). No network (a stub stands in for the Worker), no AI.
// Run: node --test tests/unit/import-signups.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildPlan, finalize, applyImport, formatPlan, readExport, rosterFromParty, norm, parseArgv } from "../../tools/import-signups.mjs";
import { recomputeSignupTallies } from "../../infrastructure/worker/discord.js";

const fx = (n) => JSON.parse(fs.readFileSync(new URL(`./fixtures/signups/${n}`, import.meta.url), "utf8"));
const party = fx("party.json"), exportDoc = fx("export-doc.json"), exportIntents = fx("export-intents.json"), current = fx("current.json");
const TOOL = new URL("../../tools/import-signups.mjs", import.meta.url).pathname;
const entry = (doc, name) => doc.entries.find((e) => e.name === name);

test("matching ignores case and punctuation, and the roster refuses ambiguity", () => {
  assert.equal(norm("=Mossy Pete="), norm("mossy pete"));
  assert.deepEqual(rosterFromParty(party).map((r) => r.slug), ["mossy-pete", "quillfeather", "dame-ember", "tobble-wick"]);
  assert.throws(() => rosterFromParty({ members: [{ name: "A-b" }, { name: "a b" }] }), /same name/);
  assert.throws(() => rosterFromParty({ members: [{ name: "!!!" }] }), /no letters/);
});

test("the signups document: counts, newest dated row wins, existing name kept, undated rows only fill, unknown fields reported", () => {
  const plan = buildPlan({ exported: exportDoc, party, current });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.counts, { in_file: 4, people: 3, add: 2, update: 1, unchanged: 0 });
  const mossy = entry(plan.doc, "=Mossy Pete=");
  assert.deepEqual([mossy.pack, mossy.meet, mossy.rsvp, mossy.when, mossy.updated], ["yes", "Valley of Strength", "late", "8pm", "2026-10-30T09:00:00.000Z"]);
  assert.equal(plan.doc.entries.filter((e) => norm(e.name) === "mossypete").length, 1, "no duplicate for the same person");
  assert.deepEqual(entry(plan.doc, "Quillfeather"), { slug: "quillfeather", name: "Quillfeather", rsvp: "maybe", when: "later", updated: "2026-10-28T10:00:00.000Z" });
  const ember = entry(plan.doc, "Dame Ember");
  assert.deepEqual(ember, { slug: "dame-ember", name: "Dame Ember", rsvp: "in", meet: "Lakeside Dock", meet_other: "the dock by the lake" });
  assert.equal("updated" in ember, false, "an undated row never invents a date");
  assert.deepEqual(entry(plan.doc, "Tobble Wick"), current.entries[1], "people not in the file are untouched");
  assert.match(plan.warnings.join(), /contact, mood/);
  assert.equal(JSON.stringify(plan.doc).includes("excited"), false);
  assert.equal(JSON.stringify(plan.doc).includes("nope"), false);
});

test("the intents mailbox: only kind signup, the entry is used, a JSON string body works, the intent time dates an undated entry", () => {
  const read = readExport(exportIntents);
  assert.deepEqual(read.errors, []);
  assert.deepEqual(read.rows.map((r) => r.name), ["Quillfeather", "Tobble Wick"]);
  assert.equal(read.rows[1].fields.updated, "2026-10-27T01:00:00.000Z");
  const plan = buildPlan({ exported: exportIntents, party, current });
  assert.deepEqual(plan.counts, { in_file: 2, people: 2, add: 1, update: 0, unchanged: 1 });
  assert.equal(entry(plan.doc, "Tobble Wick").rsvp, "out", "the stored entry is newer than the intent");
  assert.equal(buildPlan({ exported: exportIntents.intents, party, current }).ok, true, "a bare array is accepted too");
});

test("unknown names are refused and nothing is written, even for the known names in the same file", () => {
  const bad = { entries: [...exportDoc.entries, { name: "Stranger Danger", rsvp: "in", updated: "2026-10-30T00:00:00.000Z" }] };
  const plan = buildPlan({ exported: bad, party, current });
  assert.equal(plan.ok, false);
  assert.match(plan.errors.join(), /not on the board, refused: "Stranger Danger"/);
  assert.equal(plan.doc, undefined);
  assert.match(formatPlan(plan), /Nothing is written/);
});

test("bad values refuse the whole file, naming the entry and the field", () => {
  for (const [row, re] of [
    [{ name: "Mossy Pete", rsvp: "yes" }, /rsvp "yes" is not one of in, maybe, late, out/],
    [{ name: "Mossy Pete", when: "midnight" }, /when/],
    [{ name: "Mossy Pete", pack: "maybe" }, /pack/],
    [{ name: "Mossy Pete", updated: "yesterday" }, /updated must be an ISO date/],
    [{ name: "Mossy Pete", meet: "<script>" }, /plain text/],
    [{ name: "Mossy Pete", meet_other: "x".repeat(200) }, /at most 80/],
    [{ rsvp: "in" }, /no name/],
  ]) {
    const plan = buildPlan({ exported: { entries: [row] }, party, current });
    assert.equal(plan.ok, false, JSON.stringify(row));
    assert.match(plan.errors.join(), re);
  }
  assert.equal(buildPlan({ exported: { nope: 1 }, party, current }).ok, false);
  assert.equal(buildPlan({ exported: { entries: ["x"] }, party, current }).ok, false);
});

test("idempotent: applying the plan and importing the same file again finds nothing to change", async () => {
  const first = buildPlan({ exported: exportDoc, party, current });
  const written = await finalize(first.doc);
  const again = buildPlan({ exported: exportDoc, party, current: written });
  assert.equal(again.ok, true);
  assert.deepEqual(again.changes, []);
  assert.deepEqual(again.counts, { in_file: 4, people: 3, add: 0, update: 0, unchanged: 3 });
  assert.deepEqual(again.doc.entries, written.entries);
  // and a different order of the same file gives the same document
  const shuffled = { ...exportDoc, entries: [...exportDoc.entries].reverse() };
  const other = buildPlan({ exported: shuffled, party, current });
  assert.deepEqual(other.doc.entries.map((e) => [e.name, e.rsvp, e.updated]).sort(), first.doc.entries.map((e) => [e.name, e.rsvp, e.updated]).sort());
  // intents too
  const i1 = await finalize(buildPlan({ exported: exportIntents, party, current }).doc);
  assert.deepEqual(buildPlan({ exported: exportIntents, party, current: i1 }).changes, []);
});

test("an older export never overwrites newer data", () => {
  const older = { entries: [{ name: "Tobble Wick", rsvp: "in", when: "8pm", updated: "2026-01-01T00:00:00.000Z" }] };
  const plan = buildPlan({ exported: older, party, current });
  assert.deepEqual(plan.changes, []);
  assert.deepEqual(entry(plan.doc, "Tobble Wick"), current.entries[1]);
});

test("tallies are the Worker's own: the finalised document equals recomputeSignupTallies of its entries, and updated is kept", async () => {
  const plan = buildPlan({ exported: exportDoc, party, current });
  const doc = await finalize(plan.doc);
  const ref = JSON.parse(JSON.stringify({ options: plan.doc.options, entries: plan.doc.entries }));
  await recomputeSignupTallies(ref);
  assert.deepEqual(doc.tallies, ref.tallies);
  assert.equal(doc.updated, current.updated);
  assert.equal(doc.tallies.rsvp.late.count, 1);
  assert.equal(doc.tallies.meet["Valley of Strength"].count, 1);
});

test("dry run touches no network and no file: the CLI prints the plan and exits 0 (or 1 on a refusal)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imp-"));
  try {
    const f = (n, o) => { const p = path.join(dir, n); fs.writeFileSync(p, JSON.stringify(o)); return p; };
    const env = { ...process.env, BOARD_ADMIN_TOKEN: "", HTTPS_PROXY: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9" };
    const ok = spawnSync("node", [TOOL, "--in", f("e.json", exportDoc), "--party-file", f("p.json", party), "--current-file", f("c.json", current)], { encoding: "utf8", env });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /^DRY RUN: nothing is sent/);
    assert.match(ok.stdout, /to add: 2; to update: 1; already up to date: 0/);
    assert.match(ok.stdout, /update =Mossy Pete= \(mossy-pete\): pack, meet, when, updated, rsvp|update =Mossy Pete= \(mossy-pete\):/);
    const json = spawnSync("node", [TOOL, "--in", f("e.json", exportDoc), "--party-file", f("p.json", party), "--json"], { encoding: "utf8", env });
    assert.equal(JSON.parse(json.stdout).counts.add, 4 - 1, "without --current-file everything is new (three people)");
    const refused = spawnSync("node", [TOOL, "--in", f("b.json", { entries: [{ name: "Nobody Here", rsvp: "in" }] }), "--party-file", f("p.json", party)], { encoding: "utf8", env });
    assert.equal(refused.status, 1);
    assert.match(refused.stdout, /REFUSED/);
    const noToken = spawnSync("node", [TOOL, "--in", f("e.json", exportDoc), "--party-file", f("p.json", party), "--apply", "--api", "http://127.0.0.1:9"], { encoding: "utf8", env });
    assert.equal(noToken.status, 1);
    assert.match(noToken.stdout + noToken.stderr, /BOARD_ADMIN_TOKEN is not set; nothing was sent/);
    const mix = spawnSync("node", [TOOL, "--in", "x", "--apply", "--current-file", "y"], { encoding: "utf8", env });
    assert.equal(mix.status, 2);
    assert.equal(spawnSync("node", [TOOL], { encoding: "utf8" }).status, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("apply: reads the live document, saves a backup, PUTs once with the admin token; a second run sends nothing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imp-")), backupPath = path.join(dir, "backup.json");
  const TOKEN = "admin-token-for-tests-0123456789abcdef";
  let live = JSON.parse(JSON.stringify(current)); const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push([init.method || "GET", url, init.headers && init.headers.authorization]);
    if ((init.method || "GET") === "PUT") { live = JSON.parse(init.body); return new Response("{}", { status: 200 }); }
    return new Response(JSON.stringify(live), { status: 200 });
  };
  try {
    const r1 = await applyImport({ exported: exportDoc, party, api: "https://api.test/", env: { BOARD_ADMIN_TOKEN: TOKEN }, fetchImpl, backupPath });
    assert.equal(r1.ok, true);
    assert.equal(r1.changed, true);
    assert.deepEqual(calls.map((c) => c[0]), ["GET", "PUT"]);
    assert.equal(calls[1][1], "https://api.test/api/data/signups");
    assert.equal(calls[1][2], `Bearer ${TOKEN}`);
    assert.equal(calls[0][2], undefined, "the read sends no token");
    assert.deepEqual(JSON.parse(fs.readFileSync(backupPath, "utf8")), current);
    assert.equal((fs.statSync(backupPath).mode & 0o777), 0o600);
    assert.equal(live.entries.length, 4);
    assert.equal(live.tallies.rsvp.late.count, 1);
    assert.equal(r1.log.join().includes(TOKEN), false, "the token is never printed");
    calls.length = 0;
    const r2 = await applyImport({ exported: exportDoc, party, api: "https://api.test", env: { BOARD_ADMIN_TOKEN: TOKEN }, fetchImpl, backupPath });
    assert.equal(r2.ok, true);
    assert.equal(r2.changed, false);
    assert.deepEqual(calls.map((c) => c[0]), ["GET"], "the second run only reads");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("apply stops without writing when the token is missing, the read fails, the document is odd, a name is unknown, or the PUT is refused", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imp-")), backupPath = path.join(dir, "b.json");
  const put = []; const ok = (body, status = 200) => async (url, init = {}) => { if (init.method === "PUT") { put.push(1); return new Response("{}", { status: init.status || 401 }); } return new Response(JSON.stringify(body), { status }); };
  const run = (env, fetchImpl, exported = exportDoc) => applyImport({ exported, party, api: "https://api.test", env, fetchImpl, backupPath });
  try {
    assert.equal((await run({}, ok(current))).ok, false);
    assert.equal((await run({ BOARD_ADMIN_TOKEN: "t".repeat(30) }, ok(current, 500))).ok, false);
    assert.match((await run({ BOARD_ADMIN_TOKEN: "t".repeat(30) }, ok({ nope: 1 }))).log.join(), /no entries list/);
    assert.equal((await run({ BOARD_ADMIN_TOKEN: "t".repeat(30) }, ok(current), { entries: [{ name: "Nobody Here", rsvp: "in" }] })).ok, false);
    assert.equal(put.length, 0);
    const refused = await run({ BOARD_ADMIN_TOKEN: "t".repeat(30) }, ok(current));
    assert.equal(refused.ok, false);
    assert.equal(put.length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("arguments: unknown options and missing values are errors; the token is not an option", () => {
  assert.throws(() => parseArgv(["--token", "x"]), /unknown option/);
  assert.throws(() => parseArgv(["--in"]), /needs a value/);
  assert.deepEqual(parseArgv(["--in", "a", "--apply", "--json"]), { in: "a", apply: true, json: true });
});

test("fixtures hold no real-looking contact details or long ids", () => {
  for (const n of ["party.json", "export-doc.json", "export-intents.json", "current.json"]) {
    const t = fs.readFileSync(new URL(`./fixtures/signups/${n}`, import.meta.url), "utf8");
    assert.doesNotMatch(t, /\d{17,20}/);
    assert.doesNotMatch(t, /@[a-z0-9.-]+\.[a-z]{2,}/i);
    assert.equal(t.includes("\r"), false);
  }
});
