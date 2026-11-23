// Feature flags. Cloudflare Flagship (env.FLAGS, the [[flagship]] binding in wrangler.toml) when the Worker has it; otherwise the legacy
// wrangler.toml [vars] value of the same name. Local dev, unit tests and PR preview Workers have no binding (the preview deploy strips it),
// so they keep reading [vars] exactly as before.
//
// The flag key is the legacy var name, spelled exactly: flagOn(env, "D1_FEED") asks Flagship for the flag D1_FEED, or reads env.D1_FEED without a binding.
// Every flag must be a BOOLEAN flag in Flagship with the variations on (true) and off (false), default variation off.
// With a binding: a missing flag, a disabled flag, any throw, any answer other than true, or no answer within FLAG_TIMEOUT_MS means OFF; the [vars]
// value is not consulted. The timeout keeps a slow Flagship from stalling every request that checks a flag.
// Flags are created and flipped in the Cloudflare dashboard (Compute, Flagship), never by CI. See docs/runbooks/flags.md.
export const FLAG_TIMEOUT_MS = 100;
export const legacyOn = (env, key) => String((env && env[key]) || "").trim().toLowerCase() === "on";

// The same question as flagOn, but the answer says whether it WAS an answer: "on", "off" (a definite false, or no binding and the legacy variable not "on"), or "unknown" (the
// binding threw, rejected, timed out or answered something that is not a boolean). flagOn folds "unknown" into false; a caller that must fail closed when it cannot ask (the roster
// gate, ADR 0002 F2) uses this. flagOn itself is unchanged.
export async function flagState(env, key, evalContext) {
  const b = env && env.FLAGS;
  if (b && typeof b.getBooleanValue === "function") {
    let timer;
    try {
      const ask = evalContext === undefined ? b.getBooleanValue(key, false) : b.getBooleanValue(key, false, evalContext);
      const late = new Promise((resolve) => { timer = setTimeout(() => resolve("late"), FLAG_TIMEOUT_MS); });
      const v = await Promise.race([Promise.resolve(ask).then((x) => ({ v: x }), () => "failed"), late]);
      if (v === "late" || v === "failed") return "unknown";
      return v.v === true ? "on" : v.v === false ? "off" : "unknown";
    } catch {
      return "unknown";
    } finally {
      clearTimeout(timer);
    }
  }
  return legacyOn(env, key) ? "on" : "off";
}

export async function flagOn(env, key, evalContext) {
  const b = env && env.FLAGS;
  if (b && typeof b.getBooleanValue === "function") {
    let timer;
    try {
      const ask = evalContext === undefined ? b.getBooleanValue(key, false) : b.getBooleanValue(key, false, evalContext);
      const late = new Promise((resolve) => { timer = setTimeout(() => resolve(false), FLAG_TIMEOUT_MS); });
      // If the binding call later rejects after the timeout won the race, that rejection is already handled here.
      const v = await Promise.race([Promise.resolve(ask).catch(() => false), late]);
      return v === true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
  return legacyOn(env, key);
}
