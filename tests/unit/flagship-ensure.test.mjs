// tools/flagship-ensure-flags.mjs (B51): the production deploy creates missing Flagship flags with wrangler, DISABLED, and never touches an existing one.
// The real wrangler and the real Flagship API are not used: a fake `wrangler` program records its arguments and answers from files.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseKeyList, appIdFromToml, extractFlagKeys, missingKeys, ensureFlags } from "../../tools/flagship-ensure-flags.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TOOL = path.join(ROOT, "tools/flagship-ensure-flags.mjs");
const APP = "1f0b836c-4929-4728-8bee-6b8bde677e79";
const toml = fs.readFileSync(path.join(ROOT, "infrastructure/wrangler.toml"), "utf8");

test("parseKeyList: one key per line, comments and blanks ignored, duplicates dropped, anything else throws", () => {
  assert.deepEqual(parseKeyList("# c\nD1_FEED\n\n  CARDS_ENABLED  # trailing\nD1_FEED\n"), ["D1_FEED", "CARDS_ENABLED"]);
  assert.deepEqual(parseKeyList(""), []);
  for (const bad of ["two words", "$(rm -rf)", "a;b", "--disabled", "-x", "KEY\u0000", "a".repeat(80)]) assert.throws(() => parseKeyList(bad), /not a flag key/, bad);
});

test("the committed key list parses and is not empty", () => {
  const keys = parseKeyList(fs.readFileSync(path.join(ROOT, "infrastructure/flagship-flags.txt"), "utf8"));
  assert.ok(keys.includes("D1_FEED"));
});

test("appIdFromToml reads the app id from the [[flagship]] block only, and only a UUID", () => {
  assert.equal(appIdFromToml(toml), APP);
  assert.equal(appIdFromToml('[vars]\napp_id = "' + APP + '"\n'), null);
  assert.equal(appIdFromToml('[[flagship]]\nbinding = "FLAGS"\napp_id = "not-a-uuid"\n'), null);
  assert.equal(appIdFromToml(""), null);
});

test("extractFlagKeys: bare array, wrapped array, nested wrapper, banner lines before the JSON, key spellings", () => {
  const A = [{ key: "D1_FEED", enabled: false }, { key: "OTHER" }];
  for (const out of [JSON.stringify(A), JSON.stringify({ flags: A }), JSON.stringify({ success: true, result: { flags: A } }), JSON.stringify({ data: { items: A } }),
    "\u25b2 [WARNING] Proxy environment variables detected.\n\n" + JSON.stringify(A, null, 2) + "\n", "banner [x]\n" + JSON.stringify({ result: A }) + "\ntrailing text"])
    assert.deepEqual([...extractFlagKeys(out)].sort(), ["D1_FEED", "OTHER"], out.slice(0, 60));
  assert.deepEqual([...extractFlagKeys(JSON.stringify([{ flagKey: "A" }, { flag_key: "B" }]))].sort(), ["A", "B"]);
});

test("extractFlagKeys reads the real output of wrangler 4.148.0 `flags list --json --all` (captured from its LOCAL flag store; the remote output is not verified)", () => {
  const real = '\u25b2 [WARNING] Proxy environment variables detected. We\'ll use your proxy for fetch requests.\n\n' + JSON.stringify({ items: [{ key: "D1_FEED", description: null, enabled: false, default_variation: "off", variations: { on: true, off: false }, rules: [], type: "boolean", updated_at: "2026-11-04T02:39:43.831Z" }], cursor: null }, null, 4) + "\n";
  assert.deepEqual([...extractFlagKeys(real)], ["D1_FEED"]);
  assert.equal(extractFlagKeys('{\n    "items": [],\n    "cursor": null\n}').size, 0);
});

test("extractFlagKeys: an empty list is a valid answer; anything unreadable is null", () => {
  assert.equal(extractFlagKeys("[]").size, 0);
  assert.equal(extractFlagKeys('{"flags":[]}').size, 0);
  for (const bad of ["", "   ", "not json", "Error: unauthorized", '{"success":false}', '{"flags":"x"}', '[{"enabled":true}]', '[{"key":"A"},{"id":3}]', "null", "42", undefined, null])
    assert.equal(extractFlagKeys(bad), null, String(bad));
});

