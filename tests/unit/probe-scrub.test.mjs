// The production probe's roster scrub (tests/helpers/probe-scrub.mjs): whole words only. A roster name is still scrubbed in every form a name shows up in; a longer word that merely contains a short name is left alone.
// Run: node --test tests/unit/probe-scrub.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { buildScrub } from "../helpers/probe-scrub.mjs";

// Fictional roster: two-word names, a one-word name that is a substring of "members", a slug with hyphens.
const NAMES = ["Quiet Fox", "Ember", "Mr. Tumble"];
const slug = (n) => n.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const tokens = NAMES.flatMap((n) => [n, slug(n), ...n.split(/[^A-Za-z0-9]+/), ...slug(n).split("-")]).filter((t) => t.length >= 3);
const scrub = buildScrub(tokens);

test("a roster name is scrubbed as a whole word: plain, possessive, punctuation-adjacent, mixed case, in a URL path, as a slug", () => {
  assert.equal(scrub("Quiet Fox joined"), "<member> joined");
  assert.equal(scrub("Quiet Fox's card"), "<member>'s card");
  assert.equal(scrub("Ember, the board shows"), "<member>, the board shows");
  assert.equal(scrub("(Ember)"), "(<member>)");
  assert.equal(scrub("QUIET fox and eMbEr"), "<member> and <member>");
  assert.equal(scrub("GET /api/member/quiet-fox/card"), "GET /api/member/<member>/card");
  assert.equal(scrub("https://x.test/ember?x=1"), "https://x.test/<member>?x=1");
  assert.equal(scrub("Mr. Tumble said"), "<member> said");
  assert.equal(scrub("quiet-fox"), "<member>");
  assert.equal(scrub("ember."), "<member>.");
  assert.equal(scrub("\"Ember\""), "\"<member>\"");
});

test("a word that only contains a roster token is left alone", () => {
  assert.equal(scrub("the board shows 6 members but the party lists 7"), "the board shows 6 members but the party lists 7");
  assert.equal(scrub("remember December embers"), "remember December embers");
  assert.equal(scrub("foxes quietly"), "foxes quietly");
  assert.equal(scrub("Ember1 ember_x"), "Ember1 <member>_x", "a digit glues a word together; an underscore is a boundary");
});

test("no tokens, short tokens and non-strings", () => {
  assert.equal(buildScrub([])("anything"), "anything");
  assert.equal(buildScrub(["ab", "x"])("ab x"), "ab x", "tokens under 3 characters are not used");
  assert.equal(buildScrub(["Ember"])(42), "42");
  assert.equal(buildScrub(["a.b+c"])("see a.b+c here"), "see <member> here", "regex metacharacters are escaped");
});

test("the probe uses it", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../browser/prod-probe.mjs", import.meta.url), "utf8");
  assert.match(src, /import \{ buildScrub \} from "\.\.\/helpers\/probe-scrub\.mjs"/);
  assert.match(src, /scrub = buildScrub\(tokens\)/);
});
