// Unit tests for the offline flow of the arm runner: --emit-prompts and --ingest-answers (tools/voice-eval/offline.mjs). No keys, no network.
// The real roster is read at runtime and used only in boolean assertions; first names used for the flagged-reply test are made-up strings injected for the test.
// Run: node --test tests/unit/voice-eval-offline.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { main, parseArgs } from "../../tools/voice-eval/run-arms.mjs";
import { OFFLINE_ARMS, SHEETS, seedDb, makeEnv, planItem, claudeAdapter } from "../../tools/voice-eval/arms.mjs";
import { guardBody, scanBody } from "../../infrastructure/worker/privacy/outbound-guard.js";
import { researchMembers, researchMembersFor, genericAliases, setFirstNameSource } from "../../infrastructure/worker/privacy/roster-config.js";
import { ROSTER_DATA } from "../../infrastructure/worker/bot-data.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PROMPTS = JSON.parse(readFileSync(join(ROOT, "tools/voice-eval/prompts.json"), "utf8"));
const tmp = () => mkdtempSync(join(tmpdir(), "offline-"));
const read = (...p) => readFileSync(join(...p), "utf8");
const rows = (dir, f) => read(dir, f).split("\n").filter(Boolean).map((l) => JSON.parse(l));
const TOKEN_RE = /\{P\d+\.[a-z0-9]+\}/;
const realFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = realFetch; });

// Captures every console method and both injected loggers; no network allowed; the env is a spy that records every property read.
async function run(args) {
  const logs = [], accessed = [];
  const env = new Proxy({}, { get: (_t, k) => { accessed.push(String(k)); return undefined; }, has: (_t, k) => { accessed.push(String(k)); return false; }, ownKeys: () => { accessed.push("<keys>"); return []; } });
  globalThis.fetch = async () => { throw new Error("network is not allowed in the offline flow"); };
  const real = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of Object.keys(real)) console[k] = (...a) => logs.push(a.map(String).join(" "));
  let code;
  try { code = await main(args, { env, log: (m) => logs.push(String(m)), err: (m) => logs.push(String(m)) }); } finally { Object.assign(console, real); globalThis.fetch = realFetch; }
  return { code, logs, text: logs.join("\n"), accessed };
}

const mappingOf = (dir) => JSON.parse(read(dir, "mapping.json"));
const neutralOf = (dir, name) => Object.entries(mappingOf(dir).arms).find(([, v]) => v === name)[0];
const emitted = (dir, n) => readdirSync(join(dir, n)).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
const promptFile = (dir, n, id) => JSON.parse(read(dir, n, `${id}.json`));
const BODY = "Short version first. That is the plain pick for most tables.";
// A fake model reply for one emitted prompt: research arms get a reply that echoes the first name token they were shown (so detokenising is exercised).
function fakeReply(file) { const tok = (file.user.match(TOKEN_RE) || [""])[0]; return tok ? `${BODY} ${tok} should take it.` : BODY; }
function answerAll(dir, replyFor = fakeReply) {
  for (const n of Object.keys(mappingOf(dir).arms)) for (const id of emitted(dir, n)) writeFileSync(join(dir, n, `${id}.answer.txt`), replyFor(promptFile(dir, n, id), n, id), "utf8");
}
const emit = async (dir, seed = 4) => { const r = await run(["--emit-prompts", "--out", dir, "--seed", String(seed)]); assert.equal(r.code, 0, r.text); return r; };

