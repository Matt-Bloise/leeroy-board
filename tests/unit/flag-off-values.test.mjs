// Flag-off sweep. A feature that ships off must be off for every value a dashboard, a wrangler.toml typo or a copied variable can hold,
// not only for the word "off". Every exported *Enabled or *Shadow helper in infrastructure/worker takes an env; this gives each one an env in which
// EVERY variable holds an off-like value, and requires false. New helpers are found by scanning the folder, so a flag added later is covered
// without editing this file. flags.test.mjs covers the Flagship binding (flagOn); this covers the plain [vars] helpers.
// Fictional env only. No network. Whether flag-off output is byte-identical to master for a given feature is a per-feature differential
// (see docs/review-classes.md); this is the cheap first half: the flag is not read as on.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";

const DIR = new URL("../../infrastructure/worker/", import.meta.url);
// Helpers whose default is ON by design (a kill switch): off only for the word "off". Listed so that adding another is a decision.
const DEFAULT_ON = new Set(["answerFormatEnabled"]);
const OFF_LIKE = [undefined, null, "", " ", "off", "OFF", "Off", false, 0, "0", "no", "false", "nope", "of", "onn", "on!", "o n", "o​n", "ｏｎ", {}, []];

async function helpers() {
  const out = [];
  for (const f of readdirSync(DIR).filter((x) => x.endsWith(".js") && x !== "index.js")) {
    let mod;
    try { mod = await import(new URL(f, DIR)); } catch { continue; }
    for (const [name, fn] of Object.entries(mod)) if (typeof fn === "function" && /^[a-z][A-Za-z]*(Enabled|Shadow)$/.test(name)) out.push({ file: f, name, fn });
  }
  return out;
}
const envOf = (v) => new Proxy({}, { get: (_t, k) => (k === "DB" || k === "FLAGS" ? undefined : v) });

test("every *Enabled and *Shadow helper is off for every off-like value, and the sweep still finds the flags it knew", async () => {
  const found = await helpers();
  const names = new Set(found.map((h) => h.name));
  for (const known of ["cardsEnabled", "cardsShadow", "boardLinesEnabled", "feedEnabled", "gaugeEnabled", "joinPromptEnabled", "momentsEnabled", "eventsEnabled", "setupCommandEnabled", "buildModalEnabled", "evalEnabled", "answerUxEnabled"]) {
    assert.ok(names.has(known), `${known} was not found: renamed, or its module no longer imports`);
  }
  const wrong = [];
  for (const { file, name, fn } of found) {
    if (DEFAULT_ON.has(name)) continue;
    // A helper that returns a promise reads a database or a binding, not an env value: not a [vars] flag, so not swept here.
    let probe;
    try { probe = fn({}); } catch { probe = undefined; }
    if (probe && typeof probe.then === "function") { probe.then(() => {}, () => {}); continue; }
    for (const v of OFF_LIKE) {
      let r;
      try { r = fn(envOf(v)); } catch (e) { wrong.push(`${file} ${name}(${JSON.stringify(v)}) threw ${e.message}`); continue; }
      if (r === true) wrong.push(`${file} ${name} is on for ${JSON.stringify(v)}`);
    }
    for (const env of [undefined, null, {}]) {
      let r;
      try { r = fn(env); } catch (e) { wrong.push(`${file} ${name}(${JSON.stringify(env)}) threw ${e.message}`); continue; }
      if (r === true) wrong.push(`${file} ${name} is on with no env value`);
    }
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
