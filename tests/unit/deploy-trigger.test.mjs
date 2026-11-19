// CI minutes: pins the production deploy trigger. paths-ignore may only list files the deploy never reads; the queueing contract stays.
// Needs the `yaml` package (tests/package.json). Run: node --test tests/unit/deploy-trigger.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { relative, resolve, dirname, sep } from "node:path";
import { parse } from "yaml";
import { LIGHT_TOOL_FILES, LIGHT_TOOL_DIRS } from "../../tools/docs-only.mjs";

const root = (p) => fileURLToPath(new URL("../../" + p, import.meta.url));
const text = readFileSync(root(".github/workflows/deploy-cloudflare.yml"), "utf8");
const wf = parse(text);
const on = wf.on ?? wf[true];
const ignore = on.push["paths-ignore"];

// GitHub glob subset used here: ** (any depth, any chars), * (no slash), literal otherwise.
function globToRe(g) {
  let r = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*" && g[i + 1] === "*") { r += ".*"; i++; if (g[i + 1] === "/") i++; }
    else if (c === "*") r += "[^/]*";
    else r += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + r + "$");
}
const ignored = (p) => ignore.some((g) => globToRe(g).test(p));

test("push still deploys master, and workflow_dispatch exists", () => {
  assert.deepEqual(on.push.branches, ["master"]);
  assert.ok("workflow_dispatch" in on);
  assert.equal(on.workflow_dispatch.inputs.allow_create_database.default, false);
  assert.equal(on.push.paths, undefined, "use paths-ignore, not paths");
});

test("paths-ignore is a list of known-safe globs", () => {
  assert.ok(Array.isArray(ignore) && ignore.length > 5);
  for (const g of ["docs/**", "tests/**", "**/*.md", ".github/ISSUE_TEMPLATE/**", ".claude/**"]) assert.ok(ignore.includes(g), g);
  for (const g of ignore) assert.ok(!g.startsWith("!"), "no negation: " + g);
});

test("nothing the deploy, the Pages bundle or wrangler reads is ignored", () => {
  const must = [
    ".github/workflows/deploy-cloudflare.yml", "index.html", "404.html", "_headers", "robots.txt", "wrangler.toml", "infrastructure/wrangler.toml", "infrastructure/schema.sql",
    "infrastructure/package.json", "infrastructure/package-lock.json", "infrastructure/flagship-flags.txt", "infrastructure/worker/index.js", "infrastructure/migrations/0001_x.sql",
    "infrastructure/scripts/seed-d1.mjs", "pages-worker/index.js", "pages-worker/private-paths.mjs", "js/brain.js", "css/shell.css", "scenes/sheet.js", "data/client.json", "data/library/a.json",
    "tools/pages-bundle.mjs", "tools/d1-row-count.mjs", "tools/flagship-ensure-flags.mjs", "tools/sync-discord-commands.mjs", "tools/strip-flagship-binding.mjs", "tools/static-server.mjs",
    "landing/index.html", "privacy/index.html", "terms/index.html", "vendor/x.js", "fonts/a.woff2", "img/a.png", "room/index.html", "rate/index.html", "next/index.html", "atlas/a.json", "cloth/a.js",
  ];
  for (const p of must) assert.equal(ignored(p), false, p);
  // every path the workflow text names as a deploy input
  const named = new Set();
  for (const m of text.slice(text.indexOf("permissions:")).matchAll(/(?:\.\.\/|\.\/)?((?:tools|infrastructure|pages-worker|data|js)\/[A-Za-z0-9_.\/-]+\.(?:mjs|js|sql|toml|json|txt))/g)) named.add(m[1]);
  assert.ok(named.has("tools/pages-bundle.mjs") && named.has("tools/sync-discord-commands.mjs"));
  for (const p of named) assert.equal(ignored(p), false, p);
  // every BUNDLE_ITEM of the Pages bundle
  const bundle = readFileSync(root("tools/pages-bundle.mjs"), "utf8");
  const items = JSON.parse(bundle.match(/BUNDLE_ITEMS = Object\.freeze\((\[[^\]]*\])\)/)[1]);
  for (const it of items) assert.equal(ignored(it + (/\./.test(it) ? "" : "/x.js")), false, it);
});

test("every ignored tools/ entry exists, and none is a deploy tool", () => {
  const deployTools = ["pages-bundle.mjs", "d1-row-count.mjs", "flagship-ensure-flags.mjs", "sync-discord-commands.mjs"];
  const toolGlobs = ignore.filter((g) => g.startsWith("tools/"));
  assert.ok(toolGlobs.length > 20);
  for (const g of toolGlobs) {
    const rel = g.replace(/\/\*\*$/, "");
    assert.ok(existsSync(root(rel)), g + " does not exist");
    assert.ok(!deployTools.some((d) => g === "tools/" + d), g);
  }
  // the scripts the deploy runs import nothing from an ignored tool (relative imports resolved against the repo root)
  for (const f of ["tools/pages-bundle.mjs", "tools/d1-row-count.mjs", "tools/flagship-ensure-flags.mjs", "tools/sync-discord-commands.mjs", "pages-worker/private-paths.mjs", "pages-worker/index.js", "infrastructure/scripts/seed-d1.mjs"]) {
    const src = readFileSync(root(f), "utf8");
    for (const m of src.matchAll(/from\s+"(\.[^"]+)"/g)) {
      const repoRel = relative(fileURLToPath(new URL("../../", import.meta.url)), resolve(dirname(root(f)), m[1])).split(sep).join("/");
      assert.equal(ignored(repoRel), false, f + " imports " + repoRel);
    }
  }
});

test("the light-path tool list is inside the deploy ignore list", () => {
  for (const f of LIGHT_TOOL_FILES) assert.equal(ignored("tools/" + f), true, f);
  for (const d of LIGHT_TOOL_DIRS) assert.equal(ignored("tools/" + d + "/x.mjs"), true, d);
});

test("queueing contract: one group, running deploys are never cancelled", () => {
  assert.deepEqual(wf.concurrency, { group: "cloudflare-production-master", "cancel-in-progress": false });
  for (const [name, job] of Object.entries(wf.jobs)) {
    if (name === "deploy-production") assert.equal(job.concurrency, undefined, "the deploy job must not set its own concurrency");
    else if (job.concurrency) assert.equal(job.concurrency["cancel-in-progress"], false, name + " must not cancel in progress");
    for (const s of job.steps) {
      if (s.if) assert.ok(!/cancelled\(\)/.test(String(s.if)), `${name}: ${s.name} uses cancelled()`);
    }
  }
});

test("the migration step has no condition and no continue-on-error", () => {
  const step = wf.jobs["deploy-production"].steps.find((s) => /Apply Unified D1 Schema/.test(s.name));
  assert.ok(step);
  assert.equal(step.if, undefined);
  assert.equal(step["continue-on-error"], undefined);
  assert.match(step.run, /d1 migrations apply/);
  assert.equal(wf.jobs["deploy-production"].if, "github.ref == 'refs/heads/master'");
});