test("emit: neutral arm directories, one {system,user} file per prompt, private mapping, code-written and blocked listed, no network, no env read", async () => {
  const dir = tmp();
  const r = await emit(dir);
  assert.deepEqual(r.accessed, [], "the offline flow never touches the environment");
  assert.deepEqual(readdirSync(dir).sort(), ["arm1", "arm2", "arm3", "mapping.json"]);
  const m = mappingOf(dir);
  assert.equal(m.private, true);
  assert.deepEqual(Object.values(m.arms).sort(), OFFLINE_ARMS.map((a) => a.name).sort());
  const A = neutralOf(dir, "prod-prompt"), B = neutralOf(dir, "restored-haiku"), C = neutralOf(dir, "restored-sonnet");
  assert.equal(emitted(dir, B).length, 38);
  assert.equal(emitted(dir, C).length, 38);
  assert.equal(emitted(dir, A).length + (m.codeWritten[A] || []).length, 38, "arm A: a file, or listed as code-written");
  assert.ok((m.codeWritten[A] || []).length >= 10, "the flag-off abstain state writes its own answer");
  for (const n of [A, B, C]) for (const id of emitted(dir, n)) assert.deepEqual(Object.keys(promptFile(dir, n, id)).sort(), ["system", "user"]);
  // The research-mode prompt is the same text for the Haiku-class and the Sonnet-class arm; arm A is the production prompt.
  for (const id of emitted(dir, B)) assert.deepEqual(promptFile(dir, B, id), promptFile(dir, C, id), id);
  const id = emitted(dir, A)[0];
  assert.notEqual(promptFile(dir, A, id).system, promptFile(dir, B, id).system === undefined ? "" : promptFile(dir, B, id).system);
  assert.match(r.text, /no network/);
  for (const q of PROMPTS) assert.ok(!r.text.includes(q.prompt), `log has prompt ${q.id}`);
});

test("emit: the files are exactly what the Claude adapter would send, and the research prompts pass the guards under the fictional and the real roster", async () => {
  const dir = tmp();
  await emit(dir);
  const B = neutralOf(dir, "restored-haiku");
  // The adapter's request body for one prompt carries the emitted text verbatim.
  const seen = [];
  const adapter = claudeAdapter({ apiKey: "FAKE", model: "m", fetchImpl: async (_u, init) => { seen.push(JSON.parse(init.body)); return new Response(JSON.stringify({ content: [{ type: "text", text: "x" }] }), { status: 200 }); } });
  const f = promptFile(dir, B, "info-05");
  await adapter({ system: f.system, user: f.user, gen: { max_tokens: 700 } });
  assert.equal(seen[0].system[0].text, f.system);
  assert.equal(seen[0].messages[0].content, f.user);
  // Same files, as planItem builds them for the same seed.
  const env = makeEnv(seedDb(PROMPTS));
  const it = await planItem(env, OFFLINE_ARMS[1], PROMPTS.find((p) => p.id === "info-05"), 4);
  assert.equal(it.system, f.system); assert.equal(it.user, f.user);
  // Guards.
  const fictional = { members: researchMembersFor(SHEETS), genericAliases: [...genericAliases] };
  const real = { members: researchMembers(), genericAliases: [...genericAliases] };
  for (const id of emitted(dir, B)) {
    const file = promptFile(dir, B, id);
    const body = { model: "m", max_tokens: 700, system: [{ type: "text", text: file.system }], messages: [{ role: "user", content: file.user }] };
    for (const [label, roster] of [["fictional", fictional], ["real", real]]) {
      assert.doesNotThrow(() => guardBody(body, roster), `${id} guardBody (${label})`);
      assert.equal(scanBody(body, roster).length, 0, `${id} scanBody (${label})`);
    }
    assert.ok(!/Fakepriest|Testbard|Sampleshaman|Demorogue/.test(JSON.stringify(file)), `${id}: a member name is in the prompt`);
    assert.match(file.system + file.user, TOKEN_RE);
  }
  const A = neutralOf(dir, "prod-prompt");
  for (const id of emitted(dir, A)) { const file = promptFile(dir, A, id); assert.equal(scanBody({ s: file.system, u: file.user }, real).length, 0, `${id}: a real roster name is in an arm A prompt`); }
});

test("round trip: fake answers for every emitted prompt produce 3 arm files with 38 rows and neutral names", async () => {
  const dir = tmp();
  await emit(dir);
  answerAll(dir);
  const out = tmp();
  const r = await run(["--ingest-answers", dir, "--out", out]);
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(r.accessed, []);
  assert.deepEqual(readdirSync(out).sort(), ["arm1.jsonl", "arm2.jsonl", "arm3.jsonl", "ingest-report.json"]);
  for (const n of ["arm1", "arm2", "arm3"]) {
    const list = rows(out, `${n}.jsonl`);
    assert.deepEqual(list.map((x) => x.id), PROMPTS.map((p) => p.id), n);
    for (const x of list) { assert.deepEqual(Object.keys(x).sort(), ["answer", "id"]); assert.ok(x.answer.trim()); assert.doesNotMatch(x.answer, /\{(?:P\d+|ID|ALL|INVITE|GUILD)\.[a-z0-9]+\}/); }
    assert.doesNotMatch(read(out, `${n}.jsonl`), /prod-prompt|restored|haiku|sonnet|claude|llama|anthropic/i);
  }
  const report = JSON.parse(read(out, "ingest-report.json"));
  assert.deepEqual(report.missing, []); assert.deepEqual(report.errors, []);
  // Without --out the arm files land next to the answers.
  assert.equal((await run(["--ingest-answers", dir])).code, 0);
  assert.ok(existsSync(join(dir, "arm1.jsonl")));
});

