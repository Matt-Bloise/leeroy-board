// Contract tests: live PR-preview responses validated against docs/openapi.yaml. No AI calls, no writes.
// Env: PREVIEW_API (Worker origin), PREVIEW_PAGES (sent as Origin), BOARD_ADMIN_TOKEN (never printed).
// The validator below is a small JSON Schema subset (the OpenAPI 3.0 keywords the spec uses); the YAML is parsed with `yaml` (devDependency).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const spec = parse(readFileSync(fileURLToPath(new URL("../../docs/openapi.yaml", import.meta.url)), "utf8"));

// ---- validator -------------------------------------------------------------------------------------------------
const resolve = (s) => {
  let guard = 0;
  while (s && s.$ref) {
    if (++guard > 20) throw new Error("$ref loop");
    s = s.$ref.replace(/^#\//, "").split("/").reduce((o, k) => o[k], spec);
  }
  return s;
};
const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
export function validate(value, schema, at = "$") {
  const s = resolve(schema);
  const errs = [];
  if (!s || Object.keys(s).length === 0) return errs;
  if (value === null) return s.nullable ? errs : [`${at}: null is not allowed`];
  if (s.type) {
    const t = typeOf(value);
    const ok = s.type === t || (s.type === "number" && t === "integer");
    if (!ok) return [`${at}: expected ${s.type}, got ${t}`];
  }
  if (s.enum && !s.enum.includes(value)) errs.push(`${at}: ${JSON.stringify(value)} not in enum ${JSON.stringify(s.enum)}`);
  if (typeof value === "string") {
    if (s.minLength != null && value.length < s.minLength) errs.push(`${at}: shorter than ${s.minLength}`);
    if (s.pattern && !new RegExp(s.pattern).test(value)) errs.push(`${at}: does not match ${s.pattern}`);
    if (s.format === "date-time" && Number.isNaN(Date.parse(value))) errs.push(`${at}: not a date-time`);
  }
  if (Array.isArray(value) && s.items) value.forEach((v, i) => errs.push(...validate(v, s.items, `${at}[${i}]`)));
  if (typeOf(value) === "object") {
    for (const k of s.required || []) if (!(k in value)) errs.push(`${at}: missing required "${k}"`);
    for (const [k, v] of Object.entries(value)) {
      if (s.properties && k in s.properties) errs.push(...validate(v, s.properties[k], `${at}.${k}`));
      else if (s.additionalProperties && typeof s.additionalProperties === "object") errs.push(...validate(v, s.additionalProperties, `${at}.${k}`));
      else if (s.additionalProperties === false) errs.push(`${at}: unexpected "${k}"`);
    }
  }
  return errs;
}

// ---- live helpers ----------------------------------------------------------------------------------------------
const need = (n) => { const v = process.env[n]; if (!v) throw new Error(`${n} is not set`); return v.trim(); };
const API = need("PREVIEW_API").replace(/\/+$/, "");
const PAGES = need("PREVIEW_PAGES").replace(/\/+$/, "");
const TOKEN = need("BOARD_ADMIN_TOKEN");
const pub = { Origin: PAGES };
const admin = { Authorization: `Bearer ${TOKEN}`, Origin: PAGES };

const schemaFor = (path, method, status) => {
  const resp = spec.paths[path][method].responses[String(status)];
  assert.ok(resp, `${method} ${path}: status ${status} is not documented in docs/openapi.yaml`);
  return resolve(resp).content["application/json"].schema;
};
async function get(path, headers, specPath = path) {
  const r = await fetch(`${API}${path}`, { headers });
  const text = await r.text();
  assert.match(r.headers.get("content-type") || "", /^application\/json/, `${path}: content-type`);
  let body;
  try { body = JSON.parse(text); } catch { assert.fail(`${path}: not JSON (HTTP ${r.status}): ${text.slice(0, 120)}`); }
  return { status: r.status, body, specPath };
}
const conforms = ({ status, body, specPath }, method = "get") => {
  const errs = validate(body, schemaFor(specPath, method, status));
  assert.deepEqual(errs, [], `${specPath} (${status}) does not match the contract:\n${errs.join("\n")}`);
};

// ---- the validator itself (offline) ----------------------------------------------------------------------------
test("validator: accepts and rejects", () => {
  const me = { $ref: "#/components/schemas/Me" };
  assert.deepEqual(validate({ slug: "a", name: "A", pending: [] }, me), []);
  assert.ok(validate({ slug: "a", name: "A" }, me).length, "missing pending");
  assert.ok(validate({ slug: 1, name: "A", pending: [] }, me).length, "wrong type");
  assert.ok(validate(null, me).length, "null for a non-nullable schema");
  assert.ok(validate({ slug: "", name: "A", pending: [] }, me).length, "minLength");
});

test("spec covers exactly the documented public and member routes", () => {
  assert.deepEqual(Object.keys(spec.paths).sort(), ["/api/admin/eval", "/api/admin/events/sync", "/api/admin/feedback", "/api/announce", "/api/atlas/{name}", "/api/auth/discord/callback", "/api/auth/discord/start", "/api/auth/logout", "/api/bootstrap", "/api/config/{key}", "/api/data/{name}", "/api/discord", "/api/health", "/api/me", "/api/me/erase", "/api/me/export", "/api/persona", "/api/signups", "/api/state", "/api/votes"]);
});

// ---- routes ----------------------------------------------------------------------------------------------------
test("GET /api/health (no key) matches the contract and omits admin detail", async () => {
  const res = await get("/api/health", pub);
  assert.equal(res.status, 200);
  conforms(res);
  for (const k of ["providers", "aiProvider", "aiGateway", "aiBudget"]) assert.ok(!(k in res.body), `${k} leaked without a key`);
});

test("GET /api/health (admin token) matches the contract including provider detail", async () => {
  const res = await get("/api/health", admin);
  assert.equal(res.status, 200);
  conforms(res);
  assert.ok(res.body.providers && res.body.aiBudget, "admin detail missing");
});

test("GET /api/admin/feedback: 401 without the admin token, contract match with it, no voter identity", async () => {
  const denied = await get("/api/admin/feedback", pub);
  assert.equal(denied.status, 401);
  conforms(denied);
  const res = await get("/api/admin/feedback", admin);
  assert.equal(res.status, 200);
  conforms(res);
  assert.ok(!JSON.stringify(res.body).includes("user_hash"));
});

test("GET /api/bootstrap matches the contract", async () => {
  const res = await get("/api/bootstrap", pub);
  assert.equal(res.status, 200);
  conforms(res);
});

test("GET /api/signups matches the contract", async () => {
  const res = await get("/api/signups", pub);
  assert.equal(res.status, 200);
  conforms(res);
});

test("GET /api/state matches the contract", async () => {
  const res = await get("/api/state", pub);
  assert.equal(res.status, 200);
  conforms(res);
});

test("GET /api/me with a key matches the contract; without a key it is 401", async () => {
  const ok = await get("/api/me", admin);
  assert.equal(ok.status, 200);
  conforms(ok);
  const no = await get("/api/me", pub);
  assert.equal(no.status, 401);
  conforms(no);
});

const DATA_ALLOWED = ["party", "timeline", "client", "stats", "signups", "tonight", "launch", "decide", "guided-atlas"];
for (const name of DATA_ALLOWED) {
  test(`GET /api/data/${name} is allow-listed: 200 matching Document, or 404 matching Error if the row is absent`, async () => {
    const res = await get(`/api/data/${name}.json`, pub, "/api/data/{name}");
    assert.ok([200, 404].includes(res.status), `got ${res.status}`);
    conforms(res);
  });
}
for (const name of ["marks", "links"]) {
  test(`GET /api/atlas/${name} is allow-listed: 200 matching Document, or 404 matching Error if the row is absent`, async () => {
    const res = await get(`/api/atlas/${name}`, pub, "/api/atlas/{name}");
    assert.ok([200, 404].includes(res.status), `got ${res.status}`);
    conforms(res);
  });
}
for (const [route, name] of [["data", "zz-not-a-document"], ["data", "marks"], ["data", "party_sheets"], ["atlas", "party"], ["atlas", "zz-not-a-document"]]) {
  test(`GET /api/${route}/${name} is outside the allow list: 404 matching Error`, async () => {
    const res = await get(`/api/${route}/${name}`, pub, `/api/${route}/{name}`);
    assert.equal(res.status, 404);
    conforms(res);
    assert.ok(!/"(json|updated_at)"/.test(JSON.stringify(res.body)), "no row detail in the 404");
  });
}

// Observed behaviour pinned for the back-end architect (see the pull request findings). These document today's
// behaviour; if one fails after an intentional change, update docs/openapi.yaml and this test together.
test("finding: a foreign Origin gets text/plain 'Forbidden Origin', not the JSON Error shape", async () => {
  const r = await fetch(`${API}/api/health`, { headers: { Origin: "https://evil.example" } });
  assert.equal(r.status, 403);
  assert.match(r.headers.get("content-type") || "", /^text\/plain/);
  assert.equal(await r.text(), "Forbidden Origin");
});

test("finding: an unknown route answers 404 with {error, path}", async () => {
  const res = await get("/api/zz-no-such-route", pub, "/api/data/{name}");
  assert.equal(res.status, 404);
  assert.equal(typeof res.body.error, "string");
  assert.equal(res.body.path, "/zz-no-such-route", "path echoes the route without the /api prefix");
});


// ---- routes added after the first spec: web login, votes, admin writes, Discord interactions ---------------------
// Nothing here sends a credential, a body that could change state, or a signed Discord request. The WEB_LOGIN flag is a
// Worker var and may differ per environment, so each web-login test accepts the flag-off 404 and, when the flag is on, checks the
// documented behaviour instead.
async function raw(method, path, headers = {}, body) {
  const r = await fetch(`${API}${path}`, { method, headers, body, redirect: "manual" });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, headers: r.headers, text, json };
}
const documented = (path, method, status) => assert.ok(spec.paths[path][method].responses[String(status)], `${method} ${path}: ${status} is not documented`);
const matchesError = (res, path, method) => {
  assert.match(res.headers.get("content-type") || "", /^application\/json/, `${path}: content-type`);
  const errs = validate(res.json, schemaFor(path, method, res.status));
  assert.deepEqual(errs, [], `${path} (${res.status}): ${errs.join("; ")}`);
};

