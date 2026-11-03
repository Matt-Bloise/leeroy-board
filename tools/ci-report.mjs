// Builds the sticky result comment of .github/workflows/preview-tests.yml and decides the gate.
// The merge gate is a comment by github-actions[bot] whose heading matches GATE_RE for the head sha (docs/runbooks/ci-minutes.md).
// Only a run that executed the required suites emits "### Preview tests: passed (<sha7>)". A light run (no `ci-full` label) emits
// "### Light checks: ..." instead, which never matches. A skipped suite is never read as a pass: `skipped` only counts when the scope rule explains it.
// Usage in CI: env vars (see main below) -> node tools/ci-report.mjs <body-file>   (writes the comment body, sets ok=true|false in $GITHUB_OUTPUT)
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// The exact regex the owner's merge script must use on the body of the newest github-actions[bot] comment (flags: m). <sha7> is the first 7 hex characters of the head sha.
export const gateRegex = (sha7) => new RegExp("^### Preview tests: passed \\(`?" + sha7 + "`?\\)[ \\t]*\\r?$", "m");
export const GATE_RE_SOURCE = "^### Preview tests: passed \\(`?<sha7>`?\\)[ \\t]*\\r?$";
export const matchesGate = (body, sha7) => /^[0-9a-f]{7}$/.test(String(sha7)) && gateRegex(sha7).test(String(body));

const ok = (r) => r === "success";
const skipped = (r) => r === "skipped";

// in: { sha7, docsOnly, siteChanged, full, results: {unit, stamps, api, browser, layout}, counts: {uPass,uFail,aPass,aFail,bPass,bFail,lFail}, pagesUrl, failing, visual, runUrl }
// out: { body, pass, gate }  (gate: the body carries the merge-gate phrase)
export function buildReport(i) {
  const r = i.results;
  const unitStamps = ok(r.unit) && ok(r.stamps);
  let pass, mode, ran, notRun;
  if (i.docsOnly) {
    mode = "docs";
    pass = unitStamps;
    ran = "unit, stamps";
    notRun = "preview, api, browser, layout (docs only: nothing a visitor or the Worker runs changed)";
  } else if (i.full) {
    mode = "full";
    if (i.siteChanged) {
      pass = unitStamps && ok(r.api) && ok(r.browser) && ok(r.layout);
      ran = "unit, stamps, api, browser, layout";
      notRun = "none";
    } else {
      // Browser and layout may only be absent because the scope rule said no site, tooling, workflow, config or dependency file changed.
      pass = unitStamps && ok(r.api) && (skipped(r.browser) || ok(r.browser)) && (skipped(r.layout) || ok(r.layout));
      ran = "unit, stamps, api";
      notRun = "browser, layout (scope rule: no site, tools, .github, wrangler or package*.json file changed)";
    }
  } else {
    mode = "light";
    pass = unitStamps && skipped(r.api) && skipped(r.browser) && skipped(r.layout);
    ran = "unit, stamps";
    notRun = "preview, api, browser, layout (full suite not requested)";
  }
  const heading = mode === "light" ? "Light checks" : "Preview tests";
  const gate = pass && mode !== "light";
  const label = (outcome, name) => {
    if (outcome === "success") return "pass";
    if (outcome === "skipped") {
      if (mode === "docs") return "not run (docs only)";
      if (mode === "light") return "not run (full suite not requested)";
      return name === "browser" || name === "layout" ? (i.siteChanged ? "not run" : "not run (scope rule)") : "not run";
    }
    return "FAIL";
  };
  const cell = (v) => (v === null || v === undefined ? "-" : String(v));
  const c = i.counts || {};
  const lines = [
    "<!-- preview-tests -->",
    `### ${heading}: ${pass ? "passed" : "FAILED"} (\`${i.sha7}\`)`,
    "",
  ];
  if (mode === "docs" && pass) lines.push("**passed (docs only)**: this PR changes only docs, so no preview was created and only the unit and stamps suites ran.", "");
  if (mode === "light") {
    lines.push(
      pass
        ? "Full suite not requested: only unit and stamps ran. The API, browser and layout suites need the `ci-full` label, added when the PR is final. This comment is not the merge gate."
        : "Unit or stamps failed. The full suite was not requested (no `ci-full` label). This comment is not the merge gate.",
      ""
    );
  }
  if (mode === "full" && pass) lines.push(`Suites run: ${ran}. Not run: ${notRun}.`, "");
  lines.push(
    "| Suite | Result | Passed | Failed |",
    "| :--- | :--- | ---: | ---: |",
    `| Unit | ${label(r.unit, "unit")} | ${cell(c.uPass)} | ${cell(c.uFail)} |`,
    `| Stamps | ${label(r.stamps, "stamps")} | - | - |`,
    `| API | ${label(r.api, "api")} | ${cell(c.aPass)} | ${cell(c.aFail)} |`,
    `| Browser smoke (Chromium + WebKit) | ${label(r.browser, "browser")} | ${cell(c.bPass)} | ${cell(c.bFail)} |`,
    `| Layout sweep (Chromium) | ${label(r.layout, "layout")} | - | ${cell(c.lFail)} |`,
    ""
  );
  lines.push(mode === "docs" ? "No preview (docs only)." : mode === "light" ? "No preview (light run)." : i.pagesUrl ? `Preview: ${i.pagesUrl}` : "No preview URL was found.");
  if (i.failing && i.failing.length) lines.push("", "First failures:", "```", i.failing.join("\n").slice(0, 1500), "```");
  if (i.visual) lines.push("", "Visual audit (not gating): see artifact `visual-audit` on the run below.");
  lines.push(`[Logs and artifact](${i.runUrl})`);
  return { body: lines.join("\n"), pass, gate };
}

