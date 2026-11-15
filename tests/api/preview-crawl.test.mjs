// The anonymous crawl against the real PR preview Worker: one member hides all nine sheet lines, then every GET route (derived from ROUTES, the public document sets
// and the dispatcher's regexes), every public document and the live socket are read with no key and no cookie, and every body, header and JSON key is searched for the
// hidden values. Hits are reported as FIELD NAMES only; a value is never printed. The sheet is put back in a finally block.
// The crawl logic is tests/helpers/preview-crawl.mjs; tests/unit/preview-crawl.test.mjs runs it against a local Worker and proves it goes red when a route leaks.
// Env: PREVIEW_API (Worker origin), BOARD_ADMIN_TOKEN (never printed), CRAWL_REPORT (optional: where the JSON report goes; CI sets it into the folder that is uploaded as an artifact).
// Refuses (fails, never skips) unless GET /api/health says isPrPreview:true, and refuses api.leeroy.party and leeroy.party.
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPreviewCrawl, collectLiveMessages, assertPreviewBase, formatTable } from "../helpers/preview-crawl.mjs";

const need = (n) => { const v = process.env[n]; if (!v) throw new Error(`${n} is not set`); return v.trim(); };
const API = need("PREVIEW_API").replace(/\/+$/, "");
const TOKEN = need("BOARD_ADMIN_TOKEN");
const REPORT = process.env.CRAWL_REPORT || join(tmpdir(), "preview-crawl.json");

// plain fetch, no cookie jar, no automatic redirect: what an anonymous caller sees from this route itself
const call = async (method, path, { headers = {}, body } = {}) => {
  const init = { method, headers: { ...headers }, redirect: "manual" };
  if (body !== undefined) { init.body = typeof body === "string" ? body : JSON.stringify(body); init.headers["Content-Type"] = "application/json"; }
  const res = await fetch(`${API}${path}`, init);
  return { status: res.status, text: await res.text(), headers: [...res.headers] };
};

test("preview crawl: with all nine sheet lines of one member hidden, no anonymous read and no live message shows a hidden value", { timeout: 20 * 60 * 1000 }, async () => {
  assertPreviewBase(API);
  const wsUrl = `${API.replace(/^http/, "ws")}/api/live`;
  const live = (trigger) => collectLiveMessages(wsUrl, trigger, 8000);
  let report = null, failure = null;
  try {
    report = await runPreviewCrawl({ call, live, admin: { Authorization: `Bearer ${TOKEN}` }, say: (s) => process.stdout.write(`${s}\n`) });
  } catch (e) {
    failure = e; report = e.report || null; // a run that throws still writes what it collected: the table and the artifact
  } finally {
    if (report) {
      writeFileSync(REPORT, JSON.stringify({ ...report, failed: failure ? failure.message : null }, null, 2));
      process.stdout.write(`${formatTable(report)}\nreport: ${REPORT}\n`);
    }
  }
  if (failure) throw failure;
  assert.equal(report.restored, true, "the sheet was put back");
  assert.deepEqual(report.hits, [], `hidden values found in anonymous answers (field names): ${report.hits.join(", ")}`);
});
