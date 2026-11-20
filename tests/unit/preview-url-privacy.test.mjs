// The account's workers.dev subdomain carries a personal name. It must not reach the public PR comment, a workflow log, a job output or an uploaded artifact through the preview and deploy workflows.
// Design: nothing carries the host in clear between jobs (job outputs that contain a masked value are dropped, artifacts are downloadable by any signed-in user). The preview-secrets job (the only Preview Tests job that
// holds the Cloudflare token, pinned by workflow-secrets.test.mjs) reads the account subdomain from the API, masks it and hands on only its base64; every job that needs the host rebuilds it itself
// (tools/preview-worker-url.sh: masked before anything else, written to $GITHUB_ENV only), and every job that uploads files scrubs them first (tools/scrub-subdomain.sh, pattern-based).
// (The subdomain is also in served files and git history: docs/parity/worker-parity-gap-table.md. Renaming the subdomain or a custom domain is the account admin's.)
// Run: node --test tests/unit/preview-url-privacy.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");
const { parse } = createRequire(import.meta.url)("yaml");
const WF = Object.fromEntries(["preview-tests", "pr-preview-cloudflare", "deploy-cloudflare", "security", "nightly-production"].map((n) => [n, { text: read(`.github/workflows/${n}.yml`), doc: parse(read(`.github/workflows/${n}.yml`)) }]));
const stepsOf = (doc) => Object.entries(doc.jobs).flatMap(([job, j]) => (j.steps || []).map((s, i) => ({ job, i, ...s })));
const hasBash = !spawnSync("bash", ["-c", "true"]).error;

test("the sticky preview comment never prints the Worker URL or a workers.dev host", () => {
  const script = stepsOf(WF["pr-preview-cloudflare"].doc).find((s) => /Post \/ Update Sticky PR Preview Comment/.test(s.name || "")).with.script;
  assert.ok(!/workerUrl|worker_url/.test(script), "the comment script does not read the Worker URL");
  assert.ok(!/workers\.dev\/|\$\{[^}]*workers\.dev/.test(script), "no workers.dev URL is built in the comment");
  assert.match(script, /host not printed here/);
});

