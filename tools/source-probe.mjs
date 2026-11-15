#!/usr/bin/env node
// Source probe: measures what fetching allow-listed public pages would cost a Cloudflare Worker, before the research pipeline is built
// (docs/adr/0011-research-sources-and-hotfix-index.md). No dependencies.
//
// Usage:
//   node tools/source-probe.mjs --out <dir> [--live] [--config <file>] [--fixtures <dir>] [--max-bytes n] [--timeout ms] [--delay ms]
//
// The default (also spelled --dry-run) reads recorded fixtures (tests/unit/fixtures/source-probe/manifest.json) and makes NO network call.
// Only with --live does the tool fetch the listed public pages from this machine, one at a time, with a delay. The result describes this
// machine's network and Node's CPU, not Cloudflare's edge: the CPU figure is an estimate (see the report notes).
//
// Rules the tool enforces (each has a test in tests/unit/source-probe.test.mjs):
//   - https only; the host must be in allowedHosts (exact match), else the source is refused and nothing is fetched
//   - robots.txt of the host is read first; Disallow for our user agent means the page is not fetched
//   - redirects are followed by hand, same host only, at most maxRedirects; a redirect to another host is recorded, not followed
//   - the body is read up to maxBytes, then cancelled
//   - page text is parsed for measurement only and is never written to the report (only counts and hashes of length)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CONFIG = path.join(HERE, "source-probe.sources.json");
export const DEFAULT_FIXTURES = path.join(HERE, "..", "tests", "unit", "fixtures", "source-probe");
export const WORKERS_FREE_CPU_MS = 10;
export const DEFAULT_LIMITS = { timeoutMs: 10000, maxBytes: 256 * 1024, maxRedirects: 3, delayMs: 1500 };
export const CPU_PASSES = 5;

// ---------- guards ----------

export function checkSourceUrl(urlText, allowedHosts) {
  let u;
  try {
    u = new URL(urlText);
  } catch {
    return { ok: false, reason: "bad_url" };
  }
  if (u.protocol !== "https:") return { ok: false, reason: "not_https" };
  if (u.username || u.password) return { ok: false, reason: "credentials_in_url" };
  const host = u.hostname.toLowerCase();
  const allowed = (allowedHosts || []).map((h) => String(h).toLowerCase());
  if (!allowed.includes(host)) return { ok: false, reason: "host_not_allowed" };
  return { ok: true, url: u, host };
}

// ---------- robots.txt (RFC 9309 subset: groups, Allow/Disallow, * and $, longest match wins, Allow wins a tie) ----------

export function parseRobots(text) {
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const i = line.indexOf(":");
    if (i < 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const val = line.slice(i + 1).trim();
    if (key === "user-agent") {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], rules: [] };
        groups.push(cur);
      }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else if (key === "allow" || key === "disallow") {
      lastWasAgent = false;
      if (cur) cur.rules.push({ allow: key === "allow", pattern: val });
    } else {
      lastWasAgent = false;
    }
  }
  return groups;
}

function patternToRegex(pattern) {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const re = body.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp("^" + re + (anchored ? "$" : ""));
}

// Merges all groups that match our product token or "*", then applies the rules to a path+query (longest match wins, Allow wins a tie).
export function robotsAllows(groups, userAgent, pathAndQuery) {
  const product = String(userAgent || "").split("/")[0].toLowerCase();
  // Every group that names our product token or "*" applies, and their rules are merged. This is stricter than RFC 9309
  // (which lets a specific group replace "*"): a crawler that is not sure should obey the more restrictive reading.
  const matching = groups.filter((g) => g.agents.some((a) => a === "*" || (a && (product === a || product.includes(a)))));
  if (!matching.length) return { allowed: true, matched: null };
  const rules = matching.flatMap((g) => g.rules);
  let match = null;
  for (const r of rules) {
    if (!r.pattern) continue; // an empty Disallow allows everything
    if (!patternToRegex(r.pattern).test(pathAndQuery)) continue;
    if (!match || r.pattern.length > match.pattern.length || (r.pattern.length === match.pattern.length && r.allow && !match.allow)) match = r;
  }
  if (!match) return { allowed: true, matched: null };
  return { allowed: match.allow, matched: `${match.allow ? "Allow" : "Disallow"}: ${match.pattern}` };
}

