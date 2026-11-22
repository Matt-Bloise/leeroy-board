// The preview Worker deploy retries ONLY the transient Cloudflare 10007, at most 3 attempts, and still redacts and fails closed. Run: node --test tests/unit/preview-deploy-retry.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
const wf = fs.readFileSync(new URL("../../.github/workflows/pr-preview-cloudflare.yml", import.meta.url), "utf8");
const at = wf.indexOf("- name: Deploy Ephemeral PR Worker & Durable Object");
const step = wf.slice(at, at + 3500);

test("the preview deploy retries only error 10007, three attempts at most, with a pause", () => {
  assert.match(step, /for ATTEMPT in 1 2 3; do/);
  assert.match(step, /grep -qE '\(\^\|\[\^0-9\]\)10007\(\[\^0-9\]\|\$\)'/);
  assert.match(step, /\[ \$ATTEMPT -eq 3 \]/);
  assert.match(step, /sleep 20/);
  assert.equal((step.match(/npx wrangler deploy/g) || []).length, 1, "a single deploy command inside the loop");
});

test("the retry loop sits before the redaction and the exit check, so a retried output is still redacted and a final failure still fails", () => {
  const loop = step.indexOf("for ATTEMPT"), redact = step.indexOf("SUB=$(printf"), fail = step.indexOf("wrangler deploy failed with exit code");
  assert.ok(loop > 0 && loop < redact && redact < fail);
});