test("GET /api/votes matches the contract and exposes no ballots or hashes", async () => {
  const res = await get("/api/votes", pub);
  assert.equal(res.status, 200);
  conforms(res);
  assert.ok(!/ballots|voter|hash/i.test(JSON.stringify(res.body)), "private vote fields in the public listing");
});

test("GET /api/auth/discord/start: 404 Error with the flag off; with it on a 302 to Discord with only a state cookie, or a documented refusal", async () => {
  const res = await raw("GET", "/api/auth/discord/start", pub);
  documented("/api/auth/discord/start", "get", res.status);
  if (res.status === 302) {
    const loc = new URL(res.headers.get("location"));
    assert.equal(loc.origin + loc.pathname, "https://discord.com/oauth2/authorize");
    assert.equal(loc.searchParams.get("scope"), "identify");
    assert.equal(loc.searchParams.get("code_challenge_method"), "S256");
    assert.match(res.headers.get("set-cookie") || "", /^__Host-oauth=[\w-]{43}\.[\w-]{43}; .*Secure; HttpOnly/);
    assert.ok(!/__Host-sess/.test(res.headers.get("set-cookie") || ""), "start must not set a session");
  } else matchesError(res, "/api/auth/discord/start", "get");
});

test("GET /api/auth/discord/callback without a state cookie never creates a session", async () => {
  const res = await raw("GET", "/api/auth/discord/callback?state=x&code=abcdef123", pub);
  documented("/api/auth/discord/callback", "get", res.status);
  assert.ok(!/__Host-sess=[\w-]{10,}/.test(res.headers.get("set-cookie") || ""), "a session cookie was set");
  if (res.status === 302) assert.match(res.headers.get("location") || "", /\?login=state$/);
  else matchesError(res, "/api/auth/discord/callback", "get");
});

