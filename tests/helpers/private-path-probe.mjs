// Production check for the member data files: NONE of the private paths may answer 2xx on a site hostname (https://leeroy.party, https://leeroy-board.pages.dev).
// Used by tests/browser/prod-probe.mjs (after each production deploy and once a day). Unit-tested in tests/unit/private-path-probe.test.mjs with a fake fetch and a local server.
//
// Why it exists: on 2026-11-15 the files had been out of the Pages bundle for days, every old deployment had been deleted, and leeroy.party/data/party.json still answered 200 with the old
// bytes (an edge layer behind the zone cache; docs/runbooks/member-data-worker-only.md). Only a request to the real hostname can tell. Two requests per host and path:
//   bare          the plain URL, no extra header: this is the URL the stale object answers (a query string or a Cache-Control request header changed the answer in the measurements)
//   cache-busted  the same path with a unique query string and "Cache-Control: no-cache", which shows what the current deployment itself answers
// Output: status lines only ("PASS ... 404", "FAIL ... 200"), never a body: the response body is cancelled unread, so a leak is never copied into a public CI log.
// Retries: a 2xx, a 5xx or a network error is asked again, all still-failing URLs together, up to `attempts` rounds with a growing pause (a new deploy takes a moment to reach the edge). A 2xx that
// is still there after the last round is a FAIL; a 5xx or network error that never clears is only a WARN (it proves nothing about a leak), and so is a 3xx (not a 2xx: no bytes were served).
// Requests that reach the Pages Function (every private path does) count as Worker requests on the free plan: 2 x hosts x 6 paths = 24 per run, 72 at the very most with every retry.
import { PRIVATE_DATA_FILES } from "../../pages-worker/private-paths.mjs";

export const DEFAULT_HOSTS = Object.freeze(["https://leeroy.party", "https://leeroy-board.pages.dev"]);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export async function probePrivatePaths({ hosts = DEFAULT_HOSTS, paths = PRIVATE_DATA_FILES, fetchImpl = fetch, attempts = 3, backoffMs = 8000, sleep = wait, timeoutMs = 20000, token = () => Math.random().toString(36).slice(2, 10) } = {}) {
  const jobs = [];
  for (const host of hosts) for (const p of paths) for (const kind of ["bare", "cache-busted"]) jobs.push({ host, path: p, kind, shown: `${host}/${p} (${kind})` });
  let pending = jobs, requests = 0;
  const last = new Map();
  for (let round = 1; round <= attempts && pending.length; round++) {
    if (round > 1) await sleep(backoffMs * (round - 1));
    await Promise.all(pending.map(async (j) => {
      requests++;
      const busted = j.kind === "cache-busted";
      const url = `${j.host}/${j.path}${busted ? `?cb=${token()}` : ""}`;
      try {
        const res = await fetchImpl(url, { method: "GET", redirect: "manual", headers: busted ? { "cache-control": "no-cache", pragma: "no-cache" } : {}, signal: AbortSignal.timeout(timeoutMs) });
        try { await res.body?.cancel(); } catch { /* the body is never read */ }
        last.set(j, { status: res.status });
      } catch (e) { last.set(j, { error: String((e && e.name) || "error") }); }
    }));
    pending = pending.filter((j) => { const r = last.get(j); return r.error || r.status >= 500 || (r.status >= 200 && r.status < 300); });
  }
  const lines = [], problems = [], warnings = [];
  for (const j of jobs) {
    const r = last.get(j);
    if (r.error) { warnings.push(`WARN private data path not checked, no answer (${r.error}) after ${attempts} attempts: ${j.shown}`); continue; }
    if (r.status >= 200 && r.status < 300) { problems.push(`private data path answers ${r.status} on a site hostname after ${attempts} attempts: ${j.shown}`); continue; }
    if (r.status >= 500) { warnings.push(`WARN private data path not checked, status ${r.status} after ${attempts} attempts: ${j.shown}`); continue; }
    lines.push(`PASS private data path ${r.status}: ${j.shown}`);
  }
  return { lines, problems, warnings, requests, checked: jobs.length };
}
