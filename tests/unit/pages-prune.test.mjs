// tools/pages-prune.mjs deletes the old Cloudflare Pages deployments (they still serve the member data files) and purges the stale data files from the edge cache.
// A mistake here is a production deletion with no undo, so this file pins the safety properties, all against a stubbed fetch (nothing here touches the network):
//   - the keep set: the production deployment is kept, everything else is deleted, and a production id that cannot be determined deletes NOTHING and fails (exit 1);
//   - pagination ends, and a list that cannot be read to the end deletes nothing;
//   - backoff honors Retry-After and is capped;
//   - a dry run (the default, also for any unexpected DRY_RUN value) makes no DELETE and no POST;
//   - a real run issues DELETE ...?force=true for exactly the non-kept ids, at most 3 at a time, and stops on an over-cap count;
//   - the token, the account id and every deployment id never appear in an output line, even when fetch throws or a response body holds them;
//   - the purge step skips with one plain line and exit 0 when the token lacks permission, and only ever asks for leeroy.party URLs from the pages-bundle private list;
//   - the workflow is workflow_dispatch only with dry_run defaulting to true, and reads its inputs through env, not through the script text.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { PRIVATE_DATA_FILES, STRIPPED_FILES } from "../../tools/pages-bundle.mjs";
import {
  FailClosed, parseDeployments, productionIdsFromProject, pickKeepSet, nextPage, backoffMs, isDryRun, purgeTargets, listAllDeployments,
  prune, purge, main, MAX_PAGES, DELETE_CONCURRENCY, PURGE_SKIP_LINE, BACKOFF_CAP_MS,
} from "../../tools/pages-prune.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

const TOKEN = "tok_Zq81-FICTIONAL-token-value";
const ACCT = "0123456789abcdef0123456789abcdef";
const ZONE = "fedcba9876543210fedcba9876543210";
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const created = (n) => new Date(Date.UTC(2026, 10, 15) - n * 86400000).toISOString();
const dep = (n, environment = "preview", extra = {}) => ({ id: uid(n), environment, created_on: created(n), ...extra });
// newest first, like the API: 1..N, production deployments at 1, 8 and 15, the rest previews
function fixture(total = 70, productionAt = [1, 8, 15]) {
  return Array.from({ length: total }, (_, i) => dep(i + 1, productionAt.includes(i + 1) ? "production" : "preview"));
}
const env = (extra = {}) => ({ CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCT, PAGES_PROJECT_NAME: "leeroy-board", DRY_RUN: "false", ...extra });
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

// A fake of the four endpoints the tool uses. Every call is recorded; nothing leaves the process.
function fake(o = {}) {
  const deployments = o.deployments || fixture();
  const calls = [];
  const state = { inflight: 0, maxInflight: 0 };
  const projectBody = o.project !== undefined ? o.project : { success: true, result: { canonical_deployment: deployments.find((d) => d.id === uid(o.canonical ?? 1)) ?? null, latest_deployment: o.latest ? deployments.find((d) => d.id === uid(o.latest)) : null } };
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || "GET";
    const p = u.pathname.replace(/^\/client\/v4/, "");
    calls.push({ method, path: p, search: u.search, body: init.body, auth: init.headers?.Authorization });
    if (o.throwOn && o.throwOn(method, p)) throw new Error(`socket hang up for ${url} with ${init.headers?.Authorization}`);
    if (o.respond) { const r = o.respond(method, p, u, calls.length); if (r) return r; }
    if (method === "GET" && /^\/accounts\/[^/]+\/pages\/projects\/[^/]+$/.test(p)) return json(o.projectStatus || 200, projectBody);
    if (method === "GET" && /\/deployments$/.test(p)) {
      const page = Number(u.searchParams.get("page")), asked = Number(u.searchParams.get("per_page"));
      const per = o.clamp || asked;
      const slice = deployments.slice((page - 1) * per, page * per);
      const body = { success: true, result: slice };
      if (o.resultInfo !== false) body.result_info = { page, per_page: per, count: slice.length, total_count: deployments.length, total_pages: Math.ceil(deployments.length / per) };
      return json(200, body);
    }
    if (method === "DELETE") {
      state.inflight++; state.maxInflight = Math.max(state.maxInflight, state.inflight);
      await new Promise((r) => setImmediate(r));
      state.inflight--;
      return json(o.deleteStatus ? o.deleteStatus(p) : 200, { success: true, result: { id: "echo", note: TOKEN } });
    }
    return json(404, { success: false });
  };
  return { fetch, calls, state, deployments, deletes: () => calls.filter((c) => c.method === "DELETE"), writes: () => calls.filter((c) => c.method !== "GET") };
}
const harness = (o = {}) => {
  const f = fake(o);
  const out = [], sleeps = [];
  const opts = { env: env(o.env), fetch: f.fetch, log: (l) => out.push(l), sleep: async (ms) => { sleeps.push(ms); }, rand: () => 0.5 };
  return { f, out, sleeps, opts };
};
const idOf = (call) => call.path.split("/").pop();

