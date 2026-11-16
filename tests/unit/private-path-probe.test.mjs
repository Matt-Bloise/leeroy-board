// The production check that no private member data path answers 2xx on a site hostname (tests/helpers/private-path-probe.mjs, run by tests/browser/prod-probe.mjs).
// Pinned: a 2xx anywhere (bare URL, cache-busted, or a raw dot-segment / parent-segment / backslash form, either host) is a problem, and a 2xx on ANY attempt stays a problem even when a later attempt
// answers 404, 5xx or nothing (a later 404 is another edge node, not proof); 404 everywhere is clean; a 5xx or network error that never clears, with no 2xx, is a WARN, not a failure; the bare request
// carries no extra header and the cache-busted one a unique query and Cache-Control: no-cache; the raw forms reach the server exactly as written; redirects are not followed; response bodies are
// cancelled unread and never appear in the output; the probe script wires it in before any browser starts, and it is not pointed at the API host (api.leeroy.party answers 200 on purpose).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { probePrivatePaths, DEFAULT_HOSTS, RAW_VARIANTS, rawGet } from "../../tests/helpers/private-path-probe.mjs";
import { PRIVATE_DATA_FILES } from "../../pages-worker/private-paths.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const noSleep = async () => {};
const BODY = "SECRET-MEMBER-BODY";
const PER_HOST = PRIVATE_DATA_FILES.length * (2 + RAW_VARIANTS.length); // bare, cache-busted and the raw forms, per file

// A fake fetch / raw transport: `plan(info, callNo)` returns a status (number) or throws. info = { url, u, init, raw, host, kind }.
function fakes(plan) {
  const calls = [], counts = new Map();
  const answer = (info) => {
    const key = info.raw ? `${info.host}RAW${info.raw}` : `${info.u.host}${info.u.pathname}${info.u.search ? "?" : ""}`;
    const n = counts.get(key) || 0;
    counts.set(key, n + 1);
    calls.push(info);
    return plan(info, n);
  };
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    const cancelled = { v: false };
    const info = { url, u, init, raw: null, host: u.origin, cancelled };
    const status = answer(info);
    return { status, body: { cancel: async () => { cancelled.v = true; } }, text: async () => { throw new Error("the probe must never read a body"); }, json: async () => { throw new Error("the probe must never read a body"); } };
  };
  const rawImpl = async (host, target) => {
    const info = { url: host + target, u: new URL(host), init: null, raw: target, host };
    return { status: answer(info) };
  };
  return { fetchImpl, rawImpl, calls };
}
const opts = (f, more = {}) => ({ fetchImpl: f.fetchImpl, rawImpl: f.rawImpl, sleep: noSleep, ...more });

test("default hosts are the two site hostnames, never the API host; every private file is probed plain, cache-busted and in three raw spellings", async () => {
  assert.deepEqual([...DEFAULT_HOSTS], ["https://leeroy.party", "https://leeroy-board.pages.dev"]);
  const f = fakes(() => 404);
  const r = await probePrivatePaths(opts(f));
  assert.equal(r.checked, DEFAULT_HOSTS.length * PER_HOST);
  assert.equal(r.checked, 60);
  assert.equal(f.calls.length, r.checked, "one request per URL when nothing is wrong");
  assert.ok(f.calls.every((c) => !/api\.leeroy\.party/.test(c.url)));
  assert.deepEqual(RAW_VARIANTS.map(([k]) => k), ["dot-segment", "parent-segment", "backslash"]);
  const raws = f.calls.filter((c) => c.raw).map((c) => c.raw);
  for (const p of PRIVATE_DATA_FILES) for (const want of [`/${p.replace("data/", "data/./")}`, `/${p.replace("data/", "data/x/../")}`, `/${p.replace("data/", "data\\")}`]) assert.ok(raws.includes(want), `${want} is probed`);
});

test("all 404: clean, one PASS status line per request, nothing else", async () => {
  const r = await probePrivatePaths(opts(fakes(() => 404)));
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.lines.length, 60);
  for (const l of r.lines) assert.match(l, /^PASS private data path 404: https:\/\/[a-z.-]+\/\S+ \((bare|cache-busted|dot-segment|parent-segment|backslash)\)$/);
  assert.ok(!r.lines.join("\n").includes("cb="), "the cache-busting token is not printed");
});

