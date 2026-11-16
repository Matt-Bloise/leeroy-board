// The production check that no private member data path answers 2xx on a site hostname (tests/helpers/private-path-probe.mjs, run by tests/browser/prod-probe.mjs).
// Pinned: a 200 anywhere (bare URL or cache-busted, either host) is a problem; 404 everywhere is clean; a 200 that clears on a retry is clean; a 5xx or a network error that never clears is a WARN,
// not a failure; the bare request carries no extra header and the cache-busted one carries a unique query and Cache-Control: no-cache; redirects are not followed; response bodies are
// cancelled unread and never appear in the output; the probe script wires it in before any browser starts, and it is not pointed at the API host (api.leeroy.party answers 200 on purpose).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { probePrivatePaths, DEFAULT_HOSTS } from "../../tests/helpers/private-path-probe.mjs";
import { PRIVATE_DATA_FILES } from "../../pages-worker/private-paths.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const noSleep = async () => {};
const BODY = "SECRET-MEMBER-BODY";

// A fake fetch: `plan(url, init, callNo)` returns a status (number) or throws.
function fakeFetch(plan) {
  const calls = [];
  const fn = async (url, init) => {
    const u = new URL(url);
    const callNo = calls.filter((c) => c.url === url).length;
    const cancelled = { v: false };
    calls.push({ url, init, u, cancelled });
    const status = plan(u, init, callNo, calls.length);
    return { status, body: { cancel: async () => { cancelled.v = true; } }, text: async () => { throw new Error("the probe must never read a body"); }, json: async () => { throw new Error("the probe must never read a body"); } };
  };
  fn.calls = calls;
  return fn;
}

test("default hosts are the two site hostnames, never the API host; the paths are the private list", async () => {
  assert.deepEqual([...DEFAULT_HOSTS], ["https://leeroy.party", "https://leeroy-board.pages.dev"]);
  const f = fakeFetch(() => 404);
  const r = await probePrivatePaths({ fetchImpl: f, sleep: noSleep });
  assert.equal(r.checked, DEFAULT_HOSTS.length * PRIVATE_DATA_FILES.length * 2);
  assert.equal(f.calls.length, r.checked, "one request per host, path and kind when nothing is wrong");
  assert.ok(f.calls.every((c) => !/api\.leeroy\.party/.test(c.url)));
  assert.deepEqual([...new Set(f.calls.map((c) => c.u.pathname))].sort(), PRIVATE_DATA_FILES.map((p) => "/" + p).sort());
});

test("all 404: clean, one PASS status line per request, nothing else", async () => {
  const r = await probePrivatePaths({ fetchImpl: fakeFetch(() => 404), sleep: noSleep });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.lines.length, 24);
  for (const l of r.lines) assert.match(l, /^PASS private data path 404: https:\/\/[a-z.-]+\/data\/[a-z-]+\.json \((bare|cache-busted)\)$/);
  assert.ok(!r.lines.join("\n").includes("cb="), "the cache-busting token is not printed");
});

test("a 200 on the bare URL of one path on one host is a problem that names the host, path and kind, and nothing but the status", async () => {
  const f = fakeFetch((u, init) => (u.host === "leeroy.party" && u.pathname === "/data/party.json" && !u.search ? 200 : 404));
  const r = await probePrivatePaths({ fetchImpl: f, sleep: noSleep });
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /answers 200 on a site hostname after 3 attempts: https:\/\/leeroy\.party\/data\/party\.json \(bare\)/);
  assert.ok(!r.problems[0].includes(BODY));
  assert.equal(r.lines.length, 23);
  assert.equal(f.calls.filter((c) => c.u.pathname === "/data/party.json" && c.u.host === "leeroy.party" && !c.u.search).length, 3, "asked three times");
  assert.equal(f.calls.length, 24 + 2, "only the failing URL is asked again");
});

test("a 200 on a cache-busted request, and a 200 on the pages.dev host, are problems too (and 201/204 count as served)", async () => {
  for (const [what, plan] of [
    ["cache-busted on leeroy.party", (u) => (u.host === "leeroy.party" && u.search.startsWith("?cb=") ? 200 : 404)],
    ["bare on pages.dev", (u) => (u.host === "leeroy-board.pages.dev" && !u.search ? 200 : 404)],
    ["204 bare", (u) => (u.pathname === "/data/signups.json" && !u.search ? 204 : 404)],
  ]) {
    const r = await probePrivatePaths({ fetchImpl: fakeFetch(plan), sleep: noSleep });
    assert.ok(r.problems.length >= 1, what);
  }
});