// ---- keep set ----

test("pickKeepSet keeps the production deployment and deletes every other one", () => {
  const list = parseDeployments({ success: true, result: fixture() }).items;
  const plan = pickKeepSet(list, productionIdsFromProject({ success: true, result: { canonical_deployment: dep(1, "production"), latest_deployment: dep(2) } }));
  assert.deepEqual([...plan.keep], [uid(1)], "only the production deployment is kept (a preview latest_deployment is not)");
  assert.equal(plan.remove.length, 69);
  assert.ok(!plan.remove.includes(uid(1)), "the production deployment is never a delete candidate");
  assert.ok(plan.remove.includes(uid(2)) && plan.remove.includes(uid(8)) && plan.remove.includes(uid(70)));
  assert.deepEqual(plan.counts, { total: 70, keep: 1, remove: 69, byEnvironment: { production: { total: 3, remove: 2 }, preview: { total: 67, remove: 67 } } });
});

test("pickKeepSet also keeps a production latest_deployment and the newest production entry (a rollback or a deploy not yet canonical)", () => {
  const list = parseDeployments({ success: true, result: fixture() }).items;
  const production = productionIdsFromProject({ success: true, result: { canonical_deployment: dep(8, "production"), latest_deployment: dep(15, "production") } });
  const plan = pickKeepSet(list, production);
  assert.deepEqual([...plan.keep].sort(), [uid(1), uid(15), uid(8)].sort(), "canonical 8, production latest 15, newest production 1");
  assert.equal(plan.remove.length, 67);
});

test("pickKeepSet fails closed when the production deployment is unknown, absent from the list, or not a production entry", () => {
  const list = parseDeployments({ success: true, result: fixture() }).items;
  assert.throws(() => pickKeepSet(list, null), FailClosed);
  assert.throws(() => pickKeepSet(list, { canonicalId: "", ids: [] }), FailClosed);
  assert.throws(() => pickKeepSet(list, { canonicalId: uid(999), ids: [uid(999)] }), FailClosed, "an id that is not in the list");
  assert.throws(() => pickKeepSet(list, { canonicalId: uid(2), ids: [uid(2)] }), FailClosed, "listed as a preview, so it cannot be the production deployment");
  assert.throws(() => pickKeepSet([], { canonicalId: uid(1), ids: [uid(1)] }), FailClosed, "an empty list proves nothing");
});

test("productionIdsFromProject fails closed unless canonical_deployment is a production deployment with a usable id", () => {
  for (const [name, body] of Object.entries({
    "no result": { success: true },
    "success false": { success: false, result: { canonical_deployment: dep(1, "production") } },
    "canonical null": { success: true, result: { canonical_deployment: null, latest_deployment: dep(1, "production") } },
    "canonical without id": { success: true, result: { canonical_deployment: { environment: "production" } } },
    "canonical id with path characters": { success: true, result: { canonical_deployment: { id: "../x", environment: "production" } } },
    "canonical is a preview": { success: true, result: { canonical_deployment: dep(1, "preview") } },
    "not an object": null,
  })) assert.throws(() => productionIdsFromProject(body), FailClosed, name);
  assert.deepEqual(productionIdsFromProject({ success: true, result: { canonical_deployment: dep(1, "production") } }), { canonicalId: uid(1), ids: [uid(1)] });
});

