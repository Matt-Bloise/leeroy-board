import test from "node:test";
import assert from "node:assert/strict";
import { pageUrl, originOf, dirOf } from "../helpers/page-url.mjs";

test("a plain origin gets the param", () => assert.equal(pageUrl("https://x.dev", { params: { preview: "1" } }), "https://x.dev/?preview=1"));
test("an existing query is kept, not doubled", () => {
  const u = new URL(pageUrl("http://127.0.0.1:8080/?brain=http://127.0.0.1:8787", { params: { preview: "1" } }));
  assert.equal(u.searchParams.get("brain"), "http://127.0.0.1:8787");
  assert.equal(u.searchParams.get("preview"), "1");
  assert.equal(u.href.split("?").length, 2);
});
test("defaults never replace what the caller passed, params do", () => {
  assert.equal(new URL(pageUrl("http://a/?brain=x", { defaults: { brain: "local" } })).searchParams.get("brain"), "x");
  assert.equal(new URL(pageUrl("http://a/", { defaults: { brain: "local" } })).searchParams.get("brain"), "local");
  assert.equal(new URL(pageUrl("http://a/?preview=0", { params: { preview: "1" } })).searchParams.get("preview"), "1");
});
test("path, hash and trailing slash", () => {
  assert.equal(pageUrl("https://x.dev/app", { path: "rate/", hash: "five" }), "https://x.dev/app/rate/#five");
  assert.equal(pageUrl("https://x.dev/?a=1#old", { hash: "" }), "https://x.dev/?a=1");
});
test("originOf and dirOf drop query and hash", () => {
  assert.equal(originOf("http://127.0.0.1:8080/?brain=1"), "http://127.0.0.1:8080");
  assert.equal(dirOf("http://127.0.0.1:8080/x?brain=1#h"), "http://127.0.0.1:8080/x/");
});