test("a 200 that clears within the retries (a deploy reaching the edge) is clean; one that never clears fails after the last round", async () => {
  const asked = new Map();
  const cleared = await probePrivatePaths({ fetchImpl: fakeFetch((u) => { const k = `${u.host}${u.pathname}${u.search ? "?" : ""}`; const n = asked.get(k) || 0; asked.set(k, n + 1); return u.pathname === "/data/client.json" && n < 2 ? 200 : 404; }), sleep: noSleep });
  assert.deepEqual(cleared.problems, []);
  const slept = [];
  const stuck = await probePrivatePaths({ fetchImpl: fakeFetch((u) => (u.pathname === "/data/client.json" ? 200 : 404)), sleep: async (ms) => { slept.push(ms); }, attempts: 3, backoffMs: 5000 });
  assert.equal(stuck.problems.length, 4, "two hosts x bare and cache-busted");
  assert.deepEqual(slept, [5000, 10000], "pauses grow between the rounds, one pause per round for all URLs together");
});

test("a 5xx or a network error that never clears is a WARN, not a failure; a 3xx is clean (no bytes were served); retried like a 200", async () => {
  const r = await probePrivatePaths({ fetchImpl: fakeFetch((u) => (u.pathname === "/data/party.json" ? 503 : u.pathname === "/data/decide.json" ? 308 : 404)), sleep: noSleep });
  assert.deepEqual(r.problems, []);
  assert.equal(r.warnings.length, 4);
  assert.ok(r.warnings.every((w) => /^WARN private data path not checked, status 503/.test(w)));
  assert.ok(r.lines.some((l) => /private data path 308/.test(l)));
  const thrower = async () => { throw Object.assign(new Error("secret detail"), { name: "TimeoutError" }); };
  const e = await probePrivatePaths({ fetchImpl: thrower, sleep: noSleep });
  assert.deepEqual(e.problems, []);
  assert.equal(e.warnings.length, 24);
  assert.ok(e.warnings.every((w) => /TimeoutError/.test(w) && !/secret detail/.test(w)));
});

test("request shape: bare = no extra header; cache-busted = unique ?cb= and Cache-Control: no-cache; GET; redirects not followed; the body is cancelled and never read", async () => {
  const f = fakeFetch(() => 404);
  await probePrivatePaths({ hosts: ["https://leeroy.party"], fetchImpl: f, sleep: noSleep, token: (() => { let i = 0; return () => `t${i++}`; })() });
  assert.equal(f.calls.length, 12);
  const bare = f.calls.filter((c) => !c.u.search), busted = f.calls.filter((c) => c.u.search);
  assert.equal(bare.length, 6);
  assert.equal(busted.length, 6);
  for (const c of bare) assert.deepEqual(c.init.headers, {});
  for (const c of busted) { assert.equal(c.init.headers["cache-control"], "no-cache"); assert.match(c.u.search, /^\?cb=t\d+$/); }
  assert.equal(new Set(busted.map((c) => c.u.search)).size, 6, "each cache-busted request has its own token");
  for (const c of f.calls) { assert.equal(c.init.method, "GET"); assert.equal(c.init.redirect, "manual"); assert.equal(c.cancelled.v, true, "body cancelled"); assert.ok(c.init.signal, "has a timeout"); }
});

test("against a real local server: 200 is caught, 404 is clean, and the body never reaches the result", async () => {
  const seen = [];
  const srv = http.createServer((req, res) => { seen.push(`${req.method} ${req.url}`); if (req.url.startsWith("/data/party.json")) { res.writeHead(200, { "content-type": "application/json" }); res.end(BODY); } else { res.writeHead(404); res.end("nope"); } });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const host = `http://127.0.0.1:${srv.address().port}`;
    const r = await probePrivatePaths({ hosts: [host], sleep: noSleep, attempts: 2 });
    assert.equal(r.problems.length, 2, "bare and cache-busted party.json");
    assert.equal(r.lines.length, 10);
    assert.ok(!JSON.stringify(r).includes(BODY), "no body in the result");
    assert.ok(seen.some((s) => s === "GET /data/party.json") && seen.some((s) => /^GET \/data\/party\.json\?cb=/.test(s)));
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