test("parseDeployments reads a list, counts entries without a usable id, and refuses anything that is not a successful list", () => {
  const r = parseDeployments({ success: true, result: [dep(1, "production"), { environment: "preview" }, null, { id: "x" }, dep(2)] });
  assert.deepEqual(r.items.map((d) => d.id), [uid(1), uid(2)]);
  assert.equal(r.malformed, 3);
  for (const bad of [null, {}, { success: false, result: [] }, { success: true, result: {} }, "x"]) assert.throws(() => parseDeployments(bad), FailClosed);
});

// ---- pagination ----

test("nextPage: short page, empty page, result_info totals", () => {
  assert.equal(nextPage({ page: 1, perPage: 25, count: 25, resultInfo: undefined }), 2);
  assert.equal(nextPage({ page: 3, perPage: 25, count: 10, resultInfo: undefined }), null, "a short page is the last one");
  assert.equal(nextPage({ page: 4, perPage: 25, count: 0, resultInfo: { total_pages: 99 } }), null, "an empty page always ends the list");
  assert.equal(nextPage({ page: 1, perPage: 25, count: 25, resultInfo: { total_pages: 3 } }), 2);
  assert.equal(nextPage({ page: 3, perPage: 25, count: 25, resultInfo: { total_pages: 3 } }), null);
  assert.equal(nextPage({ page: 1, perPage: 25, count: 10, resultInfo: { per_page: 10, total_count: 30 } }), 2, "the server clamped per_page: its own numbers win over the short-page rule");
  assert.equal(nextPage({ page: 3, perPage: 25, count: 10, resultInfo: { per_page: 10, total_count: 30 } }), null);
});

test("listAllDeployments reads every page and stops (with and without result_info, and when the server clamps per_page)", async () => {
  for (const o of [{}, { resultInfo: false }, { clamp: 10 }, { clamp: 10, resultInfo: false, deployments: fixture(70) }]) {
    const f = fake({ ...o, deployments: fixture(70) });
    const got = await listAllDeployments({ fetch: f.fetch, token: TOKEN, account: ACCT, project: "leeroy-board", sleep: async () => {}, rand: () => 0.5, maxRetries: 0 }).catch((e) => e);
    if (o.clamp && o.resultInfo === false) { assert.ok(got.items.length < 70, "without result_info a clamped server ends early: a partial list can only shrink the delete set"); continue; }
    assert.equal(got.items.length, 70, JSON.stringify(o));
    assert.equal(f.calls.length, Math.ceil(70 / (o.clamp || 25)), "no request past the last page: " + JSON.stringify(o));
  }
});

test("listAllDeployments fails closed on a repeated page and on a list that never ends", async () => {
  const ctx = (f) => ({ fetch: f.fetch, token: TOKEN, account: ACCT, project: "p", sleep: async () => {}, rand: () => 0.5, maxRetries: 0 });
  const same = fake({ respond: (m, p) => (/\/deployments$/.test(p) ? json(200, { success: true, result: fixture(25) }) : null) });
  await assert.rejects(listAllDeployments(ctx(same)), /pagination did not advance/);
  let n = 0;
  const endless = fake({ respond: (m, p) => (/\/deployments$/.test(p) ? json(200, { success: true, result: Array.from({ length: 25 }, () => dep(++n)) }) : null) });
  await assert.rejects(listAllDeployments(ctx(endless)), new RegExp(`${MAX_PAGES} pages`));
  assert.equal(endless.calls.length, MAX_PAGES);
});

// ---- backoff ----

test("backoffMs honors Retry-After (seconds and HTTP date), adds only bounded jitter, and is capped", () => {
  assert.equal(backoffMs(0, "3", () => 0), 3000);
  assert.ok(backoffMs(0, "3", () => 0.999) >= 3000 && backoffMs(0, "3", () => 0.999) < 3250);
  assert.equal(backoffMs(0, "999999", () => 0.5), BACKOFF_CAP_MS, "capped");
  assert.equal(backoffMs(0, "0", () => 0), 0);
  const at = new Date(Date.UTC(2026, 10, 15, 12, 0, 10)).toUTCString();
  assert.equal(backoffMs(0, at, () => 0, { now: () => Date.UTC(2026, 10, 15, 12, 0, 0) }), 10000);
  for (const junk of ["", "soon", null, undefined]) { const w = backoffMs(2, junk, () => 0.5); assert.ok(w > 0 && w <= BACKOFF_CAP_MS, String(junk)); }
});

