// Security headers on every Worker response; CORS unchanged. Fakes only, no AI calls.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../../infrastructure/worker/index.js";
import { SECURITY_HEADERS, withSecurityHeaders } from "../../infrastructure/worker/security-headers.js";
import { corsHeaders } from "../../infrastructure/worker/cors.js";
import { fakeD1 } from "./fake-d1.mjs";

const ORIGIN = "https://leeroy.party";
const env = { ALLOWED_ORIGINS: ORIGIN, DB: fakeD1({}) };
const ctx = { waitUntil() {} };
const call = (path, init = {}) => worker.fetch(new Request("https://api.leeroy.party" + path, init), env, ctx);

function assertSecurity(res) {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) assert.equal(res.headers.get(k), v, k);
  assert.equal(res.headers.get("Strict-Transport-Security"), "max-age=31536000");
  assert.equal(res.headers.get("X-Frame-Options"), "DENY");
  assert.equal(res.headers.get("Referrer-Policy"), "no-referrer");
  assert.equal(res.headers.get("Content-Security-Policy"), "default-src 'none'; frame-ancestors 'none'");
  assert.equal(res.headers.get("Cross-Origin-Resource-Policy"), "cross-origin");
}

test("normal response carries the security headers", async () => {
  const res = await call("/health", { headers: { Origin: ORIGIN } });
  assertSecurity(res);
});

test("error response (forbidden origin) carries the security headers", async () => {
  const res = await call("/health", { headers: { Origin: "https://evil.example" } });
  assert.equal(res.status, 403);
  assertSecurity(res);
});

test("OPTIONS preflight carries the security headers and unchanged CORS", async () => {
  const res = await call("/anything", { method: "OPTIONS", headers: { Origin: ORIGIN } });
  assert.equal(res.status, 204);
  assertSecurity(res);
  for (const [k, v] of Object.entries(corsHeaders(ORIGIN))) assert.equal(res.headers.get(k), v, k);
});

test("404 carries the security headers and CORS is unchanged", async () => {
  const res = await call("/no/such/route", { headers: { Origin: ORIGIN } });
  assertSecurity(res);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), ORIGIN);
});

test("no CORS headers are added without an Origin", async () => {
  const res = await call("/no/such/route");
  assertSecurity(res);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), null);
});

test("websocket upgrade (101) passes through untouched", () => {
  const ws = { status: 101, webSocket: {}, headers: { set() { throw new Error("must not touch"); } } };
  assert.equal(withSecurityHeaders(ws), ws);
});

test("immutable headers are rebuilt, body and status kept", async () => {
  const res = new Response("x", { status: 200, headers: { "Content-Type": "text/plain" } });
  Object.defineProperty(res, "headers", { value: { set() { throw new TypeError("immutable"); }, entries: () => res_h.entries(), [Symbol.iterator]: () => res_h[Symbol.iterator]() } });
  const res_h = new Headers({ "Content-Type": "text/plain" });
  const out = withSecurityHeaders(res);
  assertSecurity(out);
  assert.equal(out.headers.get("Content-Type"), "text/plain");
});
