import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { flagOn } from "../../infrastructure/worker/flags.js";
import { feedOn } from "../../infrastructure/worker/feed.js";
import { stripFlagship, hasFlagship } from "../../tools/strip-flagship-binding.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const toml = read("infrastructure/wrangler.toml");
const bind = (fn) => ({ getBooleanValue: fn });

test("binding true -> on; false -> off; the default passed is false and no third argument", async () => {
  let seen;
  assert.equal(await flagOn({ FLAGS: bind(async (...a) => { seen = a; return true; }) }, "D1_FEED"), true);
  assert.deepEqual(seen, ["D1_FEED", false]);
  assert.equal(await flagOn({ FLAGS: bind(async () => false) }, "D1_FEED"), false);
});

test("a throw (sync or async) or a missing flag means off, even when the legacy var says on", async () => {
  assert.equal(await flagOn({ D1_FEED: "on", FLAGS: bind(async () => { throw new Error("flag not found"); }) }, "D1_FEED"), false);
  assert.equal(await flagOn({ D1_FEED: "on", FLAGS: bind(() => { throw new Error("boom"); }) }, "D1_FEED"), false);
});

test("a non-boolean answer is off", async () => {
  for (const v of ["true", 1, null, undefined]) assert.equal(await flagOn({ FLAGS: bind(async () => v) }, "D1_FEED"), false);
});

test("no binding: the legacy [vars] value of the same name decides, as before", async () => {
  assert.equal(await flagOn({ D1_FEED: "on" }, "D1_FEED"), true);
  assert.equal(await flagOn({ D1_FEED: " ON " }, "D1_FEED"), true);
  assert.equal(await flagOn({ D1_FEED: "off" }, "D1_FEED"), false);
  assert.equal(await flagOn({}, "D1_FEED"), false);
  assert.equal(await flagOn(undefined, "D1_FEED"), false);
  assert.equal(await flagOn({ FLAGS: {}, D1_FEED: "on" }, "D1_FEED"), true, "a binding without getBooleanValue counts as missing");
});

test("feedOn uses the flag D1_FEED", async () => {
  assert.equal(await feedOn({ D1_FEED: "on" }), true);
  assert.equal(await feedOn({ D1_FEED: "on", FLAGS: bind(async () => false) }), false);
});

test("wrangler.toml has exactly the production Flagship binding, and D1_FEED stays off as the fallback", () => {
  const blocks = toml.match(/^\[\[flagship\]\][^\[]*/gm) || [];
  assert.equal(blocks.length, 1);
  assert.match(blocks[0], /^binding = "FLAGS"$/m);
  assert.match(blocks[0], /^app_id = "1f0b836c-4929-4728-8bee-6b8bde677e79"$/m);
  assert.ok(toml.indexOf("[[flagship]]") < toml.search(/^\[vars\]/m), "the binding sits before [vars]");
  assert.match(toml, /^D1_FEED = "off"/m);
});

test("every flag key the Worker reads through flagOn is listed in the runbook, spelled exactly, and has a [vars] fallback that is off", () => {
  const dir = path.join(ROOT, "infrastructure/worker");
  const keys = new Set();
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".js") && n !== "flags.js" && n !== "moments.js")) {
    for (const m of fs.readFileSync(path.join(dir, f), "utf8").matchAll(/\bflagOn\(\s*env\s*,\s*"([^"]+)"/g)) keys.add(m[1]);
  }
  assert.deepEqual([...keys].sort(), ["D1_FEED"]);
  const doc = read("docs/runbooks/flags.md");
  for (const k of keys) {
    assert.ok(doc.includes("`" + k + "`"), `${k} is listed in docs/runbooks/flags.md`);
    assert.match(toml, new RegExp(`^${k} = "off"`, "m"));
  }
});

test("strip: removes the [[flagship]] block and nothing else; the preview config keeps the legacy [vars]", () => {
  const out = stripFlagship(toml);
  assert.equal(hasFlagship(toml), true);
  assert.equal(hasFlagship(out), false);
  assert.match(out, /^D1_FEED = "off"/m);
  assert.match(out, /^\[ai\]/m);
  assert.equal(toml.split("\n").length - out.split("\n").length, 4, "header, binding, app_id and the blank separator line only");
  assert.equal(out.includes("1f0b836c"), false);
});

test("strip tool CLI rewrites the file, and fails on an inline flagship key it cannot remove", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strip-"));
  const f = path.join(dir, "wrangler.toml");
  fs.writeFileSync(f, toml);
  execFileSync(process.execPath, [path.join(ROOT, "tools/strip-flagship-binding.mjs"), f], { stdio: "pipe" });
  assert.equal(hasFlagship(fs.readFileSync(f, "utf8")), false);
  const g = path.join(dir, "inline.toml");
  fs.writeFileSync(g, 'name = "x"\nflagship = [ { binding = "FLAGS", app_id = "a" } ]\n');
  const r = spawnSync(process.execPath, [path.join(ROOT, "tools/strip-flagship-binding.mjs"), g], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /still present/);
});

// ---- timeout (a slow Flagship must not stall requests) ----
import { FLAG_TIMEOUT_MS } from "../../infrastructure/worker/flags.js";

