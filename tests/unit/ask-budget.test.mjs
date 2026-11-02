// Pure unit tests for the per-user and per-tenant ask budget (Q30). Stubbed KV, no network, no AI calls.
// Run: node --test tests/unit/ask-budget.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  askBudgetKeys, hashId, resolveCaps, loadAskCaps, checkAskBudget, recordAttributed, recordUsage, budgetMessage,
  DEFAULT_USER_DAILY_ASKS, DEFAULT_TENANT_SHARE_PCT, DEFAULT_DAILY_CAP,
} from "../../infrastructure/worker/budget.js";
import { validateConfigValue, CONFIG_KEYS, isPrivateKvKey, invalidateConfigCache } from "../../infrastructure/worker/config.js";
import { isPublicDataDoc, isPublicAtlasDoc } from "../../infrastructure/worker/public-docs.js";

const NOW = new Date("2026-11-02T10:00:00Z");

function fakeEnv({ failRead = false, failWrite = false, seed = {} } = {}) {
  const rows = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
  const DB = {
    prepare() {
      let args = [];
      return {
        bind(...a) { args = a; return this; },
        async first() {
          if (failRead) throw new Error("read failed");
          return rows.has(args[0]) ? { json: rows.get(args[0]) } : null;
        },
        async run() {
          if (failWrite) throw new Error("write failed");
          rows.set(args[0], args[1]);
          return {};
        },
      };
    },
  };
  return { DB, rows };
}

const keys = askBudgetKeys({ userPart: "ab12", tenantId: "t1" });

test("keys: user and tenant prefixes, default tenant, guest flag, empty user gives null", () => {
  assert.deepEqual(keys, { userKey: "user:ab12", tenantKey: "tenant:t1", guest: false });
  assert.equal(askBudgetKeys({ userPart: "ab12" }).tenantKey, "tenant:default");
  assert.equal(askBudgetKeys({ userPart: "ab12", guest: true }).userKey, "user:guest-ab12");
  assert.equal(askBudgetKeys({ userPart: "" }), null);
  assert.equal(askBudgetKeys(), null);
});

test("hashId is stable, short and does not contain the input", async () => {
  const a = await hashId("123456789012345678");
  assert.equal(a, await hashId("123456789012345678"));
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(await hashId(""), "");
});

test("no keys: identical to the old global check", async () => {
  const under = fakeEnv({ seed: { "ai_budget:2026-11-02": { neurons: 7999, asks: 1, cron: 0 } } });
  assert.equal(await checkAskBudget(under, null, null, NOW), null);
  const over = fakeEnv({ seed: { "ai_budget:2026-11-02": { neurons: DEFAULT_DAILY_CAP, asks: 1, cron: 0 } } });
  const v = await checkAskBudget(over, null, null, NOW);
  assert.equal(v.code, "budget_global");
  assert.ok(v.retryAfter > 0);
  assert.equal(over.rows.size, 1, "no extra rows written");
});

test("record attributes to sibling rows and leaves the global row alone", async () => {
  const env = fakeEnv();
  await recordAttributed(env, keys, 148, NOW);
  await recordAttributed(env, keys, 148, NOW);
  assert.deepEqual(JSON.parse(env.rows.get("ai_budget:2026-11-02:user:ab12")), { neurons: 296, asks: 2 });
  assert.deepEqual(JSON.parse(env.rows.get("ai_budget:2026-11-02:tenant:t1")), { neurons: 296, asks: 2 });
  assert.equal(env.rows.has("ai_budget:2026-11-02"), false);
  await recordAttributed(env, null, 5, NOW);
  assert.equal(env.rows.size, 2);
  for (const k of env.rows.keys()) assert.equal(isPrivateKvKey(k), true, k);
});

test("per-user cap: 40 member asks by default, guests are exempt", async () => {
  const env = fakeEnv({ seed: { "ai_budget:2026-11-02:user:ab12": { neurons: 100, asks: 39 } } });
  assert.equal(await checkAskBudget(env, keys, null, NOW), null);
  env.rows.set("ai_budget:2026-11-02:user:ab12", JSON.stringify({ neurons: 100, asks: 40 }));
  assert.equal((await checkAskBudget(env, keys, null, NOW)).code, "budget_user");
  const guest = { userKey: "user:ab12", tenantKey: "tenant:t1", guest: true };
  assert.equal(await checkAskBudget(env, guest, null, NOW), null);
  assert.equal(await checkAskBudget(env, { ...keys, userKey: "user:other" }, null, NOW), null);
});

