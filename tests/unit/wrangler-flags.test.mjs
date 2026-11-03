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
  bindings: ["DB", "AI", "BOARD_ROOM"],
  secrets: ["ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GROQ_API_KEY", "CEREBRAS_API_KEY", "OPENROUTER_API_KEY", "GITHUB_MODELS_TOKEN", "AI_GATEWAY_TOKEN", "CLOUDFLARE_AIG_TOKEN",
    "BOARD_ADMIN_TOKEN", "KEY_SALT", "USER_SALT", "DISCORD_BOT_TOKEN", "DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET", "DISCORD_PUBLIC_KEY", "DISCORD_WEBHOOK_URL"],
  optional: ["ANSWER_FORMAT", "AI_DAILY_NEURON_CAP", "ASK_DEADLINE_MS", "ACCOUNT_ID", "CF_ACCOUNT_ID"], // the code has a default when unset (ANSWER_FORMAT defaults ON)
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

test("the six formerly undeclared flags are declared and default off", () => {
  for (const k of ["ANSWER_UX", "CARDS_ENABLED", "CARDS_SHADOW", "SETUP_COMMAND", "BOARD_LINES_ENABLED", "EVAL_ENABLED"]) {
    assert.match(varsBlock, new RegExp(`^${k} = "off"`, "m"), k);
  }
});

test("a flag is not both declared and listed as undeclared", () => {
  assert.deepEqual([...documented].filter((k) => declared.has(k)), []);
});

test("ANSWER_FORMAT stays undeclared because unset means on", () => {
  assert.ok(!declared.has("ANSWER_FORMAT"));
});
