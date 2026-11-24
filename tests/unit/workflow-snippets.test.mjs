// A syntax error in a workflow snippet must never reach master again (PR 451 shipped `return;` at the top level of a `node -e` body: "Illegal return statement", the whole teardown failed).
// This file takes EVERY inline snippet out of EVERY workflow file and parses it with the real tools:
//   - every multi-line shell `run:` block with `bash -n` (a GitHub expression ${{ ... }} is replaced by a placeholder first);
//   - every `node -e '...'` / `node --input-type=... -e '...'` body, compiled the way node compiles `-e` text (a classic script: a top-level `return` is an error there), or as a module for --input-type=module;
//   - every actions/github-script `script:` body, compiled as the async function body github-script wraps it in.
// And it EXECUTES the teardown probe snippet itself (not a stand-in) against fixture answers, and the manual teardown route (assertPrClosed, the dispatch job). Needs the `yaml` package (tests/package.json).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { assertPrClosed } from "../../tools/preview-cleanup.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WF_DIR = path.join(ROOT, ".github/workflows");
const files = fs.readdirSync(WF_DIR).filter((f) => /\.ya?ml$/.test(f)).sort();
const EXPR = /\$\{\{[\s\S]*?\}\}/g;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const bashOk = spawnSync("bash", ["-c", "true"]).status === 0;

// -> [{ file, job, step, kind: "run" | "script", text }]
function snippets() {
  const out = [];
  for (const f of files) {
    const doc = parse(fs.readFileSync(path.join(WF_DIR, f), "utf8"));
    for (const [job, def] of Object.entries(doc.jobs || {})) {
      (def.steps || []).forEach((s, i) => {
        const step = s.name || s.id || `#${i + 1}`;
        if (typeof s.run === "string") out.push({ file: f, job, step, kind: "run", text: s.run });
        if (typeof s.uses === "string" && s.uses.startsWith("actions/github-script") && s.with && typeof s.with.script === "string") out.push({ file: f, job, step, kind: "script", text: s.with.script });
      });
    }
  }
  return out;
}
const ALL = snippets();
const where = (s) => `${s.file} > ${s.job} > ${s.step}`;

// The bodies of `node ... -e '<body>'` inside a shell text (single-quoted; a body never contains a single quote itself).
export function nodeBodies(shell) {
  const found = [];
  const re = /\bnode\s+((?:--[a-z-]+(?:=[\w-]+)?\s+)*)-e\s+'([^']*)'/g;
  let m;
  while ((m = re.exec(shell))) found.push({ module: /--input-type=module/.test(m[1]), body: m[2] });
  return found;
}

test("the scan finds the snippets it should (guards against the test checking nothing)", () => {
  assert.ok(files.length >= 10, "workflow files found");
  assert.ok(ALL.filter((s) => s.kind === "run").length >= 100, "run blocks found");
  assert.ok(ALL.filter((s) => s.kind === "script").length >= 10, "github-script bodies found");
  const bodies = ALL.filter((s) => s.kind === "run").flatMap((s) => nodeBodies(s.text.replace(EXPR, "GHEXPR")));
  assert.ok(bodies.length >= 10, `node -e bodies found: ${bodies.length}`);
});

test("every shell run block parses with bash -n", { skip: !bashOk && "bash is not available" }, () => {
  const bad = [];
  for (const s of ALL.filter((x) => x.kind === "run")) {
    const r = spawnSync("bash", ["-n"], { input: s.text.replace(EXPR, "GHEXPR"), encoding: "utf8" });
    if (r.status !== 0) bad.push(`${where(s)}: ${String(r.stderr).trim().split("\n")[0]}`);
  }
  assert.deepEqual(bad, []);
});

test("every node -e body compiles the way node compiles -e text (a top-level return is an error)", () => {
  const bad = [];
  for (const s of ALL.filter((x) => x.kind === "run")) {
    for (const { module, body } of nodeBodies(s.text.replace(EXPR, "GHEXPR"))) {
      try {
        if (module) {
          const tmp = path.join(fs.mkdtempSync(path.join(process.env.TEMP || process.env.TMPDIR || "/tmp", "wfsnip-")), "snippet.mjs");
          fs.writeFileSync(tmp, body);
          const r = spawnSync(process.execPath, ["--check", tmp], { encoding: "utf8" });
          fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
          if (r.status !== 0) throw new Error(String(r.stderr).split("\n").find((l) => /Error/.test(l)) || "syntax error");
        } else new vm.Script(body, { filename: "node-e-snippet" });
      } catch (e) { bad.push(`${where(s)}: ${e.message}`); }
    }
  }
  assert.deepEqual(bad, []);
});

