// The one place the Worker decides where the Anthropic credential comes from. The key is never in the repo, never in [vars],
// never logged, never in an error string, a trace row, a response, a cache key or a metadata header.
//
// Routes, in order:
//   1. gateway-byok  ANTHROPIC_BYOK = "on": the key lives in the AI Gateway (dashboard, Provider Keys) and never enters the Worker.
//                    The request carries cf-aig-authorization only (no x-api-key), and the direct-endpoint fallback is disabled.
//   2. store         ANTHROPIC_KEY_STORE: a Cloudflare Secrets Store binding; `await binding.get()`, cached in this isolate for 5 minutes.
//   3. legacy        ANTHROPIC_API_KEY: the Worker secret used today.
// anthropicAvailable() is the cheap presence check for provider selection; it never reads the store.

export const KEY_TTL_MS = 5 * 60 * 1000;

const keyCache = new WeakMap(); // store binding object -> { value, at }

export function resetKeyCacheForTests() {
  // WeakMap has no clear(); tests build fresh binding objects, but a test may reuse one, so swap the entries out by tracking them.
  for (const b of trackedBindings) keyCache.delete(b);
  trackedBindings.clear();
}
const trackedBindings = new Set();

const KEY_PATTERN = /sk-ant-[A-Za-z0-9_-]*/g;

// Defensive scrub: the Anthropic key pattern, plus the exact value when the caller knows it.
export function scrubSecrets(text, knownKey = "") {
  let s = String(text == null ? "" : text);
  if (knownKey && typeof knownKey === "string" && knownKey.length >= 8) s = s.split(knownKey).join("[redacted]");
  return s.replace(KEY_PATTERN, "[redacted]");
}

// An Error whose message cannot carry the key. Keeps the class-relevant fields (code, name) the callers branch on.
export function scrubError(err, knownKey = "") {
  const message = err && err.message != null ? String(err.message) : String(err);
  const clean = scrubSecrets(message, knownKey);
  const stack = String((err && err.stack) || "");
  if (err instanceof Error && clean === message && scrubSecrets(stack, knownKey) === stack) return err;
  const out = new Error(clean);
  if (err && err.code) out.code = err.code;
  if (err && err.name && err.name !== "Error") out.name = err.name;
  out.stack = `${out.name}: ${clean}`;
  return out;
}

const hasStore = (env) => Boolean(env && env.ANTHROPIC_KEY_STORE && typeof env.ANTHROPIC_KEY_STORE.get === "function");
const byokOn = (env) => Boolean(env) && env.ANTHROPIC_BYOK === "on";

export function anthropicAvailable(env) {
  return byokOn(env) || hasStore(env) || Boolean(env && env.ANTHROPIC_API_KEY);
}

// -> { mode: "gateway-byok" | "store" | "legacy" | "none", headers, reason? }. reason is a short non-secret tag.
export async function anthropicAuth(env, { now = Date.now, ttlMs = KEY_TTL_MS } = {}) {
  if (byokOn(env)) return { mode: "gateway-byok", headers: {} };

  let reason;
  if (hasStore(env)) {
    const binding = env.ANTHROPIC_KEY_STORE;
    const hit = keyCache.get(binding);
    const t = now();
    if (hit && t - hit.at < ttlMs) return { mode: "store", headers: { "x-api-key": hit.value } };
    try {
      const raw = await binding.get();
      const value = typeof raw === "string" ? raw.trim() : "";
      if (value) {
        keyCache.set(binding, { value, at: t });
        trackedBindings.add(binding);
        return { mode: "store", headers: { "x-api-key": value } };
      }
      reason = "store-empty";
    } catch {
      reason = "store-error"; // the thrown message is dropped on purpose
    }
  }

  if (env && env.ANTHROPIC_API_KEY) return { mode: "legacy", headers: { "x-api-key": env.ANTHROPIC_API_KEY }, ...(reason ? { reason } : {}) };
  return { mode: "none", headers: {}, ...(reason ? { reason } : {}) };
}