test("a 200 on the bare URL of one path on one host is a problem that names the host, path and kind, and nothing but the status", async () => {
  const f = fakes((i) => (i.host === "https://leeroy.party" && i.u.pathname === "/data/party.json" && !i.u.search && !i.raw ? 200 : 404));
  const r = await probePrivatePaths(opts(f));
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /^private data path answered 200 on attempt 1 of 3: https:\/\/leeroy\.party\/data\/party\.json \(bare\)$/);
  assert.ok(!r.problems[0].includes(BODY));
  assert.equal(r.lines.length, 59);
  assert.equal(f.calls.filter((c) => !c.raw && c.u.pathname === "/data/party.json" && c.host === "https://leeroy.party" && !c.u.search).length, 3, "asked in every round");
  assert.equal(f.calls.length, 60 + 2, "only that URL is asked again");
});

test("a 200 on a cache-busted request, on a raw spelling, on the pages.dev host, and a 201/204, are problems", async () => {
  for (const [what, plan] of [
    ["cache-busted on leeroy.party", (i) => (i.host === "https://leeroy.party" && i.u.search.startsWith("?cb=") ? 200 : 404)],
    ["bare on pages.dev", (i) => (i.host === "https://leeroy-board.pages.dev" && !i.u.search && !i.raw ? 200 : 404)],
    ["204 bare", (i) => (i.u.pathname === "/data/signups.json" && !i.u.search && !i.raw ? 204 : 404)],
    ["dot-segment", (i) => (i.raw === "/data/./party.json" ? 200 : 404)],
    ["parent-segment", (i) => (i.raw === "/data/x/../client.json" ? 200 : 404)],
    ["backslash", (i) => (i.raw === "/data\\decide.json" ? 200 : 404)],
  ]) {
    const r = await probePrivatePaths(opts(fakes(plan)));
    assert.ok(r.problems.length >= 1, what);
    assert.ok(r.problems.every((p) => /^private data path answered 20\d on attempt 1 of 3/.test(p)), what);
  }
  const raw = await probePrivatePaths(opts(fakes((i) => (i.raw === "/data\\decide.json" && i.host === "https://leeroy.party" ? 200 : 404))));
  assert.deepEqual(raw.problems, ["private data path answered 200 on attempt 1 of 3: https://leeroy.party/data\\decide.json (backslash)"]);
});

test("ANY 2xx stays a failure: 200 then 404 fails, 200 then 404 then 404 fails, 200 then a network error fails, 503 then 200 fails; 404 then 404 passes", async () => {
  const thrower = () => { throw Object.assign(new Error("detail"), { name: "TimeoutError" }); };
  const only = (name, seq) => (i, n) => {
    if (i.raw || i.u.pathname !== "/data/client.json" || i.host !== "https://leeroy.party" || i.u.search) return 404;
    const v = seq[Math.min(n, seq.length - 1)];
    if (v === "err") return thrower();
    return v;
  };
  const clientProblems = async (seq) => (await probePrivatePaths(opts(fakes(only("client", seq))))).problems;
  const a = await clientProblems([200, 404]);
  assert.equal(a.length, 1, "attempt 1 returned 200, attempt 2 returned 404: still a FAIL");
  assert.match(a[0], /^private data path answered 200 on attempt 1 of 3 \(a later attempt answered 404: another edge node\): https:\/\/leeroy\.party\/data\/client\.json \(bare\)$/);
  assert.equal((await clientProblems([200, 404, 404])).length, 1);
  const b = await clientProblems([200, "err"]);
  assert.equal(b.length, 1, "200 then a network error: still a FAIL");
  assert.match(b[0], /answered 200 on attempt 1 of 3 \(a later attempt answered no answer \(TimeoutError\): another edge node\)/);
  assert.ok(!b[0].includes("detail"));
  const c = await clientProblems([503, 200]);
  assert.equal(c.length, 1, "a 200 on a later attempt counts too (a clean 404 is final and not asked again, a 5xx is)");
  assert.match(c[0], /^private data path answered 200 on attempt 2 of 3/);
  assert.equal((await clientProblems([503, 200, 404])).length, 1, "5xx, then 200, then 404");
  const clean = await probePrivatePaths(opts(fakes(only("client", [404, 404]))));
  assert.deepEqual(clean.problems, []);
  assert.deepEqual(clean.warnings, []);
  assert.equal(clean.lines.length, 60);
});

