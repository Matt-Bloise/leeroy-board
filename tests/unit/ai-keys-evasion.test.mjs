// W-key round 3: edge-whitespace regression, linear-time scrub with a cap, key length cap, and the 12-character window check
// against encoding evasions. Offline, fake keys only. Run: node --test tests/unit/ai-keys-evasion.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { anthropicAuth, anthropicAvailable, scrubSecrets, scrubError, resetKeyCacheForTests, SCRUB_CAP, MAX_KEY_CHARS } from "../../infrastructure/worker/ai-keys.js";
import { dispatchToProvider } from "../../infrastructure/worker/ai-models.js";

const K = "sk-ant-FAKE-0000-api03-AAAAbbbbCCCCddddEEEEffff0000111122223333";
const baseEnv = { CLOUDFLARE_ACCOUNT_ID: "acct1", AI_GATEWAY_ID: "gw1", AI_GATEWAY_TOKEN: "tok" };
const GW = "https://gateway.ai.cloudflare.com/v1/acct1/gw1/anthropic/v1/messages";
const OK = () => new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), { status: 200 });
const canon = (s) => String(s).normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/g, "");
const lcs = (t, key) => { t = String(t).toLowerCase(); key = key.toLowerCase(); let best = 0; for (let i = 0; i < key.length; i++) { let lo = best + 1; while (i + lo <= key.length && t.includes(key.slice(i, i + lo))) { best = lo; lo++; } } return best; };
const rev = (s) => [...s].reverse().join("");

test.beforeEach(() => resetKeyCacheForTests());

// ---- 1. edge whitespace regression ----
test("legacy key with edge whitespace is trimmed and sent: byte-identical request to the clean key", async () => {
  const capture = async (value) => {
    const calls = [];
    const real = globalThis.fetch;
    globalThis.fetch = async (url, init) => { calls.push({ url, headers: { ...init.headers }, body: init.body }); return OK(); };
    try { await dispatchToProvider({ provider: "claude", env: { ...baseEnv, ANTHROPIC_API_KEY: value }, systemPrompt: "S", userPrompt: "U", deep: false }); } finally { globalThis.fetch = real; }
    return JSON.stringify(calls);
  };
  const clean = await capture(K);
  assert.ok(clean.includes(GW));
  for (const v of [`${K}\n`, `${K}\r\n`, ` ${K}`, `\t${K} \n`]) assert.equal(await capture(v), clean, JSON.stringify(v));
});

test("store value with edge whitespace is trimmed; interior whitespace is not configured", async () => {
  const a = await anthropicAuth({ ANTHROPIC_KEY_STORE: { get: async () => `${K}\n` } });
  assert.deepEqual(a, { mode: "store", headers: { "x-api-key": K } });
  resetKeyCacheForTests();
  assert.equal((await anthropicAuth({ ANTHROPIC_KEY_STORE: { get: async () => "sk-ant-aaa bbb" } })).mode, "none");
  assert.equal(anthropicAvailable({ ANTHROPIC_API_KEY: `${K}\n` }), true);
  assert.equal(anthropicAvailable({ ANTHROPIC_API_KEY: "sk-ant-aaa\tbbb" }), false);
  assert.equal(anthropicAvailable({ ANTHROPIC_API_KEY: " \n " }), false);
});

// ---- 3. key length cap ----
test("a value over the length cap is not configured and never crashes the scrub", async () => {
  assert.equal(MAX_KEY_CHARS, 512);
  const big = "sk-ant-" + "A1b2".repeat(750);
  assert.equal((await anthropicAuth({ ANTHROPIC_API_KEY: big })).mode, "none");
  assert.equal((await anthropicAuth({ ANTHROPIC_KEY_STORE: { get: async () => big } })).mode, "none");
  assert.equal(anthropicAvailable({ ANTHROPIC_API_KEY: big }), false);
  const out = scrubSecrets(`x ${big} y`, big); // must not throw or crash the process
  assert.ok(!out.includes("A1b2A1b2A1b2"));
  const edge = "sk-ant-" + "Z".repeat(MAX_KEY_CHARS - 7);
  assert.equal((await anthropicAuth({ ANTHROPIC_API_KEY: edge })).mode, "legacy");
  assert.equal((await anthropicAuth({ ANTHROPIC_API_KEY: edge + "Z" })).mode, "none");
  assert.ok(!scrubSecrets(`a ${edge} b`, edge).includes("ZZZZZZZZZZZZ"));
});

