// Flag-off sweep. A feature that ships off must be off for every value a dashboard, a wrangler.toml typo or a copied variable can hold,
// not only for the word "off". Every exported *Enabled, *Shadow, *On or *DryRun helper in infrastructure/worker takes an env; this gives each one an
// env in which EVERY variable holds an off-like value, and requires false. New helpers are found by scanning the folder, so a flag added later is
// covered without editing this file. A module that fails to import fails the test (an import error is never skipped).
// Not swept: legacyOn and flagOn (they take a flag key and are covered by flags.test.mjs, with the Flagship binding), and writers whose name
// ends in Shadow (recordShadow writes a ledger row; the deny list below keeps them out). Fictional env only. No network.
// Whether flag-off output is byte-identical to master for a given feature is a per-feature differential (see docs/review-classes.md,
// class 9); this is the cheap first half: the flag is not read as on.
//
// What counts as on is NOT uniform, and this test does not force it to be. Pinned here only: the string "on" turns every swept helper on (so the
// // sweep is not vacuous), and no off-like value does. Known coercions, listed in tests/review-brief.md item 9 and docs/review-classes.md F-15: an
// array ["on"] reads as on for every helper except the three momentsX ones (it is turned into the string "on"); the boolean true reads as on only
// for helpers that accept the word "true". wrangler.toml [vars] holds strings only today, so neither is reachable.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";

const DIR = new URL("../../infrastructure/worker/", import.meta.url);
// Helpers whose default is ON by design (a kill switch): off only for the word "off". Listed so that adding another is a decision.
const DEFAULT_ON = new Set(["answerFormatEnabled"]);
const NAME_RE = /^[a-z][A-Za-z]*(Enabled|Shadow|On|DryRun)$/;
const NOT_A_FLAG = /^(record|write|save|set|post|send|put|insert|flush|run|apply|note|redraw|request|load|clear|delete|legacy|flag)(?![a-z])/; // a verb prefix, so "setupCommandEnabled" is kept and "setShadow" is not
const OFF_LIKE = [undefined, null, "", " ", "off", "OFF", "Off", false, 0, "0", "no", "false", "nope", "of", "onn", "on!", "o n", "o\u200Bn", "\uFF4F\uFF4E", {}, []];

async function helpers() {
  const out = [];
  for (const f of readdirSync(DIR).filter((x) => x.endsWith(".js") && x !== "index.js")) {
    const mod = await import(new URL(f, DIR)); // an import error fails the test
    for (const [name, fn] of Object.entries(mod)) if (typeof fn === "function" && NAME_RE.test(name) && !NOT_A_FLAG.test(name)) out.push({ file: f, name, fn });
  }
  return out;
}
const envOf = (v) => new Proxy({}, { get: (_t, k) => (k === "DB" || k === "FLAGS" ? undefined : v) });

test("every flag helper is off for every off-like value and on for \"on\", and the sweep still finds the flags it knew", async () => {
  const found = await helpers();
  const names = new Set(found.map((h) => h.name));
  for (const known of ["cardsEnabled", "cardsShadow", "boardLinesEnabled", "feedEnabled", "feedOn", "gaugeEnabled", "joinPromptEnabled", "momentsEnabled", "momentsDryRun", "momentsShadow", "eventsEnabled", "setupCommandEnabled", "buildModalEnabled", "evalEnabled", "answerUxEnabled", "charsOn", "dataRightsOn", "webLoginOn"]) {
    assert.ok(names.has(known), `${known} was not found: renamed, or its module no longer imports`);
  }
  const wrong = [];
  for (const { file, name, fn } of found) {
    if (DEFAULT_ON.has(name)) continue;
    const call = async (env) => { try { return await fn(env); } catch (e) { wrong.push(`${file} ${name}(${JSON.stringify(env)}) threw ${e.message}`); return undefined; } };
    for (const v of OFF_LIKE) if ((await call(envOf(v))) === true) wrong.push(`${file} ${name} is on for ${JSON.stringify(v)}`);
    if ((await call({})) === true) wrong.push(`${file} ${name} is on with no env value`);
    if ((await call(envOf("on"))) !== true) wrong.push(`${file} ${name} is not on for "on": the sweep proves nothing for it`);
  }
  assert.deepEqual(wrong, []);
});

test("a default-on kill switch is off only for the word off", async () => {
  const { answerFormatEnabled } = await import(new URL("answer-format.js", DIR));
  assert.equal(answerFormatEnabled({}), true);
  assert.equal(answerFormatEnabled({ ANSWER_FORMAT: "off" }), false);
  assert.equal(answerFormatEnabled({ ANSWER_FORMAT: " OFF " }), false);
  assert.equal(answerFormatEnabled({ ANSWER_FORMAT: "no" }), true, "only the documented word turns it off");
});