// ---------- body reading ----------

export async function readCapped(resp, maxBytes) {
  if (!resp.body || typeof resp.body.getReader !== "function") {
    const full = await resp.text();
    return { text: full.slice(0, maxBytes), bytes: Math.min(Buffer.byteLength(full), maxBytes), truncated: full.length > maxBytes };
  }
  const reader = resp.body.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    chunks.push(value);
    if (total >= maxBytes) {
      truncated = total > maxBytes;
      // A body of exactly maxBytes may or may not have more: peek once.
      if (!truncated) {
        const peek = await reader.read();
        truncated = !peek.done;
      }
      await reader.cancel().catch(() => {});
      break;
    }
  }
  const all = new Uint8Array(Math.min(total, maxBytes));
  let off = 0;
  for (const c of chunks) {
    const take = Math.min(c.byteLength, all.length - off);
    if (take <= 0) break;
    all.set(c.subarray(0, take), off);
    off += take;
  }
  return { text: new TextDecoder().decode(all), bytes: all.length, truncated };
}

// ---------- the naive HTML-to-text pass that is measured (same shape as stripHtmlToText in infrastructure/worker/scraper.js) ----------

export function htmlToText(rawHtml) {
  return String(rawHtml || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/gi, (_, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " })[e.toLowerCase()] || " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 24000);
}

// Median CPU of CPU_PASSES runs of htmlToText, from process.cpuUsage (user + system, microseconds). Returns numbers only, never text.
export function measureParseCpu(html, passes = CPU_PASSES) {
  const samples = [];
  let textChars = 0;
  for (let i = 0; i < passes; i++) {
    const before = process.cpuUsage();
    const text = htmlToText(html);
    const d = process.cpuUsage(before);
    textChars = text.length;
    samples.push(d.user + d.system);
  }
  samples.sort((a, b) => a - b);
  const medianMicros = samples[Math.floor(samples.length / 2)];
  const cpuMs = medianMicros / 1000;
  return {
    passes,
    medianMicros,
    maxMicros: samples[samples.length - 1],
    cpuMs,
    textChars,
    budgetMs: WORKERS_FREE_CPU_MS,
    fractionOfBudget: cpuMs / WORKERS_FREE_CPU_MS,
    note: "Node on this machine, one regex pass; not the workerd runtime. process.cpuUsage has coarse resolution on some systems.",
  };
}

// Heuristic: does the server-sent HTML carry the content, or is it a shell that needs a script to fill it?
export function needsJsHeuristic(html, textChars) {
  const reasons = [];
  const h = String(html || "");
  const scriptBytes = (h.match(/<script[\s\S]*?<\/script>/gi) || []).reduce((n, s) => n + s.length, 0);
  if (/<div[^>]+id=["'](root|app|__next|__nuxt)["'][^>]*>\s*<\/div>/i.test(h)) reasons.push("empty_app_root");
  if (/<noscript[^>]*>[^<]*(enable javascript|requires javascript|javascript is required)/i.test(h)) reasons.push("noscript_asks_for_js");
  if (textChars < 400 && scriptBytes > textChars * 2) reasons.push("little_text_much_script");
  if (/__NEXT_DATA__|__NUXT__|__INITIAL_STATE__/.test(h) && textChars < 400) reasons.push("state_blob_little_text");
  return { needsJs: reasons.length > 0, reasons, scriptBytes };
}

// ---------- one source ----------

function pathAndQuery(u) {
  return u.pathname + u.search;
}

async function getRobots(host, ctx) {
  if (ctx.robotsCache.has(host)) return ctx.robotsCache.get(host);
  const robotsUrl = `https://${host}/robots.txt`;
  let entry;
  try {
    const resp = await ctx.fetchFn(robotsUrl, { method: "GET", headers: { "User-Agent": ctx.userAgent }, redirect: "manual", signal: AbortSignal.timeout(ctx.limits.timeoutMs) });
    ctx.requestCount++;
    if (resp.status >= 200 && resp.status < 300) {
      const { text } = await readCapped(resp, 512 * 1024);
      entry = { status: resp.status, groups: parseRobots(text), state: "read" };
    } else if (resp.status >= 400 && resp.status < 500) {
      entry = { status: resp.status, groups: [], state: "absent_allow_all" }; // RFC 9309: unavailable means no rules
    } else {
      entry = { status: resp.status, groups: [], state: "unreachable_deny" }; // 5xx or redirect: treated as deny to be safe
    }
  } catch (e) {
    entry = { status: null, groups: [], state: "unreachable_deny", error: String((e && e.name) || "error") };
  }
  ctx.robotsCache.set(host, entry);
  return entry;
}

export async function probeSource(source, ctx) {
  const out = {
    id: source.id,
    kind: source.kind || null,
    url: source.url,
    outcome: null,
    refusal: null,
    robots: null,
    status: null,
    contentType: null,
    contentLengthHeader: null,
    bytes: 0,
    truncated: false,
    redirects: [],
    ms: null,
    needsJs: null,
    cpu: null,
    error: null,
  };
  const check = checkSourceUrl(source.url, ctx.allowedHosts);
  if (!check.ok) {
    out.outcome = "refused";
    out.refusal = check.reason;
    return out;
  }
  const started = performance.now();
  let target = check.url;
  try {
    for (let hop = 0; hop <= ctx.limits.maxRedirects; hop++) {
      const robots = await getRobots(target.hostname.toLowerCase(), ctx);
      if (robots.state === "unreachable_deny") {
        out.robots = { verdict: "deny", reason: "robots_unreachable", robotsStatus: robots.status };
        out.outcome = "robots_deny";
        return out;
      }
      const verdict = robotsAllows(robots.groups, ctx.userAgent, pathAndQuery(target));
      out.robots = { verdict: verdict.allowed ? "allow" : "deny", rule: verdict.matched, robotsStatus: robots.status, state: robots.state };
      if (!verdict.allowed) {
        out.outcome = "robots_deny";
        return out;
      }
      const resp = await ctx.fetchFn(target.toString(), { method: "GET", headers: { "User-Agent": ctx.userAgent, Accept: "text/html,*/*;q=0.5" }, redirect: "manual", signal: AbortSignal.timeout(ctx.limits.timeoutMs) });
      ctx.requestCount++;
      out.status = resp.status;
      if (resp.status >= 300 && resp.status < 400 && resp.status !== 304) {
        const loc = resp.headers.get("location");
        const rec = { from: target.toString(), status: resp.status, to: loc || null, followed: false, reason: null };
        out.redirects.push(rec);
        let next = null;
        try {
          next = loc ? new URL(loc, target) : null;
        } catch {
          next = null;
        }
        if (!next) {
          rec.reason = "no_or_bad_location";
          out.outcome = "redirect_unusable";
          return out;
        }
        if (next.protocol !== "https:") {
          rec.reason = "not_https";
          out.outcome = "redirect_refused";
          return out;
        }
        if (next.hostname.toLowerCase() !== target.hostname.toLowerCase()) {
          rec.reason = "cross_host_not_followed";
          out.outcome = "redirect_cross_host";
          return out;
        }
        rec.followed = true;
        target = next;
        if (hop === ctx.limits.maxRedirects) {
          rec.followed = false;
          rec.reason = "too_many_redirects";
          out.outcome = "redirect_limit";
          return out;
        }
        continue;
      }
      out.contentType = resp.headers.get("content-type");
      out.contentLengthHeader = resp.headers.get("content-length") ? Number(resp.headers.get("content-length")) : null;
      if (!resp.ok) {
        out.outcome = "http_error";
        return out;
      }
      const body = await readCapped(resp, ctx.limits.maxBytes);
      out.bytes = body.bytes;
      out.truncated = body.truncated;
      out.cpu = measureParseCpu(body.text);
      const js = needsJsHeuristic(body.text, out.cpu.textChars);
      out.needsJs = { needsJs: js.needsJs, reasons: js.reasons };
      out.outcome = body.truncated ? "ok_truncated" : "ok";
      return out;
    }
    out.outcome = "redirect_limit";
    return out;
  } catch (e) {
    out.outcome = "error";
    out.error = String((e && e.name) || "Error") + ": " + String((e && e.message) || "").slice(0, 120);
    return out;
  } finally {
    out.ms = Math.round((performance.now() - started) * 10) / 10;
  }
}

// ---------- run + report ----------

export async function runProbe(config, opts = {}) {
  const limits = { ...DEFAULT_LIMITS, ...(config.limits || {}), ...(opts.limits || {}) };
  const ctx = {
    fetchFn: opts.fetchFn,
    userAgent: config.userAgent || "LeeroyBoard-CloudflareWorker/1.0",
    allowedHosts: config.allowedHosts || [],
    limits,
    robotsCache: new Map(),
    requestCount: 0,
  };
  if (typeof ctx.fetchFn !== "function") throw new Error("runProbe needs opts.fetchFn");
  const results = [];
  for (const s of config.sources || []) {
    results.push(await probeSource(s, ctx));
    if (opts.delayMs && !opts.dryRun) await new Promise((r) => setTimeout(r, opts.delayMs));
  }
  return buildReport(config, results, { mode: opts.dryRun ? "dry-run" : "live", limits, requestCount: ctx.requestCount, now: opts.now });
}

export function buildReport(config, results, meta) {
  const counts = {};
  for (const r of results) counts[r.outcome] = (counts[r.outcome] || 0) + 1;
  const cpus = results.filter((r) => r.cpu).map((r) => r.cpu.cpuMs);
  return {
    tool: "source-probe",
    version: 1,
    generatedAt: new Date(meta.now || Date.now()).toISOString(),
    mode: meta.mode,
    network: meta.mode === "live",
    userAgent: config.userAgent,
    limits: meta.limits,
    requestCount: meta.requestCount,
    summary: {
      sources: results.length,
      outcomes: counts,
      maxParseCpuMs: cpus.length ? Math.max(...cpus) : null,
      anyOverCpuBudget: cpus.some((c) => c >= WORKERS_FREE_CPU_MS),
      needsJs: results.filter((r) => r.needsJs && r.needsJs.needsJs).map((r) => r.id),
    },
    notes: [
      meta.mode === "dry-run" ? "DRY RUN: fixtures only, fictional pages, no network. Numbers say nothing about the real sites." : "LIVE: measured from the machine that ran the tool, not from Cloudflare's edge.",
      `CPU figures are Node process.cpuUsage over a regex pass, an estimate for the ${WORKERS_FREE_CPU_MS} ms Workers Free CPU limit, not a workerd measurement.`,
      "Page text is not stored in this report.",
    ],
    results,
  };
}

export function renderMarkdown(report) {
  const L = [];
  L.push(`# Source probe report`);
  L.push("");
  L.push(`Mode: ${report.mode}. Generated ${report.generatedAt}. User agent: \`${report.userAgent}\`. Requests made: ${report.requestCount}.`);
  L.push("");
  for (const n of report.notes) L.push(`- ${n}`);
  L.push("");
  L.push(`| id | outcome | status | content-type | bytes | ms | robots | redirects | needs JS | parse CPU ms |`);
  L.push(`|---|---|---|---|---|---|---|---|---|---|`);
  for (const r of report.results) {
    const rob = r.robots ? r.robots.verdict + (r.robots.rule ? ` (${r.robots.rule})` : "") : "-";
    const red = r.redirects.length ? r.redirects.map((x) => `${x.status}${x.followed ? "" : " not followed: " + x.reason}`).join("; ") : "-";
    const js = r.needsJs ? (r.needsJs.needsJs ? "yes: " + r.needsJs.reasons.join(",") : "no") : "-";
    const cpu = r.cpu ? r.cpu.cpuMs.toFixed(3) : "-";
    const cell = (v) => String(v == null ? "-" : v).replace(/\|/g, "/");
    L.push(`| ${cell(r.id)} | ${cell(r.outcome + (r.refusal ? ": " + r.refusal : ""))} | ${cell(r.status)} | ${cell(r.contentType)} | ${cell(r.bytes)}${r.truncated ? " (truncated)" : ""} | ${cell(r.ms)} | ${cell(rob)} | ${cell(red)} | ${cell(js)} | ${cpu} |`);
  }
  L.push("");
  L.push(`Outcomes: ${Object.entries(report.summary.outcomes).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}.`);
  L.push(`Max parse CPU: ${report.summary.maxParseCpuMs == null ? "n/a" : report.summary.maxParseCpuMs.toFixed(3) + " ms"} of ${WORKERS_FREE_CPU_MS} ms budget. Over budget: ${report.summary.anyOverCpuBudget ? "yes" : "no"}.`);
  L.push(`Sources needing JS: ${report.summary.needsJs.length ? report.summary.needsJs.join(", ") : "none"}.`);
  L.push("");
  return L.join("\n");
}

// ---------- dry-run fetch from fixtures ----------

export function makeFixtureFetch(manifest, fixturesDir, log) {
  return async function fixtureFetch(url) {
    if (log) log.push(url);
    const rec = manifest.responses && manifest.responses[url];
    if (!rec) return new Response("no fixture", { status: 404, headers: { "content-type": "text/plain" } });
    let body = rec.body != null ? rec.body : "";
    if (rec.file) body = fs.readFileSync(path.join(fixturesDir, rec.file), "utf8");
    const headers = {};
    if (rec.contentType) headers["content-type"] = rec.contentType;
    if (rec.location) headers["location"] = rec.location;
    if (rec.status === 204 || rec.status === 304) body = null;
    return new Response(body, { status: rec.status || 200, headers });
  };
}

// ---------- CLI ----------

function parseArgs(argv) {
  const a = { dryRun: false, live: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--dry-run") a.dryRun = true;
    else if (k === "--live") a.live = true;
    else if (["--out", "--config", "--fixtures", "--max-bytes", "--timeout", "--delay"].includes(k)) a[k.slice(2)] = argv[++i];
    else throw new Error(`unknown argument ${k}`);
  }
  if (a.live && a.dryRun) throw new Error("--live and --dry-run cannot be combined");
  a.dryRun = !a.live; // offline fixtures unless --live is given
  return a;
}

export async function main(argv) {
  const args = parseArgs(argv);
  if (!args.out) throw new Error("--out <dir> is required");
  const config = JSON.parse(fs.readFileSync(args.config || DEFAULT_CONFIG, "utf8"));
  const limits = {};
  if (args["max-bytes"]) limits.maxBytes = Number(args["max-bytes"]);
  if (args.timeout) limits.timeoutMs = Number(args.timeout);
  if (args.delay) limits.delayMs = Number(args.delay);
  let fetchFn;
  if (args.dryRun) {
    const dir = args.fixtures || DEFAULT_FIXTURES;
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
    fetchFn = makeFixtureFetch(manifest, dir);
  } else {
    fetchFn = (...a) => globalThis.fetch(...a); // the only place the network is reachable: --live
  }
  const merged = { ...DEFAULT_LIMITS, ...(config.limits || {}), ...limits };
  const report = await runProbe(config, { fetchFn, dryRun: args.dryRun, limits, delayMs: merged.delayMs });
  fs.mkdirSync(args.out, { recursive: true });
  fs.writeFileSync(path.join(args.out, "source-probe-report.json"), JSON.stringify(report, null, 2) + "\n");
  fs.writeFileSync(path.join(args.out, "source-probe-report.md"), renderMarkdown(report));
  console.log(`source-probe ${report.mode}: ${report.results.length} sources, outcomes ${JSON.stringify(report.summary.outcomes)}; wrote ${args.out}`);
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error("source-probe:", e.message);
    process.exit(1);
  });
}
