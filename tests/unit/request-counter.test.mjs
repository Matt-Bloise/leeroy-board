// The per-run Worker request counter (tests/helpers/count-requests.mjs + tools/request-summary.mjs): counts only requests to the origin in PREVIEW_API, writes one line per process,
// does nothing without its two variables, changes no request, and the summary adds the lines up.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sumRequests, render } from "../../tools/request-summary.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const COUNTER = pathToFileURL(path.join(here, "..", "helpers", "count-requests.mjs")).href;

function runNode(script, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", COUNTER, "--input-type=module", "-e", script], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("close", (code) => resolve({ code, out }));
  });
}

test("the counter counts the requests to the preview origin and only those, and leaves them unchanged", async () => {
  const hits = [];
  const server = http.createServer((req, res) => { hits.push(req.url); res.end("ok"); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reqcount-"));
  const log = path.join(dir, "log.txt");
  try {
    const script = `
      const base = ${JSON.stringify(`http://127.0.0.1:${port}`)};
      await (await fetch(base + "/a")).text();
      await (await fetch(new URL("/b", base))).text();
      await (await fetch(new Request(base + "/c"))).text();
      process.stdout.write(String(globalThis.__workerRequestCounter()));
    `;
    const r = await runNode(script, { PREVIEW_API: `http://127.0.0.1:${port}/ignored/path`, WORKER_REQUEST_LOG: log });
    assert.equal(r.code, 0, r.out);
    assert.equal(r.out, "3", "three requests counted");
    assert.deepEqual(hits.sort(), ["/a", "/b", "/c"], "every request still reached the server unchanged");
    assert.match(readFileSync(log, "utf8"), /^\S+ 3\n$/, "one line per process");
    // another origin is not counted
    const other = await runNode(`await (await fetch("http://127.0.0.1:${port}/d")).text(); process.stdout.write(String(globalThis.__workerRequestCounter()));`, { PREVIEW_API: "http://127.0.0.1:1", WORKER_REQUEST_LOG: log });
    assert.equal(other.out, "0");
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("without PREVIEW_API or WORKER_REQUEST_LOG the counter does nothing at all", async () => {
  const r = await runNode(`process.stdout.write(String(typeof globalThis.__workerRequestCounter));`, { PREVIEW_API: "", WORKER_REQUEST_LOG: "" });
  assert.equal(r.out, "undefined");
  assert.equal((await runNode(`process.stdout.write(String(typeof globalThis.__workerRequestCounter));`, { PREVIEW_API: "http://127.0.0.1:1", WORKER_REQUEST_LOG: "" })).out, "undefined");
});

test("the summary adds the per-process lines, drops zeros and never prints a host", () => {
  const r = sumRequests("api.test.mjs 90\ncontract.test.mjs 27\nnpm-cli.js 0\nrecover-preview.mjs 3\napi.test.mjs 5\nnot a line\n");
  assert.equal(r.total, 125);
  assert.deepEqual(r.rows.map((x) => `${x.script}:${x.count}`), ["api.test.mjs:95", "contract.test.mjs:27", "recover-preview.mjs:3"]);
  const md = render("api", r);
  assert.match(md, /\*\*125\*\* requests/);
  assert.equal(/https?:\/\//.test(md), false);
  assert.equal(sumRequests("").total, 0);
});

test("the api and crawl jobs load the counter and print the summary", () => {
  const wf = readFileSync(path.join(here, "..", "..", ".github", "workflows", "preview-tests.yml"), "utf8");
  assert.equal((wf.match(/NODE_OPTIONS: --import=\.\/helpers\/count-requests\.mjs/g) || []).length, 2);
  assert.ok(wf.includes('node tools/request-summary.mjs "$RUNNER_TEMP/worker-requests.log" api'));
  assert.ok(wf.includes('node tools/request-summary.mjs "$RUNNER_TEMP/worker-requests.log" crawl'));
});