test("missingKeys keeps the order of the wanted list", () => {
  assert.deepEqual(missingKeys(["A", "B", "C"], new Set(["B"])), ["A", "C"]);
  assert.deepEqual(missingKeys(["A"], new Set(["A"])), []);
});

// ---- ensureFlags with an injected run ----
const mk = (listOut, { listStatus = 0, createStatus = 0 } = {}) => {
  const calls = [], warns = [], logs = [];
  const run = (args) => { calls.push(args); return args[2] === "list" ? { status: listStatus, stdout: listOut, stderr: listStatus ? "boom" : "" } : { status: createStatus, stdout: "", stderr: createStatus ? "nope" : "" }; };
  return { calls, warns, logs, go: (keys) => ensureFlags({ keys, appId: APP, run, log: (m) => logs.push(m), warn: (m) => warns.push(m) }) };
};

test("a missing key is created with --disabled --remote; an existing key is not touched", () => {
  const t = mk(JSON.stringify([{ key: "D1_FEED" }]));
  const r = t.go(["D1_FEED", "NEW_ONE"]);
  assert.deepEqual(t.calls, [["flagship", "flags", "list", APP, "--json", "--all", "--remote"], ["flagship", "flags", "create", APP, "NEW_ONE", "--disabled", "--remote"]]);
  assert.deepEqual(r.created, ["NEW_ONE"]);
  assert.equal(r.problems, 0);
  assert.ok(t.logs.some((l) => /D1_FEED exists, left as it is/.test(l)));
});

test("every key present: only the read-only list runs", () => {
  const t = mk(JSON.stringify({ flags: [{ key: "D1_FEED" }] }));
  const r = t.go(["D1_FEED"]);
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0][2], "list");
  assert.deepEqual(r.created, []);
});

test("list fails, or its output cannot be read: nothing is created and a warning is raised", () => {
  for (const t of [mk("", { listStatus: 1 }), mk("garbage"), mk('{"flags":"x"}'), mk("")]) {
    const r = t.go(["D1_FEED"]);
    assert.equal(t.calls.length, 1, "only list was attempted");
    assert.deepEqual(r.created, []);
    assert.equal(r.problems, 1);
    assert.match(t.warns[0], /Created nothing/);
  }
});

test("a failed create is a warning, the other keys are still tried, and nothing else runs", () => {
  const t = mk("[]", { createStatus: 1 });
  const r = t.go(["A1", "B2"]);
  assert.equal(t.calls.filter((c) => c[2] === "create").length, 2);
  assert.equal(r.problems, 2);
  assert.deepEqual(r.created, []);
});

test("only `list` and `create` are ever called, and create always carries --disabled (never enable, update, disable, split, rules, delete)", () => {
  const t = mk(JSON.stringify([{ key: "X" }]));
  t.go(["X", "Y", "Z"]);
  for (const c of t.calls) {
    assert.deepEqual(c.slice(0, 2), ["flagship", "flags"]);
    assert.ok(["list", "create"].includes(c[2]), c.join(" "));
    if (c[2] === "create") assert.ok(c.includes("--disabled") && c.includes("--remote"), c.join(" "));
  }
  const src = fs.readFileSync(TOOL, "utf8").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  assert.equal(/"(enable|disable|update|split|rules|delete|evaluate|pull)"/.test(src), false, "no other wrangler flagship subcommand appears in the code");
});

test("a bad app id or no keys: nothing runs", () => {
  const calls = [];
  const run = (a) => { calls.push(a); return { status: 0, stdout: "[]", stderr: "" }; };
  assert.equal(ensureFlags({ keys: ["A"], appId: null, run, warn() {} }).problems, 1);
  assert.equal(ensureFlags({ keys: [], appId: APP, run }).problems, 0);
  assert.equal(calls.length, 0);
});

test("dry run lists but creates nothing", () => {
  const t = mk("[]");
  const r = ensureFlags({ keys: ["A1"], appId: APP, dryRun: true, run: (a) => { t.calls.push(a); return { status: 0, stdout: "[]", stderr: "" }; }, log() {}, warn() {} });
  assert.equal(t.calls.length, 1);
  assert.deepEqual(r.created, []);
});

