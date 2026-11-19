// Every env.X the Worker reads is declared in infrastructure/wrangler.toml [vars] or documented here as a secret, binding, optional number or preview-only name.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const toml = fs.readFileSync(path.join(ROOT, "infrastructure/wrangler.toml"), "utf8");
const varsBlock = toml.slice(toml.indexOf("[vars]"));
const declared = new Set([...varsBlock.matchAll(/^([A-Z][A-Z0-9_]*)\s*=/gm)].map((m) => m[1]));

// Not in [vars] on purpose.
const DOCUMENTED = {
  bindings: ["DB", "AI", "BOARD_ROOM", "FLAGS", "ANTHROPIC_KEY_STORE"],
  secrets: ["ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GROQ_API_KEY", "CEREBRAS_API_KEY", "OPENROUTER_API_KEY", "GITHUB_MODELS_TOKEN", "AI_GATEWAY_TOKEN", "CLOUDFLARE_AIG_TOKEN",
    "BOARD_ADMIN_TOKEN", "KEY_SALT", "USER_SALT", "DISCORD_BOT_TOKEN", "DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET", "DISCORD_PUBLIC_KEY", "DISCORD_WEBHOOK_URL"],
  optional: ["CARD_CLASS_EMOJI", "ANSWER_FORMAT", "AI_DAILY_NEURON_CAP", "ASK_DEADLINE_MS", "ACCOUNT_ID", "CF_ACCOUNT_ID", "SHADOW_ASK_HOURLY", "SHADOW_ASK_DAILY", "SHADOW_ASK_SUBCAP_PERCENT", "DEADMAN_STALE_SECONDS", "DEADMAN_EXPECT"].concat(
    // Declared "off" until the Workers Free variable cap (64) was hit: the code treats absent exactly like "off" (proved per flag in off-flag-absence.test.mjs), so they are no longer in wrangler.toml. docs/runbooks/flags.md lists each.
    ["ANTHROPIC_BYOK","WEB_LOGIN","DATA_RIGHTS","EVENTS_ENABLED","MOMENTS_ENABLED","MOMENTS_SHADOW","MOMENTS_DRY_RUN","BUILD_MODAL","BUILD_PROJECT","JOIN_PROMPT","ANSWER_UX","LISTENER_UNTAGGED","CARDS_ENABLED","CARDS_SHADOW","BOARD_LINES_ENABLED","SETUP_COMMAND","EVAL_ENABLED","DEADMAN"]), // the code has a default when unset (ANSWER_FORMAT defaults ON). The SHADOW_ASK_* and DEADMAN_* tuning vars are optional overrides with in-code defaults: they are NOT in wrangler.toml because the Workers Free plan allows only 64 variables in all (SHADOW_ASK_LIMITS carries the shadow trio)
  preview: ["IS_PR_PREVIEW", "PR_NUMBER", "WORKER_NAME"], // set by the PR preview deploy / the platform
};
const documented = new Set(Object.values(DOCUMENTED).flat());

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : /\.m?js$/.test(e.name) ? [path.join(dir, e.name)] : []));
}
const used = new Map();
for (const f of files(path.join(ROOT, "infrastructure/worker"))) {
  for (const m of fs.readFileSync(f, "utf8").matchAll(/\benv\.([A-Z][A-Z0-9_]+)\b/g)) used.set(m[1], path.relative(ROOT, f));
}

test("the scan finds the Worker's env reads", () => assert.ok(used.size > 40));

test("every env.X the Worker reads is declared in wrangler.toml [vars] or documented", () => {
  const missing = [...used].filter(([k]) => !declared.has(k) && !documented.has(k)).map(([k, f]) => `${k} (${f})`);
  assert.deepEqual(missing, []);
});

test("the six formerly undeclared flags default off and are now optional: absent in wrangler.toml, documented, read as off (see off-flag-absence.test.mjs)", () => {
  for (const k of ["ANSWER_UX", "CARDS_ENABLED", "CARDS_SHADOW", "SETUP_COMMAND", "BOARD_LINES_ENABLED", "EVAL_ENABLED"]) {
    assert.ok(!declared.has(k), k);
    assert.ok(documented.has(k), k);
  }
});

test("a flag is not both declared and listed as undeclared", () => {
  assert.deepEqual([...documented].filter((k) => declared.has(k)), []);
});

test("ANSWER_FORMAT stays undeclared because unset means on", () => {
  assert.ok(!declared.has("ANSWER_FORMAT"));
});

test("wrangler.toml never mentions the preview-only names: the PR preview deploy skips injecting IS_PR_PREVIEW if that word appears anywhere in the file", () => {
  for (const k of DOCUMENTED.preview) assert.ok(!toml.includes(k), `${k} must not appear in wrangler.toml (not even in a comment)`);
});

test("LISTENER is declared off, LISTENER_UNTAGGED is optional (absent = off); there is no separate listener secret", () => {
  assert.match(varsBlock, /^LISTENER = "off"/m);
  assert.ok(!declared.has("LISTENER_UNTAGGED") && documented.has("LISTENER_UNTAGGED"));
  assert.ok(![...used.keys()].includes(["LISTENER", "SECRET"].join("_")), "the signing key comes from DISCORD_BOT_TOKEN");
});
