// Flags that default off are NOT declared in infrastructure/wrangler.toml [vars]: the Workers Free plan allows 64 variables in all (secrets + text), see var-budget.test.mjs.
// This file proves that is a no-op: for every removed flag, (1) the helper that gates it answers identically with the variable absent and with "off", and false either way,
// (2) a static scan finds no read of the flag in the Worker or the Pages worker outside the gate the test calls (so no other code path can default it on), (3) the flag is not
// declared in wrangler.toml, is listed as optional in wrangler-flags.test.mjs, and is documented in docs/runbooks/flags.md as optional (absent = off).
// Kept declared on purpose (not tested here): ANSWER_FORMAT (default ON), any flag currently on in production, CLOUDFLARE_ACCOUNT_ID (the deploy patches it), the Flagship keys
// D1_FEED and INTEREST_NUDGES, and the flags whose own tests pin a declared "off" (ASK_OPENER, CHARS_V1, GROUP_MEMORY, LISTENER, REQUEST_GAUGE).
// Run: node --test tests/unit/off-flag-absence.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { webLoginOn } from "../../infrastructure/worker/web-auth.js";
import { dataRightsOn } from "../../infrastructure/worker/data-rights.js";
import { eventsEnabled } from "../../infrastructure/worker/scheduled-events.js";
import { momentsEnabled, momentsShadow, momentsDryRun } from "../../infrastructure/worker/moments.js";
import { buildModalEnabled, buildProjectEnabled } from "../../infrastructure/worker/build-modal.js";
import { joinPromptEnabled } from "../../infrastructure/worker/join.js";
import { answerUxEnabled } from "../../infrastructure/worker/answer-format.js";
import { untaggedOn } from "../../infrastructure/worker/listener-untagged.js";
import { cardsEnabled, cardsShadow, boardLinesEnabled } from "../../infrastructure/worker/cards.js";
import { setupCommandEnabled, manifestFor } from "../../infrastructure/worker/setup-command.js";
import { evalEnabled } from "../../infrastructure/worker/eval.js";
import { deadmanOn } from "../../infrastructure/worker/deadman.js";
import { anthropicAvailable, anthropicAuth, resetKeyCacheForTests } from "../../infrastructure/worker/ai-keys.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const toml = read("infrastructure/wrangler.toml");
const varsBlock = toml.slice(toml.indexOf("[vars]"));
const flagsDoc = read("docs/runbooks/flags.md");
const wranglerFlagsTest = read("tests/unit/wrangler-flags.test.mjs");

// flag -> { gates: [fn taking env], reads: { "<relative file>": number of non-comment source lines that mention the flag } }
// The reads map is the static proof: any new mention of the flag in the Worker (a second read that might default on) changes a count and fails.
const TABLE = {
  WEB_LOGIN: { gates: [webLoginOn], reads: { "infrastructure/worker/web-auth.js": 1 } },
  DATA_RIGHTS: { gates: [dataRightsOn], reads: { "infrastructure/worker/data-rights.js": 1 } },
  EVENTS_ENABLED: { gates: [eventsEnabled], reads: { "infrastructure/worker/scheduled-events.js": 1 } },
  MOMENTS_ENABLED: { gates: [momentsEnabled], reads: { "infrastructure/worker/moments.js": 2 } }, // the read, and the name in the both-on conflict log line
  MOMENTS_SHADOW: { gates: [momentsShadow], reads: { "infrastructure/worker/moments.js": 2 } },
  MOMENTS_DRY_RUN: { gates: [momentsDryRun], reads: { "infrastructure/worker/moments.js": 1 } },
  BUILD_MODAL: { gates: [buildModalEnabled], reads: { "infrastructure/worker/build-modal.js": 1, "infrastructure/worker/setup-command.js": 1 } }, // setup-command: manifestFor, covered below
  BUILD_PROJECT: { gates: [buildProjectEnabled], reads: { "infrastructure/worker/build-modal.js": 1 } },
  JOIN_PROMPT: { gates: [joinPromptEnabled], reads: { "infrastructure/worker/join.js": 1 } },
  ANSWER_UX: { gates: [answerUxEnabled], reads: { "infrastructure/worker/answer-format.js": 1, "infrastructure/worker/answer-ux.js": 1 } }, // answer-ux.js: the same expression, not exported
  LISTENER_UNTAGGED: { gates: [untaggedOn], reads: { "infrastructure/worker/listener-untagged.js": 1 } }, // the flag key constant; the read is legacyOn(env, UNTAGGED_FLAG)
  CARDS_ENABLED: { gates: [cardsEnabled], reads: { "infrastructure/worker/cards.js": 1 } },
  CARDS_SHADOW: { gates: [cardsShadow], reads: { "infrastructure/worker/cards.js": 1 } },
  BOARD_LINES_ENABLED: { gates: [boardLinesEnabled], reads: { "infrastructure/worker/cards.js": 1 } },
  SETUP_COMMAND: { gates: [setupCommandEnabled], reads: { "infrastructure/worker/setup-command.js": 1 } },
  EVAL_ENABLED: { gates: [evalEnabled], reads: { "infrastructure/worker/eval.js": 1 } },
  DEADMAN: { gates: [deadmanOn], reads: { "infrastructure/worker/deadman.js": 1 } }, // the flag key constant; the read is env[DEADMAN_FLAG]
  ANTHROPIC_BYOK: { gates: [], reads: { "infrastructure/worker/ai-keys.js": 2 } }, // byokOn and the name in its one-time warning text; byokOn (not exported): covered by the anthropicAvailable / anthropicAuth differential below
};
const REMOVED = Object.keys(TABLE);

