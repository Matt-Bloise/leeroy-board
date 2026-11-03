// Feature flags. Cloudflare Flagship (env.FLAGS, the [[flagship]] binding in wrangler.toml) when the Worker has it; otherwise the legacy
// wrangler.toml [vars] value of the same name. Local dev, unit tests and PR preview Workers have no binding (the preview deploy strips it),
// so they keep reading [vars] exactly as before.
//
// The flag key is the legacy var name, spelled exactly: flagOn(env, "D1_FEED") asks Flagship for the flag D1_FEED, or reads env.D1_FEED without a binding.
// Every flag must be a BOOLEAN flag in Flagship with the variations on (true) and off (false), default variation off.
// With a binding: a missing flag, a disabled flag, any throw or any answer other than true means OFF; the [vars] value is not consulted.
// Flags are created and flipped in the Cloudflare dashboard (Compute, Flagship), never by CI. See docs/runbooks/flags.md.
export const legacyOn = (env, key) => String((env && env[key]) || "").trim().toLowerCase() === "on";

export async function flagOn(env, key, evalContext) {
  const b = env && env.FLAGS;
  if (b && typeof b.getBooleanValue === "function") {
    try {
      const v = evalContext === undefined ? await b.getBooleanValue(key, false) : await b.getBooleanValue(key, false, evalContext);
      return v === true;
    } catch {
      return false;
    }
  }
  return legacyOn(env, key);
}
