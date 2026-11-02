// Pure unit tests for infrastructure/worker/announce.js. No network, no D1, no AI, nothing is posted to Discord.
// Run: node --test tests/unit/announce.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  clampContent, buildAllowedMentions, validateButton, buildLinkButtonRow, buildAnnounceBody, buildStartReply, lookupRosterId,
} from "../../infrastructure/worker/announce.js";

const ROLE = "11111111111";

test("allowed_mentions: none by default", () => {
  assert.deepEqual(buildAllowedMentions(), { parse: [] });
  assert.deepEqual(buildAllowedMentions("not an id"), { parse: [] });
});

test("allowed_mentions: exactly one role when given, never parse", () => {
  const m = buildAllowedMentions(ROLE);
  assert.deepEqual(m, { parse: [], roles: [ROLE] });
});

test("clampContent cuts at 2000 and leaves short text alone", () => {
  assert.equal(clampContent("x".repeat(2500)).length, 2000);
  assert.equal(clampContent("hello"), "hello");
  assert.equal(clampContent(undefined), "");
});

test("button row shape: action row, link button, label max 80", () => {
  const row = buildLinkButtonRow("L".repeat(120), "https://leeroy.party/");
  assert.equal(row.type, 1);
  assert.equal(row.components.length, 1);
  const b = row.components[0];
  assert.equal(b.type, 2);
  assert.equal(b.style, 5);
  assert.equal(b.url, "https://leeroy.party/");
  assert.equal(b.label.length, 80);
});

test("non-https button urls are rejected", () => {
  for (const u of ["http://leeroy.party/", "javascript:alert(1)", "ftp://x.test/", "not a url", "", undefined]) {
    assert.equal(validateButton("Open", u).ok, false, String(u));
    assert.equal(buildLinkButtonRow("Open", u), null);
  }
  assert.equal(validateButton("", "https://leeroy.party/").ok, false);
  assert.equal(validateButton("Open", "https://leeroy.party/").ok, true);
});

test("announce body: plain text, no mentions, no components", () => {
  const r = buildAnnounceBody({ text: "hi" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.body, { content: "hi", allowed_mentions: { parse: [] } });
});

test("announce body: role mention lists only that role; content clamped", () => {
  const r = buildAnnounceBody({ text: "y".repeat(3000), roleId: ROLE });
  assert.equal(r.ok, true);
  assert.deepEqual(r.body.allowed_mentions, { parse: [], roles: [ROLE] });
  assert.equal(r.body.content.length, 2000);
  assert.ok(r.body.content.startsWith(`<@&${ROLE}> `));
});

test("announce body: button attached, bad button or empty text refused", () => {
  const ok = buildAnnounceBody({ text: "a", buttonLabel: "Go", buttonUrl: "https://leeroy.party/" });
  assert.equal(ok.body.components[0].components[0].style, 5);
  assert.equal(buildAnnounceBody({ text: "a", buttonLabel: "Go", buttonUrl: "http://x.test/" }).ok, false);
  assert.equal(buildAnnounceBody({ text: "   " }).ok, false);
  assert.equal(buildAnnounceBody({}).ok, false);
});

test("lookupRosterId only returns configured digit ids", () => {
  const roster = { channels: { news: "22222222222", bad: "x" }, roles: { crew: ROLE } };
  assert.equal(lookupRosterId(roster, "channels", "news"), "22222222222");
  assert.equal(lookupRosterId(roster, "channels", "bad"), null);
  assert.equal(lookupRosterId(roster, "channels", "missing"), null);
  assert.equal(lookupRosterId(roster, "channels", "__proto__"), null);
  assert.equal(lookupRosterId(null, "channels", "news"), null);
  assert.equal(lookupRosterId(roster, "roles", "crew"), ROLE);
});

test("/start reply: ephemeral, four lines, link button", () => {
  const r = buildStartReply();
  assert.equal(r.flags, 64);
  assert.equal(r.content.split("\n").length, 4);
  assert.ok(r.content.includes("https://leeroy.party/"));
  assert.equal(r.components[0].components[0].style, 5);
  assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(r.content));
});