test("a binding that never resolves answers false within the timeout, even when the legacy var says on", async () => {
  const t0 = Date.now();
  assert.equal(await flagOn({ D1_FEED: "on", FLAGS: bind(() => new Promise(() => {})) }, "D1_FEED"), false);
  const ms = Date.now() - t0;
  assert.ok(ms >= FLAG_TIMEOUT_MS - 15 && ms < FLAG_TIMEOUT_MS + 700, `answered after ${ms} ms`);
});

test("a binding that resolves true quickly answers true without waiting for the timeout", async () => {
  const t0 = Date.now();
  assert.equal(await flagOn({ FLAGS: bind(() => new Promise((r) => setTimeout(() => r(true), 10))) }, "D1_FEED"), true);
  assert.ok(Date.now() - t0 < FLAG_TIMEOUT_MS, "did not wait for the timeout");
});

test("a binding that answers after the timeout loses the race (false); a late rejection is not an unhandled rejection", async () => {
  const seen = [];
  const onUnhandled = (e) => seen.push(e);
  process.on("unhandledRejection", onUnhandled);
  try {
    assert.equal(await flagOn({ FLAGS: bind(() => new Promise((_, rej) => setTimeout(() => rej(new Error("late")), FLAG_TIMEOUT_MS + 80))) }, "D1_FEED"), false);
    assert.equal(await flagOn({ FLAGS: bind(() => new Promise((r) => setTimeout(() => r(true), FLAG_TIMEOUT_MS + 80))) }, "D1_FEED"), false);
    await new Promise((r) => setTimeout(r, FLAG_TIMEOUT_MS + 250));
    assert.deepEqual(seen, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

// ---- strip tool: env blocks, dotted keys, wrangler.json(c) ----
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "strip-"));
const STRIP_CLI = path.join(ROOT, "tools/strip-flagship-binding.mjs");
const runCli = (f) => spawnSync(process.execPath, [STRIP_CLI, f], { encoding: "utf8" });

test("strip removes [[env.NAME.flagship]], [env.NAME.flagship], quoted and sub-table forms, and keeps the neighbours", () => {
  const src = [
    'name = "w"', "",
    "[[env.staging.flagship]]", 'binding = "FLAGS"', 'app_id = "a"', "",
    "[env.staging.vars]", 'X = "1"', "",
    '[[env."my env".flagship]]', 'binding = "FLAGS"', "",
    "[env.prod.flagship]", 'binding = "FLAGS"', "",
    "[flagship.extra]", 'k = "v"', "",
    "[vars]", 'D1_FEED = "off"', "",
  ].join("\n");
  assert.equal(hasFlagship(src), true);
  const out = stripFlagship(src);
  assert.equal(hasFlagship(out), false);
  assert.match(out, /\[env\.staging\.vars\]\nX = "1"/);
  assert.match(out, /\[vars\]\nD1_FEED = "off"/);
  assert.equal(/FLAGS|app_id/.test(out), false);
});

test("hasFlagship detects dotted and inline keys; the CLI refuses them and leaves the file untouched", () => {
  for (const line of ['flagship.binding = "FLAGS"', 'flagship = [ { binding = "FLAGS", app_id = "a" } ]', 'env.staging.flagship = [ { binding = "FLAGS" } ]', '"flagship" = []', "[env.x]\nflagship = []"]) {
    assert.equal(hasFlagship(`name = "x"\n${line}\n`), true, line);
    const dir = tmp(); const f = path.join(dir, "wrangler.toml"); const src = `name = "x"\n${line}\n`;
    fs.writeFileSync(f, src);
    const r = runCli(f);
    assert.equal(r.status, 1, line);
    assert.equal(fs.readFileSync(f, "utf8"), src, "file untouched on failure");
  }
});

test("a comment or an unrelated name that merely contains the word is not a flagship binding", () => {
  assert.equal(hasFlagship('# [[flagship]] is stripped for previews\n[vars]\nFLAGSHIP_NOTE = "x"\nNAME = "flagship"\n'), false);
});

test("the CLI fails when wrangler.json or wrangler.jsonc sits next to wrangler.toml, and succeeds without them", () => {
  for (const n of ["wrangler.json", "wrangler.jsonc"]) {
    const dir = tmp(); const f = path.join(dir, "wrangler.toml");
    fs.writeFileSync(f, toml); fs.writeFileSync(path.join(dir, n), "{}");
    const r = runCli(f);
    assert.equal(r.status, 1, n);
    assert.ok(r.stderr.includes(n));
    assert.equal(fs.readFileSync(f, "utf8"), toml, "toml untouched");
  }
  const dir = tmp(); const f = path.join(dir, "wrangler.toml"); fs.writeFileSync(f, toml);
  assert.equal(runCli(f).status, 0);
  assert.equal(hasFlagship(fs.readFileSync(f, "utf8")), false);
});

test("the repo has no wrangler.json or wrangler.jsonc next to infrastructure/wrangler.toml", () => {
  assert.equal(fs.existsSync(path.join(ROOT, "infrastructure/wrangler.json")), false);
  assert.equal(fs.existsSync(path.join(ROOT, "infrastructure/wrangler.jsonc")), false);
});
