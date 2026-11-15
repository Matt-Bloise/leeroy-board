// The one place the Worker decides where the Anthropic credential comes from. The key is never in the repo, never in [vars],
// never logged, never in an error string, a trace row, a response, a cache key or a metadata header.
//
// Routes, in order:
//   1. gateway-byok  ANTHROPIC_BYOK = "on" (exact): the key is stored in the AI Gateway (dashboard, Provider Keys). The request carries
//                    cf-aig-authorization only (no x-api-key), never follows a redirect, and never falls back to the direct endpoint.
//   2. store         ANTHROPIC_KEY_STORE: a Cloudflare Secrets Store binding; `await binding.get()` raced against a short timeout,
//                    single-flight per binding, cached 5 minutes (failures and empties 30 seconds).
//   3. legacy        ANTHROPIC_API_KEY: the Worker secret used today.
// A value with whitespace or control characters is treated as not configured. anthropicAvailable() is the cheap presence check for
// provider selection; it never reads the store.

export const KEY_TTL_MS = 5 * 60 * 1000;
export const NEG_TTL_MS = 30 * 1000;
export const STORE_TIMEOUT_MS = 1500;

const keyCache = new WeakMap(); // store binding -> { value, at } | { bad: reason, at }
const inflight = new WeakMap(); // store binding -> Promise
const trackedBindings = new Set();
const regexCache = new Map();
let warnedByok = false;

export function resetKeyCacheForTests() {
  for (const b of trackedBindings) { keyCache.delete(b); inflight.delete(b); }
  trackedBindings.clear();
  regexCache.clear();
  warnedByok = false;
}

// Drop a cached store key (called when Anthropic answers 401 or 403, so a rotated key is picked up on the next ask).
export function clearStoreKey(env) {
  const b = env && env.ANTHROPIC_KEY_STORE;
  if (b && typeof b === "object") keyCache.delete(b);
}

// ---- scrubbing ----
const KEY_PATTERN = /\bsk-ant-[A-Za-z0-9_-]{8,}/g;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
const escChain = (c) => (c === "-" || c === "_" ? "[-_.]" : esc(c)); // a separator swapped for another ("sk.ant.FAKE") still matches
const SEP ="(?:\\s|\\\\[nrt])*"; // whitespace or an escaped newline between key characters

