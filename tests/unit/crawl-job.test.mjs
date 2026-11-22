// The preview crawl hides a member of the preview for about 15 s, so it runs in its own job AFTER every other job that reads the preview, and the api job repairs what a cancelled crawl left behind
// BEFORE its first test. The report gate includes the crawl. Needs the `yaml` package (tests/package.json).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { buildReport } from "../../tools/ci-report.mjs";
import { recoverTarget, PLANTED_MARKER } from "../helpers/preview-crawl.mjs";

const wf = parse(readFileSync(fileURLToPath(new URL("../../.github/workflows/preview-tests.yml", import.meta.url)), "utf8"));
const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
const needs = (j) => [].concat(wf.jobs[j].needs || []);
const runs = (j) => wf.jobs[j].steps.map((s) => s.run || "").join("\n");

test("the crawl is its own job and needs every other job that reads the preview", () => {
  assert.ok(wf.jobs.crawl, "a crawl job");
  for (const j of ["scope", "preview", "api", "browser", "layout", "visual-audit"]) assert.ok(needs("crawl").includes(j), `crawl needs ${j}`);
  assert.ok(!/preview-crawl/.test(pkg.scripts["test:api"]), "the crawl is not part of test:api (it would run beside the other api tests)");
  assert.match(pkg.scripts["test:crawl"], /api\/preview-crawl\.test\.mjs/);
  assert.match(runs("crawl"), /npm run test:crawl/);
  assert.ok(!/test:crawl|preview-crawl/.test(runs("api")), "the api job does not run the crawl");
});

test("the crawl runs whenever api runs, whatever the other jobs returned, and never on a cancelled run", () => {
  const c = wf.jobs.crawl.if, a = wf.jobs.api.if;
  assert.match(c, /!cancelled\(\)/, "a status function: a failed or skipped need does not skip it");
  assert.match(c, /needs\.scope\.outputs\.api_needed == 'true'/);
  assert.ok(a.includes("needs.scope.outputs.api_needed == 'true'"), "the api job's own scope rule");
  assert.match(c, /needs\.preview\.result == 'success'/);
});

test("the api job restores the target member before its first test", () => {
  const r = runs("api");
  assert.ok(r.includes("npm run test:recover") && r.indexOf("npm run test:recover") < r.indexOf("npm run test:api"), "recover first");
  assert.match(pkg.scripts["test:recover"], /api\/recover-preview\.mjs/);
});

test("the report waits for the crawl and the result reaches ci-report", () => {
  assert.ok(needs("report").includes("crawl"));
  const env = wf.jobs.report.steps.find((s) => s.id === "build").env;
  assert.equal(env.CRAWL_RESULT, "${{ needs.crawl.result }}");
  assert.match(wf.jobs.report.steps.map((s) => (s.env && s.env.RESULTS) || "").join(""), /crawl=\$\{\{ needs\.crawl\.result \}\}/);
});

const base = { sha7: "abc1234", full: true, docsOnly: false, previewSkipped: false, runUrl: "u", pagesUrl: "p", counts: {}, siteChanged: true };
const res = (o) => ({ unit: "success", stamps: "success", api: "success", crawl: "success", browser: "success", layout: "success", ...o });
test("the gate needs the crawl: a failed, cancelled, missing or wrongly skipped crawl never passes", () => {
  assert.equal(buildReport({ ...base, apiNeeded: true, results: res({}) }).pass, true);
  for (const crawl of ["failure", "cancelled", "skipped", "missing"]) assert.equal(buildReport({ ...base, apiNeeded: true, results: res({ crawl }) }).pass, false, crawl);
  for (const crawl of ["failure", "cancelled"]) assert.equal(buildReport({ ...base, apiNeeded: false, results: res({ api: "skipped", crawl }) }).pass, false);
  // no Worker or API change: both are absent together and that passes
  assert.equal(buildReport({ ...base, apiNeeded: false, results: res({ api: "skipped", crawl: "skipped" }) }).pass, true);
  // api success with the crawl absent, or crawl success with api absent: never
  assert.equal(buildReport({ ...base, apiNeeded: false, results: res({ api: "success", crawl: "skipped" }) }).pass, false);
  assert.equal(buildReport({ ...base, apiNeeded: false, results: res({ api: "skipped", crawl: "success" }) }).pass, false);
  const failed = buildReport({ ...base, apiNeeded: true, results: res({ crawl: "failure" }) });
  assert.match(failed.body, /\| API \| FAIL/);
});

test("recoverTarget writes nothing when no planted marker is present, and clears one that is", async () => {
  const fields = { race: { value: "undead", visible: true }, goals: { value: null, visible: true } };
  const posts = [];
  const adminCall = async (m, p, body) => {
    if (m === "POST") { posts.push(body); if (body.field in fields) fields[body.field] = { value: "value" in body ? body.value : fields[body.field].value, visible: body.visible !== false }; return { status: 200, text: "{}", headers: [] }; }
    return { status: 200, text: JSON.stringify({ slug: "x", name: "X", sheet: { fields } }), headers: [] };
  };
  assert.deepEqual(await recoverTarget({ adminCall }), { mine: { slug: "x", name: "X", sheet: { fields } }, recovered: false });
  assert.equal(posts.length, 0, "a clean member is left alone");
  fields.goals = { value: "qzgoalDEAD left over", visible: false };
  assert.ok(PLANTED_MARKER.test(fields.goals.value));
  const lines = [];
  const out = await recoverTarget({ adminCall, say: (s) => lines.push(s) });
  assert.equal(out.recovered, true);
  assert.ok(posts.length >= 9 && lines.length === 1);
  assert.equal(fields.goals.value, null);
});

test("a cheap recover job runs whenever the preview deployed, and every job that reads the preview needs it", () => {
  const r = wf.jobs.recover;
  assert.ok(r, "a recover job");
  assert.match(r.if, /!cancelled\(\)/);
  assert.match(r.if, /needs\.preview\.result == 'success'/);
  assert.ok(!/api_needed/.test(r.if), "whatever api_needed says");
  assert.ok(!r.steps.some((s) => /playwright|npm ci/i.test(`${s.run || ""} ${s.name || ""}`)), "no Playwright, no dependency install: node and the recover script only");
  assert.match(runs("recover"), /npm run test:recover/);
  for (const j of ["api", "browser", "layout", "visual-audit", "crawl"]) assert.ok(needs(j).includes("recover"), `${j} needs recover`);
  assert.match(wf.jobs.crawl.if, /needs\.recover\.result == 'success'/);
});
