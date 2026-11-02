// Unit tests for infrastructure/worker/build-parse.js. The AI binding and D1 are stubbed: no AI calls, no network.
// Run: node --test tests/unit/build-parse.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { parseBuild, stripDiscord, BUILD_SCHEMA, TIMEOUT_MS } from "../../infrastructure/worker/build-parse.js";

const f = (value, confidence) => ({ value, confidence });
const reply = (o) => ({ response: JSON.stringify(o), usage: { prompt_tokens: 300, completion_tokens: 80 } });
const none = { class: f(null, 0), race: f(null, 0), role: f(null, 0), spec: f(null, 0), professions: f(null, 0), ruleset: f(null, 0), faction: f(null, 0) };

function makeEnv(aiReply, { neurons = 0 } = {}) {
  const rows = new Map();
  if (neurons) rows.set(`ai_budget:${new Date().toISOString().slice(0, 10)}`, JSON.stringify({ neurons, asks: 0, cron: 0 }));
  const calls = [];
  const DB = {
    prepare() {
      let args = [];
      return {
        bind(...a) { args = a; return this; },
        async first() { return rows.has(args[0]) ? { json: rows.get(args[0]) } : null; },
        async run() { rows.set(args[0], args[1]); return {}; },
      };
    },
  };
  const AI = { run: async (model, inputs, opts) => { calls.push({ model, inputs, opts }); return typeof aiReply === "function" ? aiReply(inputs, opts) : aiReply; } };
  return { env: { AI, DB }, calls, rows };
}

const fixtures = [
  { name: "full build", text: "Thornwick, undead warlock, affliction, tailoring and enchanting, horde hardcore",
    ai: { class: f("warlock", 0.97), race: f("undead", 0.95), role: f("dps", 0.8), spec: f("affliction", 0.93), professions: f(["tailoring", "enchanting"], 0.9), ruleset: f("hardcore", 0.9), faction: f("horde", 0.9) },
    want: { class: "warlock", race: "undead", role: "dps", spec: "affliction", professions: ["tailoring", "enchanting"], ruleset: "hardcore", faction: "horde" } },
  { name: "tank only", text: "Brindlemoss is our dwarf paladin tank, alliance",
    ai: { ...none, class: f("paladin", 0.96), race: f("dwarf", 0.95), role: f("tank", 0.95), faction: f("alliance", 0.9) },
    want: { class: "paladin", race: "dwarf", role: "tank", spec: null, professions: null, ruleset: null, faction: "alliance" } },
  { name: "low confidence guess is nulled", text: "maybe a hunter or something, pvp?",
    ai: { ...none, class: f("hunter", 0.55), ruleset: f("pvp", 0.71) },
    want: { class: null, race: null, role: null, spec: null, professions: null, ruleset: "pvp", faction: null } },
  { name: "nothing useful", text: "hello there, how are you",
    ai: none,
    want: { class: null, race: null, role: null, spec: null, professions: null, ruleset: null, faction: null } },
  { name: "invalid enum values and casing", text: "Skyborne healer priest, rp-pvp, herbalism/alchemy",
    ai: { ...none, class: f(" Priest ", 0.9), race: f("Skyborne", 0.9), role: f("support", 0.9), professions: f(["Herbalism", "alchemy", "alchemy", 7], 0.9), ruleset: f("RP-PvP", 0.9) },
    want: { class: "priest", race: "skyborne", role: null, spec: null, professions: ["herbalism", "alchemy"], ruleset: "rp-pvp", faction: null } },
  { name: "fenced model reply", text: "gnome mage frost, alliance normal",
    ai: "```json\n" + JSON.stringify({ ...none, class: f("mage", 0.9), race: f("gnome", 0.9), spec: f("frost", 0.9), faction: f("alliance", 0.9), ruleset: f("normal", 0.8) }) + "\n```",
    raw: true,
    want: { class: "mage", race: "gnome", role: null, spec: "frost", professions: null, ruleset: "normal", faction: "alliance" } },
];

for (const fx of fixtures) {
  test(`fixture: ${fx.name}`, async () => {
    const { env, calls } = makeEnv(fx.raw ? { response: fx.ai } : reply(fx.ai));
    const out = await parseBuild(fx.text, env);
    assert.equal(out.ok, true);
    assert.deepEqual(out.fields, fx.want);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].inputs.response_format.type, "json_schema");
    for (const [k, v] of Object.entries(out.confidence)) {
      assert.ok(v >= 0 && v <= 1, k);
      if (out.fields[k] === null) assert.ok(v < 0.7 || v === 0);
    }
  });
}

test("discord ids and mentions are stripped before the call", async () => {
  const { env, calls } = makeEnv(reply(none));
  await parseBuild("<@123456789012345678> and <@!223456789012345678> <#323456789012345678> 423456789012345678 @everyone orc rogue", env);
  const sent = calls[0].inputs.messages.map((m) => m.content).join("\n");
  assert.ok(!/\d{17}/.test(sent) && !/<@/.test(sent) && !/@everyone/.test(sent));
  assert.match(sent, /orc rogue/);
  assert.equal(stripDiscord("hi <@&123456> there"), "hi there");
});

test("only a hash of the input is logged", async () => {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try {
    const { env } = makeEnv(reply(none));
    await parseBuild("secretword troll shaman", env);
  } finally { console.log = orig; }
  assert.ok(lines.length >= 1);
  assert.ok(lines.every((l) => !/secretword|troll|shaman/.test(l) && /input=[0-9a-f]{16}/.test(l)));
});

test("over budget makes no AI call", async () => {
  const { env, calls } = makeEnv(reply(none), { neurons: 9000 });
  const out = await parseBuild("tauren druid", env);
  assert.deepEqual(out, { ok: false, error: { code: "over_budget", message: out.error.message } });
  assert.equal(calls.length, 0);
});

test("usage is recorded against the budget", async () => {
  const { env, rows } = makeEnv(reply(none));
  await parseBuild("tauren druid", env);
  const row = JSON.parse([...rows.values()][0]);
  assert.ok(row.neurons > 0 && row.asks === 1);
});

test("timeout returns a structured error and aborts the call", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal;
  const { env } = makeEnv((_i, opts) => { signal = opts.signal; return new Promise(() => {}); });
  const p = parseBuild("night elf druid", env);
  while (!signal) await new Promise((r) => setImmediate(r));
  t.mock.timers.tick(TIMEOUT_MS);
  const out = await p;
  assert.equal(out.ok, false);
  assert.equal(out.error.code, "timeout");
  assert.equal(signal.aborted, true);
});

test("errors never throw: missing binding, empty input, bad output, AI failure", async () => {
  assert.equal((await parseBuild("x", {})).error.code, "ai_unavailable");
  assert.equal((await parseBuild("<@123456789012345678>", makeEnv(reply(none)).env)).error.code, "empty_input");
  assert.equal((await parseBuild("gnome mage", makeEnv({ response: "no json here" }).env)).error.code, "bad_output");
  assert.equal((await parseBuild("gnome mage", makeEnv(() => { throw new Error("boom"); }).env)).error.code, "ai_error");
});

test("schema lists all seven fields", () => {
  assert.deepEqual(Object.keys(BUILD_SCHEMA.properties), ["class", "race", "role", "spec", "professions", "ruleset", "faction"]);
});