test("a 5xx or a network error that never clears is a WARN, not a failure; a 3xx is clean (no bytes were served); a 5xx is asked again", async () => {
  const r = await probePrivatePaths(opts(fakes((i) => (i.u.pathname === "/data/party.json" && !i.raw ? 503 : i.u.pathname === "/data/decide.json" && !i.raw ? 308 : 404))));
  assert.deepEqual(r.problems, []);
  assert.equal(r.warnings.length, 4, "party.json bare and cache-busted on both hosts");
  assert.ok(r.warnings.every((w) => /^WARN private data path not checked, status 503/.test(w)));
  assert.ok(r.lines.some((l) => /private data path 308/.test(l)));
  const thrower = async () => { throw Object.assign(new Error("secret detail"), { name: "TimeoutError" }); };
  const e = await probePrivatePaths({ fetchImpl: thrower, rawImpl: thrower, sleep: noSleep });
  assert.deepEqual(e.problems, []);
  assert.equal(e.warnings.length, 60);
  assert.ok(e.warnings.every((w) => /TimeoutError/.test(w) && !/secret detail/.test(w)));
  const slept = [];
  await probePrivatePaths({ fetchImpl: fakes(() => 503).fetchImpl, rawImpl: fakes(() => 503).rawImpl, sleep: async (ms) => { slept.push(ms); }, backoffMs: 5000 });
  assert.deepEqual(slept, [5000, 10000], "pauses grow between rounds, one pause per round for all URLs together");
});

test("request shape: bare = no extra header; cache-busted = unique ?cb= and Cache-Control: no-cache; GET; redirects not followed; the body is cancelled and never read", async () => {
  const f = fakes(() => 404);
  await probePrivatePaths(opts(f, { hosts: ["https://leeroy.party"], token: (() => { let i = 0; return () => `t${i++}`; })() }));
  const viaFetch = f.calls.filter((c) => !c.raw);
  assert.equal(f.calls.length, PER_HOST);
  const bare = viaFetch.filter((c) => !c.u.search), busted = viaFetch.filter((c) => c.u.search);
  assert.equal(bare.length, 6);
  assert.equal(busted.length, 6);
  for (const c of bare) assert.deepEqual(c.init.headers, {});
  for (const c of busted) { assert.equal(c.init.headers["cache-control"], "no-cache"); assert.match(c.u.search, /^\?cb=t\d+$/); }
  assert.equal(new Set(busted.map((c) => c.u.search)).size, 6, "each cache-busted request has its own token");
  for (const c of viaFetch) { assert.equal(c.init.method, "GET"); assert.equal(c.init.redirect, "manual"); assert.equal(c.cancelled.v, true, "body cancelled"); assert.ok(c.init.signal, "has a timeout"); }
});

test("against a real local server: every spelling arrives as written, a 200 is caught on all of them, the body never reaches the result", async () => {
  const seen = [];
  // the "edge": folds dot segments and backslashes (WHATWG URL parsing does exactly that) and serves party.json
  const srv = http.createServer((req, res) => { seen.push(req.url); const p = new URL(req.url, "http://x").pathname; if (p === "/data/party.json") { res.writeHead(200, { "content-type": "application/json" }); res.end(BODY); } else { res.writeHead(404); res.end("nope"); } });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const host = `http://127.0.0.1:${srv.address().port}`;
    const r = await probePrivatePaths({ hosts: [host], sleep: noSleep, attempts: 2 });
    assert.equal(r.problems.length, 5, "bare, cache-busted, dot-segment, parent-segment, backslash for party.json");
    assert.equal(r.lines.length, 25);
    assert.ok(!JSON.stringify(r).includes(BODY), "no body in the result");
    for (const want of ["/data/party.json", "/data/./party.json", "/data/x/../party.json", "/data\\party.json"]) assert.ok(seen.includes(want), `${want} reached the server as written (${seen.slice(0, 8).join(" ")})`);
    assert.ok(seen.some((s) => /^\/data\/party\.json\?cb=/.test(s)));
    assert.equal((await rawGet(host, "/data/party.json")).status, 200);
    assert.equal((await rawGet(host, "/data/other.json")).status, 404);
  } finally { await new Promise((r) => srv.close(r)); }
});

test("prod-probe.mjs runs it before the reference read and any browser, on the site hostnames only, and a problem is a FAIL line", () => {
  const src = fs.readFileSync(path.join(root, "tests/browser/prod-probe.mjs"), "utf8");
  assert.match(src, /import \{ probePrivatePaths, DEFAULT_HOSTS \} from "\.\.\/helpers\/private-path-probe\.mjs"/);
  const at = src.indexOf("probePrivatePaths({");
  assert.ok(at > 0 && at < src.indexOf("// 1. The reference"), "before the reference read of /api/state");
  assert.ok(at < src.indexOf("pw[engine].launch"), "before any browser");
  assert.match(src, /priv\.problems\.forEach\(\(x\) => fail\("private-data", x\)\)/);
  assert.ok(!/api\.leeroy\.party/.test(fs.readFileSync(path.join(root, "tests/helpers/private-path-probe.mjs"), "utf8").replace(/\/\/.*$/gm, "")), "the API host is not probed (its /api/data/* routes answer 200 on purpose)");
});
