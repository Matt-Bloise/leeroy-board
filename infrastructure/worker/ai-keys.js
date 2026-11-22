// The one place the Worker decides where the Anthropic credential comes from. The key is never in the repo, never in [vars],
// never logged, never in an error string, a trace row, a response, a cache key or a metadata header.
//
// Routes, in order:
//   1. gateway-byok  ANTHROPIC_BYOK = "on" (exact): the key is stored in the AI Gateway (dashboard, Provider Keys). The request carries
//                    cf-aig-authorization only (no x-api-key), never follows a redirect, and never falls back to the direct endpoint.
//   2. store         ANTHROPIC_KEY_STORE: a Cloudflare Secrets Store binding; `await binding.get()` raced against a short timeout,
//                    single-flight per binding, cached 5 minutes (failures and empties 30 seconds).
//   3. legacy        ANTHROPIC_API_KEY: the Worker secret used today.
// Edge whitespace on a stored or legacy value is trimmed; interior whitespace, control characters or more than 512 characters mean not configured. anthropicAvailable() is the cheap presence check for
// provider selection; it never reads the store.

export const KEY_TTL_MS = 5 * 60 * 1000;
export const NEG_TTL_MS = 30 * 1000;
export const STORE_TIMEOUT_MS = 1500;

const keyCache = new WeakMap(); // store binding -> { value, at } | { bad: reason, at }
const inflight = new WeakMap(); // store binding -> Promise
const trackedBindings = new Set();
let warnedByok = false;

export function resetKeyCacheForTests() {
  for (const b of trackedBindings) { keyCache.delete(b); inflight.delete(b); }
  trackedBindings.clear();
  windowCache.clear();
  warnedByok = false;
}

// Drop a cached store key (called when Anthropic answers 401 or 403, so a rotated key is picked up on the next ask).
export function clearStoreKey(env) {
  const b = env && env.ANTHROPIC_KEY_STORE;
  if (b && typeof b === "object") keyCache.delete(b);
}

// ---- scrubbing ----
// No regex is ever built from the key (a long key crashed the regex compiler). Everything below is string and Set work, linear in the
// text, and the text is capped first. Layers, in order: cap, exact key, the last 8 characters, the sk-ant- pattern, then a window check.
export const SCRUB_CAP = 20000;
export const MAX_KEY_CHARS = 512;
const WINDOW = 12;
const KEY_PATTERN = /\bsk-ant-[A-Za-z0-9_-]{8,}/g;
const TRUNCATED = " [truncated]";

// Canonical form for matching: Unicode compatibility fold (fullwidth to ASCII), lower case, letters and digits only. Separators of every
// kind (spaces, NUL, zero-width, commas, backslashes, quotes, markdown escapes, dashes, dots) disappear on both sides.
const isAlnum = (code) => (code >= 48 && code <= 57) || (code >= 97 && code <= 122);
function canonWithMap(text) {
  const chars = [];
  const at = [];
  let i = 0;
  for (const cp of text) {
    const n = cp.length === 1 && cp.charCodeAt(0) < 128 ? cp.toLowerCase() : cp.normalize("NFKC").toLowerCase();
    for (let k = 0; k < n.length; k++) {
      if (isAlnum(n.charCodeAt(k))) { chars.push(n[k]); at.push(i); }
    }
    i += cp.length;
  }
  return { c: chars.join(""), at };
}
const canon = (s) => canonWithMap(String(s)).c;
const reverse = (s) => [...s].reverse().join("");
const rot13 = (s) => s.replace(/[a-z]/gi, (ch) => { const b = ch <= "Z" ? 65 : 97; return String.fromCharCode(((ch.charCodeAt(0) - b + 13) % 26) + b); });
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32(buf) {
  let bits = "";
  let out = "";
  for (const b of buf) bits += b.toString(2).padStart(8, "0");
  for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, "0"), 2)];
  return out;
}