test("every wrangler deploy output is masked and redacted before it reaches the log (preview and production)", () => {
  for (const [name, doc] of [["pr-preview-cloudflare", WF["pr-preview-cloudflare"].doc], ["deploy-cloudflare", WF["deploy-cloudflare"].doc]]) {
    const step = stepsOf(doc).find((s) => /^Deploy (Ephemeral PR Worker|Cloudflare Worker)/.test(s.name || ""));
    assert.ok(step, `${name} deploy step`);
    assert.ok(!/^\s*echo "\$DEPLOY_OUT"\s*$/m.test(step.run), `${name}: a bare echo of the deploy output would print the account subdomain`);
    assert.ok(step.run.includes("echo \"$DEPLOY_OUT\" | sed -E 's#\\.[a-z0-9-]+\\.workers\\.dev#.<account-subdomain>.workers.dev#g'"), `${name}: the redacting sed`);
    assert.match(step.run, /echo "::add-mask::\$SUB"/, `${name}: the subdomain is masked`);
    assert.ok(step.run.indexOf("::add-mask::$SUB") < step.run.indexOf("echo \"$DEPLOY_OUT\" | sed"), `${name}: masked before the first echo`);
    assert.ok(/\\1#'/.test(step.run) && !/\x01/.test(step.run), `${name}: the sed back-reference is a real \\1`);
  }
  assert.ok(!/\x01/.test(WF["pr-preview-cloudflare"].text) && !/\x01/.test(WF["deploy-cloudflare"].text), "no control character in the workflows");
});

test("no artifact, no comment and no job output carries the Worker host between jobs", () => {
  const pt = WF["preview-tests"], pp = WF["pr-preview-cloudflare"];
  assert.ok(!stepsOf(pp.doc).some((s) => s.uses && /upload-artifact/.test(s.uses) && s.with && s.with.name === "preview-urls"), "no preview-urls artifact");
  assert.ok(!/preview-urls/.test(pp.text) && !/preview-urls/.test(pt.text), "no preview-urls channel left");
  for (const [job, j] of Object.entries(pt.doc.jobs)) for (const [k, v] of Object.entries(j.outputs || {})) assert.ok(!/worker/i.test(k) && !/worker/i.test(String(v)), `${job}.outputs.${k}`);
  assert.ok(!/needs\.preview\.outputs\.worker|steps\.urls\.outputs\.worker/.test(pt.text), "no job reads a Worker output");
  for (const [job, j] of Object.entries(pp.doc.jobs)) for (const [k, v] of Object.entries(j.outputs || {})) assert.ok(!/worker/i.test(k) && !/worker/i.test(String(v)), `pr-preview ${job}.outputs.${k}`);
});

test("the preview-secrets job reads the subdomain, masks it first and hands on only its base64", () => {
  const job = WF["preview-tests"].doc.jobs["preview-secrets"];
  const step = job.steps.find((x) => x.id === "sub");
  assert.ok(step && step.if === "steps.check.outputs.enabled == 'true'");
  assert.match(step.run, /^set \+x$/m);
  assert.ok(step.run.indexOf('echo "::add-mask::$SUB"') < step.run.indexOf("base64 -w0"), "masked before it is encoded");
  assert.equal(job.outputs.sub_b64, "${{ steps.sub.outputs.b64 }}");
  assert.equal(WF["preview-tests"].doc.jobs.preview.outputs.sub_b64, "${{ needs.preview-secrets.outputs.sub_b64 }}");
  assert.match(step.run, /Workers Scripts: Read/);
  for (const line of step.run.split("\n")) if (/^\s*echo\b/.test(line) && /\$\{?(RESP|SUB)\b/.test(line)) assert.match(line, /::add-mask::\$SUB|b64=\$\(printf '%s' "\$SUB" \| base64 -w0\)" >> "\$GITHUB_OUTPUT"/, `only the mask and the base64 output mention it: ${line.trim()}`);
});

test("every job of Preview Tests that talks to the preview Worker or uploads files resolves the host itself first, and scrubs before it uploads", () => {
  const doc = WF["preview-tests"].doc;
  const jobs = ["preview", "recover", "api", "browser", "layout", "visual-audit", "crawl"];
  for (const name of jobs) {
    const steps = doc.jobs[name].steps;
    const resolve = steps.findIndex((s) => /preview-worker-url\.sh "\$PR_NUMBER"/.test(s.run || ""));
    assert.ok(resolve >= 0, `${name}: resolves the host`);
    assert.ok(steps.findIndex((s) => s.uses && /actions\/checkout@/.test(s.uses)) < resolve, `${name}: tools/ is checked out first`);
    const r = steps[resolve];
    assert.match(r.env.PREVIEW_SUBDOMAIN_B64, name === "preview" ? /needs\.preview-secrets\.outputs\.sub_b64/ : /needs\.preview\.outputs\.sub_b64/);
    for (let k = 0; k < steps.length; k++) assert.ok(!JSON.stringify(steps[k]).includes("secrets.CLOUDFLARE"), `${name}: the Cloudflare token is not in this job`);
    for (let k = 0; k < steps.length; k++) {
      if (!(steps[k].uses && /upload-artifact/.test(steps[k].uses))) continue;
      assert.ok(k > resolve, `${name}: the upload comes after the resolve`);
      const before = steps.slice(0, k).reverse().find((s) => /scrub-subdomain\.sh/.test(s.run || ""));
      assert.ok(before, `${name}: a scrub step sits before the upload`);
      assert.equal(before.if, "always()");
      const uploaded = String(steps[k].with.path).split("\n").map((x) => x.trim()).filter(Boolean).map((x) => x.replace("${{ runner.temp }}", "$RUNNER_TEMP"));
      for (const f of uploaded) assert.ok(before.run.includes(f.replace(/^\$RUNNER_TEMP\//, "$RUNNER_TEMP/")) || before.run.includes(f.split("/")[0]), `${name}: ${f} is scrubbed (${before.run})`);
    }
  }
  const zap = stepsOf(WF.security.doc).filter((s) => s.job === "zap");
  assert.ok(!zap.some((s) => /preview-worker-url\.sh/.test(s.run || "") || JSON.stringify(s).includes("CLOUDFLARE_API_TOKEN")), "ZAP holds no Cloudflare token: it scrubs by pattern");
  const zi = zap.findIndex((s) => s.uses && /upload-artifact/.test(s.uses) && s.with && s.with.name === "security-zap");
  assert.ok(zap.slice(0, zi).some((s) => /scrub-subdomain\.sh zap-out/.test(s.run || "")), "ZAP scrubs its report before upload");
});

test("no upload-artifact step uploads a file written from the Worker URL, and no step writes the URL to a file", () => {
  for (const [name, wf] of Object.entries(WF)) {
    for (const s of stepsOf(wf.doc)) {
      for (const line of String(s.run || "").split("\n")) {
        if (!/(WORKER_URL|PREVIEW_API|PREVIEW_SUBDOMAIN)/.test(line)) continue;
        if (/>>?\s*"?\$?\{?(GITHUB_OUTPUT|GITHUB_ENV)\}?"?/.test(line)) continue; // step output / env of the same job
        assert.ok(!/>>?\s*\S/.test(line.replace(/2>&1|[12]?>\/dev\/null/g, "")), `${name}/${s.job}: ${line.trim()} writes the host to a file`);
      }
    }
  }
});

test("tools/preview-worker-url.sh: decodes, masks first, never echoes the host, fails closed", { skip: !hasBash }, () => {
  const src = read("tools/preview-worker-url.sh");
  assert.match(src, /^set \+x$/m);
  assert.ok(src.indexOf("::add-mask::$SUB") < src.indexOf("PREVIEW_SUBDOMAIN=$SUB"), "masked before the env file is written");
  assert.ok(src.indexOf("::add-mask::$SUB") < src.indexOf('echo "::add-mask::$HOST"'));
  assert.ok(!/echo[^\n]*\$(SUB|HOST)(?!")/.test(src.replace(/echo "::add-mask::[^"]*"/g, "")), "no echo of the subdomain or the host outside the mask commands");
  const dir = mkdtempSync(path.join(tmpdir(), "pwu-"));
  const run = (b64, pr = "425") => { const envf = path.join(dir, "env.txt"); writeFileSync(envf, ""); const r = spawnSync("bash", [path.join(ROOT, "tools/preview-worker-url.sh"), pr], { encoding: "utf8", env: { ...process.env, PREVIEW_SUBDOMAIN_B64: b64, GITHUB_ENV: envf } }); return { ...r, env: readFileSync(envf, "utf8") }; };
  const ok = run(Buffer.from("fixture-sub").toString("base64"));
  assert.equal(ok.status, 0, ok.stderr);
  const lines = ok.stdout.split("\n").filter(Boolean);
  assert.ok(lines[0].startsWith("::add-mask::"), "the first thing printed is a mask");
  assert.deepEqual(lines.filter((l) => l.startsWith("::add-mask::")), ["::add-mask::fixture-sub", "::add-mask::leeroy-brain-pr-425.fixture-sub.workers.dev", "::add-mask::https://leeroy-brain-pr-425.fixture-sub.workers.dev"]);
  assert.ok(!lines.filter((l) => !l.startsWith("::add-mask::")).join("\n").includes("fixture-sub"), "the subdomain appears nowhere but in the mask commands");
  assert.equal(ok.env, "PREVIEW_SUBDOMAIN=fixture-sub\nPREVIEW_API=https://leeroy-brain-pr-425.fixture-sub.workers.dev\n");
  for (const bad of ["", "!!!", Buffer.from("bad sub!").toString("base64"), Buffer.from("-x").toString("base64")]) {
    const r = run(bad);
    assert.equal(r.status, 1, JSON.stringify(bad));
    assert.match(r.stdout, /::error::/);
    assert.ok(!r.stdout.includes("::add-mask::"), "nothing guessed, nothing masked");
    assert.equal(r.env, "");
  }
  assert.equal(run(Buffer.from("fixture-sub").toString("base64"), "x1").status, 2, "a non-numeric PR number is refused");
});

test("tools/scrub-subdomain.sh replaces any workers.dev subdomain by pattern (and the exact one when known) in text files, and leaves the others alone", { skip: !hasBash }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "scr-"));
  const txt = path.join(dir, "a.log"), nested = path.join(dir, "d");
  spawnSync("bash", ["-c", `mkdir -p '${nested}'`]);
  writeFileSync(txt, "GET https://leeroy-brain-pr-9.fixture-sub.workers.dev/api\nplain fixture-sub line\n");
  writeFileSync(path.join(nested, "r.json"), '{"u":"https://x.other-sub.workers.dev"}');
  writeFileSync(path.join(dir, "clean.log"), "nothing\n");
  const r = spawnSync("bash", [path.join(ROOT, "tools/scrub-subdomain.sh"), txt, nested, path.join(dir, "missing")], { encoding: "utf8", env: { ...process.env, PREVIEW_SUBDOMAIN: "fixture-sub" } });
  assert.equal(r.status, 0, r.stderr);
  const a = readFileSync(txt, "utf8");
  assert.ok(!a.includes("fixture-sub") && a.includes("leeroy-brain-pr-9.<account-subdomain>.workers.dev") && a.includes("plain <account-subdomain> line"));
  assert.ok(!readFileSync(path.join(nested, "r.json"), "utf8").includes("other-sub"), "a subdomain it was not told about, by pattern");
  assert.equal(readFileSync(path.join(dir, "clean.log"), "utf8"), "nothing\n");
  assert.match(r.stdout, /Scrubbed \d file\(s\)/);
  assert.equal(spawnSync("bash", [path.join(ROOT, "tools/scrub-subdomain.sh"), txt], { encoding: "utf8", env: { ...process.env, PREVIEW_SUBDOMAIN: "bad sub;" } }).status, 1);
  assert.equal(spawnSync("bash", [path.join(ROOT, "tools/scrub-subdomain.sh"), txt], { encoding: "utf8", env: { ...process.env, PREVIEW_SUBDOMAIN: "" } }).status, 0);
});