// One regex per known key: the exact key and every suffix of 8+ chars (nested, tolerant of separators), plus base64, hex,
// percent-encoded, --escaped and JSON-escaped forms. Case-insensitive, so upper and lower case forms match too.
function knownKeyRegex(key) {
  const hit = regexCache.get(key);
  if (hit) return hit;
  let re;
  if (key.length < 8) {
    re = new RegExp(esc(key), "g");
  } else {
    const chars = [...key];
    const n = chars.length;
    // Left-extensions nest: c_j is only tried when everything to its left in the chain was consumed, so any suffix of 8+ chars matches.
    let left = "";
    for (let j = 0; j <= n - 9; j++) left = `(?:${left}${escChain(chars[j])}${SEP})?`;
    const chain = left + chars.slice(n - 8).map(escChain).join(SEP);
    const b64 = Buffer.from(key).toString("base64");
    // base64 of the key at the other two byte alignments (the key embedded after 1 or 2 bytes, e.g. "x:" + key); neighbour-dependent edges are dropped
    const shifted = [1, 2].map((k) => Buffer.from("\0".repeat(k) + key).toString("base64").replace(/=+$/, "")).map((b, i) => b.slice(i === 0 ? 2 : 3, -2));
    const forms = new Set([
      ...shifted, b64, b64.replace(/=+$/, ""), Buffer.from(key).toString("base64url"), Buffer.from(key).toString("hex"),
      encodeURIComponent(key), encodeURIComponent(key).replace(/-/g, "%2D"),
      chars.map((c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0")).join(""),
      key.replace(/-/g, "\\u002d"), JSON.stringify(key).slice(1, -1),
    ]);
    const literal = [...forms].filter((f) => f.length >= 8).sort((a, b) => b.length - a.length).map(esc);
    re = new RegExp([...literal, chain].join("|"), "gi");
  }
  if (regexCache.size >= 8) regexCache.clear();
  regexCache.set(key, re);
  return re;
}

export function scrubSecrets(text, knownKey = "") {
  let s = String(text == null ? "" : text);
  if (typeof knownKey === "string" && knownKey.length >= 4) {
    const re = knownKeyRegex(knownKey);
    re.lastIndex = 0;
    s = s.replace(re, "[redacted]");
  }
  return s.replace(KEY_PATTERN, "[redacted]");
}

// An Error whose message, stack, code and cause chain cannot carry the key. Returns the same object when nothing needed scrubbing.
export function scrubError(err, knownKey = "", depth = 0) {
  if (!(err instanceof Error)) return err == null ? err : scrubSecrets(err, knownKey);
  const message = err.message != null ? String(err.message) : "";
  const stack = String(err.stack || "");
  const code = err.code;
  const cleanMessage = scrubSecrets(message, knownKey);
  const cleanCode = typeof code === "string" ? scrubSecrets(code, knownKey) : code;
  const hasCause = "cause" in err && err.cause != null;
  const cleanCause = hasCause && depth < 4 ? scrubError(err.cause, knownKey, depth + 1) : undefined;
  const causeChanged = hasCause && (depth >= 4 || cleanCause !== err.cause);
  if (cleanMessage === message && scrubSecrets(stack, knownKey) === stack && cleanCode === code && !causeChanged) return err;
  const out = new Error(cleanMessage);
  if (cleanCode !== undefined) out.code = cleanCode;
  if (err.name && err.name !== "Error") out.name = scrubSecrets(err.name, knownKey);
  if (hasCause) out.cause = depth >= 4 ? "[redacted]" : cleanCause;
  out.stack = `${out.name}: ${cleanMessage}`;
  return out;
}

// ---- validation and flags ----
const cleanValue = (v) => typeof v === "string" && v.length > 0 && !/[\s\x00-\x1f\x7f]/.test(v);
const blank = (v) => typeof v !== "string" || v.trim() === "";

// "on" (exact) is on; unset, empty and "off" are off; anything else warns once (no value in the message) and is off.
function byokOn(env) {
  const v = env ? env.ANTHROPIC_BYOK : undefined;
  if (v === "on") return true;
  if (v === undefined || v === null || v === "" || v === "off") return false;
  if (!warnedByok) {
    warnedByok = true;
    console.warn('[AI-Keys] ANTHROPIC_BYOK has an unrecognised value: only the exact strings "on" and "off" are read; treating it as off');
  }
  return false;
}

// BYOK prerequisites: account id, gateway id and gateway token present, with no whitespace in any of them.
export function gatewayReady(env) {
  if (!env) return false;
  const account = env.CLOUDFLARE_ACCOUNT_ID || env.ACCOUNT_ID || env.CF_ACCOUNT_ID;
  const token = env.AI_GATEWAY_TOKEN || env.CLOUDFLARE_AIG_TOKEN;
  return cleanValue(account) && cleanValue(env.AI_GATEWAY_ID) && cleanValue(token);
}

const hasStore = (env) => Boolean(env && env.ANTHROPIC_KEY_STORE && typeof env.ANTHROPIC_KEY_STORE.get === "function");

// Cheap presence check for provider selection. Never calls get().
export function anthropicAvailable(env, { now = Date.now } = {}) {
  if (byokOn(env)) return gatewayReady(env);
  if (hasStore(env)) {
    const hit = keyCache.get(env.ANTHROPIC_KEY_STORE);
    const knownBad = hit && hit.bad && now() - hit.at < NEG_TTL_MS;
    if (!knownBad) return true;
  }
  return cleanValue(env && env.ANTHROPIC_API_KEY);
}

async function readStore(binding, { now, ttlMs, timeoutMs }) {
  const hit = keyCache.get(binding);
  if (hit) {
    if (hit.value && now() - hit.at < ttlMs) return { value: hit.value };
    if (hit.bad && now() - hit.at < NEG_TTL_MS) return { reason: hit.bad };
  }
  const running = inflight.get(binding);
  if (running) return running;
  trackedBindings.add(binding);
  const p = (async () => {
    let timer;
    let result;
    try {
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), timeoutMs); });
      const raw = await Promise.race([Promise.resolve().then(() => binding.get()), timeout]);
      if (typeof raw !== "string" || raw.trim() === "") result = { reason: "store-empty" };
      else if (!cleanValue(raw)) result = { reason: "store-invalid" };
      else result = { value: raw };
    } catch (e) {
      result = { reason: e && e.message === "timeout" ? "store-timeout" : "store-error" }; // the thrown message is dropped on purpose
    } finally {
      clearTimeout(timer);
    }
    keyCache.set(binding, result.value ? { value: result.value, at: now() } : { bad: result.reason, at: now() });
    return result;
  })().finally(() => inflight.delete(binding));
  inflight.set(binding, p);
  return p;
}

// -> { mode: "gateway-byok" | "store" | "legacy" | "none", headers, reason? }. reason is a short non-secret tag.
export async function anthropicAuth(env, { now = Date.now, ttlMs = KEY_TTL_MS, timeoutMs = STORE_TIMEOUT_MS } = {}) {
  if (byokOn(env)) return { mode: "gateway-byok", headers: {} };

  let reason;
  if (hasStore(env)) {
    const r = await readStore(env.ANTHROPIC_KEY_STORE, { now, ttlMs, timeoutMs });
    if (r.value) return { mode: "store", headers: { "x-api-key": r.value } };
    reason = r.reason;
  }

  const legacy = env && env.ANTHROPIC_API_KEY;
  if (cleanValue(legacy)) return { mode: "legacy", headers: { "x-api-key": legacy }, ...(reason ? { reason } : {}) };
  if (legacy && !blank(legacy)) reason = reason || "legacy-invalid";
  return { mode: "none", headers: {}, ...(reason ? { reason } : {}) };
}
