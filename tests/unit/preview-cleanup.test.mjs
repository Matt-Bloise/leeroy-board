// tools/preview-cleanup.mjs: teardown that proves deletion, and the read-only leak report. A stateful fake of the Cloudflare API; no network.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { teardown, leakReport, listAll, listWorkers, NAMES, CfError, resultFor } from "../../tools/preview-cleanup.mjs";

// A fake account: Workers, D1 databases and Pages preview deployments, with the paging the real list endpoints do (25 per page). Options inject faults.
function fakeCf({ workers = [], dbs = [], deployments = [], faults = {} } = {}) {
  const state = { workers: [...workers], dbs: dbs.map((name, i) => ({ uuid: `uuid-${i}-${name}`, name })), deployments: deployments.map((d, i) => ({ id: `dep-${i}`, environment: "preview", ...d })), calls: [] };
  const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
  const ok = (result, info) => json(200, { success: true, result, ...(info ? { result_info: info } : {}) });
  const page = (items, url) => {
    const u = new URL(url), p = Number(u.searchParams.get("page") || 1), per = Number(u.searchParams.get("per_page") || 25);
    if (faults.pageStuck) return ok(items.slice(0, per), { page: 1, per_page: per, total_count: items.length, total_pages: Math.ceil(items.length / per) });
    return ok(items.slice((p - 1) * per, p * per), { page: p, per_page: per, total_count: items.length, total_pages: Math.max(1, Math.ceil(items.length / per)) });
  };
  const fetchImpl = async (url, { method = "GET" } = {}) => {
    const path = url.replace("https://api.cloudflare.com/client/v4", ""), clean = path.split("?")[0];
    state.calls.push(`${method} ${clean}`);
    if (faults.network && method === "GET" && faults.network()) throw new Error("socket hang up");
    let m;
    if (method === "GET" && clean.endsWith("/workers/scripts")) return ok(state.workers.map((id) => ({ id })));
    if (method === "GET" && clean.endsWith("/d1/database")) return page(state.dbs, url);
    if (method === "GET" && /\/deployments$/.test(clean)) return page(state.deployments.filter((d) => d.environment === "preview"), url);
    if (method === "DELETE" && (m = /\/workers\/scripts\/([^/]+)$/.exec(clean))) {
      if (faults.workerDelete) return json(faults.workerDelete, { success: false, errors: [{ code: 10000, message: "boom" }] });
      const had = state.workers.includes(m[1]);
      if (!had) return json(404, { success: false, errors: [{ code: 10007, message: "not found" }] });
      if (!faults.keep) state.workers = state.workers.filter((w) => w !== m[1]);
      return ok({});
    }
    if (method === "DELETE" && (m = /\/d1\/database\/([^/]+)$/.exec(clean))) {
      const had = state.dbs.some((d) => d.uuid === m[1]);
      if (!had) return json(404, { success: false, errors: [{ code: 7404, message: "not found" }] });
      if (!faults.keep) state.dbs = state.dbs.filter((d) => d.uuid !== m[1]);
      return ok({});
    }
    if (method === "DELETE" && (m = /\/deployments\/([^/]+)$/.exec(clean))) {
      const had = state.deployments.some((d) => d.id === m[1]);
      if (!had) return json(404, { success: false, errors: [] });
      if (!faults.keep && !(faults.slowPages && state.slowLeft-- > 0)) state.deployments = state.deployments.filter((d) => d.id !== m[1]);
      return ok({});
    }
    return json(500, { success: false, errors: [{ code: 1, message: `unexpected ${method} ${clean}` }] });
  };
  return { state, fetchImpl };
}
const dep = (branch) => ({ deployment_trigger: { metadata: { branch } } });
const run = (cfg, extra = {}) => teardown({ token: "t", accountId: "acc", pr: 42, sleep: async () => {}, waitMs: 0, ...cfg, ...extra });

test("teardown deletes the Worker, the D1 database and every Pages deployment of the branch (all pages), then proves it", async () => {
  const deployments = [];
  for (let i = 0; i < 30; i++) deployments.push(dep(i % 2 ? "pr-42" : "pr-7")); // 15 of ours, spread over two pages
  deployments.push(dep("pr-420"), dep("pr-4")); // names that merely start like ours
  const f = fakeCf({ workers: ["leeroy-brain-pr-42", "leeroy-brain-pr-420", "leeroy-brain"], dbs: ["leeroy-board-db-pr-42", "leeroy-board-db-pr-420", "leeroy-board-db"], deployments });
  const r = await run({ fetchImpl: f.fetchImpl });
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.deepEqual(f.state.workers, ["leeroy-brain-pr-420", "leeroy-brain"], "only the exact Worker went");
  assert.deepEqual(f.state.dbs.map((d) => d.name), ["leeroy-board-db-pr-420", "leeroy-board-db"], "only the exact database went; the production name is never touched");
  assert.equal(f.state.deployments.filter((d) => d.deployment_trigger.metadata.branch === "pr-42").length, 0);
  assert.equal(f.state.deployments.length, 17, "pr-7, pr-420 and pr-4 stay");
  assert.ok(r.lines.some((l) => /verified on attempt 1/.test(l)));
  const deletes = f.state.calls.filter((c) => c.startsWith("DELETE "));
  assert.equal(deletes.length, 1 + 1 + 15);
});

