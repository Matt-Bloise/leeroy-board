// The judging rules of the production probe (tests/browser/prod-probe.mjs), without a browser.
import test from "node:test";
import assert from "node:assert/strict";
import { junkIn, wrongCountCopy, memberCountProblem, slugOf, classifyHttp, consoleFailures, isReportOnlyCsp } from "../helpers/probe-checks.mjs";

test("member count: equal passes, any difference fails", () => {
  assert.deepEqual(memberCountProblem(6, 6), []);
  assert.equal(memberCountProblem(5, 6).length, 1);
  assert.equal(memberCountProblem(7, 6).length, 1);
  assert.equal(memberCountProblem(0, 0).length, 1, "an empty reference is itself a failure");
});

test("a typed five with six members fails; with five members it passes", () => {
  assert.equal(wrongCountCopy(["Swipe sideways for all five."], 6).length, 1);
  assert.equal(wrongCountCopy(["Which of the five are you?"], 7).length, 1);
  assert.deepEqual(wrongCountCopy(["Swipe sideways for all five."], 5), []);
  assert.deepEqual(wrongCountCopy(["Swipe sideways for all six."], 6), []);
});

test("other typed counts: the other four, all five of us, the four of you", () => {
  assert.equal(wrongCountCopy(["Ask the other four"], 6).length, 1);
  assert.equal(wrongCountCopy(["Ask the other five"], 6).length, 1, "five is wrong for six members whatever it counts");
  assert.equal(wrongCountCopy(["the four of you"], 6).length, 1);
  assert.deepEqual(wrongCountCopy(["the six of you"], 6), []);
});

test("phrases about five of something else are not the party", () => {
  assert.deepEqual(wrongCountCopy(["The dial steps five points more", "a group of five players", "three of five still travel", "Read from five places"], 6), []);
});

test("junk text: undefined, NaN, [object Object], raw ids", () => {
  for (const bad of ["Level undefined", "NaN gold", "[object Object]", "id 123456789012345678", "x 3f2504e0-4f89-11d3-9a0c-0305e82c3301", "{{name}}", "null"]) assert.equal(junkIn([bad]).length, 1, bad);
  assert.deepEqual(junkIn(["Brindle Oakhand, Tauren Druid", "Level 60 in 4 weeks", "1,234 gold", "Nullify the curse", "Not a number"]), []);
});

test("slugs match the board's own", () => { assert.equal(slugOf("Brindle  Oakhand!"), "brindle-oakhand"); });

test("console exemptions are anchored: the report-only marker must START the message; the Cloudflare beacon is matched by location, not by words in the message", () => {
  const enforced = "Refused to load the image 'https://x/y.png' because it violates the following Content Security Policy directive: \"img-src 'self'\".";
  // enforced violations that merely quote the words must still fail
  assert.equal(consoleFailures([`${enforced} See https://example.org/report-only/policy`]).length, 1);
  assert.equal(consoleFailures([`${enforced} (compare Content-Security-Policy-Report-Only)`]).length, 1);
  assert.equal(isReportOnlyCsp("Refused ... report-only ..."), false);
  assert.equal(isReportOnlyCsp("Content-Security-Policy-Report-Only: blocked x"), true);
  // beacon: by console location (host match, not substring), not by message text
  assert.equal(consoleFailures([{ text: "Failed to load resource: net::ERR_FAILED", at: "https://static.cloudflareinsights.com/beacon.min.js" }]).length, 0);
  assert.equal(consoleFailures([{ text: "TypeError: x is not a function (see cloudflareinsights.com)", at: "https://leeroy.party/js/board.js" }]).length, 1);
  assert.equal(consoleFailures([{ text: "boom", at: "https://cloudflareinsights.com.evil.example/x.js" }]).length, 1);
  assert.equal(consoleFailures([{ text: "boom", at: "https://evil.example/cloudflareinsights.com" }]).length, 1);
  // the URL-less network wording is exempt only when a beacon request was seen failing, and never when the message names another URL
  assert.equal(consoleFailures([{ text: "Failed to load resource: net::ERR_FAILED", at: "" }]).length, 1);
  assert.equal(consoleFailures([{ text: "Failed to load resource: net::ERR_FAILED", at: "" }], { insightsRequestFailed: true }).length, 0);
  assert.equal(consoleFailures([{ text: "Failed to load resource: the server responded with 500 https://api.leeroy.party/api/x", at: "" }], { insightsRequestFailed: true }).length, 1);
  assert.equal(consoleFailures([{ text: "TypeError: x", at: "" }], { insightsRequestFailed: true }).length, 1);
});

test("console errors: report-only CSP and third-party noise are exempt; an ENFORCED CSP violation fails", () => {
  const enforced = "Refused to load the image 'https://x/y.png' because it violates the following Content Security Policy directive: \"img-src 'self'\".";
  assert.deepEqual(consoleFailures([enforced]), [enforced]);
  assert.deepEqual(consoleFailures(["Content Security Policy: the page's settings blocked a resource"]).length, 1, "the bare phrase is not an exemption");
  assert.deepEqual(consoleFailures([`[Report Only] ${enforced}`, "Content-Security-Policy-Report-Only: the policy blocked x", { text: "Failed to load resource", at: "https://static.cloudflareinsights.com/beacon.min.js" }]), []);
  assert.equal(consoleFailures(["The Content-Security-Policy-Report-Only policy blocked x"]).length, 1, "mid-message mention is not the marker");
  assert.equal(consoleFailures(["failed https://static.cloudflareinsights.com/beacon.min.js"]).length, 1, "message text naming the beacon host is not an exemption");
  assert.equal(isReportOnlyCsp("[Report Only] Refused to load"), true);
  assert.equal(consoleFailures(["Error creating WebGL context"], { engine: "webkit", allowWebkitNoWebgl: true }).length, 0);
  assert.equal(consoleFailures(["Error creating WebGL context"], { engine: "chromium", allowWebkitNoWebgl: true }).length, 1);
  assert.equal(consoleFailures(["TypeError: x is undefined"]).length, 1);
});

test("HTTP statuses: site 4xx/5xx fail; API 5xx fails; API 4xx warns except on bootstrap and state", () => {
  const S = "https://leeroy.party", A = "https://api.leeroy.party";
  assert.equal(classifyHttp(`${S}/js/board.js`, 404, S, A), "fail");
  assert.equal(classifyHttp(`${A}/api/library/index`, 503, S, A), "fail");
  assert.equal(classifyHttp(`${A}/api/me`, 401, S, A), "warn");
  assert.equal(classifyHttp(`${A}/api/bootstrap`, 404, S, A), "fail");
  assert.equal(classifyHttp(`${A}/api/state`, 403, S, A), "fail");
  assert.equal(classifyHttp(`${A}/api/state`, 200, S, A), "ok");
  assert.equal(classifyHttp("https://third.example/x", 500, S, A), "ok", "someone else's host is not ours");
  assert.equal(classifyHttp("http://127.0.0.1:1/api/me", 401, "http://127.0.0.1:1", "http://127.0.0.1:1"), "warn", "local: site and API share an origin, /api/ still counts as the API");
  assert.equal(classifyHttp("http://127.0.0.1:1/css/x.css", 404, "http://127.0.0.1:1", "http://127.0.0.1:1"), "fail");
});
