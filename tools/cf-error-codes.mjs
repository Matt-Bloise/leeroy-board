// Reads a Cloudflare API response body on stdin and prints ONLY the numeric error codes (comma separated), "none" when there are no errors, or "unparseable".
// Never prints message text: error messages can name accounts or resources, and CI logs of a public repository are public.
// Usage in a workflow: echo "Cloudflare error codes: $(printf '%s' "$RES" | node tools/cf-error-codes.mjs)"
import { readFileSync } from "node:fs";

export function errorCodes(body) {
  try {
    const j = JSON.parse(String(body));
    const codes = (Array.isArray(j && j.errors) ? j.errors : []).map((e) => (e && Number.isInteger(e.code) ? String(e.code) : null)).filter((c) => c !== null);
    return codes.length ? codes.join(",") : "none";
  } catch (e) { return "unparseable"; }
}

if (/cf-error-codes\.mjs$/.test(process.argv[1] || "")) {
  let input = "";
  try { input = readFileSync(0, "utf8"); } catch (e) { /* empty stdin */ }
  console.log(errorCodes(input));
}
