// Unit tests for the voice A/B arm runner (tools/voice-eval/run-arms.mjs). No network: every provider call is a fake fetch or the built-in dry run.
// Credentials in these tests are obvious fakes. The real roster is read at runtime from bot-data.js and is only ever used in boolean assertions: never printed, never in a message.
// Run: node --test tests/unit/voice-eval-runner.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { main, parseArgs, DEFAULT_MAX_SPEND } from "../../tools/voice-eval/run-arms.mjs";
import { hashPrompts, frozenHashes } from "../../tools/voice-eval/lib.mjs";
import { ARMS, SHEETS, seedDb, makeEnv, planItem, fictionaliseRoster, FLAG_OFF_GEN, RESEARCH_GEN, DEFAULT_CLAUDE_MODEL } from "../../tools/voice-eval/arms.mjs";
import { buildAnswerInputs } from "../../infrastructure/worker/ai-models.js";
import { RESEARCH_RULES } from "../../infrastructure/worker/research/rules.js";
import { guardBody, guardUserText, scanBody } from "../../infrastructure/worker/privacy/outbound-guard.js";
import { researchMembers, researchMembersFor, genericAliases } from "../../infrastructure/worker/privacy/roster-config.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PROMPTS = JSON.parse(readFileSync(join(ROOT, "tools/voice-eval/prompts.json"), "utf8"));
const CF_ID = "0123456789abcdef0123456789abcdef";
const CF_TOKEN = "FAKE-CF-TOKEN-0000-not-real";
const ANT_KEY = "sk-ant-FAKE-TEST-0000-not-real";
const KEYS = { CF_ACCOUNT_ID: CF_ID, CF_API_TOKEN: CF_TOKEN, ANTHROPIC_API_KEY: ANT_KEY };
const tmp = () => mkdtempSync(join(tmpdir(), "arms-"));
const read = (dir, f) => readFileSync(join(dir, f), "utf8");
const rows = (dir, f) => read(dir, f).split("\n").filter(Boolean).map((l) => JSON.parse(l));
const allText = (dir) => readdirSync(dir).map((f) => read(dir, f)).join("\n");

// Runs main with every console method and both injected loggers captured.
async function run(args, { env = {}, fetchImpl = async () => { throw new Error("no network in this test"); } } = {}) {
  const logs = [];
  const real = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of Object.keys(real)) console[k] = (...a) => logs.push(a.map(String).join(" "));
  let code;
  try { code = await main(args, { env, fetchImpl, log: (m) => logs.push(String(m)), err: (m) => logs.push(String(m)) }); } finally { Object.assign(console, real); }
  return { code, logs, text: logs.join("\n") };
}

// A fake of both providers. Records every request. The Claude fake echoes the first name token it was sent, so detokenising is exercised end to end.
function fakeProviders({ cfStatus = 200, antStatus = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = String(url);
    const body = JSON.parse(init.body);
    calls.push({ url: u, headers: { ...init.headers }, body, raw: init.body });
    if (u.startsWith("https://api.anthropic.com/v1/messages")) {
      if (antStatus !== 200) return new Response("{}", { status: antStatus });
      const tok = (body.messages[0].content.match(/\{P\d+\.[a-z0-9]+\}/) || ["friend"])[0];
      return new Response(JSON.stringify({ content: [{ type: "text", text: `**Short answer first.** That one is a plain pick, and ${tok} should take the sturdier route.\n-# Sources: general Classic-era knowledge · unconfirmed` }], usage: { input_tokens: 1000, output_tokens: 80 } }), { status: 200 });
    }
    if (u.startsWith("https://api.cloudflare.com/client/v4/accounts/")) {
      if (cfStatus !== 200) return new Response("{}", { status: cfStatus });
      const tok = (body.messages[1].content.match(/\{P\d+\.[a-z0-9]+\}/) || ["friend"])[0];
      return new Response(JSON.stringify({ success: true, result: { response: `**Short answer first.** That one is a plain pick, and ${tok} should take the sturdier route.\n-# Sources: general Classic-era knowledge · unconfirmed`, usage: { prompt_tokens: 900, completion_tokens: 70 } } }), { status: 200 });
    }
    throw new Error("unexpected url");
  };
  return { fetchImpl, calls };
}

