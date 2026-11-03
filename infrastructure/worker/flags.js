// Feature flags. Flagship (env.FLAGS, the [[flagship]] binding) when the deploy attached it; otherwise the legacy wrangler.toml [vars] value.
// Local dev, unit tests and PR preview Workers have no binding, so they keep reading [vars] exactly as before.
// Flag key "d1-feed" maps to the legacy var D1_FEED (upper case, dashes to underscores). Manifest: infrastructure/flags.json.
// With a binding, ANY throw or non-true answer means OFF; the legacy var is not consulted (the dashboard is the single switch).
export const legacyVarName = (key) => String(key).toUpperCase().replace(/-/g, "_");
export const legacyOn = (env, key) => String((env && env[legacyVarName(key)]) || "").trim().toLowerCase() === "on";

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
