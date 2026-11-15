// Capped body reader: the boundary (exactly the cap passes, one byte more is refused), the early stop with reader.cancel(), a chunked body on a real
// route, and the guest-facing model label and log lines of a failed ask. Fictional data, no network.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../../infrastructure/worker/index.js";
import { readTextCapped, readJsonCapped, MAX_BODY_BYTES } from "../../infrastructure/worker/limits.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";

const realFetch = globalThis.fetch;
globalThis.fetch = async () => new Response("blocked in tests", { status: 599 });
test.after(() => { globalThis.fetch = realFetch; });

const room = { fetch: async () => new Response("ok") };
const enc = (s) => new TextEncoder().encode(s);
// A request-like object whose body is a stream of the given chunks, recording pulls and cancel.
function streamed(chunks, { declared } = {}) {
  const seen = { pulled: 0, cancelled: false };
  let i = 0;
  const body = new ReadableStream({
    pull(c) { if (i >= chunks.length) return c.close(); const ch = chunks[i++]; seen.pulled += ch.byteLength; c.enqueue(ch); },
    cancel() { seen.cancelled = true; },
  }, { highWaterMark: 0 });
  return { req: { headers: { get: (k) => (k.toLowerCase() === "content-length" && declared !== undefined ? String(declared) : null) }, body }, seen };
}

test("readTextCapped: exactly the cap passes, one byte more is refused (single chunk and split chunks)", async () => {
  const exact = "a".repeat(100);
  assert.deepEqual(await readTextCapped(streamed([enc(exact)]).req, 100), { text: exact });
  assert.deepEqual(await readTextCapped(streamed([enc("a".repeat(60)), enc("a".repeat(40))]).req, 100), { text: exact });
  assert.deepEqual(await readTextCapped(streamed([enc(exact + "a")]).req, 100), { tooLarge: true });
  assert.deepEqual(await readTextCapped(streamed([enc("a".repeat(60)), enc("a".repeat(41))]).req, 100), { tooLarge: true });
});

test("readTextCapped: past the cap it stops pulling and cancels the stream (reader.cancel)", async () => {
  const chunks = Array.from({ length: 50 }, () => enc("a".repeat(100)));
  const { req, seen } = streamed(chunks);
  assert.deepEqual(await readTextCapped(req, 250), { tooLarge: true });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(seen.cancelled, true, "the stream was cancelled");
  assert.ok(seen.pulled < 1000, `pulled ${seen.pulled} of 5000 bytes`);
});

test("readTextCapped: a declared Content-Length over the cap is refused without opening the body; an empty body is the empty string", async () => {
  const { req, seen } = streamed([enc("x")], { declared: 101 });
  assert.deepEqual(await readTextCapped(req, 100), { tooLarge: true });
  assert.equal(seen.pulled, 0, "ReadableStream pre-pulls one chunk at most only once a reader exists; with no reader the highWaterMark pull is the only one");
  assert.deepEqual(await readTextCapped({ headers: { get: () => null }, body: null }, 100), { text: "" });
});

test("readJsonCapped: exactly MAX_BODY_BYTES passes as JSON, one more is refused", async () => {
  const exact = '{"p":"' + "x".repeat(MAX_BODY_BYTES - 8) + '"}';
  assert.equal(enc(exact).length, MAX_BODY_BYTES);
  assert.ok((await readJsonCapped(streamed([enc(exact)]).req)).body);
  assert.deepEqual(await readJsonCapped(streamed([enc(exact + " ")]).req), { tooLarge: true });
});

test("POST /api/intent: a chunked body (no Content-Length) over the cap is 413 and is not read to the end", async () => {
  let sent = 0;
  const stream = new ReadableStream({ pull(c) { if (sent >= 8 * 1024 * 1024) return c.close(); sent += 65536; c.enqueue(new Uint8Array(65536).fill(97)); } });
  const env = { DB: schemaDb(), ALLOWED_ORIGINS: "", BOARD_ROOM: { idFromName: () => "r", get: () => room } };
  const res = await worker.fetch(new Request("https://api.test/api/intent", { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.5" }, body: stream, duplex: "half" }), env, { waitUntil() {}, passThroughOnException() {} });
  assert.equal(res.status, 413);
  assert.ok(sent < 1024 * 1024, `read ${sent} bytes`);
});

// ---- a failed ask: the guest-facing model label and the log lines
async function failedAsk(aiError, setModel) {
  const DB = schemaDb();
  const env = { DB, USER_SALT: "user-salt-for-tests-0123456789", KEY_SALT: "key-salt-for-tests-0123456789", ALLOWED_ORIGINS: "", BOARD_ROOM: { idFromName: () => "r", get: () => room }, AI: { run: async () => { throw aiError; } } };
  const pending = [], logged = [];
  const ctx = { waitUntil: (p) => pending.push(p), passThroughOnException() {} };
  const keep = { e: console.error, w: console.warn, l: console.log };
  const grab = (...a) => logged.push(a.map(String).join(" "));
  console.error = grab; console.warn = grab; console.log = grab;
  try {
    const init = (method, body) => ({ method, headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.7" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const posted = await worker.fetch(new Request("https://api.test/api/intent", init("POST", { kind: "ask", text: "hello" })), env, ctx);
    const { id, secret } = await posted.json();
    await Promise.allSettled(pending);
    if (setModel) DB.raw.prepare("UPDATE ask_turns SET model = ? WHERE id = ?").run(setModel, id);
    const read = await worker.fetch(new Request(`https://api.test/api/ask?id=${id}&s=${secret}`, init("GET")), env, ctx);
    return { ask: (await read.json()).ask, logged: logged.join("\n") };
  } finally { console.error = keep.e; console.warn = keep.w; console.log = keep.l; }
}

test("GET /api/ask: the model a guest sees is the bare label, never a diagnostic suffix, whatever is stored", async () => {
  const MARK = "PROVIDER-MARKER-55";
  for (const stored of [`workers-ai:m (after claude: ${MARK})`, `manual (failed: ${MARK})`, `workers-ai:m [${MARK}]`, `workers-ai:m+research [x] (after a: ${MARK})`]) {
    const { ask } = await failedAsk(new Error("boom"), stored);
    assert.doesNotMatch(JSON.stringify(ask), /PROVIDER-MARKER/, stored);
    assert.doesNotMatch(String(ask.model), /after|failed|\[/, stored);
  }
  const { ask } = await failedAsk(new Error("boom"), "workers-ai:@cf/meta/m");
  assert.equal(ask.provider, "workers-ai");
  assert.equal(ask.model, "@cf/meta/m", "a plain label is untouched");
});

test("a failed ask: every log line is free of the provider text, including the gateway and fallback warnings", async () => {
  const MARK = "PROVIDER-MARKER-66 secret-binding";
  const { logged } = await failedAsk(Object.assign(new Error(MARK), { name: "WeirdError" }));
  assert.ok(logged.length > 0, "something was logged");
  assert.doesNotMatch(logged, /PROVIDER-MARKER|secret-binding/);
});

// The gateway and fallback warnings only run against live providers, so they are pinned at the source: no console call in ai-models.js prints raw error text.
test("ai-models.js: no console.error/warn argument is a raw err.message or a bare caught error", () => {
  const src = readFileSync(new URL("../../infrastructure/worker/ai-models.js", import.meta.url), "utf8");
  const calls = src.split("\n").filter((l) => /console\.(error|warn|log)\(/.test(l));
  assert.ok(calls.length >= 5);
  for (const l of calls) assert.doesNotMatch(l, /\b\w*[eE]rr\w*\.message|\be\.message|\be && e\.message|, e\)|, err\)/, l.trim());
});
