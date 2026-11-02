// API tests against a PR preview Worker. No AI calls: free Workers AI has a very low rate limit.
// Env: PREVIEW_API (Worker origin), PREVIEW_PAGES (Pages origin, sent as Origin), BOARD_ADMIN_TOKEN (never printed).
import test from "node:test";
import assert from "node:assert/strict";

const need = (n) => { const v = process.env[n]; if (!v) throw new Error(`${n} is not set`); return v.trim(); };
const API = need("PREVIEW_API").replace(/\/+$/, "");
const PAGES = need("PREVIEW_PAGES").replace(/\/+$/, "");
const TOKEN = need("BOARD_ADMIN_TOKEN");
const authHeaders = { Authorization: `Bearer ${TOKEN}`, Origin: PAGES };
const json = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { throw new Error(`not JSON (HTTP ${r.status}): ${t.slice(0, 120)}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("GET /api/health: ok, PR preview, workers-ai", async () => {
  const r = await fetch(`${API}/api/health`);
  assert.equal(r.status, 200);
  const b = await json(r);
  assert.equal(b.ok, true);
  assert.equal(b.isPrPreview, true);
  assert.equal(b.aiProvider, "workers-ai");
});

test("GET /api/bootstrap: JSON, only workers-ai provider enabled", async () => {
  const r = await fetch(`${API}/api/bootstrap`, { headers: { Origin: PAGES } });
  assert.equal(r.status, 200);
  const b = await json(r);
  assert.ok(b.providers && typeof b.providers === "object", "providers missing");
  const on = Object.entries(b.providers).filter(([, v]) => v === true).map(([k]) => k);
  assert.deepEqual(on, ["workers-ai"]);
});

test("GET /api/state: party of 5 with required fields", async () => {
  const r = await fetch(`${API}/api/state`, { headers: authHeaders });
  assert.equal(r.status, 200);
  const b = await json(r);
  assert.ok(Array.isArray(b.party), "party is not an array");
  assert.equal(b.party.length, 5);
  for (const m of b.party) {
    assert.equal(typeof m.slug, "string");
    assert.equal(typeof m.name, "string");
    assert.ok(m.fields && typeof m.fields === "object", `${m.slug}: fields missing`);
    for (const k of ["race", "class"]) assert.ok(m.fields[k] && "value" in m.fields[k], `${m.slug}: fields.${k} missing`);
  }
});

test("CORS: a foreign Origin is refused with 403 and no Allow-Origin", async () => {
  const r = await fetch(`${API}/api/health`, { headers: { Origin: "https://evil.example" } });
  assert.equal(r.status, 403);
  assert.equal(r.headers.get("access-control-allow-origin"), null);
  await r.arrayBuffer();
});

test("CORS: the preview Pages origin is allowed and echoed", async () => {
  const r = await fetch(`${API}/api/health`, { headers: { Origin: PAGES } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("access-control-allow-origin"), PAGES);
  await r.arrayBuffer();
});

test("write route without a key is refused (401 or 403)", async () => {
  const r = await fetch(`${API}/api/intent`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "ask", q: "should not run" }) });
  assert.ok([401, 403].includes(r.status), `got ${r.status}`);
  await r.arrayBuffer();
});

// The Discord interactions endpoint is not tested here: it cannot be attached to a PR environment (it would need the live Discord channel).

test("library index JSON is reachable", async () => {
  const r = await fetch(`${API}/api/library/index.json`, { headers: { Origin: PAGES } });
  assert.equal(r.status, 200);
  const b = await json(r);
  assert.ok(b.totals && b.totals.pages > 0, "library totals missing");
});

test("WebSocket /api/live connects and delivers a first message within 10 s", async () => {
  const ws = new WebSocket(`${API.replace(/^http/, "ws")}/api/live`);
  const first = await new Promise((resolve, reject) => {
    const t = setTimeout(() => { try { ws.close(); } catch {} reject(new Error("no message in 10 s")); }, 10000);
    ws.addEventListener("message", (e) => { clearTimeout(t); resolve(String(e.data)); });
    ws.addEventListener("error", () => { clearTimeout(t); reject(new Error("websocket error")); });
    ws.addEventListener("close", (e) => { clearTimeout(t); reject(new Error(`closed before a message (${e.code})`)); });
  });
  try { ws.close(); } catch {}
  assert.ok(first.length > 0);
});
