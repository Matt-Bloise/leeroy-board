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
import { handleAnswerButton } from "../../infrastructure/worker/answer-ux.js";
import { anthropicAvailable, anthropicAuth, resetKeyCacheForTests } from "../../infrastructure/worker/ai-keys.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const toml = read("infrastructure/wrangler.toml");
const varsBlock = toml.slice(toml.indexOf("[vars]"));
const flagsDoc = read("docs/runbooks/flags.md");
const wranglerFlagsTest = read("tests/unit/wrangler-flags.test.mjs");

// flag -> { gates: [{ name, probe(env) }], reads }. A probe returns whatever the gate produces (boolean, manifest, response body, auth mode): the test asserts probe({}) deep-equals probe({X:"off"}),
// and that "on" changes the result (so the probe is not vacuous). EVERY place the Worker reads a flag has a behavioural probe here; reads counts the non-comment mentions per file as the static cross-check.
const g = (name, probe) => ({ name, probe });
const BASE = [{ name: "ask" }, { name: "sheet" }];
const GATEWAY = { CLOUDFLARE_ACCOUNT_ID: "acct123", AI_GATEWAY_ID: "gw", AI_GATEWAY_TOKEN: "gwtoken" };
const KEYED = { ...GATEWAY, ANTHROPIC_API_KEY: ["sk", "ant", "FAKE"].join("-") };
const BUTTON = { data: { custom_id: "ux:more:intent1:abc" }, member: { user: { id: "700000000000000001" } } };
const TABLE = {
  WEB_LOGIN: { gates: [g("webLoginOn", webLoginOn)], reads: { "infrastructure/worker/web-auth.js": 1 } },
  DATA_RIGHTS: { gates: [g("dataRightsOn", dataRightsOn)], reads: { "infrastructure/worker/data-rights.js": 1 } },
  EVENTS_ENABLED: { gates: [g("eventsEnabled", eventsEnabled)], reads: { "infrastructure/worker/scheduled-events.js": 1 } },
  MOMENTS_ENABLED: { gates: [g("momentsEnabled", momentsEnabled)], reads: { "infrastructure/worker/moments.js": 2 } }, // the read, and the name in the both-on conflict log line
  MOMENTS_SHADOW: { gates: [g("momentsShadow", momentsShadow)], reads: { "infrastructure/worker/moments.js": 2 } },
  MOMENTS_DRY_RUN: { gates: [g("momentsDryRun", momentsDryRun)], reads: { "infrastructure/worker/moments.js": 1 } },
  BUILD_MODAL: { gates: [g("buildModalEnabled", buildModalEnabled), g("manifestFor (/join)", (env) => manifestFor(env, BASE))], reads: { "infrastructure/worker/build-modal.js": 1, "infrastructure/worker/setup-command.js": 1 } },
  BUILD_PROJECT: { gates: [g("buildProjectEnabled", buildProjectEnabled)], reads: { "infrastructure/worker/build-modal.js": 1 } },
  JOIN_PROMPT: { gates: [g("joinPromptEnabled", joinPromptEnabled)], reads: { "infrastructure/worker/join.js": 1 } },
  ANSWER_UX: { gates: [g("answerUxEnabled (answer-format.js)", answerUxEnabled), g("handleAnswerButton (answer-ux.js answerUxEnabledEnv)", (env) => handleAnswerButton({ env, interaction: BUTTON }))], reads: { "infrastructure/worker/answer-format.js": 1, "infrastructure/worker/answer-ux.js": 1 } },
  LISTENER_UNTAGGED: { gates: [g("untaggedOn", untaggedOn)], reads: { "infrastructure/worker/listener-untagged.js": 1 } }, // the flag key constant; the read is legacyOn(env, UNTAGGED_FLAG)
  CARDS_ENABLED: { gates: [g("cardsEnabled", cardsEnabled)], reads: { "infrastructure/worker/cards.js": 1 } },
  CARDS_SHADOW: { gates: [g("cardsShadow", cardsShadow)], reads: { "infrastructure/worker/cards.js": 1 } },
  BOARD_LINES_ENABLED: { gates: [g("boardLinesEnabled", boardLinesEnabled)], reads: { "infrastructure/worker/cards.js": 1 } },
  SETUP_COMMAND: { gates: [g("setupCommandEnabled", setupCommandEnabled), g("manifestFor (/setup)", (env) => manifestFor(env, BASE))], reads: { "infrastructure/worker/setup-command.js": 1 } },
  EVAL_ENABLED: { gates: [g("evalEnabled", evalEnabled)], reads: { "infrastructure/worker/eval.js": 1 } },
  DEADMAN: { gates: [g("deadmanOn", deadmanOn)], reads: { "infrastructure/worker/deadman.js": 1 } }, // the flag key constant; the read is env[DEADMAN_FLAG]
  // byokOn is not exported: both of its consumers (provider availability, auth mode) are probed, with and without the gateway and a key
  ANTHROPIC_BYOK: { gates: [g("anthropicAvailable (gateway)", (env) => { resetKeyCacheForTests(); return anthropicAvailable({ ...GATEWAY, ...env }); }), g("anthropicAuth (gateway)", async (env) => { resetKeyCacheForTests(); return anthropicAuth({ ...GATEWAY, ...env }); }), g("anthropicAuth (gateway and key)", async (env) => { resetKeyCacheForTests(); return anthropicAuth({ ...KEYED, ...env }); })], reads: { "infrastructure/worker/ai-keys.js": 2 } }, // the read and the name in its one-time warning text
};
const REMOVED = Object.keys(TABLE);

