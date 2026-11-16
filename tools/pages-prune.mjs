// Deletes the OLD Cloudflare Pages deployments of the site and purges the stale member-data files from the edge cache. Node 22, no dependencies.
// Run from .github/workflows/pages-prune.yml (workflow_dispatch only, dry run by default); never run by a push, a schedule or a pull request.
//
//   node tools/pages-prune.mjs prune    list the deployments; delete every one that is not in the keep set (or only count them when DRY_RUN != "false")
//   node tools/pages-prune.mjs purge    purge the private data files from the edge cache of the leeroy.party zone (never fails the workflow)
//
// Environment (the workflow supplies it; nothing is read from a file):
//   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID   the same repository secrets the deploy uses. Never printed.
//   PAGES_PROJECT_NAME                            the Pages project (leeroy-board in the workflow)
//   DRY_RUN                                       anything except the exact string "false" is a dry run (fail safe)
//   MAX_DELETE                                    refuse to delete when more than this many deployments qualify (default 2000)
//
// WHY: the member data files (data/party.json and the others in tools/pages-bundle.mjs) used to be published as static files. They are Worker-only now, but every
// OLD deployment (<hash>.leeroy-board.pages.dev) still serves them. Deleting the old deployments is the only way to stop that; there is no undo.
//
// KEEP SET (everything else is deleted):
//   1. the current production deployment: `canonical_deployment` of GET /accounts/{id}/pages/projects/{project} (the API documents it as the most recent production deployment);
//   2. the project's `latest_deployment` when it is also a production deployment (a deploy that has not become canonical yet, or a rollback);
//   3. the newest production-environment deployment in the list.
// Preview deployments (pr-<n> branches) are NOT kept: matching them to open pull requests needs the GitHub API, cannot be done reliably offline, and an old preview is exactly
// what still serves the private files. A pull request gets a fresh preview on its next push.
//
// FAIL CLOSED: if the production deployment id cannot be determined with certainty (project call failed, no canonical id, it is not a production deployment, or it is not in the
// deployment list) NOTHING is deleted and the exit code is 1. The same holds for a list that could not be read to the end, and for a count above MAX_DELETE.
//
// OUTPUT: counts and progress only. The workflow log of a public repository is public, so no deployment id, branch, account id, zone id, token or response body is ever printed.
import { pathToFileURL } from "node:url";
import { PRIVATE_DATA_FILES, STRIPPED_FILES } from "./pages-bundle.mjs";

export const API = "https://api.cloudflare.com/client/v4";
export const PER_PAGE = 25;
export const MAX_PAGES = 1000;
export const DELETE_CONCURRENCY = 3;
export const DEFAULT_MAX_DELETE = 2000;
export const MAX_RETRIES = 5;
export const BACKOFF_BASE_MS = 500;
export const BACKOFF_CAP_MS = 60000;
export const PROGRESS_EVERY = 25;
export const ZONE_NAME = "leeroy.party";
export const PAGES_DEV_HOST = "leeroy-board.pages.dev";
export const PURGE_SKIP_LINE = "cache purge skipped: token lacks Cache Purge permission";
// Cloudflare error codes that mean "this token may not do that" (the HTTP status is 401 or 403 for all of them).
const AUTH_CODES = new Set([9109, 10000, 10001, 9106, 9107]);
const ID_RE = /^[A-Za-z0-9-]{8,64}$/;