test("POST /api/auth/logout without an Origin header: 404 with the flag off, 403 origin not allowed with it on", async () => {
  const res = await raw("POST", "/api/auth/logout", {}, "{}");
  documented("/api/auth/logout", "post", res.status);
  assert.ok([404, 403].includes(res.status), `got ${res.status}`);
  matchesError(res, "/api/auth/logout", "post");
  if (res.status === 403) assert.equal(res.json.error, "origin not allowed");
});

test("POST /api/auth/logout with an allowed Origin and no cookie: 404 with the flag off, 200 {ok:true} with it on", async () => {
  const res = await raw("POST", "/api/auth/logout", pub, "{}");
  documented("/api/auth/logout", "post", res.status);
  assert.ok([404, 200].includes(res.status), `got ${res.status}`);
  matchesError(res, "/api/auth/logout", "post");
});

test("finding: the flag-off 404 on a web-login route has no path field, unlike the unknown-route 404", async () => {
  const off = await raw("GET", "/api/auth/discord/start", pub);
  if (off.status !== 404) return; // flag on in this environment
  assert.deepEqual(off.json, { error: "not found" });
  const unknown = await raw("GET", "/api/zz-no-such-route", pub);
  assert.notDeepEqual(off.json, unknown.json, "the two 404 bodies differ, so the flag state can be told apart");
});