test("every github-script body compiles as an async function body", () => {
  const bad = [];
  for (const s of ALL.filter((x) => x.kind === "script")) {
    try { new AsyncFunction("github", "context", "core", "glob", "io", "exec", "require", "__original_require__", s.text.replace(EXPR, "GHEXPR")); }
    catch (e) { bad.push(`${where(s)}: ${e.message}`); }
  }
  assert.deepEqual(bad, []);
});

test("the checker itself catches the PR 451 mistake (a top-level return in a node -e body)", () => {
  const broken = `ANSWER=$(node -e '\n  try { if (x) { process.stdout.write("unknown"); return; } } catch (e) {}\n')`;
  const [{ body }] = nodeBodies(broken);
  assert.throws(() => new vm.Script(body), /Illegal return statement/);
  assert.equal(spawnSync("bash", ["-n"], { input: broken, encoding: "utf8" }).status, 0, "bash alone cannot see it: the node check is needed");
});

// ---- execute the teardown probe, the real text from the workflow
const preview = parse(fs.readFileSync(path.join(WF_DIR, "pr-preview-cloudflare.yml"), "utf8"));
const probeStep = preview.jobs["teardown-pr-preview"].steps.find((s) => s.id === "probe");
const [probe] = nodeBodies(probeStep.run.replace(EXPR, "GHEXPR"));
const runProbe = (d1, wk) => spawnSync(process.execPath, ["-e", probe.body], { encoding: "utf8", env: { ...process.env, D1_JSON: d1, WK_JSON: wk, D1_DATABASE_NAME: "leeroy-board-db-pr-451", WORKER_NAME: "leeroy-brain-pr-451" } });
const ok = (result) => JSON.stringify({ success: true, result });

test("the teardown probe, run for real: yes when the D1 database or the Worker exists, no when neither, unknown on any answer it cannot trust", () => {
  assert.ok(probe, "the probe's node body is found in the workflow");
  const cases = [
    [ok([{ name: "leeroy-board-db-pr-451" }]), ok([]), "yes"],
    [ok([]), ok([{ id: "leeroy-brain-pr-451" }]), "yes"],
    [ok([{ name: "leeroy-board-db" }, { name: "leeroy-board-db-pr-4510" }]), ok([{ id: "leeroy-brain" }]), "no"],
    [JSON.stringify({ success: false, errors: [{ code: 10000 }] }), ok([]), "unknown"], // the branch that had the illegal return
    [ok([]), JSON.stringify({ success: false }), "unknown"],
    [ok([]), JSON.stringify({ success: true, result: null }), "unknown"],
    ["not json", ok([]), "unknown"],
    ["", "", "unknown"],
  ];
  for (const [d1, wk, want] of cases) {
    const r = runProbe(d1, wk);
    assert.equal(r.status, 0, `exit 0 for ${want}: ${r.stderr}`);
    assert.equal(r.stdout, want);
  }
});

