// Preview environment cleanup through the Cloudflare API, with proof. Node 22, no dependencies, fetch injected for the tests.
//   node tools/preview-cleanup.mjs teardown <pr-number>   delete this PR's Worker, D1 database and Pages preview deployments, then VERIFY by listing that nothing remains; exit 1 if anything does
//   node tools/preview-cleanup.mjs leaks                  READ-ONLY: list the preview Workers, D1 databases and Pages preview deployments named for a PR number whose PR is closed; deletes nothing
// env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, PAGES_PROJECT_NAME (default leeroy-board); leaks also GH_TOKEN and GITHUB_REPOSITORY.
//
// Why it exists (docs/runbooks/cloudflare-requests.md, the steward's RULES.md): the old teardown ended each delete with `|| echo ...`, so a failed delete still went green, the Pages listing read only
// the first page of deployments, and a later event of the same PR could cancel a teardown half way. Here:
//   - a delete succeeds only on a 2xx, or on a 404 that means "already gone" (anything else is an error and fails the step);
//   - after the deletes every list is read again, ALL pages, and a listing that cannot be completed (the total says more than was read, a page that does not advance) is a failure, never a pass;
//   - the verification retries a few times (eventual consistency) before it fails loudly, naming what remains;
//   - it only ever touches the three names derived from the PR number: leeroy-brain-pr-<n>, leeroy-board-db-pr-<n>, Pages branch pr-<n>. Never a pattern, never production, never anything else.
// A teardown failure is safe to re-run: every step is idempotent. Nothing waits on it: it only frees a preview slot.
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const API = "https://api.cloudflare.com/client/v4";
export const NAMES = (pr) => {
  if (!/^[0-9]{1,8}$/.test(String(pr))) throw new Error(`not a pull request number: ${pr}`);
  return { worker: `leeroy-brain-pr-${pr}`, d1: `leeroy-board-db-pr-${pr}`, branch: `pr-${pr}` };
};
export const WORKER_RE = /^leeroy-brain-pr-([0-9]{1,8})$/, D1_RE = /^leeroy-board-db-pr-([0-9]{1,8})$/, BRANCH_RE = /^pr-([0-9]{1,8})$/;
const MAX_PAGES = 200;

export class CfError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

// One call. Throws CfError on a network failure, on a body that is not JSON, and (unless the status is in `okStatus`) on anything but a 2xx with success true.
export async function cf(fetchImpl, token, method, pathAndQuery, { okStatus = [] } = {}) {
  let res;
  try { res = await fetchImpl(`${API}${pathAndQuery}`, { method, headers: { Authorization: `Bearer ${token}` } }); }
  catch (e) { throw new CfError(`${method} ${pathAndQuery.split("?")[0]}: network error: ${e.message}`, 0); }
  let body = null;
  try { body = await res.json(); } catch { /* handled below */ }
  if (okStatus.includes(res.status)) return { status: res.status, body };
  if (res.status < 200 || res.status >= 300 || !body || body.success !== true) {
    const why = body && Array.isArray(body.errors) && body.errors.length ? body.errors.map((e) => `${e.code}: ${e.message}`).join("; ") : "no error text";
    throw new CfError(`${method} ${pathAndQuery.split("?")[0]} answered ${res.status} (${why})`, res.status);
  }
  return { status: res.status, body };
}

// Every item of a list endpoint, all pages. Fails when the listing cannot be completed: a page that adds nothing new while the total says more, or more than MAX_PAGES pages.
export async function listAll(fetchImpl, token, pathBase, query = "", key = (x) => x.id || x.uuid || x.name) {
  const seen = new Map();
  let total = null;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { body } = await cf(fetchImpl, token, "GET", `${pathBase}?${query}${query ? "&" : ""}page=${page}&per_page=25`);
    const items = Array.isArray(body.result) ? body.result : [];
    const info = body.result_info || {};
    if (typeof info.total_count === "number") total = info.total_count;
    let added = 0;
    for (const it of items) { const k = key(it); if (k !== undefined && !seen.has(k)) { seen.set(k, it); added++; } }
    const totalPages = typeof info.total_pages === "number" ? info.total_pages : null;
    if (items.length === 0 || added === 0) break;
    if (totalPages !== null && page >= totalPages) break;
    if (totalPages === null && total !== null && seen.size >= total) break;
    if (totalPages === null && total === null && items.length < 25) break;
  }
  if (total !== null && seen.size < total) throw new CfError(`${pathBase}: the listing is incomplete (${seen.size} of ${total} items read)`, 0);
  return [...seen.values()];
}

