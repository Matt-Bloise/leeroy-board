// Unit tests for tools/add-member.mjs. Made-up ids and names only. No network, no D1, no AI: the apply path runs against a stub fetch.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPlan, formatPlan, applyPlan, slugify, partyEntry } from "../../tools/add-member.mjs";
import { validateMemberEntry } from "../../infrastructure/worker/members.js";
import { validateConfigValue } from "../../infrastructure/worker/config.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(root, "tools", "add-member.mjs");
const FIXTURE = path.join(root, "tests", "fixtures", "six-members", "party.json");
const ARGS = ["--id", "100000000000000007", "--name", "Wick Marrowbone", "--class", "shaman", "--race", "tauren"];
const run = (args, env = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
const five = () => ({ faction: "Horde", members: Array.from({ length: 5 }, (_, i) => ({ name: `Made Up ${i}` })) });

test("dry run is the default: it prints the plan, sends nothing, exits 0", () => {
  const r = run(ARGS);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^DRY RUN: nothing is sent\. Add --apply to send\./);
  assert.match(r.stdout, /1\. POST \/api\/admin\/members/);
  assert.match(r.stdout, /2\. PUT \/api\/data\/party/);
  assert.match(r.stdout, /"slug": "wick-marrowbone"/);
  assert.match(r.stdout, /"id": "100000000000000007"/);
  assert.match(r.stdout, /"match": \[\s*"wick marrowbone"\s*\]/);
  assert.match(r.stdout, /Rollback: docs\/runbooks\/add-party-member\.md/);
});

test("dry run with a saved party document shows the count going from five to six", () => {
  const f = path.join(os.tmpdir(), `add-member-test-${process.pid}.json`);
  fs.writeFileSync(f, JSON.stringify(five()));
  try {
    const r = run([...ARGS, "--party-file", f]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /members: 5 -> 6/);
    assert.doesNotMatch(r.stdout, /warning/);
  } finally { fs.unlinkSync(f); }
});

test("the plan lists what has no route instead of inventing one", () => {
  const r = run(ARGS);
  for (const part of ["Member key: no route exists", "PARTY_MEMBERS", "ROSTER_DATA", "name_map", "party.n"]) assert.ok(r.stdout.includes(part), part);
  assert.doesNotMatch(r.stdout, /\/api\/(members|keys|sheet)\b/);
});

test("the new party entry has the shape the board reads, and a spec still open", () => {
  const e = partyEntry({ name: "Wick Marrowbone", cls: "shaman", race: "tauren", role: "damage", startZone: null });
  assert.deepEqual(Object.keys(e), ["name", "class_key", "class", "race", "spec", "spec_status", "role", "role_detail", "color", "start_zone", "board_line", "professions"]);
  assert.equal(e.class, "Shaman");
  assert.equal(e.start_zone, "Mulgore");
  assert.equal(e.board_line, "Tauren Shaman");
  assert.deepEqual(e.spec_status, { status: "open", source: "board" });
  const shipped = JSON.parse(fs.readFileSync(FIXTURE, "utf8")).members[0];
  assert.deepEqual(Object.keys(e), Object.keys(shipped));
});

test("the roster entry passes the Worker's own validators", () => {
  const p = buildPlan(Object.fromEntries([["id", "100000000000000007"], ["name", "Wick Marrowbone"], ["class", "shaman"], ["race", "tauren"]]));
  assert.equal(p.ok, true);
  assert.equal(validateMemberEntry(p.roster), null);
  assert.equal(validateConfigValue("discord_members", [p.roster]), null);
});

test("a priest defaults to healer, a role can be overridden, an unknown race needs a start zone", () => {
  assert.equal(buildPlan({ id: "100000000000000007", name: "Wick", class: "priest", race: "undead" }).entry.role, "healer");
  assert.equal(buildPlan({ id: "100000000000000007", name: "Wick", class: "priest", race: "undead", role: "damage" }).entry.role, "damage");
  assert.equal(buildPlan({ id: "100000000000000007", name: "Wick", class: "mage", race: "pandaren" }).ok, false);
  assert.equal(buildPlan({ id: "100000000000000007", name: "Wick", class: "mage", race: "pandaren", "start-zone": "The Wandering Isle" }).entry.start_zone, "The Wandering Isle");
});