// ---- 2. linear time and cap ----
test("1 MB hostile input scrubs in under 500 ms each (scrubSecrets and scrubError), output is capped", () => {
  assert.equal(SCRUB_CAP, 20000);
  const MB = 1024 * 1024;
  const fill = (unit) => unit.repeat(Math.ceil(MB / unit.length)).slice(0, MB);
  const inputs = {
    "backslash-n runs": fill("\\n"), "backslash-t runs": fill("\\t"), "backslash-r runs": fill("\\r"),
    "key minus last char repeated": fill(K.slice(0, -1)), "key suffix repeated": fill(K.slice(8)), "sk-ant- repeated": fill("sk-ant-"),
    "key chars each followed by escapes": fill([...K].join("\\n")), "spaces": fill(" "), "zero width": fill("​"), "percent": fill("%2"),
    "nul interleaved": fill([...K].join("\0")),
  };
  for (const [name, text] of Object.entries(inputs)) {
    let t0 = Date.now();
    const out = scrubSecrets(text, K);
    assert.ok(Date.now() - t0 < 500, `scrubSecrets ${name}: ${Date.now() - t0}ms`);
    assert.ok(out.length <= SCRUB_CAP + 40, `${name} capped`);
    t0 = Date.now();
    scrubError(new Error(text), K);
    assert.ok(Date.now() - t0 < 500, `scrubError ${name}: ${Date.now() - t0}ms`);
  }
});

test("text past the cap is cut, not passed through, even with the key in it", () => {
  const out = scrubSecrets("a".repeat(SCRUB_CAP + 100) + " " + K, K);
  assert.ok(!out.includes("FAKE-0000"));
  assert.ok(out.length <= SCRUB_CAP + 40);
  assert.equal(scrubSecrets("short text", K), "short text");
});

// ---- 4. window check over encoding evasions ----
const B32 = (buf) => { const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; let bits = "", o = ""; for (const b of buf) bits += b.toString(2).padStart(8, "0"); for (let i = 0; i < bits.length; i += 5) o += A[parseInt(bits.slice(i, i + 5).padEnd(5, "0"), 2)]; return o; };
const rot13 = (s) => s.replace(/[a-z]/gi, (c) => String.fromCharCode((c <= "Z" ? 90 : 122) >= (c = c.charCodeAt(0) + 13) ? c : c - 26));
const wrap = (s, n) => s.match(new RegExp(`.{1,${n}}`, "g")).join("\n");
const EVASIONS = {
  "middle slice, all but prefix and last char": K.slice(7, -1),
  "middle slice 20 chars": K.slice(20, 40),
  "x plus a slice": "x" + K.slice(15, 45),
  "three pieces": K.slice(0, 10) + " ... " + K.slice(10, 50) + " ... " + K.slice(50),
  "UTF-16LE with NULs": [...K].join("\0"),
  "zero-width spaces": [...K].join("​"),
  "reversed": rev(K),
  "HTML entity for the dash": K.replaceAll("-", "&#45;"),
  "HTML hex entity for the dash": K.replaceAll("-", "&#x2d;"),
  "markdown-escaped dashes": K.replaceAll("-", "\\-"),
  "base64 wrapped every 20": wrap(Buffer.from(K).toString("base64"), 20),
  "hex with colons": [...K].map((c) => c.charCodeAt(0).toString(16)).join(":"),
  "backslash-x hex": [...K].map((c) => "\\x" + c.charCodeAt(0).toString(16)).join(""),
  "double percent-encoding": [...K].map((c) => "%25" + c.charCodeAt(0).toString(16)).join(""),
  "percent-encoded dash": encodeURIComponent(K).replaceAll("-", "%2D"),
  "doubly escaped unicode dash": K.replaceAll("-", "\\\\u002d"),
  "comma between chars": [...K].join(","),
  "fullwidth letters": [...K].map((c) => (/[!-~]/.test(c) ? String.fromCharCode(c.charCodeAt(0) + 0xfee0) : c)).join(""),
  "quoted concatenation": `"${K.slice(0, 30)}" + "${K.slice(30)}"`,
  "base32": B32(Buffer.from(K)),
  "base32 shifted": B32(Buffer.from("xy" + K)),
  "rot13": rot13(K),
  "UTF-16LE base64": Buffer.from(K, "utf16le").toString("base64"),
  "UTF-16BE base64": Buffer.from(K, "utf16le").swap16().toString("base64"),
  "base64 shifted one byte": Buffer.from("x" + K).toString("base64"),
  "base64 shifted two bytes (Basic auth)": Buffer.from("x:" + K).toString("base64"),
  "base64url": Buffer.from(K).toString("base64url"),
  "decimal char codes": [...K].map((c) => `&#${c.charCodeAt(0)};`).join(""),
  "dashes as dots": K.replaceAll("-", "."),
  "reversed base64": rev(Buffer.from(K).toString("base64")),
  "reversed hex": rev(Buffer.from(K).toString("hex")),
  "upper hex": Buffer.from(K).toString("hex").toUpperCase(),
  "newline every 8": K.match(/.{1,8}/g).join("\n"),
  "tab and space separated": [...K].join(" \t"),
};

