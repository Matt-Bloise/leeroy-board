// tools/cost-model.mjs: it runs with no dependencies and no network, its totals match a fixture worked out by hand
// (tests/fixtures/cost-model/expected.json explains the arithmetic), and the real model is still tied to the code it was read from.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { run, parseSchema, writeRows, MODEL, runScenario, limitsReport, anchorsOf } from "../../tools/cost-model.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FX = path.join(ROOT, "tests/fixtures/cost-model");
const SCRIPT = path.join(ROOT, "tools/cost-model.mjs");
const expected = JSON.parse(fs.readFileSync(path.join(FX, "expected.json"), "utf8"));

function runJson(args) {
  const lines = [];
  const code = run([...args, "--json"], (s) => lines.push(s));
  return { code, json: code === 0 ? JSON.parse(lines.join("\n")) : null, text: lines.join("\n") };
}

test("the script has no imports but node built-ins", () => {
  const src = fs.readFileSync(SCRIPT, "utf8");
  const mods = [...src.matchAll(/^import .* from "([^"]+)";?$/gm)].map((m) => m[1]);
  assert.ok(mods.length >= 3);
  for (const m of mods) assert.ok(m.startsWith("node:"), `${m} is not a node: built-in`);
  assert.ok(!/\bfetch\s*\(|node:https?|node:net|node:dns/.test(src), "the script must not touch the network");
});

test("the schema reader derives rows written from schema.sql", () => {
  const schema = parseSchema(fs.readFileSync(path.join(FX, "infrastructure/schema.sql"), "utf8"));
  assert.deepEqual(schema, expected.schema);
  assert.equal(writeRows(schema, "ev", "insert"), 3);        // row + 2 indexes, INTEGER key adds none
  assert.equal(writeRows(schema, "kv_state", "insert"), 2);  // row + automatic index of the TEXT key
  assert.equal(writeRows(schema, "kv_state", "update"), 1);  // the key does not change
  assert.equal(writeRows(schema, "ev", "update", 1, 1), 2);  // one indexed column changes
});

test("the fixture day matches the hand-worked totals", () => {
  const { code, json } = runJson(["--root", FX, "--model", path.join(FX, "model.json")]);
  assert.equal(code, 0);
  const s = json.scenarios[0];
  for (const [k, v] of Object.entries(expected.total)) assert.equal(s.total[k], v, `${k}`);
  assert.equal(s.first, expected.first);
  assert.equal(s.maxCpu.ms, expected.maxCpuMs);
});

test("the fixture's cache arithmetic is the hand-worked one", () => {
  const model = JSON.parse(fs.readFileSync(path.join(FX, "model.json"), "utf8"));
  const schema = parseSchema(fs.readFileSync(path.join(FX, "infrastructure/schema.sql"), "utf8"));
  const res = runScenario(model, schema, model.scenarios[0], { pr333: false });
  const g = res.byEp["GET /a"];
  assert.deepEqual({ demand: g.demand, misses: g.misses, hits: g.hits }, expected.get_a);
  const pcts = Object.fromEntries(limitsReport(model, res.total).map((x) => [x.key, Number(x.pct.toFixed(2))]));
  assert.deepEqual(pcts, { requests: 29.6, d1Reads: 35.58, d1Writes: 30 });
});

test("the script runs as a command, deterministically", () => {
  const args = [SCRIPT, "--root", FX, "--model", path.join(FX, "model.json")];
  const a = spawnSync(process.execPath, args, { encoding: "utf8" });
  const b = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(a.status, 0, a.stderr);
  assert.equal(a.stdout, b.stdout);
  assert.match(a.stdout, /### Scenarios/);
  assert.match(a.stdout, /First limit: \*\*rows read\*\* at 35\.6%/);
});

test("a model anchor that is no longer in the code fails the run", () => {
  const model = JSON.parse(fs.readFileSync(path.join(FX, "model.json"), "utf8"));
  model.endpoints["GET /a"].miss.stmts[0].a = "SELECT json FROM a_table_that_was_renamed";
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || "/tmp"), "cost-model-"));
  const f = path.join(tmp, "model.json");
  fs.writeFileSync(f, JSON.stringify(model));
  const lines = [];
  const code = run(["--root", FX, "--model", f], (s) => lines.push(s));
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.equal(code, 1);
  assert.match(lines.join("\n"), /no longer contains/);
});

// Tests below price the real MODEL against PINNED copies of infrastructure/schema.sql and wrangler.toml (tests/fixtures/cost-model-pinned),
// never the live tree, so a SQL reformat or a flag flip elsewhere cannot turn the gating unit job red. Whether the live code still
// contains every anchor is a separate, non-gating check: `npm --prefix tests run cost-model:check` (node tools/cost-model.mjs --check).
const PINNED = path.join(ROOT, "tests/fixtures/cost-model-pinned");
const PIN = ["--root", PINNED, "--no-anchors"];

test("every anchor of the real model names a file and a non-empty fragment", () => {
  const list = anchorsOf(MODEL, { pr333Tree: false }), list333 = anchorsOf(MODEL, { pr333Tree: true });
  assert.ok(list.length > 100 && list333.length > list.length);
  for (const a of [...list, ...list333]) assert.ok(a.file && typeof a.text === "string" && a.text.trim().length >= 4, `${a.where}`);
});

test("the real model runs on the pinned snapshot and stays inside what the snapshot says", () => {
  const master = runJson(PIN);
  assert.equal(master.code, 0);
  assert.equal(master.json.scenarios.length, MODEL.scenarios.length);
  assert.deepEqual(master.json.warnings, [], "the pinned wrangler.toml sets a flag the model prices as off, or the crons changed");
  for (const s of master.json.scenarios) {
    for (const v of Object.values(s.total)) assert.ok(Number.isFinite(v) && v >= 0);
    assert.ok(["requests", "d1Reads", "d1Writes", "neurons", "doRequests"].includes(s.first));
  }
  // the PR 333 overlay only adds work: no scenario gets cheaper (rows read within 1 percent), and the polling scenario pays for the lost cache
  const pr = runJson([...PIN, "--assume-pr333"]);
  assert.equal(pr.code, 0);
  for (let i = 0; i < master.json.scenarios.length; i++) {
    const m = master.json.scenarios[i].total, p = pr.json.scenarios[i].total;
    assert.ok(p.d1q >= m.d1q && p.rr >= m.rr * 0.99 && p.req >= m.req, master.json.scenarios[i].name); // the ask path reads one row fewer (the party row moves to the sheets read)
  }
  const poll = (j) => j.scenarios.find((s) => s.name === "Ten polling tabs").total;
  assert.ok(poll(pr.json).d1q > 1.5 * poll(master.json).d1q);
});

test("the markdown report has its tables", () => {
  const lines = [];
  assert.equal(run(PIN, (s) => lines.push(s)), 0);
  const md = lines.join("\n");
  const diff = [];
  assert.equal(run([...PIN, "--diff"], (x) => diff.push(x)), 0);
  assert.match(diff.join("\n"), /### PR 333 against master: a day each/);
  for (const h of ["### Limits used", "### Cost of one request, per route", "### Scenarios (a day each)", "### What alone exhausts each limit"]) assert.ok(md.includes(h), h);
});