test("bad input is refused with exit 2 and a reason", () => {
  for (const [args, re] of [
    [["--id", "123", "--name", "Wick", "--class", "mage", "--race", "orc"], /--id must be/],
    [[...ARGS.slice(0, 2), "--name", "Wick@example.com", "--class", "mage", "--race", "orc"], /game handle/],
    [[...ARGS.slice(0, 2), "--name", "Blizzard Wick", "--class", "mage", "--race", "orc"], /game handle/],
    [[...ARGS.slice(0, 2), "--name", "Wick", "--class", "bard", "--race", "orc"], /--class must be/],
    [[...ARGS.slice(0, 2), "--name", "x".repeat(41), "--class", "mage", "--race", "orc"], /--name must be 1 to 40/],
    [[...ARGS, "--slug", "Not A Slug"], /--slug must be/],
  ]) {
    const r = run(args);
    assert.equal(r.status, 2, args.join(" "));
    assert.match(r.stderr, re);
    assert.equal(r.stdout, "");
  }
});

test("a name already on the board is skipped in the plan, so a second run changes nothing", () => {
  const p = buildPlan({ id: "100000000000000007", name: "made up 2", class: "mage", race: "orc" }, five());
  assert.equal(p.ok, true);
  assert.equal(p.requests[1].skipped, true);
  assert.match(formatPlan(p), /SKIPPED/);
  assert.equal(p.nextDoc, null);
});

test("an Alliance race in a Horde party is a warning", () => {
  const p = buildPlan({ id: "100000000000000007", name: "Wick", class: "mage", race: "gnome" }, five());
  assert.match(p.warnings.join(" "), /Gnome is Alliance, the party is Horde/);
});

test("slugify", () => {
  assert.equal(slugify("Wick Marrowbone"), "wick-marrowbone");
  assert.equal(slugify("  Tallow  Vex!! "), "tallow-vex");
  assert.equal(slugify("Ünï Cödé"), "uni-code");
  assert.ok(slugify("a".repeat(60)).length <= 32);
});

test("--apply with no admin token sends nothing", async () => {
  const p = buildPlan({ id: "100000000000000007", name: "Wick", class: "mage", race: "orc" });
  let calls = 0;
  const r = await applyPlan(p, { api: "https://example.test", env: {}, fetchImpl: async () => { calls++; return { ok: true, status: 200 }; }, backupPath: "unused" });
  assert.equal(r.ok, false);
  assert.equal(calls, 0);
  const cli = run([...ARGS, "--apply"]);
  assert.equal(cli.status, 1);
  assert.match(cli.stdout + cli.stderr, /BOARD_ADMIN_TOKEN is not set; nothing was sent/);
});

test("--apply order: read, back up, roster, then party; the token goes in a header and nowhere else", async () => {
  const p = buildPlan({ id: "100000000000000007", name: "Wick", class: "mage", race: "orc" });
  const calls = [], backup = path.join(os.tmpdir(), `add-member-backup-${process.pid}.json`);
  const doc = five();
  const fetchImpl = async (url, init = {}) => { calls.push({ url, method: init.method || "GET", headers: init.headers || {}, body: init.body }); return { ok: true, status: 200, json: async () => doc }; };
  try {
    const r = await applyPlan(p, { api: "https://example.test/", env: { BOARD_ADMIN_TOKEN: "test-token-not-real" }, fetchImpl, backupPath: backup });
    assert.equal(r.ok, true);
    assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), ["GET https://example.test/api/data/party", "POST https://example.test/api/admin/members", "PUT https://example.test/api/data/party"]);
    assert.equal(calls[0].headers.authorization, undefined);
    assert.equal(calls[1].headers.authorization, "Bearer test-token-not-real");
    assert.equal(JSON.parse(calls[2].body).members.length, 6);
    assert.equal(JSON.parse(fs.readFileSync(backup, "utf8")).members.length, 5);
    for (const c of calls) assert.ok(!String(c.url).includes("test-token") && !String(c.body || "").includes("test-token"));
    assert.ok(!r.log.join("\n").includes("test-token"));
  } finally { fs.rmSync(backup, { force: true }); }
});

test("--apply stops at the first failed step and never sends the party document after a failed roster write", async () => {
  const p = buildPlan({ id: "100000000000000007", name: "Wick", class: "mage", race: "orc" });
  const calls = [], backup = path.join(os.tmpdir(), `add-member-backup2-${process.pid}.json`);
  const fetchImpl = async (url, init = {}) => { calls.push(init.method || "GET"); return init.method === "POST" ? { ok: false, status: 400, json: async () => ({}) } : { ok: true, status: 200, json: async () => five() }; };
  try {
    const r = await applyPlan(p, { api: "https://example.test", env: { BOARD_ADMIN_TOKEN: "test-token-not-real" }, fetchImpl, backupPath: backup });
    assert.equal(r.ok, false);
    assert.deepEqual(calls, ["GET", "POST"]);
  } finally { fs.rmSync(backup, { force: true }); }
});
