// Unit tests for the refusal guards: stripPersonaIntro (answer-format.js) and guardRefusal (ask-build.js).
// Fixtures are real /ask answers from the Nov 9 eval (base2 and voice3 runs). Pure functions, no network.
// Run: node --test tests/unit/ask-refusal.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { stripPersonaIntro } from "../../infrastructure/worker/answer-format.js";
import { guardRefusal, NOT_PUBLISHED_LINE } from "../../infrastructure/worker/ask-build.js";

const D_BASE =
  "As the party librarian for Dungeons and Drinking, I can share verified library facts, options, and trade-offs alongside party build details—like your frost mage with tailoring and enchanting—for Santa, Bible Boi, Street Rat, Bloise, and Handsome Squidward. The library does not have that yet regarding past Discord posts or anyone outside our party display names, as those details are not published yet. For anything missing from the library, an official Blizzard post or a party member who has played it would help settle it.";
const D_VOICE =
  "Blue Owl, as the Dungeons and Drinking party librarian for Santa, Bible Boi, Street Rat, Bloise, and Handsome Squidward, I look up verified library facts, options, and trade-offs tailored to the party state and your level 28 Gnome Frost Mage build. The library does not have that yet. Right now, the only details on file are the party roster and the build notes for you, Red Fox, and Green Elk, with nothing published yet about past Discord posts or anyone outside those display names.";
const SOURCED =
  "**Onyxia's Lair opens on 2026-12-09.**\n\nA Protection Paladin is one of the three tank specs.\n\n-# Sources: [events/raids-dec-9](<https://leeroy.party/#library.events.raids-dec-9>)";
const GROUND = "Santa Bible Boi Street Rat Bloise Handsome Squidward frost mage tailoring enchanting level 28 gnome Discord Blizzard";

test("persona preamble is stripped, with or without a first-name greeting", () => {
  assert.ok(stripPersonaIntro(D_BASE).startsWith("The library does not have that yet"));
  assert.ok(stripPersonaIntro(D_VOICE).startsWith("The library does not have that yet."));
  assert.ok(!/librarian/i.test(stripPersonaIntro(D_BASE) + stripPersonaIntro(D_VOICE)));
});

test("first-name greeting that is not a persona intro stays", () => {
  const t = "Blue Owl, the library does not have that yet.";
  assert.equal(stripPersonaIntro(t), t);
});

test("an intro with nothing after it is kept", () => {
  const t = "As the party librarian for Dungeons and Drinking, I can share facts.";
  assert.equal(stripPersonaIntro(t), t);
});

test("refusal drops the unsupported publication status and the invented-name sentence", () => {
  const a = guardRefusal(stripPersonaIntro(D_BASE), GROUND);
  assert.ok(a.startsWith("The library does not have that yet. For anything missing"), a);
  assert.ok(!/not published/.test(a));
  assert.ok(a.includes("official Blizzard post"), "what would settle it stays");
  const b = guardRefusal(stripPersonaIntro(D_VOICE), GROUND);
  assert.ok(b.startsWith(NOT_PUBLISHED_LINE) && !/Red Fox|Green Elk|published/.test(b), b);
});

test("refusal guard is idempotent", () => {
  const once = guardRefusal(stripPersonaIntro(D_BASE), GROUND);
  assert.equal(guardRefusal(once, GROUND), once);
  assert.equal(stripPersonaIntro(once), once);
});

test("a normal sourced answer is unchanged byte for byte", () => {
  assert.equal(stripPersonaIntro(SOURCED), SOURCED);
  assert.equal(guardRefusal(SOURCED, GROUND), SOURCED);
});

test("sourced refusal with a Sources footer keeps the footer", () => {
  const t = "The library does not have that yet.\n\n-# Sources: [classes/overview](<https://leeroy.party/#library.classes.overview>)";
  assert.equal(guardRefusal(t, GROUND), t);
});

// Council finding (Codex, Nov 9): an unknown name attached to the refusal sentence itself used to survive.
test("an invented name attached to the refusal sentence is cut back to the canonical line", () => {
  const out = guardRefusal("The library does not have that yet for Zorblax the Unseen.", "mage frost gnome");
  assert.equal(out, "The library does not have that yet.");
});
test("a refusal sentence with only grounded words is unchanged", () => {
  const same = "The library does not have that yet, but it lists frost mage spells.";
  assert.equal(guardRefusal(same, "frost mage spells library"), same);
});
