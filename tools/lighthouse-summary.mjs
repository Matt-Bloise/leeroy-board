#!/usr/bin/env node
// Markdown summary of a Lighthouse CI run for the job summary ($GITHUB_STEP_SUMMARY): per URL the median run (by LCP) against the budgets of lighthouserc.json,
// and how many requests the page loads made to the Worker API (any request whose path starts with /api/, on any origin), so the cost in Worker requests is on the page.
//   node tools/lighthouse-summary.mjs [--dir .lighthouseci] [--config lighthouserc.json] [--target https://leeroy.party/]
// Reads the lhr-*.json files lhci wrote; writes nothing, sends nothing. Informational: it exits 0 whatever it finds.
import fs from "node:fs";
const argv = process.argv.slice(2), arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const DIR = arg("dir", ".lighthouseci"), CONFIG = arg("config", "lighthouserc.json"), TARGET = arg("target", "");
const kb = (n) => (n / 1000).toFixed(0) + " kB";
const FMT = { "largest-contentful-paint": (n) => (n / 1000).toFixed(1) + " s", "cumulative-layout-shift": (n) => n.toFixed(3), "total-byte-weight": kb, "resource-summary:script:size": kb, "resource-summary:image:size": kb };
const NAMES = { "largest-contentful-paint": "LCP", "cumulative-layout-shift": "CLS", "total-byte-weight": "Total bytes", "resource-summary:script:size": "JavaScript", "resource-summary:image:size": "Images" };
let matrix = []; try { matrix = JSON.parse(fs.readFileSync(CONFIG, "utf8")).ci.assert.assertMatrix; } catch (e) {}
const budgetFor = (url) => { const m = matrix.find((e) => new RegExp(e.matchingUrlPattern).test(url)), o = {}; if (m) for (const [k, v] of Object.entries(m.assertions)) o[k] = v[1].maxNumericValue; return o; };
const apiCalls = (lhr) => { try { return lhr.audits["network-requests"].details.items.filter((it) => { try { return /^\/api\//.test(new URL(it.url).pathname); } catch (e) { return false; } }).length; } catch (e) { return null; } };

const out = ["### Lighthouse, mobile 390x844: informational, never blocks", ""];
let files = []; try { files = fs.readdirSync(DIR).filter((f) => /^lhr-.*\.json$/.test(f)); } catch (e) {}
const byUrl = {};
for (const f of files) { try { const r = JSON.parse(fs.readFileSync(`${DIR}/${f}`, "utf8")); (byUrl[r.requestedUrl] ||= []).push(r); } catch (e) {} }
const urls = Object.keys(byUrl);
let totalRuns = 0, totalApi = 0, unknown = false;
if (!urls.length) out.push("Lighthouse produced no results (see the run log).");
for (const u of urls) {
  const runs = byUrl[u].sort((a, b) => a.audits["largest-contentful-paint"].numericValue - b.audits["largest-contentful-paint"].numericValue);
  const r = runs[Math.floor(runs.length / 2)];
  const val = { "largest-contentful-paint": r.audits["largest-contentful-paint"].numericValue, "cumulative-layout-shift": r.audits["cumulative-layout-shift"].numericValue, "total-byte-weight": r.audits["total-byte-weight"].numericValue };
  for (const it of r.audits["resource-summary"].details.items) { if (it.resourceType === "script") val["resource-summary:script:size"] = it.transferSize; if (it.resourceType === "image") val["resource-summary:image:size"] = it.transferSize; }
  const b = budgetFor(u), calls = runs.map(apiCalls);
  totalRuns += runs.length; if (calls.some((c) => c === null)) unknown = true; else totalApi += calls.reduce((a, c) => a + c, 0);
  out.push(`**\`${new URL(u).pathname}\`** (median of ${runs.length}, score ${Math.round(r.categories.performance.score * 100)}; Worker API requests per load: ${calls.map((c) => (c === null ? "?" : c)).join(", ")})`, "", "| Metric | Measured | Budget | |", "| :--- | ---: | ---: | :--- |");
  for (const k of Object.keys(NAMES)) { const v = val[k]; if (v === undefined) continue; const over = b[k] !== undefined && v > b[k]; out.push(`| ${NAMES[k]} | ${FMT[k](v)} | ${b[k] !== undefined ? FMT[k](b[k]) : "-"} | ${over ? "over budget" : "ok"} |`); }
  out.push("");
}
if (urls.length) out.push(`**Worker requests made by this Lighthouse run: ${unknown ? "not measurable (no network-requests audit)" : totalApi}** (${totalRuns} page loads over ${urls.length} URLs; counted from Lighthouse's own request list, requests whose path starts with \`/api/\`).`, "");
if (TARGET) out.push(`Target: ${TARGET}`);
out.push("Lab numbers on a shared runner with simulated throttling; budgets are starting values, not targets. See docs/runbooks/lighthouse.md.");
console.log(out.join("\n"));