test("dry run end to end: 3 arm files, 38 rows each, neutral names, mapping and usage written", async () => {
  const out = tmp();
  const r = await run(["--out", out, "--dry-run", "--seed", "5"]);
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(readdirSync(out).sort(), ["arm1.jsonl", "arm2.jsonl", "arm3.jsonl", "mapping.json", "usage.json"]);
  assert.equal(PROMPTS.length, 38);
  for (const f of ["arm1.jsonl", "arm2.jsonl", "arm3.jsonl"]) {
    const list = rows(out, f);
    assert.deepEqual(list.map((x) => x.id), PROMPTS.map((p) => p.id), f);
    for (const x of list) { assert.deepEqual(Object.keys(x).sort(), ["answer", "id"]); assert.ok(x.answer.trim().length > 0); }
  }
  const mapping = JSON.parse(read(out, "mapping.json"));
  assert.deepEqual(Object.keys(mapping.arms).sort(), ["arm1", "arm2", "arm3"]);
  assert.deepEqual(Object.values(mapping.arms).sort(), ARMS.map((a) => a.name).sort());
  assert.equal(mapping.mode, "dry");
  // What the judge side can see (the arm files) carries no real arm name, vendor or model word.
  for (const f of ["arm1.jsonl", "arm2.jsonl", "arm3.jsonl"]) assert.doesNotMatch(read(out, f), /prod-prompt|restored|llama|claude|anthropic|workers/i);
  const usage = JSON.parse(read(out, "usage.json"));
  assert.equal(usage.calls.length, 114);
  assert.ok(usage.calls.every((c) => /^arm[123]$/.test(c.arm)), "usage rows carry neutral arm names");
  assert.match(r.text, /mode dry/);
  assert.match(r.text, /estimated tokens/);
});

test("--live without its keys refuses and names the missing variables (never values); no request", async () => {
  const p = fakeProviders();
  const r = await run(["--out", join(tmp(), "never"), "--live", "--yes"], { env: { ANTHROPIC_API_KEY: ANT_KEY }, fetchImpl: p.fetchImpl });
  assert.equal(r.code, 5);
  assert.equal(p.calls.length, 0);
  assert.match(r.text, /needs environment variables: CF_ACCOUNT_ID, CF_API_TOKEN/);
  assert.ok(!r.text.includes(ANT_KEY));
  assert.equal((await run(["--out", tmp()])).code, 2, "no mode flag: refused");
  assert.equal((await run(["--out", tmp(), "--dry-run", "--yes"])).code, 2, "--yes only with --live");
});

test("with keys present and no --yes: refuses, makes no request, writes nothing", async () => {
  const out = join(tmp(), "never");
  const p = fakeProviders();
  const r = await run(["--out", out, "--live"], { env: KEYS, fetchImpl: p.fetchImpl });
  assert.equal(r.code, 4);
  assert.equal(p.calls.length, 0);
  assert.ok(!existsSync(out));
  assert.match(r.text, /add --yes/);
  assert.match(r.text, /estimated tokens/, "the estimate is printed before any send");
});

test("refuses when the estimate is over --max-spend: dry, and live with --yes; no request, nothing written", async () => {
  for (const [env, extra] of [[{}, ["--dry-run"]], [KEYS, ["--live", "--yes"]]]) {
    const out = join(tmp(), "never");
    const p = fakeProviders();
    const r = await run(["--out", out, "--max-spend", "1000", ...extra], { env, fetchImpl: p.fetchImpl });
    assert.equal(r.code, 3);
    assert.equal(p.calls.length, 0);
    assert.ok(!existsSync(out));
    assert.match(r.text, /over --max-spend 1000/);
  }
  assert.equal(DEFAULT_MAX_SPEND, 400000);
  const ok = await run(["--out", tmp(), "--dry-run"]);
  assert.equal(ok.code, 0, "the default limit admits one full run");
});

