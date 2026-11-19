// Production finding (Nov 19 2026): every deploy after PR 398 failed at `wrangler deploy` with "This deployment includes 65 variables, which exceeds the Workers Free limit of 64 variables per
// Worker (secrets + text)". Nothing merged after PR 396 reached production until this was fixed. This file fails IN THE PR when wrangler.toml [vars] plus the Worker's secrets would pass a budget
// below the cap, so the next flag is caught at review time and not at deploy time.
// The deployed secret count is not in the repo: 9, derived from the failing deploy (run 44569484868): 65 variables in all minus the 56 text variables wrangler.toml declared then. When a secret is added
// to the Worker, raise SECRETS_DEPLOYED here in the same PR. The cap applies to secrets + text variables together; bindings (DB, AI, BOARD_ROOM, FLAGS) are not counted.
// Run: node --test tests/unit/var-budget.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const toml = fs.readFileSync(path.join(ROOT, "infrastructure/wrangler.toml"), "utf8");
const varsBlock = (() => { const rest = toml.slice(toml.indexOf("[vars]") + 6); const j = rest.search(/^\[/m); return j < 0 ? rest : rest.slice(0, j); })();
const names = [...varsBlock.matchAll(/^([A-Za-z][A-Za-z0-9_]*)\s*=/gm)].map((m) => m[1]);

export const WORKERS_FREE_CAP = 64;
export const SECRETS_DEPLOYED = 9;
export const BUDGET = 62; // two below the cap: one new flag fits, the second must remove one
const total = () => names.length + SECRETS_DEPLOYED;

test("the [vars] scan finds the variables and no name is declared twice", () => {
  assert.ok(names.length > 40, `found ${names.length}`);
  assert.equal(new Set(names).size, names.length, "a duplicate [vars] key");
});

test(`text variables (${names.length}) plus deployed secrets (${SECRETS_DEPLOYED}) stay within the budget of ${BUDGET}, under the Workers Free cap of ${WORKERS_FREE_CAP}`, () => {
  assert.ok(total() <= BUDGET, `${names.length} text + ${SECRETS_DEPLOYED} secrets = ${total()} > budget ${BUDGET} (cap ${WORKERS_FREE_CAP}). Fold related flags into one var (like SHADOW_ASK_LIMITS) or drop an "off" default the code already assumes when absent.`);
  assert.ok(total() < WORKERS_FREE_CAP);
});

test("the budget really is below the cap and the count is stated", () => {
  assert.ok(BUDGET < WORKERS_FREE_CAP);
  assert.ok(SECRETS_DEPLOYED >= 1);
});

test("the three SHADOW_ASK_* tuning vars and the two DEADMAN_* tuning vars are not declared separately (they are optional overrides with in-code defaults)", () => {
  for (const k of ["SHADOW_ASK_HOURLY", "SHADOW_ASK_DAILY", "SHADOW_ASK_SUBCAP_PERCENT", "DEADMAN_STALE_SECONDS", "DEADMAN_EXPECT"]) assert.ok(!names.includes(k), k);
  assert.ok(names.includes("SHADOW_ASK") && names.includes("DEADMAN"));
});