function sourceFiles(dir) {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sourceFiles(`${dir}/${e.name}`) : /\.m?js$/.test(e.name) ? [`${dir}/${e.name}`] : []));
}
const code = (src) => src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).map((l) => l.replace(/\s\/\/.*$/, ""));
const SCAN = [...sourceFiles("infrastructure/worker"), ...sourceFiles("pages-worker")];
const word = (k) => new RegExp(`\\b${k}\\b`);

test("the table lists 18 removed flags and none is declared in wrangler.toml [vars]", () => {
  assert.equal(REMOVED.length, 18);
  for (const k of REMOVED) assert.ok(!new RegExp(`^${k}\\s*=`, "m").test(varsBlock), `${k} must not be declared`);
});

test("static proof: the only non-comment mentions of each removed flag in the Worker and the Pages worker are the counted gate lines", () => {
  const found = {};
  for (const f of SCAN) {
    const lines = code(read(f));
    for (const k of REMOVED) {
      const n = lines.filter((l) => word(k).test(l)).length;
      if (n) (found[k] ||= {})[f] = n;
    }
  }
  const expected = Object.fromEntries(REMOVED.map((k) => [k, TABLE[k].reads]));
  assert.deepEqual(found, expected);
});

test("static proof: no line that reads a removed flag tests for not-off (unset would turn it on)", () => {
  for (const f of SCAN) for (const l of code(read(f))) for (const k of REMOVED) if (word(k).test(l)) {
    assert.ok(!new RegExp(`\\b${k}\\b[^;?]*!==?\\s*["']off["']`).test(l), `${f}: ${l.trim()}`);
  }
});

for (const k of REMOVED) {
  test(`${k}: absent equals "off" equals false at every gate`, () => {
    for (const gate of TABLE[k].gates) {
      const absent = gate({});
      const off = gate({ [k]: "off" });
      assert.equal(absent, off, `${gate.name}: absent differs from "off"`);
      assert.equal(absent, false, `${gate.name}: absent is not off`);
      assert.equal(gate({ [k]: "on" }), true, `${gate.name}: "on" does not turn it on (the test would prove nothing)`);
      try { assert.equal(gate(undefined), false, `${gate.name}: no env at all`); } catch (e) { if (e.name === "AssertionError") throw e; /* webLoginOn is only called with an env object */ }
    }
  });
}

test("BUILD_MODAL and SETUP_COMMAND: the served command manifest is identical with the vars absent and off", () => {
  const base = [{ name: "ask" }, { name: "sheet" }];
  const absent = manifestFor({}, base);
  assert.deepEqual(manifestFor({ BUILD_MODAL: "off", SETUP_COMMAND: "off" }, base), absent);
  assert.deepEqual(absent, base);
  assert.notDeepEqual(manifestFor({ BUILD_MODAL: "on" }, base), base, "BUILD_MODAL on adds /join (not vacuous)");
  assert.notDeepEqual(manifestFor({ SETUP_COMMAND: "on" }, base), base, "SETUP_COMMAND on adds /setup (not vacuous)");
});

test("ANTHROPIC_BYOK: provider availability and the auth mode are identical with the var absent and off, and BYOK is only reachable with on", async () => {
  const gateway = { CLOUDFLARE_ACCOUNT_ID: "acct123", AI_GATEWAY_ID: "gw", AI_GATEWAY_TOKEN: "gwtoken" };
  const keyed = { ...gateway, ANTHROPIC_API_KEY: ["sk", "ant", "FAKE"].join("-") };
  for (const base of [{}, gateway, keyed]) {
    resetKeyCacheForTests();
    const a = [anthropicAvailable({ ...base }), await anthropicAuth({ ...base })];
    resetKeyCacheForTests();
    const b = [anthropicAvailable({ ...base, ANTHROPIC_BYOK: "off" }), await anthropicAuth({ ...base, ANTHROPIC_BYOK: "off" })];
    assert.deepEqual(a, b, JSON.stringify(Object.keys(base)));
    assert.notEqual(a[1].mode, "gateway-byok");
  }
  resetKeyCacheForTests();
  assert.equal((await anthropicAuth({ ...gateway, ANTHROPIC_BYOK: "on" })).mode, "gateway-byok", "on still enables it (not vacuous)");
});

test("a removed flag is listed as optional in wrangler-flags.test.mjs and documented in flags.md as not declared (absent = off), with how to turn it on", () => {
  for (const k of REMOVED) {
    assert.ok(new RegExp(`"${k}"`).test(wranglerFlagsTest), `${k} missing from DOCUMENTED.optional`);
    const row = flagsDoc.split("\n").find((l) => l.startsWith(`| \`${k}\` |`));
    assert.ok(row, `${k} has no row in the Optional flags table of docs/runbooks/flags.md`);
    assert.ok(row.includes("not declared in wrangler.toml (absent = off)"), k);
    assert.ok(row.includes(`add \`${k} = "on"\``), k);
    assert.ok(row.includes("var-budget"), k);
  }
});
