// Pure unit tests for infrastructure/worker/request-key.js. No network, no D1, no AI.
// Run: node --test tests/unit/request-key.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { extractKey } from "../../infrastructure/worker/request-key.js";

const req = (headers = {}, url = "https://x.test/api/me") => new Request(url, { headers });

test("reads a Bearer token", () => assert.equal(extractKey(req({ Authorization: "Bearer abc " })), "abc"));
test("reads a Board token", () => assert.equal(extractKey(req({ Authorization: "Board abc" })), "abc"));
test("reads X-Board-Key", () => assert.equal(extractKey(req({ "X-Board-Key": " abc " })), "abc"));
test("Authorization wins over X-Board-Key", () => assert.equal(extractKey(req({ Authorization: "Bearer one", "X-Board-Key": "two" })), "one"));
test("no credentials gives an empty string", () => assert.equal(extractKey(req()), ""));
test("a key in the URL query (?k=) is ignored", () => {
  assert.equal(extractKey(req({}, "https://x.test/api/me?k=secret")), "");
  assert.equal(extractKey(req({}, "https://x.test/api/me?a=1&k=secret")), "");
});
test("an unknown Authorization scheme is not read as a key", () => assert.equal(extractKey(req({ Authorization: "Basic abc" })), ""));