test("backoffMs grows with the attempt number without Retry-After, with jitter, and never passes the cap", () => {
  const lo = (a) => backoffMs(a, null, () => 0), hi = (a) => backoffMs(a, null, () => 1);
  assert.ok(lo(1) > lo(0) && lo(2) > lo(1));
  assert.ok(hi(0) >= lo(0) && hi(3) > lo(3));
  assert.equal(backoffMs(40, null, () => 1), BACKOFF_CAP_MS);
});

// ---- prune: dry run ----

test("a dry run lists and counts only: no DELETE, no POST, counts in the output, no deployment id anywhere", async () => {
  const h = harness({ env: { DRY_RUN: "true" } });
  assert.equal(await prune(h.opts), 0);
  assert.deepEqual(h.f.writes(), [], "a dry run makes no call other than GET");
  assert.ok(h.f.calls.length >= 4 && h.f.calls.every((c) => c.method === "GET"));
  const text = h.out.join("\n");
  assert.match(text, /DRY RUN/);
  assert.match(text, /total 70, keep 1, would delete 69; by environment: production 3 \(delete 2\), preview 67 \(delete 67\)/);
  assert.ok(!text.includes("0000-4000"), "no deployment id is printed");
});

test("anything but the exact string false is a dry run (unset, empty, True, 0, no)", async () => {
  for (const v of [undefined, "", "true", "True", "0", "no", " TRUE "]) {
    assert.equal(isDryRun(v), true, String(v));
    const h = harness({ env: { DRY_RUN: v } });
    if (v === undefined) delete h.opts.env.DRY_RUN;
    await prune(h.opts);
    assert.deepEqual(h.f.writes(), [], `DRY_RUN=${v}`);
  }
  assert.equal(isDryRun("false"), false);
});

