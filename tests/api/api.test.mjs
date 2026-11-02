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

test("GET /api/health without a key: minimal body, no provider detail", async () => {
  const r = await fetch(`${API}/api/health`);
  assert.equal(r.status, 200);
  const b = await json(r);
  assert.equal(b.ok, true);
  assert.equal(b.service, "leeroy-brain");
  assert.equal(b.isPrPreview, true);
  assert.equal(typeof b.at, "string");
  assert.ok(!("providers" in b), "providers must be absent without the admin token");
  assert.ok(!("aiProvider" in b), "aiProvider must be absent without the admin token");
  assert.ok(!("aiGateway" in b), "aiGateway must be absent without the admin token");
});

test("GET /api/health with the admin token: provider detail present", async () => {
  const r = await fetch(`${API}/api/health`, { headers: authHeaders });
  assert.equal(r.status, 200);
  const b = await json(r);
  assert.equal(b.ok, true);
  assert.equal(b.aiProvider, "workers-ai");
  assert.ok(b.providers && typeof b.providers === "object", "providers missing");
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

test("CORS: localhost:8080 is not an allowed origin", async () => {
  const r = await fetch(`${API}/api/bootstrap`, { headers: { Origin: "http://localhost:8080" } });
  assert.ok(r.status === 403 || r.headers.get("access-control-allow-origin") === null, "localhost origin must not be allowed");
  assert.notEqual(r.headers.get("access-control-allow-origin"), "http://localhost:8080");
  await r.arrayBuffer();
});

test("CORS: https://leeroy.party is allowed and echoed", async () => {
  const r = await fetch(`${API}/api/bootstrap`, { headers: { Origin: "https://leeroy.party" } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("access-control-allow-origin"), "https://leeroy.party");
  await r.arrayBuffer();
});

test("CORS: the preview Pages origin is allowed and echoed", async () => {
  const r = await fetch(`${API}/api/health`, { headers: { Origin: PAGES } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("access-control-allow-origin"), PAGES);
  await r.arrayBuffer();
});

test("Pages: baseline security headers are served on the preview origin", async () => {
  const r = await fetch(`${PAGES}/`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("strict-transport-security") || "", /max-age=31536000/);
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.ok(r.headers.get("referrer-policy"), "referrer-policy missing");
  assert.match(r.headers.get("permissions-policy") || "", /camera=\(\)/);
  await r.arrayBuffer();
});

test("Pages: cache lifetimes by path, HTML always revalidated, stamped code not immutable", async () => {
  const cc = async (path) => { const r = await fetch(`${PAGES}${path}`); assert.equal(r.status, 200, `${path} answered ${r.status}`); await r.arrayBuffer(); return r.headers.get("cache-control") || ""; };
  assert.match(await cc("/"), /max-age=0/);
  assert.match(await cc("/fonts/alegreya-latin.woff2"), /max-age=2592000/);
  assert.match(await cc("/img/tavern-plate.jpg"), /max-age=86400.*stale-while-revalidate=604800/);
  assert.match(await cc("/data/stats.json"), /max-age=300.*stale-while-revalidate=3600/);
  const code = await cc("/js/board.js");
  assert.doesNotMatch(code, /immutable/, "stamps are not yet content-verified, so code must not be immutable");
});

// Public guests may only ask (Workers AI, 2 per hour per IP, PR 17). Every other write kind must still need a key. Never send kind "ask" here: that would spend AI.
test("non-ask write route without a key is refused (401 or 403)", async () => {
  const r = await fetch(`${API}/api/intent`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "signup", patch: {} }) });
  assert.ok([401, 403].includes(r.status), `got ${r.status}`);
  await r.arrayBuffer();
});

test("PUT /api/persona without a key is refused (401 or 403)", async () => {
  const r = await fetch(`${API}/api/persona`, { method: "PUT", headers: { "Content-Type": "application/json", Origin: PAGES }, body: JSON.stringify({ version: 1, system: "x" }) });
  assert.ok([401, 403].includes(r.status), `got ${r.status}`);
  await r.arrayBuffer();
});

test("PUT /api/persona with a key but an invalid body is refused (400), nothing is written", async () => {
  const r = await fetch(`${API}/api/persona`, { method: "PUT", headers: { "Content-Type": "application/json", ...authHeaders }, body: JSON.stringify({ system: 5 }) });
  assert.equal(r.status, 400);
  await r.arrayBuffer();
});

test("GET /api/persona is not a public read (404 or 405)", async () => {
  const r = await fetch(`${API}/api/persona`, { headers: { Origin: PAGES } });
  assert.ok([404, 405].includes(r.status), `got ${r.status}`);
  await r.arrayBuffer();
});

// Admin-only routes: no key must be refused. Empty or harmless bodies only; nothing is written.
test("GET /api/intents without a key is refused (401 or 403)", async () => {
  const r = await fetch(`${API}/api/intents`, { headers: { Origin: PAGES } });
  assert.ok([401, 403].includes(r.status), `got ${r.status}`);
  await r.arrayBuffer();
});

for (const [method, path] of [["POST", "/api/ack"], ["POST", "/api/answer"], ["PUT", "/api/vocab"]]) {
  test(`${method} ${path} without a key is refused (401 or 403)`, async () => {
    const r = await fetch(`${API}${path}`, { method, headers: { "Content-Type": "application/json", Origin: PAGES }, body: "{}" });
    assert.ok([401, 403].includes(r.status), `got ${r.status}`);
    await r.arrayBuffer();
  });
}

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

test("GET /api/signups: 200 with an entries array", async () => {
  const r = await fetch(`${API}/api/signups`, { headers: { Origin: PAGES } });
  assert.equal(r.status, 200);
  const b = await json(r);
  assert.ok(Array.isArray(b.entries), "entries is not an array");
});

for (const key of ["name_map", "discord_members"]) {
  test(`PUT /api/config/${key} without a key is refused (401 or 403)`, async () => {
    const r = await fetch(`${API}/api/config/${key}`, { method: "PUT", headers: { "Content-Type": "application/json", Origin: PAGES }, body: "{}" });
    assert.ok([401, 403].includes(r.status), `status ${r.status}`);
  });
}

test("GET /api/config/name_map is not a public read (404 or 405)", async () => {
  const r = await fetch(`${API}/api/config/name_map`, { headers: { Origin: PAGES } });
  assert.ok([404, 405].includes(r.status), `status ${r.status}`);
});
