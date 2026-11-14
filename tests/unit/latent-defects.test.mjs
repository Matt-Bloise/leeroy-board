// Latent defects from the 2026-11-14 catalogue (docs/review-classes.md, follow-ups F-1, F-3, F-6, F-7, F-9, F-10), one test block per fix.
// Each test failed on master before its fix. Fictional data only. No network, no D1, no AI.
import test from "node:test";
import assert from "node:assert/strict";
import { applySignupChange } from "../../infrastructure/worker/cards.js";

const NOW = Date.UTC(2026, 10, 3, 12);
const JUNK = [null, undefined, 5, "text", true, [], [1, 2]];

// F-1: applySignupChange read `e.name` on every row and threw on a null one.
test("F-1 applySignupChange: rows that are not objects are skipped and kept; the click lands on the real row", () => {
  const doc = { entries: [...JUNK, { slug: "red-fox", name: "Red Fox", rsvp: "maybe" }] };
  const r = applySignupChange(doc, { name: "Red Fox", slug: "red-fox", field: "rsvp", value: "in", now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  assert.equal(r.before, "maybe");
  assert.equal(r.doc.entries.length, JUNK.length + 1, "no junk row is removed and no second row is added");
  const fox = r.doc.entries.find((e) => e && e.slug === "red-fox");
  assert.equal(fox.rsvp, "in");
  assert.equal(fox.updated, "2026-11-03T12:00:00.000Z");
  const fresh = applySignupChange({ entries: [null, 5] }, { name: "Blue Owl", field: "when", value: "8pm", now: NOW });
  assert.equal(fresh.ok, true);
  assert.deepEqual(fresh.doc.entries.at(-1), { name: "Blue Owl", when: "8pm", updated: "2026-11-03T12:00:00.000Z" });
  assert.equal(doc.entries.at(-1).rsvp, "maybe", "the input document is not changed");
});