test("only the exact string false turns the dry run off: padded, re-cased, empty, numeric and non-string values all stay dry runs", async () => {
  const variants = [" false", "false ", " false ", "False", "FALSE", "fAlSe", "false\n", "false\r\n", "\tfalse", "\nfalse", "", " ", "0", "no", "off", "true", undefined, null, false, 0, "false;", "'false'", '"false"', "fals", "falsey"];
  for (const v of variants) {
    assert.equal(isDryRun(v), true, `isDryRun(${JSON.stringify(v)}) must be a dry run`);
    const h = harness({ env: { DRY_RUN: v } });
    if (v === undefined) delete h.opts.env.DRY_RUN;
    assert.equal(await prune(h.opts), 0);
    assert.deepEqual(h.f.writes(), [], `DRY_RUN=${JSON.stringify(v)} made a write call`);
    const p = zoneFake({ env: { DRY_RUN: v } });
    if (v === undefined) delete p.opts.env.DRY_RUN;
    await purge(p.opts);
    assert.equal(p.calls.length, 0, `DRY_RUN=${JSON.stringify(v)}: the purge step made a call`);
  }
  assert.equal(isDryRun("false"), false);
  assert.doesNotMatch(isDryRun.toString(), /trim|toLowerCase|toUpperCase|Boolean|String\(/, "isDryRun does not normalize its input");
  const dryLine = read("tools/pages-prune.mjs").split("\n").find((l) => /DRY_RUN/.test(l) && /isDryRun\(/.test(l) && /ctx|dryRun:/.test(l));
  assert.match(dryLine, /isDryRun\(env\.DRY_RUN\)/, "the raw environment value goes to isDryRun, not a cleaned copy");
  const real = harness({ env: { DRY_RUN: "false" } });
  assert.equal(await prune(real.opts), 0);
  assert.equal(real.f.deletes().length, 69, "exactly false deletes");
  const realPurge = zoneFake({ env: { DRY_RUN: "false" } });
  await purge(realPurge.opts);
  assert.equal(realPurge.calls.filter((c) => c.method === "POST").length, 1, "exactly false purges");
});

// ---- prune: real run ----

test("a real run sends DELETE with force=true for exactly the non-kept ids, at most 3 at a time, and prints progress every 25", async () => {
  const h = harness();
  assert.equal(await prune(h.opts), 0);
  const dels = h.f.deletes();
  assert.equal(dels.length, 69);
  assert.ok(dels.every((c) => c.search === "?force=true" && c.path.startsWith(`/accounts/${ACCT}/pages/projects/leeroy-board/deployments/`)));
  const ids = new Set(dels.map(idOf));
  assert.equal(ids.size, 69, "each id once");
  assert.ok(!ids.has(uid(1)), "production is never deleted");
  assert.deepEqual([...ids].sort(), h.f.deployments.map((d) => d.id).filter((id) => id !== uid(1)).sort());
  assert.ok(h.f.state.maxInflight >= 2 && h.f.state.maxInflight <= DELETE_CONCURRENCY, `max in flight ${h.f.state.maxInflight}`);
  assert.equal(h.out.filter((l) => /progress \d+\/69/.test(l)).length, 2, "progress at 25 and 50");
  assert.match(h.out.join("\n"), /finished\. deleted 69, already gone 0, failed 0, not attempted 0/);
});

test("a real run with a rolled-back production keeps the canonical, the production latest and the newest production entry", async () => {
  const h = harness({ canonical: 8, latest: 15 });
  assert.equal(await prune(h.opts), 0);
  const ids = new Set(h.f.deletes().map(idOf));
  for (const keep of [1, 8, 15]) assert.ok(!ids.has(uid(keep)), `kept ${keep}`);
  assert.equal(ids.size, 67);
});

test("an over-cap count deletes nothing and exits 1; an explicit larger cap allows it", async () => {
  const h = harness({ env: { MAX_DELETE: "50" } });
  assert.equal(await prune(h.opts), 1);
  assert.equal(h.f.deletes().length, 0);
  assert.match(h.out.join("\n"), /STOPPED: 69 deployments qualify, which is more than the cap of 50/);
  const ok = harness({ env: { MAX_DELETE: "69" } });
  assert.equal(await prune(ok.opts), 0);
  assert.equal(ok.f.deletes().length, 69);
  for (const bad of ["abc", "-1", "1.5"]) { const b = harness({ env: { MAX_DELETE: bad } }); assert.equal(await prune(b.opts), 1, bad); assert.deepEqual(b.f.writes(), []); }
  const dry = harness({ env: { DRY_RUN: "true", MAX_DELETE: "5" } });
  assert.equal(await prune(dry.opts), 1, "the cap also fails a dry run, so the operator sees it before the real run");
});

// ---- prune: fail closed ----

test("fail closed: a production deployment that cannot be determined deletes nothing and exits 1", async () => {
  const cases = {
    "project has no canonical_deployment": { project: { success: true, result: { latest_deployment: dep(1, "production") } } },
    "canonical_deployment is null": { project: { success: true, result: { canonical_deployment: null } } },
    "canonical is not in the list": { project: { success: true, result: { canonical_deployment: dep(999, "production") } } },
    "canonical is a preview": { project: { success: true, result: { canonical_deployment: dep(2, "preview") } } },
    "project call is 403": { projectStatus: 403, project: { success: false } },
    "project call is 404 (wrong account or project)": { projectStatus: 404, project: { success: false } },
    "no production entry at all": { deployments: fixture(30, []), project: { success: true, result: { canonical_deployment: dep(1, "production") } } },
  };
  for (const [name, o] of Object.entries(cases)) {
    const h = harness(o);
    assert.equal(await prune(h.opts), 1, name);
    assert.deepEqual(h.f.writes(), [], `${name}: nothing deleted`);
    assert.match(h.out.join("\n"), /FAILED CLOSED/, name);
  }
});

test("fail closed: a list that cannot be read (5xx after retries, 403, bad body) deletes nothing", async () => {
  for (const [name, respond] of Object.entries({
    "every list call is 503": (m, p) => (/\/deployments$/.test(p) ? json(503, { success: false }) : null),
    "list is 403": (m, p) => (/\/deployments$/.test(p) ? json(403, { success: false }) : null),
    "list body is not JSON": (m, p) => (/\/deployments$/.test(p) ? new Response("<html>", { status: 200 }) : null),
    "the second page fails": (m, p, u) => (/\/deployments$/.test(p) && u.searchParams.get("page") === "2" ? json(500, {}) : null),
  })) {
    const h = harness({ respond });
    assert.equal(await prune(h.opts), 1, name);
    assert.deepEqual(h.f.writes(), [], name);
  }
});

test("a missing token, account or project is a config error: exit 1, no call at all", async () => {
  for (const k of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "PAGES_PROJECT_NAME"]) {
    const h = harness({ env: { [k]: "" } });
    assert.equal(await prune(h.opts), 1, k);
    assert.equal(h.f.calls.length, 0, k);
  }
});

test("retries: 429 honors Retry-After, 5xx and network errors back off, and a delete that never succeeds is counted as failed (exit 1)", async () => {
  let first = true;
  const h = harness({ deployments: fixture(5, [1]), respond: (m, p) => { if (m === "GET" && /\/deployments$/.test(p) && first) { first = false; return json(429, {}, { "retry-after": "7" }); } return null; } });
  assert.equal(await prune(h.opts), 0);
  assert.ok(h.sleeps.some((ms) => ms >= 7000 && ms < 7250), `slept ${h.sleeps}`);

  const flaky = harness({ deployments: fixture(5, [1]), throwOn: (m, p) => m === "DELETE" && p.endsWith(uid(3)) && flaky.f.calls.filter((c) => c.path.endsWith(uid(3))).length < 3 });
  assert.equal(await prune(flaky.opts), 0, "a network error that clears is retried");
  assert.equal(flaky.f.deletes().filter((c) => idOf(c) === uid(3)).length, 3);

  const dead = harness({ deployments: fixture(5, [1]), deleteStatus: (p) => (p.endsWith(uid(3)) ? 500 : 200) });
  assert.equal(await prune(dead.opts), 1);
  assert.equal(dead.f.deletes().filter((c) => idOf(c) === uid(3)).length, 6, "1 try + 5 retries, then given up");
  assert.match(dead.out.join("\n"), /deleted 3, already gone 0, failed 1/);

  const gone = harness({ deployments: fixture(5, [1]), deleteStatus: (p) => (p.endsWith(uid(3)) ? 404 : 200) });
  assert.equal(await prune(gone.opts), 0, "404 on a delete is already gone, not a failure");
  assert.match(gone.out.join("\n"), /already gone 1/);
});

test("a 403 on delete stops the run after the calls already in flight and exits 1", async () => {
  const h = harness({ deleteStatus: () => 403 });
  assert.equal(await prune(h.opts), 1);
  assert.ok(h.f.deletes().length <= DELETE_CONCURRENCY, `${h.f.deletes().length} delete calls before the stop`);
  assert.match(h.out.join("\n"), /token is not allowed to delete Pages deployments/);
});

// ---- no secret in any output ----

test("the token, the account id and every deployment id never appear in an output line, even when fetch throws or a body holds them", async () => {
  const seen = [];
  for (const o of [
    { env: { DRY_RUN: "true" } },
    {},
    { throwOn: (m, p) => m === "GET" && /\/deployments$/.test(p) },
    { throwOn: (m) => m === "DELETE", deployments: fixture(6, [1]) },
    { deleteStatus: () => 403 },
    { projectStatus: 403, project: { success: false, errors: [{ message: `bad token ${TOKEN}` }] } },
    { env: { CLOUDFLARE_API_TOKEN: `  "${TOKEN}"\r\n` } },
  ]) {
    const h = harness(o);
    await prune(h.opts);
    seen.push(...h.out);
  }
  assert.ok(seen.length > 10);
  for (const line of seen) {
    assert.ok(!line.includes(TOKEN), `token in: ${line}`);
    assert.ok(!line.includes("FICTIONAL"), `token part in: ${line}`);
    assert.ok(!line.includes(ACCT), `account id in: ${line}`);
    assert.ok(!/00000000-0000-4000/.test(line), `deployment id in: ${line}`);
  }
});

test("the logger masks the token even if a message were to carry it", async () => {
  const lines = [];
  const h = harness({ env: { PAGES_PROJECT_NAME: `proj-${TOKEN}` } });
  h.opts.log = (l) => lines.push(l);
  await prune({ ...h.opts, env: { ...h.opts.env, DRY_RUN: "true" } });
  assert.ok(lines.length > 0 && lines.every((l) => !l.includes(TOKEN)));
  assert.ok(lines.some((l) => l.includes("***")), "the project name carried the token and was masked");
});

// ---- purge ----

test("purgeTargets: the private files from pages-bundle on leeroy.party (and the pages.dev twins, counted only)", () => {
  const t = purgeTargets();
  const paths = [...PRIVATE_DATA_FILES, ...Object.keys(STRIPPED_FILES)];
  assert.deepEqual(t.zone, paths.map((p) => `https://leeroy.party/${p}`));
  assert.deepEqual(t.pagesDev, paths.map((p) => `https://leeroy-board.pages.dev/${p}`));
  for (const n of ["party", "decide", "tonight", "guided-atlas", "client", "signups"]) assert.ok(t.zone.includes(`https://leeroy.party/data/${n}.json`), n);
  assert.ok(t.zone.includes("https://leeroy.party/data/atlas/links.json"), "the reduced links file: the cached copy is the unreduced one");
  assert.ok(t.zone.every((u) => !/[*?]/.test(u)), "explicit URLs only: wildcards need Enterprise");
});

function zoneFake(o = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url), method = init.method || "GET", p = u.pathname.replace(/^\/client\/v4/, "");
    calls.push({ method, path: p, search: u.search, body: init.body });
    if (method === "GET" && p === "/zones") return o.zones ? o.zones() : json(200, { success: true, result: [{ id: ZONE, name: "leeroy.party" }] });
    if (method === "POST" && p === `/zones/${ZONE}/purge_cache`) return o.purge ? o.purge() : json(200, { success: true, result: { id: ZONE } });
    return json(404, { success: false });
  };
  const out = [];
  return { calls, out, opts: { env: env(o.env), fetch, log: (l) => out.push(l), sleep: async () => {}, rand: () => 0.5 } };
}