test("credentials are never read from argv: any key-shaped flag is refused without echoing it", async () => {
  for (const args of [["--api-key", ANT_KEY], [`--anthropic-api-key=${ANT_KEY}`], ["--token", CF_TOKEN], [ANT_KEY], ["--out", tmp(), "--CF_API_TOKEN", CF_TOKEN]]) {
    const p = fakeProviders();
    const r = await run(args, { env: {}, fetchImpl: p.fetchImpl });
    assert.equal(r.code, 2);
    assert.equal(p.calls.length, 0);
    assert.ok(!r.text.includes(ANT_KEY) && !r.text.includes(CF_TOKEN), "the refusal does not echo what was typed");
    assert.match(r.text, /environment variables only/);
  }
  assert.ok(parseArgs(["--out", "x", "--live", "--yes"]).opts.yes);
  assert.ok(parseArgs(["--out", "x", "--claude-model", "bad model!"]).error);
  assert.ok(parseArgs(["--out", "x", "--seed", "-1"]).error);
});

test("live run through fake providers: keys only in headers, never in bodies, logs or files; no prompt text in logs or files", async () => {
  const out = tmp();
  const p = fakeProviders();
  const r = await run(["--out", out, "--live", "--yes", "--seed", "9"], { env: KEYS, fetchImpl: p.fetchImpl });
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /LIVE/);
  const cf = p.calls.filter((c) => c.url.includes("cloudflare.com"));
  const ant = p.calls.filter((c) => c.url.includes("anthropic.com"));
  assert.ok(cf.length > 0 && ant.length > 0);
  assert.equal(cf.length + ant.length, p.calls.length, "every call is one of the two providers");
  for (const c of cf) {
    assert.equal(c.url, `https://api.cloudflare.com/client/v4/accounts/${CF_ID}/ai/run/@cf/meta/llama-3.3-70b-instruct-fp8-fast`);
    assert.equal(c.headers.authorization, `Bearer ${CF_TOKEN}`);
    assert.equal(c.body.temperature, 0.3);
    assert.equal(c.body.seed, 9);
    assert.deepEqual(c.body.messages.map((m) => m.role), ["system", "user"]);
  }
  for (const c of ant) {
    assert.equal(c.url, "https://api.anthropic.com/v1/messages");
    assert.equal(c.headers["x-api-key"], ANT_KEY);
    assert.equal(c.headers["anthropic-version"], "2023-06-01");
    assert.equal(c.body.model, DEFAULT_CLAUDE_MODEL);
    assert.equal(c.body.max_tokens, 700);
    assert.ok(!("temperature" in c.body), "the Worker sends no temperature to Claude");
  }
  for (const c of p.calls) for (const k of [CF_ID, CF_TOKEN, ANT_KEY]) assert.ok(!c.raw.includes(k), "no credential in a request body");
  const files = allText(out);
  for (const k of [CF_TOKEN, ANT_KEY]) { assert.ok(!r.text.includes(k), "log"); assert.ok(!files.includes(k), "files"); }
  // No prompt text in the logs or in usage/mapping (the arm files hold answers only).
  const private_ = read(out, "usage.json") + read(out, "mapping.json");
  for (const q of PROMPTS) { assert.ok(!r.text.includes(q.prompt), `log has prompt ${q.id}`); assert.ok(!private_.includes(q.prompt), `usage has prompt ${q.id}`); }
  assert.ok(!r.text.includes("USER_QUESTION") && !private_.includes("USER_QUESTION"));
  assert.ok(!/Fakepriest|Testbard|Sampleshaman|Demorogue/.test(r.text + private_), "no member names in logs or usage");
  const usage = JSON.parse(read(out, "usage.json"));
  assert.equal(usage.mode, "live");
  assert.ok(usage.totals.inputTokens > 0 && usage.totals.outputTokens > 0);
  assert.ok(usage.calls.some((c) => c.provider === "code"), "flag-off abstain answers are written by code and make no call");
});

