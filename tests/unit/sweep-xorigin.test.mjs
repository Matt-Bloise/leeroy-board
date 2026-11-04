// The layout sweep must name the URL of any cross-origin request that answers 4xx/5xx or fails (B55: WebKit logs such a 404 as
// "Origin ... is not allowed by Access-Control-Allow-Origin. Status code: 404" without the URL). Browser proof: layout-sweep.mjs --inject-css <css with a background url to a missing API path> must report xorigin-http.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const src = readFileSync(new URL("../browser/layout-sweep.mjs", import.meta.url), "utf8");
test("layout sweep judges cross-origin 4xx and failed requests and names the URL", () => {
  assert.match(src, /once\("xorigin-http", `\$\{r\.status\(\)\} \$\{u\}`\)/);
  assert.match(src, /page\.on\("requestfailed"[^\n]*\n?[^\n]*xo\(u\)/);
  assert.match(src, /!\/cloudflareinsights\/\.test\(u\)/);
});