test("purge: a dry run makes no call at all and prints counts", async () => {
  const z = zoneFake({ env: { DRY_RUN: "true" } });
  assert.equal(await purge(z.opts), 0);
  assert.equal(z.calls.length, 0);
  const text = z.out.join("\n");
  assert.match(text, /DRY RUN, would purge 7 URLs on leeroy\.party/);
  assert.match(text, /7 on leeroy-board\.pages\.dev cannot be purged \(pages\.dev is not a zone of this account\)/);
  assert.ok(!text.includes(ZONE) && !text.includes(TOKEN));
});

test("purge: a real run looks the zone up and posts explicit leeroy.party URLs only", async () => {
  const z = zoneFake();
  assert.equal(await purge(z.opts), 0);
  assert.deepEqual(z.calls.map((c) => `${c.method} ${c.path}${c.search}`), ["GET /zones?name=leeroy.party", `POST /zones/${ZONE}/purge_cache`]);
  const body = JSON.parse(z.calls[1].body);
  assert.deepEqual(Object.keys(body), ["files"]);
  assert.deepEqual(body.files, purgeTargets().zone);
  assert.ok(body.files.every((u) => u.startsWith("https://leeroy.party/data/")));
  assert.match(z.out.join("\n"), /purged 7 URLs on leeroy\.party/);
  assert.ok(!z.out.join("\n").includes(ZONE), "the zone id is not printed");
});