test("a delete that fails is a failure, not an echo (the old teardown ended each delete with || echo)", async () => {
  const f = fakeCf({ workers: ["leeroy-brain-pr-42"], dbs: ["leeroy-board-db-pr-42"], faults: { workerDelete: 500 } });
  const r = await run({ fetchImpl: f.fetchImpl });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /delete Worker leeroy-brain-pr-42/.test(e) && /500/.test(e)));
  assert.ok(r.remaining.some((x) => /Worker leeroy-brain-pr-42/.test(x)), "and the verification names what remains");
});

test("a 404 on delete means already gone, and a PR with nothing left is a pass", async () => {
  const f = fakeCf();
  const r = await run({ fetchImpl: f.fetchImpl });
  assert.equal(r.ok, true);
  assert.ok(r.lines.some((l) => /already gone/.test(l)));
});

test("a deletion that the API acknowledges but that did not happen fails the verification, naming what remains", async () => {
  const f = fakeCf({ workers: ["leeroy-brain-pr-42"], dbs: ["leeroy-board-db-pr-42"], deployments: [dep("pr-42")], faults: { keep: true } });
  const r = await run({ fetchImpl: f.fetchImpl, attempts: 3 });
  assert.equal(r.ok, false);
  assert.deepEqual(r.remaining.sort(), ["D1 database leeroy-board-db-pr-42", "Pages deployment dep-0", "Worker leeroy-brain-pr-42"]);
  assert.equal(r.lines.filter((l) => /^attempt \d: still there/.test(l)).length, 3, "it retried before failing");
});

test("eventual consistency: a deployment that disappears on the second look is a pass", async () => {
  const f = fakeCf({ deployments: [dep("pr-42")], faults: { slowPages: true } });
  f.state.slowLeft = 1; // the first delete is acknowledged but the row survives one look
  const r = await run({ fetchImpl: f.fetchImpl });
  assert.equal(r.ok, false, "the first delete did not take, so the step reports it; a re-run finishes (idempotent)");
  const again = await run({ fetchImpl: f.fetchImpl });
  assert.equal(again.ok, true);
});

test("a listing that cannot be completed is a failure, never a pass (the old code read only the first page)", async () => {
  const deployments = Array.from({ length: 60 }, () => dep("pr-7"));
  const f = fakeCf({ deployments, faults: { pageStuck: true } });
  const r = await run({ fetchImpl: f.fetchImpl });
  assert.equal(r.ok, false);
  assert.ok([...r.errors, ...r.remaining].some((x) => /incomplete/.test(x)), [...r.errors, ...r.remaining].join(" | "));
});

test("a network error while verifying is a failure, not a pass", async () => {
  let n = 0;
  const f = fakeCf({ workers: ["leeroy-brain-pr-42"], faults: { network: () => ++n > 2 } });
  const r = await run({ fetchImpl: f.fetchImpl, attempts: 2 });
  assert.equal(r.ok, false);
  assert.ok(r.remaining.some((x) => /could not verify/.test(x)));
});

test("listAll reads every page, and NAMES refuses anything that is not a pull request number", async () => {
  const f = fakeCf({ dbs: Array.from({ length: 60 }, (_, i) => `leeroy-board-db-pr-${i}`) });
  const all = await listAll(f.fetchImpl, "t", "/accounts/acc/d1/database", "", (d) => d.uuid);
  assert.equal(all.length, 60);
  for (const bad of ["", "x", "1; rm", "-1", "123456789", "4 2", "../1"]) assert.throws(() => NAMES(bad), /not a pull request number/, bad);
  assert.deepEqual(NAMES(42), { worker: "leeroy-brain-pr-42", d1: "leeroy-board-db-pr-42", branch: "pr-42" });
  assert.ok(new CfError("x", 1) instanceof Error);
});

test("the leak report lists previews of closed or unknown PRs, ignores production and open PRs, and only reads", async () => {
  const f = fakeCf({
    workers: ["leeroy-brain", "leeroy-brain-pr-10", "leeroy-brain-pr-11", "leeroy-gateway-spike"],
    dbs: ["leeroy-board-db", "leeroy-board-db-pr-10", "leeroy-board-db-pr-12"],
    deployments: [dep("pr-11"), dep("pr-11"), dep("pr-13"), dep("master")],
  });
  const states = { 10: "open", 11: "closed", 12: "unknown", 13: "closed" };
  const r = await leakReport({ fetchImpl: f.fetchImpl, token: "t", accountId: "acc", prState: async (n) => states[n] });
  assert.deepEqual(r.leaks.map((l) => `${l.kind} ${l.name} ${l.state}`).sort(), [
    "D1 database leeroy-board-db-pr-12 unknown", "Pages preview branch pr-11 closed", "Pages preview branch pr-13 closed", "Worker leeroy-brain-pr-11 closed",
  ]);
  assert.equal(r.checked, 6);
  assert.ok(f.state.calls.every((c) => c.startsWith("GET ")), "read-only: no write call of any kind");
});

