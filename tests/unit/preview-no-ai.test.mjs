// A PR preview cannot call Workers AI (the steward's RULES.md rule 6): the Worker answers a placeholder without touching env.AI, and the preview deploy strips the [ai] binding.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stripAi, hasAi } from "../../tools/strip-ai-binding.mjs";
import { workersAiRun, PREVIEW_AI_PLACEHOLDER, isProviderConfigured, isPrPreviewEnv } from "../../infrastructure/worker/ai-models.js";
import { parseBuild } from "../../infrastructure/worker/build-parse.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TOOL = path.join(ROOT, "tools", "strip-ai-binding.mjs");
const tomlOf = () => readFileSync(path.join(ROOT, "infrastructure", "wrangler.toml"), "utf8");

test("the production wrangler.toml has an [ai] binding and stripping it removes exactly that table", () => {
  const toml = tomlOf();
  assert.equal(hasAi(toml), true, "the premise: production declares the binding");
  const next = stripAi(toml);
  assert.equal(hasAi(next), false);
  const before = toml.split("\n"), after = next.split("\n");
  const removed = before.filter((l, i) => !after.includes(l) || false);
  assert.ok(removed.some((l) => /^\[ai\]/.test(l.trim())) && removed.some((l) => /binding = "AI"/.test(l)));
  assert.ok(before.length - after.length <= 3, "only the table and its key left, nothing else");
  assert.ok(next.includes("AI_PROVIDER"), "AI_PROVIDER (a variable that merely starts with AI) is untouched");
  assert.ok(/\[observability\]/.test(next) && /\[\[d1_databases\]\]/.test(next) && /\[durable_objects\]/.test(next));
});

test("dotted, inline and environment forms are removed or refused; a file with no binding fails the step instead of passing", () => {
  assert.equal(hasAi(stripAi('name = "x"\n[ai]\nbinding = "AI"\n[vars]\nA = "1"\n')), false);
  assert.equal(stripAi('name = "x"\n[ai]\nbinding = "AI"\n[vars]\nA = "1"\n'), 'name = "x"\n[vars]\nA = "1"\n');
  assert.equal(hasAi(stripAi('[[ai]]\nbinding = "AI"\n[vars]\n')), false);
  assert.equal(hasAi(stripAi('[env.staging.ai]\nbinding = "AI"\n')), false);
  assert.equal(hasAi('ai = { binding = "AI" }\n'), true, "an inline form is detected");
  assert.equal(hasAi('ai.binding = "AI"\n'), true, "a dotted form is detected");
  assert.equal(hasAi('[vars]\nAI_PROVIDER = "workers-ai"\n[ai_gateway]\nx = 1\n'), false, "look-alike names are not bindings");
  const dir = mkdtempSync(path.join(tmpdir(), "strip-ai-"));
  try {
    const run = (content) => { const f = path.join(dir, "wrangler.toml"); writeFileSync(f, content); const r = spawnSync(process.execPath, [TOOL, f], { encoding: "utf8" }); return { status: r.status, after: readFileSync(f, "utf8") }; };
    assert.equal(run('name = "x"\n[ai]\nbinding = "AI"\n').status, 0);
    const inline = run('name = "x"\nai = { binding = "AI" }\n');
    assert.equal(inline.status, 1, "an inline form the tool cannot remove fails closed");
    assert.match(inline.after, /ai = \{ binding/, "and the file is left untouched");
    assert.equal(run('name = "x"\n[vars]\nA = "1"\n').status, 1, "a layout with no binding fails: the step never assumes previews are safe");
    writeFileSync(path.join(dir, "wrangler.json"), "{}");
    assert.equal(run('[ai]\nbinding = "AI"\n').status, 1, "a wrangler.json beside the toml wins over it, so the step refuses");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("in a preview the Worker never touches env.AI: a placeholder comes back and a throwing binding is not read", async () => {
  for (const env of [{ IS_PR_PREVIEW: "true" }, { IS_PR_PREVIEW: "1" }, { WORKER_NAME: "leeroy-brain-pr-12" }, { PR_NUMBER: "12" }]) {
    Object.defineProperty(env, "AI", { get() { throw new Error("env.AI was read in a preview"); }, enumerable: true });
    assert.equal(isPrPreviewEnv(env), true);
    const r = await workersAiRun(env, "@cf/x", { messages: [] }, {});
    assert.equal(r.response, PREVIEW_AI_PLACEHOLDER);
    assert.deepEqual(r.usage, { prompt_tokens: 0, completion_tokens: 0 });
    assert.equal(isProviderConfigured(env, "workers-ai"), true, "health and bootstrap still list workers-ai as the preview provider (the api suite expects it)");
    assert.equal(isProviderConfigured(env, "claude"), false);
    const parsed = await parseBuild("level 60 mage", env);
    assert.ok(JSON.stringify(parsed).includes("ai_unavailable"), JSON.stringify(parsed));
  }
});

test("outside a preview the binding is called exactly as before", async () => {
  const calls = [];
  const env = { AI: { run: async (m, i, o) => { calls.push([m, i, o]); return { response: "real" }; } } };
  assert.equal(isPrPreviewEnv(env), false);
  const r = await workersAiRun(env, "@cf/x", { a: 1 }, { signal: 1 });
  assert.equal(r.response, "real");
  assert.deepEqual(calls, [["@cf/x", { a: 1 }, { signal: 1 }]]);
  assert.equal(isProviderConfigured(env, "workers-ai"), true);
  assert.equal(isProviderConfigured({}, "workers-ai"), false, "production without a binding is not configured, as before");
});

test("the only call of env.AI.run in the Worker is the one in workersAiRun", () => {
  const dir = path.join(ROOT, "infrastructure", "worker");
  const files = ["ai-models.js", "build-parse.js"];
  let direct = 0;
  for (const f of files) direct += (readFileSync(path.join(dir, f), "utf8").replace(/\/\/.*$/gm, "").match(/env\.AI\.run\(/g) || []).length;
  assert.equal(direct, 1, "one direct call, inside workersAiRun");
});

test("the preview deploy strips the binding right after the flag binding, before any wrangler command", () => {
  const wf = readFileSync(path.join(ROOT, ".github", "workflows", "pr-preview-cloudflare.yml"), "utf8");
  const flag = wf.indexOf("node ../tools/strip-flagship-binding.mjs wrangler.toml");
  const ai = wf.indexOf("node ../tools/strip-ai-binding.mjs wrangler.toml");
  assert.ok(flag > 0 && ai > flag, "strip-ai-binding runs after strip-flagship-binding");
  const deploy = wf.indexOf("wrangler deploy", ai);
  assert.ok(deploy > ai, "and before the deploy");
});