export const listD1 = (f, t, acc) => listAll(f, t, `/accounts/${acc}/d1/database`, "", (d) => d.uuid || d.name);
export const listWorkers = async (f, t, acc) => {
  const { body } = await cf(f, t, "GET", `/accounts/${acc}/workers/scripts`);
  return Array.isArray(body.result) ? body.result : [];
};
export const listPreviewDeployments = (f, t, acc, project) => listAll(f, t, `/accounts/${acc}/pages/projects/${project}/deployments`, "env=preview");
const branchOf = (d) => (d && d.deployment_trigger && d.deployment_trigger.metadata && d.deployment_trigger.metadata.branch) || "";

// -> { ok, lines, remaining: string[] }
export async function teardown({ fetchImpl = fetch, token, accountId, pr, project = "leeroy-board", sleep = (ms) => new Promise((r) => setTimeout(r, ms)), attempts = 4, waitMs = 5000 }) {
  const n = NAMES(pr);
  const lines = [];
  const say = (s) => lines.push(s);
  const errors = [];
  const step = async (label, fn) => { try { await fn(); } catch (e) { errors.push(`${label}: ${e.message}`); say(`FAIL ${label}: ${e.message}`); } };

  await step(`delete Worker ${n.worker}`, async () => {
    const r = await cf(fetchImpl, token, "DELETE", `/accounts/${accountId}/workers/scripts/${n.worker}?force=true`, { okStatus: [404] });
    say(r.status === 404 ? `Worker ${n.worker}: already gone (404)` : `Worker ${n.worker}: deleted`);
  });
  await step(`delete D1 database ${n.d1}`, async () => {
    const dbs = (await listD1(fetchImpl, token, accountId)).filter((d) => d.name === n.d1);
    if (dbs.length === 0) { say(`D1 ${n.d1}: already gone (not listed)`); return; }
    for (const d of dbs) {
      const r = await cf(fetchImpl, token, "DELETE", `/accounts/${accountId}/d1/database/${d.uuid}`, { okStatus: [404] });
      say(r.status === 404 ? `D1 ${n.d1}: already gone (404)` : `D1 ${n.d1}: deleted`);
    }
  });
  await step(`delete Pages preview deployments of branch ${n.branch}`, async () => {
    const mine = (await listPreviewDeployments(fetchImpl, token, accountId, project)).filter((d) => d.environment === "preview" && branchOf(d) === n.branch);
    say(`Pages: ${mine.length} preview deployment(s) for ${n.branch}`);
    for (const d of mine) {
      const r = await cf(fetchImpl, token, "DELETE", `/accounts/${accountId}/pages/projects/${project}/deployments/${d.id}?force=true`, { okStatus: [404] });
      say(`Pages deployment ${d.id}: ${r.status === 404 ? "already gone (404)" : "deleted"}`);
    }
  });

  // Verify: list again, all pages, and require that nothing named for this PR remains.
  let remaining = [];
  for (let a = 1; a <= attempts; a++) {
    remaining = [];
    try {
      if ((await listWorkers(fetchImpl, token, accountId)).some((w) => w.id === n.worker)) remaining.push(`Worker ${n.worker}`);
      if ((await listD1(fetchImpl, token, accountId)).some((d) => d.name === n.d1)) remaining.push(`D1 database ${n.d1}`);
      for (const d of (await listPreviewDeployments(fetchImpl, token, accountId, project)).filter((x) => x.environment === "preview" && branchOf(x) === n.branch)) remaining.push(`Pages deployment ${d.id}`);
      if (remaining.length === 0) { say(`verified on attempt ${a}: no Worker, no D1 database and no Pages preview deployment named for PR ${pr} remains`); break; }
      say(`attempt ${a}: still there: ${remaining.join(", ")}`);
    } catch (e) {
      remaining = [`could not verify: ${e.message}`];
      say(`attempt ${a}: could not verify (${e.message})`);
    }
    if (a < attempts) await sleep(waitMs);
  }
  const ok = errors.length === 0 && remaining.length === 0;
  return { ok, lines, remaining, errors };
}

