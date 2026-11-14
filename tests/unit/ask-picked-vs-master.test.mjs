// Flag-off differential against master: the same fictional scenarios and stubbed model replies run through master's Worker code and this checkout's,
// with ASK_PICKED unset or off (and ASK_COMPOSED unset, as on master). The answers, stored rows, the exact prompts sent to the model and everything
// buildAnswerInputs returns must be byte-identical. Master's tree is extracted with `git archive` into a temp folder; the test is skipped when no master
// commit is available (a shallow CI checkout). ASK_DIFF_REF overrides the ref. Run: node --test tests/unit/ask-picked-vs-master.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadHarness, REPLIES } from "../helpers/ask-harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const git = (...a) => spawnSync("git", ["-C", ROOT, ...a], { encoding: "utf8" });
const ref = [process.env.ASK_DIFF_REF, "origin/master", "master"].filter(Boolean).find((r) => git("rev-parse", "--verify", "--quiet", `${r}^{commit}`).status === 0);

test("flag off is byte-identical to master: answers, prompts and buildAnswerInputs, every scenario and reply", { skip: ref ? false : "no master commit in this checkout" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ask-picked-master-"));
  try {
    const tar = path.join(dir, "master.tar");
    const a = git("archive", "--format=tar", "-o", tar, ref, "infrastructure", "tests/helpers");
    assert.equal(a.status, 0, a.stderr);
    const x = spawnSync("tar", ["-xf", "master.tar"], { cwd: dir, encoding: "utf8" });
    assert.equal(x.status, 0, x.stderr);
    // master's helpers folder has no ask-harness.mjs: use this checkout's harness, loading master's modules
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("provider down", { status: 500 });
    try {
      const M = await loadHarness(dir), B = await loadHarness(ROOT);
      let compared = 0;
      for (const reply of REPLIES) {
        const master = await M.runAll({}, reply);
        for (const env of [{}, { ASK_PICKED: "off" }, { ASK_PICKED: "OFF" }, { ASK_PICKED: "" }]) {
          assert.equal(await B.runAll(env, reply), master, `env=${JSON.stringify(env)} reply=${String(reply).slice(0, 24)}`);
          compared++;
        }
      }
      assert.equal(compared, REPLIES.length * 4);
      // the comparison can fail: master's modules are their own instances, and flag on differs from master
      assert.notEqual(M.ai, B.ai);
      assert.notEqual(await B.runAll({ ASK_PICKED: "on" }, '["f1"]'), await M.runAll({}, '["f1"]'));
    } finally { globalThis.fetch = realFetch; }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
