// party.n (Nov 4 2026): with Winton the board has six members, but the next-step card still said "the five" and "the other four" because next/rules.js hard-coded the count.
// The count now comes from N.partyCount (js/next.js passes K.pn.count() when party.n is on, else 5). This pins that no count word is hard-coded in the launch-night and
// meeting rules, that the client flag is on in data/client.json, and that the helper turns a count into the same words the board uses.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
const read = (...p) => fs.readFileSync(new URL(`../../${p.join("/")}`, import.meta.url), "utf8");
const rules = read("next", "rules.js"), nextjs = read("js", "next.js");

test("next/rules.js carries no hard-coded party size in its launch-night and meeting copy", () => {
  assert.ok(!/each of the five|The five see|the five meet|other four at the meeting|Each of the five has/.test(rules), "a hard-coded count word is back");
  assert.ok((rules.match(/countWord\(N\.partyCount\)/g) || []).length >= 4, "the count comes from N.partyCount");
});
test("js/next.js passes the party count (the real count only when party.n is on, otherwise 5)", () => {
  assert.match(nextjs, /partyCount: K\.pn && K\.pn\.on\(\) \? K\.pn\.count\(\) : 5/);
});
test("the client flag party.n is on in data/client.json", () => {
  assert.equal(JSON.parse(read("data", "client.json")).flags["party.n"], true);
});