function parseLogs(dir) {
  const read = (f) => { try { return readFileSync(`${dir}/${f}`, "utf8"); } catch (e) { return ""; } };
  const unit = read("unit.log"), api = read("api.log"), br = read("browser.log"), lay = read("layout.log");
  const num = (re, s) => { const m = s.match(re); return m ? Number(m[1]) : null; };
  const counts = { uPass: num(/^\S+ pass (\d+)$/m, unit), uFail: num(/^\S+ fail (\d+)$/m, unit), aPass: num(/^\S+ pass (\d+)$/m, api), aFail: num(/^\S+ fail (\d+)$/m, api) };
  counts.bPass = num(/live-smoke: all (\d+) checks passed/, br);
  counts.bFail = counts.bPass === null ? null : 0;
  const bf = br.match(/live-smoke: (\d+) of (\d+) checks FAILED/);
  if (bf) { counts.bFail = Number(bf[1]); counts.bPass = Number(bf[2]) - counts.bFail; }
  const lm = lay.match(/layout-sweep: .*?(\d+) failures/);
  counts.lFail = lm ? Number(lm[1]) : null;
  const failing = [...br.split("\n"), ...lay.split("\n")].filter((l) => l.startsWith("FAIL ")).slice(0, 10);
  const apiFailing = api.split("\n").filter((l) => /^\S+ .* \(\d/.test(l) && !/^\S*✔/.test(l) && /fail|✖/i.test(l)).slice(0, 10);
  return { counts, failing: [...apiFailing, ...failing] };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const e = process.env;
  const { counts, failing } = parseLogs(`${e.RUNNER_TEMP || "."}/logs`);
  const out = buildReport({
    sha7: String(e.HEAD_SHA || "").slice(0, 7),
    docsOnly: e.DOCS_ONLY === "true",
    siteChanged: e.SITE_CHANGED === "true",
    full: e.FULL === "true",
    results: { unit: e.UNIT_RESULT, stamps: e.STAMPS_RESULT, api: e.API_RESULT, browser: e.BROWSER_RESULT, layout: e.LAYOUT_RESULT },
    counts, failing, pagesUrl: e.PAGES_URL || "", visual: e.VISUAL === "true", runUrl: e.RUN_URL || "",
  });
  writeFileSync(process.argv[2], out.body, "utf8");
  console.log(out.body);
  if (e.GITHUB_OUTPUT) appendFileSync(e.GITHUB_OUTPUT, `ok=${out.pass}\n`);
}
