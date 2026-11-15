// Security audit (Worker): POST /api/discord (before its signature is checked) and POST /api/token are open to anyone and read the whole body into
// memory with no limit. Both now refuse an oversized body with 413 before reading it all, whether or not it declares a Content-Length.
// Real Worker over an in-memory SQLite D1. No network.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../../infrastructure/worker/index.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";

const room = { fetch: async () => new Response("ok") };
const ctx = { waitUntil() {}, passThroughOnException() {} };
const env = () => ({ DB: schemaDb(), ALLOWED_ORIGINS: "", DISCORD_PUBLIC_KEY: "00".repeat(32), DISCORD_CLIENT_SECRET: "x", BOARD_ROOM: { idFromName: () => "r", get: () => room } });

// A body of `bytes` bytes handed over in 64 KiB chunks, with no Content-Length (what chunked transfer looks like to the Worker).
function chunked(bytes) {
  let sent = 0, pulled = 0;
  const stream = new ReadableStream({ pull(c) { if (sent >= bytes) return c.close(); const n = Math.min(65536, bytes - sent); sent += n; pulled += n; c.enqueue(new Uint8Array(n).fill(97)); } });
  return { stream, pulled: () => pulled };
}

for (const [path, headers] of [["/api/discord", { "X-Signature-Ed25519": "00", "X-Signature-Timestamp": String(Math.floor(Date.now() / 1000)) }], ["/api/token", {}]]) {
  test(`POST ${path}: a declared oversize body is refused with 413`, async () => {
    const big = "a".repeat(300 * 1024);
    const res = await worker.fetch(new Request(`https://api.test${path}`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: big }), env(), ctx);
    assert.equal(res.status, 413);
  });
  test(`POST ${path}: an undeclared (chunked) oversize body is cut off, not read to the end`, async () => {
    const { stream, pulled } = chunked(8 * 1024 * 1024);
    const res = await worker.fetch(new Request(`https://api.test${path}`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: stream, duplex: "half" }), env(), ctx);
    assert.equal(res.status, 413);
    assert.ok(pulled() < 1024 * 1024, `read ${pulled()} bytes before refusing`);
  });
}

test("a normal small /api/token body still reaches the code check", async () => {
  const res = await worker.fetch(new Request("https://api.test/api/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: "" }) }), env(), ctx);
  assert.equal(res.status, 400);
});