test("every listed evasion is redacted: no 12-character window of the evasion text survives", () => {
  for (const [name, v] of Object.entries(EVASIONS)) {
    const out = scrubSecrets(`Mira tanks tonight. Debug: ${v}\n-# Sources: classes/tanking`, K);
    const c = canon(out);
    const cv = canon(v);
    for (let i = 0; i + 12 <= cv.length; i++) assert.ok(!c.includes(cv.slice(i, i + 12)), `${name}: window ${cv.slice(i, i + 12)} survives`);
    assert.ok(lcs(out, K) < 12, `${name}: plain key run ${lcs(out, K)}`);
    assert.ok(lcs(out, rev(K)) < 12, `${name}: reversed key run`);
  }
});

test("clean text around a leak is mostly kept, and text with no key material is untouched", () => {
  const plain = "Mira tanks tonight at nine. Bring flasks. Sources: classes/tanking";
  assert.equal(scrubSecrets(plain, K), plain);
  const out = scrubSecrets(`Hello there friend. Key: ${K}. Goodbye now.`, K);
  assert.ok(out.startsWith("Hello there friend."));
  assert.ok(!out.includes("FAKE-0000"));
});

test("windows are scoped to the known key: another key's text is untouched", () => {
  const other = "sk-ant-OTHER-1111-api03-ZZZZyyyyXXXXwwwwVVVVuuuu99998888";
  const out = scrubSecrets(`${other.replace("sk-ant-", "sk_ant_")} and some filler words here to keep a gap before the leak ${canon(K).slice(0, 20)}`, K);
  assert.ok(!out.includes(canon(K).slice(0, 12)));
  assert.ok(out.includes("sk_ant_OTHER"));
});

test("the window check also runs on the 200 answer and on errors end to end", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ content: [{ type: "text", text: `ok ${Buffer.from(K.slice(7, -1)).toString("base64")} and ${[...K].join("​")}` }] }), { status: 200 });
  try {
    const r = await dispatchToProvider({ provider: "claude", env: { ...baseEnv, ANTHROPIC_API_KEY: K }, systemPrompt: "S", userPrompt: "U", deep: false });
    const c = canon(r.answer);
    assert.ok(!c.includes(canon(K).slice(5, 17)));
    assert.ok(!c.includes(canon(Buffer.from(K.slice(7, -1)).toString("base64")).slice(10, 22)));
  } finally { globalThis.fetch = real; }
  const e = scrubError(new Error(`bad ${[...K].join(",")}`), K);
  assert.ok(!canon(e.message).includes(canon(K).slice(0, 12)));
  const named = new Error("x"); named.name = K;
  assert.ok(!canon(scrubError(named, K).name).includes(canon(K).slice(0, 12)));
});
