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
  assert.deepEqual(dir("connect-src"), ["'self'", "https://api.leeroy.party", "wss://api.leeroy.party"]);
  assert.deepEqual(dir("frame-ancestors"), ["'self'", "https://discord.com", "https://*.discordsays.com"]);
  assert.deepEqual(dir("object-src"), ["'none'"]);
  assert.deepEqual(dir("base-uri"), ["'none'"]);
  const s = dir("script-src");
  assert.equal(s[0], "'self'");
  assert.ok(!s.includes("'unsafe-inline'") && !s.includes("'unsafe-eval'") && !s.includes("*"), "no unsafe-inline, unsafe-eval or wildcard in script-src");
});
test("the script-src hash is the sha256 of the inline host-redirect script in index.html", () => {
  const m = /<script id="host-redirect">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, "host-redirect script present");
  const want = `'sha256-${crypto.createHash("sha256").update(m[1]).digest("base64")}'`;
  assert.ok(dir("script-src").includes(want), `script-src must include ${want}; has ${dir("script-src").join(" ")}`);
});
test("a changed host-redirect script would no longer match (the check is not vacuous)", () => {
  const m = /<script id="host-redirect">([\s\S]*?)<\/script>/.exec(html);
  const other = `'sha256-${crypto.createHash("sha256").update(`${m[1]} `).digest("base64")}'`;
  assert.ok(!dir("script-src").includes(other));
});