export class FailClosed extends Error {
  constructor(message) { super(message); this.name = "FailClosed"; }
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// ---- pure functions (unit-tested) ----

// API response body -> { items: [{ id, environment, createdOn }], malformed }. Throws FailClosed unless the body is a successful list.
// Entries without a usable id are counted in `malformed` and never become delete candidates.
export function parseDeployments(json) {
  if (!isObj(json) || json.success !== true || !Array.isArray(json.result)) throw new FailClosed("the deployment list response was not a successful list");
  const items = [];
  let malformed = 0;
  for (const d of json.result) {
    if (!isObj(d) || typeof d.id !== "string" || !ID_RE.test(d.id)) { malformed++; continue; }
    items.push({ id: d.id, environment: typeof d.environment === "string" ? d.environment : "unknown", createdOn: typeof d.created_on === "string" ? d.created_on : "" });
  }
  return { items, malformed };
}

// The production deployment ids named by the project object: canonical_deployment (required) and latest_deployment when that one is also production.
// Throws FailClosed when the canonical id is missing, so the caller deletes nothing.
export function productionIdsFromProject(json) {
  if (!isObj(json) || json.success !== true || !isObj(json.result)) throw new FailClosed("the project response was not a successful object");
  const canonical = json.result.canonical_deployment;
  if (!isObj(canonical) || typeof canonical.id !== "string" || !ID_RE.test(canonical.id)) throw new FailClosed("the production deployment (canonical_deployment) could not be determined");
  if (typeof canonical.environment === "string" && canonical.environment !== "production") throw new FailClosed("canonical_deployment is not a production deployment");
  const ids = [canonical.id];
  const latest = json.result.latest_deployment;
  if (isObj(latest) && typeof latest.id === "string" && ID_RE.test(latest.id) && latest.environment === "production" && latest.id !== canonical.id) ids.push(latest.id);
  return { canonicalId: canonical.id, ids };
}

// deployments: parseDeployments().items. production: { canonicalId, ids }. Returns { keep: Set, remove: [ids], counts }.
// Throws FailClosed (so nothing is deleted) when the canonical production deployment is not in the list, or is not a production-environment entry.
export function pickKeepSet(deployments, production) {
  if (!production || typeof production.canonicalId !== "string" || !production.canonicalId) throw new FailClosed("no production deployment id: refusing to choose what to delete");
  const byId = new Map(deployments.map((d) => [d.id, d]));
  const canonical = byId.get(production.canonicalId);
  if (!canonical) throw new FailClosed("the production deployment is not in the deployment list: refusing to delete anything");
  if (canonical.environment !== "production") throw new FailClosed("the production deployment is listed with a non-production environment: refusing to delete anything");
  const keep = new Set([production.canonicalId, ...(production.ids || []).filter((id) => byId.has(id))]);
  const newest = deployments.filter((d) => d.environment === "production").sort((a, b) => (a.createdOn < b.createdOn ? 1 : a.createdOn > b.createdOn ? -1 : 0))[0];
  if (newest) keep.add(newest.id);
  const remove = deployments.filter((d) => !keep.has(d.id)).map((d) => d.id);
  const counts = { total: deployments.length, keep: keep.size, remove: remove.length, byEnvironment: {} };
  for (const d of deployments) {
    const e = (counts.byEnvironment[d.environment] ||= { total: 0, remove: 0 });
    e.total++;
    if (!keep.has(d.id)) e.remove++;
  }
  return { keep, remove, counts };
}

// The page after `page`, or null when the list is finished. Uses the server's own result_info when it is complete, else the short-page rule. An empty page always ends the list.
export function nextPage({ page, perPage, count, resultInfo }) {
  if (!Number.isInteger(count) || count <= 0) return null;
  const info = isObj(resultInfo) ? resultInfo : {};
  if (Number.isInteger(info.total_pages) && info.total_pages > 0) return page < info.total_pages ? page + 1 : null;
  if (Number.isInteger(info.total_count) && Number.isInteger(info.per_page) && info.per_page > 0) return page * info.per_page < info.total_count ? page + 1 : null;
  return count < perPage ? null : page + 1;
}

// Milliseconds to wait before retry number `attempt` (0-based). A usable Retry-After is honored (plus up to 250 ms of jitter) and the result never exceeds capMs.
export function backoffMs(attempt, retryAfter, rand = Math.random, { baseMs = BACKOFF_BASE_MS, capMs = BACKOFF_CAP_MS, now = Date.now } = {}) {
  let wait = null;
  if (retryAfter !== null && retryAfter !== undefined && String(retryAfter).trim() !== "") {
    const raw = String(retryAfter).trim();
    if (/^\d+$/.test(raw)) wait = Number(raw) * 1000;
    else { const at = Date.parse(raw); if (Number.isFinite(at)) wait = Math.max(0, at - now()); }
  }
  if (wait !== null) return Math.min(capMs, wait + Math.floor(rand() * 250));
  const exp = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.min(capMs, Math.floor(exp / 2 + rand() * (exp / 2)));
}

// Real runs need the exact string "false" (what the workflow's boolean input renders as). No trim, no case folding, no coercion: anything else is a dry run.
export const isDryRun = (value) => value !== "false";
const clean = (v) => String(v ?? "").replace(/[\r\n\s]/g, "").replace(/^["']|["']$/g, "");

// Repo-relative private paths -> the URLs to purge. Only leeroy.party can be purged through the zone API; the pages.dev URLs are returned separately so the log can say so.
export function purgeTargets() {
  const paths = [...PRIVATE_DATA_FILES, ...Object.keys(STRIPPED_FILES)];
  return { zone: paths.map((p) => `https://${ZONE_NAME}/${p}`), pagesDev: paths.map((p) => `https://${PAGES_DEV_HOST}/${p}`) };
}

// ---- API plumbing ----

function makeLogger(log, secrets) {
  const hidden = secrets.filter((s) => typeof s === "string" && s.length >= 4);
  return (line) => {
    let out = String(line);
    for (const s of hidden) out = out.split(s).join("***");
    log(out);
  };
}

async function safeJson(res) { try { return await res.json(); } catch { return null; } }

// One API call with retry on 429, 5xx and network errors. Returns { status, json } (status 0 = the network never answered). Never throws, never logs.
async function cf(ctx, method, urlPath, body) {
  const headers = { Authorization: `Bearer ${ctx.token}`, Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  for (let attempt = 0; ; attempt++) {
    let res = null;
    try { res = await ctx.fetch(`${API}${urlPath}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }); } catch { res = null; }
    const retryable = !res || res.status === 429 || res.status >= 500;
    if (!retryable) return { status: res.status, json: await safeJson(res) };
    if (attempt >= ctx.maxRetries) return { status: res ? res.status : 0, json: res ? await safeJson(res) : null };
    await ctx.sleep(backoffMs(attempt, res ? res.headers?.get?.("retry-after") : null, ctx.rand));
  }
}

const isAuthFailure = (r) => r.status === 401 || r.status === 403 || (isObj(r.json) && Array.isArray(r.json.errors) && r.json.errors.some((e) => isObj(e) && AUTH_CODES.has(e.code)));

function makeCtx(opts) {
  const env = opts.env || {};
  const token = clean(env.CLOUDFLARE_API_TOKEN);
  const account = clean(env.CLOUDFLARE_ACCOUNT_ID);
  const project = clean(env.PAGES_PROJECT_NAME);
  const say = makeLogger(opts.log || console.log, [token, account, env.CLOUDFLARE_API_TOKEN, env.CLOUDFLARE_ACCOUNT_ID]);
  return {
    token, account, project, say,
    fetch: opts.fetch || globalThis.fetch,
    sleep: opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms))),
    rand: opts.rand || Math.random,
    maxRetries: opts.maxRetries ?? MAX_RETRIES,
    dryRun: isDryRun(env.DRY_RUN),
    env,
  };
}

// Lists every deployment, page by page. Throws FailClosed when the list cannot be read to its end (so no partial list ever reaches the delete step).
export async function listAllDeployments(ctx) {
  const all = [];
  const seen = new Set();
  let malformed = 0;
  let page = 1;
  for (let n = 0; page !== null; n++) {
    if (n >= MAX_PAGES) throw new FailClosed(`the deployment list did not end after ${MAX_PAGES} pages`);
    const r = await cf(ctx, "GET", `/accounts/${encodeURIComponent(ctx.account)}/pages/projects/${encodeURIComponent(ctx.project)}/deployments?page=${page}&per_page=${PER_PAGE}`);
    if (r.status !== 200) throw new FailClosed(`listing deployments failed (HTTP ${r.status}, page ${page})`);
    const parsed = parseDeployments(r.json);
    const fresh = parsed.items.filter((d) => !seen.has(d.id));
    if (parsed.items.length > 0 && fresh.length === 0) throw new FailClosed(`pagination did not advance (page ${page} repeated known deployments)`);
    for (const d of fresh) { seen.add(d.id); all.push(d); }
    malformed += parsed.malformed;
    page = nextPage({ page, perPage: PER_PAGE, count: parsed.items.length + parsed.malformed, resultInfo: r.json.result_info });
  }
  return { items: all, malformed };
}

async function runPool(items, limit, fn) {
  let next = 0;
  const worker = async () => { while (next < items.length) { const item = items[next++]; await fn(item); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// ---- step 1: prune ----

export async function prune(opts) {
  const ctx = makeCtx(opts);
  const say = ctx.say;
  if (!ctx.token || !ctx.account || !ctx.project) { say("pages-prune: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID or PAGES_PROJECT_NAME is not set. Nothing was changed."); return 1; }
  const maxDelete = ctx.env.MAX_DELETE === undefined || String(ctx.env.MAX_DELETE).trim() === "" ? DEFAULT_MAX_DELETE : Number(String(ctx.env.MAX_DELETE).trim());
  if (!Number.isInteger(maxDelete) || maxDelete < 0) { say("pages-prune: MAX_DELETE is not a whole number. Nothing was changed."); return 1; }
  say(`pages-prune: ${ctx.dryRun ? "DRY RUN (nothing will be changed)" : "REAL RUN (deployments will be deleted)"}; project ${ctx.project}`);

  let plan;
  try {
    const p = await cf(ctx, "GET", `/accounts/${encodeURIComponent(ctx.account)}/pages/projects/${encodeURIComponent(ctx.project)}`);
    if (p.status !== 200) throw new FailClosed(`reading the project failed (HTTP ${p.status})`);
    const production = productionIdsFromProject(p.json);
    const listed = await listAllDeployments(ctx);
    plan = pickKeepSet(listed.items, production);
    if (listed.malformed) say(`pages-prune: ${listed.malformed} list entries had no usable id and are left alone`);
  } catch (e) {
    if (e instanceof FailClosed) { say(`pages-prune: FAILED CLOSED: ${e.message}. Nothing was deleted.`); return 1; }
    say("pages-prune: FAILED CLOSED: unexpected error while reading. Nothing was deleted.");
    return 1;
  }

  const { counts } = plan;
  const byEnv = Object.entries(counts.byEnvironment).map(([env, c]) => `${env} ${c.total} (delete ${c.remove})`).join(", ");
  say(`pages-prune: total ${counts.total}, keep ${counts.keep}, ${ctx.dryRun ? "would delete" : "to delete"} ${counts.remove}; by environment: ${byEnv || "none"}`);
  if (counts.remove > maxDelete) { say(`pages-prune: STOPPED: ${counts.remove} deployments qualify, which is more than the cap of ${maxDelete}. Nothing was deleted. Raise max_delete on purpose to go on.`); return 1; }
  if (ctx.dryRun) { say("pages-prune: dry run finished. Nothing was changed. Run again with dry_run unticked to delete."); return 0; }
  if (counts.remove === 0) { say("pages-prune: nothing to delete."); return 0; }

  let done = 0, deleted = 0, gone = 0, failed = 0, aborted = false;
  await runPool(plan.remove, DELETE_CONCURRENCY, async (id) => {
    if (aborted) return;
    const r = await cf(ctx, "DELETE", `/accounts/${encodeURIComponent(ctx.account)}/pages/projects/${encodeURIComponent(ctx.project)}/deployments/${encodeURIComponent(id)}?force=true`);
    if (r.status === 200 && r.json && r.json.success !== false) deleted++;
    else if (r.status === 404) gone++;
    else if (isAuthFailure(r)) { failed++; if (!aborted) { aborted = true; say("pages-prune: STOPPED: the token is not allowed to delete Pages deployments (needs Account > Cloudflare Pages > Edit)."); } }
    else failed++;
    done++;
    if (done % PROGRESS_EVERY === 0) say(`pages-prune: progress ${done}/${counts.remove} (deleted ${deleted}, already gone ${gone}, failed ${failed})`);
  });
  say(`pages-prune: finished. deleted ${deleted}, already gone ${gone}, failed ${failed}, not attempted ${counts.remove - done}`);
  return failed > 0 || done < counts.remove ? 1 : 0;
}

// ---- step 2: purge the edge cache ----

export async function purge(opts) {
  const ctx = makeCtx(opts);
  const say = ctx.say;
  const targets = purgeTargets();
  say(`cache purge: ${targets.zone.length} URLs on ${ZONE_NAME}; ${targets.pagesDev.length} on ${PAGES_DEV_HOST} cannot be purged (pages.dev is not a zone of this account): those cache entries expire on their own and the old deployments that back them are removed by the prune step`);
  if (ctx.dryRun) { say(`cache purge: DRY RUN, would purge ${targets.zone.length} URLs on ${ZONE_NAME}. Nothing was changed.`); return 0; }
  if (!ctx.token) { say("cache purge skipped: no token"); return 0; }
  const skip = (why) => { say(`::warning::cache purge skipped: ${why}`); return 0; };
  try {
    const z = await cf(ctx, "GET", `/zones?name=${encodeURIComponent(ZONE_NAME)}`);
    if (isAuthFailure(z)) { say(PURGE_SKIP_LINE); return 0; }
    if (z.status !== 200 || !isObj(z.json) || !Array.isArray(z.json.result)) return skip(`zone lookup failed (HTTP ${z.status})`);
    const zone = z.json.result.find((r) => isObj(r) && r.name === ZONE_NAME && typeof r.id === "string" && /^[0-9a-f]{32}$/i.test(r.id));
    if (!zone) return skip("the token cannot see the zone (check Zone > Zone Read and the zone scope), or it does not exist");
    let purged = 0;
    for (let i = 0; i < targets.zone.length; i += 30) {
      const chunk = targets.zone.slice(i, i + 30);
      const r = await cf(ctx, "POST", `/zones/${zone.id}/purge_cache`, { files: chunk });
      if (isAuthFailure(r)) { say(PURGE_SKIP_LINE); return 0; }
      if (r.status !== 200 || !isObj(r.json) || r.json.success !== true) return skip(`the purge call failed (HTTP ${r.status})`);
      purged += chunk.length;
    }
    say(`cache purge: purged ${purged} URLs on ${ZONE_NAME}`);
    return 0;
  } catch {
    return skip("unexpected error");
  }
}

// ---- CLI ----

export async function main(argv = process.argv.slice(2), opts = {}) {
  const step = argv[0];
  const run = { env: process.env, ...opts };
  if (step === "prune") return prune(run);
  if (step === "purge") return purge(run);
  (opts.log || console.error)("usage: node tools/pages-prune.mjs prune|purge");
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().then((code) => { process.exitCode = code; }, () => { console.error("pages-prune: unexpected failure"); process.exitCode = 1; });
}