test("finishing differs by arm: the flag-off deleters cut an unsupported number that research mode keeps and labels; an imperative opener is cut in every arm", async () => {
  const dir = tmp();
  await emit(dir);
  const reply = "Moonpetal gathering is quick if you plan it. Go with the northern route first. It takes 45 minutes in total and drops 99 petals.";
  answerAll(dir, (_f, _n, id) => (id === "info-09" ? reply : BODY));
  const out = tmp();
  assert.equal((await run(["--ingest-answers", dir, "--out", out])).code, 0);
  const get = (name) => rows(out, `${neutralOf(dir, name)}.jsonl`).find((x) => x.id === "info-09").answer;
  const a = get("prod-prompt"), b = get("restored-haiku"), c = get("restored-sonnet");
  assert.ok(!/45|99/.test(a), `arm A keeps an unsupported number: ${a}`);
  for (const t of [b, c]) { assert.match(t, /45 minutes/); assert.match(t, /Classic value, not confirmed for Forever/); }
  assert.equal(b, c);
  // repairHouseVoice (the "inform, never instruct" step) runs in all arms, so this imperative opener is not a differentiator.
  for (const t of [a, b, c]) assert.ok(!/Go with the northern route/.test(t), t);
});

test("tokens in a research reply are detokenised; a token that is not ours is flagged", async () => {
  const dir = tmp();
  await emit(dir);
  answerAll(dir);
  const B = neutralOf(dir, "restored-haiku");
  const f = promptFile(dir, B, "info-05");
  const tok = f.user.match(TOKEN_RE)[0];
  writeFileSync(join(dir, B, "info-05.answer.txt"), `**Short answer first.** ${tok} should take the sturdier route.\n-# Sources: general Classic-era knowledge · unconfirmed`);
  writeFileSync(join(dir, B, "info-06.answer.txt"), `${BODY} {P9.zzzz} should take it.`);
  const out = tmp();
  const r = await run(["--ingest-answers", dir, "--out", out]);
  assert.equal(r.code, 1);
  const ok = rows(out, `${B}.jsonl`).find((x) => x.id === "info-05").answer;
  assert.doesNotMatch(ok, /\{P/);
  assert.match(ok, /Fakepriest|Testbard|Sampleshaman|Demorogue/, "the token came back as a display name");
  const report = JSON.parse(read(out, "ingest-report.json"));
  assert.deepEqual(report.errors, [{ arm: B, id: "info-06", error: "reply:flagged" }]);
  assert.ok(!rows(out, `${B}.jsonl`).some((x) => x.id === "info-06"), "a flagged reply is not defaulted into the file");
});

test("a reply that leaks a first name is flagged, not written, and the name is never logged", async () => {
  const FIRST = "Zorblaxington";
  setFirstNameSource((_r, i) => [`${FIRST}${i}`]);
  try {
    const dir = tmp();
    await emit(dir);
    answerAll(dir);
    const B = neutralOf(dir, "restored-sonnet");
    writeFileSync(join(dir, B, "info-01.answer.txt"), `${BODY} ${FIRST}0 would agree.`);
    const out = tmp();
    const r = await run(["--ingest-answers", dir, "--out", out]);
    assert.equal(r.code, 1);
    const report = JSON.parse(read(out, "ingest-report.json"));
    assert.deepEqual(report.errors, [{ arm: B, id: "info-01", error: "reply:flagged" }]);
    assert.ok(!rows(out, `${B}.jsonl`).some((x) => x.id === "info-01"));
    assert.ok(!r.text.includes(FIRST) && !read(out, "ingest-report.json").includes(FIRST) && !read(out, `${B}.jsonl`).includes(FIRST));
  } finally { setFirstNameSource(null); }
});

test("missing answers are reported and never defaulted", async () => {
  const dir = tmp();
  await emit(dir);
  answerAll(dir);
  const A = neutralOf(dir, "prod-prompt"), C = neutralOf(dir, "restored-sonnet");
  const [gone] = emitted(dir, C);
  rmSync(join(dir, C, `${gone}.answer.txt`));
  const aGone = emitted(dir, A)[0];
  rmSync(join(dir, A, `${aGone}.answer.txt`));
  const out = tmp();
  const r = await run(["--ingest-answers", dir, "--out", out]);
  assert.equal(r.code, 1);
  assert.match(r.text, /2 missing answers/);
  const report = JSON.parse(read(out, "ingest-report.json"));
  assert.deepEqual(report.missing.map((m) => `${m.arm}:${m.id}`).sort(), [`${A}:${aGone}`, `${C}:${gone}`].sort());
  assert.ok(!rows(out, `${C}.jsonl`).some((x) => x.id === gone));
  assert.equal(rows(out, `${C}.jsonl`).length, 37);
});

test("a changed prompt since emit is refused for that prompt (the reply answers a different prompt)", async () => {
  const dir = tmp();
  await emit(dir);
  answerAll(dir);
  const m = mappingOf(dir);
  const B = neutralOf(dir, "restored-haiku");
  m.promptSha256[B]["info-02"] = "0".repeat(64);
  writeFileSync(join(dir, "mapping.json"), JSON.stringify(m));
  const out = tmp();
  const r = await run(["--ingest-answers", dir, "--out", out]);
  assert.equal(r.code, 1);
  assert.deepEqual(JSON.parse(read(out, "ingest-report.json")).errors, [{ arm: B, id: "info-02", error: "prompt:drift" }]);
});

test("no key or prompt text in logs or written files, and the environment is never read", async () => {
  const dir = tmp();
  const e = await emit(dir);
  answerAll(dir);
  const out = tmp();
  const i = await run(["--ingest-answers", dir, "--out", out]);
  assert.deepEqual([...e.accessed, ...i.accessed], []);
  const privateFiles = read(dir, "mapping.json") + read(out, "ingest-report.json");
  for (const q of PROMPTS) for (const t of [e.text, i.text, privateFiles]) assert.ok(!t.includes(q.prompt), `prompt ${q.id} in a log or private file`);
  for (const t of [e.text, i.text, privateFiles]) assert.ok(!t.includes("USER_QUESTION") && !/sk-ant|Bearer/.test(t));
  assert.ok(!/Fakepriest|Testbard|Sampleshaman|Demorogue/.test(e.text + i.text + privateFiles));
});

test("deterministic with --seed: same seed gives byte-identical prompts, mapping and ingested files; another seed differs", async () => {
  const [a, b, c] = [tmp(), tmp(), tmp()];
  await emit(a, 8); await emit(b, 8); await emit(c, 9);
  const snap = (d) => readdirSync(d).sort().flatMap((n) => (n === "mapping.json" ? [[n, read(d, n)]] : readdirSync(join(d, n)).sort().map((f) => [`${n}/${f}`, read(d, n, f)])));
  assert.deepEqual(snap(a), snap(b));
  assert.notDeepEqual(snap(a), snap(c));
  answerAll(a); answerAll(b);
  const [oa, ob] = [tmp(), tmp()];
  await run(["--ingest-answers", a, "--out", oa]); await run(["--ingest-answers", b, "--out", ob]);
  for (const f of ["arm1.jsonl", "arm2.jsonl", "arm3.jsonl"]) assert.equal(read(oa, f), read(ob, f), f);
});

test("mode flags: exactly one mode, --yes only with --live, bad mapping refused, ingest of an empty directory refused", async () => {
  assert.ok(parseArgs(["--emit-prompts", "--out", "x"]).opts.emit);
  assert.equal(parseArgs(["--ingest-answers", "d"]).opts.out, "d");
  assert.ok(parseArgs(["--emit-prompts", "--dry-run", "--out", "x"]).error);
  assert.ok(parseArgs(["--emit-prompts", "--yes", "--out", "x"]).error);
  assert.ok(parseArgs(["--out", "x"]).error);
  const empty = tmp();
  assert.equal((await run(["--ingest-answers", empty])).code, 2);
  writeFileSync(join(empty, "mapping.json"), JSON.stringify({ seed: 1, arms: { arm1: "restored-llama" } }));
  assert.equal((await run(["--ingest-answers", empty])).code, 2);
  assert.ok(ROSTER_DATA.length > 0);
});