// Byte helpers on plain Uint8Array (TextEncoder and btoa exist in Workers and in Node; Buffer exists only in Node or with nodejs_compat).
const utf8Bytes = (s) => new TextEncoder().encode(s); // lone surrogates become U+FFFD, as Buffer.from(string) did
function utf16leBytes(s) {
  const out = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); out[2 * i] = c & 255; out[2 * i + 1] = c >> 8; }
  return out;
}
function swap16(u8) {
  const out = new Uint8Array(u8.length);
  for (let i = 0; i + 1 < u8.length; i += 2) { out[i] = u8[i + 1]; out[i + 1] = u8[i]; }
  return out;
}
function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
function base64(u8) {
  let bin = "";
  for (let i = 0; i < u8.length; i += 4096) bin += String.fromCharCode(...u8.subarray(i, i + 4096));
  return btoa(bin);
}

const windowCache = new Map(); // key -> { size, set }

// Every 12-character window (the key's own length when shorter, minimum 8) of the key and of the forms an evasion can take:
// the key, rot13, escaped-dash variants, base64 / base32 / UTF-16 at every byte alignment, hex and char-code forms with the usual
// prefixes (x, 0x, %25, u00, decimal), and the reverse of each. A form is added in canonical form (see canonWithMap).
function windowsFor(key) {
  const hit = windowCache.get(key);
  if (hit) return hit;
  const base = canon(key);
  let result = null;
  if (base.length >= 8) {
    const size = Math.min(WINDOW, base.length);
    const forms = new Set();
    const add = (s) => { const c = canon(s); if (c.length >= size) { forms.add(c); forms.add(reverse(c)); } };
    add(key);
    add(rot13(key));
    for (const r of ["2d", "u002d", "45", "x2d"]) add(key.replaceAll("-", r));
    // No Node globals here: the Worker runs without nodejs_compat, where `Buffer` does not exist (a ReferenceError that used to hide every Claude outcome, see failReason in research/claude.js).
    const bytes = utf8Bytes(key);
    const u16 = utf16leBytes(key);
    const u16swapped = swap16(u16);
    for (let k = 0; k < 5; k++) {
      const pad = new Uint8Array(k).fill(120); // "x" repeated k times
      if (k < 3) {
        add(base64(concatBytes(pad, bytes)));
        add(base64(concatBytes(pad, u16)));
        add(base64(concatBytes(pad, u16swapped)));
      }
      add(base32(concatBytes(pad, bytes)));
    }
    for (const p of ["", "x", "0x", "25", "u00"]) {
      add([...bytes].map((b) => p + b.toString(16).padStart(2, "0")).join(""));
      if (p === "") add([...u16].map((b) => b.toString(16).padStart(2, "0")).join(""));
    }
    add([...key].map((ch) => ch.charCodeAt(0)).join(""));
    const set = new Set();
    for (const f of forms) for (let i = 0; i + size <= f.length; i++) set.add(f.slice(i, i + size));
    result = { size, set };
  }
  if (windowCache.size >= 8) windowCache.clear();
  windowCache.set(key, result);
  return result;
}

// Redact every canonical window hit, widened by (size - 1) on each side, mapped back to the original text.
function redactWindows(text, win) {
  const { c, at } = canonWithMap(text);
  if (c.length < win.size) return text;
  const marks = new Int32Array(c.length + 1);
  let any = false;
  for (let p = 0; p + win.size <= c.length; p++) {
    if (win.set.has(c.substr(p, win.size))) {
      any = true;
      marks[Math.max(0, p - (win.size - 1))] += 1;
      marks[Math.min(c.length, p + 2 * win.size - 1)] -= 1;
    }
  }
  if (!any) return text;
  const out = [];
  let open = 0;
  let last = 0; // original index already copied
  let spanStart = -1;
  for (let p = 0; p < c.length; p++) {
    open += marks[p];
    if (open > 0 && spanStart < 0) spanStart = at[p];
    if (open <= 0 && spanStart >= 0) {
      out.push(text.slice(last, spanStart), "[redacted]");
      last = at[p - 1] + 1;
      spanStart = -1;
    }
  }
  if (spanStart >= 0) { out.push(text.slice(last, spanStart), "[redacted]"); last = text.length; }
  out.push(text.slice(last));
  return out.join("");
}