// ---- the CLI, with a fake wrangler program ----
function fake({ list = "[]", listStatus = 0, createStatus = 0, stderr = "" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flagfake-"));
  const log = path.join(dir, "calls.jsonl"), prog = path.join(dir, "wrangler");
  fs.writeFileSync(path.join(dir, "list.txt"), list);
  fs.writeFileSync(prog, `#!${process.execPath}\nconst fs=require("fs"),a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+"\\n");\nconst L=a[2]==="list";process.stderr.write(${JSON.stringify(stderr)});\nif(L){process.stdout.write(fs.readFileSync(${JSON.stringify(path.join(dir, "list.txt"))},"utf8"));process.exit(${listStatus});}process.exit(${createStatus});\n`, { mode: 0o755 });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { prog, calls, dir };
}
const cli = (f, extra = [], env = {}) => spawnSync(process.execPath, [TOOL, ...extra], { encoding: "utf8", env: { ...process.env, FLAGSHIP_WRANGLER: f.prog, CLOUDFLARE_API_TOKEN: "", ...env } });

test("CLI: creates the missing key disabled, leaves the existing key, exit 0", () => {
  const f = fake({ list: JSON.stringify([{ key: "OTHER" }]) });
  const r = cli(f);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(f.calls().map((c) => c.slice(2, 3)[0]), ["list", "create"]);
  assert.deepEqual(f.calls()[1], ["flagship", "flags", "create", APP, "D1_FEED", "--disabled", "--remote"]);
  assert.match(r.stdout, /created D1_FEED \(disabled/);
});

test("CLI: the key already exists: no create, exit 0", () => {
  const f = fake({ list: JSON.stringify({ flags: [{ key: "D1_FEED", enabled: true }] }) });
  const r = cli(f);
  assert.equal(r.status, 0);
  assert.equal(f.calls().length, 1);
  assert.match(r.stdout, /D1_FEED exists, left as it is/);
});

test("CLI: unreadable list output -> no create, a ::warning:: annotation, exit 1", () => {
  const f = fake({ list: "Error: something else entirely" });
  const r = cli(f);
  assert.equal(r.status, 1);
  assert.equal(f.calls().length, 1);
  assert.match(r.stdout, /::warning title=Flagship flags::.*Created nothing/);
});

test("CLI: list command fails -> no create, warning, exit 1", () => {
  const f = fake({ listStatus: 2, stderr: "authentication error" });
  const r = cli(f);
  assert.equal(r.status, 1);
  assert.equal(f.calls().length, 1);
  assert.match(r.stdout, /::warning/);
});

test("CLI: the API token never appears in the output, even when wrangler echoes it in an error", () => {
  const TOKEN = "cf-secret-token-0123456789";
  const f = fake({ listStatus: 1, stderr: `request failed with Authorization: Bearer ${TOKEN}` });
  const r = cli(f, [], { CLOUDFLARE_API_TOKEN: TOKEN });
  assert.equal(r.status, 1);
  assert.equal((r.stdout + r.stderr).includes(TOKEN), false);
  assert.match(r.stdout, /\*\*\*/);
});

test("CLI: a malformed key list or missing toml block -> nothing runs, exit 1", () => {
  const f = fake();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keys-"));
  const keys = path.join(dir, "k.txt"); fs.writeFileSync(keys, "good_key\nbad key; rm\n");
  assert.equal(cli(f, ["--keys", keys]).status, 1);
  const noToml = path.join(dir, "w.toml"); fs.writeFileSync(noToml, "[vars]\nX = 1\n");
  assert.equal(cli(f, ["--toml", noToml]).status, 1);
  assert.equal(f.calls().length, 0);
});

test("CLI: --dry-run creates nothing", () => {
  const f = fake({ list: "[]" });
  const r = cli(f, ["--dry-run"]);
  assert.equal(r.status, 0);
  assert.equal(f.calls().length, 1);
  assert.match(r.stdout, /would create D1_FEED/);
});
