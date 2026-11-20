// Production ships no personal workers.dev host; a preview build gets exactly its own Worker, stamped into the staged copy only (tools/preview-stamp.mjs).
// Run: node --test tests/unit/preview-stamp.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { stampTexts, stampDist } from "../../tools/preview-stamp.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");
const WORKER = "https://leeroy-brain-pr-9.example-account.workers.dev";

test("production sources, headers and bundle carry no workers.dev host at all", () => {
  for (const f of ["_headers", "js/brain.js", "js/board.js", "index.html", "404.html"]) assert.ok(!/workers\.dev/.test(read(f)), `${f} has no workers.dev host`);
  const bundle = read("tools/pages-bundle.mjs");
  const items = JSON.parse(bundle.match(/BUNDLE_ITEMS = Object\.freeze\((\[[^\]]*\])\)/)[1]);
  for (const it of items) {
    if (!/\.(js|html|css|json|txt|mjs)$/.test(it) && it !== "_headers") continue;
    assert.ok(!/workers\.dev/.test(read(it)), `${it} has no workers.dev host`);
  }
  assert.match(read("js/brain.js"), /const WORKER = "https:\/\/api\.leeroy\.party";/, "production talks to api.leeroy.party");
  assert.match(read("js/board.js"), /const PREVIEW_WORKER = "";/, "empty in production");
});

test("the Content-Security-Policy connect-src of production names api.leeroy.party and no workers.dev origin; the policy is not tightened or loosened by this change", () => {
  const h = read("_headers");
  const lines = h.split("\n").filter((l) => !l.trim().startsWith("#") && /Content-Security-Policy/i.test(l));
  assert.ok(lines.length >= 1);
  for (const l of lines) {
    const c = (/connect-src ([^;]*)/.exec(l) || [])[1] || "";
    assert.ok(c.includes("https://api.leeroy.party") && c.includes("wss://api.leeroy.party"));
    const toks = c.split(/\s+/).filter(Boolean);
    assert.ok(!/workers\.dev/.test(c) && !toks.some((t) => t.includes("*") || t === "https:" || t === "wss:"), c);
  }
  assert.ok(/Content-Security-Policy-Report-Only/.test(h), "still report-only: nothing is enforced here");
});

test("stampTexts: the preview gets its own Worker in brain.js, board.js and the CSP connect-src, and nothing else changes", () => {
  const src = { brain: read("js/brain.js"), board: read("js/board.js"), headers: read("_headers") };
  const out = stampTexts(src, WORKER);
  assert.ok(out.brain.includes(`const WORKER = "${WORKER}";`) && !out.brain.includes('const WORKER = "https://api.leeroy.party";'));
  assert.ok(out.board.includes(`const PREVIEW_WORKER = "${WORKER}";`));
  const host = "leeroy-brain-pr-9.example-account.workers.dev";
  for (const l of out.headers.split("\n").filter((x) => !x.trim().startsWith("#") && /Content-Security-Policy(-Report-Only)?:/i.test(x) && /connect-src/.test(x))) assert.ok(l.includes(`connect-src https://${host} wss://${host} `), "the exact host is the first connect-src entry");
  assert.equal(out.brain.replace(`const WORKER = "${WORKER}";`, 'const WORKER = "https://api.leeroy.party";'), src.brain, "only the constant changed in brain.js");
  assert.equal(out.board.replace(`const PREVIEW_WORKER = "${WORKER}";`, 'const PREVIEW_WORKER = "";'), src.board);
  assert.equal(out.headers.split(`https://${host} wss://${host} `).join(""), src.headers, "only the exact host was added to the headers");
});

test("stampTexts refuses a bad URL and any replacement that does not apply", () => {
  const src = { brain: read("js/brain.js"), board: read("js/board.js"), headers: read("_headers") };
  for (const bad of ["http://x.workers.dev", "https://evil.example", "https://x.workers.dev.evil.example", "https://x.y.z.workers.dev", "https://x.workers.dev/", "https://x.workers.dev:8443", "", undefined]) assert.throws(() => stampTexts(src, bad), /Worker URL/, String(bad));
  assert.throws(() => stampTexts({ ...src, brain: "nothing" }, WORKER), /WORKER constant/);
  assert.throws(() => stampTexts({ ...src, board: "nothing" }, WORKER), /PREVIEW_WORKER constant/);
  assert.throws(() => stampTexts({ ...src, headers: "/*\n  X-Test: 1\n" }, WORKER), /connect-src/);
});

test("stampDist writes the three staged files, and refuses without writing anything when one does not apply", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "stamp-"));
  mkdirSync(path.join(dir, "js"));
  writeFileSync(path.join(dir, "js/brain.js"), read("js/brain.js")); writeFileSync(path.join(dir, "js/board.js"), read("js/board.js")); writeFileSync(path.join(dir, "_headers"), read("_headers"));
  stampDist(dir, WORKER);
  assert.ok(readFileSync(path.join(dir, "js/brain.js"), "utf8").includes(WORKER));
  const bad = mkdtempSync(path.join(tmpdir(), "stamp-"));
  mkdirSync(path.join(bad, "js"));
  writeFileSync(path.join(bad, "js/brain.js"), read("js/brain.js")); writeFileSync(path.join(bad, "js/board.js"), "no constant"); writeFileSync(path.join(bad, "_headers"), read("_headers"));
  assert.throws(() => stampDist(bad, WORKER));
  assert.ok(!readFileSync(path.join(bad, "js/brain.js"), "utf8").includes(WORKER), "nothing half-written");
  const cli = spawnSync(process.execPath, [path.join(ROOT, "tools/preview-stamp.mjs"), dir, "https://evil.example"], { encoding: "utf8" });
  assert.equal(cli.status, 1);
  assert.ok(!cli.stdout.includes("example-account") && !cli.stderr.includes("example-account"));
});

test("the preview workflow stamps the staged copy with the tool and no longer edits brain.js with an inline script", () => {
  const wf = read(".github/workflows/pr-preview-cloudflare.yml");
  assert.match(wf, /node tools\/preview-stamp\.mjs \.cloudflare-dist "\$WORKER_URL"/);
  assert.ok(!/const url = process\.argv\[1\]; fs\.writeFileSync\(p, s\.replace/.test(wf));
});