function sourceFiles(dir) {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sourceFiles(`${dir}/${e.name}`) : /\.m?js$/.test(e.name) ? [`${dir}/${e.name}`] : []));
}
const code = (src) => src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).map((l) => l.replace(/\s\/\/.*$/, ""));
const SCAN = [...sourceFiles("infrastructure/worker"), ...sourceFiles("pages-worker")];
const word = (k) => new RegExp(`\\b${k}\\b`);

test("the table lists 18 removed flags; a removed flag may be declared in wrangler.toml only as \"on\" or \"off\" (the documented enable procedure); the variable budget is the guard against declaring them all", () => {
  assert.equal(REMOVED.length, 18);
  for (const k of REMOVED) {
    const m = varsBlock.match(new RegExp(`^${k}\s*=\s*"([^"]*)"`, "m"));
    if (m) assert.ok(["on", "off"].includes(m[1]), `${k} declared as ${m[1]}`);
  }
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
  test(`${k}: at every gate (${TABLE[k].gates.map((x) => x.name).join(", ")}) absent equals "off", and "on" changes the result`, async () => {
    assert.ok(TABLE[k].gates.length >= 1);
    for (const { name, probe } of TABLE[k].gates) {
      const absent = await probe({});
      const off = await probe({ [k]: "off" });
      const on = await probe({ [k]: "on" });
      assert.deepEqual(absent, off, `${name}: absent differs from "off"`);
      assert.notDeepEqual(on, absent, `${name}: "on" changes nothing (the probe would prove nothing)`);
      if (typeof absent === "boolean") assert.equal(absent, false, `${name}: absent is not off`);
    }
  });
}

test("a gate for ANTHROPIC_BYOK never reports gateway-byok unless the value is on", async () => {
  for (const env of [{}, { ANTHROPIC_BYOK: "off" }, { ANTHROPIC_BYOK: "" }]) {
    resetKeyCacheForTests();
    assert.notEqual((await anthropicAuth({ ...GATEWAY, ...env })).mode, "gateway-byok");
  }
  resetKeyCacheForTests();
  assert.equal((await anthropicAuth({ ...GATEWAY, ANTHROPIC_BYOK: "on" })).mode, "gateway-byok");
});

test("premise: the deploy removes variables that wrangler.toml omits. No workflow, package script or wrangler.toml may use keep-vars / keep_vars, or a dashboard-set \"on\" would survive the omission", () => {
  const files = [...fs.readdirSync(path.join(ROOT, ".github/workflows")).filter((f) => /.ya?ml$/.test(f)).map((f) => `.github/workflows/${f}`), "infrastructure/wrangler.toml", "infrastructure/package.json"];
  assert.ok(files.length >= 4);
  for (const f of files) assert.ok(!/keep[-_]vars/i.test(read(f)), `${f} mentions keep-vars`);
  assert.ok(/npx wrangler deploy(?![-w])/.test(read(".github/workflows/deploy-cloudflare.yml")), "the production deploy is still a plain wrangler deploy");
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
