// Production check for the member data files: NONE of the private paths may answer 2xx on a site hostname (https://leeroy.party, https://leeroy-board.pages.dev).
// Used by tests/browser/prod-probe.mjs (after each production deploy and once a day). Unit-tested in tests/unit/private-path-probe.test.mjs with a fake fetch and a local server.
//
// Why it exists: on 2026-11-15 the files had been out of the Pages bundle for days, every old deployment had been deleted, and leeroy.party/data/party.json still answered 200 with the old
// bytes (an edge layer behind the zone cache; docs/runbooks/member-data-worker-only.md). Only a request to the real hostname can tell. Per host and file:
//   bare          the plain URL, no extra header: this is the URL the stale object answers (a query string or a Cache-Control request header changed the answer in the measurements)
//   cache-busted  the same path with a unique query string and "Cache-Control: no-cache", which shows what the current deployment itself answers
//   dot-segment, parent-segment, backslash   "/data/./party.json", "/data/x/../party.json", "/data\party.json": the stale copy was measured answering all three (the edge folds them into the
//                 plain path before it looks the file up). Sent RAW with node:http(s), because fetch() would fold them itself before sending (WHATWG URL parsing).
// Output: status lines only ("PASS ... 404", "FAIL ... 200"), never a body: the response body is cancelled unread, so a leak is never copied into a public CI log.
// Rounds: every URL that has not answered cleanly is asked again, all together, up to `attempts` rounds with a growing pause (a new deploy takes a moment to reach the edge, and different
// edge nodes answer differently: a second request may land on a node that holds no copy). A 2xx is STICKY: once any attempt for a URL has answered 2xx, that URL is a FAIL, even if a later attempt
// answers 404, 5xx or nothing (an earlier 200 is the evidence, a later 404 only means another node). A 5xx or network error that never clears, with no 2xx seen, is only a WARN (it proves nothing
// about a leak), and so is a 3xx (no bytes were served).
// Requests that reach the Pages Function (every private path does) count as Worker requests on the free plan: 5 requests per host and file = 60 per run on the two hosts, 180 at the very most with every retry.
import http from "node:http";
import https from "node:https";
import { PRIVATE_DATA_FILES } from "../../pages-worker/private-paths.mjs";

export const DEFAULT_HOSTS = Object.freeze(["https://leeroy.party", "https://leeroy-board.pages.dev"]);

// The raw request targets, per private file ("data/party.json"). Names are what the lines print.
export const RAW_VARIANTS = Object.freeze([
  ["dot-segment", (f) => `/${f.replace(/^data\//, "data/./")}`],
  ["parent-segment", (f) => `/${f.replace(/^data\//, "data/x/../")}`],
  ["backslash", (f) => `/${f.replace(/^data\//, "data\\")}`],
]);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// GET with the request target exactly as given; resolves { status } and drops the connection without reading the body.
export function rawGet(host, target, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(host);
    const lib = u.protocol === "http:" ? http : https;
    const req = lib.request({ protocol: u.protocol, hostname: u.hostname, port: u.port || undefined, path: target, method: "GET", agent: false, timeout: timeoutMs, headers: { accept: "*/*", "user-agent": "leeroy-private-path-probe" } }, (res) => { const status = res.statusCode; res.destroy(); resolve({ status }); });
    req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { name: "TimeoutError" })));
    req.on("error", reject);
    req.end();
  });
}

export async function probePrivatePaths({ hosts = DEFAULT_HOSTS, paths = PRIVATE_DATA_FILES, fetchImpl = fetch, rawImpl = rawGet, attempts = 3, backoffMs = 8000, sleep = wait, timeoutMs = 20000, token = () => Math.random().toString(36).slice(2, 10) } = {}) {
  const jobs = [];
  for (const host of hosts) for (const p of paths) {
    for (const kind of ["bare", "cache-busted"]) jobs.push({ host, path: p, kind, raw: null, shown: `${host}/${p} (${kind})` });
    for (const [kind, target] of RAW_VARIANTS) jobs.push({ host, path: p, kind, raw: target(p), shown: `${host}${target(p)} (${kind})` });
  }
  let pending = jobs, requests = 0;
  const last = new Map(), seen2xx = new Map();
  for (let round = 1; round <= attempts && pending.length; round++) {
    if (round > 1) await sleep(backoffMs * (round - 1));
    await Promise.all(pending.map(async (j) => {
      requests++;
      let r;
      try {
        if (j.raw) r = { status: (await rawImpl(j.host, j.raw, { timeoutMs })).status };
        else {
          const busted = j.kind === "cache-busted";
          const res = await fetchImpl(`${j.host}/${j.path}${busted ? `?cb=${token()}` : ""}`, { method: "GET", redirect: "manual", headers: busted ? { "cache-control": "no-cache", pragma: "no-cache" } : {}, signal: AbortSignal.timeout(timeoutMs) });
          try { await res.body?.cancel(); } catch { /* the body is never read */ }
          r = { status: res.status };
        }
      } catch (e) { r = { error: String((e && e.name) || "error") }; }
      last.set(j, r);
      if (r.status >= 200 && r.status < 300 && !seen2xx.has(j)) seen2xx.set(j, { status: r.status, round });
    }));
    pending = pending.filter((j) => { const r = last.get(j); return r.error || r.status >= 500 || (r.status >= 200 && r.status < 300); });
  }
  const lines = [], problems = [], warnings = [];
  const after = (r) => (r.error ? `no answer (${r.error})` : `${r.status}`);
  for (const j of jobs) {
    const r = last.get(j), hit = seen2xx.get(j);
    if (hit) { problems.push(`private data path answered ${hit.status} on attempt ${hit.round} of ${attempts}${r.error || r.status < 200 || r.status >= 300 ? ` (a later attempt answered ${after(r)}: another edge node)` : ""}: ${j.shown}`); continue; }
    if (r.error) { warnings.push(`WARN private data path not checked, no answer (${r.error}) after ${attempts} attempts: ${j.shown}`); continue; }
    if (r.status >= 500) { warnings.push(`WARN private data path not checked, status ${r.status} after ${attempts} attempts: ${j.shown}`); continue; }
    lines.push(`PASS private data path ${r.status}: ${j.shown}`);
  }
  return { lines, problems, warnings, requests, checked: jobs.length };
}
