// Flag-off byte identity against a FROZEN record of master's answers: the fictional corpus of tests/helpers/ask-harness.mjs (scenarios, stubbed replies) was run
// through master's Worker code once and every result (stored answer, cites, model, status, the exact prompts sent, buildAnswerInputs) is recorded in
// tests/fixtures/ask-picked-master-frozen.json as a sha256 per scenario, with the answer text for reading. This test needs no git history, so it runs in a shallow CI
// checkout too (ask-picked-vs-master.test.mjs compares against a live master tree when one is available).
// Rewrite the record (only from master's code): ASK_FROZEN_WRITE=<root of an extracted master tree> node --test tests/unit/ask-picked-frozen.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadHarness, REPLIES, SCENARIOS } from "../helpers/ask-harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURE = path.join(ROOT, "tests/fixtures/ask-picked-master-frozen.json");
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const replyName = (r) => (r instanceof Error ? `Error(${r.message})` : r);

async function record(root) {
  const H = await loadHarness(root);
  const out = [];
  for (const reply of REPLIES) {
    const rows = JSON.parse(await H.runAll({}, reply));
    out.push({ reply: replyName(reply), scenarios: rows.map((x) => ({ question: x.s, answer: x.r.answer, model: x.r.model, sha256: sha(JSON.stringify(x)) })) });
  }
  return out;
}

test("flag off is byte-identical to the frozen record of master's answers, prompts and buildAnswerInputs", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("provider down", { status: 500 });
  try {
    if (process.env.ASK_FROZEN_WRITE) {
      const rec = await record(process.env.ASK_FROZEN_WRITE);
      fs.writeFileSync(FIXTURE, JSON.stringify({ about: "master's flag-off output on the fictional ask-harness corpus; see tests/unit/ask-picked-frozen.test.mjs", scenarios: SCENARIOS.length, replies: rec }, null, 1) + "\n");
    }
    const frozen = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
    assert.equal(frozen.replies.length, REPLIES.length);
    const H = await loadHarness(ROOT);
    let n = 0;
    for (const env of [{}, { ASK_PICKED: "off" }, { ASK_PICKED: "OFF" }, { ASK_PICKED: "On" }]) {
      for (let k = 0; k < REPLIES.length; k++) {
        const rows = JSON.parse(await H.runAll(env, REPLIES[k]));
        const want = frozen.replies[k];
        assert.equal(want.reply, replyName(REPLIES[k]));
        assert.equal(rows.length, want.scenarios.length);
        rows.forEach((x, i) => {
          assert.equal(x.r.answer, want.scenarios[i].answer, `${JSON.stringify(env)} ${want.reply} ${x.s}`);
          assert.equal(sha(JSON.stringify(x)), want.scenarios[i].sha256, `${JSON.stringify(env)} ${want.reply} ${x.s}: prompts or inputs differ`);
          n++;
        });
      }
    }
    assert.equal(n, 4 * REPLIES.length * SCENARIOS.length);
    // the record can fail: flag on differs from it
    const on = JSON.parse(await H.runAll({ ASK_PICKED: "on" }, '["f1"]'));
    assert.ok(on.some((x, i) => sha(JSON.stringify(x)) !== frozen.replies[1].scenarios[i].sha256));
  } finally { globalThis.fetch = realFetch; }
});