test("purge: a token without permission prints the one skip line and exits 0 (zone lookup 403, purge 403, error code 9109, 401)", async () => {
  const denied = [
    { zones: () => json(403, { success: false, errors: [{ code: 9109 }] }) },
    { purge: () => json(403, { success: false, errors: [{ code: 9109, message: "Unauthorized to access requested resource" }] }) },
    { purge: () => json(401, { success: false }) },
    { purge: () => json(400, { success: false, errors: [{ code: 9109 }] }) },
    { zones: () => json(400, { success: false, errors: [{ code: 10000 }] }) },
  ];
  for (const o of denied) {
    const z = zoneFake(o);
    assert.equal(await purge(z.opts), 0);
    assert.ok(z.out.includes(PURGE_SKIP_LINE), z.out.join(" | "));
    assert.equal(z.out.filter((l) => l.startsWith("cache purge skipped")).length, 1, "exactly one skip line");
    assert.ok(z.out.every((l) => !l.includes(TOKEN)));
  }
  assert.equal(PURGE_SKIP_LINE, "cache purge skipped: token lacks Cache Purge permission");
});

test("purge: other failures (zone not visible, 5xx, network error, no token) are a warning and exit 0, never a failed job", async () => {
  const cases = [
    zoneFake({ zones: () => json(200, { success: true, result: [] }) }),
    zoneFake({ zones: () => json(200, { success: true, result: [{ id: ZONE, name: "other.example" }] }) }),
    zoneFake({ purge: () => json(500, { success: false }) }),
    zoneFake({ env: { CLOUDFLARE_API_TOKEN: "" } }),
  ];
  for (const z of cases) { assert.equal(await purge(z.opts), 0); assert.ok(z.out.some((l) => /cache purge skipped/.test(l))); }
  const boom = zoneFake();
  boom.opts.fetch = async () => { throw new Error(`down ${TOKEN}`); };
  assert.equal(await purge(boom.opts), 0);
  assert.ok(boom.out.every((l) => !l.includes(TOKEN)));
});

