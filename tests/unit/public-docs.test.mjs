// Allow list for GET /api/data/<name> and GET /api/atlas/<name>: the site's documents are served, nothing else.
import test from "node:test";
import assert from "node:assert/strict";
import { PUBLIC_DATA_DOCS, PUBLIC_ATLAS_DOCS, isPublicDataDoc, isPublicAtlasDoc } from "../../infrastructure/worker/public-docs.js";
import { isPrivateKvKey } from "../../infrastructure/worker/config.js";

// Every document the site fetches through /api/data (see js/board.js, js/v15.js, scenes/decide.js, scenes/guided-atlas.js).
const SITE_DATA = ["party", "timeline", "client", "stats", "signups", "tonight", "launch", "decide", "guided-atlas"];
// Every document the site fetches through /api/atlas (js/atlas-hook.js, atlas/atlas.js).
const SITE_ATLAS = ["marks", "links"];

test("every data document the site fetches is allowed and not private", () => {
  for (const n of SITE_DATA) {
    assert.equal(isPublicDataDoc(n), true, n);
    assert.equal(isPrivateKvKey(n), false, n);
  }
});
test("every atlas document the site fetches is allowed and not private", () => {
  for (const n of SITE_ATLAS) {
    assert.equal(isPublicAtlasDoc(n), true, n);
    assert.equal(isPrivateKvKey(n), false, n);
  }
});
test("the allow lists hold exactly the documents the site fetches", () => {
  assert.deepEqual([...PUBLIC_DATA_DOCS].sort(), [...SITE_DATA].sort());
  assert.deepEqual([...PUBLIC_ATLAS_DOCS].sort(), [...SITE_ATLAS].sort());
});
test("config and private rows are not allowed on either route", () => {
  for (const n of ["persona", "name_map", "discord_members", "discord_roster", "vocab", "votes:index", "feed_posts", "ai_budget:2026-11-02", "vote:ab12cd34", "votes:x", "party_sheets", "config:x", "secret"]) {
    assert.equal(isPublicDataDoc(n), false, n);
    assert.equal(isPublicAtlasDoc(n), false, n);
  }
});
test("unknown, empty and malformed names are not allowed", () => {
  for (const n of ["", "   ", undefined, null, "nope", "zz-auth-test", "../party", "party/x", "party.json", "PARTY"]) {
    assert.equal(isPublicDataDoc(n), false, String(n));
  }
});
test("the two routes do not share names", () => {
  for (const n of SITE_ATLAS) assert.equal(isPublicDataDoc(n), false, n);
  for (const n of SITE_DATA) assert.equal(isPublicAtlasDoc(n), false, n);
});