// -> { leaks: [{ kind, name, pr, state }], checked: number, lines } READ-ONLY. prState(pr) -> "open" | "closed" | "unknown".
export async function leakReport({ fetchImpl = fetch, token, accountId, project = "leeroy-board", prState }) {
  const found = [];
  for (const w of await listWorkers(fetchImpl, token, accountId)) { const m = WORKER_RE.exec(w.id || ""); if (m) found.push({ kind: "Worker", name: w.id, pr: m[1] }); }
  for (const d of await listD1(fetchImpl, token, accountId)) { const m = D1_RE.exec(d.name || ""); if (m) found.push({ kind: "D1 database", name: d.name, pr: m[1] }); }
  const branches = new Set();
  for (const d of await listPreviewDeployments(fetchImpl, token, accountId, project)) { const b = branchOf(d); const m = BRANCH_RE.exec(b); if (m && !branches.has(b)) { branches.add(b); found.push({ kind: "Pages preview branch", name: b, pr: m[1] }); } }
  const states = new Map();
  for (const f of found) if (!states.has(f.pr)) states.set(f.pr, await prState(f.pr));
  const leaks = found.filter((f) => states.get(f.pr) !== "open").map((f) => ({ ...f, state: states.get(f.pr) }));
  return { leaks, checked: found.length };
}

const summary = (text) => { process.stdout.write(text + "\n"); if (process.env.GITHUB_STEP_SUMMARY) { try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + "\n"); } catch { /* best effort */ } } };

async function main() {
  const [mode, arg] = process.argv.slice(2);
  const token = String(process.env.CLOUDFLARE_API_TOKEN || "").replace(/[\r\n ]/g, ""), accountId = String(process.env.CLOUDFLARE_ACCOUNT_ID || "").replace(/[\r\n ]/g, "");
  const project = process.env.PAGES_PROJECT_NAME || "leeroy-board";
  if (!token || !accountId) {
    console.log("::notice title=Cloudflare cleanup skipped::CLOUDFLARE_API_TOKEN or CLOUDFLARE_ACCOUNT_ID is missing, so this workflow could not have created a preview. See docs/runbooks/ci-secrets.md.");
    process.exit(0);
  }
  if (mode === "teardown") {
    const r = await teardown({ token, accountId, pr: arg, project });
    summary([`### Preview teardown, PR ${arg}`, "", ...r.lines.map((l) => `- ${l}`), "", r.ok ? "**Result: torn down and verified.**" : `**Result: FAILED. Still there or failed: ${[...r.errors, ...r.remaining].join("; ")}.** Every step is idempotent: re-run this job, or tell the owner (a manual delete is the owner's, never a session's).`].join("\n"));
    process.exit(r.ok ? 0 : 1);
  }
  if (mode === "leaks") {
    const repo = process.env.GITHUB_REPOSITORY, gh = process.env.GH_TOKEN;
    const prState = async (n) => {
      try {
        const res = await fetch(`https://api.github.com/repos/${repo}/pulls/${n}`, { headers: { Authorization: `Bearer ${gh}`, Accept: "application/vnd.github+json" } });
        if (res.status === 404) return "closed"; // no such pull request: nothing can be using it
        if (!res.ok) return "unknown";
        const j = await res.json();
        return j.state === "open" ? "open" : "closed";
      } catch { return "unknown"; }
    };
    const r = await leakReport({ token, accountId, project, prState });
    const rows = r.leaks.map((l) => `| ${l.kind} | \`${l.name}\` | #${l.pr} | ${l.state} |`);
    summary(["### Preview leak report (read-only: nothing was deleted)", "", `Preview resources found: ${r.checked}. Named for a pull request that is not open: **${r.leaks.length}**.`, "", ...(rows.length ? ["| Kind | Name | PR | PR state |", "| --- | --- | --- | --- |", ...rows, "", "Deleting these is the account owner's decision. Nothing here deletes anything."] : ["No leaks."])].join("\n"));
    if (r.leaks.length) console.log(`::warning title=Preview resources without an open pull request::${r.leaks.length} leaked preview resource(s); see the job summary.`);
    process.exit(0);
  }
  console.error("usage: node tools/preview-cleanup.mjs teardown <pr-number> | leaks");
  process.exit(2);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`::error::${String(e.message).replace(/[\r\n]+/g, " ")}`); process.exit(1); });
}
