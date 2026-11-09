// Unit tests for infrastructure/worker/ask-fallback.js. Pure; no network.
// Run: node --test tests/unit/ask-fallback.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { classPageFallback } from "../../infrastructure/worker/ask-fallback.js";
import { NOT_PUBLISHED_LINE } from "../../infrastructure/worker/ask-build.js";

const pages = [{ id: "classes/mage", title: "Mage" }, { id: "classes/rogue", title: "Rogue" }, { id: "raids/onyxias-lair", title: "Onyxia's Lair" }];
const ctx = (question, extra = {}) => ({ question, pages, boardUrl: "https://leeroy.party", ...extra });

test("refusal plus a class question gets the class page link", () => {
  const out = classPageFallback(NOT_PUBLISHED_LINE, ctx("how do mages work"));
  assert.equal(out, `${NOT_PUBLISHED_LINE}\nThe library does have the [Mage page](<https://leeroy.party/#library.classes.mage>) if you want the overview.`);
});

test("refusal for a non-class question is unchanged", () => {
  assert.equal(classPageFallback(NOT_PUBLISHED_LINE, ctx("when does onyxia open")), NOT_PUBLISHED_LINE);
});

test("a sourced answer is unchanged byte for byte", () => {
  const a = "Mages are casters. [classes/mage~mage.role]\n-# Sources: [Mage](<https://leeroy.party/#library.classes.mage>)";
  assert.equal(classPageFallback(a, ctx("how do mages work")), a);
});

test("two classes named, or a class missing from the library, adds nothing", () => {
  assert.equal(classPageFallback(NOT_PUBLISHED_LINE, ctx("mage or rogue")), NOT_PUBLISHED_LINE);
  assert.equal(classPageFallback(NOT_PUBLISHED_LINE, ctx("explain the warlock")), NOT_PUBLISHED_LINE);
});