test("workflow wiring: the teardown job uses the tool with no || echo, and a teardown run is in its own group that never cancels", () => {
  const wf = readFileSync(new URL("../../.github/workflows/pr-preview-cloudflare.yml", import.meta.url), "utf8");
  const at = wf.indexOf("  teardown-pr-preview:");
  const job = wf.slice(at, wf.indexOf("      - name: Update Sticky PR Comment to Confirm Teardown"));
  assert.ok(job.includes("node tools/preview-cleanup.mjs teardown"), "the job runs the tool");
  assert.equal(/\|\|\s*echo/.test(job), false, "no delete ends in || echo");
  assert.equal(/wrangler (delete|d1 delete)/.test(job), false, "no unverified wrangler delete");
  const head = wf.slice(0, wf.indexOf("permissions:"));
  assert.ok(head.includes("'teardown'") && head.includes("'spinup'"), "teardown and spin-up runs are in different concurrency groups");
  const cancel = head.slice(head.indexOf("cancel-in-progress:"));
  assert.ok(cancel.slice(0, cancel.indexOf("\n")).includes("github.event.action == 'closed'"), "a closed event never cancels the run before it");
  assert.ok(head.includes("closed") && head.includes("ci-full"), "teardown events are closed and unlabeled ci-full");
});

test("workflow wiring: the leak report is scheduled, read-only and deletes nothing", () => {
  const wf = readFileSync(new URL("../../.github/workflows/preview-leak-report.yml", import.meta.url), "utf8");
  assert.ok(/schedule:\s*\n\s*- cron:/.test(wf), "a daily schedule");
  assert.ok(wf.includes("node tools/preview-cleanup.mjs leaks"));
  assert.equal(/teardown|wrangler|DELETE|delete/.test(wf.replace(/#.*$/gm, "")), false, "no delete anywhere in the workflow code");
  assert.ok(/permissions:\s*\n\s*contents: read/.test(wf));
});

test("a canonical pull request number only: no leading zero, no sign, no space, no zero, at most 8 digits", () => {
  for (const bad of ["0451", "00", "0", "007", "+5", " 5", "5 ", "5\n", "1e3", "0x10", "4.5", "100000000"]) assert.throws(() => NAMES(bad), /not a pull request number/, JSON.stringify(bad));
  assert.equal(NAMES("99999999").branch, "pr-99999999");
  assert.equal(NAMES(451).worker, "leeroy-brain-pr-451");
});

test("teardown counts what it actually found and deleted", async () => {
  const f = fakeCf({ workers: ["leeroy-brain-pr-42"], dbs: ["leeroy-board-db-pr-42"], deployments: [dep("pr-42"), dep("pr-42")] });
  assert.equal((await run({ fetchImpl: f.fetchImpl })).found, 4);
  const empty = fakeCf({});
  const r = await run({ fetchImpl: empty.fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.found, 0);
});

test("resultFor: the manual route never says verified when nothing was found to delete (a wrong number looks the same as a finished one)", () => {
  const none = { ok: true, found: 0, lines: [], remaining: [], errors: [] };
  const some = { ok: true, found: 3, lines: [], remaining: [], errors: [] };
  const failed = { ok: false, found: 1, lines: [], remaining: ["Worker x"], errors: [] };
  const a = resultFor(none, { manual: true });
  assert.equal(a.exit, 1);
  assert.match(a.text, /NOT VERIFIED/);
  assert.doesNotMatch(a.text, /torn down and verified/);
  assert.equal(resultFor(some, { manual: true }).exit, 0);
  assert.match(resultFor(some, { manual: true }).text, /torn down and verified/);
  assert.equal(resultFor(none, { manual: false }).exit, 0, "the closed event keeps its old meaning: nothing to do is fine");
  assert.equal(resultFor(failed, { manual: true }).exit, 1);
  assert.match(resultFor(failed, { manual: true }).text, /FAILED/);
});

test("a listing whose answer has no result array is an error, never an empty list (so never 'verified')", async () => {
  const answer = (body) => async () => ({ status: 200, ok: true, json: async () => body });
  for (const body of [{ success: true }, { success: true, result: null }, { success: true, result: {} }, { success: true, result: "x" }]) {
    await assert.rejects(() => listAll(answer(body), "t", "/accounts/acc/d1/database"), /result/, JSON.stringify(body));
    await assert.rejects(() => listWorkers(answer(body), "t", "acc"), /result/, JSON.stringify(body));
  }
  await assert.rejects(() => listAll(answer({ success: false, result: [] }), "t", "/x"), CfError);
  assert.deepEqual(await listWorkers(answer({ success: true, result: [] }), "t", "acc"), []);
  // and a teardown run whose verification listing has no result is not ok
  const f = fakeCf({});
  const bare = async (url, o = {}) => (o.method || "GET") === "GET" && /workers\/scripts$/.test(url) ? { status: 200, ok: true, json: async () => ({ success: true }) } : f.fetchImpl(url, o);
  const r = await run({ fetchImpl: bare });
  assert.equal(r.ok, false);
  assert.ok(r.remaining.some((x) => /could not verify/.test(x)));
});
