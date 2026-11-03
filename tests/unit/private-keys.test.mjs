// isPrivateKvKey: config and private rows must never be served by the public GET /api/data/<key> route.
import test from "node:test";
import assert from "node:assert/strict";
import { isPrivateKvKey } from "../../infrastructure/worker/config.js";

test("config rows are private", () => {
  for (const k of ["persona", "name_map", "discord_members", "discord_roster", "vocab", "votes:index", "feed_posts"]) {
    assert.equal(isPrivateKvKey(k), true, k);
  }
});
test("prefixed working rows are private, case-insensitively", () => {
  for (const k of ["ai_budget:2026-11-02", "vote:ab12cd34", "votes:index", "feed_x", "Private:y", "config:z", "SECRET_thing", "PERSONA"]) {
    assert.equal(isPrivateKvKey(k), true, k);
  }
});
test("empty or blank keys are private", () => {
  assert.equal(isPrivateKvKey(""), true);
  assert.equal(isPrivateKvKey("   "), true);
  assert.equal(isPrivateKvKey(undefined), true);
});
test("public board documents are not private", () => {
  for (const k of ["party", "party_sheets", "signups", "stats", "timeline", "tonight", "launch", "decide", "marks"]) {
    assert.equal(isPrivateKvKey(k), false, k);
  }
});
test("unknown keys are private by default (allow list, not deny list)", () => {
  for (const k of ["discord_tokens", "oauth_state", "admin_notes", "x", "Discord_Tokens", "partyy", "party "]) {
    assert.equal(isPrivateKvKey(k), k === "party " ? false : true, JSON.stringify(k));
  }
});
