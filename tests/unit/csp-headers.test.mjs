// F3: _headers carries a Content-Security-Policy (report-only or enforced) with the agreed directives, and the sha256 in script-src is the hash of the inline host-redirect script in index.html.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const headers = fs.readFileSync(path.join(root, "_headers"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
// the /* block: indented lines up to the first blank line
const block = headers.split(/\r?\n\r?\n/)[0];
const line = block.split(/\r?\n/).find((l) => /^\s+Content-Security-Policy(-Report-Only)?:/i.test(l));
const policy = line ? line.replace(/^\s+[^:]+:\s*/, "") : "";
const dir = (name) => (policy.split(";").map((x) => x.trim()).find((x) => x.split(/\s+/)[0] === name) || "").split(/\s+/).slice(1);

test("the /* rule carries a Content-Security-Policy (Report-Only is allowed, and must be said in the PR)", () => {
  assert.ok(block.startsWith("/*"), "first rule is /*");
  assert.ok(line, "Content-Security-Policy or Content-Security-Policy-Report-Only under /*");
});
test("the policy has the agreed directives", () => {
  assert.deepEqual(dir("default-src"), ["'self'"]);
  assert.deepEqual(dir("connect-src").slice(0, 3), ["'self'", "https://api.leeroy.party", "wss://api.leeroy.party"]);
  assert.deepEqual(dir("object-src"), ["'none'"]);
  assert.deepEqual(dir("base-uri"), ["'none'"]);
  const s = dir("script-src");
  assert.equal(s[0], "'self'");
  assert.ok(!s.includes("'unsafe-inline'") && !s.includes("'unsafe-eval'") && !s.includes("*"), "no unsafe-inline, unsafe-eval or wildcard in script-src");
});
test("frame-ancestors is not in the report-only line (browsers ignore it there; WebKit logs a console error on every page)", () => {
  assert.ok(/Report-Only/i.test(line), "the /* policy is the report-only header");
  assert.ok(!/frame-ancestors/i.test(line), "frame-ancestors must not be on the Content-Security-Policy-Report-Only line");
  assert.deepEqual(dir("frame-ancestors"), []);
});
test("script-src carries the sha256 of EVERY inline script in index.html (host-redirect, the second inline script, the module)", () => {
  const scripts = [...html.matchAll(/<script(?![^>]*\ssrc=)([^>]*)>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.some((m) => /id="host-redirect"/.test(m[1])), "host-redirect script present");
  assert.ok(scripts.length >= 3, "the inline scripts are still found");
  for (const m of scripts) {
    const want = `'sha256-${crypto.createHash("sha256").update(m[2]).digest("base64")}'`;
    assert.ok(dir("script-src").includes(want), `script-src must include ${want} (${m[1].trim() || "inline script"}); has ${dir("script-src").join(" ")}`);
  }
});
test("the policy allows what normal pages use, so a report-only policy stays quiet: data: images, inline styles, blob workers, the preview Workers", () => {
  assert.deepEqual(dir("img-src"), ["'self'", "data:"]);
  assert.ok(dir("style-src").includes("'self'") && dir("style-src").includes("'unsafe-inline'"));
  assert.deepEqual(dir("worker-src"), ["'self'", "blob:"]);
  assert.deepEqual(dir("font-src"), ["'self'"]);
  const c = dir("connect-src");
  for (const h of ["https://*.joshbblaine.workers.dev", "wss://*.joshbblaine.workers.dev", "https://*.jmattbloise.workers.dev", "wss://*.jmattbloise.workers.dev"]) assert.ok(c.includes(h), h);
  assert.ok(!c.includes("*") && !c.includes("https:") && !c.includes("https://*.workers.dev"), "no blanket origin");
});
test("the Cloudflare Web Analytics beacon is allowed by exact host only: script host in script-src, report endpoint in connect-src, nothing wider", () => {
  const s = dir("script-src"), c = dir("connect-src");
  assert.ok(s.includes("https://static.cloudflareinsights.com"), "script-src allows the beacon script host");
  assert.ok(c.includes("https://cloudflareinsights.com"), "connect-src allows the beacon report endpoint");
  assert.ok(!s.some((x) => /cloudflareinsights/.test(x) && x !== "https://static.cloudflareinsights.com"), "script-src names only the beacon host");
  assert.ok(![...s, ...c].some((x) => /\*/.test(x) && /cloudflare/.test(x)), "no wildcard on the beacon hosts");
  assert.ok(!s.includes("'unsafe-inline'") && !s.includes("https:") && !s.includes("*"), "script-src is not widened");
  for (const d of ["default-src", "img-src", "font-src", "worker-src"]) assert.ok(!dir(d).some((x) => /cloudflareinsights/.test(x)), `${d} is untouched`);
});
test("a changed host-redirect script would no longer match (the check is not vacuous)", () => {
  const m = /<script id="host-redirect">([\s\S]*?)<\/script>/.exec(html);
  const other = `'sha256-${crypto.createHash("sha256").update(`${m[1]} `).digest("base64")}'`;
  assert.ok(!dir("script-src").includes(other));
});

// B59: the residual WebKit console error "frame-ancestors is ignored when delivered in a report-only policy" at 3440x1440 and wider (production run 41817101970), in the
// library states only. Source: the library search Worker (vendor/library-worker.js) is a module worker, and WebKit logs the CSP of a worker script response. /vendor/* is
// immutable for a year, so Cloudflare kept serving the copy it cached before PR 168 removed the directive. No rule in _headers sets frame-ancestors; the fix is a new URL for the worker.
test("no rule in _headers, on any path, sets frame-ancestors in any header value (comment lines excepted)", () => {
  const live = headers.split(/\r?\n/).filter((l) => !/^\s*#/.test(l));
  assert.deepEqual(live.filter((l) => /frame-ancestors/i.test(l)), []);
  assert.deepEqual(live.filter((l) => /^\s+Content-Security-Policy/i.test(l)).length, 1, "exactly one CSP header line, under /*");
});
test("the library worker is requested under a new ?v= stamp, not the one the edge cached with the old header (9ee32dfeb0)", () => {
  const board = fs.readFileSync(path.join(root, "js/board.js"), "utf8");
  const m = /vendor\/library-worker\.js\?v=([0-9a-f]{10})/.exec(board);
  assert.ok(m, "board.js starts vendor/library-worker.js with a ?v= stamp");
  assert.notEqual(m[1], "9ee32dfeb0");
});