test("per-tenant share: 70 percent of the soft cap by default", async () => {
  const env = fakeEnv({ seed: { "ai_budget:2026-11-02:tenant:t1": { neurons: 5599, asks: 30 }, "ai_budget:2026-11-02": { neurons: 5599, asks: 30, cron: 0 } } });
  assert.equal(await checkAskBudget(env, keys, null, NOW), null);
  env.rows.set("ai_budget:2026-11-02:tenant:t1", JSON.stringify({ neurons: 5600, asks: 31 }));
  assert.equal((await checkAskBudget(env, keys, null, NOW)).code, "budget_tenant");
  const other = askBudgetKeys({ userPart: "ab12", tenantId: "t2" });
  assert.equal(await checkAskBudget(env, other, null, NOW), null, "another tenant is unaffected");
});

test("global wins over tenant and user", async () => {
  const env = fakeEnv({ seed: {
    "ai_budget:2026-11-02": { neurons: 8000, asks: 1, cron: 0 },
    "ai_budget:2026-11-02:tenant:t1": { neurons: 9000, asks: 1 },
    "ai_budget:2026-11-02:user:ab12": { neurons: 1, asks: 99 },
  } });
  assert.equal((await checkAskBudget(env, keys, null, NOW)).code, "budget_global");
});

test("caps come from the config row and fall back to defaults", async () => {
  assert.deepEqual(resolveCaps(null), { userDailyAsks: DEFAULT_USER_DAILY_ASKS, tenantSharePct: DEFAULT_TENANT_SHARE_PCT });
  assert.deepEqual(resolveCaps({ userDailyAsks: 3, tenantSharePct: 10 }), { userDailyAsks: 3, tenantSharePct: 10 });
  assert.deepEqual(resolveCaps({ userDailyAsks: -1, tenantSharePct: 500 }), resolveCaps(null));
  invalidateConfigCache();
  const env = fakeEnv({ seed: { ai_budget_caps: { userDailyAsks: 2, tenantSharePct: 50 }, "ai_budget:2026-11-02:user:ab12": { neurons: 1, asks: 2 } } });
  const caps = await loadAskCaps(env);
  assert.deepEqual(caps, { userDailyAsks: 2, tenantSharePct: 50 });
  assert.equal((await checkAskBudget(env, keys, caps, NOW)).code, "budget_user");
  invalidateConfigCache();
});

test("config key is registered, validated and never public", () => {
  assert.ok(CONFIG_KEYS.includes("ai_budget_caps"));
  assert.equal(validateConfigValue("ai_budget_caps", { userDailyAsks: 40, tenantSharePct: 70 }), null);
  assert.equal(validateConfigValue("ai_budget_caps", {}), null);
  for (const bad of [[], null, { userDailyAsks: 0 }, { userDailyAsks: 1.5 }, { tenantSharePct: 0 }, { tenantSharePct: 101 }, { extra: 1 }, { tenantSharePct: "70" }]) {
    assert.notEqual(validateConfigValue("ai_budget_caps", bad), null, JSON.stringify(bad));
  }
  assert.equal(isPrivateKvKey("ai_budget_caps"), true);
  assert.equal(isPublicDataDoc("ai_budget_caps"), false);
  assert.equal(isPublicAtlasDoc("ai_budget_caps"), false);
});

test("fails open on KV errors", async () => {
  const bad = fakeEnv({ failRead: true, failWrite: true });
  assert.equal(await checkAskBudget(bad, keys, null, NOW), null);
  await recordAttributed(bad, keys, 10, NOW);
  await recordUsage(bad, "ask", 10, NOW);
  assert.deepEqual(await loadAskCaps(bad), resolveCaps(null));
  invalidateConfigCache();
});

test("messages are friendly and carry no ids", () => {
  for (const c of ["budget_user", "budget_tenant", "budget_global"]) {
    const m = budgetMessage(c);
    assert.ok(m.length > 20 && m.length < 200);
    assert.doesNotMatch(m, /\d{6,}/);
  }
  assert.notEqual(budgetMessage("budget_user"), budgetMessage("budget_tenant"));
});