// A job stays off on a workflow_dispatch (github.event.pull_request and github.event.action are empty there) when its own `if` reads one of them and has no status function that overrides a skipped need,
// or when it needs only jobs that stay off by the same rule and its own `if` has no status function.
export function gatedOnPullRequest(jobs, name, seen = new Set()) {
  if (seen.has(name)) return false;
  const def = jobs[name], cond = String(def.if || "");
  if (/\b(always|failure|cancelled|success)\s*\(/.test(cond)) return false;
  if (/github\.event\.pull_request|github\.event\.action/.test(cond)) return true;
  const needs = [].concat(def.needs || []);
  return needs.length > 0 && needs.every((n) => jobs[n] && gatedOnPullRequest(jobs, n, new Set([...seen, name])));
}

test("gatedOnPullRequest rejects what the old check let through: a job that needs any job, an if with always(), a job with no if", () => {
  const jobs = {
    base: { if: "github.event.pull_request.head.repo.full_name == github.repository" },
    open: { },
    dep: { needs: "open" },
    ok: { needs: ["base"] },
    forced: { needs: ["base"], if: "always() && needs.base.result == 'success'" },
  };
  assert.equal(gatedOnPullRequest(jobs, "base"), true);
  assert.equal(gatedOnPullRequest(jobs, "ok"), true);
  assert.equal(gatedOnPullRequest(jobs, "open"), false);
  assert.equal(gatedOnPullRequest(jobs, "dep"), false);
  assert.equal(gatedOnPullRequest(jobs, "forced"), false);
});

// ---- the manual teardown of a closed pull request
const pr = (state, status = 200) => async (url) => ({ ok: status >= 200 && status < 300, status, json: async () => ({ state }), url });
const refuse = async (opts, re) => assert.rejects(() => assertPrClosed({ ghToken: "t", repo: "o/r", ...opts }), re);

test("assertPrClosed: passes a closed pull request and says which number", async () => {
  assert.equal(await assertPrClosed({ fetchImpl: pr("closed"), ghToken: "t", repo: "o/r", pr: 451 }), "451");
  let asked;
  await assertPrClosed({ fetchImpl: async (u) => { asked = u; return { ok: true, status: 200, json: async () => ({ state: "closed" }) }; }, ghToken: "t", repo: "o/r", pr: "12" });
  assert.equal(asked, "https://api.github.com/repos/o/r/pulls/12");
});

test("assertPrClosed: refuses an open pull request, a number that is no pull request, an unreadable answer and anything that is not a plain number", async () => {
  await refuse({ fetchImpl: pr("open"), pr: 451 }, /open/);
  await refuse({ fetchImpl: pr("closed", 404), pr: 99999 }, /not a pull request/);
  await refuse({ fetchImpl: pr("closed", 500), pr: 5 }, /answered 500/);
  await refuse({ fetchImpl: async () => { throw new Error("offline"); }, pr: 5 }, /could not read/);
  await refuse({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error("x"); } }), pr: 5 }, /not JSON/);
  await refuse({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }), pr: 5 }, /not closed/);
  for (const bad of ["", "abc", "12 13", "12;rm", "-5", "1e3", "0x10", "4.5", "123456789", "pr-451", "../451", "451\n", "0451", "0", "00", "+451", " 451", undefined, null]) {
    let called = false;
    await refuse({ fetchImpl: async () => { called = true; return pr("closed")(); }, pr: bad }, /not a pull request number/);
    assert.equal(called, false, `no request is made for ${JSON.stringify(bad)}`);
  }
  await refuse({ fetchImpl: pr("closed"), pr: 5, repo: "not a repo" }, /repository/);
});

test("the CLI route refuses a value that is not a number with exit 1 before any network call, and takes no secret as proof", () => {
  const env = { ...process.env, CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: "", GH_TOKEN: "x", GITHUB_REPOSITORY: "o/r" };
  for (const v of ["abc", "451; echo", ""]) {
    const r = spawnSync(process.execPath, [path.join(ROOT, "tools/preview-cleanup.mjs"), "teardown-closed", v], { encoding: "utf8", env });
    assert.equal(r.status, 1, `exit 1 for ${JSON.stringify(v)}`);
    assert.match(r.stdout + r.stderr, /not a pull request number/);
  }
});

test("the dispatch job: manual input, master only, number via the environment, runs the tool's teardown-closed route, and no other job runs on a dispatch", () => {
  const w = preview;
  const inp = w.on.workflow_dispatch.inputs.pr_number;
  assert.equal(inp.required, true);
  assert.equal(inp.type, "string");
  const job = w.jobs["teardown-closed-pr"];
  assert.match(job.if, /github\.event_name == 'workflow_dispatch'/);
  assert.match(job.if, /github\.ref == 'refs\/heads\/master'/);
  assert.equal(job.env.PR_NUMBER, "${{ inputs.pr_number }}");
  const runs = job.steps.filter((s) => s.run).map((s) => s.run);
  assert.ok(runs.every((r) => !/\$\{\{/.test(r)), "no expression is pasted into script text");
  assert.ok(runs.some((r) => /preview-cleanup\.mjs teardown-closed "\$PR_NUMBER"/.test(r)));
  assert.equal(job.permissions["pull-requests"], "read", "the dispatch job cannot write to pull requests");
  assert.equal(job.permissions.contents, "read");
  for (const name of Object.keys(w.jobs)) if (name !== "teardown-closed-pr") assert.ok(gatedOnPullRequest(w.jobs, name), `job ${name} cannot be shown to stay off on a workflow_dispatch`);
  assert.match(w.concurrency.group, /workflow_dispatch/);
  assert.match(w.concurrency["cancel-in-progress"], /workflow_dispatch/);
});