test("the Claude request: tokenised, no member name in any body, passes guardBody and the strict guard under the fictional AND the real roster", async () => {
  const p = fakeProviders();
  const r = await run(["--out", tmp(), "--live", "--yes", "--arms", "restored-claude"], { env: KEYS, fetchImpl: p.fetchImpl });
  assert.equal(r.code, 0, r.text);
  const bodies = p.calls.filter((c) => c.url.includes("anthropic.com")).map((c) => c.body);
  assert.equal(bodies.length, 38);
  const fictional = { members: researchMembersFor(SHEETS), genericAliases: [...genericAliases] };
  const real = { members: researchMembers(), genericAliases: [...genericAliases] }; // built at runtime; never printed
  for (const b of bodies) {
    const text = JSON.stringify(b);
    assert.ok(!/Fakepriest|Testbard|Sampleshaman|Demorogue/i.test(text), "a fictional member name reached the Claude body");
    assert.match(text, /\{P\d+\.[a-z0-9]{4}\}|\{ID/, "tokens are present");
    for (const [label, roster] of [["fictional", fictional], ["real", real]]) {
      assert.doesNotThrow(() => guardBody(b, roster), `guardBody (${label})`);
      assert.equal(scanBody(b, roster).length, 0, `scanBody (${label})`);
    }
  }
  // The strict guard over the typed segments (as research/claude.js does), for every prompt, under both rosters.
  const env = makeEnv(seedDb(PROMPTS));
  for (const prompt of PROMPTS) {
    const it = await planItem(env, ARMS[2], prompt, 9);
    assert.equal(it.blocked, null, `${prompt.id} blocked`);
    for (const [label, roster] of [["fictional", it.priv.roster], ["real", real]]) {
      assert.doesNotThrow(() => guardUserText(it.priv.userSegments, roster), `${prompt.id} segments (${label})`);
      for (const seg of it.priv.partySegments) assert.doesNotThrow(() => guardUserText([seg], roster), `${prompt.id} party (${label})`);
    }
  }
});

test("replies are detokenised: no token survives in any arm, and a member display name is restored", async () => {
  const out = tmp();
  const p = fakeProviders();
  const r = await run(["--out", out, "--live", "--yes", "--seed", "2"], { env: KEYS, fetchImpl: p.fetchImpl });
  assert.equal(r.code, 0, r.text);
  const mapping = JSON.parse(read(out, "mapping.json"));
  const neutralOf = (name) => Object.keys(mapping.arms).find((k) => mapping.arms[k] === name);
  for (const f of ["arm1.jsonl", "arm2.jsonl", "arm3.jsonl"]) for (const x of rows(out, f)) assert.doesNotMatch(x.answer, /\{(?:P\d+|ID|ALL|INVITE|GUILD)\.[a-z0-9]+\}/, `${f} ${x.id}`);
  const claudeRows = rows(out, `${neutralOf("restored-claude")}.jsonl`);
  assert.ok(claudeRows.some((x) => /Fakepriest|Testbard|Sampleshaman|Demorogue/.test(x.answer)), "the echoed token came back as a display name");
});

test("arm prompts: A is the flag-off prompt, B and C are the research-mode prompts, B and C send the same text", async () => {
  const DB = seedDb(PROMPTS);
  const env = makeEnv(DB);
  const [A, B, C] = ARMS;
  assert.equal(A.research, false); assert.equal(B.research, true); assert.equal(C.research, true);
  let abstainChecked = 0;
  for (const p of PROMPTS) {
    const off = await buildAnswerInputs(env, { question: p.prompt, by: "Fakepriest", memberSlug: "fakepriest", journey: "curious", share: true, isMember: true, previousQuestion: null, research: false });
    const offDefault = await buildAnswerInputs(env, { question: p.prompt, by: "Fakepriest", memberSlug: "fakepriest", journey: "curious", share: true, isMember: true, previousQuestion: null });
    assert.equal(offDefault.systemPrompt, off.systemPrompt);
    const a = await planItem(env, A, p, 4);
    const b = await planItem(env, B, p, 4);
    const c = await planItem(env, C, p, 4);
    if (!p.previous) {
      const on = await buildAnswerInputs(env, { question: p.prompt, by: "Fakepriest", memberSlug: "fakepriest", journey: "curious", share: true, isMember: true, previousQuestion: null, research: true });
      assert.equal(a.rawSystem, fictionaliseRoster(off.systemPrompt), `${p.id} A system`);
      assert.equal(a.rawUser, fictionaliseRoster(off.userPrompt), `${p.id} A user`);
      assert.equal(b.rawSystem, fictionaliseRoster(on.systemPrompt), `${p.id} B system`);
      assert.equal(b.rawUser, fictionaliseRoster(on.userPrompt), `${p.id} B user`);
      assert.equal(c.rawSystem, fictionaliseRoster(on.systemPrompt), `${p.id} C system`);
      if (on.abstain) {
        abstainChecked++;
        assert.ok(b.rawSystem.includes(RESEARCH_RULES), `${p.id} research rules in B`);
        assert.ok(!a.rawSystem.includes(RESEARCH_RULES), `${p.id} no research rules in A`);
        assert.equal(a.composed !== null, true, `${p.id} flag-off abstain is written by code`);
        assert.equal(b.composed, null, `${p.id} research abstain goes to the model`);
      }
    }
    assert.equal(b.system, c.system, `${p.id} B and C system`);
    assert.equal(b.user, c.user, `${p.id} B and C user`);
    assert.notEqual(a.rawSystem.includes("{P1."), true);
    assert.equal(b.priv.ok, true);
    assert.equal(a.maxTokens, 350); assert.equal(b.maxTokens, 700); assert.equal(c.maxTokens, 700);
  }
  assert.ok(abstainChecked >= 10, "the abstain state is exercised");
  // A follow-up carries its previous question into the prompt, in both modes.
  // A follow-up hands its previous question to the Worker's builder in every arm, as answerWithAi does when isFollowUp(question) is true
  // (whether the prompt then shows it is the builder's own rule).
  const handed = [];
  for (const p of PROMPTS.filter((x) => x.previous)) for (const arm of ARMS) { const it = await planItem(env, arm, p, 4); if (it.previousQuestion === p.previous) handed.push(`${arm.name}:${p.id}`); }
  assert.ok(handed.length >= 6 && handed.length % 3 === 0, "follow-ups carry their previous question in every arm");
});

test("no real roster name or alias is in any prompt of any arm (boolean check against the runtime roster)", async () => {
  const env = makeEnv(seedDb(PROMPTS));
  const real = { members: researchMembers(), genericAliases: [...genericAliases] };
  let checked = 0;
  for (const arm of ARMS) for (const p of PROMPTS) {
    const it = await planItem(env, arm, p, 1);
    for (const text of [it.rawSystem, it.rawUser]) {
      assert.equal(scanBody({ t: text }, real).length, 0, `${arm.name} ${p.id}: a real roster name is in a prompt`);
      checked++;
    }
  }
  assert.equal(checked, 228);
});

test("reproducible with a seed: same seed gives byte-identical arm files and mapping; another seed changes them", async () => {
  const [a, b, c] = [tmp(), tmp(), tmp()];
  assert.equal((await run(["--out", a, "--dry-run", "--seed", "11"])).code, 0);
  assert.equal((await run(["--out", b, "--dry-run", "--seed", "11"])).code, 0);
  assert.equal((await run(["--out", c, "--dry-run", "--seed", "12"])).code, 0);
  for (const f of ["arm1.jsonl", "arm2.jsonl", "arm3.jsonl", "mapping.json"]) assert.equal(read(a, f), read(b, f), f);
  assert.notEqual(allText(a), allText(c));
  // The tokenised prompt itself (nonce included) is reproducible with the seed, and the real crypto is restored afterwards.
  const env = makeEnv(seedDb(PROMPTS));
  const x = await planItem(env, ARMS[2], PROMPTS[0], 21);
  const y = await planItem(env, ARMS[2], PROMPTS[0], 21);
  const z = await planItem(env, ARMS[2], PROMPTS[0], 22);
  assert.equal(x.user, y.user);
  assert.notEqual(x.user, z.user);
  assert.equal(typeof globalThis.crypto.subtle.digest, "function");
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
});

test("model id: --claude-model beats CLAUDE_VOICE_MODEL beats the default; a bad id is refused", async () => {
  const model = async (args, env) => { const p = fakeProviders(); const r = await run(["--out", tmp(), "--live", "--yes", "--arms", "restored-claude", ...args], { env: { ...KEYS, ...env }, fetchImpl: p.fetchImpl }); assert.equal(r.code, 0, r.text); return new Set(p.calls.map((c) => c.body.model)); };
  assert.deepEqual([...await model([], {})], ["claude-haiku-5-5"]);
  assert.deepEqual([...await model([], { CLAUDE_VOICE_MODEL: "claude-sonnet-5-5" })], ["claude-sonnet-5-5"]);
  assert.deepEqual([...await model(["--claude-model", "claude-opus-5"], { CLAUDE_VOICE_MODEL: "claude-sonnet-5-5" })], ["claude-opus-5"]);
  assert.deepEqual([...await model([], { CLAUDE_VOICE_MODEL: "bad id; drop" })], ["claude-haiku-5-5"]);
  assert.equal((await run(["--out", tmp(), "--dry-run", "--claude-model", "x y"])).code, 2);
});

test("generation parameters match the Worker source (the flag-off call: 350 tokens, temperature 0.3)", () => {
  const src = readFileSync(join(ROOT, "infrastructure/worker/ai-models.js"), "utf8");
  assert.ok(src.includes("const ANSWER_GEN_PARAMS = { max_tokens: 350, temperature: 0.3 };"));
  assert.deepEqual(FLAG_OFF_GEN, { max_tokens: 350, temperature: 0.3 });
  assert.deepEqual(RESEARCH_GEN, { max_tokens: 700, temperature: 0.3 });
});

test("provider failures: error codes only, rows missing, exit 1, no body or key echoed", async () => {
  const out = tmp();
  const p = fakeProviders({ antStatus: 401, cfStatus: 500 });
  const r = await run(["--out", out, "--live", "--yes"], { env: KEYS, fetchImpl: p.fetchImpl });
  assert.equal(r.code, 1);
  const usage = JSON.parse(read(out, "usage.json"));
  const errs = new Set(usage.calls.filter((c) => c.status !== "ok").map((c) => c.error));
  assert.ok(errs.has("http-401") && errs.has("http-500"), [...errs].join());
  assert.ok(!r.text.includes(ANT_KEY) && !allText(out).includes(ANT_KEY));
  const mapping = JSON.parse(read(out, "mapping.json"));
  const claude = Object.keys(mapping.arms).find((k) => mapping.arms[k] === "restored-claude");
  assert.equal(rows(out, `${claude}.jsonl`).length, 0);
});

test("the runner uses the frozen prompts file: its hash matches and a full run reads exactly those 38 ids", async () => {
  assert.equal(hashPrompts(PROMPTS), frozenHashes().prompts);
  const out = tmp();
  assert.equal((await run(["--out", out, "--dry-run"])).code, 0);
  assert.deepEqual(rows(out, "arm1.jsonl").map((x) => x.id), PROMPTS.map((p) => p.id));
});
