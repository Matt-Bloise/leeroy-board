// The trust card must not promise more privacy than the board gives. Anonymous reads of /api/data/party,
// /api/data/signups, /api/bootstrap and /api/state return names, builds and sign-ups (live probe, 2026-11-15),
// and other board pages can still show a field hidden on the sheet until the read-time projection ships.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const trust = JSON.parse(readFileSync(new URL("../../data/trust.json", import.meta.url), "utf8"));
const sees = trust.lines.find((l) => l.id === "sees");

test("trust card 'who can see it' says the board is open to anyone with the link", () => {
  assert.match(sees.what, /Anyone with the link/);
  assert.doesNotMatch(sees.what, /Members of your own guild see/);
});

test("trust card does not claim a hidden field is hidden everywhere", () => {
  assert.match(sees.what, /other board pages may still reveal it/);
});