test("admin write routes refuse a request without the admin token (401) before reading the body", async () => {
  const calls = [
    ["POST", "/api/announce", "/api/announce", "post"],
    ["POST", "/api/admin/events/sync", "/api/admin/events/sync", "post"],
    ["PUT", "/api/config/name_map", "/api/config/{key}", "put"],
    ["PUT", "/api/config/discord_roster", "/api/config/{key}", "put"],
    ["PUT", "/api/persona", "/api/persona", "put"],
  ];
  for (const [method, path, specPath, m] of calls) {
    const res = await raw(method, path, { ...pub, "Content-Type": "application/json" }, "{}");
    assert.equal(res.status, 401, `${method} ${path}`);
    matchesError(res, specPath, m);
    assert.equal(res.json.error, "Unauthorized");
  }
});

test("a wrong token is refused like a missing one on the admin write routes", async () => {
  const res = await raw("PUT", "/api/persona", { ...pub, Authorization: "Bearer not-the-admin-token-0123456789", "Content-Type": "application/json" }, "{}");
  assert.equal(res.status, 401);
});

test("finding: config and persona are write only; GET answers the generic 404 and echoes no private data", async () => {
  for (const path of ["/api/config/name_map", "/api/config/discord_members", "/api/config/discord_roster", "/api/persona"]) {
    for (const headers of [pub, admin]) {
      const res = await raw("GET", path, headers);
      assert.equal(res.status, 404, `${path} ${headers === admin ? "admin" : "anonymous"}`);
      assert.deepEqual(Object.keys(res.json).sort(), ["error", "path"]);
    }
  }
});

test("POST /api/discord with a stale timestamp is 401 text/plain (500 only when the public key is not configured)", async () => {
  const stale = String(Math.floor(Date.now() / 1000) - 3600);
  for (const ts of [stale, "not-a-number", ""]) {
    const res = await raw("POST", "/api/discord", { "X-Signature-Ed25519": "00".repeat(64), "X-Signature-Timestamp": ts, "Content-Type": "application/json" }, '{"type":1}');
    documented("/api/discord", "post", res.status);
    assert.ok([401, 500].includes(res.status), `ts=${JSON.stringify(ts)} got ${res.status}`);
    if (res.status === 401) {
      assert.match(res.headers.get("content-type") || "", /^text\/plain/);
      assert.equal(res.text, "Stale or invalid request timestamp");
    } else assert.equal(res.json.error, "DISCORD_PUBLIC_KEY not configured");
  }
});

test("POST /api/discord with a fresh timestamp and a bad signature is 401 'Invalid request signature'", async () => {
  const res = await raw("POST", "/api/discord", { "X-Signature-Ed25519": "00".repeat(64), "X-Signature-Timestamp": String(Math.floor(Date.now() / 1000)), "Content-Type": "application/json" }, '{"type":1}');
  assert.ok([401, 500].includes(res.status), `got ${res.status}`);
  if (res.status === 401) assert.equal(res.text, "Invalid request signature");
});

test("POST /api/admin/eval: refused without the admin token; with it, 404 while EVAL_ENABLED is off or 400 for an empty body (no AI call either way)", async () => {
  const anon = await raw("POST", "/api/admin/eval", { ...pub, "Content-Type": "application/json" }, "{}");
  documented("/api/admin/eval", "post", anon.status);
  assert.equal(anon.status, 401);
  const res = await raw("POST", "/api/admin/eval", { ...admin, "Content-Type": "application/json" }, "{}");
  documented("/api/admin/eval", "post", res.status);
  assert.ok([400, 404].includes(res.status), `got ${res.status}`);
  matchesError(res, "/api/admin/eval", "post");
});