// Replace each occurrence of `lit` (and, for the tail, the preceding characters that continue the key leftwards).
function redactTail(text, key) {
  const n = key.length;
  let s = text;
  for (const k of new Set([key, key.toLowerCase(), key.toUpperCase()])) {
    const lit = k.slice(-8);
    if (s.indexOf(lit) < 0) continue;
    const out = [];
    let from = 0;
    for (let i = s.indexOf(lit); i >= 0; i = s.indexOf(lit, from)) {
      let t = 0;
      while (i - 1 - t >= from && n - 9 - t >= 0 && s[i - 1 - t] === k[n - 9 - t]) t++;
      out.push(s.slice(from, i - t), "[redacted]");
      from = i + lit.length;
    }
    out.push(s.slice(from));
    s = out.join("");
  }
  return s;
}

export function scrubSecrets(text, knownKey = "") {
  let s = String(text == null ? "" : text);
  if (s.length > SCRUB_CAP) s = s.slice(0, SCRUB_CAP - WINDOW + 1); // cut, never pass the rest through; the edge may hold a key fragment, so it is shortened too
  const truncated = String(text == null ? "" : text).length > SCRUB_CAP;
  if (typeof knownKey === "string" && knownKey.length >= 4 && knownKey.length <= MAX_KEY_CHARS) {
    s = s.split(knownKey).join("[redacted]");
    if (knownKey.length >= 8) s = redactTail(s, knownKey);
  }
  s = s.replace(KEY_PATTERN, "[redacted]");
  if (typeof knownKey === "string" && knownKey.length >= 8 && knownKey.length <= MAX_KEY_CHARS) {
    const win = windowsFor(knownKey);
    if (win) s = redactWindows(s, win);
  }
  return truncated ? s + TRUNCATED : s;
}

// An Error whose message, name, stack, code and cause chain cannot carry the key. Returns the same object when nothing needed scrubbing.
export function scrubError(err, knownKey = "", depth = 0) {
  if (!(err instanceof Error)) return err == null ? err : scrubSecrets(err, knownKey);
  const message = err.message != null ? String(err.message) : "";
  const stack = String(err.stack || "");
  const name = String(err.name || "Error");
  const code = err.code;
  const cleanMessage = scrubSecrets(message, knownKey);
  const cleanName = scrubSecrets(name, knownKey);
  const cleanCode = typeof code === "string" ? scrubSecrets(code, knownKey) : code;
  const hasCause = "cause" in err && err.cause != null;
  const cleanCause = hasCause && depth < 4 ? scrubError(err.cause, knownKey, depth + 1) : undefined;
  const causeChanged = hasCause && (depth >= 4 || cleanCause !== err.cause);
  if (cleanMessage === message && cleanName === name && scrubSecrets(stack, knownKey) === stack && cleanCode === code && !causeChanged) return err;
  const out = new Error(cleanMessage);
  if (cleanCode !== undefined) out.code = cleanCode;
  if (cleanName !== "Error") out.name = cleanName;
  if (hasCause) out.cause = depth >= 4 ? "[redacted]" : cleanCause;
  out.stack = `${out.name}: ${cleanMessage}`;
  return out;
}

// ---- validation and flags ----
// A credential: edge whitespace (a pasted secret, a trailing newline from printf) is trimmed and the trimmed value is used; interior
// whitespace or control characters, or more than MAX_KEY_CHARS characters, mean not configured.
function credential(v) {
  if (typeof v !== "string") return { empty: true };
  const t = v.trim();
  if (!t) return { empty: true };
  if (t.length > MAX_KEY_CHARS || /[\s\x00-\x1f\x7f]/.test(t)) return { invalid: true };
  return { value: t };
}
const cleanValue = (v) => typeof v === "string" && v.length > 0 && !/[\s\x00-\x1f\x7f]/.test(v); // strict: gateway account, id and token

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
  return Boolean(credential(env && env.ANTHROPIC_API_KEY).value);
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
      const cred = credential(raw);
      if (cred.empty) result = { reason: "store-empty" };
      else if (cred.invalid) result = { reason: "store-invalid" };
      else result = { value: cred.value };
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

  const legacy = credential(env && env.ANTHROPIC_API_KEY);
  if (legacy.value) return { mode: "legacy", headers: { "x-api-key": legacy.value }, ...(reason ? { reason } : {}) };
  if (legacy.invalid) reason = reason || "legacy-invalid";
  return { mode: "none", headers: {}, ...(reason ? { reason } : {}) };
}
