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
  assert.deepEqual(Object.keys(spec.paths).sort(), ["/api/atlas/{name}", "/api/bootstrap", "/api/data/{name}", "/api/health", "/api/me", "/api/signups", "/api/state"]);
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
