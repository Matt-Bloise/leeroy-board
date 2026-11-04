// tools/d1-row-count.mjs: the seed decision must FAIL CLOSED on any unexpected `wrangler d1 execute --json` output.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { rowCount } from "../../tools/d1-row-count.mjs";

const CLI = fileURLToPath(new URL("../../tools/d1-row-count.mjs", import.meta.url));
const ok = (n) => JSON.stringify([{ results: [{ n }], success: true, meta: {} }]);

test("a numeric count is returned, including a real 0", () => {
  assert.equal(rowCount(ok(0)), 0);
  assert.equal(rowCount(ok(42)), 42);
});

test("every unexpected shape throws instead of reading as 0", () => {
  for (const bad of ["", "not json", "null", "[]", "{}", "[{}]", '[{"results":[]}]', '[{"results":[{}]}]', '[{"results":[{"n":null}]}]', '[{"results":[{"n":"5"}]}]',
    '[{"results":[{"n":-1}]}]', '[{"results":[{"n":1.5}]}]', '[{"result":[{"n":5}]}]', '{"error":{"text":"boom"}}', '[{"results":[{"count":5}]}]']) {
    assert.throws(() => rowCount(bad), Error, bad);
  }
});

test("the CLI prints the count, or exits 1 with a message and prints no count", () => {
  const good = spawnSync(process.execPath, [CLI, ok(7)], { encoding: "utf8" });
  assert.deepEqual([good.status, good.stdout], [0, "7"]);
  const bad = spawnSync(process.execPath, [CLI, '{"error":"x"}'], { encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout, "");
  assert.match(bad.stderr, /Refusing to guess/);
  assert.equal(spawnSync(process.execPath, [CLI], { encoding: "utf8" }).status, 1);
});
