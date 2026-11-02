// The inline script in index.html that sends the two stray hostnames to leeroy.party. It is inline (no extra request, runs before anything else),
// so this test pulls the script text out of index.html and runs it against a fake location. No network.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const m = /<script id="host-redirect">([\s\S]*?)<\/script>/.exec(html);

function run(hostname, rest = {}, throwing = false) {
  const calls = [];
  const loc = { hostname, pathname: "/atlas/", search: "?a=1", hash: "#five", replace: (u) => calls.push(u), ...rest };
  const sandbox = throwing ? { get location() { throw new Error("blocked"); } } : { location: loc };
  vm.runInNewContext(m[1], sandbox);
  return calls;
}

test("index.html carries one host-redirect script, before every other script", () => {
  assert.ok(m, "script#host-redirect present");
  assert.equal(html.split('id="host-redirect"').length, 2);
  assert.ok(html.indexOf('id="host-redirect"') < html.search(/<script(?![^>]*host-redirect)/), "no other script before it");
});

test("www.leeroy.party and leeroy-board.pages.dev go to leeroy.party, keeping path, query and hash", () => {
  for (const h of ["www.leeroy.party", "leeroy-board.pages.dev"]) assert.deepEqual(run(h), ["https://leeroy.party/atlas/?a=1#five"]);
});

test("leeroy.party, previews, localhost and look-alike hosts are left alone", () => {
  for (const h of ["leeroy.party", "pr-12.leeroy-board.pages.dev", "abc123.leeroy-board.pages.dev", "localhost", "127.0.0.1", "evil-www.leeroy.party", "www.leeroy.party.evil.com", "leeroy-board.pages.dev.evil.com", "api.leeroy.party"]) assert.deepEqual(run(h), [], h);
});

test("a throwing location is swallowed", () => {
  assert.doesNotThrow(() => run("x", {}, true));
});