// ---- CLI ----

test("the CLI: an unknown step exits 2, and prune with no credentials exits 1 without any network", () => {
  assert.equal(spawnSync(process.execPath, ["tools/pages-prune.mjs"], { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH } }).status, 2);
  const r = spawnSync(process.execPath, ["tools/pages-prune.mjs", "prune"], { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH, DRY_RUN: "false" } });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /is not set\. Nothing was changed\./);
  assert.equal(r.stderr, "");
  assert.equal(spawnSync(process.execPath, ["tools/pages-prune.mjs", "purge"], { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH, DRY_RUN: "false" } }).status, 0, "purge with no token skips");
  const lines = [];
  return main(["nope"], { log: (l) => lines.push(l) }).then((code) => { assert.equal(code, 2); assert.match(lines[0], /usage/); });
});

// ---- the workflow ----

const wfText = read(".github/workflows/pages-prune.yml");
const wf = parseYaml(wfText);

test("the workflow is workflow_dispatch only, with dry_run defaulting to true", () => {
  const on = wf.on ?? wf[true];
  assert.deepEqual(Object.keys(on), ["workflow_dispatch"], "no push, schedule, pull_request or any other trigger");
  const inputs = on.workflow_dispatch.inputs;
  assert.equal(inputs.dry_run.type, "boolean");
  assert.strictEqual(inputs.dry_run.default, true);
  assert.equal(inputs.purge_cache.type, "boolean");
  assert.strictEqual(inputs.purge_cache.default, true);
  assert.equal(inputs.max_delete.default, 2000);
  assert.doesNotMatch(wfText.replace(/#.*$/gm, ""), /^\s*(push|schedule|pull_request|pull_request_target|workflow_run|release|issues|repository_dispatch|workflow_call)\s*:/m);
});

test("the workflow has minimal permissions, pins actions by SHA, runs only on master, and reads its inputs and secrets through env", () => {
  assert.deepEqual(wf.permissions, { contents: "read" });
  const job = wf.jobs.prune;
  assert.equal(job.if, "github.ref == 'refs/heads/master'");
  assert.equal(job.env.PAGES_PROJECT_NAME, "leeroy-board");
  assert.equal(parseYaml(read(".github/workflows/deploy-cloudflare.yml")).jobs["deploy-production"].env.PAGES_PROJECT_NAME, "leeroy-board", "the same project the deploy publishes to");
  for (const s of job.steps.filter((x) => x.uses)) assert.match(s.uses, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `${s.uses} is pinned by SHA`);
  assert.equal(job.steps.find((s) => /checkout/.test(s.uses || "")).uses, "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683", "the same checkout pin as the other workflows");
  const runs = job.steps.filter((s) => s.run);
  assert.deepEqual(runs.map((s) => s.run), ["node tools/pages-prune.mjs prune", "node tools/pages-prune.mjs purge"], "step 1 prunes, step 2 purges");
  for (const s of runs) {
    assert.doesNotMatch(s.run, /\$\{\{|secrets\.|echo/, "no expression, no secret and no echo inside a script");
    assert.equal(s.env.CLOUDFLARE_API_TOKEN, "${{ secrets.CLOUDFLARE_API_TOKEN }}");
    assert.equal(s.env.DRY_RUN, "${{ inputs.dry_run }}");
  }
  assert.equal(runs[0].env.CLOUDFLARE_ACCOUNT_ID, "${{ secrets.CLOUDFLARE_ACCOUNT_ID }}");
  assert.equal(runs[0].env.MAX_DELETE, "${{ inputs.max_delete }}");
  assert.equal(runs[1].if, "${{ !cancelled() && inputs.purge_cache }}");
  const names = [...wfText.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(names)].sort(), ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"]);
});
