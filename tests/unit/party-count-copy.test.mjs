// party.n (Nov 4 2026): with Winton the board has six members, but the next-step card still said "the five" and "the other four" because next/rules.js hard-coded the count.
// The words now come IN with the input: js/next.js asks K.pn (js/board.js, the one place a count becomes words) and passes partyWord / partyOther / partyNoun / say. This pins that the rules
// module has no number table of its own, that it uses what it is given, that with nothing given it keeps the old five wording, and that the client flag is on in data/client.json.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
const read = (...p) => fs.readFileSync(new URL(`../../${p.join("/")}`, import.meta.url), "utf8");
const rules = read("next", "rules.js"), nextjs = read("js", "next.js");
const { candidates } = await import("../../next/rules.js");
const NOW = Date.UTC(2026, 10, 4, 12);
const find = (input, id) => candidates({ party: { members: [] }, timeline: { events: [] }, tonight: null, me: null, ...input }, NOW).find((c) => c.id === id);

test("next/rules.js carries no hard-coded party size and no number table", () => {
  assert.ok(!/each of the five|The five see|the five meet|other four at the meeting|Each of the five has|from the five/.test(rules), "a hard-coded count word is back");
  assert.ok(!/\bNUM\b|countWord|numberWord/.test(rules), "the rules module grew its own number table again; the words come from K.pn");
  assert.ok((rules.match(/N\.partyWord/g) || []).length >= 4 && /N\.partyOther/.test(rules) && /N\.partyNoun/.test(rules) && /N\.say\(/.test(rules));
});
test("js/next.js passes the words from K.pn (the helper in js/board.js), nothing typed here", () => {
  assert.match(nextjs, /partyWord: K\.pn\.word\(\), partyOther: K\.pn\.word\(-1\), partyNoun: K\.pn\.noun\(\), say: K\.pn\.say/);
  assert.ok(!/partyCount/.test(nextjs) && !/partyCount/.test(rules));
  assert.match(nextjs, /of the \$\{K\.pn\.word\(\)\} \$\{n === 1/, "the tonight line says how many of the party are in");
});
test("the next-step candidates say the words they are given", () => {
  const six = { partyWord: "six", partyOther: "five", partyNoun: "party" };
  assert.match(find(six, "pick-name").why, /^Each of the six has their own next step/);
  const seven = { partyWord: "seven", partyOther: "six", partyNoun: "party" };
  assert.match(find(seven, "pick-name").why, /^Each of the seven has/);
});
test("with no words given the old five wording is unchanged", () => {
  assert.match(find({}, "pick-name").why, /^Each of the five has their own next step/);
});
test("the client flag party.n is on in data/client.json", () => {
  assert.equal(JSON.parse(read("data", "client.json")).flags["party.n"], true);
});
